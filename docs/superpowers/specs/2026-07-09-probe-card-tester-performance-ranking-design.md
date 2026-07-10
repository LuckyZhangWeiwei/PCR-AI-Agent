# REQ-KLWT-019 变体：Probe Card / Tester 良率排名（AI Agent 能力）设计

**日期：** 2026-07-09（**2026-07-10 修订**：结合真实 JB STAR 表结构核实 + Copilot 对同类需求的分析，扩充时间趋势/坏 bin 分布/置信度档位，并修正数据计算路径的正确性问题——详见各节标注）
**背景：** 用户参考了另一个项目的截图（REQ-KLWT-019：上传 ProbeView 导出的 Excel，让 AI 分析「最佳 Probe Card + Tester + PassName 组合」及「Probe Card 最差表现排名」）。确认后本项目**不做文件上传**——直接用现有 JB STAR（INFCONTROL⋈INFLAYERBINLIST）数据，把这个分析能力做成现有 AI Agent 的一个新工具。用户后续又找同事用 Copilot 分析了这张截图的完整逻辑（良率+波动+样本量三维评分、时间趋势、Wafer Map 关联、Tester ANOVA、置信度分数几个扩展方向），07-10 修订据此重新过了一遍取舍。

---

## 1. 目标

用户在 AI Agent 对话里问类似「这个 device 下最好的探针卡+机台组合是什么」「探针卡表现排名」「这张卡良率是不是在变差」「这张卡常见坏 bin 是什么」时，Agent 能给出：

1. **组合排名表**：按 `(cardId, testerId, passId)` 分组的良率排名（最好在前），含置信度档位。
2. **探针卡排名表**：按 `cardId` 聚合（跨 tester）的良率排名（最差在前），带规则触发的评估文字 + 置信度档位。
3. **时间趋势表**（07-10 新增）：每张卡按月的良率走势，用于判断是否逐渐衰退。
4. **坏 bin 分布表**（07-10 新增）：每张卡最常见的坏 bin 编号 Top 3 + 占比，简化版「接触不良」线索。

数字由服务端确定性计算直出；LLM 只负责在表格之后写「数据解读」「专业建议」，不允许自己重新计算或改写数字——这与项目里 JB 确定性总结的既有约定一致（见 `docs/HANDOFF_AGENT_JB_DETERMINISTIC_SUMMARY.md`）。

---

## 2. 数据来源与范围

- **数据源：仅 JB STAR**（INFCONTROL ⋈ INFLAYERBINLIST）。不引入 Yield Monitor 数据（DUT 不均衡报警是另一个维度，v1 不混用，避免口径混乱）。
- **必需参数：`device`**。探针卡种类（`probeCardType` = `CARDID` 首段）与 device 绑定，跨 device 汇总排名没有业务意义。模型未拿到 device 时应先追问或从上下文/最近 lot 推断，不允许跨 device 硬算。
- **固定 `PASSTYPE='TEST'`**（沿用项目里所有 JB 查询的既有约定，天然排除 RETESTBIN，对应截图「Ignore Retest Steps」的要求）。
- **passId 处理**：
  - 若用户/模型显式给了 `passId`，只统计该 passId。
  - **若未指定 `passId`，默认按 `passId ∈ {1, 3, 5}` 分别输出**（pass1/pass3/pass5 各一张组合表 + 各一张探针卡排名表），**不跨 sort 合并/均值**。这是项目里反复强调的硬约束（`domain_pass_sort_mapping`、`HANDOFF_AGENT_JB_DETERMINISTIC_SUMMARY.md` §0），必须延续。
- **时间窗**：未显式传 `testStart*`/`testEnd*` 时，复用 `v3DefaultOneYearWindow`（最近一年 `TESTEND`）。
- **行数保护**：复用 `MEMORY_AGG_ORACLE_MAX_ROWS`；超限返回 422（与 v4 聚合一致的既有约定）。

---

## 3. 数据计算（核心：新的 Node 端聚合，不是现有 SQL SUM 聚合）

现有 `infcontrol-layer-bins/v3/aggregate` 只能对某个 groupBy 维度做「坏 bin 数 SUM」，拿不到「每组的良率均值/标准差/样本数」——这是排名评分需要的核心指标，必须新建计算逻辑：

