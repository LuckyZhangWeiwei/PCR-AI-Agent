# Cursor 修复交接（2026-07-23 · 给 Claude Code）

> **执行者：** Cursor Agent  
> **读者：** Claude Code / 接手 Agent mask·device「测试情况」lot 列表的 Agent  
> **前置阅读：** [`HANDOFF_AGENT_JB_LOT_LISTING.md`](HANDOFF_AGENT_JB_LOT_LISTING.md)；[`HANDOFF_AGENT_JB_DETERMINISTIC_SUMMARY.md`](HANDOFF_AGENT_JB_DETERMINISTIC_SUMMARY.md)  
> **分支：** `main`  
> **范围：** mask/device「最近一个月测试情况」类问法 → 富表 lot 列表（良率 / 坏 bin / DUT / 平均良率 / 前 20），禁止单 lot 概况代答与「坏 BIN 分布」图

---

## 0. 一眼结论

| 项 | 状态 | 说明 |
|---|---|---|
| **现象** | ✅ 已修 | 「P02G 最近一个月的测试情况」只出基础 lot 表（50 行、无良率/坏 bin），并夹带最新单 lot 的「数据解读」+「坏 BIN 分布」图 |
| **根因** | ✅ 已定位 | `P02G` 是 4 位 **mask**，`isDeviceTestOverviewQuestion` 只认完整 device → 落 `lot_overview`；mask 多 lot 虽改出列表，但 **未带富表 presentation**；`lot_overview` 仍挂 primary lot 柱状图 |
| **改法** | ✅ 已合入 | mask 概况 → `lot_listing` 富表；默认 topN=20；相关 DUT 列；概况路径补 `aggregate_jb_bins`；`shouldSkipTopBadBinDistChart` |
| **本地单测** | ✅ | `npx tsx --test test/agentJbDeterministicReply.test.ts test/agentQueryScope.test.ts test/agentJbMaskScopeRoute.test.ts` → **全绿** |
| **部署后复验** | ⏭ 待做 | `cd pcr-ai-api && npm run build && pm2 reload` 后重问下方真库句 |

---

## 1. 问题复现

用户问：

> P02G 最近一个月的测试情况，要加上平均 yield，以及主要坏 bin，和相关 dut，显示前 20 条

**修前实测：**

- 表头：`# | Lot | Device | 测试结束 | 片数 | 数据来源`（无良率 / 坏 bin / DUT）
- 「共 57 个 lot，下表列前 **50** 个」
- 下方 LLM「数据解读」写最新单 lot 的 pass1 BIN40 聚集（答非所问）
- 可能再挂「坏 BIN 分布（最新 lot）」柱状图

---

## 2. 根因

1. **`isDeviceTestOverviewQuestion`** 要求 `inferDeviceFromText`（完整 `WA03P02G`），**不认**独立 mask `P02G` → `detectJbReplyMode` = `lot_overview`。
2. `lot_overview` + `isMaskLevelQuestionOnMultiLotPayload` 分支虽改出 `buildRecentLotsListingMarkdown`，但 **未传** `inferLotListingPresentation` → 默认 `includeYield: false` → 基础表。
3. `mode === lot_overview` 时 `emitDeterministicJbTablesReply` 仍 `tryEmitTopBinBarChart`（标题 **坏 BIN 分布**），数据来自 multi-lot payload 的 **primary lot**，与列表意图无关。
4. `jbReplySkipsCommentaryLlm(lot_overview)` 为 false → 仍跑解读 LLM，写成单 lot 分析。

---

## 3. 改法（已合入）

| 文件 | 变更 |
| --- | --- |
| `jb/agentJbQuestionClassifiers.ts` | `isDeviceTestOverviewQuestion` 接受 **mask**；`isTesterTestOverviewQuestion` 排除 mask |
| `jb/agentJbListingMarkdown.ts` | 概况富表：`includeSuspectDuts`；默认 **topN=20**；解析「前20条」；富表「相关 DUT」列 |
| `jb/agentJbOverviewMarkdown.ts` | mask 多 lot / `card_test_overview` 强制富表 presentation |
| `dispatch/.../agentJbLotDirectRoutes.ts` | `includeFailBins` 时补 `aggregate_jb_bins(lot,bin)` |
| `jbRouteResolver.ts` | LLM 失败 mask 概况降级 → **`lot_listing`**（原 `lot_overview`） |
| `render/agentJbTablesReply.ts` | **`shouldSkipTopBadBinDistChart`**：列表/概况不问单 lot「坏 BIN 分布」图 |
| `test/agentJbDeterministicReply.test.ts` / `jbRouteResolver.test.ts` | 回归 |

**呈现约定（概况类）：**

| 列 / 块 | 有 |
| --- | --- |
| 良率% / 探针卡 / 主要坏 bin / 相关 DUT | ✅ |
| 平均良率（表下） | ✅ |
| 默认前 20 条 | ✅ |
| 单 lot「坏 BIN 分布」图 | ❌（本类问法） |
| 单 lot「数据解读」LLM | ❌（`lot_listing` skip commentary） |

**相关 DUT：** 来自会话内 YM `TRIGGER_LABEL` 的 `dut#`；无 YM 数据时列为 `—`（未在本修中自动补查 YM）。

---

## 4. 验证

**本地（已跑）：**

```bash
cd pcr-ai-api
npx tsx --test test/agentJbDeterministicReply.test.ts test/agentQueryScope.test.ts test/agentJbMaskScopeRoute.test.ts
```

关键断言：`detectJbReplyMode("P02G 最近一个月的测试情况") === "lot_listing"`；`inferLotListingPresentation` → topN=20 + 平均良率 + DUT；`shouldSkipTopBadBinDistChart` 对 mask 概况为 true、对单 lot 概况为 false。

**部署后真库（⏭ Claude Code / 运维）：**

```bash
cd pcr-ai-api && npm run build && pm2 reload
```

Agent 重问：

> P02G 最近一个月的测试情况

**判定：**

1. 模式等价 **lot 富表**（含良率% / 主要坏 bin / 相关 DUT），**下表列前 20**（或共 ≤20 时列全）
2. 表下有 **平均良率**
3. **无**「坏 BIN 分布（某 lot）」柱状图
4. **无**针对最新单 lot 的「pass1 聚集 BIN…」类解读代答列表

可选对照：`NF13816.1J 整体测试情况` — 仍应允许单 lot 概况 + 坏 BIN 分布图（回归）。

---

## 5. 已知限制 / 后续

- 相关 DUT 依赖本轮已有 YM 工具结果；概况直连路径未自动 `query_yield_triggers`。若产品要求概况必填 DUT，需在 `tryRunLotListingDirectRoute` 加 YM enrichment。
- 「所有 lot 都列出来」仍可不截断 topN（仅概况默认 20）；`recentLotsByTestEnd` 上限仍受 DB 侧 50 影响。
- 无时间窗的 mask「测试情况」（如「P11C 最近的测试情况」无「一个月」）会先走 **时间澄清**（与卡/device 概况一致），不再静默全量 mask scope。

---

## 6. 给 Claude Code 的下一步

1. 部署 API 并跑 §4 真库句。  
2. 若 DUT 列长期为 `—` 且产品要求必填 → 设计概况路径 YM 补查。  
3. 勿把 mask 概况改回 `lot_overview` + 单 lot 图表。
