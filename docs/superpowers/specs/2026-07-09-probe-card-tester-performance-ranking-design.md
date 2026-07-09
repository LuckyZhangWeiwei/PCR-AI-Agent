# REQ-KLWT-019 变体：Probe Card / Tester 良率排名（AI Agent 能力）设计

**日期：** 2026-07-09
**背景：** 用户参考了另一个项目的截图（REQ-KLWT-019：上传 ProbeView 导出的 Excel，让 AI 分析「最佳 Probe Card + Tester + PassName 组合」及「Probe Card 最差表现排名」）。确认后本项目**不做文件上传**——直接用现有 JB STAR（INFCONTROL⋈INFLAYERBINLIST）数据，把这个分析能力做成现有 AI Agent 的一个新工具。

---

## 1. 目标

用户在 AI Agent 对话里问类似「这个 device 下最好的探针卡+机台组合是什么」「探针卡表现排名」时，Agent 能给出：

1. **组合排名表**：按 `(cardId, testerId, passId)` 分组的良率排名（最好在前）。
2. **探针卡排名表**：按 `cardId` 聚合（跨 tester）的良率排名（最差在前），带规则触发的评估文字。

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

1. **取数据**：仿照 v4 聚合的既有模式（`aggregateInfcontrolLayerBinV3FromRows`）——Oracle 端先 `COUNT` 再用 `buildInfcontrolLayerBinsV3SqlFullMatching` 拉全量匹配行（受 `MEMORY_AGG_ORACLE_MAX_ROWS` 限制）；Dummy 端用同一份 `INFCONTROL_LAYER_BINS_DUMMY` 内存行（JBStart.xlsx）做同等筛选。
2. **算每行良率**：复用现有坏 bin 计算工具（`PASSBIN` token 排除逻辑，与 `jbYieldCalc.ts` / `passBinSemantics.ts` 一致的口径）算出该行（一片 wafer 的一次 pass）的 `rowYield = 1 - badDieSum / grossDie`。
3. **分组聚合（纯函数，Oracle/Dummy 共用同一份计算代码，只是输入行数组来源不同——天然满足 dummy-parity）**：
   - **组合维度** `(cardId, testerId, passId)`：`avgYield`、`stdDevYield`（样本标准差）、`recordCount`（片数）、`lotCount`（distinct lot 数）。
   - **探针卡维度** `cardId`（同一 device + passId 范围内，跨 tester）：同样四个指标。
4. **新文件（拟定）**：
   - `pcr-ai-api/src/lib/probeCardTesterPerformance.ts` — 分组聚合纯函数 + markdown 表构建。
   - 复用 `infcontrolLayerBinFilters.ts`（筛选解析）、`infcontrolLayerBinDummy.ts`（Dummy 全量行获取）、`passBinSemantics.ts` / `jbYieldCalc.ts`（良率计算）。

---

## 4. 排名与评分规则（确定性规则，不用 LLM 打分，不用星级）

### 4.1 组合排名表（每个 passId 一张）

- 排序：`avgYield` 降序；并列时 `stdDevYield` 升序决胜；再并列按 `recordCount` 降序。
- 列：排名、CardId、TesterId、平均良率、标准差、片数、Lot 数。
- 样本量提示：`lotCount < 3` 时该行标注「样本有限」（不剔除，只是弱化置信度，与截图「Combine yield and consistency into a balanced ranking」的用意一致，但不做黑箱加权分数，保持可解释）。

### 4.2 探针卡排名表（每个 passId 一张，最差在前）

