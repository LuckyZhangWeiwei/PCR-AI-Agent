# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository structure

This is a two-package monorepo (no shared workspace tooling — each package has its own `node_modules` and must be managed independently):

| Package | Tech | Role |
| --- | --- | --- |
| [`pcr-ai-api/`](pcr-ai-api/) | Node.js + Express + TypeScript + **oracledb 5.5**（锁定；见 `pcr-ai-api/CLAUDE.md` §8） | Read-only REST API backed by Oracle |
| [`pcr-ai-report/`](pcr-ai-report/) | React 19 + TypeScript + Vite + ECharts + **@dnd-kit** | Browser dashboard (**NXP ATTJ WaferTest Dashboard**) that queries the API |

> **Deep API context:** [`pcr-ai-api/CLAUDE.md`](pcr-ai-api/CLAUDE.md) — Dummy/Oracle, v3/v4 aggregate, `MEMORY_AGG_ORACLE_MAX_ROWS`, SiliconFlow, CORS, Oracle driver pinning.  
> **Deep report context:** [`pcr-ai-report/CLAUDE.md`](pcr-ai-report/CLAUDE.md) — draggable layout, localStorage keys, query panel, chart labels, tab/settings shell. Read the relevant package doc before editing that package.  
> **INF site-bin-bylot（API 已实现，报表 `InfDutDistPanel` 已接入）：** [`docs/SITE_BIN_BY_LOT_INTEGRATION.md`](docs/SITE_BIN_BY_LOT_INTEGRATION.md) — 单片 `infPath`。**Lot/Device 聚合交接：** [`docs/HANDOFF_SITE_BIN_BY_LOT_AGG.md`](docs/HANDOFF_SITE_BIN_BY_LOT_AGG.md) — Device：`device`+`passId`，默认 **topN=10** 最新 lot、TESTEND 最近一年；curl 见 [`pcr-ai-api/docs/SITE_BIN_BY_LOT_API.md`](pcr-ai-api/docs/SITE_BIN_BY_LOT_API.md)。  
> **JB 中断 slot 良率（半片 + Agent 汇报顺序）：** [`docs/HANDOFF_JB_INTERRUPT_YIELD.md`](docs/HANDOFF_JB_INTERRUPT_YIELD.md) — `interruptHalf` / `completionHalf`、输出顺序 **前半→后半→整片合并**，再 lot 整体；0% 必写。  
> **JB mask 多 lot 良率/中断（勿跨 lot 合并 slot）：** [`docs/HANDOFF_JB_MULTI_LOT_MASK_YIELD.md`](docs/HANDOFF_JB_MULTI_LOT_MASK_YIELD.md) — `rowsForYieldAggregates`、`(lot,slot,passId)` 分组、`simulate-agent-p11c-mask.mjs`、空查询缓存 v5。  
> **Agent JB 逐片 BIN + 工具结果体积：** [`docs/HANDOFF_AGENT_JB_BIN_AND_TOOL_RESULT.md`](docs/HANDOFF_AGENT_JB_BIN_AND_TOOL_RESULT.md) — `slotBadBinsCompact`、`toolResultMaxChars`（Settings 默认 12000）。  
> **Agent JB 确定性总结 + 工程建议：** [`docs/HANDOFF_AGENT_JB_DETERMINISTIC_SUMMARY.md`](docs/HANDOFF_AGENT_JB_DETERMINISTIC_SUMMARY.md) — 服务端直出表、`badBinSlotTrends`/`lotYieldOverviewMarkdown`、lot 全量查询、`### 数据解读` + `### 专业建议`（Wafer Test / Probe Card / DUT）。  
> **Agent device+机台 lot 列表（YM 自动补 JB）：** [`docs/HANDOFF_AGENT_JB_LOT_LISTING.md`](docs/HANDOFF_AGENT_JB_LOT_LISTING.md) — `lot_listing` 直出表、`detectPendingQuery` YM→JB、`buildRecentLotsListingMarkdown`（fail BIN / 嫌疑 DUT）。  
> **Agent JB 突增/聚集坏 bin + 中断次数 + 机台 + 数据/结论分栏：** [`docs/HANDOFF_AGENT_JB_CLUSTER_INTERRUPT_TESTER_UX.md`](docs/HANDOFF_AGENT_JB_CLUSTER_INTERRUPT_TESTER_UX.md) — `clusteredBadBinAlerts`、`testInterruptCount`、`testerByLot`、`splitAgentReplyMarkdown`。  
> **Agent JB 中途换卡（CARDID×passId）：** [`docs/HANDOFF_AGENT_JB_PROBE_CARD_CHANGE.md`](docs/HANDOFF_AGENT_JB_PROBE_CARD_CHANGE.md) — 仅同 (slot,passId) 算换卡；`cardByPassId`（pass1/3 各一卡正常）。  
> **Agent generate_chart（GLM 空参 + DUT 占比推断）：** [`docs/HANDOFF_AGENT_GENERATE_CHART.md`](docs/HANDOFF_AGENT_GENERATE_CHART.md) — `parseGlmToolCallBody`、`inferGenerateChartArgsFromHistory`、`labels`+`values`。  
> **JB 报表 BIN/Platform/DUT 多选：** [`docs/HANDOFF_JB_REPORT_FILTERS_DUT_MULTISELECT.md`](docs/HANDOFF_JB_REPORT_FILTERS_DUT_MULTISELECT.md) — `bins=` 列表筛选、Platform 仅 Yield（含 93K）、明细/下钻多选叠加 DUT、`mergeSiteBinPasses`。  
> **INF 晶圆图 + Agent 三路由（2026-06-03）：** [`docs/HANDOFF_INF_WAFER_MAP_AND_AGENT_TABLE_UX.md`](docs/HANDOFF_INF_WAFER_MAP_AND_AGENT_TABLE_UX.md) — `agentWaferMapRoute` / `agentJbOverviewRoute` / `agentDutBinMapRoute`；`inf_draw` vs `inf_draw_dut_bin_map`；性能与超时；表/解读分栏。  
> **Cursor 修复（2026-07-06 · wafermap notch 角度）：** [`docs/HANDOFF_CURSOR_FIX_WAFERMAP_NOTCH_ANGLE_2026-07-06.md`](docs/HANDOFF_CURSOR_FIX_WAFERMAP_NOTCH_ANGLE_2026-07-06.md) — INF `dNotchAngle`→SVG 转换（180=底）；`infNotchAngleToSvg` / `readDieGeometry`。 
> **Cursor 交接（2026-07-07 · Yield Monitor 周期报警趋势）：** [`docs/HANDOFF_CURSOR_YIELD_MONITOR_PERIOD_ALARM_TREND_2026-07-07.md`](docs/HANDOFF_CURSOR_YIELD_MONITOR_PERIOD_ALARM_TREND_2026-07-07.md) — `GET …/v3/period-alarm-trend`（16→1 请求、COUNT DISTINCT、Bin 不含 goodbin）；⏭ API 待部署。  
> **Cursor 交接（2026-07-09 · Tester 报警频率 + Top5 hover）：** [`docs/HANDOFF_CURSOR_YIELD_MONITOR_ALARM_RATE_AND_TOP5_2026-07-09.md`](docs/HANDOFF_CURSOR_YIELD_MONITOR_ALARM_RATE_AND_TOP5_2026-07-09.md) — Tab、Top5、Oracle `LENGTH(hostname)`；**最终 JB 分母** [`docs/HANDOFF_CURSOR_YIELD_MONITOR_JB_DENOMINATOR_2026-07-09.md`](docs/HANDOFF_CURSOR_YIELD_MONITOR_JB_DENOMINATOR_2026-07-09.md) — 全量 JB distinct slot、v3 PASSTYPE、仅部署 API 即可；⏭ 真库复验。
> **Lot 低良率 DUT REST（2026-07-01）：** [`docs/HANDOFF_LOT_UNDERPERFORMING_DUTS_API.md`](docs/HANDOFF_LOT_UNDERPERFORMING_DUTS_API.md) — `GET /api/v4/inf-analysis/lot-underperforming-duts?lot=`；lotOverall×0.75 阈值；JB 反查 device。 
> **Agent 问题清单（2026-06-27 第二轮 · P-A 已修）：** [`docs/HANDOFF_AGENT_ISSUES_2026-06-27_ROUND2.md`](docs/HANDOFF_AGENT_ISSUES_2026-06-27_ROUND2.md) — P-A：`get_filter_values` device-by-mask 真库空（Oracle `TRIM(col)!=''` 陷阱 → `oracleStringSql.ts`）；待办 P-B/P-C/P-D/P-F。  
> **Cursor 真库验证实录（2026-06-27～28 · 给 Claude Code）：** [`docs/HANDOFF_CURSOR_VERIFICATION_RESULTS_2026-06-27.md`](docs/HANDOFF_CURSOR_VERIFICATION_RESULTS_2026-06-27.md) — 严格复验 **5/5 闭环** + P-C summary bail + verify 脚本。  
> **Cursor 真库验证（2026-07-01 · 部署后）：** [`docs/HANDOFF_CURSOR_VERIFICATION_RESULTS_2026-07-01.md`](docs/HANDOFF_CURSOR_VERIFICATION_RESULTS_2026-07-01.md) — 新 API `NF12316.1X` ✅；派发 A1-1/2 ✅；A1-4/P-D/分类器待修；双开关 FLIP 建议。  
> **Cursor mask 快路 + A1-4 fan-out（2026-07-01 · 已部署 5/5）：** [`docs/HANDOFF_CURSOR_JB_MASK_YIELD_ROUTE_2026-07-01.md`](docs/HANDOFF_CURSOR_JB_MASK_YIELD_ROUTE_2026-07-01.md) — Pass B/C + handoff 全绿；A1-4 `lots=5`；默认模型 Flash；A1-2/A2-4 待修。  
> **真库验证：DUT 低良率阈值口径 + JB Star 跨 LOT 多选（2026-07-04 · Cursor 5/5 闭环）：** [`docs/HANDOFF_CURSOR_VERIFICATION_RESULTS_2026-07-04_DUT_YIELD_MULTISELECT.md`](docs/HANDOFF_CURSOR_VERIFICATION_RESULTS_2026-07-04_DUT_YIELD_MULTISELECT.md) — A1 PASS1=TEST、良品 **BIN55**（非 BIN1）；**A2 建议改取数**（JB PASSBIN 优先）；A3 维持 passId=[1,3,5]；B API 跨 LOT **无 bug**；Agent 未调低良率工具待修。任务书：[`docs/HANDOFF_CURSOR_REALDB_DUT_YIELD_AND_MULTISELECT_2026-07-04.md`](docs/HANDOFF_CURSOR_REALDB_DUT_YIELD_AND_MULTISELECT_2026-07-04.md)。  
> **Cursor 修复（2026-07-04 · P0+P1 已合入）：** [`docs/HANDOFF_CURSOR_FIX_DUT_GOODBIN_AND_AGENT_ROUTE_2026-07-04.md`](docs/HANDOFF_CURSOR_FIX_DUT_GOODBIN_AND_AGENT_ROUTE_2026-07-04.md) — JB PASSBIN 良品 bin 取数 + Agent A 路谓词放宽。  
> **Cursor 修复（2026-07-10 · 探针卡 lot 列表 scope）：** [`docs/HANDOFF_CURSOR_JB_CARD_LISTING_SCOPE_2026-07-10.md`](docs/HANDOFF_CURSOR_JB_CARD_LISTING_SCOPE_2026-07-10.md) — `resolveJbListingScope`（cardId 优先）、`lot_listing` 良率呈现、Flash 强制、无 card 专用路由；⏭ 真库 6081-03 回归。
> **探针卡/测试机组合良率排名（2026-07-09 设计 / 2026-07-10 实现 / 2026-07-11 终审修复 + 真实模型联调修复）：** [`docs/HANDOFF_AGENT_PROBE_CARD_TESTER_PERFORMANCE.md`](docs/HANDOFF_AGENT_PROBE_CARD_TESTER_PERFORMANCE.md) — `aggregate_probe_card_tester_performance`；组合/探针卡排名+置信度档位+月度趋势+坏bin频率；仅 JB STAR，v1 无前端面板；良率下限钳制于 0。**真实 MiniMax-M2.5 联调修复两处**：①「探针卡+最好/最差」问法曾被既有 `isCardYieldCompareQuestion` 抢答成 `query_jb_bins`（`758c282`）；②总结轮改为服务端确定性直出四张表（`tryRunDeterministicProbeCardPerfSummary`，`31956f1`），不再依赖模型"听话"转述。**真库测试任务：** [`docs/HANDOFF_CURSOR_REALDB_PROBE_CARD_TESTER_PERFORMANCE_2026-07-11.md`](docs/HANDOFF_CURSOR_REALDB_PROBE_CARD_TESTER_PERFORMANCE_2026-07-11.md) — ⏭ 待 Cursor 用真库验证（本地全程 Dummy 模式开发，从未跑过真实 Oracle 路径，两处修复也只在 Dummy 上验证过）。
> **Agent 准确性修复清单（2026-07-11 会话日志复盘 · 交接 Cursor）：** [`docs/HANDOFF_CURSOR_AGENT_ACCURACY_2026-07-11.md`](docs/HANDOFF_CURSOR_AGENT_ACCURACY_2026-07-11.md) — ⏭ 8 项待修：探针卡四表无标题/无 pass 分组（P0-1）、JB vs DUT 表良率同屏矛盾 `goodBinsByPassId` 未打通（P0-2）、good bin≠BIN1 全 0 大表照出（P0-3）、「good bin 是多少」被概况表劫持（P0-4）、lot 列表误挂单 lot DUT 表（P1-5）、listing scope 误带机台致 5↔4 lot 不一致（P1-6）、解读跨温度层对比/写出 pass2（P1-7）、cardId count=0 回归 + DUT 表重复（P2-8）。  
> **Cursor 交接（2026-07-20 · Agent 列表 limit 200→500）：** [`docs/HANDOFF_CURSOR_AGENT_TOOL_LIMIT_500_2026-07-20.md`](docs/HANDOFF_CURSOR_AGENT_TOOL_LIMIT_500_2026-07-20.md) — `AGENT_TOOL_LIST_LIMIT_MAX=500`（JB+YM）；默认仍 50；lot 列表富列仍靠 ≤20 全量行，非单靠抬 limit。
> **Cursor 修复（2026-07-21 · DUT×BIN 图 RETEST 抹 BIN）：** [`docs/HANDOFF_CURSOR_FIX_DUT_BIN_MAP_RETEST_WIPE_2026-07-21.md`](docs/HANDOFF_CURSOR_FIX_DUT_BIN_MAP_RETEST_WIPE_2026-07-21.md) — `inf_draw_dut_bin_map` 数字 pass 只读 TEST；⏭ 真库 NF13390.1K 复验。
> **Cursor 修复（2026-07-23 · DUT 集中度表卡号空）：** [`docs/HANDOFF_CURSOR_FIX_DUT_CONCENTRATION_CARDID_2026-07-23.md`](docs/HANDOFF_CURSOR_FIX_DUT_CONCENTRATION_CARDID_2026-07-23.md) — `query_lot_dut_bin_agg` 传入 `cardByPassId` + Oracle SELECT `CARDID`；⏭ 真库 WA00P32P/bin90 复验。

