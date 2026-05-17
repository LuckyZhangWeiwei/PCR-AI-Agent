# InfcontrolReport Combined Query Endpoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/v4/combined` endpoint to `pcr-ai-api` that fetches top-N rows and aggregates them in Node memory in a single Oracle call, then wire it up in `pcr-ai-report`'s `InfcontrolReport` to replace the current 6-request (1 list + 5 aggregate) pattern.

**Architecture:** New `parseAggsParam.ts` utility parses a `|`-delimited aggs query param; the route handler does one Oracle query, runs `aggregateInfcontrolLayerBinV3FromRows` on raw rows (before enrichment strips BIN0…BIN255), then enriches rows for display. Frontend sends one request and distributes results to the 5 existing aggregate state vars.

**Tech Stack:** Node 18 + Express 4 + TypeScript 5, `oracledb 5.5` (pinned — do NOT upgrade), `node:test` + `node:assert/strict` for tests, React 19 + TypeScript 5 for frontend.

---

## File Map

### Backend (`pcr-ai-api/`)

| File | Change | Responsibility |
|---|---|---|
| `src/lib/parseAggsParam.ts` | **Create** | Parse `aggs` query param (`\|`-delimited `groupBy:groupTop` specs) |
| `test/parseAggsParam.test.ts` | **Create** | Unit tests for `parseAggsParam` |
| `src/routes/infcontrolRoutes.ts` | **Modify** | New `GET /infcontrol-layer-bins/v4/combined` route |

### Frontend (`pcr-ai-report/`)

| File | Change | Responsibility |
|---|---|---|
| `src/api/paths.ts` | **Modify** | Add `INFCONTROL_COMBINED_PATH` constant |
| `src/api/types.ts` | **Modify** | Add `InfcontrolAggregateBlock` and `InfcontrolCombinedResponse` interfaces |
| `src/reports/InfcontrolReport.tsx` | **Modify** | Replace two-phase `handleQuery` with single combined call |

---

## Task 1: `parseAggsParam.ts` library (TDD)

**Files:**
- Create: `pcr-ai-api/src/lib/parseAggsParam.ts`
- Create: `pcr-ai-api/test/parseAggsParam.test.ts`

- [ ] **Step 1: Write the failing test**

Create `pcr-ai-api/test/parseAggsParam.test.ts`:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAggsParam } from "../src/lib/parseAggsParam.js";

