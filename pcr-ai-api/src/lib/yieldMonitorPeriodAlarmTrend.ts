import type { BindParameters } from "oracledb";
import {
  parseYieldMonitorTriggerActivityQuery,
  parseYieldMonitorTriggerV3Query,
  YIELD_MONITOR_V3_TYPE_SCOPE,
} from "./yieldMonitorTriggerFilters.js";
import {
  filterYieldMonitorDummyRowsMatchingActivity,
  filterYieldMonitorDummyRowsMatchingV3,
  yieldMonitorDummyTimeOffsetMs,
  type YieldMonitorTriggerDummyRow,
} from "./yieldMonitorTriggerDummy.js";
import { parseBinFromTriggerLabel } from "./yieldTriggerLabelBin.js";
import { parseDutNumberFromTriggerLabel } from "./yieldTriggerLabelDut.js";

export type PeriodKey = "week" | "month";

export type PeriodAlarmBucket = {
  start: Date;
  end: Date;
  label: string;
};

export type PeriodAlarmTopTester = {
  hostname: string;
  count: number;
};

export type PeriodAlarmTrendPoint = {
  label: string;
  timeStampFrom: string;
  timeStampTo: string;
  total: number;
  testerCount: number;
  cardCount: number;
  /** distinct bin kinds excluding goodbin and empty */
  binCount: number;
  /** distinct dut# excluding empty */
  dutCount: number;
  /** delta_diff 报警触发次数（= total；分子） */
  testerAlarmNumerator: number;
  /** 同期同筛选、该桶内出过报警的 tester 在 YM 全 TYPE 记录总数（分母） */
  testerActivityTotal: number;
  /** testerAlarmNumerator / testerActivityTotal；分母为 0 时为 null */
  testerAlarmRate: number | null;
  /** 该桶触发次数 Top N 的 tester（按 count 降序） */
  topTesters: PeriodAlarmTopTester[];
};

export const PERIOD_ALARM_TOP_TESTERS_LIMIT = 5;

export const PERIOD_ALARM_TREND_BUCKET_COUNT = 4;
export const PERIOD_ALARM_MAX_WEEK_BUCKETS = 54;
export const PERIOD_ALARM_MAX_MONTH_BUCKETS = 24;

const PERIOD_ALARM_TIME_KEYS = [
  "timeStampBegin",
  "timeStampFrom",
  "timeStampEnd",
  "timeStampTo",
] as const;

const BIN_EXPR =
  "LOWER(REGEXP_SUBSTR(t.TRIGGER_LABEL, 'Bin#\\s*([0-9]+|goodbin)', 1, 1, 'i', 1))";
const DUT_EXPR =
  "REGEXP_SUBSTR(t.TRIGGER_LABEL, 'on\\s+dut#\\s*([0-9]+)', 1, 1, 'i', 1)";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatMonthDay(d: Date): string {
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
}

