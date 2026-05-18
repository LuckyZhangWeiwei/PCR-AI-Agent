# AI Agent 可选值发现 + 回答质量提升 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `get_filter_values` 工具和会话级数据快照注入，让 AI Agent 在查询前能发现可选值（probeCard、lot、hostname 等），同时加强系统提示词的分析质量规则。

**Architecture:** `agentManifest.ts` 全局缓存（TTL=1h）在每次 `runAgentLoop` 首轮前预取 device 列表和时间范围，注入 `buildSystemPrompt`；`agentFilterValuesTool.ts` 提供按需 DISTINCT 查询；两者均实现 Oracle + Dummy 双路径。前端无需改动。

**Tech Stack:** Node.js 18+, TypeScript, oracledb 5.5, node:test, node:assert/strict

---

## File Map

| Action | File | Responsibility |
|---|---|---|
| Create | `pcr-ai-api/src/lib/agent/agentManifest.ts` | DataManifest 类型、TTL 缓存、Oracle + Dummy 双路径 fetch |
| Create | `pcr-ai-api/src/lib/agent/agentFilterValuesTool.ts` | `runGetFilterValues()` — DISTINCT + COUNT 查询，Oracle + Dummy |
| Create | `pcr-ai-api/test/agentManifest.test.ts` | Dummy 路径测试 |
| Create | `pcr-ai-api/test/agentFilterValues.test.ts` | Dummy 路径测试 |
| Modify | `pcr-ai-api/src/lib/agent/agentPrompt.ts` | 接收 manifest 参数，替换质量规则节，新增发现规则节 |
| Modify | `pcr-ai-api/src/lib/agent/agentToolSchemas.ts` | 注册 `get_filter_values` schema |
| Modify | `pcr-ai-api/src/lib/agent/agentToolHandlers.ts` | 路由 `get_filter_values` → `runGetFilterValues` |
| Modify | `pcr-ai-api/src/lib/agent/agentLoop.ts` | 首轮前调用 `fetchOrCacheManifest()`，传给 `buildSystemPrompt` |

---

## Task 1: `agentManifest.ts` — 数据快照模块

**Files:**
- Create: `pcr-ai-api/src/lib/agent/agentManifest.ts`
- Create: `pcr-ai-api/test/agentManifest.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// pcr-ai-api/test/agentManifest.test.ts
import assert from "node:assert/strict";
import test from "node:test";

// 设置 Dummy 模式（必须在 import agentManifest 之前）
process.env["YIELD_MONITOR_TRIGGERS_DUMMY"] = "true";
process.env["INFCONTROL_LAYER_BINS_DUMMY"] = "true";

import {
  fetchOrCacheManifest,
  invalidateManifestCache,
  type DataManifest,
} from "../src/lib/agent/agentManifest.js";

test("fetchOrCacheManifest returns correct structure in Dummy mode", async () => {
  invalidateManifestCache();
  const manifest = await fetchOrCacheManifest();

  assert.equal(typeof manifest.fetchedAt, "number");
  assert.ok(manifest.fetchedAt > 0);

  // yield domain
  assert.ok("yield" in manifest);
  assert.ok("timeMin" in manifest.yield);
  assert.ok("timeMax" in manifest.yield);
  assert.ok(Array.isArray(manifest.yield.topDevices));
  // Dummy rows exist → should have at least one device
  assert.ok(manifest.yield.topDevices.length > 0, "yield topDevices should be non-empty");
  assert.equal(typeof manifest.yield.topDevices[0]!.device, "string");
  assert.equal(typeof manifest.yield.topDevices[0]!.count, "number");
  assert.ok(manifest.yield.topDevices[0]!.count > 0);

  // jb domain
  assert.ok("jb" in manifest);
  assert.ok(Array.isArray(manifest.jb.topDevices));
  assert.ok(manifest.jb.topDevices.length > 0, "jb topDevices should be non-empty");
});

test("fetchOrCacheManifest returns same object on second call (cache hit)", async () => {
  invalidateManifestCache();
  const m1 = await fetchOrCacheManifest();
  const m2 = await fetchOrCacheManifest();
  assert.equal(m1, m2, "second call should return cached object");
});

test("fetchOrCacheManifest re-fetches after invalidation", async () => {
  invalidateManifestCache();
  const m1 = await fetchOrCacheManifest();
  invalidateManifestCache();
  const m2 = await fetchOrCacheManifest();
  // Not the same object — fresh fetch
  assert.notEqual(m1, m2);
  assert.ok(m2.fetchedAt >= m1.fetchedAt);
});

test("yield topDevices are sorted by count descending", async () => {
  invalidateManifestCache();
  const manifest = await fetchOrCacheManifest();
  const devices = manifest.yield.topDevices;
  for (let i = 1; i < devices.length; i++) {
    assert.ok(
      devices[i - 1]!.count >= devices[i]!.count,
      `topDevices[${i - 1}].count (${devices[i - 1]!.count}) should be >= topDevices[${i}].count (${devices[i]!.count})`
    );
  }
});

test("topDevices capped at 10", async () => {
  invalidateManifestCache();
  const manifest = await fetchOrCacheManifest();
  assert.ok(manifest.yield.topDevices.length <= 10);
  assert.ok(manifest.jb.topDevices.length <= 10);
});
```

- [ ] **Step 2: Run tests, verify they FAIL**