1. **取数据**：仿照 `aggregate_jb_bins` 工具已验证的既有模式（`agentToolHandlers.ts` 里的 `toolAggregateJbBins`）——Oracle 端先 `COUNT` 再用 `buildInfcontrolLayerBinsV3SqlFullMatching` 拉全量匹配行（受 `MEMORY_AGG_ORACLE_MAX_ROWS` 限制）；Dummy 端用 `filterInfcontrolLayerBinV3DummyRowsMatching` 从同一份 `INFCONTROL_LAYER_BINS_DUMMY` 内存行（JBStart.xlsx）做同等筛选。
2. **算每行良率（07-10 修正：复用现成函数，不新写）**：两条路径拿到的原始行都先过一遍 `agentToolHandlers.ts` 里已经在用的 `enrichJbRow`（= `enrichInfcontrolLayerBinRowV2`，见 `passBinSemantics.ts`），把顶层 `BIN0..BIN255` 列转成 `row.bins[]` 结构；再用 `jbYieldCalc.ts` 的 `badDieFromJbRow(row)` 算该行坏 die 合计，`rowYield = 1 - badDieFromJbRow(row) / grossDie`。
   - **为什么不新写一套 `badDieForRawJbRow`**：最初草稿打算照抄 `PASSBIN` hyphen-token 解析自己写一个新函数，但漏掉了「BIN1 恒为良品」这条硬规则（`jbYieldCalc.ts` 的 `JB_HARD_GOOD_BIN` 常量，不在 `PASSBIN` 字符串里体现，需要额外硬编码）——会算出偏低的良率。`enrichJbRow` + `badDieFromJbRow` 这条路径已经是 `agentToolHandlers.ts` 里 `aggregate_jb_bins`/JB 明细工具在用、且被现有测试覆盖的路径，直接复用零新增 bug 面。
3. **样本单位**：一行 JB 记录（一次 pass 的一个测试段）= 一个样本。正常 1 行 ≈ 1 片 wafer；若测试中途换卡（interrupt→用另一张卡续测），同一片 wafer 会拆成 2 行分别挂在两张卡下——这是**正确**的归因，不是需要修的 bug（前半段坏 die 应算在当时那张卡头上）。`recordCount`＝贡献了有效良率的行数（≈ 该卡处理过的 wafer 段数），`lotCount`＝distinct LOT 数（更保守的置信度信号）。
4. **分组聚合（纯函数，Oracle/Dummy 共用同一份计算代码，只是输入行数组来源不同——天然满足 dummy-parity）**：
   - **组合维度** `(cardId, testerId, passId)`：`avgYield`、`stdDevYield`（样本标准差）、`recordCount`、`lotCount`、`confidenceTier`（见 §4）。
   - **探针卡维度** `cardId`（同一 device + passId 范围内，跨 tester）：同样字段 + 评估文字（见 §4）。
   - **时间趋势**（按 `cardId` + `TESTEND` 的 `YYYY-MM`）与**坏 bin 分布**（按 `cardId`，坏 die 数按 bin 编号汇总取占比 Top 3）：见 §4.4/§4.5。
5. **新文件（拟定）**：
   - `pcr-ai-api/src/lib/probeCardTesterPerformance.ts` — 分组聚合纯函数 + markdown 表构建（`mean`/`sampleStdDev`/`median` 统计工具 + 分组排名 + 趋势分桶 + 坏 bin 频率统计）。
   - 复用 `infcontrolLayerBinFilters.ts`（筛选解析）、`infcontrolLayerBinDummy.ts`（Dummy 全量行获取）、`passBinSemantics.ts` 的 `enrichInfcontrolLayerBinRowV2` / `jbYieldCalc.ts` 的 `badDieFromJbRow`（良率计算，不新写）。

---

## 4. 排名与评分规则（确定性规则，不用 LLM 打分，不用星级）

### 4.1 组合排名表（每个 passId 一张）

- 排序：`avgYield` 降序；并列时 `stdDevYield` 升序决胜；再并列按 `recordCount` 降序。
- 列：排名、CardId、TesterId、平均良率、标准差、片数、Lot 数、**置信度**（07-10 新增，见 4.3）。

### 4.2 探针卡排名表（每个 passId 一张，最差在前）

- 排序：`avgYield` 升序（最差最先看到）。
- 列：排名、CardId、平均良率、标准差、片数、Lot 数、评估、**置信度**（07-10 新增，见 4.3）。
- **评估文字（规则触发，按优先级取第一条匹配）：**
  1. `lotCount < 3` → 「样本有限，置信度低」
  2. `avgYield < 组内均值 − 1.5 × 组内标准差`（且 `lotCount >= 3`）→ 「良率明显偏低」——「组内」指同一次查询返回的探针卡集合（同 device + passId 下所有 cardId）的 `avgYield` 分布，均值/标准差在生成该表时现算，不是全局常量
  3. `stdDevYield > 组内标准差的中位数`（且未命中 1/2）→ 「波动较大，稳定性差」——同样基于本次查询返回的探针卡集合内 `stdDevYield` 分布取中位数
  4. 否则 → 「表现稳定」

