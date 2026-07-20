// pcr-ai-api/src/lib/agent/tools/agentToolYieldTriggers.ts
import { withProbeWebConnection } from "../../../oracle.js";
import oracledb from "oracledb";
import {
  parseYieldMonitorTriggerV3Query,
} from "../../yieldMonitor/yieldMonitorTriggerFilters.js";
import {
  parseYieldMonitorTriggerV3AggregateQuery,
  buildYieldMonitorTriggerV3AggregateSql,
  buildYieldMonitorTriggerV3AggregateTotalSql,
  buildYieldMonitorV3AggregateGroupParts,
  type YieldMonitorV3AggDim,
} from "../../yieldMonitor/yieldMonitorTriggerV3Aggregate.js";
import {
  yieldMonitorTriggersUseDummy,
  filterYieldMonitorDummyRowsV3,
  aggregateYieldMonitorV3DummyRows,
} from "../../yieldMonitor/yieldMonitorTriggerDummy.js";
import {
  buildYieldMonitorTriggersV3Sql,
} from "../../apiV3ListSql.js";
import {
  clampLimit,
  truncateResult,
  enrichYieldRow,
} from "./agentToolHandlers.js";
import {
  AGENT_TOOL_LIST_LIMIT_DEFAULT,
  AGENT_TOOL_LIST_LIMIT_MAX,
} from "./agentToolListLimits.js";

export async function toolQueryYieldTriggers(
  args: Record<string, unknown>,
  maxChars: number
): Promise<string> {
  const limit = clampLimit(
    args["limit"],
    AGENT_TOOL_LIST_LIMIT_DEFAULT,
    AGENT_TOOL_LIST_LIMIT_MAX
  );
  const params: Record<string, unknown> = { ...args, limit };
  if (args["timeFrom"]) params["timeStampFrom"] = args["timeFrom"];
  if (args["timeTo"]) params["timeStampTo"] = args["timeTo"];

  const parsed = parseYieldMonitorTriggerV3Query(params);
  if (!parsed.ok) return `查询参数错误: ${parsed.error}`;

  if (yieldMonitorTriggersUseDummy()) {
    const rows = filterYieldMonitorDummyRowsV3(parsed.applied, limit).map(
      (r) => enrichYieldRow(r as Record<string, unknown>)
    );
    return truncateResult({ count: rows.length, rows }, maxChars);
  }

  const sql = buildYieldMonitorTriggersV3Sql(parsed.whereSql);
  const rows = await withProbeWebConnection(async (conn) => {
    const result = await conn.execute(sql, { ...parsed.binds, lim: limit }, {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
    });
    return (result.rows ?? []) as Record<string, unknown>[];
  });
  const enriched = rows.map(enrichYieldRow);
  return truncateResult({ count: enriched.length, rows: enriched }, maxChars);
}

export async function toolAggregateYieldTriggers(
  args: Record<string, unknown>,
  maxChars: number
): Promise<string> {
  const dimensionsRaw = String(args["dimensions"] ?? "device");
  const groupTop = clampLimit(args["groupTop"], 10, 25);
  const params: Record<string, unknown> = {
    ...args,
    dimensions: dimensionsRaw,
    groupTop,
  };
  if (args["timeFrom"]) params["timeStampFrom"] = args["timeFrom"];
  if (args["timeTo"]) params["timeStampTo"] = args["timeTo"];

  const parsed = parseYieldMonitorTriggerV3AggregateQuery(params);
  if (!parsed.ok) return `查询参数错误: ${parsed.error}`;

  if (yieldMonitorTriggersUseDummy()) {
    const result = aggregateYieldMonitorV3DummyRows(
      parsed.applied,
      parsed.dimensions as YieldMonitorV3AggDim[],
      parsed.groupTop
    );
    // dummy-parity：与 Oracle 路径（builtGroups）一致展平 { key, parts, count } → { ...parts, count }。
    const flatGroups = result.groups.map((g) => ({ ...g.parts, count: g.count }));
    return truncateResult(
      { totalRowsMatching: result.totalRowsMatching, groups: flatGroups },
      maxChars
    );
  }

  const sql = buildYieldMonitorTriggerV3AggregateSql(
    parsed.whereSql,
    parsed.dimensions as YieldMonitorV3AggDim[]
  );
  const totalSql = buildYieldMonitorTriggerV3AggregateTotalSql(parsed.whereSql);

  const { groups, total } = await withProbeWebConnection(async (conn) => {
    const aggResult = await conn.execute(
      sql,
      { ...parsed.binds, agg_lim: parsed.groupTop },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const totalResult = await conn.execute(totalSql, parsed.binds, {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
    });
    const totalRows = (totalResult.rows ?? []) as Record<string, unknown>[];
    const totalCount =
      typeof totalRows[0]?.["TOTAL_MATCHING"] === "number"
        ? (totalRows[0]["TOTAL_MATCHING"] as number)
        : 0;
    const rawGroups = (aggResult.rows ?? []) as Record<string, unknown>[];
    const builtGroups = rawGroups.map((grpRow) => {
      const grpKey = String(grpRow["GRP_KEY"] ?? "");
      const cnt = Number(grpRow["CNT"] ?? 0);
      return {
        ...buildYieldMonitorV3AggregateGroupParts(
          parsed.dimensions as YieldMonitorV3AggDim[],
          grpKey
        ),
        count: cnt,
      };
    });
    return { groups: builtGroups, total: totalCount };
  });

  return truncateResult({ totalRowsMatching: total, groups }, maxChars);
}

/** 获取指定探针卡的 YM 原始行（仅用于跨域关联，不需要 enrich）。失败返回空数组。 */
export async function fetchYmRowsForCard(
  cardId: string
): Promise<Record<string, unknown>[]> {
  const params = { probeCard: cardId };
  const parsed = parseYieldMonitorTriggerV3Query(params);
  if (!parsed.ok) return [];
  const limit = AGENT_TOOL_LIST_LIMIT_MAX;
  if (yieldMonitorTriggersUseDummy()) {
    return filterYieldMonitorDummyRowsV3(
      parsed.applied,
      limit
    ) as Record<string, unknown>[];
  }
  const sql = buildYieldMonitorTriggersV3Sql(parsed.whereSql);
  return withProbeWebConnection(async (conn) => {
    const result = await conn.execute(
      sql,
      { ...parsed.binds, lim: limit },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    return (result.rows ?? []) as Record<string, unknown>[];
  }).catch(() => []);
}