---

## Hard rules (always apply)

These are enforced by `pcr-ai-api/.cursor/rules/` and by build-time checks — treat them as invariants, not guidelines.

**1. Oracle path and Dummy path must stay in sync (`dummy-parity`)**  
Any change to WHERE clauses, filter parsing, sort order, limit, aggregation dimensions, or response shape must be made simultaneously in both the Oracle path (`parse*Query`, `build*Sql`, `api.ts`) and the corresponding `*Dummy.ts` file. Running `npm test` exercises both paths. Drift between them is the highest-priority bug class in this codebase.

**2. Never add `undici` to `pcr-ai-api` (`no-undici`)**  
SiliconFlow outbound calls use Node built-in `fetch` (strict TLS) or `node:https` (skip cert). `npm run build` runs `scripts/verify-dist-no-undici.mjs` and fails if `undici` appears in `dist/lib/siliconflowChat.js`. If the server reports `Cannot find package 'undici'`, rebuild (`npm ci && npm run build && pm2 reload`) — never install `undici` to fix it.

**3. `oracledb` is pinned at 5.5.0 — do not upgrade to 6.x**  
v6 requires Oracle Instant Client ≥ 18.1. Production hosts run 11g clients and cannot be upgraded. See `pcr-ai-api/CLAUDE.md` §8 before touching `package.json`.