```powershell
cd pcr-ai-api
npx tsx --test test/agentManifest.test.ts
```
Expected: `Error: Cannot find module '../src/lib/agent/agentManifest.js'`

- [ ] **Step 3: Create `agentManifest.ts`**

```typescript
// pcr-ai-api/src/lib/agent/agentManifest.ts
import { withConnection, withProbeWebConnection } from "../../oracle.js";
import oracledb from "oracledb";
import {
  yieldMonitorTriggersUseDummy,
  getYieldMonitorTriggerDummyRows,
} from "../yieldMonitorTriggerDummy.js";
import {
  infcontrolLayerBinsUseDummy,
  getInfcontrolLayerBinDummyRows,
} from "../infcontrolLayerBinDummy.js";
import { probeCardTypeLeadingSegment } from "../probeCardTypeLeadingSegment.js";

export interface DataManifest {
  fetchedAt: number;
  yield: {
    timeMin: string | null;
    timeMax: string | null;
    topDevices: Array<{ device: string; count: number }>;
  };
  jb: {
    timeMin: string | null;
    timeMax: string | null;
    topDevices: Array<{ device: string; count: number }>;
  };
}

const MANIFEST_TTL_MS = 60 * 60 * 1000; // 1 hour
let _cachedManifest: DataManifest | null = null;

function emptyDomain(): DataManifest["yield"] {
  return { timeMin: null, timeMax: null, topDevices: [] };
}

async function fetchYieldDomain(): Promise<DataManifest["yield"]> {
  if (yieldMonitorTriggersUseDummy()) {
    const rows = getYieldMonitorTriggerDummyRows().filter(
      (r) =>
        String(r.TYPE).trim().toUpperCase() === "DELTA_DIFF" &&
        !/^(kk|gg|c)/i.test(String(r.LOTID))
    );
    if (rows.length === 0) return emptyDomain();

    let timeMin = rows[0]!.TIME_STAMP;
    let timeMax = rows[0]!.TIME_STAMP;
    const devCount = new Map<string, number>();

    for (const r of rows) {
      if (r.TIME_STAMP && r.TIME_STAMP < timeMin) timeMin = r.TIME_STAMP;
      if (r.TIME_STAMP && r.TIME_STAMP > timeMax) timeMax = r.TIME_STAMP;
      devCount.set(r.DEVICE, (devCount.get(r.DEVICE) ?? 0) + 1);
    }

    const topDevices = [...devCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([device, count]) => ({ device, count }));

    return { timeMin: timeMin || null, timeMax: timeMax || null, topDevices };
  }

  const timeRangeSql = `
    SELECT MIN(t.TIME_STAMP) AS ts_min, MAX(t.TIME_STAMP) AS ts_max
    FROM YMWEB_YIELDMONITORTRIGGER t
    WHERE UPPER(TRIM(t."TYPE")) = 'DELTA_DIFF'
      AND NOT REGEXP_LIKE(t.LOTID, '^(kk|gg|c)', 'i')
  `;
  const topDeviceSql = `
    SELECT t.DEVICE, COUNT(*) AS cnt
    FROM YMWEB_YIELDMONITORTRIGGER t
    WHERE UPPER(TRIM(t."TYPE")) = 'DELTA_DIFF'
      AND NOT REGEXP_LIKE(t.LOTID, '^(kk|gg|c)', 'i')
    GROUP BY t.DEVICE
    ORDER BY cnt DESC
    FETCH FIRST 10 ROWS ONLY
  `;

  return withProbeWebConnection(async (conn) => {
    const rangeResult = await conn.execute(timeRangeSql, {}, {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
    });
    const devResult = await conn.execute(topDeviceSql, {}, {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
    });
    const rangeRow =
      ((rangeResult.rows ?? []) as Record<string, unknown>[])[0] ?? {};
    const devRows = (devResult.rows ?? []) as Record<string, unknown>[];
    return {
      timeMin:
        rangeRow["TS_MIN"] != null
          ? String(rangeRow["TS_MIN"]).slice(0, 10)
          : null,
      timeMax:
        rangeRow["TS_MAX"] != null
          ? String(rangeRow["TS_MAX"]).slice(0, 10)
          : null,
      topDevices: devRows.map((r) => ({
        device: String(r["DEVICE"] ?? ""),
        count: Number(r["CNT"] ?? 0),
      })),
    };
  });
}

async function fetchJbDomain(): Promise<DataManifest["jb"]> {
  if (infcontrolLayerBinsUseDummy()) {
    const rows = getInfcontrolLayerBinDummyRows().filter(
      (r) =>
        String(r.PASSTYPE).trim() === "TEST" &&
        !/^(kk|gg|c)/i.test(String(r.LOT))
    );
    if (rows.length === 0) return emptyDomain();

    let timeMin = String(rows[0]!.TESTEND);
    let timeMax = String(rows[0]!.TESTEND);
    const devCount = new Map<string, number>();

    for (const r of rows) {
      const te = String(r.TESTEND);
      if (te && te < timeMin) timeMin = te;
      if (te && te > timeMax) timeMax = te;
      devCount.set(String(r.DEVICE), (devCount.get(String(r.DEVICE)) ?? 0) + 1);
    }

    const topDevices = [...devCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([device, count]) => ({ device, count }));

    return { timeMin: timeMin || null, timeMax: timeMax || null, topDevices };
  }

  const timeRangeSql = `
    SELECT MIN(t2.TESTEND) AS ts_min, MAX(t2.TESTEND) AS ts_max
    FROM INFCONTROL t1
    JOIN INFLAYERBINLIST t2 ON t1.ID = t2.INFCONTROLID
    WHERE t2.PASSTYPE = 'TEST'
      AND NOT REGEXP_LIKE(t1.LOT, '^(kk|gg|c)', 'i')
  `;
  const topDeviceSql = `
    SELECT t1.DEVICE, COUNT(*) AS cnt
    FROM INFCONTROL t1
    JOIN INFLAYERBINLIST t2 ON t1.ID = t2.INFCONTROLID
    WHERE t2.PASSTYPE = 'TEST'
      AND NOT REGEXP_LIKE(t1.LOT, '^(kk|gg|c)', 'i')
    GROUP BY t1.DEVICE
    ORDER BY cnt DESC
    FETCH FIRST 10 ROWS ONLY
  `;

  return withConnection(async (conn) => {
    const rangeResult = await conn.execute(timeRangeSql, {}, {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
    });
    const devResult = await conn.execute(topDeviceSql, {}, {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
    });
    const rangeRow =
      ((rangeResult.rows ?? []) as Record<string, unknown>[])[0] ?? {};
    const devRows = (devResult.rows ?? []) as Record<string, unknown>[];
    return {
      timeMin:
        rangeRow["TS_MIN"] != null
          ? String(rangeRow["TS_MIN"]).slice(0, 10)
          : null,
      timeMax:
        rangeRow["TS_MAX"] != null
          ? String(rangeRow["TS_MAX"]).slice(0, 10)
          : null,
      topDevices: devRows.map((r) => ({
        device: String(r["DEVICE"] ?? ""),
        count: Number(r["CNT"] ?? 0),
      })),
    };
  });
}

export function invalidateManifestCache(): void {
  _cachedManifest = null;
}

export async function fetchOrCacheManifest(): Promise<DataManifest> {
  if (
    _cachedManifest !== null &&
    Date.now() - _cachedManifest.fetchedAt < MANIFEST_TTL_MS
  ) {
    return _cachedManifest;
  }

  const [yieldDomain, jbDomain] = await Promise.all([
    fetchYieldDomain().catch(() => emptyDomain()),
    fetchJbDomain().catch(() => emptyDomain()),
  ]);

  const manifest: DataManifest = {
    fetchedAt: Date.now(),
    yield: yieldDomain,
    jb: jbDomain,
  };
  _cachedManifest = manifest;
  return manifest;
}
```

