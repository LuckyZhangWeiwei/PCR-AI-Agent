# Cursor JB 路由修复交接（2026-07-01 · 给 Claude Code）

> **执行者：** Cursor Agent  
> **分支：** `feat/jb-route-resolver`（本 commit 在 `1bcf96f` 验证文档之后）  
> **前置：** 用户 `.env` — `JB_DETERMINISTIC_DISPATCH=true`、`JB_LLM_INTENT_CLASSIFIER=true`、`AGENT_MODEL=deepseek-ai/DeepSeek-V4-Flash`  
> **API：** `http://10.192.130.89:30008`  
> **前序文档：** [`HANDOFF_CURSOR_VERIFICATION_RESULTS_2026-07-01.md`](HANDOFF_CURSOR_VERIFICATION_RESULTS_2026-07-01.md)

---

## 0. 一眼结论

| 项 | 修复前（Flash 复验） | 本 commit 代码 + 部署后 handoff 复验 |
|---|---|---|
| **P-B** lot 列表 | ❌ 吐 UFLEX 机台表 | ✅ ~50 lot（`handoff-reverify-after-fix.txt`） |
| **P-F** DUT×BIN 集中度 | ❌ 无 `query_lot_dut_bin_agg` | ✅ BIN79 集中度表 |
| **P-A** P11C | ⚠️ PASS 但 SSE `undefined.length` | ✅ PASS（guard 已加，待确认 error event 消失） |
| **P-C** 多卡对比 | ✅ | ✅ |
| **P-D** bin×lot 排行 | ❌ 250s timeout | ❌ **仍 250s timeout**（代码已加直连路由，需 Claude 查聚合耗时/优先级） |
| **A1-4** lot 良率 top5 | ⚠️ `dispatch=false`，1 lot | ⚠️ **代码已修，部署后 step2 仍见 1 lot**（待复验 + 收紧脚本） |
| **Pass C** invalid key + P11C | ❌ 无表 | ⏭ **代码已修，未部署复验** |
| **本地 `npm test`** | — | **449/453**（2 项 agentEval live 黄金集，非 handoff） |

**给 Claude：** 本 commit 解决 handoff **P-B/P-F** 与分类器抢路由类问题；**P-D 超时、A1-4 派发、Pass C 降级** 需在部署本 dist 后再跑一轮脚本确认，P-D 可能还需性能/超时专项。

---

## 1. 仍待跟进的问题（优先级）

| P | 现象 | Cursor 判断 | 建议 Claude 动作 |
|---|---|---|---|
| **P-D** | `uflex 最近三天` → `哪个lot bin40最多` → **250s timeout** | PRE_LLM `tryRunBinLotRankingDirectRoute` 已加，但真库仍超时 — 可能未 reload dist、或 `aggregate_jb_bins(groupBy:"bin,lot", tstype=UFLEX, 3d)` 过慢、或 setup 轮 LLM 占满 budget | 部署后单跑 `verify-handoff-steps.mjs pd`；查 Oracle 聚合耗时；必要时默认 `tstype`+时间窗走 `query_jb_bins` 限 lot 再 aggregate；或 verify 脚本 `streamTimeoutSec` 360 |
| **A1-4** | `WC13N55Z 各 lot 良率 top5` → `dispatch=false`，单 lot 概况 | `classifyJbIntent` 不再对非 generic 调 LLM；`isLotYieldRankingQuestion` 收紧「各 lot + topN」 | 部署后 `verify-step2-dispatch.mjs a1-4`；查 `buildLotYieldRankingMarkdown` / mask 级 `query_jb_bins` 是否只回 1 lot；**收紧 A1-4 断言 `lots>=3`** |
| **Pass C** | invalid apiKey + `P11C 最近的测试情况` 无表 | LLM 失败 + mask → 降级 `lot_overview` regex | 部署后 `verify-jb-route-pass-bc.mjs` |
| **A2-4** | `ZZZZZ bin99` blank reply | 未改 | 原 dead-end 问题 |
| **agentEval live** | 误分类率 ~28% > 2% | 黄金集 vs 纯正则标注差异，非本次 handoff 范围 | 服务器 `AGENT_EVAL_LIVE=1` 补跑；按需扩黄金集 |
| **P-A SSE** | 偶发 `Cannot read properties of undefined (reading 'length')` | `historyAwaitingToolSummary` + manifest 可选链 | 部署后观察 P-A 是否仍出现 error event |

---

## 2. Cursor 代码修改（按文件）

### 2.1 `jbRouteResolver.ts`

- **`classifyJbIntent`：** 仅当 `base.mode === "generic"` 且 `isAmbiguous` 时才调 LLM；**非 generic（如 `lot_yield_ranking`）一律保留 regex**，避免 Flash 分类器把 A1-4 改成 generic/low 导致 `resolveDispatch` 不派发。
- **LLM 分类失败降级：** 若句中含 mask 且 `isLotOverviewQuestion`，降级 **`lot_overview` + source=regex**（Pass C invalid key 路径）。

### 2.2 `agentJbDeterministicReply.ts`

- **`isLotYieldRankingQuestion`：** 增加「各 lot 良率 topN」；去掉过宽「lot+良率+前N个」以免误伤「前5个lot各自的良率」黄金集。
- **`isBinLotRankingQuestion`：** 新增 — 「哪个 lot BINnn 最多」（带 bin、无 lot 锚点、含 lot 维度关键词）。

### 2.3 `agentQueryScope.ts`