---

## Commands

### pcr-ai-api (backend)

```bash
cd pcr-ai-api
npm ci                  # install deps
npm run dev             # tsx watch (hot-reload); defaults both Dummy flags to true — set PCR_AI_LOCAL_DUMMY=false to use real Oracle
npm run build           # tsc → dist/ + copy-perlscripts + verify-dist-no-undici
npm start               # node dist/server.js (production)
npm run typecheck       # tsc --noEmit
npm test                # run all backend tests (test/*.test.ts)
npm run docs:api-v3     # rebuild docs/API_V3.md from dist (run after changing SQL/doc templates)
npm run pm2:start       # build + pm2 start ecosystem.config.cjs
npm run pm2:reload      # build + pm2 reload (zero-downtime on server)
```

Default port: **30008** (override via `PORT=` in `.env`).  
Copy `.env.example` → `.env` and fill `ORACLE_*` credentials before starting.

### pcr-ai-report (frontend)

```bash
cd pcr-ai-report
npm ci                  # install deps
npm run dev             # Vite dev server (reads .env.development)
npm run build           # tsc -b && vite build → dist/
npm run pack:dist       # build + tar dist/ → dist.tar for nginx deploy (extract at web root)
npm run lint            # eslint
npm run preview         # serve the built dist/ locally
```

