// pcr-ai-api/src/lib/agent/agentToolHandlers.ts
import { withConnection, withProbeWebConnection } from "../../oracle.js";
import oracledb from "oracledb";
import {
  parseYieldMonitorTriggerV3Query,
} from "../yieldMonitorTriggerFilters.js";
import {
  parseYieldMonitorTriggerV3AggregateQuery,
  buildYieldMonitorTriggerV3AggregateSql,
  buildYieldMonitorTriggerV3AggregateTotalSql,
  buildYieldMonitorV3AggregateGroupParts,
  type YieldMonitorV3AggDim,
} from "../yieldMonitorTriggerV3Aggregate.js";
import {
  yieldMonitorTriggersUseDummy,
  filterYieldMonitorDummyRowsV3,
  aggregateYieldMonitorV3DummyRows,
} from "../yieldMonitorTriggerDummy.js";
import {
  parseInfcontrolLayerBinsV3Query,
} from "../infcontrolLayerBinFilters.js";
import {
  parseInfcontrolLayerBinsV3AggregateQuery,
} from "../infcontrolLayerBinV3Aggregate.js";
import {
  buildInfcontrolLayerBinAggregateSql,
  buildInfcontrolLayerBinMatchingCountSql,
  buildInfcontrolLayerBinAggregateGroupParts,
  type InfcontrolLayerBinGroupBy,
} from "../infcontrolLayerBinAggregate.js";
import {
  infcontrolLayerBinsUseDummy,
  filterInfcontrolLayerBinV3DummyRows,
  aggregateInfcontrolLayerBinV3DummyRows,
} from "../infcontrolLayerBinDummy.js";
import {
  buildYieldMonitorTriggersV3Sql,
  buildInfcontrolLayerBinsV3Sql,
} from "../apiV3ListSql.js";
import { probeCardTypeLeadingSegment } from "../probeCardTypeLeadingSegment.js";
import { addDutNumberToYieldMonitorV3Row } from "../yieldTriggerLabelDut.js";
import { enrichInfcontrolLayerBinRowV2 } from "../passBinSemantics.js";
import {
  buildChartOption,
  type ChartData,
  type ChartSentinel,
  type ClarificationSentinel,
} from "./agentChartTool.js";
import { runGetFilterValues } from "./agentFilterValuesTool.js";
import { wrapJbQueryResultForAgent } from "./agentJbBinFormat.js";
import { buildInfPath } from "../buildInfPath.js";
import {
  runOutputSiteBinByLot,
  parseSiteBinByLotJson,
} from "../outputSiteBinByLot.js";
import { tryResolveSiteBinByLotDummy } from "../outputSiteBinByLotDummy.js";

export type { ChartSentinel, ClarificationSentinel };

const TOOL_LIST_LIMIT = 50;
const TOOL_LIST_LIMIT_MAX = 200;
const TOOL_RESULT_TRUNCATE = 6000;

function clampLimit(raw: unknown, defaultVal: number, max: number): number {
  const n = typeof raw === "number" ? raw : defaultVal;
  return Math.min(Math.max(1, Math.round(n)), max);
}

function truncateResult(obj: unknown): string {
  try {
    const s = JSON.stringify(obj);
    return s.length > TOOL_RESULT_TRUNCATE
      ? s.slice(0, TOOL_RESULT_TRUNCATE) + "…(truncated)"
      : s;
  } catch {
    return "(结果序列化失败)";
  }
}

function enrichYieldRow(row: Record<string, unknown>): Record<string, unknown> {
  const base = addDutNumberToYieldMonitorV3Row(row);
  return {
    ...base,
    PROBECARDTYPE: probeCardTypeLeadingSegment(
      base["PROBECARD"] ?? base["probecard"]
    ),
  };
}

function enrichJbRow(row: Record<string, unknown>): Record<string, unknown> {
  const e = enrichInfcontrolLayerBinRowV2(row);
  return {
    ...e,
    PROBECARDTYPE: probeCardTypeLeadingSegment(e["CARDID"] ?? e["cardid"]),
  };
}

async function toolQueryYieldTriggers(
  args: Record<string, unknown>
): Promise<string> {
  const limit = clampLimit(args["limit"], TOOL_LIST_LIMIT, TOOL_LIST_LIMIT_MAX);
  const params: Record<string, unknown> = { ...args, limit };
  if (args["timeFrom"]) params["timeStampFrom"] = args["timeFrom"];
  if (args["timeTo"]) params["timeStampTo"] = args["timeTo"];

  const parsed = parseYieldMonitorTriggerV3Query(params);
  if (!parsed.ok) return `查询参数错误: ${parsed.error}`;

  if (yieldMonitorTriggersUseDummy()) {
    const rows = filterYieldMonitorDummyRowsV3(parsed.applied, limit).map(
      (r) => enrichYieldRow(r as Record<string, unknown>)
    );
    return truncateResult({ count: rows.length, rows });
  }

  const sql = buildYieldMonitorTriggersV3Sql(parsed.whereSql);
  const rows = await withProbeWebConnection(async (conn) => {
    const result = await conn.execute(sql, { ...parsed.binds, lim: limit }, {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
    });
    return (result.rows ?? []) as Record<string, unknown>[];
  });
  const enriched = rows.map(enrichYieldRow);
  return truncateResult({ count: enriched.length, rows: enriched });
}

async function toolAggregateYieldTriggers(
  args: Record<string, unknown>
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
    return truncateResult(result);
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

  return truncateResult({ totalRowsMatching: total, groups });
}

