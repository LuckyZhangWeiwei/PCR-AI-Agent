# YM Alarm Density Trend Chart Implementation Plan

> **⚠️ ABANDONED (2026-07-09):** Cursor independently shipped an equivalent feature (`testerAlarmRate`) directly on `main`, tab-integrated into the existing Tester trend chart block rather than the standalone 4th block this plan describes. Decision: adopt Cursor's version (including its >100%→null capping, which differs from this plan's uncapped design). The worktree branch that executed Tasks 1-4 of this plan (`worktree-yield-monitor-alarm-density-trend`) was discarded — its `jbTotal`/`ratio` additions duplicated what Cursor's `testerActivityTotal`/`testerAlarmRate` now do in the same file. See `../specs/2026-07-08-yield-monitor-alarm-density-trend-design.md` and `../../HANDOFF_CURSOR_YIELD_MONITOR_JB_DENOMINATOR_2026-07-09.md`. Steps below are left unmarked as a historical record only — do not execute.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a standalone "YM 触发密度" chart to the Yield Monitor tab's period alarm trend section, showing `ratio = YM_trigger_total(bucket) / JB_STAR_test_total(bucket)` per week/month bucket, computed server-side in the existing `GET …/v3/period-alarm-trend` endpoint.

**Architecture:** `yieldMonitorRoutes.ts`'s `period-alarm-trend` handler runs its existing YM query (probeweb pool) plus a new JB STAR bucketed-count query (main pool, new module `infcontrolLayerBinPeriodCountTrend.ts`), reusing the same period buckets and the same `appliedForm`-derived filters (field-name-mapped). A pure merge function attaches `jbTotal`/`ratio` per bucket. The frontend adds one field to its response type and one new chart block, no new HTTP call.

**Tech Stack:** `pcr-ai-api` (Node/Express/TypeScript/oracledb 5.5), `pcr-ai-report` (React 19/TypeScript/ECharts), `node:test` for backend tests.

## Global Constraints

