# Yield Monitor 周期报警统计改为近4周/近4月趋势柱图 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `periodAlarm` section's "this period vs last period" KPI+ranking view with 5 vertical bar charts showing the last 4 weeks (or last 4 months) of trigger totals and per-dimension category counts, while keeping the old code intact but inert.

**Architecture:** Add a pure `recentPeriodBuckets()` bucket-generator to `pcr-ai-report/src/utils/yieldCalc.ts`. In `YieldMonitorReport.tsx`, add a new state/effect that fans out 16 (4 buckets × 4 dimensions) `YIELD_AGGREGATE_PATH` calls per period switch, derive per-bucket totals and distinct-category counts, and render them as 5 new vertical bar charts via a new `DraggableReportBlocks` grid. Gate all pre-existing period-alarm state/effect/JSX behind a `SHOW_LEGACY_PERIOD_CHARTS = false` constant so it's dead code, not deleted code.

**Tech Stack:** React 19 + TypeScript + Vite, ECharts (via `DarkChart`), no backend changes (reuses existing `hostname`/`probeCard`/`bin`/`dutNumber` v3/v4 aggregate dimensions).

## Global Constraints

- Spec: [`docs/superpowers/specs/2026-07-06-yield-monitor-period-trend-charts-design.md`](../specs/2026-07-06-yield-monitor-period-trend-charts-design.md). Every task's requirements implicitly include this spec.
- `pcr-ai-report` has **no unit test runner** (`package.json` has no `test` script; only `zod`'s own tests exist under `node_modules`). Verification is via `npm run build` (`tsc -b && vite build`, catches all type errors) plus, where noted, a standalone Node script (this machine's Node is v24.14.1, which executes `.ts` files directly with native type-stripping — confirmed working during planning) or a live Playwright check.
- Do not delete the existing `periodByTester`/`periodByCard`/`periodByBin`/`periodByDut`/`periodTotal`/`periodPrevTotal` state, the old period-fetch `useEffect`, the 4 old `useMemo` chart options, the ratio `useMemo`s, or the old KPI/chart JSX — gate them behind `SHOW_LEGACY_PERIOD_CHARTS = false` instead (per spec's "旧代码处理" section).
- Keep `REPORT_ORACLE_FANOUT_CONCURRENCY` (value `1`) as the concurrency for the new fetch fan-out — do not raise it.
- `groupTop` for the new per-bucket dimension calls must be `100` (the API's max), so `groups.length` approximates the true distinct-category count without truncation bias.
- `pcr-ai-report/tsconfig.app.json` has `noUnusedLocals: true` and `noUnusedParameters: true` — any variable/import you add must be referenced somewhere reachable by the compiler (this is exactly why the legacy code is *gated*, not removed from the render tree).

---

## File Structure

- **Modify** `pcr-ai-report/src/utils/yieldCalc.ts` — add `PeriodBucket` type + `recentPeriodBuckets()` pure function (Task 1).
- **Modify** `pcr-ai-report/src/reports/YieldMonitorReport.tsx` — new state, new fetch effect, new chart-option builders, new block-order/label constants, gate legacy code, replace `periodAlarmSection` JSX (Task 2).

No new files are created; no backend (`pcr-ai-api`) changes.

---

### Task 1: `recentPeriodBuckets()` pure function

**Files:**
- Modify: `pcr-ai-report/src/utils/yieldCalc.ts:307-329` (insert after the existing `periodWindow` function, before `formatBinLabel`)
- Verify: a standalone scratch script (not committed) run directly with Node

**Interfaces:**
- Produces: `export type PeriodBucket = { start: Date; end: Date; label: string }` and `export function recentPeriodBuckets(period: PeriodKey, count: number, now?: Date): PeriodBucket[]`, returned **oldest-to-newest**. `PeriodKey` already exists in this file (`"week" | "month"`). Task 2 imports both `recentPeriodBuckets` and `type PeriodBucket` from `../utils/yieldCalc`.

- [ ] **Step 1: Read the current end of the "Period window" section**

Open `pcr-ai-report/src/utils/yieldCalc.ts` and confirm lines 307-338 currently look like this (the exact text you'll anchor on):

```ts
// ── Period window (周/月报警统计) ────────────────────────────────────────

export type PeriodKey = "week" | "month";

/**
 * 当前周期窗口 + 等长的紧邻前一周期窗口（用于环比）。
 * 本周 = 最近 7 天；本月 = 自然月 1 日至今。
 * 环比窗口取与当前窗口等长的紧邻前段，使"本月至今 N 天" vs "上月同样 N 天"公平对比。
 */
export function periodWindow(
  period: PeriodKey,
  now: Date = new Date()
): { start: Date; end: Date; prevStart: Date; prevEnd: Date } {
  const end = now;
  const start =
    period === "week"
      ? new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
      : new Date(now.getFullYear(), now.getMonth(), 1);
  const durationMs = end.getTime() - start.getTime();
  const prevEnd = start;
  const prevStart = new Date(start.getTime() - durationMs);
  return { start, end, prevStart, prevEnd };
}

/** 派生聚合维度 `bin` 的展示格式：数字 → `BIN n`；`goodbin` → `GOODBIN`；空 → `(未知)`。 */
export function formatBinLabel(bin: string): string {
```

If the surrounding text differs (e.g. line numbers shifted), locate the function by name (`periodWindow`) instead of trusting the line numbers literally.

- [ ] **Step 2: Insert `PeriodBucket` + `recentPeriodBuckets` between `periodWindow`'s closing brace and the `formatBinLabel` doc comment**

Insert this new code immediately after `periodWindow`'s closing `}` and before the `/** 派生聚合维度 \`bin\`...` comment:

```ts

export type PeriodBucket = { start: Date; end: Date; label: string };

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatMonthDay(d: Date): string {
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
}

function formatYearMonth(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

/**
 * 近 `count` 个周期窗口，按时间从旧到新排列，供趋势柱图 x 轴使用。
 * week：`count` 个连续、不重叠的滚动 7 天窗口，最新一个是 `[now-7d, now]`。
 * month：`count` 个自然月窗口，最新一个是「本月 1 日至 now」（可能是不完整月份），
 * 其余为完整自然月。
 */
export function recentPeriodBuckets(
  period: PeriodKey,
  count: number,
  now: Date = new Date()
): PeriodBucket[] {
  const buckets: PeriodBucket[] = [];
  if (period === "week") {
    const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
    for (let i = 0; i < count; i++) {
      const end = new Date(now.getTime() - i * WEEK_MS);
      const start = new Date(end.getTime() - WEEK_MS);
      buckets.push({ start, end, label: `${formatMonthDay(start)}-${formatMonthDay(end)}` });
    }
  } else {
    for (let i = 0; i < count; i++) {
      const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const end = i === 0 ? now : new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      buckets.push({ start, end, label: formatYearMonth(start) });
    }
  }
  return buckets.reverse();
}
```

- [ ] **Step 3: Verify the bucket math with a standalone Node script (no test runner exists in this package)**

Write this to a scratch file (e.g. your session's scratchpad directory), not inside the repo:

```ts
type PeriodKey = "week" | "month";
type PeriodBucket = { start: Date; end: Date; label: string };

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
function formatMonthDay(d: Date): string {
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
}
function formatYearMonth(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}
function recentPeriodBuckets(period: PeriodKey, count: number, now: Date = new Date()): PeriodBucket[] {
  const buckets: PeriodBucket[] = [];
  if (period === "week") {
    const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
    for (let i = 0; i < count; i++) {
      const end = new Date(now.getTime() - i * WEEK_MS);
      const start = new Date(end.getTime() - WEEK_MS);
      buckets.push({ start, end, label: `${formatMonthDay(start)}-${formatMonthDay(end)}` });
    }
  } else {
    for (let i = 0; i < count; i++) {
      const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const end = i === 0 ? now : new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      buckets.push({ start, end, label: formatYearMonth(start) });
    }
  }
  return buckets.reverse();
}

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else {
    console.log("PASS:", msg);
  }
}

const NOW = new Date("2026-07-06T10:00:00.000Z");

const weekBuckets = recentPeriodBuckets("week", 4, NOW);
assert(weekBuckets.length === 4, "week: returns 4 buckets");
assert(weekBuckets[3].end.getTime() === NOW.getTime(), "week: newest bucket ends at now");
assert(
  weekBuckets[3].start.getTime() === NOW.getTime() - 7 * 24 * 60 * 60 * 1000,
  "week: newest bucket starts 7 days before now"
);
assert(
  weekBuckets[0].start.getTime() === NOW.getTime() - 28 * 24 * 60 * 60 * 1000,
  "week: oldest bucket starts 28 days before now"
);
assert(
  weekBuckets[0].end.getTime() === weekBuckets[1].start.getTime(),
  "week: buckets are contiguous between oldest and 2nd-oldest"
);
assert(
  weekBuckets.every((b) => b.end.getTime() - b.start.getTime() === 7 * 24 * 60 * 60 * 1000),
  "week: every bucket spans exactly 7 days"
);
console.log("week labels:", weekBuckets.map((b) => b.label));

const monthBuckets = recentPeriodBuckets("month", 4, NOW);
assert(monthBuckets.length === 4, "month: returns 4 buckets");
assert(
  monthBuckets[3].end.getTime() === NOW.getTime(),
  "month: newest bucket ends at now (partial current month)"
);
assert(
  monthBuckets[3].start.getTime() === new Date(2026, 6, 1).getTime(),
  "month: newest bucket starts 2026-07-01"
);
assert(
  monthBuckets[0].start.getTime() === new Date(2026, 3, 1).getTime(),
  "month: oldest bucket starts 2026-04-01 (3 months back)"
);
assert(
  monthBuckets[0].end.getTime() === monthBuckets[1].start.getTime(),
  "month: buckets are contiguous between oldest and 2nd-oldest"
);
console.log("month labels:", monthBuckets.map((b) => b.label));

console.log("done");
```

Run it (adjust the scratch path to wherever you saved it):

```bash
"/c/Program Files/nodejs/node.exe" /path/to/scratch/verify_recent_period_buckets.ts
```

Expected: every line printed is `PASS: ...`, the two `console.log` label lines print
`week labels: [ '06/08-06/15', '06/15-06/22', '06/22-06/29', '06/29-07/06' ]` and
`month labels: [ '2026-04', '2026-05', '2026-06', '2026-07' ]`, and the final line is `done` with no `FAIL:` lines and no non-zero exit code.

- [ ] **Step 4: Typecheck the real file**

```bash
cd pcr-ai-report && npm run build
```

Expected: exits 0, no TypeScript errors in `yieldCalc.ts`.

- [ ] **Step 5: Commit**

```bash
git add pcr-ai-report/src/utils/yieldCalc.ts
git commit -m "feat(report): add recentPeriodBuckets for last-N-period trend charts"
```

---

### Task 2: Wire the 5 trend charts into `YieldMonitorReport.tsx`, gate the legacy period-alarm code

**Files:**
- Modify: `pcr-ai-report/src/reports/YieldMonitorReport.tsx` (import block, module-level constants, component state, effects, `useMemo` chart options, `periodAlarmSection` JSX, `yieldReportSections` dependency array)
- Test: no unit test (see Global Constraints); verify via `npm run build` + a live Playwright check (see Step 8)

**Interfaces:**
- Consumes: `recentPeriodBuckets(period: PeriodKey, count: number, now?: Date): PeriodBucket[]` and `type PeriodBucket` from Task 1 (`../utils/yieldCalc`); existing `YieldMonitorV3AggregateResponse`, `apiGetJson`, `YIELD_AGGREGATE_PATH`, `allSettledWithConcurrency`, `REPORT_ORACLE_FANOUT_CONCURRENCY`, `DarkChart`, `DraggableReportBlocks`, `getChartPalette`, `baseChartOption`, `yieldTrendChartGrid`, `YIELD_TREND_CHART_HEIGHT`, `selectionTierColors` — all already imported in this file.
- Produces: nothing consumed by later tasks (this is the last task in the plan).

- [ ] **Step 1: Add `recentPeriodBuckets` / `PeriodBucket` to the existing `yieldCalc` import**

Find this import (near the top of the file):

```ts
import {
  buildTree,
  dateShortcutLast7Days,
  dateShortcutThisMonth,
  dateShortcutToday,
  formatBinLabel,
  parseDutNumber,
  periodWindow,
  tallyDutNumbers,
  type PeriodKey,
} from "../utils/yieldCalc";
```

Replace it with:

```ts
import {
  buildTree,
  dateShortcutLast7Days,
  dateShortcutThisMonth,
  dateShortcutToday,
  formatBinLabel,
  parseDutNumber,
  periodWindow,
  recentPeriodBuckets,
  tallyDutNumbers,
  type PeriodBucket,
  type PeriodKey,
} from "../utils/yieldCalc";
```

- [ ] **Step 2: Add new module-level constants and the `TrendPoint` type**

Find:

```ts
const YIELD_ALARM_CHART_BLOCK_ORDER = [
  "chAlarmTester",
  "chAlarmCard",
  "chAlarmBin",
  "chAlarmDut",
] as const;

// Sub-dimension options for drill-down panels
```

Replace it with:

```ts
const YIELD_ALARM_CHART_BLOCK_ORDER = [
  "chAlarmTester",
  "chAlarmCard",
  "chAlarmBin",
  "chAlarmDut",
] as const;

/** 旧版「单周期 Top10 + 环比」KPI/图表保留代码但不再展示，见 periodAlarmSection 内的用法。 */
const SHOW_LEGACY_PERIOD_CHARTS = false;

const YIELD_ALARM_TREND_CHART_BLOCK_ORDER = [
  "chAlarmTotalTrend",
  "chAlarmTesterTrend",
  "chAlarmCardTrend",
  "chAlarmBinTrend",
  "chAlarmDutTrend",
] as const;

/** 每个趋势桶要请求的聚合维度：用于统计该维度当期出现的不同类别数。 */
const TREND_DIMENSIONS = ["hostname", "probeCard", "bin", "dutNumber"] as const;

/** 趋势桶聚合请求的 groupTop：取 API 允许的最大值，让 groups.length 尽量准确反映真实类别数。 */
const TREND_GROUP_TOP = 100;

type TrendPoint = {
  bucket: PeriodBucket;
  total: number | null;
  testerCount: number | null;
  cardCount: number | null;
  binCount: number | null;
  dutCount: number | null;
};

// Sub-dimension options for drill-down panels
```

- [ ] **Step 3: Add `buildTrendBarOption`, right before the component function**

Find:

```ts
export function YieldMonitorReport({ apiBase, listLimits }: Props) {
```

Insert immediately before it (after the existing `buildRankBarOption` function):

```ts
/** 近 N 期趋势柱图（竖版）：x 轴为周期桶 label，y 轴为对应数值（null 按 0 展示）。 */
function buildTrendBarOption(
  theme: "light" | "dark",
  buckets: PeriodBucket[],
  values: (number | null)[],
  color: string
): EChartsOption {
  const palette = getChartPalette(theme);
  return {
    ...baseChartOption(theme),
    grid: yieldTrendChartGrid,
    xAxis: {
      type: "category",
      data: buckets.map((b) => b.label),
      axisLabel: { color: palette.axisColor, fontSize: 10 },
    },
    yAxis: {
      type: "value",
      axisLabel: { color: palette.axisColor },
      splitLine: { lineStyle: { color: palette.splitLine } },
    },
    series: [
      {
        type: "bar",
        data: values.map((v) => v ?? 0),
        itemStyle: { color, borderRadius: [4, 4, 0, 0] as unknown as number },
        label: { show: true, position: "top", color: palette.axisColor, fontSize: 10 },
        animationDuration: 600,
      },
    ],
    tooltip: { trigger: "axis" },
  };
}

```

- [ ] **Step 4: Add new state right after the existing period-alarm state**

Find:

```ts
  const [loadingPeriod, setLoadingPeriod] = useState(false);
  const [errorPeriod, setErrorPeriod] = useState<string | null>(null);
```

Replace it with:

```ts
  const [loadingPeriod, setLoadingPeriod] = useState(false);
  const [errorPeriod, setErrorPeriod] = useState<string | null>(null);
  const [trendPoints, setTrendPoints] = useState<TrendPoint[]>([]);
  const [loadingTrend, setLoadingTrend] = useState(false);
  const [errorTrend, setErrorTrend] = useState<string | null>(null);
```

- [ ] **Step 5: Gate the legacy period-fetch effect so it stops making network calls**

Find the existing effect that starts with:

```ts
  useEffect(() => {
    let cancelled = false;
    const { start, end, prevStart, prevEnd } = periodWindow(period);
```

Replace just the opening two lines with:

```ts
  useEffect(() => {
    if (!SHOW_LEGACY_PERIOD_CHARTS) return;
    let cancelled = false;
    const { start, end, prevStart, prevEnd } = periodWindow(period);
```

Leave the rest of that effect (through its `}, [apiBase, appliedCoreParams, period]);` closing line) untouched.

- [ ] **Step 6: Add the new trend-fetch effect, right after the legacy effect and before the "KPI derivations" divider**

Find:

```ts
    return () => {
      cancelled = true;
    };
  }, [apiBase, appliedCoreParams, period]);

  // ── KPI derivations ──────────────────────────────────────────────────────
```

Replace it with (this inserts a brand-new effect between the legacy effect's closing and the KPI-derivations comment — the legacy effect's own closing lines are reproduced unchanged at the top of this block so the anchor stays unique):

```ts
    return () => {
      cancelled = true;
    };
  }, [apiBase, appliedCoreParams, period]);

  useEffect(() => {
    let cancelled = false;
    const buckets = recentPeriodBuckets(period, 4);
    setLoadingTrend(true);
    setErrorTrend(null);

    (async () => {
      const calls: (() => Promise<YieldMonitorV3AggregateResponse>)[] = [];
      for (const bucket of buckets) {
        const bucketParams = {
          ...appliedCoreParams,
          timeStampFrom: bucket.start.toISOString(),
          timeStampTo: bucket.end.toISOString(),
        };
        for (const dim of TREND_DIMENSIONS) {
          calls.push(() =>
            apiGetJson<YieldMonitorV3AggregateResponse>(apiBase, YIELD_AGGREGATE_PATH, {
              ...bucketParams,
              dimensions: dim,
              groupTop: TREND_GROUP_TOP,
            })
          );
        }
      }

      const settled = (await allSettledWithConcurrency(
        calls,
        REPORT_ORACLE_FANOUT_CONCURRENCY
      )) as PromiseSettledResult<YieldMonitorV3AggregateResponse>[];
      if (cancelled) return;
      setLoadingTrend(false);

      const points: TrendPoint[] = buckets.map((bucket, i) => {
        const [testerRes, cardRes, binRes, dutRes] = settled.slice(i * 4, i * 4 + 4);
        const ok = (r: PromiseSettledResult<YieldMonitorV3AggregateResponse>) =>
          r.status === "fulfilled" ? r.value : null;
        const tester = ok(testerRes);
        const card = ok(cardRes);
        const bin = ok(binRes);
        const dut = ok(dutRes);
        const total =
          tester?.totalRowsMatching ??
          card?.totalRowsMatching ??
          bin?.totalRowsMatching ??
          dut?.totalRowsMatching ??
          null;
        return {
          bucket,
          total,
          testerCount: tester ? tester.groups.length : null,
          cardCount: card ? card.groups.length : null,
          binCount: bin ? bin.groups.length : null,
          dutCount: dut ? dut.groups.length : null,
        };
      });
      setTrendPoints(points);

      const firstRejected = settled.find((r) => r.status === "rejected") as
        | PromiseRejectedResult
        | undefined;
      setErrorTrend(
        firstRejected
          ? firstRejected.reason instanceof Error
            ? firstRejected.reason.message
            : String(firstRejected.reason)
          : null
      );
    })();

    return () => {
      cancelled = true;
    };
  }, [apiBase, appliedCoreParams, period]);

  // ── KPI derivations ──────────────────────────────────────────────────────
```

- [ ] **Step 7: Add the new chart-option `useMemo`s, right after the legacy `periodDutOption` and before `periodRatioPct`**

Find:

```ts
  const periodDutOption = useMemo(
    () =>
      buildRankBarOption(
        theme,
        periodByDut?.groups ?? [],
        "dutNumber",
        selectionTierColors(theme, "orange").base,
        (v) => `dut#${v}`
      ),
    [periodByDut, theme]
  );

  const periodRatioPct = useMemo(() => {
```

Replace it with:

```ts
  const periodDutOption = useMemo(
    () =>
      buildRankBarOption(
        theme,
        periodByDut?.groups ?? [],
        "dutNumber",
        selectionTierColors(theme, "orange").base,
        (v) => `dut#${v}`
      ),
    [periodByDut, theme]
  );

  const trendBuckets = useMemo(() => trendPoints.map((p) => p.bucket), [trendPoints]);
  const trendTotalOption = useMemo(
    () =>
      buildTrendBarOption(
        theme,
        trendBuckets,
        trendPoints.map((p) => p.total),
        selectionTierColors(theme, "gold").base
      ),
    [trendBuckets, trendPoints, theme]
  );
  const trendTesterOption = useMemo(
    () =>
      buildTrendBarOption(theme, trendBuckets, trendPoints.map((p) => p.testerCount), chartPalette.accent),
    [trendBuckets, trendPoints, theme, chartPalette.accent]
  );
  const trendCardOption = useMemo(
    () =>
      buildTrendBarOption(theme, trendBuckets, trendPoints.map((p) => p.cardCount), chartPalette.accent2),
    [trendBuckets, trendPoints, theme, chartPalette.accent2]
  );
  const trendBinOption = useMemo(
    () =>
      buildTrendBarOption(theme, trendBuckets, trendPoints.map((p) => p.binCount), chartPalette.accent3),
    [trendBuckets, trendPoints, theme, chartPalette.accent3]
  );
  const trendDutOption = useMemo(
    () =>
      buildTrendBarOption(
        theme,
        trendBuckets,
        trendPoints.map((p) => p.dutCount),
        selectionTierColors(theme, "orange").base
      ),
    [trendBuckets, trendPoints, theme]
  );

  const periodRatioPct = useMemo(() => {
```

- [ ] **Step 8: Replace the `periodAlarmSection` JSX**

Find the whole `periodAlarmSection` block (it starts with `const periodAlarmSection = (` inside the `yieldReportSections` `useMemo`, right after `const chips = useMemo(...)` and `const hasData = ...`):

```tsx
    const periodAlarmSection = (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="preset-chips">
          {(["week", "month"] as const).map((p) => (
            <button
              key={p}
              type="button"
              className={`chip${period === p ? " chip--active" : ""}`}
              onClick={() => setPeriod(p)}
            >
              {p === "week" ? "本周" : "本月"}
            </button>
          ))}
        </div>
        <DraggableReportBlocks
          storageKey="pcr-ai-report:yield-monitor-alarm-kpi-blocks"
          defaultOrder={YIELD_ALARM_KPI_BLOCK_ORDER}
          layoutEpoch={layoutEpoch}
          axis="x"
          groupClassName="report-reorder-group--kpis"
          labels={{
            kpiAlarmTotal: "总触发次数",
            kpiAlarmRatio: "环比变化率",
          }}
          sections={{
            kpiAlarmTotal: (
              <KpiCard
                label="总触发次数"
                value={periodTotal}
                color="blue"
                subtext={periodPrevTotal !== null ? `上一周期 ${periodPrevTotal} 次` : undefined}
                showLabel={false}
              />
            ),
            kpiAlarmRatio: (
              <KpiCard
                label="环比变化率"
                value={periodRatioLabel}
                color={periodRatioColor}
                subtext="vs 上一周期"
                showLabel={false}
              />
            ),
          }}
        />
        {errorPeriod && (
          <div style={{ color: "var(--red-text)", fontSize: 12 }}>{errorPeriod}</div>
        )}
        <DraggableReportBlocks
          storageKey="pcr-ai-report:yield-monitor-alarm-chart-blocks"
          defaultOrder={YIELD_ALARM_CHART_BLOCK_ORDER}
          layoutEpoch={layoutEpoch}
          axis="grid"
          groupClassName="report-reorder-group--chartgrid"
          labels={{
            chAlarmTester: "Tester 分布",
            chAlarmCard: "Probe Card 分布",
            chAlarmBin: "Bin 分布",
            chAlarmDut: "DUT 分布",
          }}
          sections={{
            chAlarmTester: (
              <div className="report-chart-panel chart-no-drill">
                {loadingPeriod ? (
                  <div style={{ color: "var(--muted)", fontSize: 13, padding: "8px 0" }}>加载中…</div>
                ) : (periodByTester?.groups.length ?? 0) === 0 ? (
                  <div style={{ color: "var(--muted)", fontSize: 13, padding: "8px 0" }}>该周期无触发记录</div>
                ) : (
                  <DarkChart
                    option={periodTesterOption}
                    height={rankBarChartHeight(periodByTester?.groups.length ?? 0, 10)}
                  />
                )}
              </div>
            ),
            chAlarmCard: (
              <div className="report-chart-panel chart-no-drill">
                {loadingPeriod ? (
                  <div style={{ color: "var(--muted)", fontSize: 13, padding: "8px 0" }}>加载中…</div>
                ) : (periodByCard?.groups.length ?? 0) === 0 ? (
                  <div style={{ color: "var(--muted)", fontSize: 13, padding: "8px 0" }}>该周期无触发记录</div>
                ) : (
                  <DarkChart
                    option={periodCardOption}
                    height={rankBarChartHeight(periodByCard?.groups.length ?? 0, 10)}
                  />
                )}
              </div>
            ),
            chAlarmBin: (
              <div className="report-chart-panel chart-no-drill">
                {loadingPeriod ? (
                  <div style={{ color: "var(--muted)", fontSize: 13, padding: "8px 0" }}>加载中…</div>
                ) : (periodByBin?.groups.length ?? 0) === 0 ? (
                  <div style={{ color: "var(--muted)", fontSize: 13, padding: "8px 0" }}>该周期无触发记录</div>
                ) : (
                  <DarkChart
                    option={periodBinOption}
                    height={rankBarChartHeight(periodByBin?.groups.length ?? 0, 10)}
                  />
                )}
              </div>
            ),
            chAlarmDut: (
              <div className="report-chart-panel chart-no-drill">
                {loadingPeriod ? (
                  <div style={{ color: "var(--muted)", fontSize: 13, padding: "8px 0" }}>加载中…</div>
                ) : (periodByDut?.groups.length ?? 0) === 0 ? (
                  <div style={{ color: "var(--muted)", fontSize: 13, padding: "8px 0" }}>该周期无触发记录</div>
                ) : (
                  <DarkChart
                    option={periodDutOption}
                    height={rankBarChartHeight(periodByDut?.groups.length ?? 0, 10)}
                  />
                )}
              </div>
            ),
          }}
        />
      </div>
    );
```

Replace it with:

```tsx
    const periodAlarmSection = (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="preset-chips">
          {(["week", "month"] as const).map((p) => (
            <button
              key={p}
              type="button"
              className={`chip${period === p ? " chip--active" : ""}`}
              onClick={() => setPeriod(p)}
            >
              {p === "week" ? "本周" : "本月"}
            </button>
          ))}
        </div>
        {SHOW_LEGACY_PERIOD_CHARTS && (
          <>
            <DraggableReportBlocks
              storageKey="pcr-ai-report:yield-monitor-alarm-kpi-blocks"
              defaultOrder={YIELD_ALARM_KPI_BLOCK_ORDER}
              layoutEpoch={layoutEpoch}
              axis="x"
              groupClassName="report-reorder-group--kpis"
              labels={{
                kpiAlarmTotal: "总触发次数",
                kpiAlarmRatio: "环比变化率",
              }}
              sections={{
                kpiAlarmTotal: (
                  <KpiCard
                    label="总触发次数"
                    value={periodTotal}
                    color="blue"
                    subtext={periodPrevTotal !== null ? `上一周期 ${periodPrevTotal} 次` : undefined}
                    showLabel={false}
                  />
                ),
                kpiAlarmRatio: (
                  <KpiCard
                    label="环比变化率"
                    value={periodRatioLabel}
                    color={periodRatioColor}
                    subtext="vs 上一周期"
                    showLabel={false}
                  />
                ),
              }}
            />
            {errorPeriod && (
              <div style={{ color: "var(--red-text)", fontSize: 12 }}>{errorPeriod}</div>
            )}
            <DraggableReportBlocks
              storageKey="pcr-ai-report:yield-monitor-alarm-chart-blocks"
              defaultOrder={YIELD_ALARM_CHART_BLOCK_ORDER}
              layoutEpoch={layoutEpoch}
              axis="grid"
              groupClassName="report-reorder-group--chartgrid"
              labels={{
                chAlarmTester: "Tester 分布",
                chAlarmCard: "Probe Card 分布",
                chAlarmBin: "Bin 分布",
                chAlarmDut: "DUT 分布",
              }}
              sections={{
                chAlarmTester: (
                  <div className="report-chart-panel chart-no-drill">
                    {loadingPeriod ? (
                      <div style={{ color: "var(--muted)", fontSize: 13, padding: "8px 0" }}>加载中…</div>
                    ) : (periodByTester?.groups.length ?? 0) === 0 ? (
                      <div style={{ color: "var(--muted)", fontSize: 13, padding: "8px 0" }}>该周期无触发记录</div>
                    ) : (
                      <DarkChart
                        option={periodTesterOption}
                        height={rankBarChartHeight(periodByTester?.groups.length ?? 0, 10)}
                      />
                    )}
                  </div>
                ),
                chAlarmCard: (
                  <div className="report-chart-panel chart-no-drill">
                    {loadingPeriod ? (
                      <div style={{ color: "var(--muted)", fontSize: 13, padding: "8px 0" }}>加载中…</div>
                    ) : (periodByCard?.groups.length ?? 0) === 0 ? (
                      <div style={{ color: "var(--muted)", fontSize: 13, padding: "8px 0" }}>该周期无触发记录</div>
                    ) : (
                      <DarkChart
                        option={periodCardOption}
                        height={rankBarChartHeight(periodByCard?.groups.length ?? 0, 10)}
                      />
                    )}
                  </div>
                ),
                chAlarmBin: (
                  <div className="report-chart-panel chart-no-drill">
                    {loadingPeriod ? (
                      <div style={{ color: "var(--muted)", fontSize: 13, padding: "8px 0" }}>加载中…</div>
                    ) : (periodByBin?.groups.length ?? 0) === 0 ? (
                      <div style={{ color: "var(--muted)", fontSize: 13, padding: "8px 0" }}>该周期无触发记录</div>
                    ) : (
                      <DarkChart
                        option={periodBinOption}
                        height={rankBarChartHeight(periodByBin?.groups.length ?? 0, 10)}
                      />
                    )}
                  </div>
                ),
                chAlarmDut: (
                  <div className="report-chart-panel chart-no-drill">
                    {loadingPeriod ? (
                      <div style={{ color: "var(--muted)", fontSize: 13, padding: "8px 0" }}>加载中…</div>
                    ) : (periodByDut?.groups.length ?? 0) === 0 ? (
                      <div style={{ color: "var(--muted)", fontSize: 13, padding: "8px 0" }}>该周期无触发记录</div>
                    ) : (
                      <DarkChart
                        option={periodDutOption}
                        height={rankBarChartHeight(periodByDut?.groups.length ?? 0, 10)}
                      />
                    )}
                  </div>
                ),
              }}
            />
          </>
        )}
        {errorTrend && (
          <div style={{ color: "var(--red-text)", fontSize: 12 }}>{errorTrend}</div>
        )}
        <DraggableReportBlocks
          storageKey="pcr-ai-report:yield-monitor-alarm-trend-chart-blocks"
          defaultOrder={YIELD_ALARM_TREND_CHART_BLOCK_ORDER}
          layoutEpoch={layoutEpoch}
          axis="grid"
          groupClassName="report-reorder-group--chartgrid"
          labels={{
            chAlarmTotalTrend: "总触发次数趋势",
            chAlarmTesterTrend: "Tester 数趋势",
            chAlarmCardTrend: "Probe Card 数趋势",
            chAlarmBinTrend: "Bin 种类数趋势",
            chAlarmDutTrend: "DUT 编号数趋势",
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
            chAlarmBinTrend: (
              <div className="report-chart-panel chart-no-drill">
                {loadingTrend ? (
                  <div style={{ color: "var(--muted)", fontSize: 13, padding: "8px 0" }}>加载中…</div>
                ) : (
                  <DarkChart option={trendBinOption} height={YIELD_TREND_CHART_HEIGHT} />
                )}
              </div>
            ),
            chAlarmDutTrend: (
              <div className="report-chart-panel chart-no-drill">
                {loadingTrend ? (
                  <div style={{ color: "var(--muted)", fontSize: 13, padding: "8px 0" }}>加载中…</div>
                ) : (
                  <DarkChart option={trendDutOption} height={YIELD_TREND_CHART_HEIGHT} />
                )}
              </div>
            ),
          }}
        />
      </div>
    );
```

- [ ] **Step 9: Extend the `yieldReportSections` `useMemo` dependency array**

Find the end of the dependency array:

```ts
    periodTesterOption,
    periodCardOption,
    periodBinOption,
    periodDutOption,
    loadingPeriod,
    errorPeriod,
  ]);
```

Replace it with:

```ts
    periodTesterOption,
    periodCardOption,
    periodBinOption,
    periodDutOption,
    loadingPeriod,
    errorPeriod,
    trendPoints,
    trendBuckets,
    trendTotalOption,
    trendTesterOption,
    trendCardOption,
    trendBinOption,
    trendDutOption,
    loadingTrend,
    errorTrend,
  ]);
```

- [ ] **Step 10: Typecheck and build**

```bash
cd pcr-ai-report && npm run build
```

Expected: exits 0, no TypeScript errors (in particular, no `noUnusedLocals` complaints — if you see one, it means some legacy identifier is no longer referenced anywhere, including inside the `{SHOW_LEGACY_PERIOD_CHARTS && (...)}` block; check you copied that whole block over, not a subset).

- [ ] **Step 11: Live verification with Playwright (`example-skills:webapp-testing`)**

Start the dev servers if not already running (`pcr-ai-api` with `npm run dev`, `pcr-ai-report` with `npm run dev`), open the report in a Playwright-driven browser, go to the **Yield Monitor** tab, run a query, and confirm:
1. The 「周期报警统计」section shows **only**: the 本周/本月 chip row, then 5 chart panels titled 总触发次数趋势 / Tester 数趋势 / Probe Card 数趋势 / Bin 种类数趋势 / DUT 编号数趋势 — no KPI cards, no "环比变化率", no "Tester 分布"/"Probe Card 分布" ranking charts.
2. Each of the 5 charts renders 4 vertical bars.
3. Clicking **本月** switches all 5 x-axes from `MM/DD-MM/DD` week-range labels to `YYYY-MM` month labels, and the charts refresh (show "加载中…" briefly, then bars).
4. No console errors during the load or the 本周/本月 toggle.

Take at least one screenshot of the section in both 本周 and 本月 modes and visually confirm axis labels and bar counts match the above (ECharts renders to `<canvas>`, so use screenshots, not `page.content()` text search, to confirm chart content — a prior session in this repo hit exactly this pitfall).

- [ ] **Step 12: Commit**

```bash
git add pcr-ai-report/src/reports/YieldMonitorReport.tsx
git commit -m "feat(report): replace period-alarm KPI/ranking view with 4-period trend bar charts"
```

---

## Self-Review Notes (already applied above)

- **Spec coverage:** bucket generation (Task 1), 16-call fan-out with `groupTop=100`, total via any dimension's `totalRowsMatching`, distinct-category count via `groups.length`, no KPI cards, 5 new `DraggableReportBlocks` grid with a fresh storage key, legacy code gated (not deleted) behind `SHOW_LEGACY_PERIOD_CHARTS` including the legacy effect no longer firing network calls — all covered by Task 2.
- **Type consistency:** `PeriodBucket`, `recentPeriodBuckets`, `TrendPoint`, `trendBuckets`, `trendTotal/TesterCount/CardCount/BinCount/DutCount`, `buildTrendBarOption`, `TREND_DIMENSIONS`, `TREND_GROUP_TOP`, `YIELD_ALARM_TREND_CHART_BLOCK_ORDER` are named identically everywhere they appear across Task 1 and Task 2.
- **No placeholders:** every step has complete, verified code (Task 1's bucket math was executed against Node v24.14.1 during planning and all assertions passed).
