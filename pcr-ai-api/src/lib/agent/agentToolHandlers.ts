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
  filterInfcontrolLayerBinV3DummyRowsMatching,
  aggregateInfcontrolLayerBinV3DummyRows,
} from "../infcontrolLayerBinDummy.js";
import {
  buildYieldMonitorTriggersV3Sql,
  buildInfcontrolLayerBinsV3Sql,
  buildInfcontrolLayerBinsV3SqlFullMatching,
} from "../apiV3ListSql.js";
import { probeCardTypeLeadingSegment } from "../probeCardTypeLeadingSegment.js";
import { deviceMask } from "../deviceMask.js";
import { addDutNumberToYieldMonitorV3Row } from "../yieldTriggerLabelDut.js";
import { enrichInfcontrolLayerBinRowV2 } from "../passBinSemantics.js";
import {
  buildChartOption,
  inferGenerateChartArgsFromHistory,
  normalizeGenerateChartArgs,
  resolveGenerateChartData,
  type ChartSentinel,
  type ClarificationSentinel,
} from "./agentChartTool.js";
import type { ChatMessage } from "./agentHistory.js";
import { runGetFilterValues } from "./agentFilterValuesTool.js";
import {
  serializeJbQueryResultForAgent,
  wrapJbQueryResultForAgent,
} from "./agentJbBinFormat.js";
import {
  clampToolResultMaxChars,
  DEFAULT_TOOL_RESULT_MAX_CHARS,
} from "./agentConfig.js";
import { buildInfPath } from "../buildInfPath.js";
import {
  runOutputSiteBinByLot,
  parseSiteBinByLotJson,
  type SiteBinPass,
} from "../outputSiteBinByLot.js";
import { tryResolveSiteBinByLotDummy } from "../outputSiteBinByLotDummy.js";

export type { ChartSentinel, ClarificationSentinel };

export type RunToolOptions = {
  toolResultMaxChars?: number;
  /** Recent session turns — used to infer generate_chart data when model omits args. */
  history?: ChatMessage[];
  /** query_jb_bins：serialize 前写入完整 markdown 缓存（总结轮直出表）。 */
  onJbBinsWrapped?: (wrapped: Record<string, unknown>) => void;
};

const TOOL_LIST_LIMIT = 50;
const TOOL_LIST_LIMIT_MAX = 200;

function resolveToolResultMaxChars(options?: RunToolOptions): number {
  return clampToolResultMaxChars(
    options?.toolResultMaxChars ?? DEFAULT_TOOL_RESULT_MAX_CHARS
  );
}

function clampLimit(raw: unknown, defaultVal: number, max: number): number {
  const n = typeof raw === "number" ? raw : defaultVal;
  return Math.min(Math.max(1, Math.round(n)), max);
}

function truncateResult(obj: unknown, maxChars: number): string {
  try {
    const s = JSON.stringify(obj);
    return s.length > maxChars
      ? s.slice(0, maxChars) + "…(truncated)"
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
    MASK: deviceMask(base["DEVICE"] ?? base["device"]),
  };
}

function enrichJbRow(row: Record<string, unknown>): Record<string, unknown> {
  const e = enrichInfcontrolLayerBinRowV2(row);
  return {
    ...e,
    PROBECARDTYPE: probeCardTypeLeadingSegment(e["CARDID"] ?? e["cardid"]),
    MASK: deviceMask(e["DEVICE"] ?? e["device"]),
  };
}

