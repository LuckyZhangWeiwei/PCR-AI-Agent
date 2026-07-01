/**
 * v3/v4 层控列表与聚合共用的 INFLAYERBINLIST.PASSTYPE 范围。
 * 含 TEST / INTERRUPT（常规与中断）、TEST ISR / TEST INTERRUPT（带前缀的层类型）、
 * RETESTBIN（复测坏 bin）。
 * 仍排除 NA（Current 层）与 LAYERNAME=Abandoned（见 SQL / Dummy 侧 LAYERNAME 条件）。
 */
export const INFCONTROL_LAYER_BIN_V3_PASSTYPES = [
  "TEST",
  "INTERRUPT",
  "TEST ISR",
  "TEST INTERRUPT",
  "RETESTBIN",
] as const;

export type InfcontrolLayerBinV3Passtype =
  (typeof INFCONTROL_LAYER_BIN_V3_PASSTYPES)[number];

/** Oracle：`UPPER(TRIM(alias.PASSTYPE)) IN (...)` */
export function infcontrolLayerBinV3PasstypeOracleIn(alias: string): string {
  const inList = INFCONTROL_LAYER_BIN_V3_PASSTYPES.map(
    (v) => `'${v.replace(/'/g, "''")}'`
  ).join(", ");
  return `UPPER(TRIM(${alias}.PASSTYPE)) IN (${inList})`;
}

/** Dummy / Node：行 PASSTYPE 是否在 v3 范围内。 */
export function infcontrolLayerBinV3PasstypeMatches(
  passtype: unknown
): boolean {
  const pt = String(passtype ?? "").trim().toUpperCase();
  return INFCONTROL_LAYER_BIN_V3_PASSTYPES.some(
    (v) => v.toUpperCase() === pt
  );
}

/** Oracle：`WHERE passtype IN (...) AND LAYERNAME <> Abandoned [AND extra]` */
export function infcontrolLayerBinV3BaseWhereBlock(
  alias: string,
  extraAndSql = ""
): string {
  const extra = extraAndSql.trim();
  const base = `WHERE ${infcontrolLayerBinV3PasstypeOracleIn(alias)} AND UPPER(TRIM(${alias}.LAYERNAME)) <> 'ABANDONED'`;
  return extra ? `${base} AND ${extra}` : base;
}