function formatYearMonth(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

/** 与前端 `yieldCalc.recentPeriodBuckets` 一致。 */
export function recentPeriodBuckets(
  period: PeriodKey,
  count: number,
  now: Date = new Date()
): PeriodAlarmBucket[] {
  const buckets: PeriodAlarmBucket[] = [];
  if (period === "week") {
    const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
    for (let i = 0; i < count; i++) {
      const end = new Date(now.getTime() - i * WEEK_MS);
      const start = new Date(end.getTime() - WEEK_MS);
      buckets.push({
        start,
        end,
        label: `${formatMonthDay(start)}-${formatMonthDay(end)}`,
      });
    }
  } else {
    for (let i = 0; i < count; i++) {
      const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const end =
        i === 0 ? now : new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      const label =
        i === 0 ? `${formatYearMonth(start)}(至今)` : formatYearMonth(start);
      buckets.push({ start, end, label });
    }
  }
  return buckets.reverse();
}

function parseOptionalDateParam(raw: unknown, label: string): Date | undefined {
  const s = firstString(raw);
  if (s === undefined) return undefined;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid date for ${label}`);
  }
  return d;
}

function hasPeriodAlarmTimeFilter(q: Record<string, unknown>): boolean {
  return PERIOD_ALARM_TIME_KEYS.some(
    (k) => firstString(firstQueryValue(q, k)) !== undefined
  );
}

function defaultPeriodAlarmRange(now: Date): { from: Date; to: Date } {
  const hi = now;
  const lo = new Date(hi.getTime());
  lo.setUTCFullYear(lo.getUTCFullYear() - 1);
  return { from: lo, to: hi };
}

/** 与查询区 TIME_STAMP 一致；未传时间窗时默认近 1 UTC 年（锚点 `now`）。 */
export function resolvePeriodAlarmTimeRange(
  q: Record<string, unknown>,
  now: Date = new Date()
): { ok: true; from: Date; to: Date } | { ok: false; error: string } {
  try {
    if (!hasPeriodAlarmTimeFilter(q)) {
      return { ok: true, ...defaultPeriodAlarmRange(now) };
    }

    const tsFrom =
      parseOptionalDateParam(firstQueryValue(q, "timeStampBegin"), "timeStampBegin") ??
      parseOptionalDateParam(firstQueryValue(q, "timeStampFrom"), "timeStampFrom");
    const tsTo =
      parseOptionalDateParam(firstQueryValue(q, "timeStampEnd"), "timeStampEnd") ??
      parseOptionalDateParam(firstQueryValue(q, "timeStampTo"), "timeStampTo");

    if (tsFrom !== undefined && tsTo !== undefined && tsFrom > tsTo) {
      return { ok: false, error: "timeStampFrom must be <= timeStampTo" };
    }

    if (tsFrom === undefined && tsTo === undefined) {
      return { ok: true, ...defaultPeriodAlarmRange(now) };
    }

    if (tsFrom !== undefined && tsTo !== undefined) {
      return { ok: true, from: tsFrom, to: tsTo };
    }

    if (tsFrom !== undefined) {
      return { ok: true, from: tsFrom, to: now };
    }

    const to = tsTo!;
    const from = new Date(to.getTime());
    from.setUTCFullYear(from.getUTCFullYear() - 1);
    return { ok: true, from, to };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: message };
  }
}

export type PeriodBucketsInRangeResult =
  | { ok: true; buckets: PeriodAlarmBucket[] }
  | { ok: false; error: string };

/**
 * 在 `[rangeFrom, rangeTo]` 内按周/月切分 x 轴桶（与前端 `yieldCalc.periodBucketsInRange` 一致）。
 */
export function periodBucketsInRange(
  period: PeriodKey,
  rangeFrom: Date,
  rangeTo: Date
): PeriodBucketsInRangeResult {
  if (rangeFrom.getTime() >= rangeTo.getTime()) {
    return { ok: false, error: "time range must span a positive duration" };
  }

  const buckets: PeriodAlarmBucket[] = [];

  if (period === "week") {
    const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
    let cursor = rangeFrom.getTime();
    const endMs = rangeTo.getTime();
    while (cursor < endMs) {
      const bucketEndMs = Math.min(cursor + WEEK_MS, endMs);
      const start = new Date(cursor);
      const end = new Date(bucketEndMs);
      buckets.push({
        start,
        end,
        label: `${formatMonthDay(start)}-${formatMonthDay(end)}`,
      });
      cursor = bucketEndMs;
      if (buckets.length > PERIOD_ALARM_MAX_WEEK_BUCKETS) {
        return {
          ok: false,
          error: `time range spans more than ${PERIOD_ALARM_MAX_WEEK_BUCKETS} weeks; narrow TIME_STAMP filter`,
        };
      }
    }
  } else {
    let y = rangeFrom.getFullYear();
    let m = rangeFrom.getMonth();
    while (true) {
      const monthStart = new Date(y, m, 1);
      if (monthStart.getTime() >= rangeTo.getTime()) break;
      const monthEndExclusive = new Date(y, m + 1, 1);
      const start =
        monthStart.getTime() < rangeFrom.getTime() ? rangeFrom : monthStart;
      const end =
        monthEndExclusive.getTime() > rangeTo.getTime() ? rangeTo : monthEndExclusive;
      if (start.getTime() < end.getTime()) {
        buckets.push({
          start,
          end,
          label: formatYearMonth(monthStart),
        });
      }
      if (buckets.length > PERIOD_ALARM_MAX_MONTH_BUCKETS) {
        return {
          ok: false,
          error: `time range spans more than ${PERIOD_ALARM_MAX_MONTH_BUCKETS} months; narrow TIME_STAMP filter`,
        };
      }
      m += 1;
      if (m > 11) {
        m = 0;
        y += 1;
      }
    }
  }

  if (buckets.length === 0) {
    return { ok: false, error: "time range produced no period buckets" };
  }
  return { ok: true, buckets };
}

export type ParsePeriodAlarmTrendOk = {
  ok: true;
  period: PeriodKey;
  now: Date;
  buckets: PeriodAlarmBucket[];
  /** delta_diff 报警 WHERE（Top tester 子查询） */
  whereSql: string;
  /** 全 TYPE 活动量 WHERE（主趋势扫描） */
  activityWhereSql: string;
  alarmBinds: BindParameters;
  activityBinds: BindParameters;
  applied: Record<string, unknown>;
};

export type ParsePeriodAlarmTrendFail = { ok: false; error: string };

function firstQueryValue(q: Record<string, unknown>, key: string): unknown {
  const v = q[key];
  if (v !== undefined) return v;
  const lower = key.toLowerCase();
  for (const [k, val] of Object.entries(q)) {
    if (k.toLowerCase() === lower) return val;
  }
  return undefined;
}

function firstString(raw: unknown): string | undefined {
  if (raw == null) return undefined;
  if (typeof raw === "string") return raw.trim() === "" ? undefined : raw;
  if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === "string") {
    return raw[0].trim() === "" ? undefined : raw[0];
  }
  return undefined;
}

function parseNowParam(raw: unknown): Date | undefined {
  const s = firstString(raw);
  if (s === undefined) return undefined;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return undefined;
  return d;
}

/**
 * 解析周期报警趋势请求：必填 `period=week|month`；可选 `now`（ISO，默认服务端当前时刻）。
 * 可选 `timeStampFrom`/`timeStampTo`（与 v3 列表一致）决定 x 轴桶范围；未传时默认近 1 UTC 年。
 * 可选与 v3 列表相同的其它字符串筛选（device / hostname / …）。
 */
export function parsePeriodAlarmTrendQuery(
  q: Record<string, unknown>
): ParsePeriodAlarmTrendOk | ParsePeriodAlarmTrendFail {
  const periodRaw = firstString(firstQueryValue(q, "period"))?.trim().toLowerCase();
  if (periodRaw !== "week" && periodRaw !== "month") {
    return { ok: false, error: 'Query parameter "period" must be "week" or "month"' };
  }
  const period = periodRaw as PeriodKey;
  const now = parseNowParam(firstQueryValue(q, "now")) ?? new Date();

  const rangeResolved = resolvePeriodAlarmTimeRange(q, now);
  if (!rangeResolved.ok) {
    return { ok: false, error: rangeResolved.error };
  }

  const bucketResolved = periodBucketsInRange(
    period,
    rangeResolved.from,
    rangeResolved.to
  );
  if (!bucketResolved.ok) {
    return { ok: false, error: bucketResolved.error };
  }
  const buckets = bucketResolved.buckets;
  const spanFrom = buckets[0]!.start.toISOString();
  const spanTo = buckets[buckets.length - 1]!.end.toISOString();

  const filterQ = { ...q };
  delete filterQ.period;
  delete filterQ.now;

  const base = parseYieldMonitorTriggerV3Query({
    ...filterQ,
    timeStampFrom: spanFrom,
    timeStampTo: spanTo,
  });
  if (!base.ok) {
    return { ok: false, error: base.error };
  }

  const activity = parseYieldMonitorTriggerActivityQuery({
    ...filterQ,
    timeStampFrom: spanFrom,
    timeStampTo: spanTo,
  });
  if (!activity.ok) {
    return { ok: false, error: activity.error };
  }

  return {
    ok: true,
    period,
    now,
    buckets,
    whereSql: base.whereSql,
    activityWhereSql: activity.whereSql,
    alarmBinds: base.binds,
    activityBinds: activity.binds,
    applied: base.applied,
  };
}

/** 单次 Oracle 扫描：各桶 COUNT(*) + COUNT(DISTINCT …) + Tester 报警频率分母（仅 activity binds + 桶）。 */
export function buildPeriodAlarmTrendSql(
  activityWhereSql: string,
  bucketCount: number
): string {
  const activityWc = activityWhereSql.trim();
  const caseLines: string[] = [];
  for (let i = bucketCount - 1; i >= 0; i--) {
    caseLines.push(
      `      WHEN t.TIME_STAMP >= :b${i}_from AND t.TIME_STAMP <= :b${i}_to THEN ${i}`
    );
  }
  const caseExpr = `CASE\n${caseLines.join("\n")}\n      ELSE NULL\n    END`;
  const typeScopeUpper = YIELD_MONITOR_V3_TYPE_SCOPE.toUpperCase();

  return `
WITH bucketed AS (
  SELECT
    TRIM(t.HOSTNAME) AS hostname,
    TRIM(t.PROBECARD) AS probe_card,
    ${BIN_EXPR} AS bin_v,
    ${DUT_EXPR} AS dut_v,
    ${caseExpr} AS bucket_idx,
    CASE WHEN UPPER(TRIM(t."TYPE")) = '${typeScopeUpper}' THEN 1 ELSE 0 END AS is_alarm_row
  FROM YMWEB_YIELDMONITORTRIGGER t
  ${activityWc}
)
SELECT
  b.bucket_idx,
  SUM(b.is_alarm_row) AS TOTAL,
  COUNT(DISTINCT CASE WHEN b.is_alarm_row = 1 THEN b.hostname END) AS TESTER_CNT,
  COUNT(DISTINCT CASE WHEN b.is_alarm_row = 1 THEN b.probe_card END) AS CARD_CNT,
  COUNT(DISTINCT CASE WHEN b.is_alarm_row = 1 AND b.bin_v IS NOT NULL AND b.bin_v != 'goodbin' THEN b.bin_v END) AS BIN_CNT,
  COUNT(DISTINCT CASE WHEN b.is_alarm_row = 1 AND b.dut_v IS NOT NULL THEN b.dut_v END) AS DUT_CNT,
  SUM(
    CASE
      WHEN EXISTS (
        SELECT 1
        FROM bucketed ah
        WHERE ah.bucket_idx = b.bucket_idx
          AND ah.is_alarm_row = 1
          AND ah.hostname IS NOT NULL
          AND LENGTH(ah.hostname) > 0
          AND ah.hostname = b.hostname
      )
      THEN 1
      ELSE 0
    END
  ) AS TESTER_ACTIVITY_TOTAL
FROM bucketed b
WHERE b.bucket_idx IS NOT NULL
GROUP BY b.bucket_idx
ORDER BY b.bucket_idx
`.trim();
}

/** 各桶 delta_diff 触发次数 Top N tester（与主查询共用 activity 扫描 + 桶 bind）。 */
export function buildPeriodAlarmTrendTopTestersSql(
  activityWhereSql: string,
  bucketCount: number,
  topN = PERIOD_ALARM_TOP_TESTERS_LIMIT
): string {
  const activityWc = activityWhereSql.trim();
  const caseLines: string[] = [];
  for (let i = bucketCount - 1; i >= 0; i--) {
    caseLines.push(
      `      WHEN t.TIME_STAMP >= :b${i}_from AND t.TIME_STAMP <= :b${i}_to THEN ${i}`
    );
  }
  const caseExpr = `CASE\n${caseLines.join("\n")}\n      ELSE NULL\n    END`;
  const typeScopeUpper = YIELD_MONITOR_V3_TYPE_SCOPE.toUpperCase();

  return `
WITH bucketed AS (
  SELECT
    TRIM(t.HOSTNAME) AS hostname,
    ${caseExpr} AS bucket_idx,
    CASE WHEN UPPER(TRIM(t."TYPE")) = '${typeScopeUpper}' THEN 1 ELSE 0 END AS is_alarm_row
  FROM YMWEB_YIELDMONITORTRIGGER t
  ${activityWc}
)
SELECT bucket_idx, hostname, cnt
FROM (
  SELECT bucket_idx, hostname, cnt,
    ROW_NUMBER() OVER (PARTITION BY bucket_idx ORDER BY cnt DESC, hostname) AS rn
  FROM (
    SELECT bucket_idx, hostname, COUNT(*) AS cnt
    FROM bucketed
    WHERE is_alarm_row = 1
      AND bucket_idx IS NOT NULL
      AND hostname IS NOT NULL
      AND LENGTH(hostname) > 0
    GROUP BY bucket_idx, hostname
  )
)
WHERE rn <= ${topN}
ORDER BY bucket_idx, cnt DESC, hostname
`.trim();
}

export function periodAlarmTrendMainBinds(
  parsed: ParsePeriodAlarmTrendOk
): BindParameters {
  const binds = { ...parsed.activityBinds } as Record<string, unknown>;
  parsed.buckets.forEach((b, i) => {
    binds[`b${i}_from`] = b.start;
    binds[`b${i}_to`] = b.end;
  });
  return binds as BindParameters;
}

export function periodAlarmTrendTopBinds(
  parsed: ParsePeriodAlarmTrendOk
): BindParameters {
  return periodAlarmTrendMainBinds(parsed);
}

/** @deprecated 使用 periodAlarmTrendMainBinds / periodAlarmTrendTopBinds */
export function periodAlarmTrendBinds(
  parsed: ParsePeriodAlarmTrendOk
): BindParameters {
  return periodAlarmTrendMainBinds(parsed);
}

function assignBucketIndex(
  rowTs: number,
  buckets: PeriodAlarmBucket[],
  timeOffsetMs = 0
): number | null {
  for (let i = buckets.length - 1; i >= 0; i--) {
    const b = buckets[i]!;
    const from = b.start.getTime() - timeOffsetMs;
    const to = b.end.getTime() - timeOffsetMs;
    if (rowTs >= from && rowTs <= to) return i;
  }
  return null;
}

function computeTesterAlarmRate(
  numerator: number,
  activityTotal: number
): number | null {
  if (activityTotal <= 0) return null;
  return numerator / activityTotal;
}

export function topTestersFromAlarmRows(
  rows: Array<YieldMonitorTriggerDummyRow & { PROBECARDTYPE?: string | null }>,
  limit = PERIOD_ALARM_TOP_TESTERS_LIMIT
): PeriodAlarmTopTester[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const hn = String(row.HOSTNAME ?? "").trim();
    if (!hn) continue;
    counts.set(hn, (counts.get(hn) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([hostname, count]) => ({ hostname, count }));
}

function aggregateBucketMetrics(
  rows: Array<YieldMonitorTriggerDummyRow & { PROBECARDTYPE?: string | null }>,
  activityRows: Array<
    YieldMonitorTriggerDummyRow & { PROBECARDTYPE?: string | null }
  >,
  alarmHostnames: Set<string>
): Omit<
  PeriodAlarmTrendPoint,
  "label" | "timeStampFrom" | "timeStampTo" | "topTesters"
> {
  const testers = new Set<string>();
  const cards = new Set<string>();
  const bins = new Set<string>();
  const duts = new Set<string>();

  for (const row of rows) {
    testers.add(String(row.HOSTNAME ?? "").trim());
    cards.add(String(row.PROBECARD ?? "").trim());
    const bin = parseBinFromTriggerLabel(row.TRIGGER_LABEL);
    if (bin != null && bin !== "" && bin !== "goodbin") {
      bins.add(bin);
    }
    const dut = parseDutNumberFromTriggerLabel(row.TRIGGER_LABEL);
    if (dut !== null) {
      duts.add(String(dut));
    }
  }

  testers.delete("");
  cards.delete("");

  const total = rows.length;
  let testerActivityTotal = 0;
  for (const row of activityRows) {
    const hn = String(row.HOSTNAME ?? "").trim();
    if (hn !== "" && alarmHostnames.has(hn)) {
      testerActivityTotal += 1;
    }
  }

  return {
    total,
    testerCount: testers.size,
    cardCount: cards.size,
    binCount: bins.size,
    dutCount: duts.size,
    testerAlarmNumerator: total,
    testerActivityTotal,
    testerAlarmRate: computeTesterAlarmRate(total, testerActivityTotal),
  };
}

export function aggregatePeriodAlarmTrendDummy(
  applied: Record<string, unknown>,
  buckets: PeriodAlarmBucket[]
): PeriodAlarmTrendPoint[] {
  const rows = filterYieldMonitorDummyRowsMatchingV3(applied);
  const activityRows = filterYieldMonitorDummyRowsMatchingActivity(applied);
  /**
   * 必须与 `filterYieldMonitorDummyRowsMatchingV3` 内部用的偏移同源（基于时间窗过滤前的行计算）。
   * 若改用已按时间窗过滤后的 `rows` 重新计算 maxTs，两次取值范围不同会得到不一致的偏移，
   * 导致窗口边界附近的行在分桶时被错误丢弃（分桶结果比实际过滤结果少）。
   */
  const timeOffsetMs = yieldMonitorDummyTimeOffsetMs(applied);
  const grouped: Array<
    Array<YieldMonitorTriggerDummyRow & { PROBECARDTYPE?: string | null }>
  > = buckets.map(() => []);
  const activityGrouped: Array<
    Array<YieldMonitorTriggerDummyRow & { PROBECARDTYPE?: string | null }>
  > = buckets.map(() => []);

  for (const row of rows) {
    const t = new Date(row.TIME_STAMP).getTime();
    if (Number.isNaN(t)) continue;
    const idx = assignBucketIndex(t, buckets, timeOffsetMs);
    if (idx === null) continue;
    grouped[idx]!.push(row);
  }

  for (const row of activityRows) {
    const t = new Date(row.TIME_STAMP).getTime();
    if (Number.isNaN(t)) continue;
    const idx = assignBucketIndex(t, buckets, timeOffsetMs);
    if (idx === null) continue;
    activityGrouped[idx]!.push(row);
  }

  return buckets.map((bucket, i) => {
    const alarmRows = grouped[i] ?? [];
    const alarmHostnames = new Set(
      alarmRows
        .map((r) => String(r.HOSTNAME ?? "").trim())
        .filter((hn) => hn !== "")
    );
    const metrics = aggregateBucketMetrics(
      alarmRows,
      activityGrouped[i] ?? [],
      alarmHostnames
    );
    return {
      label: bucket.label,
      timeStampFrom: bucket.start.toISOString(),
      timeStampTo: bucket.end.toISOString(),
      ...metrics,
      topTesters: topTestersFromAlarmRows(alarmRows),
    };
  });
}

export function attachPeriodAlarmTopTesters(
  points: PeriodAlarmTrendPoint[],
  topRows: Record<string, unknown>[]
): PeriodAlarmTrendPoint[] {
  const byBucket = new Map<number, PeriodAlarmTopTester[]>();
  for (const row of topRows) {
    const idxRaw = row.BUCKET_IDX ?? row.bucket_idx;
    const idx = idxRaw != null ? Number(idxRaw) : NaN;
    if (!Number.isFinite(idx)) continue;
    const hostnameRaw = row.HOSTNAME ?? row.hostname;
    const hostname =
      hostnameRaw == null ? "" : String(hostnameRaw).trim();
    const cntRaw = row.CNT ?? row.cnt;
    const count = cntRaw != null ? Number(cntRaw) : NaN;
    if (!hostname || !Number.isFinite(count)) continue;
    const list = byBucket.get(idx) ?? [];
    list.push({ hostname, count });
    byBucket.set(idx, list);
  }

  return points.map((p, i) => ({
    ...p,
    topTesters: byBucket.get(i) ?? [],
  }));
}

export function mapPeriodAlarmTrendRows(
  buckets: PeriodAlarmBucket[],
  rows: Record<string, unknown>[]
): PeriodAlarmTrendPoint[] {
  const byIdx = new Map<number, Record<string, unknown>>();
  for (const row of rows) {
    const idxRaw = row.BUCKET_IDX ?? row.bucket_idx;
    const idx = idxRaw != null ? Number(idxRaw) : NaN;
    if (Number.isFinite(idx)) byIdx.set(idx, row);
  }

  return buckets.map((bucket, i) => {
    const row = byIdx.get(i);
    const num = (k: string) => {
      const raw = row?.[k] ?? row?.[k.toLowerCase()];
      const n = Number(raw);
      return Number.isFinite(n) ? n : 0;
    };
    return {
      label: bucket.label,
      timeStampFrom: bucket.start.toISOString(),
      timeStampTo: bucket.end.toISOString(),
      total: num("TOTAL"),
      testerCount: num("TESTER_CNT"),
      cardCount: num("CARD_CNT"),
      binCount: num("BIN_CNT"),
      dutCount: num("DUT_CNT"),
      testerAlarmNumerator: num("TOTAL"),
      testerActivityTotal: num("TESTER_ACTIVITY_TOTAL"),
      testerAlarmRate: computeTesterAlarmRate(
        num("TOTAL"),
        num("TESTER_ACTIVITY_TOTAL")
      ),
      topTesters: [],
    };
  });
}

export const PERIOD_ALARM_TREND_DOCUMENTATION =
  "按查询 TIME_STAMP 时间窗（未传则近 1 UTC 年）切分周/月 x 轴桶，单次 Oracle 扫描返回各桶触发总量与 COUNT(DISTINCT) 种类数（Tester / Probe Card / Bin excluding goodbin / DUT）、Tester 报警频率，以及各桶触发 Top 5 tester。";
