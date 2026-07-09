import { Router } from "express";
import oracledb, { type BindParameters } from "oracledb";
import { enrichOracleDriverDetail, sendAgentError } from "../lib/agentResponse.js";
import { reqId } from "../lib/routeHelpers.js";
import {
  YIELD_MONITOR_TRIGGER_TOP,
  parseYieldMonitorTriggerQuery,
  parseYieldMonitorTriggerV3Query,
} from "../lib/yieldMonitorTriggerFilters.js";
import {
  YIELD_MONITOR_V3_AGGREGATE_DOCUMENTATION,
  buildYieldMonitorTriggerV3AggregateSqlWithTotal,
  mapYieldMonitorV3AggregateRows,
  parseYieldMonitorTriggerV3AggregateQuery,
  type YieldMonitorV3AggDim,
} from "../lib/yieldMonitorTriggerV3Aggregate.js";
import { buildYieldMonitorTriggerMatchingCountSql } from "../lib/yieldMonitorTriggerAggregate.js";
import {
  buildYieldMonitorHostnameSummarySql,
  buildYieldMonitorProbeCardSummarySql,
  buildYieldMonitorTriggerTopSql,
} from "../lib/yieldMonitorTriggerSql.js";
import {
  aggregateYieldMonitorV3DummyRows,
  aggregateYieldMonitorV3FromRows,
  buildYieldMonitorHostnameSummaryDummy,
  buildYieldMonitorProbeCardSummaryDummy,
  filterYieldMonitorDummyRows,
  filterYieldMonitorDummyRowsMatchingV3,
  filterYieldMonitorDummyRowsV3,
  yieldMonitorTriggersUseDummy,
} from "../lib/yieldMonitorTriggerDummy.js";
import type { YieldMonitorTriggerDummyRow } from "../lib/yieldMonitorTriggerDummy.js";
import { YIELD_MONITOR_V4_AGGREGATE_DOCUMENTATION } from "../lib/apiV4Docs.js";
import { normalizeDbRowKeysUpper } from "../lib/dbRowKeyUpper.js";
import { readMemoryAggregateOracleMaxRows } from "../lib/memoryAggregateOracleLimits.js";
import { probeCardTypeLeadingSegment } from "../lib/probeCardTypeLeadingSegment.js";
import { deviceMask } from "../lib/deviceMask.js";
import {
  API_V3_LIST_LIMIT_MAX,
  buildYieldMonitorTriggersV3Sql,
  buildYieldMonitorTriggersV3SqlFullMatching,
} from "../lib/apiV3ListSql.js";
import { clampLimitFromQuery } from "../lib/sqlIdent.js";
import { parseAggsParam } from "../lib/parseAggsParam.js";
import { withConnection, withProbeWebConnection } from "../oracle.js";
import { addDutNumberToYieldMonitorV3Row } from "../lib/yieldTriggerLabelDut.js";
import {
  PERIOD_ALARM_TREND_DOCUMENTATION,
  aggregatePeriodAlarmTrendDummy,
  attachPeriodAlarmTopDevices,
  attachPeriodAlarmTopProbeCards,
  attachPeriodAlarmTopTesters,
  buildPeriodAlarmJbSlotTuplesSql,
  buildPeriodAlarmTrendSql,
  buildPeriodAlarmTrendTopDevicesSql,
  buildPeriodAlarmTrendTopProbeCardsSql,
  buildPeriodAlarmTrendTopTestersSql,
  mapPeriodAlarmTrendRows,
  mergePeriodAlarmJbSlotDenominator,
  parsePeriodAlarmTrendQuery,
  periodAlarmTrendJbSlotBinds,
  periodAlarmTrendMainBinds,
  periodAlarmTrendTopBinds,
} from "../lib/yieldMonitorPeriodAlarmTrend.js";

export const yieldMonitorRouter = Router();

