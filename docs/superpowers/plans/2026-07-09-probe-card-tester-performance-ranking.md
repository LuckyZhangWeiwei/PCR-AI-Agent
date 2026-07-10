# Probe Card / Tester Performance Ranking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new AI Agent tool `aggregate_probe_card_tester_performance` that, given a `device`, ranks probe-card+tester combinations and probe cards by JB STAR yield, with confidence tiers, monthly yield trend, and bad-bin frequency tables — per `docs/superpowers/specs/2026-07-09-probe-card-tester-performance-ranking-design.md` (revised 2026-07-10, committed `f009918`).

**Architecture:** A new pure-function module (`probeCardTesterPerformance.ts`) groups already-enriched JB STAR rows by `(cardId, testerId, passId)` and by `cardId`, computing avgYield/stdDevYield/recordCount/lotCount/confidenceTier/assessment/monthly-trend/bad-bin-frequency and building markdown tables. It has **no Oracle/Dummy awareness** — the agent tool handler in `agentToolHandlers.ts` fetches the row set (Oracle: COUNT-then-fetch-full-matching-rows; Dummy: in-memory filter), enriches each row with the existing `enrichJbRow`, and hands the enriched array to the pure function. This mirrors the exact pattern `toolAggregateJbBins`/the v4 in-memory aggregate routes already use, so Dummy/Oracle parity is structural (one grouping function, two row sources) rather than something that needs re-verifying per feature.

**Tech Stack:** Node.js + TypeScript (`pcr-ai-api`), `oracledb@5.5.0`, `node:test` + `node:assert/strict` for tests, no new npm dependencies.

## Global Constraints

