# Swagger UI for all RESTful APIs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve a single, real, interactive OpenAPI 3.0 document (`GET /openapi.json`) covering every route in `pcr-ai-api` — including routes not yet in the manifest (agent chat/feedback, admin config, inf-analysis, siliconflow) — and render it with `swagger-ui-dist` at `GET /api-docs`.

**Architecture:** Extend the existing static manifest (`pcr-ai-api/src/lib/manifest/`) with the missing routes, then add a pure converter function (`openapiConverter.ts`) that turns `apiManifest` into an OpenAPI document with real absolute paths (expanding apiRouter-mounted routes across `/api/v1`, `/api/v3`, `/api/v4`; leaving agent/admin/`/health` at their single real mount). A thin route serves the JSON; a static HTML page (bundled `swagger-ui-dist` assets, no CDN) renders it with "try it out" enabled for every operation.

**Tech Stack:** Node.js + Express + TypeScript (ESM, `module: Node16`), `node:test` + `node:assert/strict`, `swagger-ui-dist` (new dependency).

## Global Constraints

- Package: everything in this plan lives in `pcr-ai-api/` only. No `pcr-ai-report` changes.
- TypeScript: `strict: true`, `module`/`moduleResolution: Node16` — every relative import needs an explicit `.js` extension, even though source files are `.ts`.
- Node engine floor: `>=18.12.1` (from `pcr-ai-api/package.json`).
- Do not add `undici` as a dependency (hard rule, `pcr-ai-api/.cursor/rules/no-undici.mdc`) — not touched by this plan, but do not introduce it while adding `swagger-ui-dist`.
- Do not touch `oracledb` version (pinned `5.5.0`) — not touched by this plan.
- This work is additive documentation/metadata only — it does not change any existing route's WHERE clause, filter parsing, sort order, limit, aggregation dimension, or response shape, so the dummy-parity rule does not apply.
- Test runner: `npm test` = `tsx --test test/*.test.ts`. New test files must live directly in `pcr-ai-api/test/` and match `*.test.ts`.
- Existing convention (seen in `test/agentManifest.test.ts`, `test/agentRoute.test.ts`): set `process.env["YIELD_MONITOR_TRIGGERS_DUMMY"] = "true"` and `process.env["INFCONTROL_LAYER_BINS_DUMMY"] = "true"` **before** importing anything that transitively imports `src/lib/manifest/index.ts`, so dummy example-query builders don't attempt an Oracle connection.

---

### Task 1: Manifest — agent + admin endpoints

**Files:**
- Create: `pcr-ai-api/src/lib/manifest/agentManifestEndpoints.ts`
- Create: `pcr-ai-api/src/lib/manifest/adminManifestEndpoints.ts`
- Modify: `pcr-ai-api/src/lib/manifest/index.ts`
- Test: `pcr-ai-api/test/manifestAgentAdminEndpoints.test.ts`