describe("parseAggsParam", () => {
  it("non-string returns ok with empty specs", () => {
    assert.deepEqual(parseAggsParam(undefined), { ok: true, specs: [] });
    assert.deepEqual(parseAggsParam(null), { ok: true, specs: [] });
    assert.deepEqual(parseAggsParam(42), { ok: true, specs: [] });
  });

  it("empty string returns ok with empty specs", () => {
    assert.deepEqual(parseAggsParam(""), { ok: true, specs: [] });
    assert.deepEqual(parseAggsParam("  "), { ok: true, specs: [] });
  });

  it("parses single spec with groupTop", () => {
    const r = parseAggsParam("bin:30");
    assert.ok(r.ok);
    assert.deepEqual(r.specs, [{ groupBy: "bin", groupTop: 30 }]);
  });

  it("defaults groupTop to 30 when colon absent", () => {
    const r = parseAggsParam("bin");
    assert.ok(r.ok);
    assert.deepEqual(r.specs, [{ groupBy: "bin", groupTop: 30 }]);
  });

  it("parses multiple pipe-separated specs", () => {
    const r = parseAggsParam("bin:30|probeCardType,bin:25|slot,bin:50");
    assert.ok(r.ok);
    assert.deepEqual(r.specs, [
      { groupBy: "bin", groupTop: 30 },
      { groupBy: "probeCardType,bin", groupTop: 25 },
      { groupBy: "slot,bin", groupTop: 50 },
    ]);
  });

  it("returns error when spec count exceeds maxSpecs", () => {
    const input = Array.from({ length: 11 }, (_, i) => `dim${i}:10`).join("|");
    const r = parseAggsParam(input);
    assert.ok(!r.ok);
    assert.ok(r.error.includes("at most 10"));
  });

  it("returns error for zero groupTop", () => {
    const r = parseAggsParam("bin:0");
    assert.ok(!r.ok);
    assert.ok(r.error.includes("positive integer"));
  });

  it("returns error for non-integer groupTop", () => {
    const r = parseAggsParam("bin:1.5");
    assert.ok(!r.ok);
    assert.ok(r.error.includes("positive integer"));
  });

  it("returns error for non-numeric groupTop", () => {
    const r = parseAggsParam("bin:abc");
    assert.ok(!r.ok);
    assert.ok(r.error.includes("positive integer"));
  });

  it("uses maxSpecs parameter", () => {
    const r = parseAggsParam("bin:10|slot:10|device:10", 2);
    assert.ok(!r.ok);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd pcr-ai-api
npm test 2>&1 | grep -E "parseAggsParam|FAIL|Cannot find"
```

Expected: Module not found / compilation error because `parseAggsParam.ts` does not exist yet.

- [ ] **Step 3: Implement `parseAggsParam.ts`**

Create `pcr-ai-api/src/lib/parseAggsParam.ts`:

```typescript
export type AggSpec = { groupBy: string; groupTop: number };

export function parseAggsParam(
  raw: unknown,
  maxSpecs = 10
): { ok: true; specs: AggSpec[] } | { ok: false; error: string } {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: true, specs: [] };
  }
  const items = raw.split("|").filter((s) => s.trim() !== "");
  if (items.length > maxSpecs) {
    return {
      ok: false,
      error: `aggs has at most ${maxSpecs} specs; got ${items.length}`,
    };
  }
  const specs: AggSpec[] = [];
  for (const item of items) {
    const trimmed = item.trim();
    const lastColon = trimmed.lastIndexOf(":");
    let groupBy: string;
    let groupTop: number;
    if (lastColon === -1) {
      groupBy = trimmed;
      groupTop = 30;
    } else {
      const suffix = trimmed.slice(lastColon + 1).trim();
      if (suffix === "") {
        groupBy = trimmed.slice(0, lastColon).trim();
        groupTop = 30;
      } else {
        const n = Number(suffix);
        if (!Number.isInteger(n) || n <= 0) {
          return {
            ok: false,
            error: `groupTop must be a positive integer; got "${suffix}" in "${trimmed}"`,
          };
        }
        groupBy = trimmed.slice(0, lastColon).trim();
        groupTop = n;
      }
    }
    if (groupBy === "") {
      return { ok: false, error: `groupBy is empty in aggs spec "${trimmed}"` };
    }
    specs.push({ groupBy, groupTop });
  }
  return { ok: true, specs };
}
```

- [ ] **Step 4: Run tests and verify they pass**

```bash
cd pcr-ai-api
npm test
```

Expected: All tests pass including the new `parseAggsParam` suite.

- [ ] **Step 5: Typecheck**

```bash
cd pcr-ai-api
npm run typecheck
```

Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add pcr-ai-api/src/lib/parseAggsParam.ts pcr-ai-api/test/parseAggsParam.test.ts
git commit -m "feat(api): add parseAggsParam utility for combined aggs query param"
```

---

## Task 2: `/v4/combined` route in `infcontrolRoutes.ts`

**Files:**
- Modify: `pcr-ai-api/src/routes/infcontrolRoutes.ts`

**Critical ordering constraint:** Aggregation with `aggregateInfcontrolLayerBinV3FromRows` MUST happen on normalized rows BEFORE `enrichInfcontrolLayerBinV3ListRow` is called, because enrichment strips the BIN0…BIN255 columns that the aggregator reads.

- [ ] **Step 1: Add new imports to `infcontrolRoutes.ts`**

Locate the existing import block from `infcontrolLayerBinAggregate.js` (currently imports `buildInfcontrolLayerBinAggregateGroupParts`, `buildInfcontrolLayerBinAggregateSql`, `buildInfcontrolLayerBinMatchingCountSql`, `parseInfcontrolLayerBinAggregateQuery`). Add `parseInfcontrolLayerBinAggregateGroupSpec` and `type InfcontrolLayerBinGroupBy` to it:

```typescript
import {
  buildInfcontrolLayerBinAggregateGroupParts,
  buildInfcontrolLayerBinAggregateSql,
  buildInfcontrolLayerBinMatchingCountSql,
  parseInfcontrolLayerBinAggregateQuery,
  parseInfcontrolLayerBinAggregateGroupSpec,
  type InfcontrolLayerBinGroupBy,
} from "../lib/infcontrolLayerBinAggregate.js";
```

Also add the new `parseAggsParam` import (place near the other `lib/` imports):

```typescript
import { parseAggsParam } from "../lib/parseAggsParam.js";
```

- [ ] **Step 2: Add the route handler after the existing `/v4/aggregate` route**

Append the following route after the `infcontrolRouter.get("/infcontrol-layer-bins/v4/aggregate", ...)` handler (around line 800+):

```typescript
/**
 * **v4 层控合并查询**：一次 Oracle 查询（top N 明细行）同时返回 **rows**（展示用）与
 * **aggregates**（各维度在 top N 行上的内存聚合）。
 * 聚合在 Node 内对原始行（含 BIN0…BIN255）完成；展示行在聚合后 enrich（BIN 列已剥离）。
 * 无 MEMORY_AGG_ORACLE_MAX_ROWS 限制（固定 top N，不拉全量行）。
 */
infcontrolRouter.get("/infcontrol-layer-bins/v4/combined", async (req, res) => {
  const parsed = parseInfcontrolLayerBinsV3Query(
    req.query as Record<string, unknown>
  );
  if (!parsed.ok) {
    return sendAgentError(
      res,
      400,
      "VALIDATION_ERROR",
      parsed.error,
      "See GET /api/v1/manifest infcontrol-layer-bins/v4."
    );
  }

  const aggsResult = parseAggsParam(req.query.aggs);
  if (!aggsResult.ok) {
    return sendAgentError(
      res,
      400,
      "VALIDATION_ERROR",
      aggsResult.error,
      "aggs format: groupBy:groupTop|groupBy:groupTop|… (e.g. bin:30|probeCardType,bin:25)"
    );
  }

  const limit = clampLimitFromQuery(
    req.query as Record<string, unknown>,
    200,
    API_V3_LIST_LIMIT_MAX
  );

  // Validate and resolve each agg spec's groupBy string → InfcontrolLayerBinGroupBy[]
  const resolvedSpecs: {
    key: string;
    groupBy: InfcontrolLayerBinGroupBy[];
    groupTop: number;
  }[] = [];
  for (const spec of aggsResult.specs) {
    const gs = parseInfcontrolLayerBinAggregateGroupSpec({
      groupBy: spec.groupBy,
      groupTop: String(spec.groupTop),
    });
    if (!gs.ok) {
      return sendAgentError(
        res,
        400,
        "VALIDATION_ERROR",
        `aggs groupBy "${spec.groupBy}": ${gs.error}`,
        "Each groupBy must include exactly one 'bin' dimension (e.g. probeCardType,bin)."
      );
    }
    resolvedSpecs.push({ key: spec.groupBy, groupBy: gs.groupBy, groupTop: spec.groupTop });
  }

  if (infcontrolLayerBinsUseDummy()) {
    const dummyRows = filterInfcontrolLayerBinV3DummyRows(parsed.applied, limit);
    const aggregates: Record<string, unknown> = {};
    for (const rs of resolvedSpecs) {
      const { totalRowsMatching, groups } = aggregateInfcontrolLayerBinV3FromRows(
        dummyRows,
        rs.groupBy,
        rs.groupTop
      );
      aggregates[rs.key] = { groupBy: rs.key, groupTop: rs.groupTop, totalRowsMatching, groups };
    }
    const enrichedRows = dummyRows.map((row) =>
      enrichInfcontrolLayerBinV3ListRow(row as Record<string, unknown>)
    );
    return res.json({
      meta: {
        apiVersion: "4",
        requestId: reqId(req),
        combinedPath: "infcontrol-layer-bins/v4/combined",
      },
      limit,
      limitMax: API_V3_LIST_LIMIT_MAX,
      orderBy: "TESTEND DESC NULLS LAST, SLOT, PASSID, PASSNUM",
      filters: { ...parsed.applied, limit },
      count: enrichedRows.length,
      rows: enrichedRows,
      aggregates,
    });
  }

  const sql = buildInfcontrolLayerBinsV3Sql(parsed.whereAndSql);
  const binds: BindParameters = { ...parsed.binds, lim: limit };

  try {
    const rawRows = await withConnection(async (conn) => {
      const result = await conn.execute(sql, binds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });
      return result.rows || [];
    });

    // Normalize column names to uppercase before aggregation (required by aggregateInfcontrolLayerBinV3FromRows)
    const normalizedRows = (rawRows as Record<string, unknown>[]).map(
      (r) => normalizeDbRowKeysUpper(r) as InfcontrolLayerBinDummyRow
    );

    // Aggregate BEFORE enrichment — enrichInfcontrolLayerBinV3ListRow strips BIN0…BIN255 columns
    const aggregates: Record<string, unknown> = {};
    for (const rs of resolvedSpecs) {
      const { totalRowsMatching, groups } = aggregateInfcontrolLayerBinV3FromRows(
        normalizedRows,
        rs.groupBy,
        rs.groupTop
      );
      aggregates[rs.key] = { groupBy: rs.key, groupTop: rs.groupTop, totalRowsMatching, groups };
    }

    // Enrich rows for display (adds PROBECARDTYPE, passBinPair, etc.)
    const enrichedRows = normalizedRows.map((r) =>
      enrichInfcontrolLayerBinV3ListRow(r as Record<string, unknown>)
    );

    return res.json({
      meta: {
        apiVersion: "4",
        requestId: reqId(req),
        combinedPath: "infcontrol-layer-bins/v4/combined",
      },
      limit,
      limitMax: API_V3_LIST_LIMIT_MAX,
      orderBy: "TESTEND DESC NULLS LAST, SLOT, PASSID, PASSNUM",
      filters: { ...parsed.applied, limit },
      count: enrichedRows.length,
      rows: enrichedRows,
      aggregates,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return sendAgentError(
      res,
      500,
      "ORACLE_QUERY_FAILED",
      "Oracle query failed",
      enrichOracleDriverDetail(message)
    );
  }
});
```

- [ ] **Step 3: Typecheck**

```bash
cd pcr-ai-api
npm run typecheck
```

Expected: No errors. If you see `InfcontrolLayerBinDummyRow not found`, add `import type { InfcontrolLayerBinDummyRow } from "../lib/infcontrolLayerBinDummy.js";` — check if it's already imported (it is at line 38 of infcontrolRoutes.ts).

- [ ] **Step 4: Run all tests**

```bash
cd pcr-ai-api
npm test
```

Expected: All existing tests pass. The new endpoint has no automated integration test (Dummy path verified manually).

- [ ] **Step 5: Build**

```bash
cd pcr-ai-api
npm run build
```

Expected: Build succeeds, `verify-dist-no-undici` passes.

- [ ] **Step 6: Commit**

```bash
git add pcr-ai-api/src/routes/infcontrolRoutes.ts
git commit -m "feat(api): add /v4/combined endpoint for InfcontrolReport single-query load"
```

---

## Task 3: Frontend — `paths.ts` and `types.ts`

**Files:**
- Modify: `pcr-ai-report/src/api/paths.ts`
- Modify: `pcr-ai-report/src/api/types.ts`

- [ ] **Step 1: Add `INFCONTROL_COMBINED_PATH` to `paths.ts`**

Current file has:
```typescript
export const API_PREFIX = "/api/v4";
export const INFCONTROL_AGGREGATE_PATH = "/api/v3/infcontrol-layer-bins/v3/aggregate";
export const YIELD_AGGREGATE_PATH = "/api/v3/yield-monitor-triggers/v3/aggregate";
```

Add after `INFCONTROL_AGGREGATE_PATH`:

```typescript
export const INFCONTROL_COMBINED_PATH =
  "/api/v4/infcontrol-layer-bins/v4/combined";
```

- [ ] **Step 2: Add two new types to `types.ts`**

After the `InfcontrolAggregateResponse` type definition (around line 88), add:

```typescript
/** Single aggregate block from **`GET …/v4/combined`** response `aggregates` map. */
export interface InfcontrolAggregateBlock {
  groupBy: string;
  groupTop: number;
  totalRowsMatching: number;
  groups: AggregateGroup[];
}

/** **`GET …/v4/combined`** response — list rows + all aggregates in one call. */
export interface InfcontrolCombinedResponse extends InfcontrolLayerBinsV3Response {
  aggregates: Record<string, InfcontrolAggregateBlock>;
}
```

- [ ] **Step 3: Build to verify types**

```bash
cd pcr-ai-report
npm run build
```

Expected: Build succeeds (no usages of the new types yet, so no TS errors).

- [ ] **Step 4: Commit**

```bash
git add pcr-ai-report/src/api/paths.ts pcr-ai-report/src/api/types.ts
git commit -m "feat(report): add InfcontrolCombinedResponse types and INFCONTROL_COMBINED_PATH"
```

---

## Task 4: Frontend — `InfcontrolReport.tsx` replace `handleQuery`

**Files:**
- Modify: `pcr-ai-report/src/reports/InfcontrolReport.tsx`

- [ ] **Step 1: Update imports**

**Current import from `"../api/paths"`:**
```typescript
import { API_PREFIX, INFCONTROL_AGGREGATE_PATH } from "../api/paths";
```
Change to:
```typescript
import { API_PREFIX, INFCONTROL_AGGREGATE_PATH, INFCONTROL_COMBINED_PATH } from "../api/paths";
```

**Current import from `"../api/types"`:**
```typescript
import type {
  AggregateGroup,
  InfcontrolAggregateResponse,
  InfcontrolLayerBinsV3Response,
  InfcontrolLayerBinV3Row,
} from "../api/types";
```
Change to:
```typescript
import type {
  AggregateGroup,
  InfcontrolAggregateBlock,
  InfcontrolAggregateResponse,
  InfcontrolCombinedResponse,
  InfcontrolLayerBinsV3Response,
  InfcontrolLayerBinV3Row,
} from "../api/types";
```

**Remove the `asyncConcurrency` import** (only used in the Phase 2 block we are replacing):
```typescript
// Remove this entire block:
import {
  allSettledWithConcurrency,
  REPORT_AGGREGATE_FANOUT_CONCURRENCY,
} from "../utils/asyncConcurrency";
```

- [ ] **Step 2: Change state types for the 5 initial-load aggregate vars**

Locate these five `useState` calls (around lines 282–287):
```typescript
const [aggBin,      setAggBin]      = useState<InfcontrolAggregateResponse | null>(null);
const [aggCardType, setAggCardType] = useState<InfcontrolAggregateResponse | null>(null);
const [aggSlot,     setAggSlot]     = useState<InfcontrolAggregateResponse | null>(null);
const [aggTree,     setAggTree]     = useState<InfcontrolAggregateResponse | null>(null);
const [aggDevice,   setAggDevice]   = useState<InfcontrolAggregateResponse | null>(null);
```

Change all five to use `InfcontrolAggregateBlock`:
```typescript
const [aggBin,      setAggBin]      = useState<InfcontrolAggregateBlock | null>(null);
const [aggCardType, setAggCardType] = useState<InfcontrolAggregateBlock | null>(null);
const [aggSlot,     setAggSlot]     = useState<InfcontrolAggregateBlock | null>(null);
const [aggTree,     setAggTree]     = useState<InfcontrolAggregateBlock | null>(null);
const [aggDevice,   setAggDevice]   = useState<InfcontrolAggregateBlock | null>(null);
```

(`aggFree` remains `InfcontrolAggregateResponse | null` — it still uses the v3 aggregate path.)

- [ ] **Step 3: Replace the `query` useCallback body**

Find the `query` useCallback (starts around line 412 with `const query = useCallback(async () => {`). Replace its entire body — from the initial state resets down to `void fetchFreeAgg(freeDim, form);` — with:

```typescript
  const query = useCallback(async () => {
    setLoadingList(true);
    setLoadingAgg(true);
    setErrorList(null);
    setErrorAgg(null);
    setDrills({});
    setSelectedLotLabel(null);
    setSelectedBin(null);
    setSelectedCardType(null);
    setSelectedSlot(null);
    setList(null);
    setAggBin(null);
    setAggCardType(null);
    setAggSlot(null);
    setAggTree(null);
    setAggDevice(null);
    setSelectedDevice(null);
    setAggFree(null);

    try {
      const res = await apiGetJson<InfcontrolCombinedResponse>(
        apiBase,
        INFCONTROL_COMBINED_PATH,
        {
          ...buildListParams(form, listLimits),
          aggs: [
            `${jbAggregateGroupBy("bin")}:30`,
            `${jbAggregateGroupBy("probeCardType")}:25`,
            `${jbAggregateGroupBy("slot")}:50`,
            `${jbAggregateGroupBy("device", "lot", "probeCardType", "cardId")}:100`,
            `${jbAggregateGroupBy("device")}:30`,
          ].join("|"),
        }
      );
      setList(res);
      setAggBin(res.aggregates[jbAggregateGroupBy("bin")] ?? null);
      setAggCardType(res.aggregates[jbAggregateGroupBy("probeCardType")] ?? null);
      setAggSlot(res.aggregates[jbAggregateGroupBy("slot")] ?? null);
      setAggTree(
        res.aggregates[jbAggregateGroupBy("device", "lot", "probeCardType", "cardId")] ?? null
      );
      setAggDevice(res.aggregates[jbAggregateGroupBy("device")] ?? null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErrorList(msg);
      setErrorAgg(msg);
    } finally {
      setLoadingList(false);
      setLoadingAgg(false);
    }

    void fetchFreeAgg(freeDim, form);
  }, [apiBase, form, freeDim, fetchFreeAgg, listLimits]);
```

> **Key:** `jbAggregateGroupBy("bin")` returns `"bin"`, `jbAggregateGroupBy("probeCardType")` returns `"probeCardType,bin"`, etc. These match the `aggs` keys exactly, so `res.aggregates[key]` retrieves the right block.

- [ ] **Step 4: Build and typecheck**

```bash
cd pcr-ai-report
npm run build
```

Expected: Build succeeds with no TypeScript errors. If you see errors about `InfcontrolAggregateBlock` vs `InfcontrolAggregateResponse` in downstream usage, check that only `totalRowsMatching` and `groups` are accessed on `aggBin`/`aggCardType`/`aggSlot`/`aggTree`/`aggDevice` — both fields exist on `InfcontrolAggregateBlock`.

- [ ] **Step 5: Manual verification (dev server)**

```bash
cd pcr-ai-report
npm run dev
```

Open the dashboard → JB tab → fill in a device filter → click 「查询」. In the browser DevTools Network panel, verify:
- Only **one** request to `/api/v4/infcontrol-layer-bins/v4/combined` (not 6 requests)
- The response `aggregates` object contains keys: `bin`, `probeCardType,bin`, `slot,bin`, `device,lot,probeCardType,cardId,bin`, `device,bin`
- Charts render correctly (BIN rank chart, card-type chart, slot chart, device tree, device chart)
- Drill-down still works (click a bar → fires `INFCONTROL_AGGREGATE_PATH` v3 request)
- Free-dim aggregation still works

- [ ] **Step 6: Commit**

```bash
git add pcr-ai-report/src/reports/InfcontrolReport.tsx
git commit -m "feat(report): replace 6 serial Oracle requests with single /v4/combined call"
```

---

## Task 5: Final verification

- [ ] **Step 1: Full backend test + build**

```bash
cd pcr-ai-api
npm test && npm run build
```

Expected: All tests pass, build succeeds.

- [ ] **Step 2: Full frontend build**

```bash
cd pcr-ai-report
npm run build
```

Expected: Build succeeds, no TypeScript errors.

- [ ] **Step 3: Confirm Network tab has 1 combined request on initial load**

Run dev server and confirm the Network panel shows exactly 1 combined request (not 6) when clicking 「查询」 the first time. Drill-down and free-dim requests still go to `INFCONTROL_AGGREGATE_PATH`.

---

## Self-Review Checklist

**Spec coverage:**
- ✅ New `parseAggsParam.ts` with `AggSpec` type and all parsing rules (§4.1)
- ✅ Oracle path: single query → normalize → aggregate → enrich → respond (§4.2)
- ✅ Dummy path: symmetric with Oracle path (§4.2 constraint #2)
- ✅ `/v4` and `/v3/aggregate` routes unchanged (constraint #1)
- ✅ `aggs` missing/empty → `aggregates: {}` (parse returns `specs: []`, loop is no-op)
- ✅ 400 for invalid aggs, 500 for Oracle failure, no 422 (§3.3)
- ✅ Frontend: `INFCONTROL_COMBINED_PATH`, `InfcontrolAggregateBlock`, `InfcontrolCombinedResponse` (§5.1–5.2)
- ✅ `handleQuery` replaced; drill-down (`fetchDrill`) and free-dim (`fetchFreeAgg`) unchanged (§5.3)

**Critical constraint:** Aggregation MUST happen BEFORE `enrichInfcontrolLayerBinV3ListRow` — both Oracle and Dummy paths enforce this. The comment in the route handler makes this explicit.
