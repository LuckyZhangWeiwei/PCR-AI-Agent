/**
 * YMWEB_YIELDMONITORTRIGGER — TYPE 为保留相关字，使用双引号
 */
export const YIELD_MONITOR_TRIGGER_SELECT = [
  "t.HOSTNAME",
  "t.DEVICE",
  "t.LOTID",
  "t.PASS",
  "t.WAFER",
  't."TYPE"',
  "t.TRIGGER_LABEL",
  "t.TIME_STAMP",
  "t.ID",
  "t.PROBECARD",
].join(",\n  ");

/**
 * @param whereClause 空串，或 `WHERE ...`；排序 TIME_STAMP DESC；Top :lim
 */
export function buildYieldMonitorTriggerTopSql(whereClause: string): string {
  const wc = whereClause.trim();
  return `
SELECT * FROM (
  SELECT ordered.*, ROWNUM AS rnum
  FROM (
    SELECT
      ${YIELD_MONITOR_TRIGGER_SELECT}
    FROM YMWEB_YIELDMONITORTRIGGER t
    ${wc}
    ORDER BY t.TIME_STAMP DESC NULLS LAST
  ) ordered
  WHERE ROWNUM <= :lim
)
WHERE rnum >= 1
`.trim();
}

/** 与列表相同 WHERE；按 PROBECARD 分组计数，COUNT(*) 降序（全量匹配行，不限 200） */
export function buildYieldMonitorProbeCardSummarySql(
  whereClause: string
): string {
  const wc = whereClause.trim();
  return `
SELECT t.PROBECARD AS PROBECARD, COUNT(*) AS CNT
FROM YMWEB_YIELDMONITORTRIGGER t
${wc}
GROUP BY t.PROBECARD
ORDER BY COUNT(*) DESC NULLS LAST
`.trim();
}

/** 与列表相同 WHERE；按 HOSTNAME（机台）分组计数，COUNT(*) 降序（全量匹配行，不限 200） */
export function buildYieldMonitorHostnameSummarySql(
  whereClause: string
): string {
  const wc = whereClause.trim();
  return `
SELECT t.HOSTNAME AS HOSTNAME, COUNT(*) AS CNT
FROM YMWEB_YIELDMONITORTRIGGER t
${wc}
GROUP BY t.HOSTNAME
ORDER BY COUNT(*) DESC NULLS LAST
`.trim();
}