**Interfaces:**
- Produces: `agentManifestEndpoints: unknown[]` (array of manifest-entry object literals, same loose shape as existing `infcontrolManifestEndpoints`/`yieldMonitorManifestEndpoints`: `{ path, method, purpose, queryParameters?, requestBody?, responseShape?, example?, deprecated? }`).
- Produces: `adminManifestEndpoints: unknown[]` (same shape).
- `manifest/index.ts` exports `apiManifest.endpoints` including these two new arrays (consumed by Task 3's `openapiConverter.ts` and by the existing `rebaseApiManifest.ts`, unchanged).

- [ ] **Step 1: Write the failing test**

Create `pcr-ai-api/test/manifestAgentAdminEndpoints.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

process.env["YIELD_MONITOR_TRIGGERS_DUMMY"] = "true";
process.env["INFCONTROL_LAYER_BINS_DUMMY"] = "true";

import { apiManifest } from "../src/lib/manifest/index.js";

function findEntry(path: string, method: string) {
  return apiManifest.endpoints.find(
    (e: any) => e.path === path && e.method === method
  );
}

test("manifest includes POST /api/v4/agent/chat with a requestBody", () => {
  const e = findEntry("/api/v4/agent/chat", "POST");
  assert.ok(e, "expected /api/v4/agent/chat POST entry");
  assert.equal(typeof (e as any).purpose, "string");
  assert.ok((e as any).requestBody, "expected requestBody description");
});

test("manifest includes POST /api/v4/agent/feedback with a requestBody", () => {
  const e = findEntry("/api/v4/agent/feedback", "POST");
  assert.ok(e, "expected /api/v4/agent/feedback POST entry");
  assert.ok((e as any).requestBody);
});

test("manifest includes GET and PATCH /api/v4/admin/config", () => {
  const get = findEntry("/api/v4/admin/config", "GET");
  const patch = findEntry("/api/v4/admin/config", "PATCH");
  assert.ok(get, "expected /api/v4/admin/config GET entry");
  assert.ok(patch, "expected /api/v4/admin/config PATCH entry");
  assert.ok((patch as any).requestBody);
});

test("manifest includes deprecated POST /api/v4/admin/agent-enabled", () => {
  const e = findEntry("/api/v4/admin/agent-enabled", "POST");
  assert.ok(e, "expected /api/v4/admin/agent-enabled POST entry");
  assert.equal((e as any).deprecated, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pcr-ai-api && npx tsx --test test/manifestAgentAdminEndpoints.test.ts`
Expected: FAIL — `assert.ok(e, ...)` throws because none of these entries exist yet in `apiManifest.endpoints`.

- [ ] **Step 3: Create `agentManifestEndpoints.ts`**

Create `pcr-ai-api/src/lib/manifest/agentManifestEndpoints.ts`:

```ts
export const agentManifestEndpoints = [
  {
    path: "/api/v4/agent/chat",
    method: "POST",
    purpose:
      "AI Agent ReAct chat loop over the Yield Monitor and JB STAR domains (see src/lib/agent/core/agentLoop.ts). Response is Server-Sent Events (Content-Type: text/event-stream): a sequence of `data: {...}\\n\\n` frames, each a JSON object with a `type` field (status | text | tool_call | tool_result | error | done). Swagger UI 'Try it out' shows the buffered raw SSE body, not a live incremental stream — for real-time viewing use the pcr-ai-report chat UI or `curl -N`.",
    requestBody: {
      message: "string; required unless retry=true",
      sessionId:
        "string, required — client-generated id used to resume/continue a session",
      retry:
        "optional boolean; true resumes the last session without appending a new user message (sessionId must already exist)",
      agentConfig:
        "optional partial AgentConfig override: { apiKey?, apiBase?, model?, subAgentModel?, maxRounds?, streamTimeoutSec?, toolResultMaxChars?, ... } — see resolveAgentConfig() in src/lib/agent/agentConfig.ts",
    },
    responseShape: {
      contentType: "text/event-stream",
      frames:
        "newline-delimited `data: <json>\\n\\n`; each JSON object has a `type` field: status (progress message), text (assistant token chunk), tool_call, tool_result, error, done",
    },
  },
  {
    path: "/api/v4/agent/feedback",
    method: "POST",
    purpose: "Persist a thumbs-up/down feedback record for one agent answer.",
    requestBody: {
      sessionId: "string, required, max 64 chars",
      question: "string, required, max 500 chars",
      answer: "string, required, max 1500 chars",
      kind: "'good' | 'bad', required",
      category:
        "string, required when kind='bad'; one of 回答不准确 | 数据有误 | 回答不完整 | 其他",
      comment: "optional string, max 1000 chars",
    },
    responseShape: {
      ok: "boolean true on success",
    },
  },
];
```

- [ ] **Step 4: Create `adminManifestEndpoints.ts`**

Create `pcr-ai-api/src/lib/manifest/adminManifestEndpoints.ts`:

```ts
export const adminManifestEndpoints = [
  {
    path: "/api/v4/admin/config",
    method: "GET",
    purpose:
      "Return the full server-shared runtime config (RuntimeConfig, see src/lib/runtimeConfig.ts). No authentication — every field, including agentApiKey, is returned in plaintext. Deploy behind a trusted network boundary.",
    responseShape: {
      agentEnabled: "boolean",
      agentApiBase: "string",
      agentModel: "string",
      agentSubModel: "string",
      agentApiKey: "string — plaintext, no masking",
      jbDeterministicDispatch: "boolean",
      jbLlmIntentClassifier: "boolean",
      dataMaskingEnabled: "boolean",
      maxRounds: "number",
      streamTimeoutSec: "number",
      clientTimeoutSec: "number",
      toolResultMaxChars: "number",
      toolResultMaxHistoryChars: "number",
      listDefaultLimit: "number",
      listMaxLimit: "number",
    },
  },
  {
    path: "/api/v4/admin/config",
    method: "PATCH",
    purpose:
      "Merge-patch the server-shared runtime config; every field is optional, only supplied keys are overwritten and persisted to runtime-config.json. Takes effect for all clients immediately, no restart. No authentication.",
    requestBody: {
      note: "Partial<RuntimeConfig> — any subset of the fields listed in the GET .../config responseShape",
    },
    responseShape: {
      note: "Full RuntimeConfig after the patch is applied (same shape as GET .../config)",
    },
  },
  {
    path: "/api/v4/admin/agent-enabled",
    method: "POST",
    purpose:
      "Deprecated backward-compat shortcut for PATCH /api/v4/admin/config { agentEnabled }. Prefer PATCH /api/v4/admin/config.",
    deprecated: true,
    requestBody: {
      agentEnabled: "boolean, required",
    },
    responseShape: {
      ok: "boolean",
      agentEnabled: "boolean — the value after the update",
    },
  },
];
```

- [ ] **Step 5: Wire both arrays into `manifest/index.ts`**

Modify `pcr-ai-api/src/lib/manifest/index.ts` — replace the whole file:

```ts
import { getInfcontrolDummyExampleQuery } from "../infcontrol/infcontrolLayerBinDummy.js";
import { getYieldMonitorDummyExampleQuery } from "../yieldMonitor/yieldMonitorTriggerDummy.js";
import { infcontrolManifestEndpoints } from "./infcontrolManifestEndpoints.js";
import { yieldMonitorManifestEndpoints } from "./yieldMonitorManifestEndpoints.js";
import { agentManifestEndpoints } from "./agentManifestEndpoints.js";
import { adminManifestEndpoints } from "./adminManifestEndpoints.js";
import {
  miscManifestEndpoints,
  deprecatedManifestEndpoints,
} from "./miscManifestEndpoints.js";

/**
 * 供 AI agent / OpenAPI 生成器使用的机器可读 API 说明（只读 GET）。
 */
export const apiManifest = {
  apiVersion: "1",
  title: "pcr-ai-api",
  description:
    "Read-only Oracle-backed HTTP API for PCR workflows. All query keys are case-insensitive. The same Express router is mounted at /api/v1 (full catalog in GET /api/v1/manifest), /api/v3 (GET /api/v3/manifest returns v3-only paths), and /api/v4 (GET /api/v4/manifest returns v4-only paths). v4 duplicates v3 list surfaces for layer bins and yield triggers; v4 aggregates load the full matching row set (same WHERE as the v4 list without FETCH FIRST) and compute groups in Node—no separate v3-style aggregate SQL. v3 routes use fixed SQL; when dummy env flags are set and the process is not dist/production (see listDummyRuntime.ts), v3/v4 list and aggregates use in-memory Excel samples like v1/v2; otherwise they hit Oracle. deprecatedEndpoints lists routes removed from the router (yield-monitor-triggers/aggregate only). agent/admin endpoints are only mounted under /api/v4 (not /api/v1 or /api/v3) — see GET /openapi.json for the full real-path catalog including those.",
  mediaType: "application/json",
  endpoints: [
    ...miscManifestEndpoints,
    ...infcontrolManifestEndpoints,
    ...yieldMonitorManifestEndpoints,
    ...agentManifestEndpoints,
    ...adminManifestEndpoints,
  ],
  deprecatedEndpoints: [...deprecatedManifestEndpoints],
  errorShape: {
    error: "human-readable message",
    code: "machine-stable code (e.g. VALIDATION_ERROR, ORACLE_QUERY_FAILED)",
    detail: "optional extra context",
  },
  tracing: {
    requestHeader: "X-Request-Id",
    responseHeader: "X-Request-Id",
    note: "Echo client id or server-generated UUID for log correlation.",
  },
} as const;
```

(This adds two imports and two array spreads, and appends one sentence to `description`. `infAnalysisManifestEndpoints` is added in Task 2 — do not add that import yet.)

- [ ] **Step 6: Run test to verify it passes**

Run: `cd pcr-ai-api && npx tsx --test test/manifestAgentAdminEndpoints.test.ts`
Expected: PASS (all 4 tests).

- [ ] **Step 7: Typecheck**

Run: `cd pcr-ai-api && npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add pcr-ai-api/src/lib/manifest/agentManifestEndpoints.ts pcr-ai-api/src/lib/manifest/adminManifestEndpoints.ts pcr-ai-api/src/lib/manifest/index.ts pcr-ai-api/test/manifestAgentAdminEndpoints.test.ts
git commit -m "feat(manifest): register agent chat/feedback and admin config endpoints"
```

---

### Task 2: Manifest — inf-analysis + siliconflow endpoints

**Files:**
- Create: `pcr-ai-api/src/lib/manifest/infAnalysisManifestEndpoints.ts`
- Modify: `pcr-ai-api/src/lib/manifest/miscManifestEndpoints.ts`
- Modify: `pcr-ai-api/src/lib/manifest/index.ts`
- Test: `pcr-ai-api/test/manifestInfAnalysisEndpoints.test.ts`

**Interfaces:**
- Consumes: same manifest-entry shape established in Task 1.
- Produces: `infAnalysisManifestEndpoints: unknown[]`, and one more entry appended to `miscManifestEndpoints`. Both feed into `apiManifest.endpoints` (consumed by Task 3).

- [ ] **Step 1: Write the failing test**

Create `pcr-ai-api/test/manifestInfAnalysisEndpoints.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

process.env["YIELD_MONITOR_TRIGGERS_DUMMY"] = "true";
process.env["INFCONTROL_LAYER_BINS_DUMMY"] = "true";

import { apiManifest } from "../src/lib/manifest/index.js";

function findEntry(path: string, method: string) {
  return apiManifest.endpoints.find(
    (e: any) => e.path === path && e.method === method
  );
}

test("manifest includes GET /api/v1/inf-analysis/lot-underperforming-duts", () => {
  const e = findEntry("/api/v1/inf-analysis/lot-underperforming-duts", "GET");
  assert.ok(e);
  const params = (e as any).queryParameters as Array<{ name: string; optional?: boolean }>;
  const lotParam = params.find((p) => p.name === "lot");
  assert.ok(lotParam, "expected a lot query parameter");
  assert.equal(lotParam!.optional, false, "lot must be marked required (optional: false)");
});

test("manifest includes GET /api/v1/inf-analysis/site-bin-bylot", () => {
  const e = findEntry("/api/v1/inf-analysis/site-bin-bylot", "GET");
  assert.ok(e);
});

test("manifest includes POST /api/v1/inf-analysis/site-bin-bylot/layers with a requestBody", () => {
  const e = findEntry("/api/v1/inf-analysis/site-bin-bylot/layers", "POST");
  assert.ok(e);
  assert.ok((e as any).requestBody);
});

test("manifest includes GET /api/v1/siliconflow/chat", () => {
  const e = findEntry("/api/v1/siliconflow/chat", "GET");
  assert.ok(e);
  const params = (e as any).queryParameters as Array<{ name: string; optional?: boolean }>;
  const messageParam = params.find((p) => p.name === "message");
  assert.ok(messageParam);
  assert.equal(messageParam!.optional, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pcr-ai-api && npx tsx --test test/manifestInfAnalysisEndpoints.test.ts`
Expected: FAIL — none of these entries exist yet.

- [ ] **Step 3: Create `infAnalysisManifestEndpoints.ts`**

Create `pcr-ai-api/src/lib/manifest/infAnalysisManifestEndpoints.ts`:

```ts
export const infAnalysisManifestEndpoints = [
  {
    path: "/api/v1/inf-analysis/lot-underperforming-duts",
    method: "GET",
    purpose:
      "Filter probe DUTs within a lot whose yield is below lotOverall * thresholdRatio (default 0.75). Backed by JB STAR (INFCONTROL/INFLAYERBINLIST); read-only, does not modify INF files. See docs/HANDOFF_LOT_UNDERPERFORMING_DUTS_API.md.",
    queryParameters: [
      { name: "lot", type: "string", optional: false, note: "required" },
      {
        name: "device",
        type: "string",
        optional: true,
        note: "if omitted, resolved from JB STAR by lot",
      },
      { name: "probeCardType", type: "string", optional: true },
      {
        name: "passId",
        type: "number",
        optional: true,
        note: "comma-separated allowed; default [1,3,5]",
      },
      { name: "thresholdRatio", type: "number", optional: true, note: "default 0.75" },
      { name: "testEndFrom", type: "datetime", optional: true },
      { name: "testEndTo", type: "datetime", optional: true },
    ],
    responseShape: {
      meta: "object with apiVersion, requestId",
      note:
        "per-DUT yield vs lotOverall*thresholdRatio and an underperforming flag; see docs/HANDOFF_LOT_UNDERPERFORMING_DUTS_API.md for the full field list",
    },
  },
  {
    path: "/api/v1/inf-analysis/site-bin-bylot",
    method: "GET",
    purpose:
      "Per wafer test pass, which probe-card DUT produced each bin. Three modes: single wafer (infPath+passId), lot directory scan (device+lot+passId, optional probeCardType), device aggregate across the most recent lots (device+passId, no lot; default topN=10, max 50).",
    queryParameters: [
      {
        name: "infPath",
        type: "string",
        optional: true,
        note: "single-wafer mode; mutually exclusive with device",
      },
      { name: "device", type: "string", optional: true, note: "aggregate mode trigger" },
      { name: "lot", type: "string", optional: true },
      { name: "probeCardType", type: "string", optional: true },
      { name: "passId", type: "number", optional: true, note: "comma-separated allowed" },
      { name: "keynumber", type: "number", optional: true, note: "single-wafer mode only" },
      { name: "passNum", type: "number", optional: true, note: "single-wafer mode only" },
      { name: "testEnd", type: "datetime", optional: true, note: "single-wafer mode only" },
      {
        name: "topN",
        type: "number",
        optional: true,
        note: "device mode only; default 10, max 50",
      },
    ],
    responseShape: {
      meta: "object with apiVersion, requestId, summary",
      note:
        "shape varies by mode; see docs/SITE_BIN_BY_LOT_API.md and docs/HANDOFF_SITE_BIN_BY_LOT_AGG.md",
    },
  },
  {
    path: "/api/v1/inf-analysis/site-bin-bylot/layers",
    method: "POST",
    purpose:
      "Batch variant of GET .../site-bin-bylot: fetch and merge multiple single-wafer layers in one request.",
    requestBody: {
      layers:
        "array of { infPath: string, device: string, passIds: number[], testEnd?: string, keynumber?: number, passNum?: number }, required, at least one entry",
    },
    responseShape: {
      meta: "object with apiVersion, requestId, summary",
      layerCount: "number",
      mapSources: "array of string",
      layers:
        "array of per-layer results: { infPath, passIds, mapSource, passes, keynumber?, passNum?, testEnd? }",
    },
  },
];
```

- [ ] **Step 4: Add the siliconflow entry to `miscManifestEndpoints.ts`**

Modify `pcr-ai-api/src/lib/manifest/miscManifestEndpoints.ts` — insert a new entry between the `/api/v1/table-rows` entry and the `/health` entry:

```ts
export const miscManifestEndpoints = [
  {
    path: "/api/v1/manifest",
    method: "GET",
    purpose:
      "Return this catalog for tool discovery (endpoints, deprecatedEndpoints, error/tracing shapes).",
  },
  {
    path: "/api/v1/db/ping",
    method: "GET",
    purpose: "Health check against Oracle via SELECT 1 FROM DUAL (main pool).",
  },
  {
    path: "/api/v1/table-rows",
    method: "GET",
    purpose: "Development helper: first N rows from a table (ROWNUM).",
    queryParameters: [
      { name: "table", type: "string", optional: true },
      { name: "limit", type: "number", optional: true, note: "default 50, max 500" },
    ],
  },
  {
    path: "/api/v1/siliconflow/chat",
    method: "GET",
    purpose:
      "Direct SiliconFlow Chat Completions proxy (legacy, hardcoded API key in src/lib/siliconflowChat.ts). Prefer POST /api/v4/agent/chat for the full ReAct agent.",
    queryParameters: [
      {
        name: "message",
        type: "string",
        optional: false,
        note: "UTF-8 query string; max 100000 chars",
      },
    ],
    responseShape: {
      message: "string — echo of the request message",
      reply: "string — model reply",
      model: "string — model id used",
      reasoningContent:
        "optional string — present only if the model returned reasoning content",
    },
  },
  {
    path: "/health",
    method: "GET",
    purpose: "Process liveness (no database).",
  },
];

export const deprecatedManifestEndpoints = [
  {
    path: "/api/v1/yield-monitor-triggers/aggregate",
    method: "GET",
    status: "removed",
    note: "Disabled in src/routes/api.ts; libraries yieldMonitorTriggerAggregate.ts, dummy aggregate kept for future redesign.",
  },
];
```

- [ ] **Step 5: Wire `infAnalysisManifestEndpoints` into `manifest/index.ts`**

Modify `pcr-ai-api/src/lib/manifest/index.ts`:

```diff
 import { infcontrolManifestEndpoints } from "./infcontrolManifestEndpoints.js";
 import { yieldMonitorManifestEndpoints } from "./yieldMonitorManifestEndpoints.js";
 import { agentManifestEndpoints } from "./agentManifestEndpoints.js";
 import { adminManifestEndpoints } from "./adminManifestEndpoints.js";
+import { infAnalysisManifestEndpoints } from "./infAnalysisManifestEndpoints.js";
 import {
   miscManifestEndpoints,
   deprecatedManifestEndpoints,
 } from "./miscManifestEndpoints.js";
```

```diff
   endpoints: [
     ...miscManifestEndpoints,
     ...infcontrolManifestEndpoints,
     ...yieldMonitorManifestEndpoints,
+    ...infAnalysisManifestEndpoints,
     ...agentManifestEndpoints,
     ...adminManifestEndpoints,
   ],
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd pcr-ai-api && npx tsx --test test/manifestInfAnalysisEndpoints.test.ts test/manifestAgentAdminEndpoints.test.ts`
Expected: PASS (all tests in both files).

- [ ] **Step 7: Typecheck**

Run: `cd pcr-ai-api && npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add pcr-ai-api/src/lib/manifest/infAnalysisManifestEndpoints.ts pcr-ai-api/src/lib/manifest/miscManifestEndpoints.ts pcr-ai-api/src/lib/manifest/index.ts pcr-ai-api/test/manifestInfAnalysisEndpoints.test.ts
git commit -m "feat(manifest): register inf-analysis and siliconflow/chat endpoints"
```

---

### Task 3: OpenAPI converter

**Files:**
- Create: `pcr-ai-api/src/lib/manifest/openapiConverter.ts`
- Test: `pcr-ai-api/test/openapiConverter.test.ts`

**Interfaces:**
- Consumes: `apiManifest` from `./index.js` (all endpoints registered by Tasks 1–2 plus the pre-existing infcontrol/yield-monitor/misc entries); `rebaseApiPath(path: string, mountPrefix: string): string` from `../rebaseApiManifest.js` (existing, unchanged).
- Produces: `buildOpenApiDocument(): Record<string, unknown>` — an OpenAPI 3.0.3 document with `openapi`, `info`, `paths`, `components.schemas.Error`. Consumed by Task 4's route.

- [ ] **Step 1: Write the failing test**

Create `pcr-ai-api/test/openapiConverter.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

process.env["YIELD_MONITOR_TRIGGERS_DUMMY"] = "true";
process.env["INFCONTROL_LAYER_BINS_DUMMY"] = "true";

import { buildOpenApiDocument } from "../src/lib/manifest/openapiConverter.js";

test("buildOpenApiDocument returns a well-formed OpenAPI 3.0 document", () => {
  const doc = buildOpenApiDocument() as any;
  assert.ok(doc.openapi.startsWith("3."), `expected openapi 3.x, got ${doc.openapi}`);
  assert.ok(Object.keys(doc.paths).length > 0, "expected non-empty paths");
  assert.ok(doc.components.schemas.Error, "expected components.schemas.Error");
});

test("apiRouter-sourced paths appear under v1, v3, and v4", () => {
  const doc = buildOpenApiDocument() as any;
  assert.ok(doc.paths["/api/v1/infcontrol-layer-bins"], "missing v1 path");
  assert.ok(doc.paths["/api/v3/infcontrol-layer-bins"], "missing v3 path");
  assert.ok(doc.paths["/api/v4/infcontrol-layer-bins"], "missing v4 path");
  assert.ok(doc.paths["/api/v1/infcontrol-layer-bins"].get, "expected GET operation");
});

test("agent and admin paths appear exactly once, at their real v4 prefix", () => {
  const doc = buildOpenApiDocument() as any;
  assert.ok(doc.paths["/api/v4/agent/chat"], "missing /api/v4/agent/chat");
  assert.ok(doc.paths["/api/v4/agent/chat"].post, "expected POST operation");
  assert.equal(doc.paths["/api/v1/agent/chat"], undefined, "must not exist under v1");
  assert.equal(doc.paths["/api/v3/agent/chat"], undefined, "must not exist under v3");

  assert.ok(doc.paths["/api/v4/admin/config"], "missing /api/v4/admin/config");
  assert.ok(doc.paths["/api/v4/admin/config"].get, "expected GET operation");
  assert.ok(doc.paths["/api/v4/admin/config"].patch, "expected PATCH operation");
});

test("/health appears exactly once, unprefixed", () => {
  const doc = buildOpenApiDocument() as any;
  assert.ok(doc.paths["/health"], "missing /health");
  assert.ok(doc.paths["/health"].get);
});

test("deprecated endpoints are marked deprecated:true on every expanded mount", () => {
  const doc = buildOpenApiDocument() as any;
  for (const prefix of ["/api/v1", "/api/v3", "/api/v4"]) {
    const op = doc.paths[`${prefix}/yield-monitor-triggers/aggregate`]?.get;
    assert.ok(op, `expected ${prefix}/yield-monitor-triggers/aggregate to exist`);
    assert.equal(op.deprecated, true);
  }
  assert.equal(doc.paths["/api/v4/admin/agent-enabled"].post.deprecated, true);
});

test("POST /api/v4/agent/chat and PATCH /api/v4/admin/config declare a requestBody", () => {
  const doc = buildOpenApiDocument() as any;
  assert.ok(doc.paths["/api/v4/agent/chat"].post.requestBody);
  assert.ok(doc.paths["/api/v4/admin/config"].patch.requestBody);
  assert.ok(
    doc.paths["/api/v4/agent/chat"].post.requestBody.content["application/json"].schema
  );
});

test("query parameters convert type + required correctly", () => {
  const doc = buildOpenApiDocument() as any;
  const op = doc.paths["/api/v1/inf-analysis/lot-underperforming-duts"].get;
  const lotParam = op.parameters.find((p: any) => p.name === "lot");
  assert.ok(lotParam);
  assert.equal(lotParam.required, true);
  assert.equal(lotParam.schema.type, "string");

  const deviceParam = op.parameters.find((p: any) => p.name === "device");
  assert.equal(deviceParam.required, false);

  const passIdParam = op.parameters.find((p: any) => p.name === "passId");
  assert.equal(passIdParam.schema.type, "number");
});

test("responseShape converts to an object schema with description text preserved", () => {
  const doc = buildOpenApiDocument() as any;
  const schema =
    doc.paths["/api/v1/infcontrol-layer-bins"].get.responses["200"].content[
      "application/json"
    ].schema;
  assert.equal(schema.type, "object");
  assert.ok(schema.properties.rows);
  assert.equal(schema.properties.rows.type, "array");
  assert.match(schema.properties.rows.description, /Oracle columns uppercased/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pcr-ai-api && npx tsx --test test/openapiConverter.test.ts`
Expected: FAIL with a module-not-found error for `../src/lib/manifest/openapiConverter.js`.

- [ ] **Step 3: Write the implementation**

Create `pcr-ai-api/src/lib/manifest/openapiConverter.ts`:

```ts
import { apiManifest } from "./index.js";
import { rebaseApiPath } from "../rebaseApiManifest.js";

interface ManifestQueryParam {
  name: string;
  type: string;
  optional?: boolean;
  note?: string;
}

interface OperationSource {
  purpose: string;
  queryParameters?: ManifestQueryParam[];
  requestBody?: unknown;
  responseShape?: unknown;
  example?: string;
  deprecated?: boolean;
}

interface ManifestEndpointDef extends OperationSource {
  path: string;
  method: string;
}

interface DeprecatedManifestEndpointDef {
  path: string;
  method: string;
  status: string;
  note: string;
}

function typeToSchema(type: string): Record<string, unknown> {
  switch (type) {
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "datetime":
      return { type: "string", format: "date-time" };
    default:
      return { type: "string" };
  }
}

function shapeToSchema(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    if (/array/i.test(value)) {
      return { type: "array", items: {}, description: value };
    }
    return { type: "string", description: value };
  }
  if (Array.isArray(value)) {
    return {
      type: "array",
      items: value.length > 0 ? shapeToSchema(value[0]) : {},
    };
  }
  if (value !== null && typeof value === "object") {
    const properties: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      properties[key] = shapeToSchema(v);
    }
    return { type: "object", properties };
  }
  return {};
}

function convertQueryParam(p: ManifestQueryParam): Record<string, unknown> {
  return {
    name: p.name,
    in: "query",
    required: p.optional !== true,
    ...(p.note ? { description: p.note } : {}),
    schema: typeToSchema(p.type),
  };
}

function buildOperation(
  e: OperationSource,
  deprecated: boolean,
  deprecatedNote: string | undefined
): Record<string, unknown> {
  const responses: Record<string, unknown> = {
    "200": {
      description: "Success",
      ...(e.responseShape !== undefined
        ? {
            content: {
              "application/json": { schema: shapeToSchema(e.responseShape) },
            },
          }
        : {}),
    },
    default: {
      description: "Error",
      content: {
        "application/json": { schema: { $ref: "#/components/schemas/Error" } },
      },
    },
  };

  const descriptionParts: string[] = [];
  if (deprecatedNote) descriptionParts.push(deprecatedNote);
  if (e.example) descriptionParts.push(`Example: ${e.example}`);

  const operation: Record<string, unknown> = {
    summary: e.purpose,
    responses,
  };
  if (descriptionParts.length > 0) {
    operation.description = descriptionParts.join("\n\n");
  }
  if (e.queryParameters && e.queryParameters.length > 0) {
    operation.parameters = e.queryParameters.map(convertQueryParam);
  }
  if (e.requestBody !== undefined) {
    operation.requestBody = {
      required: true,
      content: { "application/json": { schema: shapeToSchema(e.requestBody) } },
    };
  }
  if (deprecated) operation.deprecated = true;
  return operation;
}

function expandPaths(canonicalPath: string): string[] {
  if (canonicalPath.startsWith("/api/v1/")) {
    return ["/api/v1", "/api/v3", "/api/v4"].map((prefix) =>
      rebaseApiPath(canonicalPath, prefix)
    );
  }
  return [canonicalPath];
}

export function buildOpenApiDocument(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};

  function addOperation(path: string, method: string, operation: Record<string, unknown>) {
    const existing = paths[path] ?? {};
    existing[method.toLowerCase()] = operation;
    paths[path] = existing;
  }

  const endpoints = apiManifest.endpoints as unknown as ManifestEndpointDef[];
  for (const e of endpoints) {
    const operation = buildOperation(e, e.deprecated === true, undefined);
    for (const path of expandPaths(e.path)) {
      addOperation(path, e.method, operation);
    }
  }

  const deprecatedEndpoints =
    apiManifest.deprecatedEndpoints as unknown as DeprecatedManifestEndpointDef[];
  for (const d of deprecatedEndpoints) {
    const operation = buildOperation({ purpose: `[${d.status}] ${d.note}` }, true, d.note);
    for (const path of expandPaths(d.path)) {
      addOperation(path, d.method, operation);
    }
  }

  return {
    openapi: "3.0.3",
    info: {
      title: apiManifest.title,
      version: apiManifest.apiVersion,
      description: apiManifest.description,
    },
    paths,
    components: {
      schemas: {
        Error: {
          type: "object",
          properties: {
            error: { type: "string", description: apiManifest.errorShape.error },
            code: { type: "string", description: apiManifest.errorShape.code },
            detail: { type: "string", description: apiManifest.errorShape.detail },
          },
        },
      },
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pcr-ai-api && npx tsx --test test/openapiConverter.test.ts`
Expected: PASS (all 7 tests).

- [ ] **Step 5: Typecheck**

Run: `cd pcr-ai-api && npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add pcr-ai-api/src/lib/manifest/openapiConverter.ts pcr-ai-api/test/openapiConverter.test.ts
git commit -m "feat(manifest): add manifest-to-OpenAPI-3.0 converter"
```

---

### Task 4: `GET /openapi.json` route

**Files:**
- Create: `pcr-ai-api/src/routes/openapiRoutes.ts`
- Modify: `pcr-ai-api/src/app.ts`
- Test: `pcr-ai-api/test/openapiRoute.test.ts`

**Interfaces:**
- Consumes: `buildOpenApiDocument()` from `../lib/manifest/openapiConverter.js` (Task 3).
- Produces: `openapiRouter` (Express `Router`), mounted at the app root in `app.ts`. Consumed by Task 5's static docs page (which fetches `/openapi.json` from the browser).

- [ ] **Step 1: Write the failing test**

Create `pcr-ai-api/test/openapiRoute.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

process.env["YIELD_MONITOR_TRIGGERS_DUMMY"] = "true";
process.env["INFCONTROL_LAYER_BINS_DUMMY"] = "true";

import { createApp } from "../src/app.js";

test("GET /openapi.json returns a valid OpenAPI document", async (t) => {
  const app = createApp();
  const server = app.listen(0);
  t.after(() => server.close());
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  const res = await fetch(`http://127.0.0.1:${(address as any).port}/openapi.json`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);

  const body = await res.json();
  assert.ok(body.openapi.startsWith("3."));
  assert.ok(body.paths["/api/v4/agent/chat"]);
  assert.ok(body.paths["/api/v1/infcontrol-layer-bins"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pcr-ai-api && npx tsx --test test/openapiRoute.test.ts`
Expected: FAIL — `GET /openapi.json` 404s (route doesn't exist yet).

- [ ] **Step 3: Create the route**

Create `pcr-ai-api/src/routes/openapiRoutes.ts`:

```ts
import { Router } from "express";
import { buildOpenApiDocument } from "../lib/manifest/openapiConverter.js";

export const openapiRouter = Router();

/** Full real-path OpenAPI 3.0 document for every route in the app; consumed by GET /api-docs (swagger-ui-dist). */
openapiRouter.get("/openapi.json", (_req, res) => {
  res.json(buildOpenApiDocument());
});
```

- [ ] **Step 4: Mount it in `app.ts`**

Modify `pcr-ai-api/src/app.ts`:

```diff
 import { adminRouter } from "./routes/admin.js";
 import { agentRouter } from "./routes/agent.js";
 import { apiRouter } from "./routes/api.js";
 import { healthRouter } from "./routes/health.js";
+import { openapiRouter } from "./routes/openapiRoutes.js";
```

```diff
   app.use(healthRouter);
+  app.use(openapiRouter);
   app.use("/api/v1", apiRouter);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd pcr-ai-api && npx tsx --test test/openapiRoute.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full test suite + typecheck**

Run: `cd pcr-ai-api && npm run typecheck && npm test`
Expected: all tests pass (no regression in the other ~65 test files).

- [ ] **Step 7: Commit**

```bash
git add pcr-ai-api/src/routes/openapiRoutes.ts pcr-ai-api/src/app.ts pcr-ai-api/test/openapiRoute.test.ts
git commit -m "feat(api): serve GET /openapi.json"
```

---

### Task 5: Swagger UI static docs page (`GET /api-docs`)

**Files:**
- Modify: `pcr-ai-api/package.json` (new dependency `swagger-ui-dist`)
- Create: `pcr-ai-api/public/api-docs/index.html`
- Modify: `pcr-ai-api/src/app.ts`
- Test: `pcr-ai-api/test/apiDocsPage.test.ts`

**Interfaces:**
- Consumes: `GET /openapi.json` (Task 4), served same-origin so the browser page can fetch it with a relative URL.
- Produces: `GET /api-docs/` (serves `public/api-docs/index.html` via the existing `express.static(publicDir)` mount) and `GET /api-docs/vendor/*` (serves the `swagger-ui-dist` package's bundled assets).

- [ ] **Step 1: Install the dependency**

Run: `cd pcr-ai-api && npm install swagger-ui-dist --save`
Expected: `pcr-ai-api/package.json` gains `"swagger-ui-dist": "^<resolved-version>"` under `dependencies`, and `pcr-ai-api/package-lock.json` updates.

- [ ] **Step 2: Verify the installed package layout**

Run (PowerShell): `Get-ChildItem pcr-ai-api/node_modules/swagger-ui-dist | Select-Object Name`
Expected: the listing includes `swagger-ui-bundle.js`, `swagger-ui-standalone-preset.js`, `swagger-ui.css`, and `index.js` directly at the package root (not nested in a subdirectory). If any of these three asset filenames differ in the installed version, update the `<script>`/`<link>` tags in Step 4 to match the actual filenames before continuing.

- [ ] **Step 3: Write the failing test**

Create `pcr-ai-api/test/apiDocsPage.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

process.env["YIELD_MONITOR_TRIGGERS_DUMMY"] = "true";
process.env["INFCONTROL_LAYER_BINS_DUMMY"] = "true";

import { createApp } from "../src/app.js";

test("GET /api-docs/ serves the swagger-ui HTML page", async (t) => {
  const app = createApp();
  const server = app.listen(0);
  t.after(() => server.close());
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as any).port;

  const res = await fetch(`http://127.0.0.1:${port}/api-docs/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /swagger-ui/);
  assert.match(html, /\/openapi\.json/);
});

test("GET /api-docs (no trailing slash) redirects to /api-docs/", async (t) => {
  const app = createApp();
  const server = app.listen(0);
  t.after(() => server.close());
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as any).port;

  const res = await fetch(`http://127.0.0.1:${port}/api-docs`, { redirect: "manual" });
  assert.ok(res.status === 301 || res.status === 302, `expected a redirect, got ${res.status}`);
  assert.equal(res.headers.get("location"), "/api-docs/");
});

test("GET /api-docs/vendor/swagger-ui-bundle.js serves the vendored bundle", async (t) => {
  const app = createApp();
  const server = app.listen(0);
  t.after(() => server.close());
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as any).port;

  const res = await fetch(`http://127.0.0.1:${port}/api-docs/vendor/swagger-ui-bundle.js`);
  assert.equal(res.status, 200);
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd pcr-ai-api && npx tsx --test test/apiDocsPage.test.ts`
Expected: FAIL — all three requests 404 (nothing serves `/api-docs/*` yet).

- [ ] **Step 5: Write the HTML page**

Create `pcr-ai-api/public/api-docs/index.html`:

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>pcr-ai-api · API Docs</title>
  <link rel="stylesheet" href="./vendor/swagger-ui.css" />
  <style>
    body { margin: 0; background: #1b1b1b; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="./vendor/swagger-ui-bundle.js"></script>
  <script src="./vendor/swagger-ui-standalone-preset.js"></script>
  <script>
    window.onload = function () {
      window.ui = SwaggerUIBundle({
        url: "/openapi.json",
        dom_id: "#swagger-ui",
        presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
        layout: "StandaloneLayout",
        tryItOutEnabled: true,
      });
    };
  </script>
</body>
</html>
```

- [ ] **Step 6: Mount the `swagger-ui-dist` static assets in `app.ts`**

Modify `pcr-ai-api/src/app.ts`. First, add the `createRequire` import:

```diff
 import express, { type ErrorRequestHandler } from "express";
 import fs from "node:fs";
+import { createRequire } from "node:module";
 import path from "node:path";
 import { fileURLToPath } from "node:url";
```

Then, right after the existing `publicDir` computation (inside `createApp()`), add the vendor mount:

```diff
   const publicDir = path.join(
     path.dirname(fileURLToPath(import.meta.url)),
     "..",
     "public"
   );
   /** 本地 v3 联调页：`public/v3-api-tester.html` → `GET /v3-api-tester.html` */
   app.use(express.static(publicDir));
+
+  /** Swagger UI 静态资源（不依赖 CDN）：`GET /api-docs/` 渲染 public/api-docs/index.html，指向 GET /openapi.json。 */
+  const swaggerUiDistDir = path.dirname(
+    createRequire(import.meta.url).resolve("swagger-ui-dist")
+  );
+  app.use("/api-docs/vendor", express.static(swaggerUiDistDir));
```

(`express.static(publicDir)` already serves `public/api-docs/index.html` at `GET /api-docs/`, and redirects `GET /api-docs` → `GET /api-docs/`, by default `serve-static` directory-index behavior — no extra route needed.)

- [ ] **Step 7: Run test to verify it passes**

Run: `cd pcr-ai-api && npx tsx --test test/apiDocsPage.test.ts`
Expected: PASS (all 3 tests).

- [ ] **Step 8: Run the full test suite + typecheck**

Run: `cd pcr-ai-api && npm run typecheck && npm test`
Expected: all tests pass.

- [ ] **Step 9: Commit**

```bash
git add pcr-ai-api/package.json pcr-ai-api/package-lock.json pcr-ai-api/public/api-docs/index.html pcr-ai-api/src/app.ts pcr-ai-api/test/apiDocsPage.test.ts
git commit -m "feat(api): serve Swagger UI at GET /api-docs (swagger-ui-dist, try-it-out enabled)"
```

---

### Task 6: End-to-end verification

**Files:** none (verification only).

- [ ] **Step 1: Full build + test + typecheck**

Run: `cd pcr-ai-api && npm run build && npm run typecheck && npm test`
Expected: build succeeds (including `verify-dist-no-undici.mjs`), typecheck clean, all tests pass.

- [ ] **Step 2: Manual dev-server smoke check**

Run (in one terminal): `cd pcr-ai-api && npm run dev`

In a second terminal:

```bash
curl -s http://127.0.0.1:30008/openapi.json | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log('paths:', Object.keys(d.paths).length); console.log('has agent/chat:', !!d.paths['/api/v4/agent/chat']); console.log('has v1/v3/v4 infcontrol-layer-bins:', !!d.paths['/api/v1/infcontrol-layer-bins'], !!d.paths['/api/v3/infcontrol-layer-bins'], !!d.paths['/api/v4/infcontrol-layer-bins']);"
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:30008/api-docs/
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:30008/api-docs/vendor/swagger-ui-bundle.js
```

Expected: `paths:` count > 30, both boolean checks `true`, both `curl -w` calls print `200`.

- [ ] **Step 3: Manual browser check**

Open `http://127.0.0.1:30008/api-docs/` in a browser. Confirm:
- The page loads the Swagger UI layout (not a blank page or a CORS/fetch error banner).
- `GET /api/v1/infcontrol-layer-bins` is listed and expandable, showing its query parameters and response schema.
- `POST /api/v4/agent/chat` is listed with a "Try it out" button and a request body editor.
- `POST /api/v4/admin/agent-enabled` is visually marked deprecated (strikethrough).

Stop the dev server (`Ctrl+C`) once confirmed.

- [ ] **Step 4: Report completion**

No commit — this task is verification-only. Summarize in the session what was checked and any deviations found (e.g. if `swagger-ui-dist` asset filenames differed from Task 5 Step 2's expectation and were adjusted).
