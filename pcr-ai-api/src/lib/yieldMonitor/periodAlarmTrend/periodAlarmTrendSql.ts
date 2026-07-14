import type { BindParameters } from "oracledb";
import { YIELD_MONITOR_V3_TYPE_SCOPE } from "../yieldMonitorTriggerFilters.js";
import { infcontrolLayerBinV3BaseWhereBlock } from "../../infcontrolLayerBinPasstypeScope.js";
import {
  PERIOD_ALARM_TOP_N_LIMIT,
  type ParsePeriodAlarmTrendOk,
} from "./periodAlarmTrendTypes.js";

const BIN_EXPR =
  "LOWER(REGEXP_SUBSTR(t.TRIGGER_LABEL, 'Bin#\\s*([0-9]+|goodbin)', 1, 1, 'i', 1))";
const DUT_EXPR =
  "REGEXP_SUBSTR(t.TRIGGER_LABEL, 'on\\s+dut#\\s*([0-9]+)', 1, 1, 'i', 1)";

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

/** JB Start：每桶 distinct (LOT,SLOT) 片数，按 TESTEND 分桶（v3 PASSTYPE 范围，不含 RETESTBIN）。 */
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
SELECT bucket_idx, lot, slot
FROM (
  SELECT
    ${caseExpr} AS bucket_idx,
    TRIM(t1.LOT) AS lot,
    t1.SLOT AS slot
  FROM INFCONTROL t1
  INNER JOIN INFLAYERBINLIST t2 ON t1.KEYNUMBER = t2.KEYNUMBER
  ${whereBlock}
) src
WHERE bucket_idx IS NOT NULL
  AND lot IS NOT NULL
  AND LENGTH(lot) > 0
GROUP BY bucket_idx, lot, slot
ORDER BY bucket_idx, lot, slot
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
