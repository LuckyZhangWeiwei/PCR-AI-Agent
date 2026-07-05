# 单 Lot 良品 Bin 判定失效修复 — 设计文档

## 背景与问题

用户在生产环境向 Agent 问"WA01N39W 的测试情况"，Agent 先输出该 device 的最近 lot 列表，随后自动为最新一个 lot（DR41803.1Y，仅 1 片）追加"各 DUT 良率"明细表。表格显示 pass1 **整体良率 0%**（78 个 DUT 全部 0 good/total），并自带警示："疑该测试层非完整 TEST 层或良品 bin 非 BIN1，请核对 pass/bin 口径"。用户反馈：这看起来像是"逐片良率没有正常输出"。

排查结论：**这不是数据异常，是良品 bin 判定逻辑在单 lot 场景下必然失败**，与本次会话无关的历史遗留 bug。

## 根因

`tryAppendUnderperformingDutSection`（`agentLoop.ts`）→ `runLotUnderperformingDuts`（`lotUnderperformingDutsResolve.ts`）在判定"这个 pass 的良品 bin 是哪个"时：

1. 先查该 lot 的 JB `PASSBIN` 字段，若某 passId 的所有行都**只**解析出 BIN1（即没有"BIN1 之外"的额外良品 bin 信号，`jbRowHasExtraGoodBinSignal` 判定为 false），代码会**主动丢弃**这个 passId 的 PASSBIN 结果，改为信任度更低的 INF 数据启发式回退（`resolveGoodBinsForPass` → `buildGoodBinsFromInfHeuristic` → `goodBinNumbersFromSiteBinPasses`，定义于 `agentDutConcentration.ts`）。
2. 这个 INF 启发式的判定标准是"某 BIN 在该 pass 内平均每 DUT 的 die 数 > 100 才算良品 bin candidate"。查其现有测试（`test/agentDutConcentration.test.ts:41`，每 DUT 2000 颗）可知，这个阈值是按**跨多 lot 聚合**场景的量级设计的（die 数天然是几千起）。
3. `runLotUnderperformingDuts` 是**单 lot 单片**场景，示例数据里每个 DUT 的 total 只有 21~31 颗，远低于 100。**不管真实良品 bin 是哪个，单 lot 场景下任何 BIN 的"平均每 DUT die 数"都不可能超过 100**——启发式必然返回空集合 → 判定"没有良品 bin" → 所有 DUT 良品数强制为 0 → 触发"整体良率 0%"警示。

同样的 `goodBinNumbersFromSiteBinPasses`（die 体积启发式）还被 `agentToolHandlers.ts` 的 `lotDutConcentrationOpts`（`query_lot_dut_bin_agg` 工具的 DUT 集中度分析）直接调用，同样是单 lot 场景，同样会踩这个坑。

## 修复方案

**核心改动**：单 lot 场景下彻底不再依赖 die 体积启发式，改为直接信任 JB `PASSBIN` 字段——只要该 pass 有 JB 行数据，`PASSBIN` 按 `-` 切分出的每个数字都视为良品 bin（不再要求"必须有 BIN1 之外的额外信号才采信"）。

### ⚠️ 已知的取舍：与 NF12595.1A 历史修复的冲突

`buildGoodBinsByPassFromJbRows`（`lotUnderperformingDutsResolve.ts`）目前的"必须有 BIN1 之外额外信号才采信 PASSBIN"这道门槛，**不是随意加的**——`test/lotUnderperformingDuts.test.ts:148-156` 的回归测试注释明确写着这是为了修 NF12595.1A 那次的历史 bug：当 `PASSBIN` 字段为空（无信息）、且该设备真实良品 bin 不是 BIN1 时，如果直接信任"无信息 = 良品 bin 只有 BIN1"，会导致真实良品 bin 非 BIN1 的 lot 整体良率恒为 0%；当时的解法是"没有额外信号就不采信，退回 INF 启发式（`goodBinNumbersFromSiteBinPasses`）"。

本次去掉这道门槛、直接信任 `PASSBIN` split 结果（哪怕只解析出 BIN1、没有"额外信号"），**会重新引入 NF12595.1A 那类场景的回归风险**：如果未来某个设备的 `PASSBIN` 恰好为空、且真实良品 bin 不是 BIN1，会再次被误判为 0% 良率。

**该风险已与用户明确沟通并被接受**：单 lot 场景下 INF 启发式本身已被证实是坏的（本次修复的根因），与其保留一个"防住旧 bug 但制造新 bug"的门槛，不如直接信任 JB 权威字段 `PASSBIN`。若未来再次出现"`PASSBIN` 为空 + 良品 bin 非 BIN1"的场景，需要另外的信号源（而非本次废弃的 die 体积启发式）来解决，届时再评估。

### 改动点 1：`lotUnderperformingDutsResolve.ts` 的 `buildGoodBinsByPassFromJbRows`

