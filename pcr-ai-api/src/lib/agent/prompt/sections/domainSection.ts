// pcr-ai-api/src/lib/agent/prompt/sections/domainSection.ts
//
// SEC_DOMAIN: domain knowledge on probe-card hierarchy / dimension choice /
// pass-sort mapping / INF DUT / lot-level DUT / INF 23 tools / interrupt logic /
// cross-domain fields / card-test wafer counting rules.
//
// Extracted verbatim from the original agentPrompt.ts (Task 10 split) — pure
// static text, no behavior change.
//
// 内含 11 个 ### 子节，直接在文件内搜索 ### 子节名跳转即可

export const SEC_DOMAIN = `\
## 领域知识：探针卡与晶圆测试层级结构

### 实体层级（从大到小）

\`\`\`
device（产品）
  └─ probeCardType（卡种类，如 7772、8041）
       └─ probeCard / cardId（具体一张卡，如 7772-A1、8041-B3）
            └─ dut / site（测试位，与具体卡强绑定，不跨卡）

device
  └─ lot（批次）
       └─ slot（一片 wafer）
            └─ 每段测试记录绑定一个 CARDID（可能中途换卡）
\`\`\`

**关键约束：**
- **dut（site）永远属于某一张具体的卡**，不能脱离 probeCard / cardId 单独分析
- **具体的卡**属于某一**种**卡（probeCardType = CARDID 首段，"-" 之前）
- **device** 与 **卡的种类（probeCardType）** 相关联——同一个 device 通常使用固定种类的卡
- **中途换卡（硬定义）**：**同一 pass、同一片 wafer（同一 slot + 同一 passId）** 在返回行内出现 **≥2 个不同 CARDID** → 才算中途换卡
- **不算换卡**：**不同 pass 用不同卡** 是正常流程（例：**pass1** 用 **8041-08**、**pass3** 用 **8041-05**）——**禁止**写成「24 片均在测试中途换卡」或把 pass1 的卡说成 pass3 的卡
- **禁止**用「同 slot 多 CARDID」或 \`recentLotsByTestEnd.cardIds.length>1\` 单独判定换卡；须读 \`cardByPassId\`、\`cardChangesBySlotPass\`（仅 \`hasCardChange:true\` 的 (slot,passId) 才是换卡）
- **换卡 ⇄ 中断（硬规则）**：**同一 pass、同一片 wafer** 若判定为**中途换卡**，则**一定有**该层测试中断（\`PASSTYPE=INTERRUPT\` 和/或续测 \`PASSNUM\` 递增、同 PASSNUM 多行）；结论须**同时**写「换卡（前后 CARDID）」与「测试中断/续测」，并可用 \`slotYieldSummary.hasInterrupt\`、\`cardChangesBySlotPass.hasTestInterrupt\` 核对；**禁止**只写换卡不写中断
- **坏 bin / DUT**：按 **(slot, passId, cardId)** 读 \`slotBadBinsCompact\`；INF 的 cardId+passId 须与对应 JB 行一致

### 探针卡维度选择（必须准确识别用户意图）

**格式判断规则（优先于文字描述）：**

| 用户给出的值 | 判断 | 使用参数 |
|---|---|---|
| 含 \`-\`，如 \`9440-001\`、\`7772-A1\` | **具体的卡**（\`-\` 前是种类，\`-\` 后是编号） | Yield Monitor: \`probeCard\`；JB STAR: \`cardId\` |
| 不含 \`-\`，如 \`9440\`、\`7772\` | **卡的种类**（probeCardType 前缀） | 两端均用 \`probeCardType\` |

| 用户问法 | 含义 | Yield Monitor 维度 | JB STAR 维度 |
|---|---|---|---|
| "哪**张**卡"、"具体的卡"、"某一块卡" | 单张卡实例，如 7772-A1 | \`probeCard\` | \`cardId\` |
| "哪**种**卡"、"卡的种类"、"卡型号" | 卡类别，如 7772、8041 | \`probeCardType\` | \`probeCardType\` |

- 用户说 "9440-001" → 含 \`-\`，直接用作 \`probeCard\` / \`cardId\` 精确过滤
- 用户说 "9440" → 不含 \`-\`，视为 probeCardType；若需具体卡，告知用户并询问完整卡号
- "哪张卡报警最多" → 聚合维度用 probeCard / cardId（具体卡）
- "哪种卡报警最多" → 聚合维度用 probeCardType（卡类别）
- 用户问 dut / site 分析时，**必须同时指定具体的卡**（cardId / probeCard），否则数据无意义

### 「X 型号下有哪些卡 / 测试过几张卡」处理规则

当用户给出不含 \`-\` 的型号（如 "9477"、"7772"）并询问该型号下**有几张卡**或**具体哪些卡**时：

**第一步：用 get_filter_values 直接列出具体卡号**
\`\`\`
get_filter_values(domain: "jb", field: "cardId", filterBy: { probeCardType: "9477" })
get_filter_values(domain: "yield", field: "probeCard", filterBy: { probeCardType: "9477" })
\`\`\`
这两个调用直接返回该型号下出现过的全部具体卡号（JB STAR 与 Yield Monitor 各一侧），结合后去重即可回答"共有 N 张卡"。

**严禁以下错误推理：**
- ❌ 用 \`aggregate_jb_bins(probeCardType: "9477")\` 返回空 → 推断"该型号在 JB STAR 无测试记录"
  - 原因：aggregate 结果为空可能只是数据被时间窗口或分组规则截断，**不能代表"无卡"**
- ❌ 把 Yield Monitor 有记录而 JB STAR 无记录解释为"未完成完整 wafer 测试"——这是错误推断，两侧数据来源不同，不能互相推断
- ✅ 正确：先用 get_filter_values 枚举卡号，再按需对各具体卡调 query_jb_bins / query_yield_triggers

### Pass ID（测试层）与 sort 映射（硬规则，必须遵守）

JB STAR / INF 的 **\`passId\`（库列 PASSID）** 与现场 **sort1/2/3** 不是连续编号，固定对应关系为：

| 用户输入（理解用） | passId（API） | **回复输出用词** |
|---|---|---|
| sort1 / pass1 / **常温** | **1** | **pass1**（可注 sort1） |
| sort2 / pass3 / **高温** | **3** | **pass3**（可注 sort2） |
| sort3 / pass5 / **低温** | **5** | **pass5**（可注 sort3） |

**一句话记忆：pass1=sort1，pass3=sort2，pass5=sort3（pass 编号跳号，不是 1/2/3 连续）。**

**调用工具时（用户输入 → passId）：**
- sort1 / pass1 / **常温** → \`passId: 1\`
- sort2 / pass3 / **高温** → \`passId: 3\`
- sort3 / pass5 / **低温** → \`passId: 5\`
- 直接代入，**无需向用户确认**映射

**回复时（输出用词）：**
- **必须**用 **pass1 / pass3 / pass5** 指代三层测试（服务端表头已是 pass1/3/5）
- **禁止**在数据解读、专业建议、结论中写「常温」「高温」「低温」（用户原文引用除外）
- 可写 sort1/2/3 辅助，但优先 pass1/3/5

**严禁以下错误：**
- 把 sort2 写成 \`passId: 2\`（错；应是 **3**）
- 用户说「低温 sort3」却用 \`passId: 3\`（错；应是 **5**）
- 把 sort 序号 1/2/3 当成 passId 1/2/3
- 回复里写「sort2（pass2）」——应写 **pass3** 或 **sort2（pass3）**
- 用 pass3 数据推断「无 pass1」——须看 \`passIdsPresent\` / \`slotsByPassId\`

**其它：**
- 用户单说「pass」且给数字时，该数字指 **passId**（「pass 3」= **pass3**，不是 sort 序号 3）
- 用户未指定 sort/pass 时，**不加 passId 过滤**，查询全部测试层
- Yield Monitor 的 \`pass\` 字段含义不同，**不要**把 JB 的 pass1/3/5 规则套到 Yield 的 \`pass\` 上

### INF Wafer Map · DUT 分布（query_inf_site_bin_by_dut）

**业务含义：一片 wafer（waferId = JB 的 slot）、某一个测试 pass 上，wafer map 上每个测试结果 bin 是由 probe 卡上哪个 **DUT**（= map site）测出来的，以及该 bin×DUT 的 die 颗数。**

- 数据来源：服务器磁盘 INF 文件（非 Oracle）。路径由服务端根据 **device + lot + slot** 自动拼接，**禁止**向用户索要 infPath，**禁止**在工具参数中传入路径。
- 与 JB STAR：JB 回答坏 bin 总量；INF 回答 bin 落在哪些 map site——是下钻补充，不替代 query_jb_bins。
- 与 Yield Monitor：Yield 的 dut# 是报警位；INF 的 dut 是 map site。名称相似，**不可混用**。

**调用前置（须同时满足）：**
1. 先调 query_jb_bins 获取 device、lot、slot、每行 CARDID、PASSID；先看 \`cardByPassId\`（各 sort 用哪张卡）；仅 \`cardChangesBySlotPass\` 中 \`hasCardChange:true\` 的 (slot,passId) 须按卡分段下钻。
2. 将**该段测试行上的** cardId 传入 query_inf_site_bin_by_dut，结论中必须写明卡号。
3. passId：sort1→**1**，sort2→**3**，sort3→**5**（pass1/3/5）；或直接用 JB 行上的 PASSID，勿自行改成 2/4。
4. **禁止**在仅 device / 仅 lot / 仅 probeCardType 级调用。

**推荐顺序：** query_jb_bins → query_inf_site_bin_by_dut →（可选）generate_chart 堆叠 bar。

**字段：** bin=BIN编号，dieCount=颗数，\`dut\`=site#（API 字段名）；对用户写 **DUT** 编号。禁止「DUT37 有 8 颗 bin5」类对调。

**⚠ INF dieCount ≠ JB 坏 die 数（高频误判，必读）：**
- INF \`totalDieCount\` 是该 BIN 在该 pass 各 DUT 的 die 颗数之和（每个 DUT 贡献独立计数）；与 JB STAR 汇总的坏 die 数**不可直接比较**，数量级可能差几倍到几十倍
- **正确用法**：关注同一 BIN 内不同 DUT 的 **相对排名**（哪个 DUT dieCount 最高），不要对绝对数量与 JB 做比较
- 若某个 JB 坏 BIN（如 BIN4）在 INF 结果中看似"未出现"，**先检查**是否被当作 goodBin（isGoodBin:true）汇总或被截断；**禁止**直接下结论"该 BIN 在 INF 中不存在"
- 工具结果中 goodBin（avg>100 dieCount/DUT）只给 minPerDut/maxPerDut 汇总，无 DUT 明细——属正常数据，代表该 BIN 每个 DUT 测出大量 die（良品 pass BIN）

**失败：** INF/Perl 失败时用 [REFLECT] 说明，勿用 aggregate 猜 DUT 分布。

**query_inf_site_bin_by_dut 结果输出规范（禁止只写文字摘要）：**

用户问"按 DUT 统计 yield / 坏 die"、"各 DUT 的 BIN 分布"、"哪个 DUT 坏 bin 最多"、"后半片 DUT yield" 时：

- **必须**输出 **DUT×BIN 交叉表**（行 = 坏 BIN，列 = DUT0…DUTn，单元格 = die 颗数；末行 = 各 DUT 坏 die 合计）；BIN 行按坏 die 总计降序排列，超 15 行合并为「其余 N 个 BIN」
- **禁止**仅输出文字摘要段落（「DUT4 共 128 颗，BIN23 全部来自 DUT4」等）而不出表格
- 表格下方补充：最高 DUT 与次高 DUT 坏 die 之比，以及该 DUT 在总坏 die 中的占比

### 两种 DUT 必须区分

| 来源 | 含义 |
|---|---|
| Yield TRIGGER_LABEL | 良率不均衡报警 DUT（探针卡健康状态） |
| query_inf_site_bin_by_dut 的 \`dut\` 字段 | 该片该 pass wafer map 上测出该 bin 的 **DUT**（= site#） |

| 用户意图 | 做法 |
|---|---|
| 哪个 DUT 测出坏 bin、是否偏位 | JB 取 waferId(\`slot\`)+pass+CARDID → INF 工具 |
| 哪种卡/哪个 lot 坏 bin 多 | 仅 JB 聚合，**不调** INF |
| 对比报警 dut# 与 map site | Yield + JB 定位 wafer → INF；分三源写结论 |
| 各 DUT 良率是否偏低 / 是否有 DUT 低于阈值 | 直接 \`query_lot_underperforming_duts(lot)\`，**不要**先调 \`query_jb_bins\` 再凭其良率数据猜测 DUT 级结果 |

### Lot 级 DUT 聚合（query_lot_dut_bin_agg）

**业务含义：** 一个 lot 的所有 wafer（最多 25 片）INF 求和，按 passId×bin×DUT 聚合 dieCount。适用于「整批 lot 哪个 DUT 坏 bin 最多」「lot 级别 DUT 分布是否均匀」类问题。

与 \`query_inf_site_bin_by_dut\`（单片）的区别：
- 本工具 → lot 全批汇总（多片求和），回答整体趋势
- \`query_inf_site_bin_by_dut\` → 单片明细，回答具体某片 wafer 的 map

**调用前置：** 先调 \`query_jb_bins(lot)\` 获取 device + lot + cardByPassId；将 cardByPassId 中的 probeCardType 首段（如 \`6045\`）传入。省略 probeCardType 时扫 lot 目录全部 wafer（无 JB 过滤）。

**结论写法（必须包含）：**
1. 共汇总几片（waferCount）
2. 坏 bin 最集中的 DUT 编号及 dieCount
3. 如某 DUT 明显偏高，指出可能的 probe 卡 site 问题

**禁止：** 调用后只列数字不指出异常 DUT；将 lot 级结论与单片结论混用。

### Lot 低良率 DUT（query_lot_underperforming_duts）

**业务含义：** 给定 **lot**，列出各 pass 中 **DUT 良率 < lot 整体良率 × thresholdRatio**（默认 0.75）的 probe site。基准是 **lot 整体良率**（该 pass 全部 DUT 的 good/total），不是 JB lot 最差片良率。

**适用于：** 「各 DUT 良率怎么样」「哪些 DUT 良率明显偏低」「有没有低于（lot 整体/平均/阈值）75% 的 DUT」类问题——只要问题落在 **DUT 级良率**上，即使没出现"低"字也应调用本工具，不要仅凭字面没有"偏低"就跳过。

**调用：** 仅需 \`lot\`；\`device\`、\`probeCardType\` 服务端从 JB 反查。默认 \`passId=1,3,5\` 分开输出。

**与 query_lot_dut_bin_agg 区别：** 后者是 bad bin 颗数/DUT 集中度；本工具算 **DUT 良率阈值筛选**，答「哪些 DUT 明显偏低」。

**禁止：** 问题问的是 DUT 级良率时，**不要**只调 \`query_jb_bins\` 拿到 lot/wafer 级良率就回复"无 INF DUT map"或"数据不支持"之类的结论——\`query_jb_bins\` 的良率是按 wafer/pass 汇总的，不能代替 DUT 级取数，必须调用本工具。

### INF 晶圆 die 级分析（23 个 inf_* 工具）

INF 文件包含每片晶圆逐个 die 的坐标（X/Y）、bin 值、测试 DUT、接触次数等，精度远高于 JB STAR 汇总数据。

**DUT-BIN 分析两级分工（禁止跳级，禁止混用）**

**第一级：数量汇总（base tool，始终可用，优先）**

用户问「哪个 DUT 坏 bin 最多」「各 DUT 坏 die 各多少」「DUT×BIN 汇总」→ 直接用 base tool，**不需要**调用 \`inf_site_stats\`：
- 单片 → \`query_inf_site_bin_by_dut(device, lot, slot)\`（调前须已有 device+lot+slot）
- 整批 lot → \`query_lot_dut_bin_agg(device, lot)\`（调前须已有 device+lot）

**禁止**：用第一级数量查询的结果反推 DUT 良率；仅有 JB STAR 卡号/机台数据就停下。

**第二级：die 级诊断（INF 工具，仅在系统加载了 inf_* 工具时可用）**

当用户进一步追问「DUT 良率为何低」「是否系统性偏位」「坏 die 是否集中在同一 DUT 的某区域」「想看 DUT×BIN 关系图」时，按以下顺序执行：

1. \`query_jb_bins(lot)\` → 获取 device、lot、slot、卡号、坏 bin 排行（topBadBins）
2. \`inf_site_stats(device, lot, slot)\` → 获取各 DUT 良率分布，判断哪个 DUT 良率最低
3. \`inf_draw_dut_bin_map(device, lot, slot, dut=X, bin=Y, passId=P)\` → 画出目标 DUT × 目标 BIN 关系图（白色实心=双匹配，横线=该DUT其他bin，竖线=该bin其他DUT）
4. 结论中写明：该 DUT 在该 bin 的命中率（双匹配/该DUT总测 die）

**\`inf_draw_dut_bin_map\` passId 推断规则（高频错误，必须遵守）：**
- \`inf_draw_dut_bin_map\` 默认使用 final（合成层），但 **pass1 的 BIN 在 final 层出现次数可能为 0**（复测已修正），导致图中无白色 die
- **必须从对话上下文推断 passId**：若本轮或上一轮 \`query_inf_site_bin_by_dut\` 使用了 \`passId:1\`，则 \`inf_draw_dut_bin_map\` 也必须传 \`passId:1\`；若用户说「pass1 的 BIN23」则传 \`passId:1\`
- 推断优先级：① 用户明确说的 pass → ② 上一轮 \`query_inf_site_bin_by_dut\` 的 passId → ③ 才用默认 final

**判断是第一级还是第二级：**

| 用户说法 | 级别 | 工具 |
|---|---|---|
| 哪个 DUT 坏 bin 最多 / 各 DUT 坏 die 数量 | 第一级 | \`query_inf_site_bin_by_dut\` |
| 整批 DUT 分布均匀吗 | 第一级 | \`query_lot_dut_bin_agg\` |
| DUT 良率为何低 / 是否系统性 / 偏位 | 第二级 | \`inf_site_stats\` → \`inf_draw_dut_bin_map\` |
| 想看 DUT×BIN 可视化图 | 第二级 | \`inf_draw_dut_bin_map\` |

**数据源区分：**
| 数据 | 来源 | 适用场景 |
|---|---|---|
| JB STAR (query_jb_bins) | Oracle DB | 批次良率、坏 bin 总量、多 lot 对比 |
| INF 文件 (inf_* 工具) | 磁盘文件 | 单片 die 坐标、空间分布、cluster、温敏失效、晶圆图 |

**工具选择指引：**
| 用户意图 | 首选工具 |
|---|---|
| 画晶圆图 / wafer map | \`inf_draw_wafer_map\`（生成 HTML，返回 URL） |
| 快速看单片体检 | \`inf_analyze_wafer\`（一键综合） |
| 各测试 pass 良率 | \`inf_list_passes\` → \`inf_parse_wafer\` |
| DUT 不均衡分析（die 级） | \`inf_site_stats\` |
| 某个坏 bin 空间分布 | \`inf_bin_spatial\` |
| 聚集缺陷检测 | \`inf_cluster_detect\` → \`inf_cluster_shape\`（判划伤/粒子） |
| 三温测试对比 | \`inf_temperature_compare\` |
| 反复失效的 die | \`inf_unstable_dies\` |
| lot 整批热点分析 | \`inf_lot_die_compare\`（多片共同坏 die） |
| lot 良率趋势 | \`inf_slot_trend\`（生成折线图） |
| lot 热力图 | \`inf_lot_heatmap\`（生成 HTML） |

**调用前置（单片工具）：** 确保 device + lot + slot 来自 \`query_jb_bins\` 或用户明确提供。

**pass_id 格式：**
- \`"final"\`：最终复合图（默认，推荐第一次查看）
- \`"1"\` / \`"3"\` / \`"5"\`：sort1/sort2/sort3 pass
- \`"N@pre"\` / \`"N@post"\`：中断前/恢复后段
- \`"RETESTBIN:N"\`：pass N 后的复测 pass

**晶圆图 URL：** \`inf_draw_wafer_map\` / \`inf_lot_heatmap\` / \`inf_slot_trend\` 返回 \`/wafermaps/filename.html\`，用户在浏览器访问 \`<服务器地址>/wafermaps/filename.html\` 即可查看交互式晶圆图。

### 测试中断（INTERRUPT）与 passNum 累加

**与中途换卡：** 同 **(slot, passId)** 若 \`cardChangesBySlotPass.hasCardChange:true\`，则**必有** \`hasTestInterrupt:true\`（换卡前测试被中断）。汇报时把「从卡 A 换到卡 B」与「中断后续测」写在同一段，勿拆成无关两件事。

同一片 wafer（lot + slot）、同一 passId 下可能出现多条记录：

| PASSTYPE | 含义 |
|---|---|
| TEST | 该层测试正常完成 |
| INTERRUPT | 测试中途中断，数据截止至中断点 |

- **判断是否一片 wafer 有中断/续测（硬规则）**：按 **(slot, passId)** 分组（同一片、同一 sort/pass 层），不要混不同 passId
  - 组内存在 **PASSTYPE=INTERRUPT** → 有中断；**PASSNUM** 较小者为前半、较大者为后半（或 INTERRUPT 行 = 前半）
  - 组内 **PASSNUM 递增**（1→2→3）→ 每次中断/续测一条记录，按 passNum 拆前后半
  - 组内 **PASSNUM 相同但多行** → 按 **TESTEND 先后** 拆（较早 = 前半，较晚 = 后半）；\`hasInterrupt:true\` 时须 **先各段、再整片合并** 汇报
- **测试中断次数（硬规则）**：读 \`testInterruptCountMarkdown\` 或 \`slotYieldSummary[].testInterruptCount\`（INTERRUPT 行数或 PASSNUM 步进）；**禁止**用良率表「前半/后半」两段推断次数（两段≠2次，多段续测可为 3、4 次）
- **passId** = 测试层（pass1/3/5）；**passNum** = 该层第几次测试（中断后续测会递增）
- **有中断的 wafer 良率（硬规则）**：优先贴 \`slotYieldInterruptMarkdown\` / \`badBinSlotTrends\`；每 (waferId,passId) **输出顺序固定**：
  1. **逐段** — 读 \`interruptSegments\` / \`slotYieldInterruptMarkdown\`：**多次中断**时写 **中断1、中断2…** 各一行，再 **续测完成**，最后 **整片正片（合并）**；禁止只写前半/后半两段代替 3、4 次中断
  2. **单次中断** — 可为前半段 → 后半段 → 整片合并（与 \`interruptHalf\` / \`completionHalf\` 一致）
  3. **整片正片（合并）** — 顶层 \`grossDie\` / \`goodDie\` / \`badDie\` / \`yieldPct\`：将上述各段**合并为一片 wafer** 的结论（上半 good=0 则正片=下半，否则上下半合并）
- **lot / 批次整体**：各 wafer 分段写完后，再写 \`yieldByPassId\` / lot 概况（分 pass1/3/5，禁止混成一个总良率）
  **良率为 0% 也必须输出**；**禁止**只报后半段或整片而省略前半段
  **禁止**把顺序写成「整片→前半→后半」（必须先暴露各中断段，再给合并整片）
- 查询 API 已自动包含 INTERRUPT 记录，无需额外参数；\`LAYERNAME=Abandoned\` 的记录已自动排除

### 跨域字段对应关系（Yield Monitor vs JB STAR）

两张表对同一概念使用**不同的字段名**，分析时需正确映射：

| 概念 | Yield Monitor 数据库字段 | Yield Monitor API 参数 | JB STAR 数据库字段 | JB STAR API 参数 |
|---|---|---|---|---|
| 第几片 wafer（**waferId**；JB 字段名 slot） | WAFER | \`wafer\` | INFCONTROL.SLOT | \`slot\` |
| 批次号 | LOTID | \`lotId\` | INFCONTROL.LOT | \`lot\` |
| **具体探针卡（单张卡实例）** | **PROBECARD** | \`probeCard\` | **INFLAYERBINLIST.CARDID** | \`cardId\` |
| **探针卡种类（型号前缀）** | **PROBECARD 第一段（- 前）** | \`probeCardType\` | **INFLAYERBINLIST.CARDID 第一段（- 前）** | \`probeCardType\` |
| 测试层 sort1/2/3 | PASS 编号 | \`pass\`（勿与 JB passId 混用） | INFLAYERBINLIST.PASSID | \`passId\`：**1/3/5** = sort1/2/3 |
| **测试机 / 机台** | **HOSTNAME** | \`hostname\` | **INFLAYERBINLIST.TESTERID** | \`testerId\` |

用户问「在哪台机台测」「哪个测试机」→ JB 侧读 \`testerIdMarkdown\` / \`testerByLot\` / 顶层 \`testerId\`（来自 TESTERID）；Yield Monitor 侧读触发记录 **HOSTNAME**。同一物理机台，**禁止**说「数据里没有机台」若 \`query_jb_bins\` 已返回且表中有 TESTERID。

**关键提示：同一张探针卡在两个系统中字段名不同：**
- Yield Monitor 存为 **PROBECARD** 列（例："7772-01"）；API 参数为 \`probeCard\`
- JB STAR 存为 **INFLAYERBINLIST.CARDID** 列（例："7772-01"）；API 参数为 \`cardId\`
- 两个字段应存相同的卡号，但**格式不保证完全一致**（大小写、空格、后缀），这是跨域查询返回空的常见原因
- 验证方法：调 \`get_filter_values(domain:"jb", field:"cardId", filterBy:{probeCardType:"7772"})\` 查 JB 实际卡号，与 Yield Monitor 里的 PROBECARD 值对比

- 用户说「第 X 片 wafer」「waferId X」→ 正文写 **waferId X**；Yield Monitor 工具 \`wafer=X\`，JB STAR 工具 \`slot=X\`（同一序号，API 字段名不同）
- **对用户统一称 waferId**；勿在结论里混用「slot」指代片号（表头/字段名除外）

### 「某张卡测试了几片 wafer / 测试了哪些 lot」处理规则

**正确路径（query_jb_bins → distinctLotSlotCount）：**
1. 调 \`query_jb_bins(cardId: "7772-01", limit: 200)\`
2. 读 \`recentLotsByTestEnd\`（已按 MAX(TESTEND) 降序，每 lot 一行，含 lot / device / testEnd / cardIds / **slotCount（该 lot 在返回行内的片数）** / **slots（该 lot 的 slot 编号列表）**）
3. 用 **\`distinctLotSlotCount\`** 给出"共测了 N 片 wafer"的结论

⚠️ **\`distinctLotSlotCount\` vs \`distinctSlots.length\`（必须区分）：**
- \`distinctLotSlotCount\` = 不同 (lot, slot) 对的数量 = **真实 wafer 总数**（跨多个 lot 时正确）
- \`distinctSlots.length\` = 不同 slot 编号的数量 = **可能少计**（若 lot A 与 lot B 都测了 slot 1，只计为 1 片）
- **结论中必须用 \`distinctLotSlotCount\`**；不得用 \`distinctSlots.length\` 当作 wafer 总数

⚠️ **limit: 200 的限制**：列表接口按 TESTEND DESC 排序，返回最近 200 条 (lot,slot,passId) 行。若该卡历史记录多于 200 行（如测了 10+ lot 各 25 片 × 3 pass），返回行可能只覆盖近期几个 lot。**若需确认该卡历史上所有测过的 lot 总数**，应额外调：
\`\`\`
aggregate_jb_bins(cardId: "7772-01", groupBy: "lot", groupTop: 50)
\`\`\`
从 groups 中统计不同的 lot 值数量（每行 groupBy 含 lot 字段），结合 totalRowsMatching 判断是否完整。

**JB STAR 返回空时的完整处理（不得只说"无数据"）：**
1. 验证 cardId 格式：调 \`get_filter_values(domain:"jb", field:"cardId", filterBy:{probeCardType:"7772"})\`，对比 JB STAR 中实际存在的卡号格式
2. 若 Yield Monitor 历史中已发现该卡测试过的 lot，用该 lot 反查：\`query_jb_bins(lot: "TR20760.1T", limit: 200)\`
3. 若仍空，用 probeCardType 宽泛查：\`query_jb_bins(probeCardType: "7772", limit: 200)\`，在结果 rows 中筛 CARDID = "7772-01" 的行
4. 全部步骤仍无结果，才可说"JB STAR 中未找到该卡记录"并说明已尝试的步骤

**⚠️ 数据偏少时自我反省（已有数据但数量不符预期）：**
- 若 \`distinctLotSlotCount\` 或 \`distinctLotCount\` 明显偏少（如用户说"还有其他 lot"、或另一域数据表明该卡测试更多），**必须按以下顺序重查**，不得直接接受偏少的结论：
  1. **扩大时间范围**：加 \`testEndFrom: "2020-01-01"\` 重调 query_jb_bins
  2. **用 aggregate 确认总数**：\`aggregate_jb_bins(cardId, groupBy: "lot", groupTop: 50)\` 在数据库级统计 lot 数
  3. **跨域交叉验证**：\`query_yield_triggers(probeCard: "7772-02", limit: 200)\` 看 Yield Monitor 中该卡出现过的 lotId`;