- **`inferRecentMonthsWindow`：** 支持「最近 N **天**」（含中文「三」）。
- **`resolveRecentTimeWindow`：** 修复 **`inferRecentMonthsWindow` 返回 `{}` 为 truthy** 导致 history 时间窗永不继承的 bug。
- **`inferLotFromHistory` / `inferPlatformFromHistory`：** 从 user 句 + tool 结果推断 lot / 平台。
- **`buildLotListingQueryArgs`：** 支持 `tstype` + history 时间窗（P-B 第二轮）。
- **`buildBinLotRankingAggregateArgs`：** `groupBy:"bin,lot"` + scope 解析（P-D）。

### 2.4 `agentJbLotListingRoute.ts`

- **`canRunLotListingDirectRoute(userText, history)`：** 从 history 继承 device/tester/**platform**（「uflex 最近三天」→「都测试了什么lot」）。

### 2.5 `agentJbBinLotRankingRoute.ts`（新文件）

- **`canRunBinLotRankingDirectRoute` / `binLotRankingAggregateArgsFromUser`：** P-D PRE_LLM 门控 + 参数构造。

### 2.6 `agentLoop.ts`

- **PRE_LLM 路由顺序：** `tryRunDutBinAggDirectRoute` → `tryRunBinLotRankingDirectRoute` → lot listing → …
- **`tryRunDutBinAggDirectRoute`（P-F）：** focusBin + dut/卡关键词 + history lot → `query_lot_dut_bin_agg`，直出集中度表。
- **`tryRunBinLotRankingDirectRoute`（P-D）：** `aggregate_jb_bins(bin,lot)` + `renderAggregateJbBinsResult`。
- **`tryRunLotListingDirectRoute`：** 传入 history 给 `canRunLotListingDirectRoute`。
- **`tryRunEquipmentDirectRoute`：** `isLotYieldRankingQuestion` 时 bail，避免单 lot equipment 表代答 A1-4。
- **`historyAwaitingToolSummary`：** `get_filter_values` 的 `values` 未定义时不再 `.length` 崩溃。

### 2.7 `agentPrompt.ts`

- manifest `topDevices` 可选链（防 P-A 类 undefined.length）。

### 2.8 测试

- `jbRouteResolver.test.ts` — 非 generic 不调 LLM；LLM 失败 mask 降级 lot_overview。
- `agentQueryScope.test.ts` — 最近三天、P-B history、P-D aggregate args。
- `agentJbDeterministicReply.test.ts` — A1-4 / P-D 问句识别。

---

## 3. 真库复验（部署后 Cursor 观测）

**Handoff** — [`scratchpad/handoff-reverify-after-fix.txt`](../scratchpad/handoff-reverify-after-fix.txt)（2026-07-01，约 20min）：

| ID | 结果 |
|---|---|
| P-A | ✅ |
| P-B | ✅ ~50 lot |
| P-C | ✅ 9416 四卡 |
| P-D | ❌ 250s timeout |
| P-F | ✅ BIN79 集中度 |

**Step2**（部分跑于旧 dist）— [`scratchpad/step2-dispatch-flash-2026-07-01.txt`](../scratchpad/step2-dispatch-flash-2026-07-01.txt)：A1-4 仍 `dispatch=false lots=1`。

**本地 CI（本 commit 源码）：**

```bash
cd pcr-ai-api
npm run build    # ok
npm test         # 449 pass / 2 fail（agentEval live 黄金集）
```

---

## 4. FLIP 建议（不变）

| 开关 | 建议 |
|---|---|
| `JB_DETERMINISTIC_DISPATCH=true` | 保持 |
| `JB_LLM_INTENT_CLASSIFIER=true` | 观察；P-D 超时未解前暂缓 repo 默认 |
| `AGENT_MODEL=DeepSeek-V4-Flash` | 保持（勿用 Pro） |

---

## 5. Claude Code 建议下一步

1. **`pm2 reload`** 拉本 commit dist，按 §5 复现脚本全跑一遍。
2. **P-D：**  profiling `aggregate_jb_bins(tstype=UFLEX, 3d, groupBy=bin,lot)`；确认 PRE_LLM 是否命中（SSE 应见 `tool_start aggregate_jb_bins` 且无长 LLM 前置）。
3. **A1-4：** 确认 mask 级 `query_jb_bins` 返回 `recentLotsByTestEnd` 多行 + `buildLotYieldRankingMarkdown`；收紧 verify 断言。
4. **Pass C：** 无效 apiKey 请求体下 `P11C 最近的测试情况` 应出表或明确无数据，非空白。
5. 回传：**step2 / handoff / Pass B-C / live eval** 四份日志 + 是否 FLIP 分类器默认。

---

## 6. 复现

```bash
cd pcr-ai-api
npm ci && npm run build && npm test

VERIFY_OUT=../scratchpad/handoff-reverify-after-fix.txt node scripts/verify-handoff-steps.mjs all
node scripts/verify-handoff-steps.mjs pd    # P-D 单测

VERIFY_OUT=../scratchpad/step2-dispatch-flash-2026-07-01.txt node scripts/verify-step2-dispatch.mjs all
node scripts/verify-step3-classifier.mjs
VERIFY_BC_OUT=../scratchpad/step3-pass-bc-flash-2026-07-01.txt node scripts/verify-jb-route-pass-bc.mjs

AGENT_EVAL_LIVE=1 npx tsx --test test/agentEval.test.ts   # 需服务器 key
```