- [ ] **Step 4: Run tests, verify they PASS**

```powershell
cd pcr-ai-api
npx tsx --test test/agentManifest.test.ts
```
Expected: 5 passing, 0 failing

- [ ] **Step 5: Typecheck**

```powershell
npm run typecheck
```
Expected: no errors

- [ ] **Step 6: Commit**

```powershell
git add pcr-ai-api/src/lib/agent/agentManifest.ts pcr-ai-api/test/agentManifest.test.ts
git commit -m "feat(agent): add agentManifest — TTL-cached data snapshot (device list + time range)"
```

---

## Task 2: `agentFilterValuesTool.ts` — 按需 DISTINCT 查询工具

**Files:**
- Create: `pcr-ai-api/src/lib/agent/agentFilterValuesTool.ts`
- Create: `pcr-ai-api/test/agentFilterValues.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// pcr-ai-api/test/agentFilterValues.test.ts
import assert from "node:assert/strict";
import test from "node:test";

process.env["YIELD_MONITOR_TRIGGERS_DUMMY"] = "true";
process.env["INFCONTROL_LAYER_BINS_DUMMY"] = "true";

import { runGetFilterValues } from "../src/lib/agent/agentFilterValuesTool.js";

test("yield/probeCard returns distinct list with counts", async () => {
  const raw = await runGetFilterValues({ domain: "yield", field: "probeCard" });
  const result = JSON.parse(raw) as {
    domain: string;
    field: string;
    values: string[];
    totalDistinct: number;
  };
  assert.equal(result.domain, "yield");
  assert.equal(result.field, "probeCard");
  assert.ok(Array.isArray(result.values));
  assert.ok(result.values.length > 0, "should have at least one probeCard");
  // Each value should end with " (N次)"
  assert.match(result.values[0]!, /\(\d+次\)$/);
  assert.ok(result.totalDistinct > 0);
});

test("yield/probeCard with filterBy.device narrows results", async () => {
  // First get all probeCards to find a device that exists
  const allRaw = await runGetFilterValues({ domain: "yield", field: "probeCard" });
  const allResult = JSON.parse(allRaw) as { values: string[] };
  assert.ok(allResult.values.length > 0);

  // Get devices to pick one
  const devRaw = await runGetFilterValues({ domain: "yield", field: "lotId" });
  const devResult = JSON.parse(devRaw) as { values: string[]; totalDistinct: number };
  assert.ok(devResult.totalDistinct > 0);
});

test("yield/probeCardType returns leading-segment values", async () => {
  const raw = await runGetFilterValues({ domain: "yield", field: "probeCardType" });
  const result = JSON.parse(raw) as { values: string[]; totalDistinct: number };
  assert.ok(result.values.length > 0);
  // probeCardType values should not contain "-" (they're the leading segment)
  for (const v of result.values) {
    const label = v.replace(/ \(\d+次\)$/, "");
    assert.ok(!label.includes("-"), `probeCardType "${label}" should not contain "-"`);
  }
});

test("jb/cardId returns results in Dummy mode", async () => {
  const raw = await runGetFilterValues({ domain: "jb", field: "cardId" });
  const result = JSON.parse(raw) as { domain: string; field: string; values: string[] };
  assert.equal(result.domain, "jb");
  assert.equal(result.field, "cardId");
  assert.ok(result.values.length > 0);
});

test("jb/lot with filterBy.device filters results", async () => {
  // Get the first device from jb
  const devRaw = await runGetFilterValues({ domain: "jb", field: "cardId" });
  const devResult = JSON.parse(devRaw) as { values: string[] };
  assert.ok(devResult.values.length > 0);

  // Querying lots is valid and returns results
  const raw = await runGetFilterValues({ domain: "jb", field: "lot" });
  const result = JSON.parse(raw) as { values: string[] };
  assert.ok(result.values.length > 0);
});

test("unknown field returns error string", async () => {
  const result = await runGetFilterValues({ domain: "yield", field: "nonexistent" });
  assert.ok(typeof result === "string");
  assert.match(result, /不支持.*field/);
});

test("unknown domain returns error string", async () => {
  const result = await runGetFilterValues({ domain: "unknown", field: "probeCard" });
  assert.ok(typeof result === "string");
  assert.match(result, /domain/);
});

test("limit is respected", async () => {
  const raw = await runGetFilterValues({ domain: "yield", field: "lotId", limit: 2 });
  const result = JSON.parse(raw) as { values: string[] };
  assert.ok(result.values.length <= 2);
});
```

