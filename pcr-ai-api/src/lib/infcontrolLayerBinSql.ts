/**
 * INFCONTROL ⋈ INFLAYERBINLIST on KEYNUMBER（列名与库表一致，仅 JOIN 键保留一列）。
 * 不包含 PASSBINTABLE、INKBINTABLE（接口不输出）。
 */
const INFCONTROL_COLS = [
  "ic.KEYNUMBER",
  "ic.DEVICE",
  "ic.LOT",
  "ic.CASSETTE",
  "ic.SLOT",
  "ic.NOTCH",
  "ic.MAPROWS",
  "ic.MAPCOLS",
  "ic.SAMPLETESTNUMBER",
  "ic.PDPW",
  "ic.MESLOT",
] as const;

const INFLAYER_PREFIX_COLS = [
  "lb.TESTERID",
  "lb.TSTYPE",
  "lb.CARDID",
  "lb.PIBID",
  "lb.PROBE",
  "lb.GROSSDIE",
  "lb.PASSID",
  "lb.SESSIONNUMBER",
  "lb.PASSNUM",
  "lb.TESTSTART",
  "lb.TESTEND",
  "lb.LAYERNAME",
] as const;

const INFLAYER_BIN_COLS = Array.from(
  { length: 256 },
  (_, i) => `lb.BIN${i}`
) as readonly string[];

const INFLAYER_SUFFIX_COLS = [
  "lb.PASSRESUME",
  "lb.PASSRESULT",
  "lb.PASSTYPE",
  "lb.PASSBIN",
] as const;

export const INFCONTROL_LAYER_BIN_SELECT = [
  ...INFCONTROL_COLS,
  ...INFLAYER_PREFIX_COLS,
  ...INFLAYER_BIN_COLS,
  ...INFLAYER_SUFFIX_COLS,
].join(",\n  ");

/**
 * @param whereClause 为空字符串，或 `WHERE ...`（含 AND 条件）
 * 排序：TESTEND DESC NULLS LAST，KEYNUMBER DESC NULLS LAST；Top-N：ROWNUM <= :lim
 */
export function buildInfcontrolLayerBinTopSql(whereClause: string): string {
  const wc = whereClause.trim();
  return `
SELECT * FROM (
  SELECT ordered.*, ROWNUM AS rnum
  FROM (
    SELECT
      ${INFCONTROL_LAYER_BIN_SELECT}
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