- 排序：`avgYield` 升序（最差最先看到）。
- 列：排名、CardId、平均良率、标准差、片数、Lot 数、评估。
- **评估文字（规则触发，按优先级取第一条匹配）：**
  1. `lotCount < 3` → 「样本有限，置信度低」
  2. `avgYield < 组内均值 − 1.5 × 组内标准差`（且 `lotCount >= 3`）→ 「良率明显偏低」——「组内」指同一次查询返回的探针卡集合（同 device + passId 下所有 cardId）的 `avgYield` 分布，均值/标准差在生成该表时现算，不是全局常量
  3. `stdDevYield > 组内标准差的中位数`（且未命中 1/2）→ 「波动较大，稳定性差」——同样基于本次查询返回的探针卡集合内 `stdDevYield` 分布取中位数
  4. 否则 → 「表现稳定」

不做五星评分/彩色图标——服务端表直出数字 + 简短规则标签，LLM 在後面的「数据解读」「专业建议」里用自然语言展开，这与项目现有 JB 确定性总结的输出风格一致（避免又发明一套新的展示体系）。

---

## 5. Agent 集成

- **新工具 schema**：`aggregate_probe_card_tester_performance`（`agentToolSchemas.ts`）
  - 入参：`device`（必需）、`passId`（可选，1/3/5）、`testEndFrom`/`testEndTo`（可选）。
  - 描述：用于回答"哪个探针卡+测试机组合良率最好/最差""探针卡表现排名"类问题；明确说明未给 `passId` 时会分 pass1/pass3/pass5 分别输出，禁止跨 sort 合并。
- **工具执行**（`agentToolHandlers.ts`）：调用新聚合函数，返回结构化 JSON（含两类表的原始数据）+ 预先拼好的 markdown（组合表 + 探针卡表 × 各 passId）。
- **总结轮**：复用现有确定性总结机制思路——工具结果里的 markdown 表直出，LLM 只追加 `### 数据解读` + `### 专业建议`（复用 `BRIEF_COMMENTARY_SYSTEM` 风格，聚焦 Wafer Test / Probe Card 维护角度）。
- **Prompt 规则**（`agentPrompt.ts`）：新增一节说明何时调用此工具、术语用词（cardId 对用户仍可称"探针卡"，testerId 称"测试机/机台"）、禁止跨 passId 合并。

---

## 6. Dummy/Oracle Parity

- 分组聚合的核心计算逻辑是**唯一一份纯函数**，输入统一为「已筛选的行数组」；Oracle 路径负责拉全量匹配行，Dummy 路径负责从内存表筛选出等价的行数组，二者调用同一个计算函数——从架构上避免了口径分叉。
- 仍需为 Oracle 全量行 SQL 与 Dummy 筛选各自实现/复用现有筛选逻辑（`parseInfcontrolLayerBinsV3Query` 系列），确保 `device`/`passId`/时间窗筛选语义一致。
- `npm test` 需覆盖：分组计算纯函数单测、Oracle/Dummy 两路径 parity 测试、Agent 工具 schema 与 prompt 路由测试。

---

## 7. 范围外（v1 不做）

- 不做文件上传 / Excel 解析入口（原始截图的形式，已确认不需要）。
- 不引入 Yield Monitor 数据做联合评分。
- 不做五星可视化评分或前端图表面板——先作为 Agent 对话内 markdown 表格能力交付；是否需要独立报表 Tab 展示，后续按需再提。
- 不做跨 device 汇总排名。

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

1. 问「WA03P02G 这个 device 下最好的探针卡+机台组合」→ Agent 调用新工具，输出 pass1/pass3/pass5 三张组合排名表（未指定 passId 时），数字与手工用 JB STAR 原始数据核算一致。
2. 问「哪张探针卡表现最差」→ 输出探针卡排名表（最差在前）+ 规则触发的评估文字，样本量少的卡标注「样本有限」。
3. 指定 `passId` 时只出该 pass 的表，不与其它 sort 混算。
4. `npm test` 全绿，含新增的 Oracle/Dummy parity 测试。
5. Dummy 模式（`INFCONTROL_LAYER_BINS_DUMMY=true`）与真实 Oracle 模式下，同一份筛选条件计算出的排名结构一致（允许具体数值因样本数据不同而不同，但字段/排序/评估规则逻辑一致）。
