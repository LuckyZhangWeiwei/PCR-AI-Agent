import { Router, type Request } from "express";
import oracledb, { type BindParameters } from "oracledb";
import { buildManifestResponseJson } from "../lib/rebaseApiManifest.js";
import { enrichOracleDriverDetail, sendAgentError } from "../lib/agentResponse.js";
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
  buildYieldMonitorTriggersV3Sql,
} from "../lib/apiV3ListSql.js";
import {
  aggregateInfcontrolLayerBinDummyRows,
  aggregateInfcontrolLayerBinV2BadBinsDummy,
  aggregateInfcontrolLayerBinV3DummyRows,
  filterInfcontrolLayerBinV2DummyRows,
  filterInfcontrolLayerBinV3DummyRows,
  filterInfcontrolLayerDummyRows,
  infcontrolLayerBinsUseDummy,
} from "../lib/infcontrolLayerBinDummy.js";
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
import {
  YIELD_MONITOR_TRIGGER_TOP,
  parseYieldMonitorTriggerQuery,
  parseYieldMonitorTriggerV3Query,
} from "../lib/yieldMonitorTriggerFilters.js";
import {
  YIELD_MONITOR_V3_AGGREGATE_DOCUMENTATION,
  buildYieldMonitorTriggerV3AggregateSql,
  buildYieldMonitorTriggerV3AggregateTotalSql,
  buildYieldMonitorV3AggregateGroupParts,
  parseYieldMonitorTriggerV3AggregateQuery,
} from "../lib/yieldMonitorTriggerV3Aggregate.js";
import {
  buildYieldMonitorHostnameSummarySql,
  buildYieldMonitorProbeCardSummarySql,
  buildYieldMonitorTriggerTopSql,
} from "../lib/yieldMonitorTriggerSql.js";
import {
  aggregateYieldMonitorV3DummyRows,
  buildYieldMonitorHostnameSummaryDummy,
  buildYieldMonitorProbeCardSummaryDummy,
  filterYieldMonitorDummyRows,
  filterYieldMonitorDummyRowsV3,
  yieldMonitorTriggersUseDummy,
} from "../lib/yieldMonitorTriggerDummy.js";
import { probeCardTypeLeadingSegment } from "../lib/probeCardTypeLeadingSegment.js";
import { addDutNumberToYieldMonitorV3Row } from "../lib/yieldTriggerLabelDut.js";
import {
  clampLimit,
  clampLimitFromQuery,
  parseQualifiedTable,
} from "../lib/sqlIdent.js";
import { withConnection, withProbeWebConnection } from "../oracle.js";

export const apiRouter = Router();

function reqId(req: Request): string | undefined {
  return (req as Request & { requestId?: string }).requestId;
}

function enrichInfcontrolLayerBinV3ListRow(
  row: Record<string, unknown>
): Record<string, unknown> {
  const e = enrichInfcontrolLayerBinRowV2(row);
  return {
    ...e,
    PROBECARDTYPE: probeCardTypeLeadingSegment(e.CARDID ?? e.cardid),
  };
}

function enrichYieldMonitorTriggerV3ListRow(
  row: Record<string, unknown>
): Record<string, unknown> {
  const base = addDutNumberToYieldMonitorV3Row(row);
  return {
    ...base,
    PROBECARDTYPE: probeCardTypeLeadingSegment(base.PROBECARD ?? base.probecard),
  };
}

/** AI agent 工具发现：参数说明、示例与错误格式约定（**`/api/v1/manifest`** 全量；**`/api/v3/manifest`** 仅 v3 相关且 path 为 `/api/v3/...`） */
apiRouter.get("/manifest", (req, res) => {
  res.json(buildManifestResponseJson(req.baseUrl || "/api/v1"));
});

/**
 * INFCONTROL ⋈ INFLAYERBINLIST，复合条件 AND，固定 Top 200，按 TESTEND 降序（同 KEYNUMBER 降序作次序）。
 *
 * 查询参数（均可选，不区分大小写）：keynumber；
 * INFCONTROL：device, lot, slot, pdpw, meslot；
 * INFLAYERBINLIST：testerId, tstype, cardId, pibId, probe, grossDie, passId,
 * sessionNumber, passNum, layerName, passResume, passResult, passType, passBin；
 * 时间：testStartFrom / testStartTo，testEndFrom / testEndTo（ISO 8601）；
 * BIN：bin0 … bin255，逗号分隔整数，表示该列 IN (…) ，例 bin5=1,3,5。
 * PASSBIN 为 N-M 时：响应 **passBinPair [N,M]**；**bins[k].isGood**：BIN1 或 PASSBIN 两端列下标为 **true**，其余为 **false**。
 */
