/**
 * INFCONTROL ⋈ INFLAYERBINLIST on KEYNUMBER（v2 列表：精简列 + BIN0…BIN255 + PASSBIN）。
 */
const INFCONTROL_V2_COLS = [
  "ic.KEYNUMBER",
  "ic.DEVICE",
  "ic.LOT",
  "ic.SLOT",
  "ic.MESLOT",
] as const;

const INFLAYER_V2_PREFIX = [
  "lb.TESTERID",
  "lb.TSTYPE",
  "lb.CARDID",
  "lb.PIBID",
  "lb.PROBE",
  "lb.PASSID",
  /** 显式别名，避免 Thin 驱动返回小写键导致前端列名不一致 */
  `lb.PASSTYPE AS "PASSTYPE"`,
  "lb.TESTSTART",
  "lb.TESTEND",
] as const;

const INFLAYER_V2_BIN_COLS = Array.from(
  { length: 256 },
  (_, i) => `lb.BIN${i}`
) as readonly string[];

export const INFCONTROL_LAYER_BIN_V2_SELECT = [
  ...INFCONTROL_V2_COLS,
  ...INFLAYER_V2_PREFIX,
  ...INFLAYER_V2_BIN_COLS,
  "lb.PASSBIN",
].join(",\n  ");

/** v2：始终仅保留 **`INFLAYERBINLIST.PASSTYPE = 'TEST'`**（与其它筛选 AND） */
export function mergeV2WherePasstypeTest(whereClause: string): string {
  const fix = "TRIM(lb.PASSTYPE) = 'TEST'";
  const wc = whereClause.trim();
  if (wc === "") return `WHERE ${fix}`;
  return `${wc} AND ${fix}`;
}

/**
 * 排序：**`lb.TESTEND DESC NULLS LAST`**，**`ic.KEYNUMBER DESC NULLS LAST`** 作次序；
 * Top-N：**`ROWNUM <= :lim`**
 */
export function buildInfcontrolLayerBinV2TopSql(whereClause: string): string {
  const wc = mergeV2WherePasstypeTest(whereClause);
  return `
SELECT * FROM (
  SELECT ordered.*, ROWNUM AS rnum
  FROM (
    SELECT
      ${INFCONTROL_LAYER_BIN_V2_SELECT}
    FROM INFCONTROL ic
    INNER JOIN INFLAYERBINLIST lb ON ic.KEYNUMBER = lb.KEYNUMBER
    ${wc}
    ORDER BY lb.TESTEND DESC NULLS LAST, ic.KEYNUMBER DESC NULLS LAST
  ) ordered
  WHERE ROWNUM <= :lim
)
WHERE rnum >= 1
`.trim();
}
