import type { Request, Response } from "express";
import oracledb, { type BindParameters } from "oracledb";
import { enrichOracleDriverDetail, sendAgentError } from "../../agentResponse.js";
import { reqId } from "../../routeHelpers.js";
import {
  INFCONTROL_LAYER_BIN_TOP,
  parseInfcontrolLayerBinQuery,
  parseInfcontrolLayerBinsV3Query,
} from "../infcontrolLayerBinFilters.js";
import {
  INFCONTROL_LAYER_BIN_V2_BAD_RANK_MAX,
  INFCONTROL_LAYER_BIN_V2_BAD_RANK_MIN,
  INFCONTROL_LAYER_BIN_V2_MAX_TOP,
  parseInfcontrolLayerBinV2BadBinsQuery,
  parseInfcontrolLayerBinV2Query,
} from "../infcontrolLayerBinV2Filters.js";
import {
  buildInfcontrolLayerBinV2BadBinTotalsSql,
  rankBadBinTotalsFromAggregateRow,
} from "../../infcontrolLayerBinV2BadBinsSql.js";
import { buildInfcontrolLayerBinV2TopSql } from "../../infcontrolLayerBinV2Sql.js";
import {
  API_V3_LIST_LIMIT_MAX,
  buildInfcontrolLayerBinsV3Sql,
  buildInfcontrolLayerBinsV3SqlFullMatching,
} from "../../apiV3ListSql.js";
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
} from "../infcontrolLayerBinDummy.js";
import type { InfcontrolLayerBinDummyRow } from "../infcontrolLayerBinDummy.js";
import {
  buildInfcontrolLayerBinAggregateGroupParts,
  buildInfcontrolLayerBinAggregateSql,
  buildInfcontrolLayerBinMatchingCountSql,
  parseInfcontrolLayerBinAggregateGroupSpec,
  parseInfcontrolLayerBinAggregateQuery,
  type InfcontrolLayerBinGroupBy,
} from "../infcontrolLayerBinAggregate.js";
import { parseAggsParam } from "../../parseAggsParam.js";
import {
  INFCONTROL_V3_AGGREGATE_DOCUMENTATION,
  parseInfcontrolLayerBinsV3AggregateQuery,
} from "../infcontrolLayerBinV3Aggregate.js";
import {
  enrichInfcontrolLayerBinRow,
  enrichInfcontrolLayerBinRowV2,
} from "../../passBinSemantics.js";
import { buildInfcontrolLayerBinTopSql } from "../../infcontrolLayerBinSql.js";
import { INFCONTROL_V4_AGGREGATE_DOCUMENTATION } from "../../apiV4Docs.js";
import { normalizeDbRowKeysUpper } from "../../dbRowKeyUpper.js";
import { readMemoryAggregateOracleMaxRows } from "../../memoryAggregateOracleLimits.js";
import { probeCardTypeLeadingSegment } from "../../probeCardTypeLeadingSegment.js";
import { deviceMask } from "../../deviceMask.js";
import { clampLimitFromQuery } from "../../sqlIdent.js";
import { withConnection } from "../../../oracle.js";

function enrichInfcontrolLayerBinV3ListRow(
  row: Record<string, unknown>
): Record<string, unknown> {
  const e = enrichInfcontrolLayerBinRowV2(row);
  return {
    ...e,
    PROBECARDTYPE: probeCardTypeLeadingSegment(e.CARDID ?? e.cardid),
    MASK: deviceMask(e.DEVICE ?? e.device),
  };
}

export async function handleInfcontrolLayerBins(
  req: Request,
  res: Response
) {
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
}

export async function handleInfcontrolLayerBinsV2(
  req: Request,
  res: Response
) {
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
}

export async function handleInfcontrolLayerBinsV3(
  req: Request,
  res: Response
) {
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
}

export async function handleInfcontrolLayerBinsV3Aggregate(
  req: Request,
  res: Response
) {
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
}

export async function handleInfcontrolLayerBinsV2TopBadBins(
  req: Request,
  res: Response
) {
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
}

export async function handleInfcontrolLayerBinsAggregate(
  req: Request,
  res: Response
) {
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
}

export async function handleInfcontrolLayerBinsV4(
  req: Request,
  res: Response
) {
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
}

export async function handleInfcontrolLayerBinsV4Aggregate(
  req: Request,
  res: Response
) {
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
}

