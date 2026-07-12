import {
  parseYieldMonitorTriggerActivityQuery,
  parseYieldMonitorTriggerV3Query,
} from "../yieldMonitorTriggerFilters.js";
import { parseInfcontrolLayerBinsV3Query } from "../../infcontrol/infcontrolLayerBinFilters.js";
import type {
  ParsePeriodAlarmTrendFail,
  ParsePeriodAlarmTrendOk,
  PeriodAlarmBucket,
  PeriodBucketsInRangeResult,
  PeriodKey,
} from "./periodAlarmTrendTypes.js";
import {
  PERIOD_ALARM_MAX_MONTH_BUCKETS,
  PERIOD_ALARM_MAX_WEEK_BUCKETS,
} from "./periodAlarmTrendTypes.js";

const PERIOD_ALARM_TIME_KEYS = [
  "timeStampBegin",
  "timeStampFrom",
  "timeStampEnd",
  "timeStampTo",
] as const;

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

function mapPeriodAlarmFiltersToJbQuery(
  filterQ: Record<string, unknown>,
  spanFrom: string,
  spanTo: string
): Record<string, unknown> {
  const jbQ: Record<string, unknown> = { ...filterQ };
  delete jbQ.timeStampBegin;
  delete jbQ.timeStampEnd;
  delete jbQ.timeStampFrom;
  delete jbQ.timeStampTo;
  delete jbQ.wafer;
  delete jbQ.type;
  delete jbQ.platform;
  jbQ.testEndFrom = spanFrom;
  jbQ.testEndTo = spanTo;
  if (jbQ.lotId !== undefined) {
    jbQ.lot = jbQ.lotId;
    delete jbQ.lotId;
  }
  if (jbQ.hostname !== undefined) {
    jbQ.testerId = jbQ.hostname;
    delete jbQ.hostname;
  }
  if (jbQ.probeCard !== undefined) {
    jbQ.cardId = jbQ.probeCard;
    delete jbQ.probeCard;
  }
  if (jbQ.pass !== undefined) {
    jbQ.passId = jbQ.pass;
    delete jbQ.pass;
  }
  return jbQ;
}

function parseNowParam(raw: unknown): Date | undefined {
  const s = firstString(raw);
  if (s === undefined) return undefined;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return undefined;
  return d;
}

/**
 * 解析周期报警趋势请求
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

  const jb = parseInfcontrolLayerBinsV3Query(
    mapPeriodAlarmFiltersToJbQuery(filterQ, spanFrom, spanTo)
  );
  if (!jb.ok) {
    return { ok: false, error: jb.error };
  }

  return {
    ok: true,
    period,
    now,
    buckets,
    whereSql: base.whereSql,
    activityWhereSql: activity.whereSql,
    jbSlotWhereAndSql: jb.whereAndSql,
    alarmBinds: base.binds,
    activityBinds: activity.binds,
    jbSlotBinds: jb.binds,
    jbSlotApplied: jb.applied,
    applied: base.applied,
  };
}