function enrichYieldMonitorTriggerV3ListRow(
  row: Record<string, unknown>
): Record<string, unknown> {
  const base = addDutNumberToYieldMonitorV3Row(row);
  return {
    ...base,
    PROBECARDTYPE: probeCardTypeLeadingSegment(base.PROBECARD ?? base.probecard),
    MASK: deviceMask(base.DEVICE ?? base.device),
  };
}

/**
 * YMWEB_YIELDMONITORTRIGGER（Oracle 账号 probeweb），复合条件 AND，固定 Top 200，
 * 按 TIME_STAMP DESC；另可在**同一筛选**下对全量匹配行做 PROBECARD / HOSTNAME 分组计数（见 probeCardSummary、hostnameSummary）。
 *
 * 查询参数（可选，键名不区分大小写）：hostname, device, lotId, wafer, type,
 * triggerLabel, probeCard；数值 pass, id；时间 timeStampFrom / timeStampTo（ISO 8601）；
 * includeProbeCardSummary（默认 true，传 false 跳过探针卡与机台两次 GROUP BY）。
 */
yieldMonitorRouter.get("/yield-monitor-triggers", async (req, res) => {
  const parsed = parseYieldMonitorTriggerQuery(
    req.query as Record<string, unknown>
  );
  if (!parsed.ok) {
    return sendAgentError(
      res,
      400,
      "VALIDATION_ERROR",
      parsed.error,
      "See GET /api/v1/manifest for yield-monitor-triggers parameters."
    );
  }

  if (yieldMonitorTriggersUseDummy()) {
    const rows = filterYieldMonitorDummyRows(parsed.applied);
    const body: Record<string, unknown> = {
      meta: {
        apiVersion: "1",
        requestId: reqId(req),
      },
      limit: YIELD_MONITOR_TRIGGER_TOP,
      orderBy: "TIME_STAMP DESC NULLS LAST",
      filters: parsed.applied,
      count: rows.length,
      rows,
    };
    if (parsed.includeProbeCardSummary) {
      body.probeCardSummary = buildYieldMonitorProbeCardSummaryDummy(
        parsed.applied
      );
      body.probeCardSummaryOrderBy = "COUNT(*) DESC NULLS LAST";
      body.hostnameSummary = buildYieldMonitorHostnameSummaryDummy(
        parsed.applied
      );
      body.hostnameSummaryOrderBy = "COUNT(*) DESC NULLS LAST";
    }
    return res.json(body);
  }

  const sql = buildYieldMonitorTriggerTopSql(parsed.whereSql);
  const binds: BindParameters = {
    ...parsed.binds,
    lim: YIELD_MONITOR_TRIGGER_TOP,
  };

  try {
    const probeSummarySql = buildYieldMonitorProbeCardSummarySql(
      parsed.whereSql
    );
    const hostnameSummarySql = buildYieldMonitorHostnameSummarySql(
      parsed.whereSql
    );
    const { listRows, summaryRows, hostnameSummaryRows } =
      await withProbeWebConnection(async (conn) => {
        const listResult = await conn.execute(sql, binds, {
          outFormat: oracledb.OUT_FORMAT_OBJECT,
        });
        const rows = listResult.rows || [];
        if (!parsed.includeProbeCardSummary) {
          return {
            listRows: rows,
            summaryRows: null as unknown[] | null,
            hostnameSummaryRows: null as unknown[] | null,
          };
        }
        const [sumResult, hostResult] = await Promise.all([
          conn.execute(probeSummarySql, parsed.binds, {
            outFormat: oracledb.OUT_FORMAT_OBJECT,
          }),
          conn.execute(hostnameSummarySql, parsed.binds, {
            outFormat: oracledb.OUT_FORMAT_OBJECT,
          }),
        ]);
        return {
          listRows: rows,
          summaryRows: sumResult.rows || [],
          hostnameSummaryRows: hostResult.rows || [],
        };
      });

    const withoutRnum = listRows.map((row) => {
      const o = { ...(row as Record<string, unknown>) };
      delete o.RNUM;
      delete o.rnum;
      return o;
    });

    const body: Record<string, unknown> = {
      meta: {
        apiVersion: "1",
        requestId: reqId(req),
      },
      limit: YIELD_MONITOR_TRIGGER_TOP,
      orderBy: "TIME_STAMP DESC NULLS LAST",
      filters: parsed.applied,
      count: withoutRnum.length,
      rows: withoutRnum,
    };

    if (
      parsed.includeProbeCardSummary &&
      summaryRows &&
      hostnameSummaryRows
    ) {
      body.probeCardSummary = (
        summaryRows as Record<string, unknown>[]
      ).map((row) => {
        const pc = row.PROBECARD ?? row.probecard ?? "";
        const cntRaw = row.CNT ?? row.cnt;
        return {
          probeCard: pc === null || pc === undefined ? "" : String(pc),
          count: Number(cntRaw),
        };
      });
      body.probeCardSummaryOrderBy = "COUNT(*) DESC NULLS LAST";
      body.hostnameSummary = (
        hostnameSummaryRows as Record<string, unknown>[]
      ).map((row) => {
        const hn = row.HOSTNAME ?? row.hostname ?? "";
        const cntRaw = row.CNT ?? row.cnt;
        return {
          hostname: hn === null || hn === undefined ? "" : String(hn),
          count: Number(cntRaw),
        };
      });
      body.hostnameSummaryOrderBy = "COUNT(*) DESC NULLS LAST";
    }

    return res.json(body);
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
 * **v3** 产量监控：`YMWEB_YIELDMONITORTRIGGER` 全列；**固定** **`TYPE = delta_diff`**（Oracle **`UPPER(TRIM(t."TYPE"))`**；Dummy 同步）。每行 JSON 另含 **`dutNumber`**（从 **`TRIGGER_LABEL`** 中 **`on dut# …`** 解析，无则 **`null`**）与 **`PROBECARDTYPE`**（**`PROBECARD`** 按首个 **`-`** 拆出的前段）。**`YIELD_MONITOR_TRIGGERS_DUMMY=true`**（且非 `dist`/production）时走 **`docs/delta-diff.xlsx`** 内存样本；否则 **probeweb Oracle**。
 * 查询参数：`UPPER(TRIM)` 字符串筛选、时间窗等（**不支持** **`type`** 查询参数；**`TYPE`** 仍出现在每行对象中，**不能**用查询参数覆盖固定范围）。若未带任一 **timeStamp\*** 时间键，服务端追加 **`TIME_STAMP`** 默认 **UTC 向前一个日历年**（与 **`parseYieldMonitorTriggerV3Query`** 一致）。
 */
yieldMonitorRouter.get("/yield-monitor-triggers/v3", async (req, res) => {
  const parsed = parseYieldMonitorTriggerV3Query(
    req.query as Record<string, unknown>
  );
  if (!parsed.ok) {
    return sendAgentError(
      res,
      400,
      "VALIDATION_ERROR",
      parsed.error,
      "See GET /api/v1/manifest yield-monitor-triggers/v3."
    );
  }

  const limit = clampLimitFromQuery(
    req.query as Record<string, unknown>,
    200,
    API_V3_LIST_LIMIT_MAX
  );

  if (yieldMonitorTriggersUseDummy()) {
    const rows = filterYieldMonitorDummyRowsV3(parsed.applied, limit).map((r) =>
      enrichYieldMonitorTriggerV3ListRow(r as Record<string, unknown>)
    );
    return res.json({
      meta: {
        apiVersion: "3",
        requestId: reqId(req),
      },
      limit,
      limitMax: API_V3_LIST_LIMIT_MAX,
      orderBy: "TIME_STAMP DESC NULLS LAST",
      filters: { ...parsed.applied, limit },
      count: rows.length,
      rows,
    });
  }

  const sql = buildYieldMonitorTriggersV3Sql(parsed.whereSql);
  const binds: BindParameters = { ...parsed.binds, lim: limit };

  try {
    const rows = await withProbeWebConnection(async (conn) => {
      const result = await conn.execute(sql, binds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });
      return result.rows || [];
    });
    const withDut = (rows as Record<string, unknown>[]).map((row) =>
      enrichYieldMonitorTriggerV3ListRow(row)
    );
    return res.json({
      meta: {
        apiVersion: "3",
        requestId: reqId(req),
      },
      limit,
      limitMax: API_V3_LIST_LIMIT_MAX,
      orderBy: "TIME_STAMP DESC NULLS LAST",
      filters: { ...parsed.applied, limit },
      count: withDut.length,
      rows: withDut,
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
 * **v3 产量聚合**：与 **`/yield-monitor-triggers/v3`** 相同 **WHERE**（含固定 **`TYPE = delta_diff`**）。**Dummy** 在 Node 内 **COUNT**；**Oracle** 在库内 **`GROUP BY`**。无 **`MEMORY_AGG_ORACLE_MAX_ROWS`**（与 v4 内存聚合不同）。
 */
yieldMonitorRouter.get("/yield-monitor-triggers/v3/aggregate", async (req, res) => {
  const parsed = parseYieldMonitorTriggerV3AggregateQuery(
    req.query as Record<string, unknown>
  );
  if (!parsed.ok) {
    return sendAgentError(
      res,
      400,
      "VALIDATION_ERROR",
      parsed.error,
      "See GET /api/v1/manifest yield-monitor-triggers/v3/aggregate."
    );
  }

  if (yieldMonitorTriggersUseDummy()) {
    const { totalRowsMatching, groups } = aggregateYieldMonitorV3DummyRows(
      parsed.applied,
      parsed.dimensions,
      parsed.groupTop
    );
    return res.json({
      meta: {
        apiVersion: "3",
        requestId: reqId(req),
        aggregatePath: "yield-monitor-triggers/v3/aggregate",
      },
      documentation: YIELD_MONITOR_V3_AGGREGATE_DOCUMENTATION,
      dimensions: parsed.dimensions,
      groupTop: parsed.groupTop,
      orderBy: "COUNT(*) DESC NULLS LAST",
      filters: parsed.applied,
      totalRowsMatching,
      groups,
    });
  }

  const aggSql = buildYieldMonitorTriggerV3AggregateSqlWithTotal(
    parsed.whereSql,
    parsed.dimensions
  );
  const bindAgg: BindParameters = {
    ...parsed.binds,
    agg_lim: parsed.groupTop,
  };

  try {
    const aggRows = await withProbeWebConnection(async (conn) => {
      const aggResult = await conn.execute(aggSql, bindAgg, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });
      return (aggResult.rows || []) as Record<string, unknown>[];
    });

    const { totalRowsMatching, groups } = mapYieldMonitorV3AggregateRows(
      parsed.dimensions,
      aggRows
    );

    return res.json({
      meta: {
        apiVersion: "3",
        requestId: reqId(req),
        aggregatePath: "yield-monitor-triggers/v3/aggregate",
      },
      documentation: YIELD_MONITOR_V3_AGGREGATE_DOCUMENTATION,
      dimensions: parsed.dimensions,
      groupTop: parsed.groupTop,
      orderBy: "COUNT(*) DESC NULLS LAST",
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
 * **v3 合并查询**：一次 HTTP + 一次 probeweb 连接，返回 v3 列表 + 多组 v3 库内聚合。
 * `aggs` 格式：`dimensions:groupTop|…`（如 `timeDay:60|probeCardType:25|device,lotId,probeCardType,probeCard:100`）。
 */
yieldMonitorRouter.get("/yield-monitor-triggers/v3/combined", async (req, res) => {
  const parsed = parseYieldMonitorTriggerV3Query(
    req.query as Record<string, unknown>
  );
  if (!parsed.ok) {
    return sendAgentError(
      res,
      400,
      "VALIDATION_ERROR",
      parsed.error,
      "See GET /api/v1/manifest yield-monitor-triggers/v3/combined."
    );
  }

  const aggsResult = parseAggsParam(req.query.aggs, 8);
  if (!aggsResult.ok) {
    return sendAgentError(
      res,
      400,
      "VALIDATION_ERROR",
      aggsResult.error,
      'aggs format: dimensions:groupTop|dimensions:groupTop|… (e.g. timeDay:60|probeCardType:25)'
    );
  }

  const limit = clampLimitFromQuery(
    req.query as Record<string, unknown>,
    200,
    API_V3_LIST_LIMIT_MAX
  );

  const resolvedAggs: {
    key: string;
    dimensions: YieldMonitorV3AggDim[];
    groupTop: number;
    applied: Record<string, unknown>;
  }[] = [];

  for (const spec of aggsResult.specs) {
    const aggParsed = parseYieldMonitorTriggerV3AggregateQuery({
      ...(req.query as Record<string, unknown>),
      dimensions: spec.groupBy,
      groupTop: String(spec.groupTop),
    });
    if (!aggParsed.ok) {
      return sendAgentError(
        res,
        400,
        "VALIDATION_ERROR",
        `aggs dimensions "${spec.groupBy}": ${aggParsed.error}`,
        "Each dimensions value must be valid for yield-monitor-triggers/v3/aggregate."
      );
    }
    resolvedAggs.push({
      key: spec.groupBy,
      dimensions: aggParsed.dimensions,
      groupTop: aggParsed.groupTop,
      applied: aggParsed.applied,
    });
  }

  if (yieldMonitorTriggersUseDummy()) {
    const rows = filterYieldMonitorDummyRowsV3(parsed.applied, limit).map((r) =>
      enrichYieldMonitorTriggerV3ListRow(r as Record<string, unknown>)
    );
    const aggregates: Record<string, unknown> = {};
    for (const rs of resolvedAggs) {
      const { totalRowsMatching, groups } = aggregateYieldMonitorV3DummyRows(
        rs.applied,
        rs.dimensions,
        rs.groupTop
      );
      aggregates[rs.key] = {
        dimensions: rs.dimensions,
        groupTop: rs.groupTop,
        totalRowsMatching,
        groups,
      };
    }
    return res.json({
      meta: {
        apiVersion: "3",
        requestId: reqId(req),
        combinedPath: "yield-monitor-triggers/v3/combined",
      },
      limit,
      limitMax: API_V3_LIST_LIMIT_MAX,
      orderBy: "TIME_STAMP DESC NULLS LAST",
      filters: { ...parsed.applied, limit },
      count: rows.length,
      rows,
      aggregates,
    });
  }

  const listSql = buildYieldMonitorTriggersV3Sql(parsed.whereSql);
  const listBinds: BindParameters = { ...parsed.binds, lim: limit };

  try {
    const { listRows, aggregates } = await withProbeWebConnection(
      async (conn) => {
        const listResult = await conn.execute(listSql, listBinds, {
          outFormat: oracledb.OUT_FORMAT_OBJECT,
        });
        const rawListRows = (listResult.rows || []) as Record<string, unknown>[];

        const aggOut: Record<string, unknown> = {};
        for (const rs of resolvedAggs) {
          const aggSql = buildYieldMonitorTriggerV3AggregateSqlWithTotal(
            parsed.whereSql,
            rs.dimensions
          );
          const aggResult = await conn.execute(
            aggSql,
            { ...parsed.binds, agg_lim: rs.groupTop },
            { outFormat: oracledb.OUT_FORMAT_OBJECT }
          );
          const { totalRowsMatching, groups } = mapYieldMonitorV3AggregateRows(
            rs.dimensions,
            (aggResult.rows || []) as Record<string, unknown>[]
          );
          aggOut[rs.key] = {
            dimensions: rs.dimensions,
            groupTop: rs.groupTop,
            totalRowsMatching,
            groups,
          };
        }

        return { listRows: rawListRows, aggregates: aggOut };
      }
    );

    const withDut = listRows.map((row) =>
      enrichYieldMonitorTriggerV3ListRow(row)
    );

    return res.json({
      meta: {
        apiVersion: "3",
        requestId: reqId(req),
        combinedPath: "yield-monitor-triggers/v3/combined",
      },
      limit,
      limitMax: API_V3_LIST_LIMIT_MAX,
      orderBy: "TIME_STAMP DESC NULLS LAST",
      filters: { ...parsed.applied, limit },
      count: withDut.length,
      rows: withDut,
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
});

/**
 * **周期报警趋势**：按查询时间窗切分周/月 x 轴桶，单次 Oracle 扫描；Bin 种类不含 goodbin。
 */
yieldMonitorRouter.get("/yield-monitor-triggers/v3/period-alarm-trend", async (req, res) => {
  const parsed = parsePeriodAlarmTrendQuery(req.query as Record<string, unknown>);
  if (!parsed.ok) {
    return sendAgentError(
      res,
      400,
      "VALIDATION_ERROR",
      parsed.error,
      "See GET /api/v1/manifest yield-monitor-triggers/v3/period-alarm-trend."
    );
  }

  if (yieldMonitorTriggersUseDummy()) {
    const buckets = aggregatePeriodAlarmTrendDummy(
      parsed.applied,
      parsed.buckets,
      parsed.jbSlotApplied
    );
    return res.json({
      meta: {
        apiVersion: "3",
        requestId: reqId(req),
        path: "yield-monitor-triggers/v3/period-alarm-trend",
      },
      documentation: PERIOD_ALARM_TREND_DOCUMENTATION,
      period: parsed.period,
      filters: parsed.applied,
      buckets,
    });
  }

  const sql = buildPeriodAlarmTrendSql(
    parsed.activityWhereSql,
    parsed.buckets.length
  );
  const topTestersSql = buildPeriodAlarmTrendTopTestersSql(
    parsed.activityWhereSql,
    parsed.buckets.length
  );
  const topDevicesSql = buildPeriodAlarmTrendTopDevicesSql(
    parsed.activityWhereSql,
    parsed.buckets.length
  );
  const topProbeCardsSql = buildPeriodAlarmTrendTopProbeCardsSql(
    parsed.activityWhereSql,
    parsed.buckets.length
  );
  const jbSlotSql = buildPeriodAlarmJbSlotTuplesSql(
    parsed.jbSlotWhereAndSql,
    parsed.buckets.length
  );
  const mainBinds = periodAlarmTrendMainBinds(parsed);
  const topBinds = periodAlarmTrendTopBinds(parsed);
  const jbSlotBinds = periodAlarmTrendJbSlotBinds(parsed);
  try {
    const { rows, topTesterRows, topDeviceRows, topProbeCardRows } = await withProbeWebConnection(
      async (conn) => {
        const result = await conn.execute(sql, mainBinds, {
          outFormat: oracledb.OUT_FORMAT_OBJECT,
        });
        const topTesterResult = await conn.execute(topTestersSql, topBinds, {
          outFormat: oracledb.OUT_FORMAT_OBJECT,
        });
        const topDeviceResult = await conn.execute(topDevicesSql, topBinds, {
          outFormat: oracledb.OUT_FORMAT_OBJECT,
        });
        const topProbeCardResult = await conn.execute(topProbeCardsSql, topBinds, {
          outFormat: oracledb.OUT_FORMAT_OBJECT,
        });
        return {
          rows: (result.rows || []).map((row) =>
            normalizeDbRowKeysUpper(row as Record<string, unknown>)
          ),
          topTesterRows: (topTesterResult.rows || []).map((row) =>
            normalizeDbRowKeysUpper(row as Record<string, unknown>)
          ),
          topDeviceRows: (topDeviceResult.rows || []).map((row) =>
            normalizeDbRowKeysUpper(row as Record<string, unknown>)
          ),
          topProbeCardRows: (topProbeCardResult.rows || []).map((row) =>
            normalizeDbRowKeysUpper(row as Record<string, unknown>)
          ),
        };
      }
    );
    const jbSlotRows = await withConnection(async (conn) => {
      const jbResult = await conn.execute(jbSlotSql, jbSlotBinds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });
      return (jbResult.rows || []).map((row) =>
        normalizeDbRowKeysUpper(row as Record<string, unknown>)
      );
    });
    const buckets = mergePeriodAlarmJbSlotDenominator(
      attachPeriodAlarmTopProbeCards(
        attachPeriodAlarmTopDevices(
          attachPeriodAlarmTopTesters(
            mapPeriodAlarmTrendRows(parsed.buckets, rows),
            topTesterRows
          ),
          topDeviceRows
        ),
        topProbeCardRows
      ),
      jbSlotRows
    );
    return res.json({
      meta: {
        apiVersion: "3",
        requestId: reqId(req),
        path: "yield-monitor-triggers/v3/period-alarm-trend",
      },
      documentation: PERIOD_ALARM_TREND_DOCUMENTATION,
      period: parsed.period,
      filters: parsed.applied,
      buckets,
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
 * **v4** 产量列表：与 **v3** 相同；**`meta.apiVersion`** 为 **`"4"`**。
 */
yieldMonitorRouter.get("/yield-monitor-triggers/v4", async (req, res) => {
  const parsed = parseYieldMonitorTriggerV3Query(
    req.query as Record<string, unknown>
  );
  if (!parsed.ok) {
    return sendAgentError(
      res,
      400,
      "VALIDATION_ERROR",
      parsed.error,
      "See GET /api/v1/manifest yield-monitor-triggers/v4."
    );
  }

  const limit = clampLimitFromQuery(
    req.query as Record<string, unknown>,
    200,
    API_V3_LIST_LIMIT_MAX
  );

  if (yieldMonitorTriggersUseDummy()) {
    const rows = filterYieldMonitorDummyRowsV3(parsed.applied, limit).map((r) =>
      enrichYieldMonitorTriggerV3ListRow(r as Record<string, unknown>)
    );
    return res.json({
      meta: {
        apiVersion: "4",
        requestId: reqId(req),
      },
      limit,
      limitMax: API_V3_LIST_LIMIT_MAX,
      orderBy: "TIME_STAMP DESC NULLS LAST",
      filters: { ...parsed.applied, limit },
      count: rows.length,
      rows,
    });
  }

  const sql = buildYieldMonitorTriggersV3Sql(parsed.whereSql);
  const binds: BindParameters = { ...parsed.binds, lim: limit };

  try {
    const rows = await withProbeWebConnection(async (conn) => {
      const result = await conn.execute(sql, binds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });
      return result.rows || [];
    });
    const withDut = (rows as Record<string, unknown>[]).map((row) =>
      enrichYieldMonitorTriggerV3ListRow(row)
    );
    return res.json({
      meta: {
        apiVersion: "4",
        requestId: reqId(req),
      },
      limit,
      limitMax: API_V3_LIST_LIMIT_MAX,
      orderBy: "TIME_STAMP DESC NULLS LAST",
      filters: { ...parsed.applied, limit },
      count: withDut.length,
      rows: withDut,
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
 * **v4 产量聚合**：先 **COUNT** 匹配行（超过 **`MEMORY_AGG_ORACLE_MAX_ROWS`** 则 **422**），再拉全量行在 Node 内 **COUNT** 分桶。
 */
yieldMonitorRouter.get("/yield-monitor-triggers/v4/aggregate", async (req, res) => {
  const parsed = parseYieldMonitorTriggerV3AggregateQuery(
    req.query as Record<string, unknown>
  );
  if (!parsed.ok) {
    return sendAgentError(
      res,
      400,
      "VALIDATION_ERROR",
      parsed.error,
      "See GET /api/v1/manifest yield-monitor-triggers/v4/aggregate."
    );
  }

  const maxRowsYmV4Agg = readMemoryAggregateOracleMaxRows();

  if (yieldMonitorTriggersUseDummy()) {
    const rawRows = filterYieldMonitorDummyRowsMatchingV3(parsed.applied);
    if (rawRows.length > maxRowsYmV4Agg) {
      return sendAgentError(
        res,
        422,
        "QUERY_TOO_LARGE",
        `Matching rows (${rawRows.length}) exceed MEMORY_AGG_ORACLE_MAX_ROWS (${maxRowsYmV4Agg}). Narrow filters (device, timeStamp*, etc.).`,
        "See .env.example MEMORY_AGG_ORACLE_MAX_ROWS."
      );
    }
    const { totalRowsMatching, groups } = aggregateYieldMonitorV3FromRows(
      rawRows,
      parsed.dimensions,
      parsed.groupTop
    );
    return res.json({
      meta: {
        apiVersion: "4",
        requestId: reqId(req),
        aggregatePath: "yield-monitor-triggers/v4/aggregate",
      },
      documentation: YIELD_MONITOR_V4_AGGREGATE_DOCUMENTATION,
      dimensions: parsed.dimensions,
      groupTop: parsed.groupTop,
      orderBy: "COUNT(*) DESC NULLS LAST",
      filters: parsed.applied,
      totalRowsMatching,
      groups,
    });
  }

  const countSql = buildYieldMonitorTriggerMatchingCountSql(parsed.whereSql);
  const listSql = buildYieldMonitorTriggersV3SqlFullMatching(parsed.whereSql);

  try {
    const { totalRowsMatching, rows } = await withProbeWebConnection(
      async (conn) => {
        const countResult = await conn.execute(countSql, parsed.binds, {
          outFormat: oracledb.OUT_FORMAT_OBJECT,
        });
        const totalObj =
          (countResult.rows?.[0] as Record<string, unknown> | undefined) ??
          {};
        const totalRaw =
          totalObj.TOTAL_MATCHING ?? totalObj.total_matching ?? totalObj.TOTAL;
        const total =
          totalRaw != null && totalRaw !== "" ? Number(totalRaw) : 0;
        if (total > maxRowsYmV4Agg) {
          return { totalRowsMatching: total, rows: null as unknown[] | null };
        }
        const data = await conn.execute(listSql, parsed.binds, {
          outFormat: oracledb.OUT_FORMAT_OBJECT,
        });
        return { totalRowsMatching: total, rows: data.rows || [] };
      }
    );

    if (rows === null) {
      return sendAgentError(
        res,
        422,
        "QUERY_TOO_LARGE",
        `Matching rows (${totalRowsMatching}) exceed MEMORY_AGG_ORACLE_MAX_ROWS (${maxRowsYmV4Agg}). Narrow filters (device, timeStamp*, etc.).`,
        "See .env.example MEMORY_AGG_ORACLE_MAX_ROWS."
      );
    }

    const withPc = (rows as Record<string, unknown>[]).map((row) => {
      const base = {
        ...normalizeDbRowKeysUpper(row),
      } as YieldMonitorTriggerDummyRow & { PROBECARDTYPE?: string | null };
      base.PROBECARDTYPE = probeCardTypeLeadingSegment(
        base.PROBECARD ?? row.probecard
      );
      return base;
    });
    const { groups } = aggregateYieldMonitorV3FromRows(
      withPc,
      parsed.dimensions,
      parsed.groupTop
    );

    return res.json({
      meta: {
        apiVersion: "4",
        requestId: reqId(req),
        aggregatePath: "yield-monitor-triggers/v4/aggregate",
      },
      documentation: YIELD_MONITOR_V4_AGGREGATE_DOCUMENTATION,
      dimensions: parsed.dimensions,
      groupTop: parsed.groupTop,
      orderBy: "COUNT(*) DESC NULLS LAST",
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
