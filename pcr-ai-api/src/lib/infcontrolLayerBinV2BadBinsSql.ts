import { mergeV2WherePasstypeTest } from "./infcontrolLayerBinV2Sql.js";

/**
 * 在 **与 v2 相同 WHERE** 的全集上，对每个 BIN 下标 **k** 求：
 * **SUM(BINk)** 仅当该行 **BINk** 非空非零且 **k** 不在 **PASSBIN** 的 **`-`** 分隔 good 列表中。
 * 单次扫描，256 个聚合列（应用层取 Top **rankTop**）。
 */

function badBinSumColumnAlias(k: number): string {
  return `BAD_${k}`;
}

/** k ∈ [0,255]；列名由调用方保证安全 */
function badBinSumExpr(k: number): string {
  const col = `lb.BIN${k}`;
  const pat = `'(^|-)${k}(-|$)'`;
  return `SUM(
  CASE
    WHEN ${col} IS NULL OR ${col} = 0 THEN 0
    WHEN REGEXP_LIKE(TRIM(lb.PASSBIN), ${pat}) THEN 0
    ELSE ${col}
  END
) AS ${badBinSumColumnAlias(k)}`;
}

const BAD_BIN_SUM_SELECT = Array.from({ length: 256 }, (_, k) => badBinSumExpr(k)).join(
  ",\n  "
);

/**
 * 单行结果：**`BAD_0`…`BAD_255`** 为各 BIN 的 bad 合计（die 计数之和）。
 */
export function buildInfcontrolLayerBinV2BadBinTotalsSql(
  whereClause: string
): string {
  const wc = mergeV2WherePasstypeTest(whereClause);
  return `
SELECT
  ${BAD_BIN_SUM_SELECT}
FROM INFCONTROL ic
INNER JOIN INFLAYERBINLIST lb ON ic.KEYNUMBER = lb.KEYNUMBER
${wc}
`.trim();
}

export function badBinTotalsColumnAliases(): readonly string[] {
  return Array.from({ length: 256 }, (_, k) => badBinSumColumnAlias(k));
}

export type InfcontrolLayerBinV2BadBinRankEntry = {
  n: number;
  badTotal: number;
};

/**
 * 将聚合行 **`BAD_0`…`BAD_255`** 转为按 **`badTotal`** 降序的前 **`rankTop`** 项（并列时 **`n`** 升序）。
 */
export function rankBadBinTotalsFromAggregateRow(
  row: Record<string, unknown>,
  rankTop: number
): InfcontrolLayerBinV2BadBinRankEntry[] {
  const pairs: InfcontrolLayerBinV2BadBinRankEntry[] = [];
  for (let i = 0; i < 256; i++) {
    const alias = badBinSumColumnAlias(i);
    const raw = row[alias] ?? row[alias.toLowerCase()];
    const badTotal = raw == null || raw === "" ? 0 : Number(raw);
    pairs.push({
      n: i,
      badTotal: Number.isFinite(badTotal) ? badTotal : 0,
    });
  }
  pairs.sort((a, b) => {
    if (b.badTotal !== a.badTotal) return b.badTotal - a.badTotal;
    return a.n - b.n;
  });
  return pairs.slice(0, rankTop);
}
