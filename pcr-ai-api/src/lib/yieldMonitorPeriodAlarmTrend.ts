import type { BindParameters } from "oracledb";
import {
  parseYieldMonitorTriggerActivityQuery,
  parseYieldMonitorTriggerV3Query,
  YIELD_MONITOR_V3_TYPE_SCOPE,
} from "./yieldMonitor/yieldMonitorTriggerFilters.js";
import {
  parseInfcontrolLayerBinsV3Query,
} from "./infcontrol/infcontrolLayerBinFilters.js";
import {
  filterInfcontrolLayerBinV3DummyRowsMatching,
  type InfcontrolLayerBinDummyRow,
} from "./infcontrol/infcontrolLayerBinDummy.js";
import { infcontrolLayerBinV3BaseWhereBlock } from "./infcontrolLayerBinPasstypeScope.js";
import {
  filterYieldMonitorDummyRowsMatchingV3,
  yieldMonitorDummyTimeOffsetMs,
  type YieldMonitorTriggerDummyRow,
} from "./yieldMonitor/yieldMonitorTriggerDummy.js";
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

export type PeriodAlarmTopDevice = {
  device: string;
  count: number;
};

export type PeriodAlarmTopProbeCard = {
  probeCard: string;
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
  /** 同期同筛选、该桶内 JB Start 记录总数（分母；v3 PASSTYPE，不含 RETESTBIN） */
  testerActivityTotal: number;
  /** testerAlarmNumerator / testerActivityTotal；分母为 0 时为 null */
  testerAlarmRate: number | null;
  /** 该桶触发次数 Top N 的 tester（按 count 降序） */
  topTesters: PeriodAlarmTopTester[];
  /** 该桶触发次数 Top N 的 device（按 count 降序） */
  topDevices: PeriodAlarmTopDevice[];
  /** 该桶触发次数 Top N 的 probe card（按 count 降序） */
  topProbeCards: PeriodAlarmTopProbeCard[];
};

export const PERIOD_ALARM_TOP_N_LIMIT = 5;

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
  /** delta_diff 报警 WHERE（YM 报警机台集合 + Top tester） */
  whereSql: string;
  /** YM 全 TYPE 扫描 WHERE（Top tester 子查询） */
  activityWhereSql: string;
  /** JB Start slot 分母 WHERE（`parseInfcontrolLayerBinsV3Query` AND 片段） */
  jbSlotWhereAndSql: string;
  alarmBinds: BindParameters;
  activityBinds: BindParameters;
  jbSlotBinds: BindParameters;
  jbSlotApplied: Record<string, unknown>;
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