- **Dummy-Oracle Parity (hard rule):** every WHERE/filter/bucket/response-shape change must be implemented in both the Oracle SQL path and the corresponding `*Dummy.ts` path in the same task. See root `CLAUDE.md`.
- **Ratio formula (approved spec):** `ratio = total / jbTotal` computed once per bucket from bucket-level sums — never averaged from finer-grained per-day/per-lot ratios. `ratio` is uncapped and can exceed 1 (100%); it means "average YM triggers per JB STAR test", not a bounded occurrence rate. `jbTotal === 0` → `ratio = null`. JB STAR query failure → `jbTotal = null, ratio = null` for all buckets, and the whole request must still succeed (YM data still returns).
- **JB STAR scope is NOT `PASSTYPE='TEST'` alone** — reuse `infcontrolLayerBinV3BaseWhereBlock` (`src/lib/infcontrolLayerBinPasstypeScope.ts`), which is `PASSTYPE IN ('TEST','INTERRUPT','TEST ISR','TEST INTERRUPT') AND LAYERNAME <> 'ABANDONED'`, plus the existing kk/gg/c LOT-prefix exclusion baked into `parseInfcontrolLayerBinsV3Query`. Do not hardcode `PASSTYPE='TEST'` anywhere in new code — always go through the existing parser/where-block helpers so this stays in sync automatically.
- **Filter field mapping (YM `appliedForm` → JB STAR query param):** `device`→`device`, `mask`→`mask`, `lotId`→`lot`, `hostname`→`testerId`, `platform`→`platform`, `probeCardType`→`probeCardType`, `probeCard`→`cardId`, `pass`→`passId`. `wafer`→`slot` **only when `Number(wafer)` is finite** (YM `WAFER` is a free-text string column; JB `SLOT` is numeric — if the typed value doesn't parse as a number, drop the `slot` filter rather than failing the whole JB query). Bucket span → `testEndFrom`/`testEndTo` (JB buckets by `TESTEND`, YM buckets by `TIME_STAMP` — this is an accepted approximation, not to be "fixed").
- **Commit after every task** using this repo's existing commit message style (`type(scope): summary`), no `--no-verify`.
- Backend tests run via `npm test` (`tsx --test test/*.test.ts`) from `pcr-ai-api/`. Frontend has no unit test runner — verification is `npm run typecheck` + `npm run build` + manual dev-server check.

---

### Task 1: Extract reusable Dummy time-offset helper in `infcontrolLayerBinDummy.ts`

**Files:**
- Modify: `pcr-ai-api/src/lib/infcontrolLayerBinDummy.ts:443-529`
- Test: `pcr-ai-api/test/infcontrolLayerBinDummy.test.ts` (new file)

**Interfaces:**
- Produces: `infcontrolLayerBinDummyTimeOffsetMs(applied: Record<string, unknown>): number` (exported) — used by Task 2's Dummy aggregator to keep bucket time-shifting consistent with `filterInfcontrolLayerBinV3DummyRowsMatching`.
- `filterInfcontrolLayerBinV3DummyRowsMatching`'s existing exported signature and behavior are unchanged (this is a pure refactor — predicate filters are reordered, which does not change the final filtered set since they are independent of each other).

- [ ] **Step 1: Write the failing test**

Create `pcr-ai-api/test/infcontrolLayerBinDummy.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  filterInfcontrolLayerBinV3DummyRowsMatching,
  getInfcontrolLayerBinDummyRows,
  infcontrolLayerBinDummyTimeOffsetMs,
} from "../src/lib/infcontrolLayerBinDummy.js";

describe("infcontrolLayerBinDummy time offset", () => {
  test("infcontrolLayerBinDummyTimeOffsetMs shifts fixed sample timestamps near now", () => {
    const offset = infcontrolLayerBinDummyTimeOffsetMs({});
    const rows = getInfcontrolLayerBinDummyRows();
    assert.ok(rows.length > 0, "dummy sample must be non-empty for this test to be meaningful");
    const maxTs = rows.reduce(
      (m, r) => Math.max(m, new Date(String(r.TESTEND)).getTime()),
      0
    );
    assert.ok(maxTs > 0);
    // Shifted max TESTEND should land within a few seconds of "now".
    assert.ok(Math.abs(maxTs + offset - Date.now()) < 5000);
  });

  test("infcontrolLayerBinDummyTimeOffsetMs respects non-time filters (device)", () => {
    const rows = getInfcontrolLayerBinDummyRows();
    const first = rows[0]!;
    const offsetAll = infcontrolLayerBinDummyTimeOffsetMs({});
    const offsetFiltered = infcontrolLayerBinDummyTimeOffsetMs({
      device: String(first.DEVICE),
    });
    // Filtered offset is computed from a subset of rows, so it need not equal
    // the unfiltered offset, but it must still be a finite non-negative-ish number.
    assert.equal(typeof offsetFiltered, "number");
    assert.equal(typeof offsetAll, "number");
  });

  test("filterInfcontrolLayerBinV3DummyRowsMatching still applies bin-column and time filters together", () => {
    const now = Date.now();
    const wideOpen = filterInfcontrolLayerBinV3DummyRowsMatching({});
    assert.ok(wideOpen.length > 0);
    const offset = infcontrolLayerBinDummyTimeOffsetMs({});
    const narrowed = filterInfcontrolLayerBinV3DummyRowsMatching({
      testEndFrom: new Date(now - offset - 1).toISOString(),
      testEndTo: new Date(now - offset + 1).toISOString(),
    });
    assert.ok(narrowed.length <= wideOpen.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pcr-ai-api && npx tsx --test test/infcontrolLayerBinDummy.test.ts`
Expected: FAIL — `infcontrolLayerBinDummyTimeOffsetMs` is not exported from `../src/lib/infcontrolLayerBinDummy.js`.

- [ ] **Step 3: Refactor `infcontrolLayerBinDummy.ts` to extract the helper**

Replace the existing `export function filterInfcontrolLayerBinV3DummyRowsMatching(...)` (currently `infcontrolLayerBinDummy.ts:443-529`) with:

```ts
function filterInfcontrolLayerBinV3DummyRowsBeforeTime(
  applied: Record<string, unknown>
): InfcontrolLayerBinDummyRow[] {
  let rows = [...getInfcontrolLayerBinDummyRowsInternal()].filter((r) => {
    return (
      infcontrolLayerBinV3PasstypeMatches(r.PASSTYPE) &&
      String(r.LAYERNAME ?? "").trim().toUpperCase() !== "ABANDONED" &&
      !["kk", "gg", "c"].some((pfx) =>
        String(r.LOT ?? "").trim().toLowerCase().startsWith(pfx)
      )
    );
  });

  const ci = (col: string, param: string) => {
    const v = applied[param];
    if (v === undefined) return;
    const want = String(v).trim().toUpperCase();
    rows = rows.filter((r) => String(r[col]).trim().toUpperCase() === want);
  };

  ci("DEVICE", "device");
  ci("LOT", "lot");
  ci("MESLOT", "meslot");
  ci("TESTERID", "testerId");
  ci("TSTYPE", "tstype");
  ci("CARDID", "cardId");

  if (applied.mask !== undefined) {
    const want = String(applied.mask).trim().toUpperCase();
    rows = rows.filter((r) => deviceMatchesMask(r.DEVICE, want));
  }

  if (applied.probeCardType !== undefined) {
    const want = String(applied.probeCardType).trim().toUpperCase();
    rows = rows.filter((r) => {
      const cid = String(r.CARDID).trim().toUpperCase();
      return cid === want || cid.startsWith(want + "-");
    });
  }

  if (applied.slot !== undefined) {
    const n = Number(applied.slot);
    rows = rows.filter((r) => Number(r.SLOT) === n);
  }
  if (applied.passId !== undefined) {
    const n = Number(applied.passId);
    rows = rows.filter((r) => Number(r.PASSID) === n);
  }

  rows = rows.filter((r) => rowMatchesInfcontrolBinColumnFilters(r, applied));

  return rows;
}

/**
 * Dummy 数据时间戳固定，需要平移到「当前时刻」附近。偏移量必须基于**时间窗过滤前**（仅 device/lot/meslot/…
 * 等非时间筛选）匹配行的 maxTs 计算——若改用过滤后的行重新算一遍，会因为两次取值范围不同而得到不一致的偏移，
 * 导致窗口边界附近的行在分桶时被错误丢弃。任何需要独立于 `filterInfcontrolLayerBinV3DummyRowsMatching` 做时间
 * 分桶的调用方（如 period-count-trend）都应复用本函数。
 */
export function infcontrolLayerBinDummyTimeOffsetMs(
  applied: Record<string, unknown>
): number {
  const rows = filterInfcontrolLayerBinV3DummyRowsBeforeTime(applied);
  const maxTs = rows.reduce(
    (m, r) => Math.max(m, new Date(String(r.TESTEND)).getTime()),
    0
  );
  return maxTs > 0 ? Date.now() - maxTs : 0;
}

export function filterInfcontrolLayerBinV3DummyRowsMatching(
  applied: Record<string, unknown>
): Array<InfcontrolLayerBinDummyRow & { PROBECARDTYPE: string | null }> {
  let rows = filterInfcontrolLayerBinV3DummyRowsBeforeTime(applied);

  const tsLo = applied.testStartBegin ?? applied.testStartFrom;
  const tsHi = applied.testStartEnd ?? applied.testStartTo;
  const teLo = applied.testEndBegin ?? applied.testEndFrom;
  const teHi = applied.testEndEnd ?? applied.testEndTo;

  if (tsLo !== undefined || tsHi !== undefined || teLo !== undefined || teHi !== undefined) {
    const offset = infcontrolLayerBinDummyTimeOffsetMs(applied);
    if (tsLo !== undefined) {
      const from = new Date(String(tsLo)).getTime() - offset;
      rows = rows.filter((r) => new Date(String(r.TESTSTART)).getTime() >= from);
    }
    if (tsHi !== undefined) {
      const to = new Date(String(tsHi)).getTime() - offset;
      rows = rows.filter((r) => new Date(String(r.TESTSTART)).getTime() <= to);
    }
    if (teLo !== undefined) {
      const from = new Date(String(teLo)).getTime() - offset;
      rows = rows.filter((r) => new Date(String(r.TESTEND)).getTime() >= from);
    }
    if (teHi !== undefined) {
      const to = new Date(String(teHi)).getTime() - offset;
      rows = rows.filter((r) => new Date(String(r.TESTEND)).getTime() <= to);
    }
  }

  return rows.map((r) => ({
    ...r,
    PROBECARDTYPE: probeCardTypeLeadingSegment(r.CARDID),
    MASK: deviceBaseMask(r.DEVICE),
  }));
}
```

Also add `getInfcontrolLayerBinDummyRows` to the test's imports — it already exists and is exported (`infcontrolLayerBinDummy.ts:97`), no change needed there.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pcr-ai-api && npx tsx --test test/infcontrolLayerBinDummy.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Run the full existing suite to confirm no regression**

Run: `cd pcr-ai-api && npm test`
Expected: all existing tests still PASS (this refactor must not change any existing behavior — `filterInfcontrolLayerBinV3DummyRowsMatching`'s exported signature and output are identical to before).

- [ ] **Step 6: Commit**

```bash
git add pcr-ai-api/src/lib/infcontrolLayerBinDummy.ts pcr-ai-api/test/infcontrolLayerBinDummy.test.ts
git commit -m "$(cat <<'EOF'
refactor(jb-dummy): extract reusable time-offset helper

infcontrolLayerBinDummyTimeOffsetMs is exported so the upcoming
period-count-trend Dummy aggregator can reuse the same time-shift math
as filterInfcontrolLayerBinV3DummyRowsMatching, avoiding drift.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: New module `infcontrolLayerBinPeriodCountTrend.ts` (JB STAR bucketed COUNT)

**Files:**
- Create: `pcr-ai-api/src/lib/infcontrolLayerBinPeriodCountTrend.ts`
- Test: `pcr-ai-api/test/infcontrolLayerBinPeriodCountTrend.test.ts` (new file)

**Interfaces:**
- Consumes: `PeriodAlarmBucket` type from `./yieldMonitorPeriodAlarmTrend.js` (`{start: Date; end: Date; label: string}`, already exported); `infcontrolLayerBinV3BaseWhereBlock` from `./infcontrolLayerBinPasstypeScope.js`; `filterInfcontrolLayerBinV3DummyRowsMatching` / `infcontrolLayerBinDummyTimeOffsetMs` from `./infcontrolLayerBinDummy.js` (Task 1).
- Produces (all exported, all pure functions — no Oracle/Express dependency):
  - `mapYmAppliedToInfcontrolPeriodQuery(ymApplied: Record<string, unknown>, spanFromIso: string, spanToIso: string): Record<string, unknown>`
  - `buildInfcontrolPeriodCountTrendSql(whereAndSql: string, bucketCount: number): string`
  - `infcontrolPeriodCountTrendBinds(buckets: PeriodAlarmBucket[], baseBinds: BindParameters): BindParameters`
  - `mapInfcontrolPeriodCountTrendRows(buckets: PeriodAlarmBucket[], rows: Record<string, unknown>[]): number[]`
  - `aggregateInfcontrolPeriodCountTrendDummy(applied: Record<string, unknown>, buckets: PeriodAlarmBucket[]): number[]`

- [ ] **Step 1: Write the failing tests**

Create `pcr-ai-api/test/infcontrolLayerBinPeriodCountTrend.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  aggregateInfcontrolPeriodCountTrendDummy,
  buildInfcontrolPeriodCountTrendSql,
  infcontrolPeriodCountTrendBinds,
  mapInfcontrolPeriodCountTrendRows,
  mapYmAppliedToInfcontrolPeriodQuery,
} from "../src/lib/infcontrolLayerBinPeriodCountTrend.js";
import { recentPeriodBuckets } from "../src/lib/yieldMonitorPeriodAlarmTrend.js";
import { parseInfcontrolLayerBinsV3Query } from "../src/lib/infcontrolLayerBinFilters.js";
import { getInfcontrolLayerBinDummyRows } from "../src/lib/infcontrolLayerBinDummy.js";

describe("infcontrolLayerBinPeriodCountTrend", () => {
  test("mapYmAppliedToInfcontrolPeriodQuery maps field names and drops non-numeric wafer", () => {
    const q = mapYmAppliedToInfcontrolPeriodQuery(
      {
        device: "WA03P02G",
        mask: "P02G",
        lotId: "NF12615.1X",
        hostname: "TESTER01",
        platform: "UFLEX",
        probeCardType: "8041",
        probeCard: "8041-08",
        pass: 3,
        wafer: "wafer2",
        typeScope: "delta_diff",
        timeStampBegin: "2026-01-01T00:00:00.000Z",
      },
      "2026-06-01T00:00:00.000Z",
      "2026-07-01T00:00:00.000Z"
    );
    assert.deepEqual(q, {
      device: "WA03P02G",
      mask: "P02G",
      lot: "NF12615.1X",
      testerId: "TESTER01",
      platform: "UFLEX",
      probeCardType: "8041",
      cardId: "8041-08",
      passId: 3,
      testEndFrom: "2026-06-01T00:00:00.000Z",
      testEndTo: "2026-07-01T00:00:00.000Z",
    });
  });

  test("mapYmAppliedToInfcontrolPeriodQuery keeps numeric wafer as slot", () => {
    const q = mapYmAppliedToInfcontrolPeriodQuery(
      { wafer: "7" },
      "2026-06-01T00:00:00.000Z",
      "2026-07-01T00:00:00.000Z"
    );
    assert.equal(q.slot, 7);
  });

  test("buildInfcontrolPeriodCountTrendSql includes PASSTYPE scope and bucket CASE", () => {
    const sql = buildInfcontrolPeriodCountTrendSql("t1.DEVICE = :ic3_device", 4);
    assert.ok(sql.includes("PASSTYPE"));
    assert.ok(sql.includes("t2.TESTEND >= :b0_from AND t2.TESTEND <= :b0_to"));
    assert.ok(sql.includes(":b3_to"));
    assert.ok(sql.includes("COUNT(*) AS TOTAL"));
    assert.ok(sql.includes("GROUP BY bucket_idx"));
  });

  test("infcontrolPeriodCountTrendBinds adds per-bucket from/to on top of base binds", () => {
    const buckets = recentPeriodBuckets("week", 2, new Date("2026-07-06T10:00:00.000Z"));
    const binds = infcontrolPeriodCountTrendBinds(buckets, { ic3_device: "WA03P02G" });
    assert.equal((binds as Record<string, unknown>).ic3_device, "WA03P02G");
    assert.ok((binds as Record<string, unknown>).b0_from instanceof Date);
    assert.ok((binds as Record<string, unknown>).b1_to instanceof Date);
  });

  test("mapInfcontrolPeriodCountTrendRows fills 0 for buckets with no matching rows", () => {
    const buckets = recentPeriodBuckets("week", 3, new Date("2026-07-06T10:00:00.000Z"));
    const rows = [{ BUCKET_IDX: 1, TOTAL: 42 }];
    const totals = mapInfcontrolPeriodCountTrendRows(buckets, rows);
    assert.deepEqual(totals, [0, 42, 0]);
  });

  test("aggregateInfcontrolPeriodCountTrendDummy counts rows per bucket by TESTEND, matching filterInfcontrolLayerBinV3DummyRowsMatching total", async () => {
    const { filterInfcontrolLayerBinV3DummyRowsMatching, infcontrolLayerBinDummyTimeOffsetMs } =
      await import("../src/lib/infcontrolLayerBinDummy.js");
    const rows = getInfcontrolLayerBinDummyRows();
    assert.ok(rows.length > 0);
    const offset = infcontrolLayerBinDummyTimeOffsetMs({});
    const maxTe = rows.reduce(
      (m, r) => Math.max(m, new Date(String(r.TESTEND)).getTime() + offset),
      0
    );
    const buckets = recentPeriodBuckets("month", 4, new Date(maxTe));
    const totals = aggregateInfcontrolPeriodCountTrendDummy({}, buckets);
    assert.equal(totals.length, 4);
    const sumOfBuckets = totals.reduce((a, b) => a + b, 0);
    const matching = filterInfcontrolLayerBinV3DummyRowsMatching({});
    assert.ok(sumOfBuckets <= matching.length);
    assert.ok(sumOfBuckets > 0, "at least one row should fall in the last 4 months ending at the shifted max TESTEND");
  });

  test("parseInfcontrolLayerBinsV3Query accepts mapped query and its whereAndSql has no leading WHERE", () => {
    const parsed = parseInfcontrolLayerBinsV3Query({
      device: "WA03P02G",
      testEndFrom: "2026-01-01T00:00:00.000Z",
      testEndTo: "2026-02-01T00:00:00.000Z",
    });
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.ok(!parsed.whereAndSql.trim().toUpperCase().startsWith("WHERE"));
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pcr-ai-api && npx tsx --test test/infcontrolLayerBinPeriodCountTrend.test.ts`
Expected: FAIL — cannot find module `../src/lib/infcontrolLayerBinPeriodCountTrend.js`.

- [ ] **Step 3: Implement `infcontrolLayerBinPeriodCountTrend.ts`**

Create `pcr-ai-api/src/lib/infcontrolLayerBinPeriodCountTrend.ts`:

```ts
import type { BindParameters } from "oracledb";
import type { PeriodAlarmBucket } from "./yieldMonitorPeriodAlarmTrend.js";
import { infcontrolLayerBinV3BaseWhereBlock } from "./infcontrolLayerBinPasstypeScope.js";
import {
  filterInfcontrolLayerBinV3DummyRowsMatching,
  infcontrolLayerBinDummyTimeOffsetMs,
} from "./infcontrolLayerBinDummy.js";
import { assignPeriodBucketIndex } from "./yieldMonitorPeriodAlarmTrend.js";

/** YM `appliedForm`（点「查询」后生效的筛选）→ JB STAR `parseInfcontrolLayerBinsV3Query` 参数名映射。 */
const YM_TO_JB_DIRECT_FIELD_MAP: ReadonlyArray<readonly [string, string]> = [
  ["device", "device"],
  ["mask", "mask"],
  ["lotId", "lot"],
  ["hostname", "testerId"],
  ["platform", "platform"],
  ["probeCardType", "probeCardType"],
  ["probeCard", "cardId"],
  ["pass", "passId"],
];

/**
 * 把 YM period-alarm-trend 已解析的 `applied` 筛选转成 JB STAR 查询参数，供
 * `parseInfcontrolLayerBinsV3Query` 使用；`spanFromIso`/`spanToIso` 是本次请求全部
 * 分桶的整体时间跨度（与 YM 端点用同一个 span），映射到 JB 的 `testEndFrom`/`testEndTo`。
 *
 * YM 的 `wafer` 是自由文本字符串列，JB 的 `slot` 是数值列；只有能解析成有限数字时才
 * 透传为 `slot`，否则丢弃该筛选（而不是让整个 JB 查询报错）。
 */
export function mapYmAppliedToInfcontrolPeriodQuery(
  ymApplied: Record<string, unknown>,
  spanFromIso: string,
  spanToIso: string
): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  for (const [ymKey, jbKey] of YM_TO_JB_DIRECT_FIELD_MAP) {
    if (ymApplied[ymKey] !== undefined) q[jbKey] = ymApplied[ymKey];
  }
  if (ymApplied.wafer !== undefined) {
    const n = Number(ymApplied.wafer);
    if (Number.isFinite(n)) q.slot = n;
  }
  q.testEndFrom = spanFromIso;
  q.testEndTo = spanToIso;
  return q;
}

/**
 * 单次 Oracle 扫描：按 `t2.TESTEND` 落入哪个分桶做 `CASE`，`GROUP BY` 后 `COUNT(*)`。
 * `whereAndSql` 来自 `parseInfcontrolLayerBinsV3Query(...).whereAndSql`（`AND` 连接，不含 `WHERE`
 * 也不含 `PASSTYPE`/`LAYERNAME` 基础范围——由 `infcontrolLayerBinV3BaseWhereBlock` 统一补上）。
 */
export function buildInfcontrolPeriodCountTrendSql(
  whereAndSql: string,
  bucketCount: number
): string {
  const caseLines: string[] = [];
  for (let i = bucketCount - 1; i >= 0; i--) {
    caseLines.push(
      `      WHEN t2.TESTEND >= :b${i}_from AND t2.TESTEND <= :b${i}_to THEN ${i}`
    );
  }
  const caseExpr = `CASE\n${caseLines.join("\n")}\n      ELSE NULL\n    END`;
  const whereBlock = infcontrolLayerBinV3BaseWhereBlock("t2", whereAndSql);

  return `
SELECT
  bucket_idx,
  COUNT(*) AS TOTAL
FROM (
  SELECT
    ${caseExpr} AS bucket_idx
  FROM INFCONTROL t1
  INNER JOIN INFLAYERBINLIST t2 ON t1.KEYNUMBER = t2.KEYNUMBER
  ${whereBlock}
) sub
WHERE bucket_idx IS NOT NULL
GROUP BY bucket_idx
ORDER BY bucket_idx
`.trim();
}

/** 在 `parseInfcontrolLayerBinsV3Query` 产出的 `binds` 之上追加各桶 `b{i}_from`/`b{i}_to`。 */
export function infcontrolPeriodCountTrendBinds(
  buckets: PeriodAlarmBucket[],
  baseBinds: BindParameters
): BindParameters {
  const binds = { ...baseBinds } as Record<string, unknown>;
  buckets.forEach((b, i) => {
    binds[`b${i}_from`] = b.start;
    binds[`b${i}_to`] = b.end;
  });
  return binds as BindParameters;
}

/** 按 `bucket_idx` 取 `TOTAL`；缺失的桶（该周期无匹配行）记为 `0`，不是 `null`。 */
export function mapInfcontrolPeriodCountTrendRows(
  buckets: PeriodAlarmBucket[],
  rows: Record<string, unknown>[]
): number[] {
  const byIdx = new Map<number, number>();
  for (const row of rows) {
    const idxRaw = row.BUCKET_IDX ?? row.bucket_idx;
    const idx = idxRaw != null ? Number(idxRaw) : NaN;
    const totalRaw = row.TOTAL ?? row.total;
    const total = Number(totalRaw);
    if (Number.isFinite(idx) && Number.isFinite(total)) byIdx.set(idx, total);
  }
  return buckets.map((_, i) => byIdx.get(i) ?? 0);
}

/** Dummy 对照：复用 `filterInfcontrolLayerBinV3DummyRowsMatching` 的筛选 + 同一份时间偏移，按 `TESTEND` 分桶计数。 */
export function aggregateInfcontrolPeriodCountTrendDummy(
  applied: Record<string, unknown>,
  buckets: PeriodAlarmBucket[]
): number[] {
  const rows = filterInfcontrolLayerBinV3DummyRowsMatching(applied);
  const timeOffsetMs = infcontrolLayerBinDummyTimeOffsetMs(applied);
  const counts = buckets.map(() => 0);
  for (const row of rows) {
    const t = new Date(String(row.TESTEND)).getTime();
    if (Number.isNaN(t)) continue;
    const idx = assignPeriodBucketIndex(t, buckets, timeOffsetMs);
    if (idx === null) continue;
    counts[idx] = (counts[idx] ?? 0) + 1;
  }
  return counts;
}
```

Note: `assignPeriodBucketIndex` does not exist yet — it is the existing private `assignBucketIndex` in `yieldMonitorPeriodAlarmTrend.ts`, exported and renamed as part of Task 3. Task 2's implementation step and Task 3 must land together (Task 2's test file already imports transitively through `aggregateInfcontrolPeriodCountTrendDummy`, which needs Task 3's export to compile) — **do Task 3 immediately after this step, before running Task 2's tests**, or the build will fail with "assignPeriodBucketIndex is not exported". The step ordering below accounts for this.

- [ ] **Step 3b: Do Task 3's Step 3 now (export `assignPeriodBucketIndex`)**

Before running Task 2's tests, apply Task 3's Step 3 below (renaming/exporting `assignBucketIndex` in `yieldMonitorPeriodAlarmTrend.ts`) so this module compiles. Task 3's own tests are written and run in Task 3 proper; this is just the minimal export needed here.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pcr-ai-api && npx tsx --test test/infcontrolLayerBinPeriodCountTrend.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add pcr-ai-api/src/lib/infcontrolLayerBinPeriodCountTrend.ts pcr-ai-api/test/infcontrolLayerBinPeriodCountTrend.test.ts
git commit -m "$(cat <<'EOF'
feat(jb-star): add period-bucketed JB STAR test-count query builder

Pure functions only (SQL builder, bind builder, row mapper, Dummy
aggregator, YM-to-JB filter mapping) — not yet wired into any route.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Extend `yieldMonitorPeriodAlarmTrend.ts` with `jbTotal`/`ratio` merge

**Files:**
- Modify: `pcr-ai-api/src/lib/yieldMonitorPeriodAlarmTrend.ts`
- Modify: `pcr-ai-api/test/yieldMonitorPeriodAlarmTrend.test.ts`

**Interfaces:**
- Consumes: existing `PeriodAlarmTrendPoint` type (unchanged).
- Produces:
  - `assignPeriodBucketIndex(rowTs: number, buckets: PeriodAlarmBucket[], timeOffsetMs?: number): number | null` (renamed + exported from the existing private `assignBucketIndex`; same signature, same behavior) — consumed by Task 2's `aggregateInfcontrolPeriodCountTrendDummy`.
  - `PeriodAlarmTrendPointWithRatio` type = `PeriodAlarmTrendPoint & { jbTotal: number | null; ratio: number | null }`.
  - `attachJbRatio(points: PeriodAlarmTrendPoint[], jbTotals: (number | null)[]): PeriodAlarmTrendPointWithRatio[]` — consumed by Task 4's route handler.

- [ ] **Step 1: Write the failing tests**

Append to `pcr-ai-api/test/yieldMonitorPeriodAlarmTrend.test.ts` (inside the existing `describe("yieldMonitorPeriodAlarmTrend", ...)` block, before the closing `});`):

```ts
  test("assignPeriodBucketIndex is exported and matches internal bucket assignment", () => {
    const buckets = recentPeriodBuckets("week", 2, NOW);
    const midOfLastBucket = buckets[1]!.start.getTime() + 1000;
    assert.equal(assignPeriodBucketIndex(midOfLastBucket, buckets), 1);
    assert.equal(assignPeriodBucketIndex(buckets[0]!.start.getTime() - 999999, buckets), null);
  });

  test("attachJbRatio computes total/jbTotal per bucket", () => {
    const points = [
      { label: "a", timeStampFrom: "", timeStampTo: "", total: 10, testerCount: 0, cardCount: 0, binCount: 0, dutCount: 0 },
      { label: "b", timeStampFrom: "", timeStampTo: "", total: 5, testerCount: 0, cardCount: 0, binCount: 0, dutCount: 0 },
    ];
    const result = attachJbRatio(points, [20, 0]);
    assert.equal(result[0]!.jbTotal, 20);
    assert.equal(result[0]!.ratio, 0.5);
    assert.equal(result[1]!.jbTotal, 0);
    assert.equal(result[1]!.ratio, null);
  });

  test("attachJbRatio treats missing/null jbTotals entry as null (query failure)", () => {
    const points = [
      { label: "a", timeStampFrom: "", timeStampTo: "", total: 10, testerCount: 0, cardCount: 0, binCount: 0, dutCount: 0 },
    ];
    const result = attachJbRatio(points, [null]);
    assert.equal(result[0]!.jbTotal, null);
    assert.equal(result[0]!.ratio, null);
  });

  test("attachJbRatio allows ratio to exceed 1 (uncapped)", () => {
    const points = [
      { label: "a", timeStampFrom: "", timeStampTo: "", total: 30, testerCount: 0, cardCount: 0, binCount: 0, dutCount: 0 },
    ];
    const result = attachJbRatio(points, [10]);
    assert.equal(result[0]!.ratio, 3);
  });
```

Add `assignPeriodBucketIndex` and `attachJbRatio` to the existing top-of-file import from `../src/lib/yieldMonitorPeriodAlarmTrend.js`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pcr-ai-api && npx tsx --test test/yieldMonitorPeriodAlarmTrend.test.ts`
Expected: FAIL — `assignPeriodBucketIndex` and `attachJbRatio` are not exported.

- [ ] **Step 3: Rename+export `assignBucketIndex`, add `attachJbRatio`**

In `pcr-ai-api/src/lib/yieldMonitorPeriodAlarmTrend.ts`, change:

```ts
function assignBucketIndex(
  rowTs: number,
  buckets: PeriodAlarmBucket[],
  timeOffsetMs = 0
): number | null {
```

to:

```ts
export function assignPeriodBucketIndex(
  rowTs: number,
  buckets: PeriodAlarmBucket[],
  timeOffsetMs = 0
): number | null {
```

and update its one call site in `aggregateBucketMetrics`'s caller (`aggregatePeriodAlarmTrendDummy`, which calls `assignBucketIndex(t, buckets, timeOffsetMs)`) to `assignPeriodBucketIndex(t, buckets, timeOffsetMs)`.

Then append at the end of the file (after `PERIOD_ALARM_TREND_DOCUMENTATION`):

```ts
export type PeriodAlarmTrendPointWithRatio = PeriodAlarmTrendPoint & {
  /** 该周期 JB STAR（INFCONTROL⋈INFLAYERBINLIST）匹配到的测试记录数；JB 查询失败为 null。 */
  jbTotal: number | null;
  /** total / jbTotal；jbTotal 为 0 或 null 时为 null。可以超过 1（同一次测试可能触发多条 delta_diff 记录）。 */
  ratio: number | null;
};

/** 把 JB STAR 每桶总数并入 YM 每桶结果，算出 ratio。`jbTotals[i]` 与 `points[i]` 按下标对应，长度必须一致。 */
export function attachJbRatio(
  points: PeriodAlarmTrendPoint[],
  jbTotals: (number | null)[]
): PeriodAlarmTrendPointWithRatio[] {
  return points.map((p, i) => {
    const jbTotal = jbTotals[i] ?? null;
    const ratio = jbTotal !== null && jbTotal > 0 ? p.total / jbTotal : null;
    return { ...p, jbTotal, ratio };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pcr-ai-api && npx tsx --test test/yieldMonitorPeriodAlarmTrend.test.ts`
Expected: PASS (all tests including the 4 new ones)

- [ ] **Step 5: Run Task 2's tests now that `assignPeriodBucketIndex` exists**

Run: `cd pcr-ai-api && npx tsx --test test/infcontrolLayerBinPeriodCountTrend.test.ts`
Expected: PASS (this confirms the Task 2/3 ordering dependency noted in Task 2 Step 3b is resolved)

- [ ] **Step 6: Run the full suite**

Run: `cd pcr-ai-api && npm test`
Expected: all tests PASS

- [ ] **Step 7: Commit**

```bash
git add pcr-ai-api/src/lib/yieldMonitorPeriodAlarmTrend.ts pcr-ai-api/test/yieldMonitorPeriodAlarmTrend.test.ts
git commit -m "$(cat <<'EOF'
feat(yield-monitor): add attachJbRatio merge helper for period-alarm-trend

Exports assignBucketIndex as assignPeriodBucketIndex for reuse by the
JB STAR period-count-trend Dummy aggregator (Task 2). attachJbRatio
computes YM-total/JB-total per bucket, uncapped, null on zero/failed
denominator.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Wire JB STAR query into the `period-alarm-trend` route handler

**Files:**
- Modify: `pcr-ai-api/src/routes/yieldMonitorRoutes.ts:1-56` (imports) and `:556-615` (handler)
- Test: `pcr-ai-api/test/rest-api-v3-dummy.test.ts`

**Interfaces:**
- Consumes: `withConnection` from `../oracle.js`; `infcontrolLayerBinsUseDummy` from `../lib/infcontrolLayerBinDummy.js`; `parseInfcontrolLayerBinsV3Query` from `../lib/infcontrolLayerBinFilters.js`; all of Task 2's and Task 3's new exports.
- Produces: `GET …/v3/period-alarm-trend` response `buckets[]` items now include `jbTotal`, `ratio`; response may include a top-level `jbTotalError: string` when the JB STAR side failed.

- [ ] **Step 1: Write the failing test**

Add to `pcr-ai-api/test/rest-api-v3-dummy.test.ts`, right before the `test("未知路径 → 404 NOT_FOUND", ...)` block near the end (inside the same `describe`):

```ts
    test("GET /api/v3/yield-monitor-triggers/v3/period-alarm-trend includes jbTotal/ratio per bucket（dummy）", async () => {
      const { status, body } = await getJson(
        `${API}/yield-monitor-triggers/v3/period-alarm-trend?period=month`
      );
      assertOkJson(status, body);
      const buckets = (body as { buckets?: Record<string, unknown>[] }).buckets ?? [];
      assert.equal(buckets.length, 4);
      for (const b of buckets) {
        assert.ok("jbTotal" in b, "bucket missing jbTotal");
        assert.ok("ratio" in b, "bucket missing ratio");
        const jbTotal = b.jbTotal as number | null;
        const ratio = b.ratio as number | null;
        if (jbTotal === null || jbTotal === 0) {
          assert.equal(ratio, null);
        } else {
          assert.equal(ratio, (b.total as number) / jbTotal);
        }
      }
    });

    test("GET /api/v3/yield-monitor-triggers/v3/period-alarm-trend with device filter narrows both YM and jbTotal consistently（dummy）", async () => {
      const wideRes = await getJson(
        `${API}/yield-monitor-triggers/v3/period-alarm-trend?period=month`
      );
      assertOkJson(wideRes.status, wideRes.body);
      const wideBuckets = (wideRes.body as { buckets?: Record<string, unknown>[] }).buckets ?? [];
      const sampleDevice = wideBuckets
        .map((b) => b)
        .find(() => true);
      assert.ok(sampleDevice, "expected at least one bucket in the wide-open response");

      const icDummy = await import("../src/lib/infcontrolLayerBinDummy.js");
      const jbRows = icDummy.getInfcontrolLayerBinDummyRows();
      assert.ok(jbRows.length > 0);
      const device = String(jbRows[0]!.DEVICE);

      const narrowRes = await getJson(
        `${API}/yield-monitor-triggers/v3/period-alarm-trend?period=month&device=${encodeURIComponent(device)}`
      );
      assertOkJson(narrowRes.status, narrowRes.body);
      const narrowBuckets =
        (narrowRes.body as { buckets?: Record<string, unknown>[] }).buckets ?? [];
      const narrowJbSum = narrowBuckets.reduce(
        (sum, b) => sum + (Number(b.jbTotal) || 0),
        0
      );
      const wideJbSum = wideBuckets.reduce(
        (sum, b) => sum + (Number(b.jbTotal) || 0),
        0
      );
      assert.ok(narrowJbSum <= wideJbSum);
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pcr-ai-api && npx tsx --test test/rest-api-v3-dummy.test.ts`
Expected: FAIL — response buckets do not contain `jbTotal`/`ratio` keys.

- [ ] **Step 3: Wire up the route handler**

In `pcr-ai-api/src/routes/yieldMonitorRoutes.ts`, update the import block (currently lines 46-55):

```ts
import { withProbeWebConnection } from "../oracle.js";
import { addDutNumberToYieldMonitorV3Row } from "../lib/yieldTriggerLabelDut.js";
import {
  PERIOD_ALARM_TREND_DOCUMENTATION,
  aggregatePeriodAlarmTrendDummy,
  buildPeriodAlarmTrendSql,
  mapPeriodAlarmTrendRows,
  parsePeriodAlarmTrendQuery,
  periodAlarmTrendBinds,
} from "../lib/yieldMonitorPeriodAlarmTrend.js";
```

to:

```ts
import { withConnection, withProbeWebConnection } from "../oracle.js";
import { addDutNumberToYieldMonitorV3Row } from "../lib/yieldTriggerLabelDut.js";
import {
  PERIOD_ALARM_TREND_DOCUMENTATION,
  aggregatePeriodAlarmTrendDummy,
  attachJbRatio,
  buildPeriodAlarmTrendSql,
  mapPeriodAlarmTrendRows,
  parsePeriodAlarmTrendQuery,
  periodAlarmTrendBinds,
  type PeriodAlarmTrendPoint,
} from "../lib/yieldMonitorPeriodAlarmTrend.js";
import { parseInfcontrolLayerBinsV3Query } from "../lib/infcontrolLayerBinFilters.js";
import { infcontrolLayerBinsUseDummy } from "../lib/infcontrolLayerBinDummy.js";
import {
  aggregateInfcontrolPeriodCountTrendDummy,
  buildInfcontrolPeriodCountTrendSql,
  infcontrolPeriodCountTrendBinds,
  mapInfcontrolPeriodCountTrendRows,
  mapYmAppliedToInfcontrolPeriodQuery,
} from "../lib/infcontrolLayerBinPeriodCountTrend.js";
```

Replace the whole handler (currently `yieldMonitorRoutes.ts:556-615`):

```ts
yieldMonitorRouter.get("/yield-monitor-triggers/v3/period-alarm-trend", async (req, res) => {
  const parsed = parsePeriodAlarmTrendQuery(req.query as Record<string, unknown>);
  if (!parsed.ok) {
    return sendAgentError(
      res,
      400,
      "VALIDATION_ERROR",
      parsed.error,
      "See GET /api/v1/manifest yield-monitor-triggers/v3/period-alarm-trend."
    );
  }

  const spanFromIso = parsed.buckets[0]!.start.toISOString();
  const spanToIso = parsed.buckets[parsed.buckets.length - 1]!.end.toISOString();
  const jbQuery = mapYmAppliedToInfcontrolPeriodQuery(
    parsed.applied,
    spanFromIso,
    spanToIso
  );
  const jbParsed = parseInfcontrolLayerBinsV3Query(jbQuery);

  async function computeJbTotals(): Promise<{
    jbTotals: (number | null)[];
    jbTotalError?: string;
  }> {
    if (!jbParsed.ok) {
      return {
        jbTotals: parsed.buckets.map(() => null),
        jbTotalError: jbParsed.error,
      };
    }
    try {
      if (infcontrolLayerBinsUseDummy()) {
        return {
          jbTotals: aggregateInfcontrolPeriodCountTrendDummy(
            jbParsed.applied,
            parsed.buckets
          ),
        };
      }
      const sql = buildInfcontrolPeriodCountTrendSql(
        jbParsed.whereAndSql,
        parsed.buckets.length
      );
      const binds = infcontrolPeriodCountTrendBinds(parsed.buckets, jbParsed.binds);
      const rows = await withConnection(async (conn) => {
        const result = await conn.execute(sql, binds, {
          outFormat: oracledb.OUT_FORMAT_OBJECT,
        });
        return (result.rows || []) as Record<string, unknown>[];
      });
      return { jbTotals: mapInfcontrolPeriodCountTrendRows(parsed.buckets, rows) };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { jbTotals: parsed.buckets.map(() => null), jbTotalError: message };
    }
  }

  function respond(
    ymPoints: PeriodAlarmTrendPoint[],
    jb: { jbTotals: (number | null)[]; jbTotalError?: string }
  ) {
    const buckets = attachJbRatio(ymPoints, jb.jbTotals);
    return res.json({
      meta: {
        apiVersion: "3",
        requestId: reqId(req),
        path: "yield-monitor-triggers/v3/period-alarm-trend",
      },
      documentation: PERIOD_ALARM_TREND_DOCUMENTATION,
      period: parsed.period,
      filters: parsed.applied,
      buckets,
      ...(jb.jbTotalError ? { jbTotalError: jb.jbTotalError } : {}),
    });
  }

  if (yieldMonitorTriggersUseDummy()) {
    const ymPoints = aggregatePeriodAlarmTrendDummy(parsed.applied, parsed.buckets);
    const jb = await computeJbTotals();
    return respond(ymPoints, jb);
  }

  const sql = buildPeriodAlarmTrendSql(parsed.whereSql, parsed.buckets.length);
  const binds = periodAlarmTrendBinds(parsed);

  try {
    const rows = await withProbeWebConnection(async (conn) => {
      const result = await conn.execute(sql, binds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });
      return (result.rows || []) as Record<string, unknown>[];
    });
    const ymPoints = mapPeriodAlarmTrendRows(parsed.buckets, rows);
    const jb = await computeJbTotals();
    return respond(ymPoints, jb);
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

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pcr-ai-api && npx tsx --test test/rest-api-v3-dummy.test.ts`
Expected: PASS (all tests including the 2 new ones)

- [ ] **Step 5: Typecheck and full suite**

Run: `cd pcr-ai-api && npm run typecheck && npm test`
Expected: both PASS

- [ ] **Step 6: Commit**

```bash
git add pcr-ai-api/src/routes/yieldMonitorRoutes.ts pcr-ai-api/test/rest-api-v3-dummy.test.ts
git commit -m "$(cat <<'EOF'
feat(yield-monitor): add jbTotal/ratio to period-alarm-trend response

Runs a second query (main pool, JB STAR PASSTYPE scope) alongside the
existing probeweb YM query, mapping the same appliedForm filters by
field name. JB STAR query failure degrades gracefully — YM data still
returns, all buckets get jbTotal/ratio: null plus a jbTotalError note.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Frontend type + new standalone "触发密度" chart in `YieldMonitorReport.tsx`

**Files:**
- Modify: `pcr-ai-report/src/api/types.ts:65-83`
- Modify: `pcr-ai-report/src/reports/YieldMonitorReport.tsx`

**Interfaces:**
- Consumes: existing `buildTrendBarOption`, `selectionTierColors`, `YIELD_TREND_CHART_HEIGHT`, `DraggableReportBlocks`.
- Produces: `PeriodAlarmTrendBucket` now includes `jbTotal: number | null; ratio: number | null;`; chart block id `chAlarmRatioTrend` rendered in the existing `pcr-ai-report:yield-monitor-alarm-trend-chart-blocks` grid.

- [ ] **Step 1: Edit the response type**

In `pcr-ai-report/src/api/types.ts`, change:

```ts
/** `GET …/yield-monitor-triggers/v3/period-alarm-trend` */
export type PeriodAlarmTrendBucket = {
  label: string;
  timeStampFrom: string;
  timeStampTo: string;
  total: number;
  testerCount: number;
  cardCount: number;
  binCount: number;
  dutCount: number;
};
```

to:

```ts
/** `GET …/yield-monitor-triggers/v3/period-alarm-trend` */
export type PeriodAlarmTrendBucket = {
  label: string;
  timeStampFrom: string;
  timeStampTo: string;
  total: number;
  testerCount: number;
  cardCount: number;
  binCount: number;
  dutCount: number;
  /** JB STAR（INFCONTROL⋈INFLAYERBINLIST）该周期匹配到的测试记录数；JB 查询失败为 null。 */
  jbTotal: number | null;
  /** total / jbTotal；jbTotal 为 0 或 null 时为 null。可以超过 1（100%）。 */
  ratio: number | null;
};
```

Also add `jbTotalError?: string;` to `YieldMonitorPeriodAlarmTrendResponse` (the type right below, currently lines 77-83):

```ts
export type YieldMonitorPeriodAlarmTrendResponse = {
  meta?: ApiMeta;
  period: "week" | "month";
  filters: Record<string, unknown>;
  buckets: PeriodAlarmTrendBucket[];
  documentation?: string;
  jbTotalError?: string;
};
```

- [ ] **Step 2: Extend `TrendPoint` type**

Change (currently `YieldMonitorReport.tsx:236-241`):

```ts
type TrendPoint = {
  bucket: PeriodBucket;
  total: number | null;
  testerCount: number | null;
  cardCount: number | null;
};
```

to:

```ts
type TrendPoint = {
  bucket: PeriodBucket;
  total: number | null;
  testerCount: number | null;
  cardCount: number | null;
  jbTotal: number | null;
  ratio: number | null;
};
```

- [ ] **Step 3: Fill `ratio`/`jbTotal` at both `TrendPoint` construction sites**

In `loadLegacyFallback` (currently around `YieldMonitorReport.tsx:970-982`), change:

```ts
      return buckets.map((bucket, i) => {
        const [testerRes, cardRes] = settled.slice(i * 2, i * 2 + 2);
        const ok = (r: PromiseSettledResult<YieldMonitorV3AggregateResponse>) =>
          r.status === "fulfilled" ? r.value : null;
        const tester = ok(testerRes);
        const card = ok(cardRes);
        return {
          bucket,
          total: tester?.totalRowsMatching ?? card?.totalRowsMatching ?? null,
          testerCount: tester ? tester.groups.length : null,
          cardCount: card ? card.groups.length : null,
        };
      });
```

to:

```ts
      return buckets.map((bucket, i) => {
        const [testerRes, cardRes] = settled.slice(i * 2, i * 2 + 2);
        const ok = (r: PromiseSettledResult<YieldMonitorV3AggregateResponse>) =>
          r.status === "fulfilled" ? r.value : null;
        const tester = ok(testerRes);
        const card = ok(cardRes);
        return {
          bucket,
          total: tester?.totalRowsMatching ?? card?.totalRowsMatching ?? null,
          testerCount: tester ? tester.groups.length : null,
          cardCount: card ? card.groups.length : null,
          jbTotal: null,
          ratio: null,
        };
      });
```

(The legacy fallback path has no JB STAR data source, so it always reports `null` — the new chart shows no bars in that fallback state, which only occurs when the new API hasn't been deployed yet.)

In the main effect's success branch (currently around `YieldMonitorReport.tsx:993-1004`), change:

```ts
        setTrendPoints(
          res.buckets.map((b) => ({
            bucket: {
              start: new Date(b.timeStampFrom),
              end: new Date(b.timeStampTo),
              label: b.label,
            },
            total: b.total,
            testerCount: b.testerCount,
            cardCount: b.cardCount,
          }))
        );
```

to:

```ts
        setTrendPoints(
          res.buckets.map((b) => ({
            bucket: {
              start: new Date(b.timeStampFrom),
              end: new Date(b.timeStampTo),
              label: b.label,
            },
            total: b.total,
            testerCount: b.testerCount,
            cardCount: b.cardCount,
            jbTotal: b.jbTotal,
            ratio: b.ratio,
          }))
        );
```

- [ ] **Step 4: Typecheck (should now pass)**

Run: `cd pcr-ai-report && npm run build`
Expected: PASS (this confirms Step 1's type change is now fully consumed).

- [ ] **Step 5: Add the ratio chart option and label**

After the existing block (currently `YieldMonitorReport.tsx:1230-1256`, ending with `trendCardOption`), add:

```ts
  const periodAlarmRatioTrendLabel =
    period === "week" ? "每周触发密度" : "每月触发密度";

  const trendRatioOption = useMemo((): EChartsOption => {
    const base = buildTrendBarOption(
      theme,
      trendBuckets,
      trendPoints.map((p) => (p.ratio === null ? null : p.ratio * 100)),
      selectionTierColors(theme, "purple").base
    );
    return {
      ...base,
      tooltip: {
        trigger: "axis",
        formatter: (params: any) => {
          const arr = Array.isArray(params) ? params : [params];
          const first = arr[0] as { dataIndex?: number; axisValue?: string } | undefined;
          const idx = first?.dataIndex ?? -1;
          const p = trendPoints[idx];
          if (!p) return "";
          const ratioText = p.ratio === null ? "—" : `${(p.ratio * 100).toFixed(1)}%`;
          const jbText = p.jbTotal === null ? "无数据" : `${p.jbTotal}`;
          return [
            first?.axisValue ?? p.bucket.label,
            `YM 触发次数: ${p.total ?? "—"}`,
            `JB STAR 测试数: ${jbText}`,
            `触发密度: ${ratioText}`,
          ].join("<br/>");
        },
      },
    };
  }, [trendBuckets, trendPoints, theme]);
```

- [ ] **Step 6: Add the block to the chart-blocks grid**

Change (currently `YieldMonitorReport.tsx:194-198`):

```ts
const YIELD_ALARM_TREND_CHART_BLOCK_ORDER = [
  "chAlarmTotalTrend",
  "chAlarmTesterTrend",
  "chAlarmCardTrend",
```

to:

```ts
const YIELD_ALARM_TREND_CHART_BLOCK_ORDER = [
  "chAlarmTotalTrend",
  "chAlarmTesterTrend",
  "chAlarmCardTrend",
  "chAlarmRatioTrend",
```

(Confirm the array's closing `];` right after — do not duplicate it.)

Change the `DraggableReportBlocks` `labels` and `sections` props (currently `YieldMonitorReport.tsx:1613-1646`):

```ts
          labels={{
            chAlarmTotalTrend: periodAlarmTotalTrendLabel,
            chAlarmTesterTrend: periodAlarmTesterTrendLabel,
            chAlarmCardTrend: periodAlarmCardTrendLabel,
          }}
          sections={{
            chAlarmTotalTrend: (
              <div className="report-chart-panel chart-no-drill">
                {loadingTrend ? (
                  <div style={{ color: "var(--muted)", fontSize: 13, padding: "8px 0" }}>加载中…</div>
                ) : (
                  <DarkChart option={trendTotalOption} height={YIELD_TREND_CHART_HEIGHT} />
                )}
              </div>
            ),
            chAlarmTesterTrend: (
              <div className="report-chart-panel chart-no-drill">
                {loadingTrend ? (
                  <div style={{ color: "var(--muted)", fontSize: 13, padding: "8px 0" }}>加载中…</div>
                ) : (
                  <DarkChart option={trendTesterOption} height={YIELD_TREND_CHART_HEIGHT} />
                )}
              </div>
            ),
            chAlarmCardTrend: (
              <div className="report-chart-panel chart-no-drill">
                {loadingTrend ? (
                  <div style={{ color: "var(--muted)", fontSize: 13, padding: "8px 0" }}>加载中…</div>
                ) : (
                  <DarkChart option={trendCardOption} height={YIELD_TREND_CHART_HEIGHT} />
                )}
              </div>
            ),
          }}
```

to:

```ts
          labels={{
            chAlarmTotalTrend: periodAlarmTotalTrendLabel,
            chAlarmTesterTrend: periodAlarmTesterTrendLabel,
            chAlarmCardTrend: periodAlarmCardTrendLabel,
            chAlarmRatioTrend: periodAlarmRatioTrendLabel,
          }}
          sections={{
            chAlarmTotalTrend: (
              <div className="report-chart-panel chart-no-drill">
                {loadingTrend ? (
                  <div style={{ color: "var(--muted)", fontSize: 13, padding: "8px 0" }}>加载中…</div>
                ) : (
                  <DarkChart option={trendTotalOption} height={YIELD_TREND_CHART_HEIGHT} />
                )}
              </div>
            ),
            chAlarmTesterTrend: (
              <div className="report-chart-panel chart-no-drill">
                {loadingTrend ? (
                  <div style={{ color: "var(--muted)", fontSize: 13, padding: "8px 0" }}>加载中…</div>
                ) : (
                  <DarkChart option={trendTesterOption} height={YIELD_TREND_CHART_HEIGHT} />
                )}
              </div>
            ),
            chAlarmCardTrend: (
              <div className="report-chart-panel chart-no-drill">
                {loadingTrend ? (
                  <div style={{ color: "var(--muted)", fontSize: 13, padding: "8px 0" }}>加载中…</div>
                ) : (
                  <DarkChart option={trendCardOption} height={YIELD_TREND_CHART_HEIGHT} />
                )}
              </div>
            ),
            chAlarmRatioTrend: (
              <div className="report-chart-panel chart-no-drill">
                {loadingTrend ? (
                  <div style={{ color: "var(--muted)", fontSize: 13, padding: "8px 0" }}>加载中…</div>
                ) : (
                  <DarkChart option={trendRatioOption} height={YIELD_TREND_CHART_HEIGHT} />
                )}
              </div>
            ),
          }}
```

- [ ] **Step 7: Typecheck and build**

Run: `cd pcr-ai-report && npm run typecheck && npm run build`
Expected: both PASS. If `formatter: (params: any) => ...` trips `@typescript-eslint/no-explicit-any` under `npm run lint`, that's expected to be flagged by lint but not by `tsc` — run `npm run lint` too and if it errors, change the annotation to the project's existing pattern of typing echarts event callback params as `unknown` and narrowing inside (see `YieldMonitorReport.tsx:1752` for the existing `(params: unknown) =>` style used elsewhere in this file), adjusting the body's property access accordingly (`(params as any[])[0]` cast at the point of use instead of an untyped parameter).

- [ ] **Step 8: Manual verification (Dummy mode)**

Run: `cd pcr-ai-api && YIELD_MONITOR_TRIGGERS_DUMMY=true INFCONTROL_LAYER_BINS_DUMMY=true npm run dev`
Run in a second terminal: `cd pcr-ai-report && npm run dev`

In the browser: open the report, go to the Yield Monitor tab, run a query (any filters, or none), scroll to "周期报警趋势". Confirm:
- A 4th chart titled "每周触发密度" (or "每月触发密度" after switching the period chip) appears next to the existing 3 trend charts.
- Hovering a bar shows a tooltip with YM 触发次数 / JB STAR 测试数 / 触发密度 %.
- If any bar's tooltip shows a percentage over 100%, that is expected (uncapped ratio) — confirm the chart does not clip or error on it.
- Switching "周 | 月" chip updates this chart along with the other three.

- [ ] **Step 9: Commit**

```bash
git add pcr-ai-report/src/api/types.ts pcr-ai-report/src/reports/YieldMonitorReport.tsx
git commit -m "$(cat <<'EOF'
feat(yield-monitor): add standalone YM alarm density trend chart

PeriodAlarmTrendBucket gains jbTotal/ratio; new chAlarmRatioTrend block
in the existing alarm-trend chart grid shows YM triggers / JB STAR
tests per week or month as an uncapped percentage, with a tooltip
breaking out the raw counts.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Final verification pass

**Files:** none (verification only)

- [ ] **Step 1: Backend full suite**

Run: `cd pcr-ai-api && npm run typecheck && npm test`
Expected: both PASS, no regressions across the whole suite (not just the files touched in this plan).

- [ ] **Step 2: Frontend build**

Run: `cd pcr-ai-report && npm run build && npm run lint`
Expected: both PASS.

- [ ] **Step 3: Confirm dummy-parity checklist from the spec**

Re-read `docs/superpowers/specs/2026-07-08-yield-monitor-alarm-density-trend-design.md`'s "Dummy-Oracle Parity 检查清单" section and confirm each item against the code written in Tasks 1-4:
- `buildInfcontrolPeriodCountTrendSql` (Oracle) and `aggregateInfcontrolPeriodCountTrendDummy` (Dummy) both reuse `infcontrolLayerBinV3BaseWhereBlock`/`filterInfcontrolLayerBinV3DummyRowsMatching` respectively for the PASSTYPE/LAYERNAME/LOT-prefix scope — verified by construction (Task 2), not just by inspection.
- Filter field mapping (`mapYmAppliedToInfcontrolPeriodQuery`) is the single source of truth used by both Dummy and Oracle branches in the route handler (Task 4) — same function, no duplicated mapping logic.

- [ ] **Step 4: No commit needed** — this task is verification-only. If any step fails, fix in the relevant earlier task's files and re-run this task.