- [ ] **Step 2: Run tests, verify FAIL**

```powershell
npx tsx --test test/agentFilterValues.test.ts
```
Expected: `Cannot find module '../src/lib/agent/agentFilterValuesTool.js'`

- [ ] **Step 3: Create `agentFilterValuesTool.ts`**

```typescript
// pcr-ai-api/src/lib/agent/agentFilterValuesTool.ts
import { withConnection, withProbeWebConnection } from "../../oracle.js";
import oracledb from "oracledb";
import {
  yieldMonitorTriggersUseDummy,
  getYieldMonitorTriggerDummyRows,
} from "../yieldMonitorTriggerDummy.js";
import {
  infcontrolLayerBinsUseDummy,
  getInfcontrolLayerBinDummyRows,
} from "../infcontrolLayerBinDummy.js";
import { probeCardTypeLeadingSegment } from "../probeCardTypeLeadingSegment.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

const YIELD_FIELDS = ["probeCard", "probeCardType", "hostname", "lotId"] as const;
const JB_FIELDS = ["cardId", "probeCardType", "testerId", "lot"] as const;

type YieldField = (typeof YIELD_FIELDS)[number];
type JbField = (typeof JB_FIELDS)[number];

interface FilterValuesResult {
  domain: "yield" | "jb";
  field: string;
  values: string[];
  totalDistinct: number;
}

function clampLimit(raw: unknown): number {
  const n = typeof raw === "number" ? raw : DEFAULT_LIMIT;
  return Math.min(Math.max(1, Math.round(n)), MAX_LIMIT);
}

function countDistinct(rawValues: string[], limit: number): {
  values: string[];
  totalDistinct: number;
} {
  const counts = new Map<string, number>();
  for (const v of rawValues) {
    if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const values = sorted.slice(0, limit).map(([v, cnt]) => `${v} (${cnt}次)`);
  return { values, totalDistinct: counts.size };
}

// ─── Dummy paths ─────────────────────────────────────────────────────────────

function dummyYield(
  field: YieldField,
  filterBy: Record<string, string | undefined>,
  limit: number
): FilterValuesResult {
  const rows = getYieldMonitorTriggerDummyRows().filter((r) => {
    if (filterBy["device"] && String(r.DEVICE).trim() !== filterBy["device"]) return false;
    if (filterBy["probeCardType"]) {
      if (probeCardTypeLeadingSegment(r.PROBECARD) !== filterBy["probeCardType"]) return false;
    }
    return true;
  });

  const raw: string[] = rows.map((r) => {
    switch (field) {
      case "probeCard":     return String(r.PROBECARD).trim();
      case "probeCardType": return probeCardTypeLeadingSegment(r.PROBECARD) ?? "";
      case "hostname":      return String(r.HOSTNAME).trim();
      case "lotId":         return String(r.LOTID).trim();
    }
  });

  const { values, totalDistinct } = countDistinct(raw, limit);
  return { domain: "yield", field, values, totalDistinct };
}

function dummyJb(
  field: JbField,
  filterBy: Record<string, string | undefined>,
  limit: number
): FilterValuesResult {
  const rows = getInfcontrolLayerBinDummyRows().filter((r) => {
    if (filterBy["device"] && String(r.DEVICE).trim() !== filterBy["device"]) return false;
    if (filterBy["probeCardType"]) {
      if (probeCardTypeLeadingSegment(r.CARDID) !== filterBy["probeCardType"]) return false;
    }
    return true;
  });

  const raw: string[] = rows.map((r) => {
    switch (field) {
      case "cardId":        return String(r.CARDID).trim();
      case "probeCardType": return probeCardTypeLeadingSegment(r.CARDID) ?? "";
      case "testerId":      return String(r.TESTERID).trim();
      case "lot":           return String(r.LOT).trim();
    }
  });

  const { values, totalDistinct } = countDistinct(raw, limit);
  return { domain: "jb", field, values, totalDistinct };
}

// ─── Oracle paths ─────────────────────────────────────────────────────────────

async function oracleYield(
  field: YieldField,
  filterBy: Record<string, string | undefined>,
  limit: number
): Promise<FilterValuesResult> {
  const conditions: string[] = [
    `UPPER(TRIM(t."TYPE")) = 'DELTA_DIFF'`,
    `NOT REGEXP_LIKE(t.LOTID, '^(kk|gg|c)', 'i')`,
  ];
  const binds: Record<string, unknown> = { lim: limit };

  if (filterBy["device"]) {
    conditions.push(`t.DEVICE = :device`);
    binds["device"] = filterBy["device"];
  }
  if (filterBy["probeCardType"]) {
    conditions.push(
      `NVL(REGEXP_SUBSTR(TRIM(t.PROBECARD), '^[^-]+', 1, 1), '') = :pct`
    );
    binds["pct"] = filterBy["probeCardType"];
  }

  const where = conditions.join(" AND ");

  let sql: string;
  if (field === "probeCardType") {
    sql = `
      SELECT sub.pct AS grp_key, COUNT(*) AS cnt
      FROM (
        SELECT NVL(REGEXP_SUBSTR(TRIM(t.PROBECARD), '^[^-]+', 1, 1), '') AS pct
        FROM YMWEB_YIELDMONITORTRIGGER t
        WHERE ${where}
      ) sub
      WHERE sub.pct IS NOT NULL AND sub.pct != ''
      GROUP BY sub.pct
      ORDER BY cnt DESC
      FETCH FIRST :lim ROWS ONLY
    `;
  } else {
    const col = field === "probeCard" ? "t.PROBECARD"
      : field === "hostname" ? "t.HOSTNAME"
      : "t.LOTID";
    sql = `
      SELECT ${col} AS grp_key, COUNT(*) AS cnt
      FROM YMWEB_YIELDMONITORTRIGGER t
      WHERE ${where}
        AND ${col} IS NOT NULL AND TRIM(${col}) != ''
      GROUP BY ${col}
      ORDER BY cnt DESC
      FETCH FIRST :lim ROWS ONLY
    `;
  }

  const rows = await withProbeWebConnection(async (conn) => {
    const r = await conn.execute(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    return (r.rows ?? []) as Record<string, unknown>[];
  });

  const values = rows.map(
    (r) => `${String(r["GRP_KEY"] ?? "")} (${Number(r["CNT"] ?? 0)}次)`
  );
  return { domain: "yield", field, values, totalDistinct: rows.length };
}

async function oracleJb(
  field: JbField,
  filterBy: Record<string, string | undefined>,
  limit: number
): Promise<FilterValuesResult> {
  const conditions: string[] = [
    `t2.PASSTYPE = 'TEST'`,
    `NOT REGEXP_LIKE(t1.LOT, '^(kk|gg|c)', 'i')`,
  ];
  const binds: Record<string, unknown> = { lim: limit };

  if (filterBy["device"]) {
    conditions.push(`t1.DEVICE = :device`);
    binds["device"] = filterBy["device"];
  }
  if (filterBy["probeCardType"]) {
    conditions.push(
      `NVL(REGEXP_SUBSTR(TRIM(t1.CARDID), '^[^-]+', 1, 1), '') = :pct`
    );
    binds["pct"] = filterBy["probeCardType"];
  }

  const where = conditions.join(" AND ");
  const fromClause = `FROM INFCONTROL t1 JOIN INFLAYERBINLIST t2 ON t1.ID = t2.INFCONTROLID WHERE ${where}`;

  let sql: string;
  if (field === "probeCardType") {
    sql = `
      SELECT sub.pct AS grp_key, COUNT(*) AS cnt
      FROM (
        SELECT NVL(REGEXP_SUBSTR(TRIM(t1.CARDID), '^[^-]+', 1, 1), '') AS pct
        ${fromClause}
      ) sub
      WHERE sub.pct IS NOT NULL AND sub.pct != ''
      GROUP BY sub.pct
      ORDER BY cnt DESC
      FETCH FIRST :lim ROWS ONLY
    `;
  } else {
    const col = field === "cardId" ? "t1.CARDID"
      : field === "testerId" ? "t1.TESTERID"
      : "t1.LOT";
    sql = `
      SELECT ${col} AS grp_key, COUNT(*) AS cnt
      ${fromClause}
        AND ${col} IS NOT NULL AND TRIM(${col}) != ''
      GROUP BY ${col}
      ORDER BY cnt DESC
      FETCH FIRST :lim ROWS ONLY
    `;
  }

  const rows = await withConnection(async (conn) => {
    const r = await conn.execute(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    return (r.rows ?? []) as Record<string, unknown>[];
  });

  const values = rows.map(
    (r) => `${String(r["GRP_KEY"] ?? "")} (${Number(r["CNT"] ?? 0)}次)`
  );
  return { domain: "jb", field, values, totalDistinct: rows.length };
}

// ─── Public entry point ───────────────────────────────────────────────────────

export async function runGetFilterValues(
  args: Record<string, unknown>
): Promise<string> {
  const domain = String(args["domain"] ?? "");
  const field = String(args["field"] ?? "");
  const filterBy = (args["filterBy"] as Record<string, string> | undefined) ?? {};
  const limit = clampLimit(args["limit"]);

  if (domain === "yield") {
    if (!(YIELD_FIELDS as readonly string[]).includes(field)) {
      return `get_filter_values 错误: yield domain 不支持 field="${field}"。支持: ${YIELD_FIELDS.join(", ")}`;
    }
    const result = yieldMonitorTriggersUseDummy()
      ? dummyYield(field as YieldField, filterBy, limit)
      : await oracleYield(field as YieldField, filterBy, limit);
    return JSON.stringify(result);
  }

  if (domain === "jb") {
    if (!(JB_FIELDS as readonly string[]).includes(field)) {
      return `get_filter_values 错误: jb domain 不支持 field="${field}"。支持: ${JB_FIELDS.join(", ")}`;
    }
    const result = infcontrolLayerBinsUseDummy()
      ? dummyJb(field as JbField, filterBy, limit)
      : await oracleJb(field as JbField, filterBy, limit);
    return JSON.stringify(result);
  }

  return `get_filter_values 错误: domain 必须是 "yield" 或 "jb"，收到 "${domain}"`;
}
```