function periodAlarmBucketCaseExpr(
  bucketCount: number,
  columnSql: string
): string {
  const caseLines: string[] = [];
  for (let i = bucketCount - 1; i >= 0; i--) {
    caseLines.push(
      `      WHEN ${columnSql} >= :b${i}_from AND ${columnSql} <= :b${i}_to THEN ${i}`
    );
  }
  return `CASE\n${caseLines.join("\n")}\n      ELSE NULL\n    END`;
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

/** 单次 Oracle 扫描：各桶 COUNT(*) + COUNT(DISTINCT …)（分母由 JB slot 查询在 Node 合并）。 */
export function buildPeriodAlarmTrendSql(
  activityWhereSql: string,
  bucketCount: number
): string {
  const activityWc = activityWhereSql.trim();
  const caseExpr = periodAlarmBucketCaseExpr(bucketCount, "t.TIME_STAMP");
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
  COUNT(DISTINCT CASE WHEN b.is_alarm_row = 1 AND b.dut_v IS NOT NULL THEN b.dut_v END) AS DUT_CNT
FROM bucketed b
WHERE b.bucket_idx IS NOT NULL
GROUP BY b.bucket_idx
ORDER BY b.bucket_idx
`.trim();
}

/** JB Start：每桶记录数 COUNT(*)，按 TESTEND 分桶（v3 PASSTYPE 范围，不含 RETESTBIN）。 */
export function buildPeriodAlarmJbSlotTuplesSql(
  jbWhereAndSql: string,
  bucketCount: number
): string {
  const whereBlock = infcontrolLayerBinV3BaseWhereBlock(
    "t2",
    jbWhereAndSql.trim()
  );
  const caseExpr = periodAlarmBucketCaseExpr(bucketCount, "t2.TESTEND");

  return `
SELECT bucket_idx, activity_total
FROM (
  SELECT bucket_idx, COUNT(*) AS activity_total
  FROM (
    SELECT
      ${caseExpr} AS bucket_idx
    FROM INFCONTROL t1
    INNER JOIN INFLAYERBINLIST t2 ON t1.KEYNUMBER = t2.KEYNUMBER
    ${whereBlock}
  ) bucketed
  WHERE bucket_idx IS NOT NULL
  GROUP BY bucket_idx
) src
ORDER BY bucket_idx
`.trim();
}

/** 各桶 delta_diff 触发次数 Top N（按某一列分组，与主查询共用 activity 扫描 + 桶 bind）。 */
function buildPeriodAlarmTrendTopColumnSql(
  oracleColumn: "HOSTNAME" | "DEVICE" | "PROBECARD",
  alias: string,
  activityWhereSql: string,
  bucketCount: number,
  topN: number
): string {
  const activityWc = activityWhereSql.trim();
  const caseExpr = periodAlarmBucketCaseExpr(bucketCount, "t.TIME_STAMP");
  const typeScopeUpper = YIELD_MONITOR_V3_TYPE_SCOPE.toUpperCase();

  return `
WITH bucketed AS (
  SELECT
    TRIM(t.${oracleColumn}) AS ${alias},
    ${caseExpr} AS bucket_idx,
    CASE WHEN UPPER(TRIM(t."TYPE")) = '${typeScopeUpper}' THEN 1 ELSE 0 END AS is_alarm_row
  FROM YMWEB_YIELDMONITORTRIGGER t
  ${activityWc}
)
SELECT bucket_idx, ${alias}, cnt
FROM (
  SELECT bucket_idx, ${alias}, cnt,
    ROW_NUMBER() OVER (PARTITION BY bucket_idx ORDER BY cnt DESC, ${alias}) AS rn
  FROM (
    SELECT bucket_idx, ${alias}, COUNT(*) AS cnt
    FROM bucketed
    WHERE is_alarm_row = 1
      AND bucket_idx IS NOT NULL
      AND ${alias} IS NOT NULL
      AND LENGTH(${alias}) > 0
    GROUP BY bucket_idx, ${alias}
  )
)
WHERE rn <= ${topN}
ORDER BY bucket_idx, cnt DESC, ${alias}
`.trim();
}

/** 各桶 delta_diff 触发次数 Top N tester（与主查询共用 activity 扫描 + 桶 bind）。 */
export function buildPeriodAlarmTrendTopTestersSql(
  activityWhereSql: string,
  bucketCount: number,
  topN = PERIOD_ALARM_TOP_N_LIMIT
): string {
  return buildPeriodAlarmTrendTopColumnSql(
    "HOSTNAME",
    "hostname",
    activityWhereSql,
    bucketCount,
    topN
  );
}

/** 各桶 delta_diff 触发次数 Top N device（与主查询共用 activity 扫描 + 桶 bind）。 */
export function buildPeriodAlarmTrendTopDevicesSql(
  activityWhereSql: string,
  bucketCount: number,
  topN = PERIOD_ALARM_TOP_N_LIMIT
): string {
  return buildPeriodAlarmTrendTopColumnSql(
    "DEVICE",
    "device",
    activityWhereSql,
    bucketCount,
    topN
  );
}

/** 各桶 delta_diff 触发次数 Top N probe card（与主查询共用 activity 扫描 + 桶 bind）。 */
export function buildPeriodAlarmTrendTopProbeCardsSql(
  activityWhereSql: string,
  bucketCount: number,
  topN = PERIOD_ALARM_TOP_N_LIMIT
): string {
  return buildPeriodAlarmTrendTopColumnSql(
    "PROBECARD",
    "probe_card",
    activityWhereSql,
    bucketCount,
    topN
  );
}

export function periodAlarmTrendJbSlotBinds(
  parsed: ParsePeriodAlarmTrendOk
): BindParameters {
  const binds = { ...parsed.jbSlotBinds } as Record<string, unknown>;
  parsed.buckets.forEach((b, i) => {
    binds[`b${i}_from`] = b.start;
    binds[`b${i}_to`] = b.end;
  });
  return binds as BindParameters;
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
  if (activityTotal <= 0 || numerator <= 0) return null;
  const rate = numerator / activityTotal;
  // JB 历史覆盖不足或 TIME_STAMP 与 TESTEND 分桶错位时，比率可 >>1；UI 按百分比展示，>100% 视为无效
  if (rate > 1) return null;
  return rate;
}

export function topTestersFromAlarmRows(
  rows: Array<YieldMonitorTriggerDummyRow & { PROBECARDTYPE?: string | null }>,
  limit = PERIOD_ALARM_TOP_N_LIMIT
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

export function topDevicesFromAlarmRows(
  rows: Array<YieldMonitorTriggerDummyRow & { PROBECARDTYPE?: string | null }>,
  limit = PERIOD_ALARM_TOP_N_LIMIT
): PeriodAlarmTopDevice[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const dv = String(row.DEVICE ?? "").trim();
    if (!dv) continue;
    counts.set(dv, (counts.get(dv) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([device, count]) => ({ device, count }));
}

export function topProbeCardsFromAlarmRows(
  rows: Array<YieldMonitorTriggerDummyRow & { PROBECARDTYPE?: string | null }>,
  limit = PERIOD_ALARM_TOP_N_LIMIT
): PeriodAlarmTopProbeCard[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const pc = String(row.PROBECARD ?? "").trim();
    if (!pc) continue;
    counts.set(pc, (counts.get(pc) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([probeCard, count]) => ({ probeCard, count }));
}

function countJbRowsInBucket(
  jbRows: InfcontrolLayerBinDummyRow[],
  bucket: PeriodAlarmBucket
): number {
  const from = bucket.start.getTime();
  const to = bucket.end.getTime();
  let count = 0;
  for (const row of jbRows) {
    const te = new Date(String(row.TESTEND)).getTime();
    if (Number.isNaN(te) || te < from || te > to) continue;
    count += 1;
  }
  return count;
}

function aggregateBucketMetrics(
  rows: Array<YieldMonitorTriggerDummyRow & { PROBECARDTYPE?: string | null }>,
  jbRows: InfcontrolLayerBinDummyRow[],
  bucket: PeriodAlarmBucket
): Omit<
  PeriodAlarmTrendPoint,
  "label" | "timeStampFrom" | "timeStampTo" | "topTesters" | "topDevices" | "topProbeCards"
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
  const testerActivityTotal = countJbRowsInBucket(jbRows, bucket);

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
  buckets: PeriodAlarmBucket[],
  jbApplied: Record<string, unknown>
): PeriodAlarmTrendPoint[] {
  const rows = filterYieldMonitorDummyRowsMatchingV3(applied);
  const jbRows = filterInfcontrolLayerBinV3DummyRowsMatching(jbApplied);
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
    const alarmRows = grouped[i] ?? [];
    const metrics = aggregateBucketMetrics(alarmRows, jbRows, bucket);
    return {
      label: bucket.label,
      timeStampFrom: bucket.start.toISOString(),
      timeStampTo: bucket.end.toISOString(),
      ...metrics,
      topTesters: topTestersFromAlarmRows(alarmRows),
      topDevices: topDevicesFromAlarmRows(alarmRows),
      topProbeCards: topProbeCardsFromAlarmRows(alarmRows),
    };
  });
}

export function mergePeriodAlarmJbSlotDenominator(
  points: PeriodAlarmTrendPoint[],
  jbSlotRows: Record<string, unknown>[]
): PeriodAlarmTrendPoint[] {
  const activityByBucket = new Map<number, number>();
  for (const row of jbSlotRows) {
    const idxRaw = row.BUCKET_IDX ?? row.bucket_idx;
    const idx = idxRaw != null ? Number(idxRaw) : NaN;
    if (!Number.isFinite(idx)) continue;
    const totalRaw =
      row.ACTIVITY_TOTAL ??
      row.activity_total ??
      row.ROW_CNT ??
      row.row_cnt;
    const total = totalRaw != null ? Number(totalRaw) : NaN;
    if (!Number.isFinite(total) || total < 0) continue;
    activityByBucket.set(idx, total);
  }

  return points.map((p, i) => {
    const activity = activityByBucket.get(i) ?? 0;
    const num = p.testerAlarmNumerator;
    return {
      ...p,
      testerActivityTotal: activity,
      testerAlarmRate: computeTesterAlarmRate(num, activity),
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

export function attachPeriodAlarmTopDevices(
  points: PeriodAlarmTrendPoint[],
  topRows: Record<string, unknown>[]
): PeriodAlarmTrendPoint[] {
  const byBucket = new Map<number, PeriodAlarmTopDevice[]>();
  for (const row of topRows) {
    const idxRaw = row.BUCKET_IDX ?? row.bucket_idx;
    const idx = idxRaw != null ? Number(idxRaw) : NaN;
    if (!Number.isFinite(idx)) continue;
    const deviceRaw = row.DEVICE ?? row.device;
    const device =
      deviceRaw == null ? "" : String(deviceRaw).trim();
    const cntRaw = row.CNT ?? row.cnt;
    const count = cntRaw != null ? Number(cntRaw) : NaN;
    if (!device || !Number.isFinite(count)) continue;
    const list = byBucket.get(idx) ?? [];
    list.push({ device, count });
    byBucket.set(idx, list);
  }

  return points.map((p, i) => ({
    ...p,
    topDevices: byBucket.get(i) ?? [],
  }));
}

export function attachPeriodAlarmTopProbeCards(
  points: PeriodAlarmTrendPoint[],
  topRows: Record<string, unknown>[]
): PeriodAlarmTrendPoint[] {
  const byBucket = new Map<number, PeriodAlarmTopProbeCard[]>();
  for (const row of topRows) {
    const idxRaw = row.BUCKET_IDX ?? row.bucket_idx;
    const idx = idxRaw != null ? Number(idxRaw) : NaN;
    if (!Number.isFinite(idx)) continue;
    const probeCardRaw = row.PROBE_CARD ?? row.probe_card;
    const probeCard =
      probeCardRaw == null ? "" : String(probeCardRaw).trim();
    const cntRaw = row.CNT ?? row.cnt;
    const count = cntRaw != null ? Number(cntRaw) : NaN;
    if (!probeCard || !Number.isFinite(count)) continue;
    const list = byBucket.get(idx) ?? [];
    list.push({ probeCard, count });
    byBucket.set(idx, list);
  }

  return points.map((p, i) => ({
    ...p,
    topProbeCards: byBucket.get(i) ?? [],
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
      testerActivityTotal: 0,
      testerAlarmRate: null,
      topTesters: [],
      topDevices: [],
      topProbeCards: [],
    };
  });
}

export const PERIOD_ALARM_TREND_DOCUMENTATION =
  "按查询 TIME_STAMP 时间窗（未传则近 1 UTC 年）切分周/月 x 轴桶，返回各桶触发总量与 COUNT(DISTINCT) 种类数（Tester / Probe Card / Bin excluding goodbin / DUT）、Tester 报警频率（分子 YM delta_diff 次数 ÷ 分母同期同筛选 JB Start 记录总数，v3 PASSTYPE 不含 RETESTBIN）、以及各桶触发 Top 5 device。";
