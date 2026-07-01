import { INFCONTROL_LAYER_BIN_V2_MAX_TOP } from "./infcontrolLayerBinV2Filters.js";
import { infcontrolLayerBinV3BaseWhereBlock } from "./infcontrolLayerBinPasstypeScope.js";

/** v3 列表 `limit` 上限（与 v2 列表一致） */
export const API_V3_LIST_LIMIT_MAX = INFCONTROL_LAYER_BIN_V2_MAX_TOP;

/** 列表投影列（与历史 **`t1`/`t2`** 别名对外键名一致）。 */
function infcontrolLayerBinsV3SelectList(tInf: string, tLb: string): string {
  const bins = Array.from(
    { length: 255 },
    (_, i) => `    ${tLb}.BIN${i + 1}`
  ).join(",\n");
  return `
    ${tInf}.DEVICE,
    ${tInf}.LOT,
    ${tInf}.SLOT,
    ${tInf}.MESLOT,
    ${tLb}.TESTERID,
    ${tLb}.TSTYPE,
    ${tLb}.CARDID,
    ${tLb}.PIBID,
    ${tLb}.PROBE,
    ${tLb}.GROSSDIE,
    ${tLb}.PASSID,
    ${tLb}.PASSNUM,
    ${tLb}.TESTSTART,
    ${tLb}.TESTEND,
    ${tLb}.LAYERNAME,
    ${tLb}.PASSRESUME,
    ${tLb}.PASSTYPE,
    ${tLb}.PASSBIN,
${bins},
    ${tLb}.PASSRESULT`.trim();
}

const ORDER_BY_LAYER_BINS_V3_INNER =
  "ORDER BY t2.TESTEND DESC NULLS LAST, t1.SLOT, t2.PASSID, t2.PASSNUM";

const ORDER_BY_LAYER_BINS_V3_OUTER =
  "ORDER BY lb.TESTEND DESC NULLS LAST, ic.SLOT, lb.PASSID, lb.PASSNUM";

/**
 * INFCONTROL ⋈ INFLAYERBINLIST（`PASSTYPE = 'TEST'`），列集与业务约定一致；
 * 可选 **`whereAndSql`**：`AND` 连接的额外条件（不含 `WHERE`）；`FETCH FIRST :lim ROWS ONLY`。
 *
 * 内层 **`FETCH FIRST`** 仅选 **`INFLAYERBINLIST`** 的 **`ROWID`**（窄排序/管道），再 **`JOIN`** 回 **`lb`/`ic`**
 * 拉 **BIN1…BIN255**，通常比单段宽选列排序更易让优化器做 **Top-N**。
 */
export function buildInfcontrolLayerBinsV3Sql(whereAndSql: string): string {
  const whereBlock = infcontrolLayerBinV3BaseWhereBlock("t2", whereAndSql);
  const selectList = infcontrolLayerBinsV3SelectList("ic", "lb");
  return `
SELECT
${selectList}
FROM (
    SELECT t2.ROWID AS lb_rid
    FROM INFCONTROL t1
    INNER JOIN INFLAYERBINLIST t2 ON t1.KEYNUMBER = t2.KEYNUMBER
${whereBlock}
    ${ORDER_BY_LAYER_BINS_V3_INNER}
    FETCH FIRST :lim ROWS ONLY
) topn
INNER JOIN INFLAYERBINLIST lb ON lb.ROWID = topn.lb_rid
INNER JOIN INFCONTROL ic ON ic.KEYNUMBER = lb.KEYNUMBER
${ORDER_BY_LAYER_BINS_V3_OUTER}
`.trim();
}

/**
 * 与 **`buildInfcontrolLayerBinsV3Sql`** 相同 **WHERE** 与 **ORDER BY**，**无** **`FETCH FIRST`**
 *（**`/api/v4/…/aggregate`** Oracle 全量匹配行、Node 聚合）。**ROWID** 两段式与列表一致，避免对宽选列整集排序。
 */