The default API base is `http://10.192.130.89:30008` (set in `.env.development` and the in-app input). Override with `VITE_API_BASE_URL` in a local `.env` file (do not commit credentials).

**Local dev (`npm run dev`) and Private Network Access:** when the Vite dev server runs on `localhost` but the API lives on a private `10.x` host, the browser may block direct cross-origin calls. With **`VITE_DEV_API_VIA_PROXY=true`** (see `.env.development`), `api/client.ts` uses **same-origin** requests (`window.location.origin`) and **`vite.config.ts`** proxies **`/api`** and **`/health`** to **`VITE_DEV_PROXY_TARGET`** (default `http://10.192.130.89:30008`). In that mode, keep the in-app 「服务器地址」 **empty or same-origin**; do **not** point it at `http://10.x:30008` in the browser while relying on the proxy.

---

## Architecture overview

### API (`pcr-ai-api/src/`)

- **`loadEnv.ts`** — imported first by `server.ts`; runs `polyfillUtilIsDate.ts` (Node 23+ compat for oracledb 5.5), loads `.env` via dotenv, then sets both `*_DUMMY=true` when running under `tsx` dev (not dist/production/test). Override with `PCR_AI_LOCAL_DUMMY=false`.
- **`server.ts`** — bootstraps Express, starts the Oracle pool, logs Dummy state on startup.
- **`app.ts`** — creates the Express app, mounts middleware and routers.
- **`routes/api.ts`** — all `/api/v1`, `/api/v3`, and **`/api/v4`** endpoints (same router; v4 mirrors v3 list surfaces but aggregates in Node from the full matching row set—see `pcr-ai-api/CLAUDE.md`). Also **`GET /inf-analysis/site-bin-bylot`** (INF wafer map: per pass, which probe-card DUT produced each bin—see `pcr-ai-api/CLAUDE.md` §6 / §11.7).
- **`oracle.ts`** — two named pools: default (`withConnection`) for the main Oracle schema and `probeweb` (`withProbeWebConnection`) for yield-monitor routes. **Driver:** `oracledb@5.5.0` pinned for compatibility with older Oracle 11g clients on hosts that cannot upgrade Instant Client (see `pcr-ai-api/CLAUDE.md` §8 before bumping to v6).
- **`lib/`** — domain logic grouped by feature:
  - `yieldMonitorTrigger*` — v1/v3 list, v3 aggregate, Dummy, SQL, filter parsing, DUT label extraction.
  - `infcontrolLayerBin*` — same structure for JB STAR / layer-bins domain.
  - `apiV3ListSql.ts` — shared SQL template builder used by the v3/v4 list endpoints.
  - `apiManifest.ts` + `rebaseApiManifest.ts` — static manifest descriptor and path rewriting.
  - `listDummyRuntime.ts` — forces Oracle (disables Dummy) when running from `dist/` or `NODE_ENV=production`.
  - `agentResponse.ts` — `sendAgentError` emits the standard error envelope `{ error, code, detail? }` used by all routes; `enrichOracleDriverDetail` appends Thick/Instant Client fix hints to NJS-116 / DPI-1050 messages.
  - `v3DefaultOneYearWindow.ts` — injected by `parseInfcontrolLayerBinsV3Query` / `parseYieldMonitorTriggerV3Query` when no time params are present; adds a UTC `[now − 1 year, now]` window to both `TESTEND` and `TIME_STAMP`.