export async function handleInfcontrolLayerBinsV4Combined(
  req: Request,
  res: Response
) {
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

  const aggsResult = parseAggsParam(req.query.aggs);
  if (!aggsResult.ok) {
    return sendAgentError(
      res,
      400,
      "VALIDATION_ERROR",
      aggsResult.error,
      "aggs format: groupBy:groupTop|groupBy:groupTop|… (e.g. bin:30|probeCardType,bin:25)"
    );
  }

  const limit = clampLimitFromQuery(
    req.query as Record<string, unknown>,
    200,
    API_V3_LIST_LIMIT_MAX
  );

  // Validate and resolve each agg spec's groupBy string → InfcontrolLayerBinGroupBy[]
  const resolvedSpecs: {
    key: string;
    groupBy: InfcontrolLayerBinGroupBy[];
    groupTop: number;
  }[] = [];
  for (const spec of aggsResult.specs) {
    const gs = parseInfcontrolLayerBinAggregateGroupSpec({
      groupBy: spec.groupBy,
      groupTop: String(spec.groupTop),
    });
    if (!gs.ok) {
      return sendAgentError(
        res,
        400,
        "VALIDATION_ERROR",
        `aggs groupBy "${spec.groupBy}": ${gs.error}`,
        "Each groupBy must include exactly one 'bin' dimension (e.g. probeCardType,bin)."
      );
    }
    // Use spec.groupTop (not gs.groupTop) — the combined endpoint has no groupTop cap
    resolvedSpecs.push({ key: spec.groupBy, groupBy: gs.groupBy, groupTop: spec.groupTop });
  }

  if (infcontrolLayerBinsUseDummy()) {
    const dummyRows = filterInfcontrolLayerBinV3DummyRows(parsed.applied, limit);
    const aggregates: Record<string, unknown> = {};
    for (const rs of resolvedSpecs) {
      const { totalRowsMatching, groups } = aggregateInfcontrolLayerBinV3FromRows(
        dummyRows,
        rs.groupBy,
        rs.groupTop
      );
      aggregates[rs.key] = { groupBy: rs.key, groupTop: rs.groupTop, totalRowsMatching, groups };
    }
    const enrichedRows = dummyRows.map((row) =>
      enrichInfcontrolLayerBinV3ListRow(row as Record<string, unknown>)
    );
    return res.json({
      meta: {
        apiVersion: "4",
        requestId: reqId(req),
        combinedPath: "infcontrol-layer-bins/v4/combined",
      },
      limit,
      limitMax: API_V3_LIST_LIMIT_MAX,
      orderBy: "TESTEND DESC NULLS LAST, SLOT, PASSID, PASSNUM",
      filters: { ...parsed.applied, limit },
      count: enrichedRows.length,
      rows: enrichedRows,
      aggregates,
    });
  }

  const sql = buildInfcontrolLayerBinsV3Sql(parsed.whereAndSql);
  const binds: BindParameters = { ...parsed.binds, lim: limit };

  try {
    const rawRows = await withConnection(async (conn) => {
      const result = await conn.execute(sql, binds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });
      return result.rows || [];
    });

    // Normalize column names to uppercase before aggregation (required by aggregateInfcontrolLayerBinV3FromRows)
    const normalizedRows = (rawRows as Record<string, unknown>[]).map(
      (r) => normalizeDbRowKeysUpper(r) as InfcontrolLayerBinDummyRow
    );

    // Aggregate BEFORE enrichment — enrichInfcontrolLayerBinV3ListRow strips BIN0…BIN255 columns
    const aggregates: Record<string, unknown> = {};
    for (const rs of resolvedSpecs) {
      const { totalRowsMatching, groups } = aggregateInfcontrolLayerBinV3FromRows(
        normalizedRows,
        rs.groupBy,
        rs.groupTop
      );
      aggregates[rs.key] = { groupBy: rs.key, groupTop: rs.groupTop, totalRowsMatching, groups };
    }

    // Enrich rows for display (adds PROBECARDTYPE, passBinPair, etc.)
    const enrichedRows = normalizedRows.map((r) =>
      enrichInfcontrolLayerBinV3ListRow(r as Record<string, unknown>)
    );

    return res.json({
      meta: {
        apiVersion: "4",
        requestId: reqId(req),
        combinedPath: "infcontrol-layer-bins/v4/combined",
      },
      limit,
      limitMax: API_V3_LIST_LIMIT_MAX,
      orderBy: "TESTEND DESC NULLS LAST, SLOT, PASSID, PASSNUM",
      filters: { ...parsed.applied, limit },
      count: enrichedRows.length,
      rows: enrichedRows,
      aggregates,
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
}
