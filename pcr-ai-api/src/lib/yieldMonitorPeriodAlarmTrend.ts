import type { BindParameters } from "oracledb";
import { parseYieldMonitorTriggerV3Query } from "./yieldMonitorTriggerFilters.js";
import {
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
};

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
  whereSql: string;
  binds: BindParameters;
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

  return {
    ok: true,
    period,
    now,
    buckets,
    whereSql: base.whereSql,
    binds: base.binds,
    applied: base.applied,
  };
}

/** 单次 Oracle 扫描：4 桶 × COUNT(*) + COUNT(DISTINCT …)；bin 不含 goodbin。 */
export function buildPeriodAlarmTrendSql(
  whereSql: string,
  bucketCount: number
): string {
  const wc = whereSql.trim();
  const caseLines: string[] = [];
  for (let i = bucketCount - 1; i >= 0; i--) {
    caseLines.push(
      `      WHEN t.TIME_STAMP >= :b${i}_from AND t.TIME_STAMP <= :b${i}_to THEN ${i}`
    );
  }
  const caseExpr = `CASE\n${caseLines.join("\n")}\n      ELSE NULL\n    END`;

  return `
SELECT
  bucket_idx,
  COUNT(*) AS TOTAL,
  COUNT(DISTINCT TRIM(HOSTNAME)) AS TESTER_CNT,
  COUNT(DISTINCT TRIM(PROBECARD)) AS CARD_CNT,
  COUNT(DISTINCT CASE WHEN bin_v IS NOT NULL AND bin_v != 'goodbin' THEN bin_v END) AS BIN_CNT,
  COUNT(DISTINCT CASE WHEN dut_v IS NOT NULL THEN dut_v END) AS DUT_CNT
FROM (
  SELECT
    t.HOSTNAME,
    t.PROBECARD,
    ${BIN_EXPR} AS bin_v,
    ${DUT_EXPR} AS dut_v,
    ${caseExpr} AS bucket_idx
  FROM YMWEB_YIELDMONITORTRIGGER t
  ${wc}
) sub
WHERE bucket_idx IS NOT NULL
GROUP BY bucket_idx
ORDER BY bucket_idx
`.trim();
}

export function periodAlarmTrendBinds(
  parsed: ParsePeriodAlarmTrendOk
): BindParameters {
  const binds = { ...parsed.binds } as Record<string, unknown>;
  parsed.buckets.forEach((b, i) => {
    binds[`b${i}_from`] = b.start;
    binds[`b${i}_to`] = b.end;
  });
  return binds as BindParameters;
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

function aggregateBucketMetrics(
  rows: Array<YieldMonitorTriggerDummyRow & { PROBECARDTYPE?: string | null }>
): Omit<PeriodAlarmTrendPoint, "label" | "timeStampFrom" | "timeStampTo"> {
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

  return {
    total: rows.length,
    testerCount: testers.size,
    cardCount: cards.size,
    binCount: bins.size,
    dutCount: duts.size,
  };
}

export function aggregatePeriodAlarmTrendDummy(
  applied: Record<string, unknown>,
  buckets: PeriodAlarmBucket[]
): PeriodAlarmTrendPoint[] {
  const rows = filterYieldMonitorDummyRowsMatchingV3(applied);
  /**
   * 必须与 `filterYieldMonitorDummyRowsMatchingV3` 内部用的偏移同源（基于时间窗过滤前的行计算）。
   * 若改用已按时间窗过滤后的 `rows` 重新计算 maxTs，两次取值范围不同会得到不一致的偏移，
   * 导致窗口边界附近的行在分桶时被错误丢弃（分桶结果比实际过滤结果少）。
   */
  const timeOffsetMs = yieldMonitorDummyTimeOffsetMs(applied);
  const grouped: Array<
    Array<YieldMonitorTriggerDummyRow & { PROBECARDTYPE?: string | null }>
  > = buckets.map(() => []);

  for (const row of rows) {
    const t = new Date(row.TIME_STAMP).getTime();
    if (Number.isNaN(t)) continue;
    const idx = assignBucketIndex(t, buckets, timeOffsetMs);
    if (idx === null) continue;
    grouped[idx]!.push(row);
  }

  return buckets.map((bucket, i) => {
    const metrics = aggregateBucketMetrics(grouped[i] ?? []);
    return {
      label: bucket.label,
      timeStampFrom: bucket.start.toISOString(),
      timeStampTo: bucket.end.toISOString(),
      ...metrics,
    };
  });
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
    };
  });
}

export const PERIOD_ALARM_TREND_DOCUMENTATION =
  "按查询 TIME_STAMP 时间窗（未传则近 1 UTC 年）切分周/月 x 轴桶，单次 Oracle 扫描返回各桶触发总量与 COUNT(DISTINCT) 种类数（Tester / Probe Card / Bin excluding goodbin / DUT）。";