### Dummy data mode (dev/test only)

Set `YIELD_MONITOR_TRIGGERS_DUMMY=true` or `INFCONTROL_LAYER_BINS_DUMMY=true` in `.env` to replace Oracle queries with in-memory Excel samples (`docs/JBStart.xlsx`, `docs/delta-diff.xlsx`). **Dummy is always off in production/dist builds.** Any change to WHERE clauses, filters, sort order, or response shape must be applied to both the Oracle path and the corresponding `*Dummy.ts` file.

### Frontend (`pcr-ai-report/src/`)

- **`App.tsx`** — shell: title **NXP ATTJ WaferTest Dashboard**, tabs (Yield / JB / AI / 表浏览 / **⚙ 设置**), API base + health probe in settings; **`OverviewReport embedded`** for API catalog (no longer a top-level tab).
- **`api/client.ts`** — `apiGetJson<T>()` wraps `fetch`, normalizes the base URL, serializes query params, and throws on non-2xx with a structured error message.
- **`api/paths.ts`** — single constant `API_PREFIX = "/api/v4"` shared by all report components.
- **`reports/`** — `YieldMonitorReport`, `InfcontrolReport` (both use **`DraggableReportSections`** + nested **`DraggableReportBlocks`** for KPI/chart grids, **`.query-panel`**, layout reset); `AiAgentReport` (**Settings** 可配 **`maxRounds`**、**`streamTimeoutSec`** / **`clientTimeoutSec`**、**`toolResultMaxChars`**（默认 12000），timeout 错误可 **↻ 重试**；JB 逐片 BIN 见 [`docs/HANDOFF_AGENT_JB_BIN_AND_TOOL_RESULT.md`](docs/HANDOFF_AGENT_JB_BIN_AND_TOOL_RESULT.md)；**New Chat** 见 **`pcr-ai-report/CLAUDE.md` §16**；流式泄漏过滤（think / DSML）见 **§18** / **`pcr-ai-api/CLAUDE.md` §11 条目 14**；聊天气泡 **`~~` 横线**与**单滚动条**见 **`pcr-ai-report/CLAUDE.md` §19**；工具后总结见 **§11 条目 11**), `TableRowsReport`, `OverviewReport` (settings only when `embedded`).
- **`components/DraggableReportSections.tsx`** — `@dnd-kit` reorder/close/hide + **`localStorage`**; **`createPointerMidpointCollision`** for tall blocks; see the "可拖拽布局" section in `pcr-ai-report/CLAUDE.md`.
- **`components/ChartDrillSplit.tsx`** — CSS grid `1fr 1fr` wrapper: left = main chart, right = drill panel spanning full grid row; `overflow:hidden` prevents page-widening on first click.
- **`components/InfDutDistPanel.tsx`** — stacked bar of bin×DUT per pass for a JB STAR lot/slot; calls `GET /inf-analysis/site-bin-bylot`; filters to good bins by default using `infGoodBins.ts`.
- **`components/`** — also `DarkChart`, `DataTable`, `QueryInspector`, `KpiCard` (`showLabel` for KPI strips), `TreeTable`, `DrillDownPanel`, `CollapsibleQueryPanel`.
- **`utils/`** — `asyncConcurrency.ts` (`REPORT_ORACLE_FANOUT_CONCURRENCY = 1`); `datetimeLocal.ts` (`formatChartDayLabel`, `formatAggregateDimLabel`); `yieldCalc.ts`, `rollup.ts`, `binFilterLines.ts`; `drillAggregate.ts` (`drillFromTree` — slice cached aggTree by parent dim instead of re-fetching); `infGoodBins.ts` (merge good bins from BIN1 + `isGoodBin` flags + PASSBIN hyphen format); `buildInfPath.ts` (frontend mirror of API `buildInfPath`).
- **`theme/chartTheme.ts`** — dark-palette constants shared across all chart options.