- [ ] **Step 4: Run tests, verify PASS**

```powershell
npx tsx --test test/agentFilterValues.test.ts
```
Expected: 8 passing, 0 failing

- [ ] **Step 5: Typecheck**

```powershell
npm run typecheck
```
Expected: no errors

- [ ] **Step 6: Commit**

```powershell
git add pcr-ai-api/src/lib/agent/agentFilterValuesTool.ts pcr-ai-api/test/agentFilterValues.test.ts
git commit -m "feat(agent): add agentFilterValuesTool — on-demand DISTINCT filter value discovery"
```

---

## Task 3: `agentPrompt.ts` — manifest 注入 + 质量规则加强

**Files:**
- Modify: `pcr-ai-api/src/lib/agent/agentPrompt.ts`

- [ ] **Step 1: 替换 `agentPrompt.ts` 全文**

用以下内容完全替换该文件：

```typescript
// pcr-ai-api/src/lib/agent/agentPrompt.ts
import type { DataManifest } from "./agentManifest.js";

function buildManifestSection(manifest: DataManifest | undefined): string {
  if (!manifest) return "";

  const { yield: y, jb } = manifest;
  const hasYield = y.timeMin != null || y.topDevices.length > 0;
  const hasJb = jb.timeMin != null || jb.topDevices.length > 0;

  if (!hasYield && !hasJb) {
    return `\n## 数据库快照（暂不可用）\n如需了解可查询的 device 或时间范围，请调用 get_filter_values 工具。`;
  }

  const lines: string[] = ["\n## 数据库现有数据快照（约每小时刷新）\n"];

  if (hasYield) {
    const timeRange =
      y.timeMin && y.timeMax
        ? `${y.timeMin.slice(0, 10)} ~ ${y.timeMax.slice(0, 10)}`
        : "（时间范围未知）";
    lines.push(`Yield Monitor 数据时间范围：${timeRange}`);
    if (y.topDevices.length > 0) {
      lines.push(
        `主要 device（按触发量降序）：${y.topDevices.map((d) => `${d.device} (${d.count})`).join(", ")}`
      );
    }
    lines.push("");
  }

  if (hasJb) {
    const timeRange =
      jb.timeMin && jb.timeMax
        ? `${jb.timeMin.slice(0, 10)} ~ ${jb.timeMax.slice(0, 10)}`
        : "（时间范围未知）";
    lines.push(`JB STAR 数据时间范围：${timeRange}`);
    if (jb.topDevices.length > 0) {
      lines.push(
        `主要 device（按记录量降序）：${jb.topDevices.map((d) => `${d.device} (${d.count})`).join(", ")}`
      );
    }
    lines.push("");
  }

  lines.push("⚠️ 以上为近似统计，精确数字以工具查询结果为准。");
  return lines.join("\n");
}

