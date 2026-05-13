import { INFCONTROL_LAYER_BIN_V2_MAX_TOP } from "./infcontrolLayerBinV2Filters.js";

/** v3 列表 `limit` 上限（与 v2 列表一致） */
export const API_V3_LIST_LIMIT_MAX = INFCONTROL_LAYER_BIN_V2_MAX_TOP;

const BIN1_THROUGH_255 = Array.from(
  { length: 255 },
  (_, i) => `    t2.BIN${i + 1}`
).join(",\n");

/**
 * INFCONTROL ⋈ INFLAYERBINLIST（`PASSTYPE = 'TEST'`），列集与业务约定一致；
 * 可选 **`whereAndSql`**：`AND` 连接的额外条件（不含 `WHERE`）；`FETCH FIRST :lim ROWS ONLY`。
 */
export function buildInfcontrolLayerBinsV3Sql(whereAndSql: string): string {
  const extra = whereAndSql.trim();
  const whereBlock = extra
    ? `WHERE t2.PASSTYPE = 'TEST' AND ${extra}`
    : `WHERE t2.PASSTYPE = 'TEST'`;
  return `
SELECT
    t1.DEVICE,
    t1.LOT,
    t1.SLOT,
    t1.MESLOT,
    t2.TESTERID,
    t2.TSTYPE,
    t2.CARDID,
    t2.PIBID,
    t2.PROBE,
    t2.GROSSDIE,
    t2.PASSID,
    t2.PASSNUM,
    t2.TESTSTART,
    t2.TESTEND,
    t2.LAYERNAME,
    t2.PASSRESUME,
    t2.PASSTYPE,
    t2.PASSBIN,
${BIN1_THROUGH_255},
    t2.PASSRESULT
FROM INFCONTROL t1
INNER JOIN INFLAYERBINLIST t2
    ON t1.KEYNUMBER = t2.KEYNUMBER
${whereBlock}
ORDER BY t2.TESTEND DESC NULLS LAST, t1.SLOT, t2.PASSID, t2.PASSNUM
FETCH FIRST :lim ROWS ONLY
`.trim();
}

/**
 * probeweb：`YMWEB_YIELDMONITORTRIGGER` 全列；可选 `whereClause`（`WHERE ...` 或空），
 * `ORDER BY` + `FETCH FIRST :lim ROWS ONLY`。
 */
export function buildYieldMonitorTriggersV3Sql(whereClause: string): string {
  const wc = whereClause.trim();
  const mid = wc ? `${wc}\n` : "";
  return `
SELECT *
FROM YMWEB_YIELDMONITORTRIGGER t
${mid}ORDER BY t.TIME_STAMP DESC NULLS LAST
FETCH FIRST :lim ROWS ONLY
`.trim();
}
