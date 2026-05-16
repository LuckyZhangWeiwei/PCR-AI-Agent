// pcr-ai-api/src/lib/agent/agentTools.ts
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

// ─── Tool schemas ──────────────────────────────────────────────────────────

export const TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: "query_yield_triggers",
      description:
        "查询 Yield Monitor 触发记录列表（delta_diff 类型）。返回最近触发的原始记录。",
      parameters: {
        type: "object",
        properties: {
          device: { type: "string", description: "产品代码，如 WA03P02G" },
          lotId: { type: "string", description: "批次 ID" },
          wafer: { type: "string", description: "晶圆编号" },
          hostname: { type: "string", description: "测试机名称" },
          probeCard: { type: "string", description: "探针卡 ID" },
          probeCardType: {
            type: "string",
            description: "探针卡类型（PROBECARD 第一段，- 之前）",
          },
          pass: { type: "number", description: "Pass 编号" },
          timeFrom: { type: "string", description: "开始时间 ISO 8601" },
          timeTo: { type: "string", description: "结束时间 ISO 8601" },
          limit: {
            type: "number",
            description: "返回行数，默认 50，最大 200",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "aggregate_yield_triggers",
      description: "对 Yield Monitor 触发记录按维度聚合统计触发次数。",
      parameters: {
        type: "object",
        properties: {
          dimensions: {
            type: "string",
            description:
              "逗号分隔的聚合维度，可选: device, hostname, lotId, wafer, probeCard, probeCardType, pass, timeDay",
          },
          groupTop: {
            type: "number",
            description: "返回 top N 组，默认 10，最大 25",
          },
          device: { type: "string" },
          lotId: { type: "string" },
          wafer: { type: "string" },
          hostname: { type: "string" },
          probeCard: { type: "string" },
          probeCardType: { type: "string" },
          pass: { type: "number" },
          timeFrom: { type: "string", description: "开始时间 ISO 8601" },
          timeTo: { type: "string", description: "结束时间 ISO 8601" },
        },
        required: ["dimensions"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "query_jb_bins",
      description:
        "查询 JB STAR Layer Bins 数据列表（INFCONTROL ⋈ INFLAYERBINLIST，PASSTYPE=TEST）。",
      parameters: {
        type: "object",
        properties: {
          device: { type: "string", description: "产品代码" },
          lot: { type: "string", description: "批次 ID" },
          slot: { type: "number", description: "晶圆槽位号" },
          cardId: { type: "string", description: "探针卡 ID（CARDID）" },
          probeCardType: { type: "string", description: "探针卡类型" },
          testerId: { type: "string", description: "测试机 ID" },
          passId: { type: "number", description: "Pass ID" },
          meslot: { type: "string", description: "MES 槽位" },
          testEndFrom: {
            type: "string",
            description: "测试结束时间起 ISO 8601",
          },
          testEndTo: {
            type: "string",
            description: "测试结束时间止 ISO 8601",
          },
          limit: {
            type: "number",
            description: "返回行数，默认 50，最大 200",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "aggregate_jb_bins",
      description:
        "对 JB STAR 数据按维度聚合统计 die 数量（UNPIVOT BIN0-BIN255，仅统计坏 bin）。bin 维度自动包含。",
      parameters: {
        type: "object",
        properties: {
          groupBy: {
            type: "string",
            description:
              "逗号分隔的分组维度，可选（bin 自动包含）: device, lot, slot, cardId, probeCardType, testerId, passId, layerName, passResume, passResult, meslot",
          },
          groupTop: {
            type: "number",
            description: "返回 top N 组，默认 10，最大 50",
          },
          device: { type: "string" },
          lot: { type: "string" },
          slot: { type: "number" },
          cardId: { type: "string" },
          probeCardType: { type: "string" },
          testerId: { type: "string" },
          passId: { type: "number" },
          meslot: { type: "string" },
          testEndFrom: { type: "string" },
          testEndTo: { type: "string" },
        },
        required: ["groupBy"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_chart",
      description:
        "根据数据生成 ECharts 图表配置。调用后图表会内嵌显示在对话中。",
      parameters: {
        type: "object",
        properties: {
          chartType: {
            type: "string",
            enum: ["bar", "line", "pie", "scatter"],
            description: "图表类型",
          },
          title: { type: "string", description: "图表标题" },
          data: {
            type: "object",
            description: "图表数据",
            properties: {
              labels: {
                type: "array",
                items: { type: "string" },
                description: "X 轴标签或 pie 分类",
              },
              series: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    values: { type: "array", items: { type: "number" } },
                  },
                  required: ["name", "values"],
                },
              },
            },
            required: ["labels", "series"],
          },
        },
        required: ["chartType", "title", "data"],
      },
    },
  },
] as const;

// ─── Chart generation ──────────────────────────────────────────────────────

export interface ChartData {
  labels: string[];
  series: { name: string; values: number[] }[];
}

export interface ChartSentinel {
  __chartOption: object;
}

function buildChartOption(
  chartType: "bar" | "line" | "pie" | "scatter",
  title: string,
  data: ChartData
): object {
  if (chartType === "pie") {
    const pieData = data.labels.map((label, i) => ({
      name: label,
      value: data.series[0]?.values[i] ?? 0,
    }));
    return {
      title: { text: title, left: "center" },
      tooltip: { trigger: "item" },
      legend: { orient: "vertical", left: "left" },
      series: [{ type: "pie", radius: "50%", data: pieData }],
    };
  }

  const xAxis =
    chartType === "scatter"
      ? undefined
      : { type: "category", data: data.labels, axisLabel: { rotate: 30 } };

  const series = data.series.map((s) => {
    if (chartType === "scatter") {
      return {
        name: s.name,
        type: "scatter",
        data: data.labels.map((label, i) => [label, s.values[i] ?? 0]),
      };
    }
    return { name: s.name, type: chartType, data: s.values };
  });

  return {
    title: { text: title },
    tooltip: { trigger: "axis" },
    legend: { data: data.series.map((s) => s.name) },
    xAxis,
    yAxis: { type: "value" },
    series,
  };
}

// ─── Tool dispatch ─────────────────────────────────────────────────────────

const TOOL_LIST_LIMIT = 50;
const TOOL_LIST_LIMIT_MAX = 200;
const TOOL_RESULT_TRUNCATE = 3000;

function clampLimit(raw: unknown, defaultVal: number, max: number): number {
  const n = typeof raw === "number" ? raw : defaultVal;
  return Math.min(Math.max(1, Math.round(n)), max);
}

function truncateResult(obj: unknown): string {
  const s = JSON.stringify(obj);
  return s.length > TOOL_RESULT_TRUNCATE
    ? s.slice(0, TOOL_RESULT_TRUNCATE) + "…(truncated)"
    : s;
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
  // remap timeFrom/timeTo to the filter's expected keys
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
    return truncateResult({ count: rows.length, rows });
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
  return truncateResult({ count: enriched.length, rows: enriched });
}

async function toolAggregateJbBins(
  args: Record<string, unknown>
): Promise<string> {
  const groupByRaw = String(args["groupBy"] ?? "bin");
  const groupTop = clampLimit(args["groupTop"], 10, 50);

  // Ensure "bin" is present in groupBy
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
    return {
      groups: (aggResult.rows ?? []) as Record<string, unknown>[],
      total: totalCount,
    };
  });

  return truncateResult({ totalRowsMatching: total, groups });
}

// ─── Public dispatcher ─────────────────────────────────────────────────────

export async function runTool(
  name: string,
  args: Record<string, unknown>
): Promise<string | ChartSentinel> {
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
      const chartType = args["chartType"] as "bar" | "line" | "pie" | "scatter";
      const title = String(args["title"] ?? "");
      const data = args["data"] as ChartData;
      const option = buildChartOption(chartType, title, data);
      return { __chartOption: option };
    }
    default:
      return `未知工具: ${name}`;
  }
}