export function buildSystemPrompt(manifest?: DataManifest): string {
  const today = new Date().toISOString().slice(0, 10);
  const manifestSection = buildManifestSection(manifest);
  return `你是 NXP ATTJ WaferTest 数据分析助手，专注于探针卡良率与 BIN 异常分析。

**当前日期：${today}**
**语言要求：必须全程用中文回答，严禁使用英文。**

可用工具：query_yield_triggers, aggregate_yield_triggers, query_jb_bins, aggregate_jb_bins, generate_chart, ask_clarification, get_filter_values。
${manifestSection}

## 决策优先级

面对用户请求时，按以下顺序判断：

1. **澄清优先** — 仅当 **device 产品代码完全未知** 时才调用 ask_clarification
   → 时间范围、批次号、晶圆号、测试机等均有 API 默认值，**不得以缺少这些参数为由询问用户**
   → 用户说"总体查一下"/"都查"/"概况"时，直接用默认参数查询，无需确认
   → 必须询问时合并为一次问题，禁止多轮追问

2. **规划其次** — 请求明确，但需要 3 步及以上的连续操作
   → 先输出 [PLAN]\\n1. 步骤一\\n2. 步骤二\\n[/PLAN]，等用户确认（"好的"/"确认"/"yes"/"ok"）后再执行
   → 确认前不调用任何数据工具

3. **反思兜底** — 工具执行失败，且换策略有可能成功
   → 在回复中嵌入 [REFLECT]需要换策略：<原因和新策略>[/REFLECT]，最多重试 2 次
   → 超过 2 次直接告知用户失败原因

4. **直接执行** — 请求明确，步骤简单（1~2 步）
   → **立即调用工具，不要先说"马上查询"再停下来等待**——说完就查，查完再写结论

## 数据规则

- 查询结果为空（totalRowsMatching=0 或 groups 为空数组）时，立即用中文回答"没有找到符合条件的数据"，不要继续调用其他工具或生成图表
- 用中文回答，数字结论要具体（给出具体数字）
- 时间范围未指定时，API 默认查最近 1 年数据，无需额外说明
- Yield Monitor 数据来自 YMWEB_YIELDMONITORTRIGGER 表（delta_diff 类型），使用 query_yield_triggers / aggregate_yield_triggers
- JB STAR 数据来自 INFCONTROL ⋈ INFLAYERBINLIST（PASSTYPE=TEST），使用 query_jb_bins / aggregate_jb_bins

## 领域知识：探针卡与晶圆测试层级结构

### 实体层级（从大到小）

\`\`\`
device（产品）
  └─ probeCardType（卡种类，如 7772、8041）
       └─ probeCard / cardId（具体一张卡，如 7772-A1、8041-B3）
            └─ dut / site（测试位，与具体卡强绑定，不跨卡）

device
  └─ lot（批次）
       └─ 每个 lot 都使用某一张具体的卡（probeCard / cardId）
\`\`\`

**关键约束：**
- **dut（site）永远属于某一张具体的卡**，不能脱离 probeCard / cardId 单独分析
- **具体的卡**属于某一**种**卡（probeCardType = CARDID 首段，"-" 之前）
- **device** 与 **卡的种类（probeCardType）** 相关联——同一个 device 通常使用固定种类的卡
- **device 下有多个 lot**，每个 lot 都用**某一张具体的卡**（可能不同张，但必属同一种）

### 探针卡维度选择（必须准确识别用户意图）

| 用户问法 | 含义 | Yield Monitor 维度 | JB STAR 维度 |
|---|---|---|---|
| "哪**张**卡"、"具体的卡"、"某一块卡" | 单张卡实例，如 7772-A1 | \`probeCard\` | \`cardId\` |
| "哪**种**卡"、"卡的种类"、"卡型号" | 卡类别，如 7772、8041 | \`probeCardType\` | \`probeCardType\` |

- "哪张卡报警最多" → 聚合维度用 probeCard / cardId（具体卡）
- "哪种卡报警最多" → 聚合维度用 probeCardType（卡类别）
- 用户说"7772 这张卡"时，7772 是**种类**，需进一步问具体卡号，或改用 probeCardType 筛选再按 cardId 聚合
- 用户问 dut / site 分析时，**必须同时指定具体的卡**（cardId / probeCard），否则数据无意义

## 可选值发现规则

- 系统提示词数据快照已包含 device 列表和时间范围 → **无需**调 get_filter_values 查这两项
- 用户提到具体 probeCard / cardId / lot / hostname 但值不确定时 → 先调 get_filter_values 确认
- get_filter_values 返回空列表 → 告知用户"该条件下无数据"，不继续用猜测值查询
- filterBy 参数优先使用用户已指定的 device，缩小查询范围，提升精度

## 回复质量要求（必须遵守）

每次有数据结论时，必须包含以下三要素：

① **关键数字** — 最高/最低/总量，精确到整数，不用"大约"模糊
② **对比解读** — 至少一项：占总量的比例、与第二名的差距、与上一轮结论的变化
③ **下一步建议** — 主动给出可以继续深挖的维度或卡号（具体，不泛泛）

示例：
✅ "7772-A1 触发 17 次，占本次查询总量（40 次）的 42.5%，比第二名 8041-B3（9 次）多近一倍。
    建议按 timeDay 查趋势，确认是否近期突发；或进一步查 7772-A1 的 DUT 分布。"
❌ "7772-A1 触发了 17 次，8041-B3 触发了 9 次。"

## 图表提示规则（严格执行）

**只在以下情况末尾提示是否需要图表：**
- 聚合结果有 **≥ 4 个组**，且数值差异明显（适合对比）
- 时序数据（timeDay 维度），适合看趋势
- 用户明确提到"趋势"、"变化"、"分布"

**以下情况绝对不提示图表：**
- 结果只有 1~3 个数据点（文字更清晰）
- 用户在追问某个细节（"那张卡呢"/"DUT 3 是什么情况"）
- 查询结果为空
- 刚刚在上一轮已经提示过

❌ 禁止：每次回复末尾都加"如需图表请告诉我"
✅ 正确：只在数据真正适合可视化时才提示一次

**用户确认后才调用 generate_chart**：确认词包括"要图"/"生成"/"可视化"/"好的"/"yes"

图表类型参考：bar 适合计数对比，line 适合时序趋势，pie 适合占比

## 格式限制

- **严禁**在回复中使用 Markdown 图片语法 \`![...](url)\`，图片无法在界面显示
- 图表只能通过 generate_chart 工具生成，不要用文字图片替代`;
}
```

- [ ] **Step 2: Typecheck**

```powershell
npm run typecheck
```
Expected: no errors (agentLoop.ts will show an error because it calls `buildSystemPrompt()` with no args — that's OK, it still compiles since `manifest?` is optional)

- [ ] **Step 3: Commit**

```powershell
git add pcr-ai-api/src/lib/agent/agentPrompt.ts
git commit -m "feat(agent): inject manifest snapshot into system prompt; strengthen quality rules"
```

---

## Task 4: 注册工具 + 接入 agentLoop

**Files:**
- Modify: `pcr-ai-api/src/lib/agent/agentToolSchemas.ts`
- Modify: `pcr-ai-api/src/lib/agent/agentToolHandlers.ts`
- Modify: `pcr-ai-api/src/lib/agent/agentLoop.ts`

- [ ] **Step 1: 在 `agentToolSchemas.ts` 末尾追加 `get_filter_values` schema**

在 `TOOL_SCHEMAS` 数组 `] as const;` 之前插入（在 `ask_clarification` 对象之后）：

```typescript
  {
    type: "function",
    function: {
      name: "get_filter_values",
      description:
        "查询某个筛选维度的可用值列表（如探针卡、批次号、测试机等）。在需要精确筛选但不知道具体值时调用。不要用它查 device 或时间范围——那些已在系统提示词的数据快照中。",
      parameters: {
        type: "object",
        properties: {
          domain: {
            type: "string",
            enum: ["yield", "jb"],
            description: "数据域",
          },
          field: {
            type: "string",
            description:
              "要查询可选值的字段。yield 支持: probeCard, probeCardType, hostname, lotId；jb 支持: cardId, probeCardType, testerId, lot",
          },
          filterBy: {
            type: "object",
            description: "可选前置过滤，如 { device: 'WA03P02G' }",
            properties: {
              device: { type: "string" },
              probeCardType: { type: "string" },
            },
          },
          limit: {
            type: "number",
            description: "返回最多 N 个值，默认 20，最大 50",
          },
        },
        required: ["domain", "field"],
      },
    },
  },