### Communication flow

```
Browser (pcr-ai-report)
  └─ apiGetJson → GET /api/v4/...
       └─ pcr-ai-api (Express)
            ├─ Oracle pool (main / probeweb)
            └─ or Dummy (in-memory Excel, dev only)
```

All API calls are read-only GETs. The frontend never writes to the backend.

### AI Agent loop (`pcr-ai-api/src/lib/agent/`)

The agent is a ReAct loop in `agent/core/agentLoop.ts` (max `agentConfig.maxRounds` rounds, default 5). Understanding the summary-round invariant is essential before touching this code:

**Normal round**: history does NOT end with `role: "tool"` → request is sent with full `TOOL_SCHEMAS` and `tool_choice: "auto"`. Model may call tools or produce text.

**Summary round** (`historyAwaitingToolSummary(history) === true`, in `agent/core/agentToolStatus.ts`): last history entry is `role: "tool"` → request is sent **without** tool schema, with `SUMMARIZE_NUDGE` appended to system prompt. The model must conclude.

In the summary round the guard (`agent/core/agentLoop.ts`) enforces:
- **Data-fetch tools** (`query_*`, `aggregate_*`, `get_filter_values`, `query_inf_site_bin_by_dut`) — **blocked**. Structured `tool_calls` are discarded; embedded calls with no text trigger an error.
- **Conclusion tools** (`generate_chart`, `ask_clarification`) — **allowed**. Embedded calls are merged into `toolCalls` and executed normally.
- **Partial text + blocked embedded call** — emits `done` with the partial text (not an error), so the user sees whatever analysis the model produced before it tried to re-query.

`createDeepSeekFilter` (in `agent/core/agentEmbeddedToolParsing.ts`, exported as `filterAgentStreamTextForUi`) strips embedded tool markup (GLM `<tool_call>`, MiniMax `<minimax:tool_call>`, DSML `<｜DSML｜tool_calls>`, DeepSeek `<｜tool▁`) from the streamed text before it reaches the UI. It also parses those embedded calls so they can be executed like structured `tool_calls`.

Key files: `agent/core/agentLoop.ts` (ReAct loop) → `agent/tools/agentToolHandlers.ts` (tool dispatch) → `agent/core/agentStream.ts` (SiliconFlow SSE with idle timeout) → `agent/prompt/agentPrompt.ts` (system prompt + domain rules) → `agent/core/agentToolSchemas.ts` (tool JSON schemas). Question heuristics and semantic dispatch live in `agent/dispatch/`; aggregate-result rendering in `agent/render/`.