不做五星评分/彩色图标——服务端表直出数字 + 简短规则标签，LLM 在後面的「数据解读」「专业建议」里用自然语言展开，这与项目现有 JB 确定性总结的输出风格一致（避免又发明一套新的展示体系）。

### 4.3 置信度档位（07-10 新增，取代 Copilot 建议的数值置信度分数）

Copilot 的分析里建议给结论附一个数值置信度（如「置信度 95%」）。评估后**不采用数值形式**——那需要假设一个抽样分布（比如二项分布置信区间）才有统计意义，而实际上我们能提供的信息量就是样本数多少，编一个百分比反而比文字标签更不诚实。改用简单档位：

- `lotCount >= 10` → 「高」
- `3 <= lotCount < 10` → 「中」
- `lotCount < 3` → 「低」

这与 4.2 的「样本有限，置信度低」评估文字是同一个 `lotCount < 3` 判断，档位字段只是把它变成结构化字段，方便表格排序/筛选，不是新增一套独立逻辑。

### 4.4 时间趋势表（07-10 新增，按 cardId）

响应 Copilot「时间趋势看探针卡是否退化」的建议。用真实数据校验过 `TESTEND` 每行必有（见调研结论），按月分桶可行：

- 分组键：`cardId` + `TESTEND` 的 `YYYY-MM`（同一 passId 范围内，不跨 passId）。
- 列：CardId、月份、当月平均良率、当月样本数（行数）。
- **只收录有 ≥2 个月数据的卡**——少于 2 个点看不出走势方向，规则化过滤而非「挑几张最差的卡」这种不透明的启发式选择。
- 不做拟合线/趋势斜率计算，只给原始月度数字；LLM 在「数据解读」里用自然语言描述走势（如「持续下降」「先降后稳」），仍然是数字直出、LLM 只做文字总结的既定模式。

### 4.5 坏 bin 分布表（07-10 新增，简化版，按 cardId）

响应 Copilot「Wafer Map / Fail Bin 关联识别接触不良」的建议，但**明确降级为简化版**：现有 JB STAR 聚合数据没有 die 级 X/Y 坐标（那部分数据在独立的 `inf_draw_wafer_map` 工具链路里，本次不整合），所以只能做「哪个 bin 编号最常出现」的频率统计，不是真正的空间分布图。

- 分组键：`cardId`（同一 passId 范围内）。
- 对该卡范围内所有行，按 bin 编号（`badDieFromJbRow` 展开的坏 bin 明细，不是 `goodBinIndicesForJbRow` 排除掉的）累计坏 die 数；占比＝该 bin 编号坏 die 数 ÷ 该卡范围内坏 die 总数，取占比 Top 3。
- 列：CardId、Top 3 坏 bin（如 `BIN7 (65%), BIN12 (20%), BIN23 (8%)`）。
- **Prompt 层面必须明确边界**（见 §5）：LLM 不能把这张表解读成「边缘接触不良」「角落 pattern」之类需要坐标才能下的结论，只能说「哪个 bin 类型的失效最常见」。

---

## 5. Agent 集成

- **新工具 schema**：`aggregate_probe_card_tester_performance`（`agentToolSchemas.ts`）
  - 入参：`device`（必需）、`passId`（可选，1/3/5）、`testEndFrom`/`testEndTo`（可选）。
  - 描述（07-10 扩充）：用于回答"哪个探针卡+测试机组合良率最好/最差""探针卡表现排名""这张卡良率是不是在变差""这张卡常见坏 bin 是什么"类问题；明确说明未给 `passId` 时会分 pass1/pass3/pass5 分别输出，禁止跨 sort 合并；明确说明会附带月度趋势与坏 bin 频率表。
- **工具执行**（`agentToolHandlers.ts`）：调用新聚合函数，返回结构化 JSON（含四类表的原始数据）+ 预先拼好的 markdown（组合表 + 探针卡表 + 趋势表 + 坏 bin 表 × 各 passId）。
- **总结轮**：复用现有确定性总结机制思路——工具结果里的 markdown 表直出，LLM 只追加 `### 数据解读` + `### 专业建议`（复用 `BRIEF_COMMENTARY_SYSTEM` 风格，聚焦 Wafer Test / Probe Card 维护角度）。
- **Prompt 规则**（`agentPrompt.ts`）：
  - 新增一节说明何时调用此工具、术语用词（cardId 对用户仍可称"探针卡"，testerId 称"测试机/机台"）、禁止跨 passId 合并。
  - 触发关键词（07-10 扩充）：原有"探针卡排名/组合排名/良率最好/良率最差/表现排名"之外，加入"退化/趋势/是否变差/坏 bin/接触不良/稳定性"，让退化/坏 bin 类问题也命中同一工具。
  - **边界提醒（07-10 新增，硬约束）**：明确写清楚坏 bin 分布表只是「哪个 bin 编号常见」的频率统计，不是 die 级坐标图；LLM 禁止说"边缘接触不良""角落 pattern"这类需要空间坐标才能下的结论；真要看物理位置分布，提示用户改用已有的晶圆图工具。

