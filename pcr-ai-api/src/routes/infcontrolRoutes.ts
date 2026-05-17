import { Router } from "express";
import oracledb, { type BindParameters } from "oracledb";
import { enrichOracleDriverDetail, sendAgentError } from "../lib/agentResponse.js";
import { reqId } from "../lib/routeHelpers.js";
import {
  INFCONTROL_LAYER_BIN_TOP,
  parseInfcontrolLayerBinQuery,
  parseInfcontrolLayerBinsV3Query,
} from "../lib/infcontrolLayerBinFilters.js";
import {
  INFCONTROL_LAYER_BIN_V2_BAD_RANK_MAX,
  INFCONTROL_LAYER_BIN_V2_BAD_RANK_MIN,
  INFCONTROL_LAYER_BIN_V2_MAX_TOP,
  parseInfcontrolLayerBinV2BadBinsQuery,
  parseInfcontrolLayerBinV2Query,
} from "../lib/infcontrolLayerBinV2Filters.js";
import {
  buildInfcontrolLayerBinV2BadBinTotalsSql,
  rankBadBinTotalsFromAggregateRow,
} from "../lib/infcontrolLayerBinV2BadBinsSql.js";
import { buildInfcontrolLayerBinV2TopSql } from "../lib/infcontrolLayerBinV2Sql.js";
import {
  API_V3_LIST_LIMIT_MAX,
  buildInfcontrolLayerBinsV3Sql,
  buildInfcontrolLayerBinsV3SqlFullMatching,
} from "../lib/apiV3ListSql.js";
import {
  aggregateInfcontrolLayerBinDummyRows,
  aggregateInfcontrolLayerBinV2BadBinsDummy,
  aggregateInfcontrolLayerBinV3DummyRows,
  aggregateInfcontrolLayerBinV3FromRows,
  filterInfcontrolLayerBinV2DummyRows,
  filterInfcontrolLayerBinV3DummyRows,
  filterInfcontrolLayerBinV3DummyRowsMatching,
  filterInfcontrolLayerDummyRows,
  infcontrolLayerBinsUseDummy,
} from "../lib/infcontrolLayerBinDummy.js";
import type { InfcontrolLayerBinDummyRow } from "../lib/infcontrolLayerBinDummy.js";
import {
  buildInfcontrolLayerBinAggregateGroupParts,
  buildInfcontrolLayerBinAggregateSql,
  buildInfcontrolLayerBinMatchingCountSql,
  parseInfcontrolLayerBinAggregateQuery,
} from "../lib/infcontrolLayerBinAggregate.js";
import {
  INFCONTROL_V3_AGGREGATE_DOCUMENTATION,
  parseInfcontrolLayerBinsV3AggregateQuery,
} from "../lib/infcontrolLayerBinV3Aggregate.js";
import {
  enrichInfcontrolLayerBinRow,
  enrichInfcontrolLayerBinRowV2,
} from "../lib/passBinSemantics.js";
import { buildInfcontrolLayerBinTopSql } from "../lib/infcontrolLayerBinSql.js";
import { INFCONTROL_V4_AGGREGATE_DOCUMENTATION } from "../lib/apiV4Docs.js";
import { normalizeDbRowKeysUpper } from "../lib/dbRowKeyUpper.js";
import { readMemoryAggregateOracleMaxRows } from "../lib/memoryAggregateOracleLimits.js";
import { probeCardTypeLeadingSegment } from "../lib/probeCardTypeLeadingSegment.js";
import { clampLimitFromQuery } from "../lib/sqlIdent.js";
import { withConnection } from "../oracle.js";

export const infcontrolRouter = Router();

function enrichInfcontrolLayerBinV3ListRow(
  row: Record<string, unknown>
): Record<string, unknown> {
  const e = enrichInfcontrolLayerBinRowV2(row);
  return {
    ...e,
    PROBECARDTYPE: probeCardTypeLeadingSegment(e.CARDID ?? e.cardid),
  };
}

