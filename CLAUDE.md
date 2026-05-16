# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository structure

This is a two-package monorepo (no shared workspace tooling — each package has its own `node_modules` and must be managed independently):

| Package | Tech | Role |
| --- | --- | --- |
| [`pcr-ai-api/`](pcr-ai-api/) | Node.js + Express + TypeScript + **oracledb 5.5**（锁定；见 `pcr-ai-api/CLAUDE.md` §8） | Read-only REST API backed by Oracle |
| [`pcr-ai-report/`](pcr-ai-report/) | React 19 + TypeScript + Vite + ECharts + **@dnd-kit** | Browser dashboard (**NXP ATTJ WaferTest Dashboard**) that queries the API |

> **Deep API context:** [`pcr-ai-api/CLAUDE.md`](pcr-ai-api/CLAUDE.md) — Dummy/Oracle, v3/v4 aggregate, `MEMORY_AGG_ORACLE_MAX_ROWS`, SiliconFlow, CORS (§3、§11–§12).  
> **Deep report context:** [`pcr-ai-report/CLAUDE.md`](pcr-ai-report/CLAUDE.md) — draggable layout, localStorage keys, query panel, chart labels, tab/settings shell (§6–§11, **2026-05-15**). Read the relevant package doc before editing that package.

---

## Commands

### pcr-ai-api (backend)

```bash
cd pcr-ai-api
npm ci                  # install deps
npm run dev             # tsx watch (hot-reload)
npm run build           # tsc → dist/ + verify-dist-no-undici (no npm undici in SiliconFlow)
npm start               # node dist/server.js (production)
npm run typecheck       # tsc --noEmit
npm test                # run all backend tests (test/*.test.ts)
npm run docs:api-v3     # rebuild docs/API_V3.md from dist (run after changing SQL/doc templates)
```

Default port: **30008** (override via `PORT=` in `.env`).  
Copy `.env.example` → `.env` and fill `ORACLE_*` credentials before starting.

### pcr-ai-report (frontend)

```bash
cd pcr-ai-report
npm ci                  # install deps
npm run dev             # Vite dev server (reads .env.development)
npm run build           # tsc -b && vite build → dist/
npm run lint            # eslint
npm run preview         # serve the built dist/ locally
```

The default API base is `http://10.192.130.89:30008` (set in `.env.development` and the in-app input). Override with `VITE_API_BASE_URL` in a local `.env` file (do not commit credentials).

**Local dev (`npm run dev`) and Private Network Access:** when the Vite dev server runs on `localhost` but the API lives on a private `10.x` host, the browser may block direct cross-origin calls. With **`VITE_DEV_API_VIA_PROXY=true`** (see `.env.development`), `api/client.ts` uses **same-origin** requests (`window.location.origin`) and **`vite.config.ts`** proxies **`/api`** and **`/health`** to **`VITE_DEV_PROXY_TARGET`** (default `http://10.192.130.89:30008`). In that mode, keep the in-app 「服务器地址」 **empty or same-origin**; do **not** point it at `http://10.x:30008` in the browser while relying on the proxy.

---

## Architecture overview

### API (`pcr-ai-api/src/`)

- **`server.ts`** — bootstraps Express, starts the Oracle pool, logs Dummy state on startup.
- **`app.ts`** — creates the Express app, mounts middleware and routers.
- **`routes/api.ts`** — all `/api/v1`, `/api/v3`, and **`/api/v4`** endpoints (same router; v4 mirrors v3 list surfaces but aggregates in Node from the full matching row set—see `pcr-ai-api/CLAUDE.md`).
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
- **`reports/`** — `YieldMonitorReport`, `InfcontrolReport` (both use **`DraggableReportSections`** + nested **`DraggableReportBlocks`** for KPI/chart grids, **`.query-panel`**, layout reset); `AiAgentReport`, `TableRowsReport`, `OverviewReport` (settings only when `embedded`).
- **`components/DraggableReportSections.tsx`** — `@dnd-kit` reorder/close/hide + **`localStorage`**; **`createPointerMidpointCollision`** for tall blocks; see **`pcr-ai-report/CLAUDE.md` §6**.
- **`components/`** — also `DarkChart`, `DataTable`, `QueryInspector`, `KpiCard` (`showLabel` for KPI strips), `TreeTable`, `DrillDownPanel`.
- **`utils/`** — `asyncConcurrency.ts` (`REPORT_ORACLE_FANOUT_CONCURRENCY = 1`); `datetimeLocal.ts` (`formatChartDayLabel`, `formatAggregateDimLabel`); `yieldCalc.ts`, `rollup.ts`, `binFilterLines.ts`.
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