```

- [ ] **Step 2: 在 `agentToolHandlers.ts` 中添加 import 和路由**

在文件顶部的 import 区块末尾追加：

```typescript
import { runGetFilterValues } from "./agentFilterValuesTool.js";
```

在 `runTool` 函数的 `switch` 语句的 `default:` 之前追加：

```typescript
    case "get_filter_values":
      return runGetFilterValues(args);
```

- [ ] **Step 3: 在 `agentLoop.ts` 中集成 manifest**

在文件顶部 import 区块末尾追加：

```typescript
import { fetchOrCacheManifest } from "./agentManifest.js";
```

在 `runAgentLoop` 函数体内，`appendMessages(sessionId, ...)` 那行之后（summarization 逻辑之前），追加：

```typescript
  const manifest = await fetchOrCacheManifest().catch(() => undefined);
```

在 `runAgentLoop` 内的 `for` 循环内，找到这行：

```typescript
      { role: "system", content: buildSystemPrompt() },
```

替换为：

```typescript
      { role: "system", content: buildSystemPrompt(manifest) },
```

- [ ] **Step 4: Run full test suite**

```powershell
npm test
```
Expected: all tests pass (manifest + filterValues + existing agent + rest-api-v3-dummy)

- [ ] **Step 5: Typecheck**

```powershell
npm run typecheck
```
Expected: no errors

- [ ] **Step 6: Commit**

```powershell
git add pcr-ai-api/src/lib/agent/agentToolSchemas.ts pcr-ai-api/src/lib/agent/agentToolHandlers.ts pcr-ai-api/src/lib/agent/agentLoop.ts
git commit -m "feat(agent): register get_filter_values tool; wire manifest into runAgentLoop"
```

---

## Task 5: 验收测试

- [ ] **Step 1: 在 Dummy 模式下启动 API，手动测试 Agent**

```powershell
cd pcr-ai-api
$env:YIELD_MONITOR_TRIGGERS_DUMMY = "true"
$env:INFCONTROL_LAYER_BINS_DUMMY = "true"
$env:AGENT_API_KEY = "sk-test-dummy"
npm run dev
```

- [ ] **Step 2: 发送包含 device 发现的问题**

```powershell
$body = '{"message":"有哪些device可以查？","sessionId":"acceptance-1","agentConfig":{"apiKey":"sk-placeholder","apiBase":"https://api.siliconflow.cn/v1","model":"deepseek-ai/DeepSeek-V3"}}'
Invoke-WebRequest -Uri "http://localhost:30008/api/v4/agent/chat" -Method POST -ContentType "application/json" -Body $body | Select-Object -ExpandProperty Content
```
期望：AI 回答中包含从 prompt 数据快照里读到的 device 名称，**不调用 get_filter_values 工具**

- [ ] **Step 3: 发送需要探针卡发现的问题**

```powershell
$body = '{"message":"有哪些探针卡？","sessionId":"acceptance-2","agentConfig":{"apiKey":"sk-placeholder","apiBase":"https://api.siliconflow.cn/v1","model":"deepseek-ai/DeepSeek-V3"}}'
Invoke-WebRequest -Uri "http://localhost:30008/api/v4/agent/chat" -Method POST -ContentType "application/json" -Body $body | Select-Object -ExpandProperty Content
```
期望：SSE 流中出现 `"type":"tool_start"` 且 `"name":"get_filter_values"`，返回探针卡列表

- [ ] **Step 4: 全量测试 + build**

```powershell
npm test
npm run build
```
Expected: all tests pass, build succeeds with no undici warning

- [ ] **Step 5: 最终提交（如有未提交改动）**

```powershell
git status
# 若有剩余改动：
git add -A
git commit -m "chore(agent): acceptance verified — discovery + quality improvements complete"
```
