# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository structure

This is a two-package monorepo (no shared workspace tooling — each package has its own `node_modules` and must be managed independently):

| Package | Tech | Role |
| --- | --- | --- |
| [`pcr-ai-api/`](pcr-ai-api/) | Node.js + Express + TypeScript + **oracledb 5.5**（锁定；见 `pcr-ai-api/CLAUDE.md` §8） | Read-only REST API backed by Oracle |
| [`pcr-ai-report/`](pcr-ai-report/) | React 19 + TypeScript + Vite + ECharts | Browser dashboard that queries the API |

> **Deep API context:** `pcr-ai-api/CLAUDE.md` contains the full handoff guide for the backend — Dummy/Oracle discipline, v3 constraints, SQL entry points, and the checklist. Read it before touching `pcr-ai-api/`.

---

## Commands

### pcr-ai-api (backend)

```bash
cd pcr-ai-api
npm ci                  # install deps
npm run dev             # tsx watch (hot-reload)
npm run build           # tsc → dist/
npm start               # node dist/server.js (production)
npm run typecheck       # tsc --noEmit
npm test                # run test/rest-api-v3-dummy.test.ts
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

---

## Architecture overview

### API (`pcr-ai-api/src/`)

- **`server.ts`** — bootstraps Express, starts the Oracle pool, logs Dummy state on startup.
- **`app.ts`** — creates the Express app, mounts middleware and routers.
- **`routes/api.ts`** — all `/api/v1` and `/api/v3` endpoints (yield monitor, infcontrol layer bins, manifest, db ping, table-rows).
- **`oracle.ts`** — two named pools: default (`withConnection`) for the main Oracle schema and `probeweb` (`withProbeWebConnection`) for yield-monitor routes. **Driver:** `oracledb@5.5.0` pinned for compatibility with older Oracle 11g clients on hosts that cannot upgrade Instant Client (see `pcr-ai-api/CLAUDE.md` §8 before bumping to v6).
- **`lib/`** — domain logic grouped by feature:
  - `yieldMonitorTrigger*` — v1/v3 list, v3 aggregate, Dummy, SQL, filter parsing, DUT label extraction.
  - `infcontrolLayerBin*` — same structure for JB START / layer-bins domain.
  - `apiV3ListSql.ts` — shared SQL template builder used by the v3 list endpoints.
  - `apiManifest.ts` + `rebaseApiManifest.ts` — static manifest descriptor and path rewriting.
  - `listDummyRuntime.ts` — forces Oracle (disables Dummy) when running from `dist/` or `NODE_ENV=production`.

### Dummy data mode (dev/test only)

Set `YIELD_MONITOR_TRIGGERS_DUMMY=true` or `INFCONTROL_LAYER_BINS_DUMMY=true` in `.env` to replace Oracle queries with in-memory Excel samples (`docs/JBStart.xlsx`, `docs/delta-diff.xlsx`). **Dummy is always off in production/dist builds.** Any change to WHERE clauses, filters, sort order, or response shape must be applied to both the Oracle path and the corresponding `*Dummy.ts` file.

### Frontend (`pcr-ai-report/src/`)

- **`App.tsx`** — shell with a configurable API base URL input (persisted to `localStorage` via `usePersistedApiBase`), connection health probe, and four tab panels.
- **`api/client.ts`** — `apiGetJson<T>()` wraps `fetch`, normalizes the base URL, serializes query params, and throws on non-2xx with a structured error message.
- **`api/paths.ts`** — single constant `API_PREFIX = "/api/v3"` shared by all report components.
- **`reports/`** — one component per tab: `OverviewReport` (manifest/API directory), `YieldMonitorReport`, `InfcontrolReport`, `TableRowsReport`. Each manages its own form state, query execution, and ECharts options inline.
- **`components/`** — `DarkChart` (ECharts wrapper with resize listener), `DataTable` (generic row/column renderer), `QueryInspector`.
- **`theme/chartTheme.ts`** — dark-palette constants shared across all chart options.

### Communication flow

```
Browser (pcr-ai-report)
  └─ apiGetJson → GET /api/v3/...
       └─ pcr-ai-api (Express)
            ├─ Oracle pool (main / probeweb)
            └─ or Dummy (in-memory Excel, dev only)
```

All API calls are read-only GETs. The frontend never writes to the backend.