---

## 6. Dummy/Oracle Parity

- 分组聚合的核心计算逻辑是**唯一一份纯函数**，输入统一为「已筛选的行数组」；Oracle 路径负责拉全量匹配行，Dummy 路径负责从内存表筛选出等价的行数组，二者调用同一个计算函数——从架构上避免了口径分叉。
- 仍需为 Oracle 全量行 SQL 与 Dummy 筛选各自实现/复用现有筛选逻辑（`parseInfcontrolLayerBinsV3Query` 系列），确保 `device`/`passId`/时间窗筛选语义一致。
- `npm test` 需覆盖：分组计算纯函数单测、Oracle/Dummy 两路径 parity 测试、Agent 工具 schema 与 prompt 路由测试。

---

## 7. 范围外（v1 不做）

**07-10 复核 Copilot 建议后的取舍**：时间趋势、坏 bin 频率分布（简化版）已收进 v1（见 §4.4/§4.5）；以下仍明确排除：

- 不做文件上传 / Excel 解析入口（原始截图的形式，已确认不需要）。
- 不引入 Yield Monitor 数据做联合评分。
- 不做五星可视化评分或前端图表面板——先作为 Agent 对话内 markdown 表格能力交付；是否需要独立报表 Tab 展示，后续按需再提。
- 不做跨 device 汇总排名。
- **不做 Tester ANOVA / 显著性检验**（Copilot 建议之一）——现有的留一法均值/标准差阈值规则（§4.2）已经能抓住明显异常，引入 F 分布/p 值计算复杂度高、且对非统计背景的工程师不好解释，与"规则驱动、可解释"的设计取向冲突。
- **不做数值置信度分数**（Copilot 建议之一）——改用简单档位，见 §4.3 的理由。
- **不做真正的 Wafer Map 坐标关联**——现有 JB STAR 聚合数据没有 die 级 X/Y，§4.5 的坏 bin 表只是频率统计的简化版；die 级空间诊断留给已有的 `inf_draw_wafer_map` 工具链路，本次不打通。

---

## 8. 影响文件清单（预估）

| 文件 | 改动 |
| --- | --- |
| `pcr-ai-api/src/lib/probeCardTesterPerformance.ts`（新） | 分组聚合纯函数 + markdown 构建 |
| `pcr-ai-api/src/lib/agent/agentToolSchemas.ts` | 新增 `aggregate_probe_card_tester_performance` schema |
| `pcr-ai-api/src/lib/agent/agentToolHandlers.ts` | 新工具分派、调用聚合函数 |
| `pcr-ai-api/src/lib/agent/agentPrompt.ts` | 新增该能力的触发规则/术语说明 |
| `pcr-ai-api/test/*.test.ts` | 新增聚合纯函数测试 + Oracle/Dummy parity 测试 + 工具路由测试 |
| `docs/HANDOFF_*`（新增交接文档） | 按项目惯例补一份交接文档，供后续接手 |

---

## 9. 验收标准

1. 问「WA03P02G 这个 device 下最好的探针卡+机台组合」→ Agent 调用新工具，输出 pass1/pass3/pass5 三张组合排名表（未指定 passId 时），数字与手工用 JB STAR 原始数据核算一致（用 `enrichJbRow` + `badDieFromJbRow` 手算校验，不是自研公式）。
2. 问「哪张探针卡表现最差」→ 输出探针卡排名表（最差在前）+ 规则触发的评估文字 + 置信度档位，样本量少的卡标注「样本有限」且置信度为「低」。
3. 指定 `passId` 时只出该 pass 的表，不与其它 sort 混算。
4. 问「这张卡良率是不是在变差」→ 命中同一工具，输出该卡的月度趋势表（若有 ≥2 个月数据）；LLM 解读只描述走势方向，不编造具体统计显著性结论。
5. 问「这张卡常见坏 bin 是什么」→ 输出坏 bin 分布 Top 3；LLM 解读不出现"边缘""角落""接触位置"等需要坐标才能下的措辞。
6. `npm test` 全绿，含新增的 Oracle/Dummy parity 测试（覆盖排名、趋势分桶、坏 bin 频率三部分）。
7. Dummy 模式（`INFCONTROL_LAYER_BINS_DUMMY=true`）与真实 Oracle 模式下，同一份筛选条件计算出的排名/趋势/坏 bin 结构一致（允许具体数值因样本数据不同而不同，但字段/排序/评估规则逻辑一致）。