/**
 * Distinct lots for agent `query_jb_bins` (mask/device scope): GROUP BY lot, ORDER BY MAX(TESTEND) DESC.
 * `COUNT(*) OVER ()` = total distinct lots in filter window; `FETCH FIRST :lot_lim` caps list size.
 */
export function buildInfcontrolLayerBinsV3DistinctLotsSql(whereAndSql: string): string {
  const whereBlock = infcontrolLayerBinV3BaseWhereBlock("t2", whereAndSql);
  return `
SELECT lot, device, last_testend, slot_count, total_distinct
FROM (
  SELECT
    t1.LOT AS lot,
    t1.DEVICE AS device,
    MAX(t2.TESTEND) AS last_testend,
    COUNT(DISTINCT t1.SLOT) AS slot_count,
    COUNT(*) OVER () AS total_distinct
  FROM INFCONTROL t1
  INNER JOIN INFLAYERBINLIST t2 ON t1.KEYNUMBER = t2.KEYNUMBER
  ${whereBlock}
  GROUP BY t1.LOT, t1.DEVICE
  ORDER BY MAX(t2.TESTEND) DESC NULLS LAST
)
FETCH FIRST :lot_lim ROWS ONLY
`.trim();
}

export function buildInfcontrolLayerBinsV3SqlFullMatching(whereAndSql: string): string {
  const whereBlock = infcontrolLayerBinV3BaseWhereBlock("t2", whereAndSql);
  const selectList = infcontrolLayerBinsV3SelectList("ic", "lb");
  return `
SELECT
${selectList}
FROM (
    SELECT t2.ROWID AS lb_rid
    FROM INFCONTROL t1
    INNER JOIN INFLAYERBINLIST t2 ON t1.KEYNUMBER = t2.KEYNUMBER
${whereBlock}
    ${ORDER_BY_LAYER_BINS_V3_INNER}
) topn
INNER JOIN INFLAYERBINLIST lb ON lb.ROWID = topn.lb_rid
INNER JOIN INFCONTROL ic ON ic.KEYNUMBER = lb.KEYNUMBER
${ORDER_BY_LAYER_BINS_V3_OUTER}
`.trim();
}

/**
 * probeweb：`YMWEB_YIELDMONITORTRIGGER` 全列；**`whereClause`** 由 **`parseYieldMonitorTriggerV3Query`** 生成（**恒含** **`TYPE = delta_diff`**），为 **`WHERE …`** 或空串；
 * `ORDER BY` + `FETCH FIRST :lim ROWS ONLY`。内层 **`ROWID` + Top-N**，再 **`JOIN`** 回表取全列（与 v4 列表同源优化）。
 */
export function buildYieldMonitorTriggersV3Sql(whereClause: string): string {
  const wc = whereClause.trim();
  const mid = wc ? `${wc}\n` : "";
  return `
SELECT t.*
FROM (
    SELECT t.ROWID AS rid
    FROM YMWEB_YIELDMONITORTRIGGER t
${mid}ORDER BY t.TIME_STAMP DESC NULLS LAST
    FETCH FIRST :lim ROWS ONLY
) topn
INNER JOIN YMWEB_YIELDMONITORTRIGGER t ON t.ROWID = topn.rid
ORDER BY t.TIME_STAMP DESC NULLS LAST
`.trim();
}

/**
 * 与 **`buildYieldMonitorTriggersV3Sql`** 相同 **WHERE** 与 **ORDER BY**，**无** **`FETCH FIRST`**
 *（**`/api/v4/…/aggregate`** Oracle 全量行）。**ROWID** 两段式与列表相同。
 */
export function buildYieldMonitorTriggersV3SqlFullMatching(whereClause: string): string {
  const wc = whereClause.trim();
  const mid = wc ? `${wc}\n` : "";
  return `
SELECT t.*
FROM (
    SELECT t.ROWID AS rid
    FROM YMWEB_YIELDMONITORTRIGGER t
${mid}ORDER BY t.TIME_STAMP DESC NULLS LAST
) topn
INNER JOIN YMWEB_YIELDMONITORTRIGGER t ON t.ROWID = topn.rid
ORDER BY t.TIME_STAMP DESC NULLS LAST
`.trim();
}