async function toolQueryJbBins(
  args: Record<string, unknown>
): Promise<string> {
  const limit = clampLimit(args["limit"], TOOL_LIST_LIMIT, TOOL_LIST_LIMIT_MAX);
  const parsed = parseInfcontrolLayerBinsV3Query({ ...args, limit });
  if (!parsed.ok) return `查询参数错误: ${parsed.error}`;

  if (infcontrolLayerBinsUseDummy()) {
    const rows = filterInfcontrolLayerBinV3DummyRows(parsed.applied, limit).map(
      (r) => enrichJbRow(r as Record<string, unknown>)
    );
    return truncateResult(wrapJbQueryResultForAgent(rows));
  }

  const sql = buildInfcontrolLayerBinsV3Sql(parsed.whereAndSql);
  const rows = await withConnection(async (conn) => {
    const result = await conn.execute(
      sql,
      { ...parsed.binds, lim: limit },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    return (result.rows ?? []) as Record<string, unknown>[];
  });
  const enriched = rows.map(enrichJbRow);
  return truncateResult(wrapJbQueryResultForAgent(enriched));
}

async function toolAggregateJbBins(
  args: Record<string, unknown>
): Promise<string> {
  const groupByRaw = String(args["groupBy"] ?? "bin");
  const groupTop = clampLimit(args["groupTop"], 10, 50);

  const parts = groupByRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.includes("bin")) parts.unshift("bin");
  const groupByStr = parts.join(",");

  const params: Record<string, unknown> = {
    ...args,
    groupBy: groupByStr,
    groupTop,
  };
  const parsed = parseInfcontrolLayerBinsV3AggregateQuery(params);
  if (!parsed.ok) return `查询参数错误: ${parsed.error}`;

  if (infcontrolLayerBinsUseDummy()) {
    const result = aggregateInfcontrolLayerBinV3DummyRows(
      parsed.applied,
      parsed.groupBy as InfcontrolLayerBinGroupBy[],
      parsed.groupTop
    );
    return truncateResult(result);
  }

  const sql = buildInfcontrolLayerBinAggregateSql(
    parsed.whereSql,
    parsed.groupBy as InfcontrolLayerBinGroupBy[],
    "v3-hyphen-tokens"
  );
  const totalSql = buildInfcontrolLayerBinMatchingCountSql(parsed.whereSql);

  const { groups, total } = await withConnection(async (conn) => {
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
        ...buildInfcontrolLayerBinAggregateGroupParts(
          grpKey,
          parsed.groupBy as InfcontrolLayerBinGroupBy[]
        ),
        count: cnt,
      };
    });
    return { groups: builtGroups, total: totalCount };
  });

  return truncateResult({ totalRowsMatching: total, groups });
}

async function toolQueryInfSiteBinByDut(
  args: Record<string, unknown>
): Promise<string> {
  const device = typeof args["device"] === "string" ? args["device"].trim() : "";
  const lot    = typeof args["lot"]    === "string" ? args["lot"].trim()    : "";
  const slotRaw = args["slot"];
  const slot = typeof slotRaw === "number" ? Math.round(slotRaw) : NaN;
  const cardId = typeof args["cardId"] === "string" ? args["cardId"].trim() : undefined;

  if (!device) return "query_inf_site_bin_by_dut 参数错误: device 不能为空";
  if (!lot)    return "query_inf_site_bin_by_dut 参数错误: lot 不能为空";
  if (!Number.isFinite(slot)) return "query_inf_site_bin_by_dut 参数错误: slot 必须是整数";

  const passIds: number[] = [];
  if (typeof args["passId"] === "number") passIds.push(Math.round(args["passId"]));
  if (Array.isArray(args["passIds"])) {
    for (const p of args["passIds"]) {
      if (typeof p === "number") passIds.push(Math.round(p));
    }
  }
  if (passIds.length === 0) passIds.push(1, 3, 5);

  const infPath = buildInfPath(device, lot, slot);

  const dummy = tryResolveSiteBinByLotDummy(infPath, passIds);
  if (dummy) {
    const result = { cardId, device, lot, slot, infPath, passes: dummy.passes };
    return truncateResult(result);
  }

  const { stdout, stderr, exitCode } = await runOutputSiteBinByLot(infPath, passIds);
  if (exitCode !== 0) {
    return truncateResult({
      error: "INF/Perl 失败",
      stderr: stderr.slice(0, 500),
      hint: "检查 INF_STORAGE_ROOT 及 infPath 在 API 主机上是否可读",
    });
  }
  try {
    const data = parseSiteBinByLotJson(stdout);
    return truncateResult({ cardId, device, lot, slot, infPath, passes: data.passes });
  } catch (e) {
    return `INF 解析失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export async function runTool(
  name: string,
  args: Record<string, unknown>
): Promise<string | ChartSentinel | ClarificationSentinel> {
  switch (name) {
    case "query_yield_triggers":
      return toolQueryYieldTriggers(args);
    case "aggregate_yield_triggers":
      return toolAggregateYieldTriggers(args);
    case "query_jb_bins":
      return toolQueryJbBins(args);
    case "aggregate_jb_bins":
      return toolAggregateJbBins(args);
    case "generate_chart": {
      try {
        const chartType = args["chartType"] as "bar" | "line" | "pie" | "scatter";
        const title = String(args["title"] ?? "");
        const data = args["data"] as ChartData;
        const option = buildChartOption(chartType, title, data);
        return { __chartOption: option };
      } catch (err) {
        return `生成图表失败: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    case "ask_clarification": {
      const question = String(args["question"] ?? "").trim();
      if (!question) return "ask_clarification 参数错误: question 不能为空";
      return { __clarification: question };
    }
    case "get_filter_values":
      return runGetFilterValues(args);
    case "query_inf_site_bin_by_dut":
      return toolQueryInfSiteBinByDut(args);
    default:
      return `未知工具: ${name}`;
  }
}
