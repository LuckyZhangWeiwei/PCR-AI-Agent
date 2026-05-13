import type { BindParameters } from "oracledb";
import { parseInfcontrolLayerBinsV3Query } from "./infcontrolLayerBinFilters.js";
import {
  parseInfcontrolLayerBinAggregateGroupSpec,
  type InfcontrolLayerBinGroupBy,
} from "./infcontrolLayerBinAggregate.js";

/** 随 JSON 返回的固定说明（给人与 Agent；与 manifest `purpose` 一致） */
export const INFCONTROL_V3_AGGREGATE_DOCUMENTATION =
  "v3 层控 BIN 聚合：在「与 GET /infcontrol-layer-bins/v3 相同的筛选语义」（INFLAYERBINLIST.PASSTYPE='TEST' + v3 的 AND 条件；字符串 UPPER(TRIM)）" +
  "所匹配的**全部行**上，对 BIN0…BIN255 先 UNPIVOT 再按 groupBy 维度 SUM，取合计最大的 Top groupTop 组。与 v3 **列表**不同：列表 FETCH FIRST :lim 仅最多 500 条明细；" +
  "聚合统计的是筛选下的全量匹配行。**SUM 仅累计坏 bin**：PASSBIN 按「-」拆成的整段下标（0…255）视为 good bin（与列表 bins[].isGoodBin、与 /infcontrol-layer-bins/v2/top-bad-bins 的 token 规则一致），这些列 die 不计入；**不再**使用 v1 聚合的「BIN1 恒排除 + 仅 N-M 两端排除」。" +
  "当 **`INFCONTROL_LAYER_BINS_DUMMY=true`** 且进程非 `dist`/production 时，数据来自 **`docs/JBStart.xlsx`** 内存样本；否则走主库 Oracle。";

type ParseFail = { ok: false; error: string };
type ParseOk = {
  ok: true;
  whereSql: string;
  binds: BindParameters;
  applied: Record<string, unknown>;
  groupBy: InfcontrolLayerBinGroupBy[];
  groupTop: number;
};

/**
 * 将 v3 列表条件里的 **`t1`/`t2`** 替换为聚合 SQL 中的 **`ic`/`lb`**。
 */
export function adaptInfcontrolV3WhereAndSqlToAggregateAliases(
  whereAndSql: string
): string {
  return whereAndSql
    .trim()
    .replace(/\bt1\./gi, "ic.")
    .replace(/\bt2\./gi, "lb.");
}

/**
 * **v3 层控 BIN 聚合**：与 **`/infcontrol-layer-bins/v3`** 相同的 **筛选语义**
 *（`PASSTYPE='TEST'` + `parseInfcontrolLayerBinsV3Query` 的 AND 条件；字符串 **`UPPER(TRIM)`**），
 * 聚合逻辑与 **v1 `/infcontrol-layer-bins/aggregate`** 相同：**UNPIVOT BIN0…BIN255** 后按 **`groupBy`** 维度 **SUM**，
 * 取合计最大的 Top **`groupTop`** 组。数据源与 **`/infcontrol-layer-bins/v3`** 一致（主库或 Dummy 内存，见 `infcontrolLayerBinsUseDummy()`）。
 *
 * **`groupBy`**：须**恰好含一个 `bin`**（可与 `device`、`lot`、`testerId` 等复合），规则与 v1 aggregate 一致。
 */
export function parseInfcontrolLayerBinsV3AggregateQuery(
  q: Record<string, unknown>
): ParseFail | ParseOk {
  const gs = parseInfcontrolLayerBinAggregateGroupSpec(q);
  if (!gs.ok) {
    return gs;
  }
  const { groupBy, groupTop } = gs;

  const v3 = parseInfcontrolLayerBinsV3Query(q);
  if (!v3.ok) {
    return v3;
  }

  const adapted = adaptInfcontrolV3WhereAndSqlToAggregateAliases(
    v3.whereAndSql
  );
  const whereSql =
    adapted.length > 0
      ? `WHERE lb.PASSTYPE = 'TEST' AND ${adapted}`
      : `WHERE lb.PASSTYPE = 'TEST'`;

  const applied = {
    ...v3.applied,
    groupBy,
    groupTop,
  };

  return {
    ok: true,
    whereSql,
    binds: v3.binds,
    applied,
    groupBy,
    groupTop,
  };
}