去掉 `hasSignalByPass` / `jbRowHasExtraGoodBinSignal` 这道门槛。只要某 passId 至少有一行 JB 数据（不论 `PASSBIN` 解析出什么），就用 `goodBinIndicesForJbRow` 的并集（**恒含 BIN1 硬编码** + `PASSBIN` 切分出的每个数字）作为该 passId 的良品 bin 集合，写入 `goodBinsByPassId`。函数上方需加注释说明"曾经这里有道门槛专门防 NF12595.1A 那类 bug，现在移除，接受该回归风险，原因见设计文档"，避免以后有人看代码困惑。

`test/lotUnderperformingDuts.test.ts:148-156` 的现有测试 `"passId with no PASSBIN signal on any row is omitted..."` 断言的正是**旧行为**（无额外信号时 `map.has(1)` 为 `false`），必须同步改写为新行为的断言（`map.has(1)` 为 `true`，值为 `{1}`），并更新测试名和注释说明这是有意为之的取舍。

### 改动点 2：`lotUnderperformingDuts.ts` 的 `resolveGoodBinsForPass` 最终回退

`resolveGoodBinsForPass` 在 `opts.goodBinsByPassId` 里**完全没有**该 passId 的 key 时（不是"该 passId 有 key 但值为空"——改动 1 之后只要该 passId 有 JB 行数据、map 就必有该 key；只有当 JB 行查询压根没覆盖到这个 passId 时才会走到这一步），仍会调用 `buildGoodBinsFromInfHeuristic([pass])`（内部就是本次要删除的 `goodBinNumbersFromSiteBinPasses`）。这是本次改动前容易漏掉的第二个调用点：需要把这个最终回退也简化为固定返回 `new Set([HARD_GOOD_BIN])`（`HARD_GOOD_BIN` 已在本文件顶部定义为 `1`），并删除 `buildGoodBinsFromInfHeuristic` 函数与顶部 `import { goodBinNumbersFromSiteBinPasses } from "./agent/agentDutConcentration.js";`。

### 改动点 3：`agentToolHandlers.ts` 的 `lotDutConcentrationOpts`

不再调用 `goodBinNumbersFromSiteBinPasses(rawPasses)`。改为：用同一个 lot/device/passIds 查 JB 行（复用 `lotUnderperformingDutsResolve.ts` 导出的 `fetchJbTestRowsForLot` + `buildGoodBinsByPassFromJbRows`，前者需要新增 `export`），取所有 passId 的良品 bin 并集传给 `buildDutConcentrationInsights` 的 `goodBins`（该函数的 `goodBins` 本就是跨所有 pass 的单一 flat `Set<number>`，不是按 passId 分开的，改动不改变这个既有接口形状）。

### 改动点 4：删除死代码

完成改动 1、2、3 之后，`goodBinNumbersFromSiteBinPasses`（`agentDutConcentration.ts`）在生产代码里没有调用点了，直接删除该函数及其 JSDoc 注释，以及 `test/agentDutConcentration.test.ts` 里对应的测试用例（YAGNI：不保留一个已证明有缺陷、且无人调用的启发式函数）。`buildDutConcentrationInsights` 本身保留（它不做良品 bin 判定，只是消费调用方传入的 `goodBins`）。

**不在本次改动范围内**：`agentToolHandlers.ts` 里 `compactSiteBinPasses` 函数用的 `GOOD_BIN_AVG_THRESHOLD`（同样是 `avg > 100`），是一个独立定义的常量，只用于工具返回给 LLM 的 JSON payload 里"好 bin 只给汇总、坏 bin 给逐 DUT 明细"这个**展示层压缩**逻辑，不参与任何良率数字计算，误判的后果只是 LLM 看到的明细粒度不同，不是本次要修的"良率算错"问题，保持不动。

## 测试计划

- 改写 `test/lotUnderperformingDuts.test.ts:148-156` 的现有测试，反映新行为（见改动点 1）。
- `test/lotUnderperformingDuts.test.ts`：新增回归用例，构造"单 lot、每 DUT total 均 < 100（如 21~31）、PASSBIN 只给出 `\"1\"`（无额外信号）"的场景，用 `computeUnderperformingDutsForPass` + `buildGoodBinsByPassFromJbRows` 断言良品 bin 正确识别为 `{1}` 且良率不再被误判为 0%（复现本次 bug 场景）。
- 新增一条测试覆盖改动点 2（`resolveGoodBinsForPass` 在 `goodBinsByPassId` 完全没有该 passId 时回退到 `{1}`，而不是抛错或返回空集合）。
- 复用/扩展 `agentToolHandlers.ts` 里 `query_lot_dut_bin_agg` 相关测试，覆盖 `lotDutConcentrationOpts` 改用 PASSBIN 后的正确性。
- 删除 `agentDutConcentration.test.ts` 里 `goodBinNumbersFromSiteBinPasses` 专属的测试用例（函数已删除）。
- 运行 `npm test` 确认无回归。

## Oracle / Dummy 路径

`fetchJbTestRowsForLot`（`lotUnderperformingDutsResolve.ts`）已经同时实现了 Dummy（`jbTestRowsForLot`，读内存行）和 Oracle（`SELECT ... PASSBIN FROM INFCONTROL JOIN INFLAYERBINLIST`）两条路径。改动点 2 复用该函数后，`agentToolHandlers.ts` 的这条路径自动获得双路径同步，无需额外新增 SQL。