apiRouter.get("/infcontrol-layer-bins", async (req, res) => {
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
apiRouter.get("/infcontrol-layer-bins/v2", async (req, res) => {
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
apiRouter.get("/infcontrol-layer-bins/v3", async (req, res) => {
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
 * **v3 层控 BIN 聚合**：与 **`/infcontrol-layer-bins/v3`** 相同筛选语义。**SUM** 仅累计 **坏 bin** die：与 v3 列表 **`bins[].isGoodBin`** 一致，**`PASSBIN`** 按 **`-`** 拆出的整段下标（**0…255**）视为 **good**，该列不计入（与 **`/infcontrol-layer-bins/v2/top-bad-bins`** 的 token 规则一致）。**Dummy** 开启时在 **JBStart** 内存行上聚合；否则 Oracle。
 * 响应体含 **`documentation`**。详见 manifest 与 **`docs/AI_AGENT_API.md`**。
 */
apiRouter.get("/infcontrol-layer-bins/v3/aggregate", async (req, res) => {
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
apiRouter.get("/infcontrol-layer-bins/v2/top-bad-bins", async (req, res) => {
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
apiRouter.get("/infcontrol-layer-bins/aggregate", async (req, res) => {
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
 * YMWEB_YIELDMONITORTRIGGER（Oracle 账号 probeweb），复合条件 AND，固定 Top 200，
 * 按 TIME_STAMP DESC；另可在**同一筛选**下对全量匹配行做 PROBECARD / HOSTNAME 分组计数（见 probeCardSummary、hostnameSummary）。
 *
 * 查询参数（可选，键名不区分大小写）：hostname, device, lotId, wafer, type,
 * triggerLabel, probeCard；数值 pass, id；时间 timeStampFrom / timeStampTo（ISO 8601）；
 * includeProbeCardSummary（默认 true，传 false 跳过探针卡与机台两次 GROUP BY）。
 */
apiRouter.get("/yield-monitor-triggers", async (req, res) => {
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
apiRouter.get("/yield-monitor-triggers/v3", async (req, res) => {
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
 * **v3 产量聚合**：与 **`/yield-monitor-triggers/v3`** 相同 **WHERE**（含固定 **`TYPE = delta_diff`**）。**Dummy 开启**时在 **delta-diff** 内存行上 `COUNT`+`GROUP BY`；否则 Oracle。
 */
apiRouter.get("/yield-monitor-triggers/v3/aggregate", async (req, res) => {
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

  const aggSql = buildYieldMonitorTriggerV3AggregateSql(
    parsed.whereSql,
    parsed.dimensions
  );
  const totalSql = buildYieldMonitorTriggerV3AggregateTotalSql(parsed.whereSql);
  const bindAgg: BindParameters = {
    ...parsed.binds,
    agg_lim: parsed.groupTop,
  };

  try {
    const [aggRows, countRows] = await withProbeWebConnection(async (conn) => {
      const aggResult = await conn.execute(aggSql, bindAgg, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });
      const countResult = await conn.execute(totalSql, parsed.binds, {
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
          parts: buildYieldMonitorV3AggregateGroupParts(
            parsed.dimensions,
            keyStr
          ),
        };
      });

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

/** 从 dual 探测数据库连通性 */
apiRouter.get("/db/ping", async (req, res) => {
  try {
    const row = await withConnection(async (conn) => {
      const r = await conn.execute(
        "SELECT 1 AS ok FROM DUAL",
        {},
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      return r.rows?.[0] ?? null;
    });
    return res.json({
      meta: { apiVersion: "1", requestId: reqId(req) },
      ok: true,
      dual: row,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return sendAgentError(
      res,
      500,
      "ORACLE_PING_FAILED",
      "Oracle ping failed",
      enrichOracleDriverDetail(message)
    );
  }
});

/**
 * 只读查询表前 N 行（ROWNUM，兼容旧版 Oracle）
 * GET /api/v1/table-rows?table=MY_TABLE&limit=50
 * 或 ?table=OWNER.MY_TABLE
 * 未传 table 时使用环境变量 ORACLE_DEFAULT_TABLE
 */
apiRouter.get("/table-rows", async (req, res) => {
  const fromEnv = process.env.ORACLE_DEFAULT_TABLE;
  const tableRaw = req.query.table ?? fromEnv;
  const parsed = parseQualifiedTable(tableRaw);
  if ("error" in parsed) {
    return sendAgentError(
      res,
      400,
      "VALIDATION_ERROR",
      parsed.error,
      "Set ?table=SCHEMA.MY_TABLE or ORACLE_DEFAULT_TABLE in .env"
    );
  }

  const limit = clampLimit(req.query.limit, 50, 500);
  const fromClause =
    parsed.schema == null
      ? parsed.table
      : `${parsed.schema}.${parsed.table}`;

  const sql = `
    SELECT * FROM (
      SELECT inner_q.*, ROWNUM AS rnum
      FROM (SELECT * FROM ${fromClause}) inner_q
      WHERE ROWNUM <= :lim
    )
    WHERE rnum >= 1
  `;

  try {
    const rows = await withConnection(async (conn) => {
      const result = await conn.execute(
        sql,
        { lim: limit },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      return result.rows || [];
    });
    return res.json({
      meta: { apiVersion: "1", requestId: reqId(req) },
      table: parsed.schema ? `${parsed.schema}.${parsed.table}` : parsed.table,
      limit,
      rows,
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
