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

### 改动点 1：`lotUnderperformingDutsResolve.ts` 的 `buildGoodBinsByPassFromJbRows`

去掉 `hasSignalByPass` / `jbRowHasExtraGoodBinSignal` 这道门槛。只要某 passId 至少有一行 JB 数据（不论 `PASSBIN` 解析出什么），就用 `goodBinIndicesForJbRow` 的并集（**恒含 BIN1 硬编码** + `PASSBIN` 切分出的每个数字）作为该 passId 的良品 bin 集合，写入 `goodBinsByPassId`。

`resolveGoodBinsForPass`（`lotUnderperformingDuts.ts`）不变：仍然是"`opts.goodBinsByPassId` 有该 passId 就直接用，否则退回 INF 启发式"——但因为改动 1 之后 `goodBinsByPassId` 对**所有**有 JB 数据的 passId 都会有值，INF 启发式这条回退路径在 `runLotUnderperformingDuts` 场景下事实上不会再被触发（除非 JB 行整体查询失败/异常）。

### 改动点 2：`agentToolHandlers.ts` 的 `lotDutConcentrationOpts`

不再调用 `goodBinNumbersFromSiteBinPasses(rawPasses)`。改为：用同一个 lot/device/passIds 查 JB 行（复用 `lotUnderperformingDutsResolve.ts` 导出的 `fetchJbTestRowsForLot` + `buildGoodBinsByPassFromJbRows`，两者需要从该文件导出），取当前 focus passId 对应的良品 bin 集合传给 `buildDutConcentrationInsights`。

### 改动点 3：删除死代码

`goodBinNumbersFromSiteBinPasses`（`agentDutConcentration.ts`）改完之后生产代码里没有调用点了，直接删除该函数及其专属测试文件 `test/agentDutConcentration.test.ts` 里对应的测试用例（YAGNI：不保留一个已证明有缺陷、且无人调用的启发式函数）。`buildDutConcentrationInsights` 本身保留（它不做良品 bin 判定，只是消费调用方传入的 `goodBins`）。

## 遗留的已知限制（不在本次修复范围内）

如果某 lot/pass 的 JB `PASSBIN` 字段本身完全为空（一行都没解析出任何数字），`goodBinIndicesForJbRow` 仍会硬编码兜底加上 BIN1。如果这个设备真实良品 bin 不是 BIN1、且 `PASSBIN` 恰好没填，判定仍会出错——但这是现有代码本来就有的行为，不是本次改动引入的新问题，本次不处理。

## 测试计划

- `test/lotUnderperformingDuts.test.ts` 或 `test/agentUnderperformingDutRoute.test.ts`（视现有测试文件归属）：新增回归用例，构造"单 lot、每 DUT total 均 < 100、PASSBIN 只给出 BIN1（无额外信号）"的场景，断言良品 bin 正确识别为 `{1}` 且良率不再被误判为 0%。
- 复用/扩展 `agentToolHandlers.ts` 里 `query_lot_dut_bin_agg` 相关测试，覆盖 `lotDutConcentrationOpts` 改用 PASSBIN 后的正确性。
- 删除 `agentDutConcentration.test.ts` 里 `goodBinNumbersFromSiteBinPasses` 专属的测试用例（函数已删除）。
- 运行 `npm test` 确认无回归。

## Oracle / Dummy 路径

`fetchJbTestRowsForLot`（`lotUnderperformingDutsResolve.ts`）已经同时实现了 Dummy（`jbTestRowsForLot`，读内存行）和 Oracle（`SELECT ... PASSBIN FROM INFCONTROL JOIN INFLAYERBINLIST`）两条路径。改动点 2 复用该函数后，`agentToolHandlers.ts` 的这条路径自动获得双路径同步，无需额外新增 SQL。