async function toolQueryYieldTriggers(
  args: Record<string, unknown>,
  maxChars: number
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

async function toolAggregateYieldTriggers(
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
    return truncateResult(result, maxChars);
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

/** 指定 lot 时须取全量行，否则 TESTEND DESC + limit 会丢掉较早的 sort1（passId=1）行。 */
function isJbLotScopedAgentQuery(args: Record<string, unknown>): boolean {
  return Boolean(String(args["lot"] ?? "").trim());
}

function jbQueryHasTimeFilter(args: Record<string, unknown>): boolean {
  for (const k of [
    "testStartBegin",
    "testStartFrom",
    "testStartEnd",
    "testStartTo",
    "testEndBegin",
    "testEndFrom",
    "testEndEnd",
    "testEndTo",
  ]) {
    const v = args[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return true;
  }
  return false;
}

async function toolQueryJbBins(
  args: Record<string, unknown>,
  maxChars: number,
  options?: RunToolOptions
): Promise<string> {
  const limit = clampLimit(args["limit"], TOOL_LIST_LIMIT, TOOL_LIST_LIMIT_MAX);
  const lotScoped = isJbLotScopedAgentQuery(args);
  const queryInput: Record<string, unknown> = { ...args, limit };
  if (lotScoped && !jbQueryHasTimeFilter(args)) {
    queryInput.testEndFrom = queryInput.testEndFrom ?? "2020-01-01";
  }
  const parsed = parseInfcontrolLayerBinsV3Query(queryInput);
  if (!parsed.ok) return `查询参数错误: ${parsed.error}`;

  if (infcontrolLayerBinsUseDummy()) {
    const matching = filterInfcontrolLayerBinV3DummyRowsMatching(parsed.applied);
    const rows = (lotScoped ? matching : filterInfcontrolLayerBinV3DummyRows(parsed.applied, limit)).map(
      (r) => enrichJbRow(r as Record<string, unknown>)
    );
    const wrapped = wrapJbQueryResultForAgent(rows, {
      lotScopedFullRows: lotScoped,
    });
    options?.onJbBinsWrapped?.(wrapped);
    return serializeJbQueryResultForAgent(wrapped, maxChars);
  }

  const sql = lotScoped
    ? buildInfcontrolLayerBinsV3SqlFullMatching(parsed.whereAndSql)
    : buildInfcontrolLayerBinsV3Sql(parsed.whereAndSql);
  const rows = await withConnection(async (conn) => {
    const result = await conn.execute(
      sql,
      lotScoped ? parsed.binds : { ...parsed.binds, lim: limit },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    return (result.rows ?? []) as Record<string, unknown>[];
  });
  const enriched = rows.map(enrichJbRow);
  const wrapped = wrapJbQueryResultForAgent(enriched, {
    lotScopedFullRows: lotScoped,
  });
  options?.onJbBinsWrapped?.(wrapped);
  return serializeJbQueryResultForAgent(wrapped, maxChars);
}

function aggregateJbBinsHasScopeFilter(args: Record<string, unknown>): boolean {
  const lot = String(args["lot"] ?? "").trim();
  const device = String(args["device"] ?? "").trim();
  const cardId = String(args["cardId"] ?? "").trim();
  const probeCardType = String(args["probeCardType"] ?? "").trim();
  const testerId = String(args["testerId"] ?? "").trim();
  const meslot = String(args["meslot"] ?? "").trim();
  const slot = args["slot"];
  const hasSlot = slot !== undefined && slot !== null && String(slot).trim() !== "";
  return Boolean(
    lot || device || cardId || probeCardType || testerId || meslot || hasSlot
  );
}

async function toolAggregateJbBins(
  args: Record<string, unknown>,
  maxChars: number
): Promise<string> {
  if (!aggregateJbBinsHasScopeFilter(args)) {
    return (
      "aggregate_jb_bins 错误：未传 lot / device / cardId / slot 等过滤条件，将统计全库数据而非用户指定的批次。" +
      "用户已给出 lot ID 时须传 lot（完整含后缀，如 NF12827.1R）。" +
      "单 lot「整体/概况/坏 bin 排名」请改用 query_jb_bins(lot, limit:200)，读 topBadBins、slotYieldSummary、cardByPassId；勿调用无过滤的本工具。"
    );
  }

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
    return truncateResult(result, maxChars);
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

  return truncateResult({ totalRowsMatching: total, groups }, maxChars);
}

/**
 * Compact INF DUT-distribution data before handing to the model.
 *
 * Without compaction a single wafer (78 DUTs × 50 bins × 3 passes) can
 * exceed 100 KB of JSON, blowing past any reasonable toolResultMaxChars.
 *
 * Strategy:
 *  - Good bins (avgDiePerDut > GOOD_BIN_THRESHOLD): replace the full DUT
 *    array with a 5-field summary — model only needs min/max/total.
 *  - Bad bins: keep top MAX_DUTS_PER_BIN DUTs sorted by dieCount desc;
 *    append a "moreDuts" note for the remainder.
 *  - Skip bins with totalDieCount = 0.
 */
const GOOD_BIN_AVG_THRESHOLD = 100; // avg dieCount/DUT above this ≈ good/passing bin
const MAX_DUTS_PER_BAD_BIN = 20;

function compactSiteBinPasses(passes: SiteBinPass[]): unknown[] {
  return passes.map((pass) => ({
    passId: pass.passId,
    bins: pass.bins
      .map((b) => {
        const total = b.duts.reduce((s, d) => s + d.dieCount, 0);
        if (total === 0) return null;
        const dutCount = b.duts.length;
        const avg = dutCount > 0 ? total / dutCount : 0;

        if (avg > GOOD_BIN_AVG_THRESHOLD) {
          // Good / passing bin — summarise only
          const min = b.duts.reduce((m, d) => Math.min(m, d.dieCount), Infinity);
          const max = b.duts.reduce((m, d) => Math.max(m, d.dieCount), 0);
          return {
            bin: b.bin,
            isGoodBin: true,
            dutCount,
            totalDieCount: total,
            minPerDut: min === Infinity ? 0 : min,
            maxPerDut: max,
          };
        }

        // Bad bin — top N DUTs by dieCount desc
        const sorted = [...b.duts].sort((a, z) => z.dieCount - a.dieCount);
        const top = sorted.slice(0, MAX_DUTS_PER_BAD_BIN);
        const extra = sorted.length - top.length;
        return {
          bin: b.bin,
          dutCount,
          totalDieCount: total,
          avgPerDut: Math.round(avg),
          duts: top,
          ...(extra > 0 ? { moreDuts: `另有 ${extra} 个 DUT 未展示（dieCount 较低）` } : {}),
        };
      })
      .filter(Boolean),
  }));
}

async function toolQueryInfSiteBinByDut(
  args: Record<string, unknown>,
  maxChars: number
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
    const result = { cardId, device, lot, slot, infPath, passes: compactSiteBinPasses(dummy.passes) };
    return truncateResult(result, maxChars);
  }

  const { stdout, stderr, exitCode } = await runOutputSiteBinByLot(infPath, passIds);
  if (exitCode !== 0) {
    return truncateResult({
      error: "INF/Perl 失败",
      stderr: stderr.slice(0, 500),
      hint: "检查 INF_STORAGE_ROOT 及 infPath 在 API 主机上是否可读",
    }, maxChars);
  }
  try {
    const data = parseSiteBinByLotJson(stdout);
    const compacted = { cardId, device, lot, slot, infPath, passes: compactSiteBinPasses(data.passes) };
    return truncateResult(compacted, maxChars);
  } catch (e) {
    return `INF 解析失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export async function runTool(
  name: string,
  args: Record<string, unknown>,
  options?: RunToolOptions
): Promise<string | ChartSentinel | ClarificationSentinel> {
  const maxChars = resolveToolResultMaxChars(options);
  switch (name) {
    case "query_yield_triggers":
      return toolQueryYieldTriggers(args, maxChars);
    case "aggregate_yield_triggers":
      return toolAggregateYieldTriggers(args, maxChars);
    case "query_jb_bins":
      return toolQueryJbBins(args, maxChars, options);
    case "aggregate_jb_bins":
      return toolAggregateJbBins(args, maxChars);
    case "generate_chart": {
      try {
        const fromHistory =
          options?.history && options.history.length > 0
            ? inferGenerateChartArgsFromHistory(options.history, args)
            : null;
        const normalized = fromHistory ?? normalizeGenerateChartArgs(args);
        const chartType = (normalized["chartType"] ?? "pie") as
          | "bar"
          | "line"
          | "pie"
          | "scatter";
        const title = String(normalized["title"] ?? "");
        const data = resolveGenerateChartData(normalized);
        if (!data) {
          const keys = Object.keys(args).join(", ") || "(空)";
          const hint = options?.history?.some(
            (m) => m.role === "tool" && m.name === "query_inf_site_bin_by_dut"
          )
            ? " 若刚查询过 INF DUT 分布，请确保 title 或用户问题中含 DUT 编号（如 DUT2），或显式传入 labels+values。"
            : "";
          return (
            `生成图表失败: 缺少有效的 labels/values 或 data 结构。` +
            `请传入 data: { labels, series } 或顶层 labels + values 数组。收到参数键: ${keys}` +
            hint
          );
        }
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
      return toolQueryInfSiteBinByDut(args, maxChars);
    default:
      return `未知工具: ${name}`;
  }
}
