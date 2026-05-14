import type { BindParameters } from "oracledb";
import { parseInfcontrolLayerBinsV3Query } from "./infcontrolLayerBinFilters.js";
import {
  parseInfcontrolLayerBinAggregateGroupSpec,
  type InfcontrolLayerBinGroupBy,
} from "./infcontrolLayerBinAggregate.js";

/** 随 JSON 返回的固定说明（给人与 Agent；与 manifest `purpose` 一致） */
export const INFCONTROL_V3_AGGREGATE_DOCUMENTATION =
  "v3 层控 BIN 聚合：在「与 GET /infcontrol-layer-bins/v3 相同的筛选语义」（INFLAYERBINLIST.PASSTYPE='TEST' + v3 的 AND 条件；字符串 UPPER(TRIM)；未传 testStart/testEnd 时间键时默认最近一年 TESTEND）" +
  "所匹配的**全部行**上，**Oracle** 在库内 **UNPIVOT BIN0…BIN255** 后按 **PASSBIN** 整段 token（**`REGEXP_LIKE (^|-)k(-|$)`**）排除 good bin，再按 **groupBy** 维度 **SUM**，取合计最大的 Top groupTop 组；与 v3 **列表**不同：列表 FETCH FIRST :lim 仅最多 500 条明细，聚合统计筛选下的全量匹配行。" +
  "**Dummy**（`INFCONTROL_LAYER_BINS_DUMMY=true` 且非 dist/production）在 Node 内对 JBStart 样本行做与 **`aggregateInfcontrolLayerBinV3FromRows`** 等价的坏 bin SUM。" +
  "**groupBy** 除原有 token 外可增加 **probeCardType**（与列表 **PROBECARDTYPE** 一致：CARDID 首个「-」前段）。**SUM 仅累计坏 bin**：与列表 bins[].isGoodBin、与 /infcontrol-layer-bins/v2/top-bad-bins 的 token 规则一致；**不同于** v1 聚合的 BIN1 + N-M 两端排除。";

type ParseFail = { ok: false; error: string };
type ParseOk = {
  ok: true;
  whereSql: string;
  /** 与 **`parseInfcontrolLayerBinsV3Query`** 一致，**`t1`/`t2`** 别名；供 v4 列表 / 内存聚合拉全量行。 */
  listWhereAndSql: string;
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
 *（`PASSTYPE='TEST'` + `parseInfcontrolLayerBinsV3Query` 的 AND 条件；字符串 **`UPPER(TRIM)`**）。
 * **Oracle**：**`buildInfcontrolLayerBinAggregateSql`**（**`v3-hyphen-tokens`**）在库内 **UNPIVOT BIN0…BIN255** 后按 **`groupBy`** **SUM**，取 Top **`groupTop`** 组。
 * **Dummy**：与 **`/infcontrol-layer-bins/v3`** 同源样本，在 Node 内 **`aggregateInfcontrolLayerBinV3DummyRows`**。
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
    listWhereAndSql: v3.whereAndSql,
    binds: v3.binds,
    applied,
    groupBy,
    groupTop,
  };
}