infcontrolRouter.get("/infcontrol-layer-bins", async (req, res) => {
  const parsed = parseInfcontrolLayerBinQuery(
    req.query as Record<string, unknown>
  );
  if (!parsed.ok) {
    return sendAgentError(
      res,
      400,
      "VALIDATION_ERROR",
      parsed.error,
      "Check query parameters (see GET /api/v1/manifest)."
    );
  }

  if (infcontrolLayerBinsUseDummy()) {
    const rows = filterInfcontrolLayerDummyRows(parsed.applied).map(
      (row) => enrichInfcontrolLayerBinRow(row as Record<string, unknown>)
    );
    return res.json({
      meta: {
        apiVersion: "1",
        requestId: reqId(req),
      },
      limit: INFCONTROL_LAYER_BIN_TOP,
      orderBy: "TESTEND DESC NULLS LAST, KEYNUMBER DESC NULLS LAST",
      filters: parsed.applied,
      count: rows.length,
      rows,
    });
  }

  const sql = buildInfcontrolLayerBinTopSql(parsed.whereSql);
  const binds: BindParameters = {
    ...parsed.binds,
    lim: INFCONTROL_LAYER_BIN_TOP,
  };

  try {
    const rows = await withConnection(async (conn) => {
      const result = await conn.execute(
        sql,
        binds,
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      return result.rows || [];
    });
    const withoutRnum = rows.map((row) => {
      const o = { ...(row as Record<string, unknown>) };
      delete o.RNUM;
      delete o.rnum;
      return enrichInfcontrolLayerBinRow(o);
    });
    return res.json({
      meta: {
        apiVersion: "1",
        requestId: reqId(req),
      },
      limit: INFCONTROL_LAYER_BIN_TOP,
      orderBy: "TESTEND DESC NULLS LAST, KEYNUMBER DESC NULLS LAST",
      filters: parsed.applied,
      count: withoutRnum.length,
      rows: withoutRnum,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return sendAgentError(
      res,
      500,
      "ORACLE_QUERY_FAILED",
      "Oracle query failed",
      enrichOracleDriverDetail(message)
    );
  }
});

/**
 * **v2** INFCONTROL ⋈ INFLAYERBINLIST（**`KEYNUMBER`**）。精简列；**`PASSBIN`** 为 **`1-2-55`** 形式（`-` 分隔 good bin 下标）；
 * 响应 **`bins`**：`{ value, n, isGoodBin }[]`（仅非空 BIN 列）。**无** `bin*` / **`passBin`** 筛选；**`limit`** 默认 200、上限见响应 **`limitMax`**。
 * 排序：`TESTEND DESC NULLS LAST`，`KEYNUMBER DESC NULLS LAST`。
 */
infcontrolRouter.get("/infcontrol-layer-bins/v2", async (req, res) => {
  const parsed = parseInfcontrolLayerBinV2Query(
    req.query as Record<string, unknown>
  );
  if (!parsed.ok) {
    return sendAgentError(
      res,
      400,
      "VALIDATION_ERROR",
      parsed.error,
      "Check query parameters (see GET /api/v1/manifest infcontrol-layer-bins/v2)."
    );
  }

  if (infcontrolLayerBinsUseDummy()) {
    const rows = filterInfcontrolLayerBinV2DummyRows(
      parsed.applied,
      parsed.limit
    ).map((row) =>
      enrichInfcontrolLayerBinRowV2(row as Record<string, unknown>)
    );
    return res.json({
      meta: {
        apiVersion: "1",
        requestId: reqId(req),
      },
      limit: parsed.limit,
      limitMax: INFCONTROL_LAYER_BIN_V2_MAX_TOP,
      orderBy: "TESTEND DESC NULLS LAST, KEYNUMBER DESC NULLS LAST",
      filters: parsed.applied,
      count: rows.length,
      rows,
    });
  }

  const sql = buildInfcontrolLayerBinV2TopSql(parsed.whereSql);
  const binds: BindParameters = {
    ...parsed.binds,
    lim: parsed.limit,
  };

  try {
    const rows = await withConnection(async (conn) => {
      const result = await conn.execute(
        sql,
        binds,
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      return result.rows || [];
    });
    const withoutRnum = rows.map((row) => {
      const o = { ...(row as Record<string, unknown>) };
      delete o.RNUM;
      delete o.rnum;
      return enrichInfcontrolLayerBinRowV2(o);
    });
    return res.json({
      meta: {
        apiVersion: "1",
        requestId: reqId(req),
      },
      limit: parsed.limit,
      limitMax: INFCONTROL_LAYER_BIN_V2_MAX_TOP,
      orderBy: "TESTEND DESC NULLS LAST, KEYNUMBER DESC NULLS LAST",
      filters: parsed.applied,
      count: withoutRnum.length,
      rows: withoutRnum,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return sendAgentError(
      res,
      500,
      "ORACLE_QUERY_FAILED",
      "Oracle query failed",
      enrichOracleDriverDetail(message)
    );
  }
});

/**
 * **v3** 层控 + 层 BIN：INFCONTROL ⋈ INFLAYERBINLIST（`PASSTYPE='TEST'`）。**`INFCONTROL_LAYER_BINS_DUMMY=true`**（且非 `dist`/production 强制走库）时走 **`docs/JBStart.xlsx`** 内存样本；否则 **主库 Oracle**。
 * 支持 **`limit`**（默认 200，最大 **`limitMax`**；键名不区分大小写）及 **device, lot, slot, meslot, testerId, tstype, cardId, passId** 与 **TESTSTART / TESTEND** 时间窗。
 * 若请求**未带**任一 **testStart\*** / **testEnd\*** 查询键，服务端追加 **`t2.TESTEND`** 在 **UTC 当前起向前一个日历年**内（与 **`parseInfcontrolLayerBinsV3Query`** 默认一致）。
 * 字符串筛选 Dummy 侧等价 **`UPPER(TRIM)`**（trim + 大小写不敏感）。行形状与 **v2** 一致，并多 **`PROBECARDTYPE`**（**`CARDID`** 按首个 **`-`** 拆出的前段）。
 */
infcontrolRouter.get("/infcontrol-layer-bins/v3", async (req, res) => {
  const parsed = parseInfcontrolLayerBinsV3Query(
    req.query as Record<string, unknown>
  );
  if (!parsed.ok) {
    return sendAgentError(
      res,
      400,
      "VALIDATION_ERROR",
      parsed.error,
      "See GET /api/v1/manifest infcontrol-layer-bins/v3."
    );
  }

  const limit = clampLimitFromQuery(
    req.query as Record<string, unknown>,
    200,
    API_V3_LIST_LIMIT_MAX
  );

  if (infcontrolLayerBinsUseDummy()) {
    const rows = filterInfcontrolLayerBinV3DummyRows(parsed.applied, limit);
    const enriched = rows.map((row) =>
      enrichInfcontrolLayerBinV3ListRow(row as Record<string, unknown>)
    );
    return res.json({
      meta: {
        apiVersion: "3",
        requestId: reqId(req),
      },
      limit,
      limitMax: API_V3_LIST_LIMIT_MAX,
      orderBy: "TESTEND DESC NULLS LAST, SLOT, PASSID, PASSNUM",
      filters: { ...parsed.applied, limit },
      count: enriched.length,
      rows: enriched,
    });
  }

  const sql = buildInfcontrolLayerBinsV3Sql(parsed.whereAndSql);
  const binds: BindParameters = { ...parsed.binds, lim: limit };

  try {
    const rows = await withConnection(async (conn) => {
      const result = await conn.execute(sql, binds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });
      return result.rows || [];
    });
    const enriched = rows.map((row) =>
      enrichInfcontrolLayerBinV3ListRow(row as Record<string, unknown>)
    );
    return res.json({
      meta: {
        apiVersion: "3",
        requestId: reqId(req),
      },
      limit,
      limitMax: API_V3_LIST_LIMIT_MAX,
      orderBy: "TESTEND DESC NULLS LAST, SLOT, PASSID, PASSNUM",
      filters: { ...parsed.applied, limit },
      count: enriched.length,
      rows: enriched,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return sendAgentError(
      res,
      500,
      "ORACLE_QUERY_FAILED",
      "Oracle query failed",
      enrichOracleDriverDetail(message)
    );
  }
});

/**
 * **v3 层控 BIN 聚合**：与 **`/infcontrol-layer-bins/v3`** 相同筛选语义。**SUM** 仅累计 **坏 bin** die：与 v3 列表 **`bins[].isGoodBin`** 一致。**Dummy** 在 Node 内聚合；**Oracle** 在库内 **UNPIVOT + SUM**（**`v3-hyphen-tokens`** good-bin 规则）。无 **`MEMORY_AGG_ORACLE_MAX_ROWS`** 上限（与 v4 内存聚合不同）。
 * 响应体含 **`documentation`**。详见 manifest 与 **`docs/AI_AGENT_API.md`**。
 */
infcontrolRouter.get("/infcontrol-layer-bins/v3/aggregate", async (req, res) => {
  const parsed = parseInfcontrolLayerBinsV3AggregateQuery(
    req.query as Record<string, unknown>
  );
  if (!parsed.ok) {
    return sendAgentError(
      res,
      400,
      "VALIDATION_ERROR",
      parsed.error,
      "See GET /api/v1/manifest infcontrol-layer-bins/v3/aggregate."
    );
  }

  if (infcontrolLayerBinsUseDummy()) {
    const { totalRowsMatching, groups } = aggregateInfcontrolLayerBinV3DummyRows(
      parsed.applied,
      parsed.groupBy,
      parsed.groupTop
    );
    return res.json({
      meta: {
        apiVersion: "3",
        requestId: reqId(req),
        aggregatePath: "infcontrol-layer-bins/v3/aggregate",
      },
      documentation: INFCONTROL_V3_AGGREGATE_DOCUMENTATION,
      groupBy: parsed.groupBy,
      groupTop: parsed.groupTop,
      orderBy: "SUM(unpivoted bin column) DESC NULLS LAST",
      filters: parsed.applied,
      totalRowsMatching,
      groups,
    });
  }

  const aggSql = buildInfcontrolLayerBinAggregateSql(
    parsed.whereSql,
    parsed.groupBy,
    "v3-hyphen-tokens"
  );
  const countSql = buildInfcontrolLayerBinMatchingCountSql(parsed.whereSql);
  const bindAgg: BindParameters = {
    ...parsed.binds,
    agg_lim: parsed.groupTop,
  };

  try {
    const [aggRows, countRows] = await withConnection(async (conn) => {
      const aggResult = await conn.execute(aggSql, bindAgg, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });
      const countResult = await conn.execute(countSql, parsed.binds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });
      return [aggResult.rows || [], countResult.rows || []] as const;
    });

    const totalObj =
      (countRows[0] as Record<string, unknown> | undefined) ?? {};
    const totalRaw =
      totalObj.TOTAL_MATCHING ?? totalObj.total_matching ?? totalObj.TOTAL;
    const totalRowsMatching =
      totalRaw != null && totalRaw !== "" ? Number(totalRaw) : 0;

    const groups = (aggRows as Record<string, unknown>[])
      .filter((row) => {
        const cntRaw = row.CNT ?? row.cnt;
        return cntRaw != null && cntRaw !== "";
      })
      .map((row) => {
        const keyRaw = row.GRP_KEY ?? row.grp_key;
        const cntRaw = row.CNT ?? row.cnt;
        const keyStr = keyRaw == null ? "" : String(keyRaw);
        const n = Number(cntRaw);
        return {
          key: keyStr,
          count: Number.isFinite(n) ? n : 0,
          parts: buildInfcontrolLayerBinAggregateGroupParts(
            keyStr,
            parsed.groupBy
          ),
        };
      });

    return res.json({
      meta: {
        apiVersion: "3",
        requestId: reqId(req),
        aggregatePath: "infcontrol-layer-bins/v3/aggregate",
      },
      documentation: INFCONTROL_V3_AGGREGATE_DOCUMENTATION,
      groupBy: parsed.groupBy,
      groupTop: parsed.groupTop,
      orderBy: "SUM(unpivoted bin column) DESC NULLS LAST",
      filters: parsed.applied,
      totalRowsMatching,
      groups,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return sendAgentError(
      res,
      500,
      "ORACLE_QUERY_FAILED",
      "Oracle query failed",
      enrichOracleDriverDetail(message)
    );
  }
});

/**
 * 与 **infcontrol-layer-bins/v2** 相同 **WHERE**（无列表 **`limit`**）：对匹配全表按行用 **PASSBIN**（`-` 分隔 good bin）
 * 判定 bad，对每个 **BINn** 累计 **SUM**（die 数），返回 bad 合计最高的前 **`rankTop`** 个下标（**5–10**，默认 **10**）。
 */
infcontrolRouter.get("/infcontrol-layer-bins/v2/top-bad-bins", async (req, res) => {
  const parsed = parseInfcontrolLayerBinV2BadBinsQuery(
    req.query as Record<string, unknown>
  );
  if (!parsed.ok) {
    return sendAgentError(
      res,
      400,
      "VALIDATION_ERROR",
      parsed.error,
      "See GET /api/v1/manifest infcontrol-layer-bins/v2/top-bad-bins."
    );
  }

  if (infcontrolLayerBinsUseDummy()) {
    const bins = aggregateInfcontrolLayerBinV2BadBinsDummy(
      parsed.applied,
      parsed.rankTop
    );
    return res.json({
      meta: {
        apiVersion: "1",
        requestId: reqId(req),
      },
      rankTop: parsed.rankTop,
      rankTopMin: INFCONTROL_LAYER_BIN_V2_BAD_RANK_MIN,
      rankTopMax: INFCONTROL_LAYER_BIN_V2_BAD_RANK_MAX,
      orderBy: "badTotal DESC NULLS LAST, n ASC NULLS LAST",
      filters: parsed.applied,
      bins,
    });
  }

  const sql = buildInfcontrolLayerBinV2BadBinTotalsSql(parsed.whereSql);
  const binds: BindParameters = { ...parsed.binds };

  try {
    const aggRows = await withConnection(async (conn) => {
      const result = await conn.execute(
        sql,
        binds,
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      return result.rows || [];
    });
    const row = (aggRows[0] ?? {}) as Record<string, unknown>;
    const bins = rankBadBinTotalsFromAggregateRow(row, parsed.rankTop);
    return res.json({
      meta: {
        apiVersion: "1",
        requestId: reqId(req),
      },
      rankTop: parsed.rankTop,
      rankTopMin: INFCONTROL_LAYER_BIN_V2_BAD_RANK_MIN,
      rankTopMax: INFCONTROL_LAYER_BIN_V2_BAD_RANK_MAX,
      orderBy: "badTotal DESC NULLS LAST, n ASC NULLS LAST",
      filters: parsed.applied,
      bins,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return sendAgentError(
      res,
      500,
      "ORACLE_QUERY_FAILED",
      "Oracle query failed",
      enrichOracleDriverDetail(message)
    );
  }
});

/**
 * 与列表相同筛选（device、lot、slot、tstype、cardId、testEndFrom/To 等）；对 BIN0…BIN255 先 UNPIVOT 再 SUM，
 * 取合计最大的 Top **groupTop** 个 BIN（默认 groupBy=`bin`；可选复合维度见 manifest）。
 * **BIN1**（硬良品）列不计入 SUM；**PASSBIN** 为 **N-M** 时两端 BIN 列亦不计入（与 **passBinPair** 一致）。
 */
infcontrolRouter.get("/infcontrol-layer-bins/aggregate", async (req, res) => {
  const parsed = parseInfcontrolLayerBinAggregateQuery(
    req.query as Record<string, unknown>
  );
  if (!parsed.ok) {
    return sendAgentError(
      res,
      400,
      "VALIDATION_ERROR",
      parsed.error,
      "See GET /api/v1/manifest for infcontrol-layer-bins/aggregate parameters."
    );
  }

  if (infcontrolLayerBinsUseDummy()) {
    const { totalRowsMatching, groups } = aggregateInfcontrolLayerBinDummyRows(
      parsed.applied,
      parsed.groupBy,
      parsed.groupTop
    );
    return res.json({
      meta: {
        apiVersion: "1",
        requestId: reqId(req),
      },
      groupBy: parsed.groupBy,
      groupTop: parsed.groupTop,
      orderBy: "SUM(unpivoted bin column) DESC NULLS LAST",
      filters: parsed.applied,
      totalRowsMatching,
      groups,
    });
  }

  const aggSql = buildInfcontrolLayerBinAggregateSql(
    parsed.whereSql,
    parsed.groupBy
  );
  const countSql = buildInfcontrolLayerBinMatchingCountSql(parsed.whereSql);
  const bindAgg: BindParameters = {
    ...parsed.binds,
    agg_lim: parsed.groupTop,
  };

  try {
    const [aggRows, countRows] = await withConnection(async (conn) => {
      const aggResult = await conn.execute(aggSql, bindAgg, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });
      const countResult = await conn.execute(countSql, parsed.binds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });
      return [aggResult.rows || [], countResult.rows || []] as const;
    });

    const totalObj =
      (countRows[0] as Record<string, unknown> | undefined) ?? {};
    const totalRaw =
      totalObj.TOTAL_MATCHING ?? totalObj.total_matching ?? totalObj.TOTAL;
    const totalRowsMatching =
      totalRaw != null && totalRaw !== "" ? Number(totalRaw) : 0;

    const groups = (aggRows as Record<string, unknown>[])
      .filter((row) => {
        const cntRaw = row.CNT ?? row.cnt;
        return cntRaw != null && cntRaw !== "";
      })
      .map((row) => {
        const keyRaw = row.GRP_KEY ?? row.grp_key;
        const cntRaw = row.CNT ?? row.cnt;
        const keyStr = keyRaw == null ? "" : String(keyRaw);
        const n = Number(cntRaw);
        return {
          key: keyStr,
          count: Number.isFinite(n) ? n : 0,
          parts: buildInfcontrolLayerBinAggregateGroupParts(
            keyStr,
            parsed.groupBy
          ),
        };
      });

    return res.json({
      meta: {
        apiVersion: "1",
        requestId: reqId(req),
      },
      groupBy: parsed.groupBy,
      groupTop: parsed.groupTop,
      orderBy: "SUM(unpivoted bin column) DESC NULLS LAST",
      filters: parsed.applied,
      totalRowsMatching,
      groups,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return sendAgentError(
      res,
      500,
      "ORACLE_QUERY_FAILED",
      "Oracle query failed",
      enrichOracleDriverDetail(message)
    );
  }
});

/**
 * **v4** 层控列表：筛选 / 排序 / **`limit`** 与 **v3** 相同；**`meta.apiVersion`** 为 **`"4"`**。
 */
infcontrolRouter.get("/infcontrol-layer-bins/v4", async (req, res) => {
  const parsed = parseInfcontrolLayerBinsV3Query(
    req.query as Record<string, unknown>
  );
  if (!parsed.ok) {
    return sendAgentError(
      res,
      400,
      "VALIDATION_ERROR",
      parsed.error,
      "See GET /api/v1/manifest infcontrol-layer-bins/v4."
    );
  }

  const limit = clampLimitFromQuery(
    req.query as Record<string, unknown>,
    200,
    API_V3_LIST_LIMIT_MAX
  );

  if (infcontrolLayerBinsUseDummy()) {
    const rows = filterInfcontrolLayerBinV3DummyRows(parsed.applied, limit);
    const enriched = rows.map((row) =>
      enrichInfcontrolLayerBinV3ListRow(row as Record<string, unknown>)
    );
    return res.json({
      meta: {
        apiVersion: "4",
        requestId: reqId(req),
      },
      limit,
      limitMax: API_V3_LIST_LIMIT_MAX,
      orderBy: "TESTEND DESC NULLS LAST, SLOT, PASSID, PASSNUM",
      filters: { ...parsed.applied, limit },
      count: enriched.length,
      rows: enriched,
    });
  }

  const sql = buildInfcontrolLayerBinsV3Sql(parsed.whereAndSql);
  const binds: BindParameters = { ...parsed.binds, lim: limit };

  try {
    const rows = await withConnection(async (conn) => {
      const result = await conn.execute(sql, binds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });
      return result.rows || [];
    });
    const enriched = rows.map((row) =>
      enrichInfcontrolLayerBinV3ListRow(row as Record<string, unknown>)
    );
    return res.json({
      meta: {
        apiVersion: "4",
        requestId: reqId(req),
      },
      limit,
      limitMax: API_V3_LIST_LIMIT_MAX,
      orderBy: "TESTEND DESC NULLS LAST, SLOT, PASSID, PASSNUM",
      filters: { ...parsed.applied, limit },
      count: enriched.length,
      rows: enriched,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return sendAgentError(
      res,
      500,
      "ORACLE_QUERY_FAILED",
      "Oracle query failed",
      enrichOracleDriverDetail(message)
    );
  }
});

/**
 * **v4 层控 BIN 聚合**：**`groupBy` / `groupTop`** 与 v3 相同；在**与 v4 列表同一套筛选**下先 **COUNT** 匹配行（超过 **`MEMORY_AGG_ORACLE_MAX_ROWS`** 则 **422**），再拉全量行（无 **`FETCH FIRST`**）在 Node 内 **SUM**。
 */
infcontrolRouter.get("/infcontrol-layer-bins/v4/aggregate", async (req, res) => {
  const parsed = parseInfcontrolLayerBinsV3AggregateQuery(
    req.query as Record<string, unknown>
  );
  if (!parsed.ok) {
    return sendAgentError(
      res,
      400,
      "VALIDATION_ERROR",
      parsed.error,
      "See GET /api/v1/manifest infcontrol-layer-bins/v4/aggregate."
    );
  }

  const maxRowsIcV4Agg = readMemoryAggregateOracleMaxRows();

  if (infcontrolLayerBinsUseDummy()) {
    const rawRows = filterInfcontrolLayerBinV3DummyRowsMatching(parsed.applied);
    if (rawRows.length > maxRowsIcV4Agg) {
      return sendAgentError(
        res,
        422,
        "QUERY_TOO_LARGE",
        `Matching rows (${rawRows.length}) exceed MEMORY_AGG_ORACLE_MAX_ROWS (${maxRowsIcV4Agg}). Narrow filters (device, lot, testEnd*, etc.).`,
        "See .env.example MEMORY_AGG_ORACLE_MAX_ROWS."
      );
    }
    const { totalRowsMatching, groups } = aggregateInfcontrolLayerBinV3FromRows(
      rawRows,
      parsed.groupBy,
      parsed.groupTop
    );
    return res.json({
      meta: {
        apiVersion: "4",
        requestId: reqId(req),
        aggregatePath: "infcontrol-layer-bins/v4/aggregate",
      },
      documentation: INFCONTROL_V4_AGGREGATE_DOCUMENTATION,
      groupBy: parsed.groupBy,
      groupTop: parsed.groupTop,
      orderBy: "SUM(unpivoted bin column) DESC NULLS LAST",
      filters: parsed.applied,
      totalRowsMatching,
      groups,
    });
  }

  const countSql = buildInfcontrolLayerBinMatchingCountSql(parsed.whereSql);
  const listSql = buildInfcontrolLayerBinsV3SqlFullMatching(parsed.listWhereAndSql);

  try {
    const { totalRowsMatching, rows } = await withConnection(async (conn) => {
      const countResult = await conn.execute(countSql, parsed.binds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });
      const totalObj =
        (countResult.rows?.[0] as Record<string, unknown> | undefined) ?? {};
      const totalRaw =
        totalObj.TOTAL_MATCHING ?? totalObj.total_matching ?? totalObj.TOTAL;
      const total =
        totalRaw != null && totalRaw !== "" ? Number(totalRaw) : 0;
      if (total > maxRowsIcV4Agg) {
        return { totalRowsMatching: total, rows: null as unknown[] | null };
      }
      const data = await conn.execute(listSql, parsed.binds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });
      return { totalRowsMatching: total, rows: data.rows || [] };
    });

    if (rows === null) {
      return sendAgentError(
        res,
        422,
        "QUERY_TOO_LARGE",
        `Matching rows (${totalRowsMatching}) exceed MEMORY_AGG_ORACLE_MAX_ROWS (${maxRowsIcV4Agg}). Narrow filters (device, lot, testEnd*, etc.).`,
        "See .env.example MEMORY_AGG_ORACLE_MAX_ROWS."
      );
    }

    const normalizedRows = (rows as Record<string, unknown>[]).map(
      (r) => normalizeDbRowKeysUpper(r) as InfcontrolLayerBinDummyRow
    );
    const { groups } = aggregateInfcontrolLayerBinV3FromRows(
      normalizedRows,
      parsed.groupBy,
      parsed.groupTop
    );

    return res.json({
      meta: {
        apiVersion: "4",
        requestId: reqId(req),
        aggregatePath: "infcontrol-layer-bins/v4/aggregate",
      },
      documentation: INFCONTROL_V4_AGGREGATE_DOCUMENTATION,
      groupBy: parsed.groupBy,
      groupTop: parsed.groupTop,
      orderBy: "SUM(unpivoted bin column) DESC NULLS LAST",
      filters: parsed.applied,
      totalRowsMatching,
      groups,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return sendAgentError(
      res,
      500,
      "ORACLE_QUERY_FAILED",
      "Oracle query failed",
      enrichOracleDriverDetail(message)
    );
  }
});