- **Dummy-Oracle parity hard rule**: any filter/grouping/response-shape logic must behave identically on both paths (`CLAUDE.md` root rule #1). Satisfied here by routing both paths through the single `computeProbeCardTesterPerformance` function.
- **No new npm dependencies.**
- **Never reimplement good-bin/bad-die logic.** Per-row yield MUST be computed via `enrichJbRow` (local to `agentToolHandlers.ts`, wraps `enrichInfcontrolLayerBinRowV2` from `passBinSemantics.ts`) + `badDieFromJbRow` / `goodBinIndicesForJbRow` from `pcr-ai-api/src/lib/jbYieldCalc.ts`. The earlier draft of this plan wrote a bespoke `badDieForRawJbRow` that dropped the `JB_HARD_GOOD_BIN = 1` hard-good-bin rule (BIN1 is always good regardless of `PASSBIN`) — that bug must not be reintroduced. Task 1 includes a regression test specifically for this.
- **Never merge/average across `passId` 1/3/5.** When `passId` is not given, output three independent groups (pass1/pass3/pass5); never combine.
- **Row-count protection**: reuse `readMemoryAggregateOracleMaxRows()` (`pcr-ai-api/src/lib/memoryAggregateOracleLimits.ts`) — COUNT matching rows first (Oracle) / check filtered row count (Dummy); if it exceeds the limit, return a text error telling the user to narrow `passId` or the time window, instead of loading everything into memory.
- **`node:test` + `node:assert/strict`** for all new tests, `.js`-suffixed relative imports (ESM/NodeNext), matching every existing test file in `pcr-ai-api/test/`.
- **`npm run typecheck` and `npm test` must pass** before each commit.
- **`device` is a required tool argument** — no cross-device ranking (per spec §2, §7).

---

### Task 1: Stats helpers + per-row yield

**Files:**
- Create: `pcr-ai-api/src/lib/probeCardTesterPerformance.ts`
- Test: `pcr-ai-api/test/probeCardTesterPerformance.test.ts`

**Interfaces:**
- Consumes: `badDieFromJbRow`, `goodBinIndicesForJbRow` from `pcr-ai-api/src/lib/jbYieldCalc.ts` (existing, unmodified).
- Produces (for Task 2 to consume, same file):
  - `export function mean(values: number[]): number`
  - `export function sampleStdDev(values: number[]): number`
  - `export function median(values: number[]): number`
  - `export function rowYieldPct(row: Record<string, unknown>): number | null`

- [ ] **Step 1: Write the failing tests**

Create `pcr-ai-api/test/probeCardTesterPerformance.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  mean,
  median,
  rowYieldPct,
  sampleStdDev,
} from "../src/lib/probeCardTesterPerformance.js";

describe("probeCardTesterPerformance: stats helpers", () => {
  test("mean of a simple array", () => {
    assert.equal(mean([1, 2, 3]), 2);
    assert.equal(mean([10]), 10);
  });

  test("sampleStdDev uses n-1 denominator, 0 for <2 values", () => {
    assert.equal(sampleStdDev([]), 0);
    assert.equal(sampleStdDev([5]), 0);
    // population {2,4,4,4,5,5,7,9}, sample stddev = 2.13809...
    const v = sampleStdDev([2, 4, 4, 4, 5, 5, 7, 9]);
    assert.ok(Math.abs(v - 2.138089935) < 1e-6, `got ${v}`);
  });

  test("median for odd and even length arrays", () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([1, 2, 3, 4]), 2.5);
    assert.equal(median([7]), 7);
  });
});

describe("probeCardTesterPerformance: rowYieldPct", () => {
  test("computes yield from GROSSDIE and a bad bin", () => {
    const row = {
      GROSSDIE: 100,
      PASSBIN: undefined,
      bins: [{ n: 5, value: 10, isGoodBin: false }],
    };
    assert.equal(rowYieldPct(row), 90);
  });

  test("returns null when GROSSDIE is missing or zero", () => {
    assert.equal(rowYieldPct({ bins: [] }), null);
    assert.equal(rowYieldPct({ GROSSDIE: 0, bins: [] }), null);
  });

  test("BIN1 is always a good bin even if bins[] marks it bad (regression: old draft missed this)", () => {
    const row = {
      GROSSDIE: 100,
      PASSBIN: undefined,
      // BIN1 present with isGoodBin:false — a naive PASSBIN-only parser would
      // count it as bad die. badDieFromJbRow must still treat n=1 as good via
      // JB_HARD_GOOD_BIN, so yield must be 100, not 100 - 20/100*100 = 80.
      bins: [{ n: 1, value: 20, isGoodBin: false }],
    };
    assert.equal(rowYieldPct(row), 100);
  });

  test("PASSBIN hyphen-token good bins are excluded from bad die", () => {
    const row = {
      GROSSDIE: 100,
      PASSBIN: "3-9",
      bins: [
        { n: 3, value: 5, isGoodBin: false },
        { n: 9, value: 5, isGoodBin: false },
        { n: 12, value: 10, isGoodBin: false },
      ],
    };
    // bins 3 and 9 are good (PASSBIN token), only bin 12's 10 die are bad
    assert.equal(rowYieldPct(row), 90);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd pcr-ai-api && npx tsx --test test/probeCardTesterPerformance.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/probeCardTesterPerformance.js'`

- [ ] **Step 3: Write the implementation**

Create `pcr-ai-api/src/lib/probeCardTesterPerformance.ts`:

```ts
import { badDieFromJbRow } from "./jbYieldCalc.js";

// ─── stats helpers ──────────────────────────────────────────────────────────

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/** Sample standard deviation (n-1 denominator). 0 when fewer than 2 values. */
export function sampleStdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const sumSq = values.reduce((s, v) => s + (v - m) * (v - m), 0);
  return Math.sqrt(sumSq / (values.length - 1));
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

// ─── per-row yield ──────────────────────────────────────────────────────────

function grossDieOf(row: Record<string, unknown>): number {
  const g = Number((row as Record<string, unknown>)["GROSSDIE"] ?? (row as Record<string, unknown>)["grossDie"] ?? 0);
  return Number.isFinite(g) && g > 0 ? g : 0;
}

/**
 * Per-row yield percentage (0-100). `row` must already be enriched (has
 * `row.bins[]`, see `enrichJbRow` / `enrichInfcontrolLayerBinRowV2`). Reuses
 * `badDieFromJbRow` (BIN1-hard-good + PASSBIN hyphen tokens + bins[].isGoodBin
 * union) — do not reimplement bad-die counting here.
 * Returns null when GROSSDIE is missing/zero (row excluded from stats).
 */
export function rowYieldPct(row: Record<string, unknown>): number | null {
  const grossDie = grossDieOf(row);
  if (grossDie <= 0) return null;
  const bad = badDieFromJbRow(row);
  return (1 - bad / grossDie) * 100;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd pcr-ai-api && npx tsx --test test/probeCardTesterPerformance.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add pcr-ai-api/src/lib/probeCardTesterPerformance.ts pcr-ai-api/test/probeCardTesterPerformance.test.ts
git commit -m "feat(probe-card-perf): add stats helpers and per-row yield via badDieFromJbRow reuse"
```

---

### Task 2: Grouping, ranking, confidence tier, trend, bad-bin tables

**Files:**
- Modify: `pcr-ai-api/src/lib/probeCardTesterPerformance.ts`
- Modify (append tests): `pcr-ai-api/test/probeCardTesterPerformance.test.ts`

**Interfaces:**
- Consumes: `mean`, `sampleStdDev`, `median`, `rowYieldPct` (Task 1, same file); `goodBinIndicesForJbRow` from `pcr-ai-api/src/lib/jbYieldCalc.ts`.
- Produces (for Task 3 to consume):
  - `export type ConfidenceTier = "高" | "中" | "低"`
  - `export interface ComboRankRow { cardId: string; testerId: string; passId: number; avgYieldPct: number; stdDevYieldPct: number; recordCount: number; lotCount: number; confidenceTier: ConfidenceTier }`
  - `export interface CardRankRow { cardId: string; passId: number; avgYieldPct: number; stdDevYieldPct: number; recordCount: number; lotCount: number; confidenceTier: ConfidenceTier; assessment: string }`
  - `export interface CardTrendRow { cardId: string; month: string; avgYieldPct: number; recordCount: number }`
  - `export interface CardBadBinRow { cardId: string; topBins: { bin: number; pct: number }[] }`
  - `export interface PassGroupResult { passId: number; comboRanking: ComboRankRow[]; cardRanking: CardRankRow[]; cardTrend: CardTrendRow[]; cardBadBin: CardBadBinRow[]; comboRankingMarkdown: string; cardRankingMarkdown: string; cardTrendMarkdown: string; cardBadBinMarkdown: string }`
  - `export function computeProbeCardTesterPerformance(enrichedRows: Record<string, unknown>[]): PassGroupResult[]`

- [ ] **Step 1: Write the failing tests**

Append to `pcr-ai-api/test/probeCardTesterPerformance.test.ts`:

```ts
import { computeProbeCardTesterPerformance } from "../src/lib/probeCardTesterPerformance.js";

function jbRow(opts: {
  cardId: string;
  testerId: string;
  passId: number;
  lot: string;
  testEnd: string;
  grossDie: number;
  badBins?: { n: number; value: number }[];
}): Record<string, unknown> {
  return {
    CARDID: opts.cardId,
    TESTERID: opts.testerId,
    PASSID: opts.passId,
    LOT: opts.lot,
    TESTEND: opts.testEnd,
    GROSSDIE: opts.grossDie,
    PASSBIN: undefined,
    bins: (opts.badBins ?? []).map((b) => ({ n: b.n, value: b.value, isGoodBin: false })),
  };
}

describe("computeProbeCardTesterPerformance: grouping and ranking", () => {
  test("groups by passId, never merges 1/3/5", () => {
    const rows = [
      jbRow({ cardId: "A-01", testerId: "T1", passId: 1, lot: "L1.1A", testEnd: "2026-01-05", grossDie: 100 }),
      jbRow({ cardId: "A-01", testerId: "T1", passId: 3, lot: "L1.1A", testEnd: "2026-01-05", grossDie: 100 }),
    ];
    const groups = computeProbeCardTesterPerformance(rows);
    assert.equal(groups.length, 2);
    assert.deepEqual(groups.map((g) => g.passId).sort(), [1, 3]);
  });

  test("comboRanking sorted by avgYield desc, tie broken by stdDev asc", () => {
    const rows = [
      // Card B: 2 records, both 100% yield -> avg 100, stddev 0
      jbRow({ cardId: "B-01", testerId: "T2", passId: 1, lot: "L1", testEnd: "2026-01-01", grossDie: 100 }),
      jbRow({ cardId: "B-01", testerId: "T2", passId: 1, lot: "L2", testEnd: "2026-02-01", grossDie: 100 }),
      // Card A: 1 record, 90% yield
      jbRow({ cardId: "A-01", testerId: "T1", passId: 1, lot: "L3", testEnd: "2026-01-01", grossDie: 100, badBins: [{ n: 5, value: 10 }] }),
    ];
    const [group] = computeProbeCardTesterPerformance(rows);
    assert.equal(group!.comboRanking[0]!.cardId, "B-01");
    assert.equal(group!.comboRanking[0]!.avgYieldPct, 100);
    assert.equal(group!.comboRanking[1]!.cardId, "A-01");
  });

  test("confidenceTier from lotCount: >=10 高, 3-9 中, <3 低", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      jbRow({ cardId: "C-01", testerId: "T1", passId: 1, lot: `L${i}`, testEnd: "2026-01-01", grossDie: 100 })
    );
    const mid = Array.from({ length: 3 }, (_, i) =>
      jbRow({ cardId: "C-02", testerId: "T1", passId: 1, lot: `M${i}`, testEnd: "2026-01-01", grossDie: 100 })
    );
    const few = [jbRow({ cardId: "C-03", testerId: "T1", passId: 1, lot: "F0", testEnd: "2026-01-01", grossDie: 100 })];
    const [group] = computeProbeCardTesterPerformance([...many, ...mid, ...few]);
    const byId = new Map(group!.cardRanking.map((r) => [r.cardId, r]));
    assert.equal(byId.get("C-01")!.confidenceTier, "高");
    assert.equal(byId.get("C-02")!.confidenceTier, "中");
    assert.equal(byId.get("C-03")!.confidenceTier, "低");
  });

  test("cardRanking assessment: lotCount<3 wins first regardless of yield", () => {
    const rows = [jbRow({ cardId: "D-01", testerId: "T1", passId: 1, lot: "L1", testEnd: "2026-01-01", grossDie: 100 })];
    const [group] = computeProbeCardTesterPerformance(rows);
    assert.equal(group!.cardRanking[0]!.assessment, "样本有限，置信度低");
  });

  test("cardRanking assessment: avgYield far below group mean -> 良率明显偏低", () => {
    // 5 cards with lotCount>=3 each, one is a clear outlier low-yield card
    const good = ["E-01", "E-02", "E-03", "E-04"].flatMap((cardId) =>
      Array.from({ length: 3 }, (_, i) =>
        jbRow({ cardId, testerId: "T1", passId: 1, lot: `${cardId}-${i}`, testEnd: "2026-01-01", grossDie: 100 })
      )
    );
    const bad = Array.from({ length: 3 }, (_, i) =>
      jbRow({ cardId: "E-05", testerId: "T1", passId: 1, lot: `E-05-${i}`, testEnd: "2026-01-01", grossDie: 100, badBins: [{ n: 5, value: 60 }] })
    );
    const [group] = computeProbeCardTesterPerformance([...good, ...bad]);
    const worst = group!.cardRanking.find((r) => r.cardId === "E-05")!;
    assert.equal(worst.assessment, "良率明显偏低");
  });

  test("cardTrend only includes cards with >=2 distinct months", () => {
    const rows = [
      jbRow({ cardId: "F-01", testerId: "T1", passId: 1, lot: "L1", testEnd: "2026-01-05", grossDie: 100 }),
      jbRow({ cardId: "F-01", testerId: "T1", passId: 1, lot: "L2", testEnd: "2026-02-05", grossDie: 100 }),
      // single-month card excluded
      jbRow({ cardId: "F-02", testerId: "T1", passId: 1, lot: "L3", testEnd: "2026-01-05", grossDie: 100 }),
    ];
    const [group] = computeProbeCardTesterPerformance(rows);
    const cardIds = new Set(group!.cardTrend.map((r) => r.cardId));
    assert.ok(cardIds.has("F-01"));
    assert.ok(!cardIds.has("F-02"));
    assert.equal(group!.cardTrend.filter((r) => r.cardId === "F-01").length, 2);
  });

  test("cardBadBin: top 3 bins by share of that card's total bad die", () => {
    const rows = [
      jbRow({ cardId: "G-01", testerId: "T1", passId: 1, lot: "L1", testEnd: "2026-01-01", grossDie: 200, badBins: [{ n: 7, value: 65 }, { n: 12, value: 20 }, { n: 23, value: 8 }, { n: 40, value: 7 }] }),
    ];
    const [group] = computeProbeCardTesterPerformance(rows);
    const entry = group!.cardBadBin.find((r) => r.cardId === "G-01")!;
    assert.equal(entry.topBins.length, 3);
    assert.equal(entry.topBins[0]!.bin, 7);
    assert.ok(Math.abs(entry.topBins[0]!.pct - 65) < 1e-6);
  });

  test("markdown tables are non-empty strings containing cardId", () => {
    const rows = [jbRow({ cardId: "H-01", testerId: "T1", passId: 1, lot: "L1", testEnd: "2026-01-01", grossDie: 100 })];
    const [group] = computeProbeCardTesterPerformance(rows);
    assert.ok(group!.comboRankingMarkdown.includes("H-01"));
    assert.ok(group!.cardRankingMarkdown.includes("H-01"));
  });

  test("rows with GROSSDIE missing are excluded from all stats", () => {
    const rows = [
      jbRow({ cardId: "I-01", testerId: "T1", passId: 1, lot: "L1", testEnd: "2026-01-01", grossDie: 0 }),
    ];
    const groups = computeProbeCardTesterPerformance(rows);
    assert.equal(groups.length, 0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd pcr-ai-api && npx tsx --test test/probeCardTesterPerformance.test.ts`
Expected: FAIL — `computeProbeCardTesterPerformance is not a function` / not exported.

- [ ] **Step 3: Write the implementation**

Append to `pcr-ai-api/src/lib/probeCardTesterPerformance.ts`:

```ts
import { goodBinIndicesForJbRow } from "./jbYieldCalc.js";

// ─── shared row accessors ───────────────────────────────────────────────────

function fieldStr(row: Record<string, unknown>, upper: string, lower: string): string {
  return String(row[upper] ?? row[lower] ?? "").trim();
}

function monthKeyFromTestEnd(row: Record<string, unknown>): string | null {
  const raw = row["TESTEND"] ?? row["testend"];
  if (!raw) return null;
  const d = raw instanceof Date ? raw : new Date(String(raw));
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/** Per-bin bad-die breakdown for one row (mirrors badDieFromJbRow's loop, but keeps per-bin counts instead of collapsing to a total). Reuses goodBinIndicesForJbRow — does not reimplement good-bin detection. */
function badBinCountsForRow(row: Record<string, unknown>): Map<number, number> {
  const good = goodBinIndicesForJbRow(row);
  const counts = new Map<number, number>();
  const bins = Array.isArray(row["bins"]) ? (row["bins"] as unknown[]) : [];
  for (const cell of bins) {
    if (cell == null || typeof cell !== "object") continue;
    const c = cell as { n?: number; value?: number };
    const n = Number(c.n);
    const v = Number(c.value ?? 0);
    if (!Number.isFinite(n) || !Number.isFinite(v) || v <= 0) continue;
    if (good.has(n)) continue;
    counts.set(n, (counts.get(n) ?? 0) + v);
  }
  return counts;
}

// ─── public types ───────────────────────────────────────────────────────────

export type ConfidenceTier = "高" | "中" | "低";

export interface ComboRankRow {
  cardId: string;
  testerId: string;
  passId: number;
  avgYieldPct: number;
  stdDevYieldPct: number;
  recordCount: number;
  lotCount: number;
  confidenceTier: ConfidenceTier;
}

export interface CardRankRow {
  cardId: string;
  passId: number;
  avgYieldPct: number;
  stdDevYieldPct: number;
  recordCount: number;
  lotCount: number;
  confidenceTier: ConfidenceTier;
  assessment: string;
}

export interface CardTrendRow {
  cardId: string;
  month: string;
  avgYieldPct: number;
  recordCount: number;
}

export interface CardBadBinRow {
  cardId: string;
  topBins: { bin: number; pct: number }[];
}

export interface PassGroupResult {
  passId: number;
  comboRanking: ComboRankRow[];
  cardRanking: CardRankRow[];
  cardTrend: CardTrendRow[];
  cardBadBin: CardBadBinRow[];
  comboRankingMarkdown: string;
  cardRankingMarkdown: string;
  cardTrendMarkdown: string;
  cardBadBinMarkdown: string;
}

function confidenceTierFromLotCount(lotCount: number): ConfidenceTier {
  if (lotCount >= 10) return "高";
  if (lotCount >= 3) return "中";
  return "低";
}

function fmtPct(n: number): string {
  return `${n.toFixed(2)}%`;
}

function mdTable(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return "(无数据)";
  const head = `| ${headers.join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${r.join(" | ")} |`).join("\n");
  return [head, sep, body].join("\n");
}

// ─── grouping ────────────────────────────────────────────────────────────

const VALID_PASS_IDS = [1, 3, 5];

export function computeProbeCardTesterPerformance(
  enrichedRows: Record<string, unknown>[]
): PassGroupResult[] {
  // { passId -> { cardId -> { testerId -> rows[] } } } plus flat card-level rows
  type ValidRow = { cardId: string; testerId: string; lot: string; yieldPct: number; month: string | null; row: Record<string, unknown> };
  const byPassId = new Map<number, ValidRow[]>();

  for (const row of enrichedRows) {
    const passId = Number(row["PASSID"] ?? row["passid"]);
    if (!VALID_PASS_IDS.includes(passId)) continue;
    const cardId = fieldStr(row, "CARDID", "cardid");
    if (!cardId) continue;
    const testerId = fieldStr(row, "TESTERID", "testerid");
    const lot = fieldStr(row, "LOT", "lot");
    const yieldPct = rowYieldPct(row);
    if (yieldPct == null) continue;
    const entry: ValidRow = { cardId, testerId, lot, yieldPct, month: monthKeyFromTestEnd(row), row };
    const list = byPassId.get(passId) ?? [];
    list.push(entry);
    byPassId.set(passId, list);
  }

  const passIds = [...byPassId.keys()].sort((a, b) => a - b);

  return passIds.map((passId) => {
    const rows = byPassId.get(passId)!;

    // ── combo ranking: group by (cardId, testerId) ──
    const comboGroups = new Map<string, ValidRow[]>();
    for (const r of rows) {
      const key = `${r.cardId}::${r.testerId}`;
      const list = comboGroups.get(key) ?? [];
      list.push(r);
      comboGroups.set(key, list);
    }
    const comboRanking: ComboRankRow[] = [...comboGroups.values()].map((list) => {
      const yields = list.map((r) => r.yieldPct);
      const lotCount = new Set(list.map((r) => r.lot)).size;
      return {
        cardId: list[0]!.cardId,
        testerId: list[0]!.testerId,
        passId,
        avgYieldPct: mean(yields),
        stdDevYieldPct: sampleStdDev(yields),
        recordCount: list.length,
        lotCount,
        confidenceTier: confidenceTierFromLotCount(lotCount),
      };
    });
    comboRanking.sort((a, b) =>
      b.avgYieldPct !== a.avgYieldPct
        ? b.avgYieldPct - a.avgYieldPct
        : a.stdDevYieldPct !== b.stdDevYieldPct
        ? a.stdDevYieldPct - b.stdDevYieldPct
        : b.recordCount - a.recordCount
    );

    // ── card ranking: group by cardId (across testers) ──
    const cardGroups = new Map<string, ValidRow[]>();
    for (const r of rows) {
      const list = cardGroups.get(r.cardId) ?? [];
      list.push(r);
      cardGroups.set(r.cardId, list);
    }
    const cardStats = [...cardGroups.entries()].map(([cardId, list]) => {
      const yields = list.map((r) => r.yieldPct);
      const lotCount = new Set(list.map((r) => r.lot)).size;
      return {
        cardId,
        avgYieldPct: mean(yields),
        stdDevYieldPct: sampleStdDev(yields),
        recordCount: list.length,
        lotCount,
      };
    });
    const groupAvgs = cardStats.map((c) => c.avgYieldPct);
    const groupMean = mean(groupAvgs);
    const groupStdDev = sampleStdDev(groupAvgs);
    const groupStdDevMedian = median(cardStats.map((c) => c.stdDevYieldPct));

    const cardRanking: CardRankRow[] = cardStats.map((c) => {
      const confidenceTier = confidenceTierFromLotCount(c.lotCount);
      let assessment: string;
      if (c.lotCount < 3) {
        assessment = "样本有限，置信度低";
      } else if (c.avgYieldPct < groupMean - 1.5 * groupStdDev) {
        assessment = "良率明显偏低";
      } else if (c.stdDevYieldPct > groupStdDevMedian) {
        assessment = "波动较大，稳定性差";
      } else {
        assessment = "表现稳定";
      }
      return { ...c, confidenceTier, assessment, passId };
    });
    cardRanking.sort((a, b) => a.avgYieldPct - b.avgYieldPct);

    // ── monthly trend by cardId ──
    const trendGroups = new Map<string, Map<string, ValidRow[]>>();
    for (const r of rows) {
      if (!r.month) continue;
      const byMonth = trendGroups.get(r.cardId) ?? new Map<string, ValidRow[]>();
      const list = byMonth.get(r.month) ?? [];
      list.push(r);
      byMonth.set(r.month, list);
      trendGroups.set(r.cardId, byMonth);
    }
    const cardTrend: CardTrendRow[] = [];
    for (const [cardId, byMonth] of trendGroups) {
      if (byMonth.size < 2) continue;
      const months = [...byMonth.keys()].sort();
      for (const month of months) {
        const list = byMonth.get(month)!;
        cardTrend.push({
          cardId,
          month,
          avgYieldPct: mean(list.map((r) => r.yieldPct)),
          recordCount: list.length,
        });
      }
    }
    cardTrend.sort((a, b) => (a.cardId === b.cardId ? a.month.localeCompare(b.month) : a.cardId.localeCompare(b.cardId)));

    // ── bad bin frequency by cardId ──
    const cardBadBin: CardBadBinRow[] = [];
    for (const [cardId, list] of cardGroups) {
      const totals = new Map<number, number>();
      for (const r of list) {
        const perRow = badBinCountsForRow(r.row);
        for (const [bin, count] of perRow) {
          totals.set(bin, (totals.get(bin) ?? 0) + count);
        }
      }
      const grandTotal = [...totals.values()].reduce((s, v) => s + v, 0);
      if (grandTotal <= 0) continue;
      const topBins = [...totals.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([bin, count]) => ({ bin, pct: (count / grandTotal) * 100 }));
      cardBadBin.push({ cardId, topBins });
    }
    cardBadBin.sort((a, b) => a.cardId.localeCompare(b.cardId));

    // ── markdown ──
    const comboRankingMarkdown = mdTable(
      ["排名", "CardId", "TesterId", "平均良率", "标准差", "片数", "Lot 数", "置信度"],
      comboRanking.map((r, i) => [
        String(i + 1),
        r.cardId,
        r.testerId,
        fmtPct(r.avgYieldPct),
        fmtPct(r.stdDevYieldPct),
        String(r.recordCount),
        String(r.lotCount),
        r.confidenceTier,
      ])
    );
    const cardRankingMarkdown = mdTable(
      ["排名", "CardId", "平均良率", "标准差", "片数", "Lot 数", "评估", "置信度"],
      cardRanking.map((r, i) => [
        String(i + 1),
        r.cardId,
        fmtPct(r.avgYieldPct),
        fmtPct(r.stdDevYieldPct),
        String(r.recordCount),
        String(r.lotCount),
        r.assessment,
        r.confidenceTier,
      ])
    );
    const cardTrendMarkdown = mdTable(
      ["CardId", "月份", "当月平均良率", "当月样本数"],
      cardTrend.map((r) => [r.cardId, r.month, fmtPct(r.avgYieldPct), String(r.recordCount)])
    );
    const cardBadBinMarkdown = mdTable(
      ["CardId", "Top 3 坏 bin"],
      cardBadBin.map((r) => [
        r.cardId,
        r.topBins.map((b) => `BIN${b.bin} (${b.pct.toFixed(2)}%)`).join(", "),
      ])
    );

    return {
      passId,
      comboRanking,
      cardRanking,
      cardTrend,
      cardBadBin,
      comboRankingMarkdown,
      cardRankingMarkdown,
      cardTrendMarkdown,
      cardBadBinMarkdown,
    };
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd pcr-ai-api && npx tsx --test test/probeCardTesterPerformance.test.ts`
Expected: PASS (all tests, ~17 total)

- [ ] **Step 5: Run typecheck**

Run: `cd pcr-ai-api && npm run typecheck`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add pcr-ai-api/src/lib/probeCardTesterPerformance.ts pcr-ai-api/test/probeCardTesterPerformance.test.ts
git commit -m "feat(probe-card-perf): add combo/card ranking, confidence tier, trend, bad-bin tables"
```

---

### Task 3: Agent tool handler wiring

**Files:**
- Modify: `pcr-ai-api/src/lib/agent/agentToolHandlers.ts`
- Test: `pcr-ai-api/test/agentAggregateProbeCardTesterPerformance.test.ts`

**Interfaces:**
- Consumes: `computeProbeCardTesterPerformance` (Task 2); `parseInfcontrolLayerBinsV3Query` (`infcontrolLayerBinFilters.ts`, already imported); `buildInfcontrolLayerBinsV3SqlFullMatching` (`apiV3ListSql.ts`, already imported); `buildInfcontrolLayerBinMatchingCountSql` (`infcontrolLayerBinAggregate.ts`, already imported); `adaptInfcontrolV3WhereAndSqlToAggregateAliases` (`infcontrolLayerBinV3Aggregate.ts`, **new import**); `infcontrolLayerBinV3BaseWhereBlock` (`infcontrolLayerBinPasstypeScope.ts`, **new import**); `readMemoryAggregateOracleMaxRows` (`memoryAggregateOracleLimits.ts`, **new import**); `filterInfcontrolLayerBinV3DummyRowsMatching` (`infcontrolLayerBinDummy.ts`, already imported); local `enrichJbRow`, `infcontrolLayerBinsUseDummy`, `withConnection`, `oracledb`, `truncateResult` (all already present in the file).
- Produces: `runTool("aggregate_probe_card_tester_performance", args, options)` returns a JSON string (via `truncateResult`) shaped `{ device, passIdFilter, totalRowsMatching, groups: PassGroupResult[] }`, or a plain-text error string.

- [ ] **Step 1: Write the failing test**

Create `pcr-ai-api/test/agentAggregateProbeCardTesterPerformance.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

process.env["INFCONTROL_LAYER_BINS_DUMMY"] = "true";
process.env["NODE_ENV"] = "test";

import { runTool } from "../src/lib/agent/agentToolHandlers.js";

test("aggregate_probe_card_tester_performance requires device", async () => {
  const out = await runTool("aggregate_probe_card_tester_performance", {});
  assert.equal(typeof out, "string");
  assert.ok((out as string).includes("device"));
});

test("aggregate_probe_card_tester_performance returns grouped markdown tables for a known dummy device", async () => {
  const out = (await runTool("aggregate_probe_card_tester_performance", {
    device: "WA03P02G",
  })) as string;
  assert.equal(typeof out, "string");
  assert.ok(!out.startsWith("aggregate_probe_card_tester_performance 参数错误"));
  const parsed = JSON.parse(out);
  assert.equal(parsed.device, "WA03P02G");
  assert.ok(Array.isArray(parsed.groups));
  if (parsed.groups.length > 0) {
    const g = parsed.groups[0];
    assert.ok([1, 3, 5].includes(g.passId));
    assert.ok(typeof g.comboRankingMarkdown === "string");
    assert.ok(typeof g.cardRankingMarkdown === "string");
    assert.ok(typeof g.cardTrendMarkdown === "string");
    assert.ok(typeof g.cardBadBinMarkdown === "string");
  }
});

test("aggregate_probe_card_tester_performance with passId only returns that pass", async () => {
  const out = (await runTool("aggregate_probe_card_tester_performance", {
    device: "WA03P02G",
    passId: 1,
  })) as string;
  const parsed = JSON.parse(out);
  for (const g of parsed.groups) {
    assert.equal(g.passId, 1);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pcr-ai-api && npx tsx --test test/agentAggregateProbeCardTesterPerformance.test.ts`
Expected: FAIL — `runTool` returns the generic `default` branch message (unknown tool name), not a device-validation error.

- [ ] **Step 3: Add imports**

In `pcr-ai-api/src/lib/agent/agentToolHandlers.ts`, add these new import statements near the existing `infcontrolLayerBinAggregate.js` / `infcontrolLayerBinDummy.js` import block:

```ts
import {
  adaptInfcontrolV3WhereAndSqlToAggregateAliases,
} from "../infcontrolLayerBinV3Aggregate.js";
import { infcontrolLayerBinV3BaseWhereBlock } from "../infcontrolLayerBinPasstypeScope.js";
import { readMemoryAggregateOracleMaxRows } from "../memoryAggregateOracleLimits.js";
import { computeProbeCardTesterPerformance } from "../probeCardTesterPerformance.js";
```

- [ ] **Step 4: Implement the tool handler**

Add this function directly after `toolAggregateJbBins` (after the closing `}` at what is currently line 517, before the "Compact INF DUT-distribution data" comment block):

```ts
async function toolAggregateProbeCardTesterPerformance(
  args: Record<string, unknown>,
  maxChars: number
): Promise<string> {
  const device = typeof args["device"] === "string" ? args["device"].trim() : "";
  if (!device) {
    return "aggregate_probe_card_tester_performance 参数错误: device 不能为空，必须先给出 device 代码。";
  }

  const params: Record<string, unknown> = { device };
  if (typeof args["passId"] === "number") params["passId"] = args["passId"];
  if (args["testEndFrom"]) params["testEndFrom"] = args["testEndFrom"];
  if (args["testEndTo"]) params["testEndTo"] = args["testEndTo"];

  const parsed = parseInfcontrolLayerBinsV3Query(params);
  if (!parsed.ok) return `查询参数错误: ${parsed.error}`;

  const maxRows = readMemoryAggregateOracleMaxRows();
  let rawRows: Record<string, unknown>[];

  if (infcontrolLayerBinsUseDummy()) {
    rawRows = filterInfcontrolLayerBinV3DummyRowsMatching(
      parsed.applied
    ) as Record<string, unknown>[];
    if (rawRows.length > maxRows) {
      return `aggregate_probe_card_tester_performance 错误：匹配行数 (${rawRows.length}) 超过上限 (${maxRows})，请缩小 passId 或 testEndFrom/testEndTo 时间范围。`;
    }
  } else {
    const adapted = adaptInfcontrolV3WhereAndSqlToAggregateAliases(parsed.whereAndSql);
    const countWhereSql = infcontrolLayerBinV3BaseWhereBlock("lb", adapted);
    const countSql = buildInfcontrolLayerBinMatchingCountSql(countWhereSql);
    const matchingCount = await withConnection(async (conn) => {
      const result = await conn.execute(countSql, parsed.binds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });
      const rows = (result.rows ?? []) as Record<string, unknown>[];
      return typeof rows[0]?.["TOTAL_MATCHING"] === "number"
        ? (rows[0]["TOTAL_MATCHING"] as number)
        : 0;
    });
    if (matchingCount > maxRows) {
      return `aggregate_probe_card_tester_performance 错误：匹配行数 (${matchingCount}) 超过上限 (${maxRows})，请缩小 passId 或 testEndFrom/testEndTo 时间范围。`;
    }
    const sql = buildInfcontrolLayerBinsV3SqlFullMatching(parsed.whereAndSql);
    logAgentSql("aggregate_probe_card_tester_performance", sql, parsed.binds, {
      device,
      passId: typeof args["passId"] === "number" ? args["passId"] : undefined,
    });
    rawRows = await withConnection(async (conn) => {
      const result = await conn.execute(sql, parsed.binds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });
      return (result.rows ?? []) as Record<string, unknown>[];
    });
  }

  const enriched = rawRows.map(enrichJbRow);
  const groups = computeProbeCardTesterPerformance(enriched);

  if (groups.length === 0) {
    return `aggregate_probe_card_tester_performance: device=${device} 在指定范围内未查到有效良率数据（GROSSDIE 缺失，或 PASSID 不在 1/3/5 范围内）。可尝试放宽 testEndFrom/testEndTo。`;
  }

  return truncateResult(
    {
      device,
      passIdFilter: typeof args["passId"] === "number" ? args["passId"] : null,
      totalRowsMatching: rawRows.length,
      groups,
    },
    maxChars
  );
}
```

- [ ] **Step 5: Wire into `runTool`**

In the `switch (name)` block inside `runTool` (currently starting at line 863), add a new case right after `aggregate_jb_bins`:

```ts
    case "aggregate_jb_bins":
      return toolAggregateJbBins(args, maxChars);
    case "aggregate_probe_card_tester_performance":
      return toolAggregateProbeCardTesterPerformance(args, maxChars);
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd pcr-ai-api && npx tsx --test test/agentAggregateProbeCardTesterPerformance.test.ts`
Expected: PASS (3 tests). If the dummy dataset has no rows for `WA03P02G` at all (empty `groups`), the second test's `if (parsed.groups.length > 0)` block is skipped and the test still passes on the top-level assertions — in that case pick a different known-good dummy device by running `cd pcr-ai-api && INFCONTROL_LAYER_BINS_DUMMY=true npx tsx -e "import('./src/lib/agent/agentToolHandlers.js').then(async m => console.log(await m.runTool('query_jb_bins', {device:'WA03P02G', limit: 5})))"` to confirm the device has JB STAR dummy rows before relying on it in the test.

- [ ] **Step 7: Run full typecheck**

Run: `cd pcr-ai-api && npm run typecheck`
Expected: no errors

- [ ] **Step 8: Commit**

```bash
git add pcr-ai-api/src/lib/agent/agentToolHandlers.ts pcr-ai-api/test/agentAggregateProbeCardTesterPerformance.test.ts
git commit -m "feat(probe-card-perf): wire aggregate_probe_card_tester_performance agent tool"
```

---

### Task 4: Tool schema

**Files:**
- Modify: `pcr-ai-api/src/lib/agent/agentToolSchemas.ts`

**Interfaces:**
- Consumes: nothing new — this is a static JSON-schema entry appended to `TOOL_SCHEMAS`.
- Produces: `TOOL_SCHEMAS` includes a `function.name === "aggregate_probe_card_tester_performance"` entry that the SiliconFlow tool-calling loop can select.

- [ ] **Step 1: Write the failing test**

Create `pcr-ai-api/test/agentToolSchemas.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { TOOL_SCHEMAS } from "../src/lib/agent/agentToolSchemas.js";

test("TOOL_SCHEMAS includes aggregate_probe_card_tester_performance with required device", () => {
  const entry = TOOL_SCHEMAS.find(
    (t) => t.function.name === "aggregate_probe_card_tester_performance"
  );
  assert.ok(entry, "schema entry must exist");
  assert.ok(entry!.function.parameters.required.includes("device"));
  assert.ok("passId" in entry!.function.parameters.properties);
  assert.ok("testEndFrom" in entry!.function.parameters.properties);
  assert.ok("testEndTo" in entry!.function.parameters.properties);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pcr-ai-api && npx tsx --test test/agentToolSchemas.test.ts`
Expected: FAIL — `entry` is `undefined`.

- [ ] **Step 3: Add the schema entry**

In `pcr-ai-api/src/lib/agent/agentToolSchemas.ts`, insert a new entry into the `TOOL_SCHEMAS` array immediately after the `aggregate_jb_bins` entry closes (currently ends at line 167 with `  },`) and before the `generate_chart` entry begins (currently line 168):

```ts
  {
    type: "function",
    function: {
      name: "aggregate_probe_card_tester_performance",
      description:
        "按 device 计算 JB STAR 探针卡/测试机组合良率排名与探针卡表现排名（含月度趋势、坏 bin 频率、置信度档位）。用于回答：哪个探针卡+测试机组合良率最好/最差、探针卡表现排名、这张卡良率是不是在变差、这张卡常见坏 bin 是什么。**必填 device**；未传 passId 时按 passId∈{1,3,5} 分别输出三张组合表+三张探针卡表（pass1/pass3/pass5，不跨 sort 合并）。结果含月度良率趋势表（仅≥2个月数据的卡）与坏 bin Top3 频率表（仅频率统计，非坐标级分布）。数字均由服务端计算直出，禁止在回复里自行改写。",
      parameters: {
        type: "object",
        properties: {
          device: { type: "string", description: "device 代码，必填" },
          passId: {
            type: "number",
            description:
              "测试层 PASSID：pass1/常温/sort1→1，pass3/高温/sort2→3，pass5/低温/sort3→5（勿用2/4）；不传则分 1/3/5 三组分别输出",
          },
          testEndFrom: { type: "string", description: "TESTEND 起始时间（ISO），不传默认最近一年" },
          testEndTo: { type: "string", description: "TESTEND 结束时间（ISO）" },
        },
        required: ["device"],
      },
    },
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pcr-ai-api && npx tsx --test test/agentToolSchemas.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add pcr-ai-api/src/lib/agent/agentToolSchemas.ts pcr-ai-api/test/agentToolSchemas.test.ts
git commit -m "feat(probe-card-perf): add aggregate_probe_card_tester_performance tool schema"
```

---

### Task 5: Prompt trigger rules + guardrail

**Files:**
- Modify: `pcr-ai-api/src/lib/agent/agentPrompt.ts`
- Test: `pcr-ai-api/test/agentPrompt.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `classifyIntent(userQuestion)` returns `"card_probe"` for probe-card+tester performance/trend/bad-bin questions; `buildSystemPrompt(manifest, "card_probe")` includes the new section and the tool name.

- [ ] **Step 1: Write the failing test**

Create `pcr-ai-api/test/agentPrompt.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { buildSystemPrompt, classifyIntent } from "../src/lib/agent/agentPrompt.js";

test("classifyIntent: combo/trend/bad-bin questions route to card_probe", () => {
  assert.equal(classifyIntent("这个device下最好的探针卡+机台组合是什么"), "card_probe");
  assert.equal(classifyIntent("探针卡表现排名"), "card_probe");
  assert.equal(classifyIntent("这张卡良率是不是在变差"), "card_probe");
  assert.equal(classifyIntent("这张卡常见坏bin是什么，是不是接触不良"), "card_probe");
  assert.equal(classifyIntent("哪个探针卡+测试机组合最佳搭配"), "card_probe");
});

test("buildSystemPrompt: card_probe intent includes the new tool name and guardrail", () => {
  const prompt = buildSystemPrompt(undefined, "card_probe");
  assert.ok(prompt.includes("aggregate_probe_card_tester_performance"));
  assert.ok(prompt.includes("边缘接触不良"), "must document the spatial-claim guardrail");
});

test("SEC_TERMS_AND_TOOLS tool list mentions the new tool", () => {
  const prompt = buildSystemPrompt(undefined, "general");
  assert.ok(prompt.includes("aggregate_probe_card_tester_performance"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pcr-ai-api && npx tsx --test test/agentPrompt.test.ts`
Expected: FAIL — `classifyIntent` returns `"general"`/`"lot_bin"` for the trend/bad-bin phrasings, and the prompt doesn't mention the new tool.

- [ ] **Step 3: Extend `classifyIntent`'s `card_probe` regex**

In `pcr-ai-api/src/lib/agent/agentPrompt.ts`, replace the existing card_probe check (currently at line 1436):

```ts
  // Probe-card health / Yield Monitor trigger queries
  if (/探针卡|probe\s*card|哪张卡|卡号|最差.*(卡|card)|报警最多|yield\s*monitor|触发次数|ym触发|dut.*不均/.test(q)) return "card_probe";
```

with:

```ts
  // Probe-card health / Yield Monitor trigger queries / combo ranking / degradation trend / bad-bin frequency
  if (/探针卡|probe\s*card|哪张卡|卡号|最差.*(卡|card)|报警最多|yield\s*monitor|触发次数|ym触发|dut.*不均|组合排名|探针卡排名|最佳组合|最佳搭配|表现排名|接触不良|卡.*(退化|变差|趋势|稳定性)|(退化|变差|趋势|稳定性).*卡/.test(q)) return "card_probe";
```

(The `卡.*(退化|变差|趋势|稳定性)` / reverse-order alternatives are deliberately narrower than bare `退化|坏bin|稳定性` — those bare keywords already collide with the existing `lot_bin` classification for unrelated lot-level questions. Tying them to `卡` keeps the new routing additive without hijacking existing intent classification. Any question this misses still falls through to `"general"`, which `is()` treats as a superset that includes every section anyway — so under-classification here is not a correctness risk, only a lean-prompt-size optimization.)

- [ ] **Step 4: Add the tool name to `SEC_TERMS_AND_TOOLS`**

In the same file, find the tool list line (currently line 98):

```ts
可用工具：query_yield_triggers, aggregate_yield_triggers, query_jb_bins, aggregate_jb_bins, query_lot_dut_bin_agg, query_lot_underperforming_duts, query_inf_site_bin_by_dut, generate_chart, ask_clarification, get_filter_values。
```

Change to:

```ts
可用工具：query_yield_triggers, aggregate_yield_triggers, query_jb_bins, aggregate_jb_bins, aggregate_probe_card_tester_performance, query_lot_dut_bin_agg, query_lot_underperforming_duts, query_inf_site_bin_by_dut, generate_chart, ask_clarification, get_filter_values。
```

- [ ] **Step 5: Add the new section**

In `pcr-ai-api/src/lib/agent/agentPrompt.ts`, immediately after the `SEC_WORST_CARD` constant definition (ends at line 962 with the closing `` `; ``), add:

```ts
// ─── SEC_CARD_TESTER_PERFORMANCE ────────────────────────────────────────────
// 探针卡+测试机组合排名 / 探针卡表现排名 / 良率趋势 / 常见坏 bin

const SEC_CARD_TESTER_PERFORMANCE = `\
## 探针卡+测试机组合排名 / 探针卡表现排名 / 良率趋势 / 常见坏 bin（\`aggregate_probe_card_tester_performance\`）

**触发场景**：用户问"这个 device 下最好的探针卡+机台组合""探针卡表现排名""哪张探针卡最差""这张卡良率是不是在变差/退化""这张卡常见坏 bin 是什么/接触不良吗""哪个组合/搭配良率最好"。

**调用**：\`aggregate_probe_card_tester_performance(device, passId?, testEndFrom?, testEndTo?)\`。**必须**先有 device（缺失时先追问或从上下文推断，不允许跨 device 硬凑）。不传 passId 时结果按 passId∈{1,3,5} 分三组，**每组独立汇报，禁止跨 sort 合并或求平均**。

**结果结构**：每个 passId 分组含四张服务端直出的 markdown 表——\`comboRankingMarkdown\`（组合排名，良率降序）、\`cardRankingMarkdown\`（探针卡排名，良率**升序**即最差在前，含规则触发的评估文字与置信度档位）、\`cardTrendMarkdown\`（按卡的月度良率走势，仅含 ≥2 个月数据的卡）、\`cardBadBinMarkdown\`（按卡的坏 bin Top3 频率占比）。

**硬规则**：
1. 表格数字直接照抄工具返回的 markdown，**禁止自行重新计算或改写**；LLM 只在表格之后追加「### 数据解读」「### 专业建议」。
2. \`cardBadBinMarkdown\` **只是坏 bin 编号出现频率统计，不是 die 级空间/坐标分布**——**禁止**解读成"边缘接触不良""角落 pattern""某区域集中"等需要晶圆坐标才能下的结论；只能说"该卡失效最常见的 bin 类型是 X"。用户明确要看空间分布时，提示改用晶圆图工具（\`inf_draw_wafer_map\` / \`inf_cluster_detect\`）。
3. \`cardTrendMarkdown\` 只给月度原始数字，不做趋势拟合；LLM 描述走势方向（"持续下降""先降后稳"等）时不得编造统计显著性结论。
4. 置信度档位（高/中/低）来自 \`lotCount\`，样本量小（低）的卡结论需注明"样本有限，仅供参考"。`;
```

- [ ] **Step 6: Register the section in `buildSystemPrompt`**

In the same file, in `buildSystemPrompt`'s returned array (currently around line 1493), add a line right after the `SEC_WORST_CARD` line:

```ts
    is("lot_bin", "card_probe")                               && SEC_WORST_CARD,
    is("lot_bin", "card_probe")                               && SEC_CARD_TESTER_PERFORMANCE,
```

- [ ] **Step 7: Update the section-map header comment**

In the section map comment block near the top of the file (currently lines 10-40), add a line after the `SEC_WORST_CARD` row:

```
// ║  SEC_WORST_CARD        哪张卡最差/报警最多/坏 die 最多                    ║
// ║  SEC_CARD_TESTER_PERFORMANCE  探针卡+机台组合排名/趋势/坏bin（新工具）    ║
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd pcr-ai-api && npx tsx --test test/agentPrompt.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 9: Run full typecheck**

Run: `cd pcr-ai-api && npm run typecheck`
Expected: no errors

- [ ] **Step 10: Commit**

```bash
git add pcr-ai-api/src/lib/agent/agentPrompt.ts pcr-ai-api/test/agentPrompt.test.ts
git commit -m "feat(probe-card-perf): add prompt trigger rules and bad-bin spatial-claim guardrail"
```

---

### Task 6: Full verification + handoff doc

**Files:**
- Create: `docs/HANDOFF_AGENT_PROBE_CARD_TESTER_PERFORMANCE.md`
- Modify: `d:\AI\PCR-AI-Agent\CLAUDE.md` (add one reference line, following the existing convention of one bullet per handoff doc at the top of the file)

**Interfaces:** none — this task verifies and documents Tasks 1-5, it does not add code.

- [ ] **Step 1: Run the full backend test suite**

Run: `cd pcr-ai-api && npm test`
Expected: all tests pass, including the 4 new test files from Tasks 1-5. If `agentLoop.test.ts` / `jbRouteResolver.test.ts` fail on unrelated flag-off cases, confirm via `git stash` + re-run that the same failures pre-exist on `main` (already documented as a known pre-existing local-only issue in `docs/HANDOFF_CURSOR_JB_CARD_LISTING_SCOPE_2026-07-10.md` §4) — do not attempt to fix them as part of this feature.

- [ ] **Step 2: Run typecheck and build**

Run: `cd pcr-ai-api && npm run typecheck && npm run build`
Expected: no errors; `dist/lib/probeCardTesterPerformance.js`, updated `dist/lib/agent/agentToolHandlers.js`, `agentToolSchemas.js`, `agentPrompt.js` exist.

- [ ] **Step 3: Manual Dummy-mode end-to-end check**

Run:

```bash
cd pcr-ai-api
INFCONTROL_LAYER_BINS_DUMMY=true npx tsx -e "
import('./src/lib/agent/agentToolHandlers.js').then(async (m) => {
  const out = await m.runTool('aggregate_probe_card_tester_performance', { device: 'WA03P02G' });
  console.log(out);
});
"
```

Verify manually:
- Output is valid JSON (or a clear no-data message if the dummy sample has no rows for this device — in which case retry with a device confirmed present via `query_jb_bins` per Task 3 Step 6's fallback instructions).
- `groups[].passId` only ever `1`, `3`, or `5`.
- `groups[].comboRankingMarkdown` rows are sorted by descending yield.
- `groups[].cardRankingMarkdown` rows are sorted by ascending yield (worst first).
- Every `confidenceTier` matches its row's `lotCount` per the 高/中/低 thresholds.
- `cardTrendMarkdown` never lists a card with only one distinct month.
- `cardBadBinMarkdown` percentages for each card sum to ≤100% and are drawn from that card's own bad-die total (spot-check one row by hand against `badDieFromJbRow` output for a couple of rows of that card).

- [ ] **Step 4: Write the handoff doc**

Create `docs/HANDOFF_AGENT_PROBE_CARD_TESTER_PERFORMANCE.md` following this repo's established handoff-doc structure (see `docs/HANDOFF_CURSOR_JB_CARD_LISTING_SCOPE_2026-07-10.md` for the format convention). Populate each section with the real values from this implementation (line numbers, test counts, actual commit hashes) — do not leave any bracketed placeholder in the committed file:

```markdown
# Agent 探针卡/测试机组合良率排名交接文档

> **执行者：** [你的名字/Claude Code]
> **前置阅读：** `docs/superpowers/specs/2026-07-09-probe-card-tester-performance-ranking-design.md`
> **分支：** [实际分支名]

## 0. 一眼结论

| 项 | 状态 | 说明 |
|---|---|---|
| 新工具 `aggregate_probe_card_tester_performance` | ✅ 已实现 | `probeCardTesterPerformance.ts` 纯函数 + `agentToolHandlers.ts` 分派 |
| 组合排名 / 探针卡排名 / 置信度档位 | ✅ 已实现 | 见 §4.1-4.3 |
| 月度良率趋势表 | ✅ 已实现 | 仅 ≥2 个月数据的卡 |
| 坏 bin Top3 频率表 | ✅ 已实现 | 频率统计，非坐标分布 |
| `npm test` | ✅ [实际通过数]/[实际总数] | 新增 4 个测试文件 |
| 真库回归 | ⏭ 待做 | 部署后用真实 device 验证 Oracle 路径 COUNT + 全量拉取 |

## 1. 架构

[简述 probeCardTesterPerformance.ts 纯函数 + agentToolHandlers.ts 两路径取数的分工，与 aggregate_jb_bins/v4 聚合的既有模式对比]

## 2. 关键文件

| 文件 | 改动 |
|---|---|
| `pcr-ai-api/src/lib/probeCardTesterPerformance.ts`（新） | 分组聚合纯函数 + markdown 构建 |
| `pcr-ai-api/src/lib/agent/agentToolHandlers.ts` | 新工具分派 `toolAggregateProbeCardTesterPerformance` |
| `pcr-ai-api/src/lib/agent/agentToolSchemas.ts` | 新增 schema |
| `pcr-ai-api/src/lib/agent/agentPrompt.ts` | `SEC_CARD_TESTER_PERFORMANCE` + classifyIntent 扩展 |
| `pcr-ai-api/test/probeCardTesterPerformance.test.ts`（新） | 纯函数单测 |
| `pcr-ai-api/test/agentAggregateProbeCardTesterPerformance.test.ts`（新） | Dummy 模式工具路由测试 |
| `pcr-ai-api/test/agentToolSchemas.test.ts`（新） | schema 存在性测试 |
| `pcr-ai-api/test/agentPrompt.test.ts`（新） | classifyIntent + 内容包含测试 |

## 3. 测试

```bash
cd pcr-ai-api
npm run typecheck
npx tsx --test test/probeCardTesterPerformance.test.ts test/agentAggregateProbeCardTesterPerformance.test.ts test/agentToolSchemas.test.ts test/agentPrompt.test.ts
npm test
```

## 4. 部署与真库回归

```bash
cd pcr-ai-api
npm ci && npm run build && npm run pm2:reload
```

真库验证（部署后）：用一个已知有较多 lot 历史的 device（如从 manifest `topDevices` 挑一个）在 Agent 对话里问「[device] 这个 device 下最好的探针卡+机台组合」，确认：
- 分 pass1/pass3/pass5 三组输出
- Oracle 路径的 COUNT 查询先执行（可在服务端日志 `logAgentSql` 输出确认），未超 `MEMORY_AGG_ORACLE_MAX_ROWS` 时正常拉全量行
- 数字与手工核算一致

## 5. 已知限制（v1 范围外，见设计文档 §7）

不做文件上传、不融合 Yield Monitor 数据、不做前端可视化面板、不跨 device 汇总、不做 Tester ANOVA/显著性检验、不做数值置信度分数、不做真正的 Wafer Map 坐标关联。
```

- [ ] **Step 5: Add a reference line to `CLAUDE.md`**

In `d:\AI\PCR-AI-Agent\CLAUDE.md`, add one bullet line following the existing convention (a `>` blockquote line near the top, alongside the other `HANDOFF_*` references), pointing at the new handoff doc, e.g.:

```
> **探针卡/测试机组合良率排名（2026-07-10 设计 / [实施日期] 实现）：** [`docs/HANDOFF_AGENT_PROBE_CARD_TESTER_PERFORMANCE.md`](docs/HANDOFF_AGENT_PROBE_CARD_TESTER_PERFORMANCE.md) — `aggregate_probe_card_tester_performance`；组合/探针卡排名+置信度档位+月度趋势+坏bin频率；仅 JB STAR，v1 无前端面板。
```

- [ ] **Step 6: Final commit**

```bash
git add docs/HANDOFF_AGENT_PROBE_CARD_TESTER_PERFORMANCE.md CLAUDE.md
git commit -m "docs(probe-card-perf): add handoff doc for aggregate_probe_card_tester_performance"
```

---

## Self-Review Notes

- **Spec coverage**: §1 (combo + card ranking tables) → Task 2. §2 (device required, PASSTYPE='TEST' via existing `parseInfcontrolLayerBinsV3Query`/`infcontrolLayerBinV3BaseWhereBlock`, passId 1/3/5 split, 1-year default window via existing `v3DefaultOneYearWindow` auto-injection, row-count protection) → Tasks 2/3. §3 (reuse `enrichJbRow`+`badDieFromJbRow`, new file `probeCardTesterPerformance.ts`) → Tasks 1/2/3. §4.1-4.2 (sort orders, assessment rules) → Task 2. §4.3 (confidence tier) → Task 2. §4.4 (monthly trend, ≥2-month filter) → Task 2. §4.5 (bad-bin Top3, no spatial claims) → Task 2 (data) + Task 5 (prompt guardrail). §5 (tool schema, handler wiring, prompt trigger keywords + guardrail) → Tasks 3/4/5. §6 (dummy-parity via single pure function) → structural, verified in Task 6. §7 (exclusions) → nothing to implement, confirmed by omission. §8 (file list) → matches Tasks 1-6 exactly. §9 (acceptance criteria 1-7) → covered by Task 2/3 tests + Task 6 manual verification.
- **Placeholder scan**: no TBD/TODO; the one place with bracketed text (`[实际分支名]`, `[实施日期]`) is inside the Task 6 handoff-doc template, which is explicitly marked as a template to be filled with real values discovered during Task 6 itself (branch name, commit hashes, actual pass/fail counts) — these are facts that don't exist until the branch is created and tests are run, not deferred design decisions.
- **Type consistency**: `PassGroupResult`, `ComboRankRow`, `CardRankRow`, `CardTrendRow`, `CardBadBinRow`, `ConfidenceTier` are defined once in Task 2 and referenced identically (same field names) in Task 3's handler code and Task 6's verification checklist. `computeProbeCardTesterPerformance(enrichedRows: Record<string, unknown>[]): PassGroupResult[]` signature is consistent between Task 2's export and Task 3's call site.
