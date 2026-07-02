// pcr-ai-api/src/lib/agent/agentToolHandlers.ts
import { runInfTool } from "../infTools/index.js";
import { withConnection, withProbeWebConnection } from "../../oracle.js";
import oracledb from "oracledb";
import { logAgentSql } from "./agentSqlDebugLog.js";
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
import { deviceBaseMask } from "../deviceMask.js";
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
import { normalizeInfDrawWaferMapArgs } from "./agentInfWaferMapTool.js";
import type { ChatMessage } from "./agentHistory.js";
import { runGetFilterValues } from "./agentFilterValuesTool.js";
import {
  serializeJbQueryResultForAgent,
  wrapJbQueryResultForAgent,
  type CardByPassIdEntry,
} from "./agentJbBinFormat.js";
import {
  buildDistinctLotsFromMatchingRows,
  fetchOracleDistinctLotsForJb,
} from "./agentJbDistinctLots.js";
import {
  buildCardDegradationSignal,
  type CardDegradationSignal,
} from "./agentCrossdomainInsights.js";
import {
  clampToolResultMaxChars,
  DEFAULT_TOOL_RESULT_MAX_CHARS,
} from "./agentConfig.js";
import { buildInfPath } from "../buildInfPath.js";
import { runLotUnderperformingDuts } from "../lotUnderperformingDutsResolve.js";
import { formatAllDutsHighlightMarkdown } from "./agentUnderperformingDutView.js";
import {
  runOutputSiteBinByLot,
  runOutputSiteBinByLotForLot,
  runOutputSiteBinByLotForLotByDirectory,
  parseSiteBinByLotJson,
  type SiteBinPass,
} from "../outputSiteBinByLot.js";
import {
  tryResolveSiteBinByLotDummy,
  tryResolveSiteBinByLotDummyForLot,
  tryResolveSiteBinByLotDummyForLotByDirectory,
} from "../outputSiteBinByLotDummy.js";
import { parseSiteBinByLotTestEndWindow } from "../siteBinByLotTestEndWindow.js";
import {
  buildDutConcentrationInsights,
  formatDutConcentrationMarkdown,
  goodBinNumbersFromSiteBinPasses,
} from "./agentDutConcentration.js";
import { shouldRunDutAnalysis } from "./agentDutInsightTrigger.js";

export type { ChartSentinel, ClarificationSentinel };

export type RunToolOptions = {
  toolResultMaxChars?: number;
  /** Recent session turns — used to infer generate_chart data when model omits args. */
  history?: ChatMessage[];
  /** query_jb_bins：serialize 前写入完整 markdown 缓存（总结轮直出表）。 */
  onJbBinsWrapped?: (wrapped: Record<string, unknown>) => void;
  /** 用户原始问题文本，供 DUT 集中度触发判断使用。 */
  userText?: string;
  /** query_lot_underperforming_duts：算出 passes 后回传，供直连出散点图。 */
  onUnderperformingDuts?: (passes: import("../lotUnderperformingDuts.js").PassUnderperformingDutsResult[]) => void;
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
    if (s.length <= maxChars) return s;
    const omitted = s.length - maxChars;
    return (
      s.slice(0, maxChars) +
      `…[数据已截断：省略了末尾 ${omitted} 字符（共 ${s.length} 字符），以上为不完整数据，请基于可见部分作答，勿假设省略部分的内容]`
    );
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
    MASK: deviceBaseMask(base["DEVICE"] ?? base["device"]),
  };
}

function enrichJbRow(row: Record<string, unknown>): Record<string, unknown> {
  const e = enrichInfcontrolLayerBinRowV2(row);
  return {
    ...e,
    PROBECARDTYPE: probeCardTypeLeadingSegment(e["CARDID"] ?? e["cardid"]),
    MASK: deviceBaseMask(e["DEVICE"] ?? e["device"]),
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
async function fetchYmRowsForCard(
  cardId: string
): Promise<Record<string, unknown>[]> {
  const params = { probeCard: cardId };
  const parsed = parseYieldMonitorTriggerV3Query(params);
  if (!parsed.ok) return [];
  const limit = 200;
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

  // 跨域退化信号：仅在 cardId 存在且无 lot 过滤时（多 lot 趋势分析才有意义）
  const cardIdForInsight =
    !lotScoped && typeof args["cardId"] === "string"
      ? args["cardId"].trim()
      : "";

  async function computeCardSignal(
    enrichedRows: Record<string, unknown>[]
  ): Promise<CardDegradationSignal | null> {
    if (!cardIdForInsight || enrichedRows.length === 0) return null;
    try {
      const ymRows = await fetchYmRowsForCard(cardIdForInsight);
      return buildCardDegradationSignal(enrichedRows, ymRows, cardIdForInsight);
    } catch {
      return null;
    }
  }

  if (infcontrolLayerBinsUseDummy()) {
    const matching = filterInfcontrolLayerBinV3DummyRowsMatching(parsed.applied);
    const matchingEnriched = matching.map((r) =>
      enrichJbRow(r as Record<string, unknown>)
    );
    const rows = (lotScoped ? matchingEnriched : filterInfcontrolLayerBinV3DummyRows(parsed.applied, limit).map(
      (r) => enrichJbRow(r as Record<string, unknown>)
    ));
    const distinctLots = lotScoped
      ? undefined
      : buildDistinctLotsFromMatchingRows(matchingEnriched);
    const cardDegradationSignal = await computeCardSignal(rows);
    const wrapped = wrapJbQueryResultForAgent(rows, {
      lotScopedFullRows: lotScoped,
      cardDegradationSignal,
      recentLotsOverride: distinctLots?.lots,
      totalDistinctLots: distinctLots?.totalDistinct,
    });
    // attach BEFORE onJbBinsWrapped: the callback snapshots the session cache,
    // which the deterministic summary reads from — the field must exist first.
    await attachDutConcentrationToJbPayload(wrapped, options?.userText ?? "");
    options?.onJbBinsWrapped?.(wrapped);
    return serializeJbQueryResultForAgent(wrapped, maxChars);
  }

  const sql = lotScoped
    ? buildInfcontrolLayerBinsV3SqlFullMatching(parsed.whereAndSql)
    : buildInfcontrolLayerBinsV3Sql(parsed.whereAndSql);
  const queryBinds = lotScoped ? parsed.binds : { ...parsed.binds, lim: limit };
  logAgentSql("query_jb_bins", sql, queryBinds, {
    lotScoped,
    mask: String(args["mask"] ?? "") || undefined,
    lot: String(args["lot"] ?? "") || undefined,
    cardId: String(args["cardId"] ?? "") || undefined,
  });
  const [rows, distinctLots] = await Promise.all([
    withConnection(async (conn) => {
      const result = await conn.execute(sql, queryBinds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });
      const r = (result.rows ?? []) as Record<string, unknown>[];
      logAgentSql("query_jb_bins:result", "(rows returned)", queryBinds, {
        rowCount: r.length,
      });
      return r;
    }),
    lotScoped
      ? Promise.resolve(null)
      : fetchOracleDistinctLotsForJb(
          parsed.whereAndSql,
          parsed.binds as Record<string, string | number | Date>
        ),
  ]);
  const enriched = rows.map(enrichJbRow);
  const cardDegradationSignal = await computeCardSignal(enriched);
  const wrapped = wrapJbQueryResultForAgent(enriched, {
    lotScopedFullRows: lotScoped,
    cardDegradationSignal,
    recentLotsOverride: distinctLots?.lots,
    totalDistinctLots: distinctLots?.totalDistinct,
  });
  options?.onJbBinsWrapped?.(wrapped);
  await attachDutConcentrationToJbPayload(wrapped, options?.userText ?? "");
  return serializeJbQueryResultForAgent(wrapped, maxChars);
}

function aggregateJbBinsHasScopeFilter(args: Record<string, unknown>): boolean {
  const lot = String(args["lot"] ?? "").trim();
  const device = String(args["device"] ?? "").trim();
  const mask = String(args["mask"] ?? "").trim();
  const cardId = String(args["cardId"] ?? "").trim();
  const probeCardType = String(args["probeCardType"] ?? "").trim();
  const testerId = String(args["testerId"] ?? "").trim();
  const meslot = String(args["meslot"] ?? "").trim();
  // Platform (TSTYPE) is a valid scope — "PS16 最近一周 哪个 lot 最差" filters by tstype.
  // A 1-year default window is auto-injected when no time params are present, so this
  // does not scan the whole table unbounded.
  const tstype = String(args["tstype"] ?? "").trim();
  const slot = args["slot"];
  const hasSlot = slot !== undefined && slot !== null && String(slot).trim() !== "";
  return Boolean(
    lot || device || mask || cardId || probeCardType || testerId || meslot || tstype || hasSlot
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
    // dummy-parity：Oracle 路径将组展平为 { bin, lot, cardId, count }（见下方 builtGroups）。
    // Dummy 原始组为 { key, parts:{...}, count } 嵌套——必须同样展平，否则确定性渲染器
    // （buildMultiLotBinTable / buildBinFocusedLotRankingMarkdown / buildBinCardAggregateMarkdown）
    // 读 g["bin"]/g["lot"] 在 dummy 下恒为空，dummy 与 Oracle 行为分叉。
    const flatGroups = result.groups.map((g) => ({ ...g.parts, count: g.count }));
    return truncateResult(
      { totalRowsMatching: result.totalRowsMatching, groups: flatGroups },
      maxChars
    );
  }

  const sql = buildInfcontrolLayerBinAggregateSql(
    parsed.whereSql,
    parsed.groupBy as InfcontrolLayerBinGroupBy[],
    "v3-hyphen-tokens"
  );
  const totalSql = buildInfcontrolLayerBinMatchingCountSql(parsed.whereSql);
  logAgentSql("aggregate_jb_bins", sql, { ...parsed.binds, agg_lim: parsed.groupTop }, {
    groupBy: groupByStr,
    mask: String(args["mask"] ?? "") || undefined,
    device: String(args["device"] ?? "") || undefined,
    lot: String(args["lot"] ?? "") || undefined,
  });

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
const MAX_DUTS_PER_BAD_BIN = 8;    // top DUTs shown per bad bin; 8 is enough for DUT comparison
const MAX_BAD_BINS_DETAIL = 15;    // limit full-DUT-breakdown to top N bad bins by totalDieCount

function extractFocusBinDuts(passes: unknown[], focusBinKey: string): unknown[] {
  const result: unknown[] = [];
  for (const p of passes) {
    const pass = p as { passId: number; bins?: unknown[] };
    if (!pass.bins) continue;
    const entry = pass.bins.find((b) => (b as { bin?: string }).bin === focusBinKey);
    if (!entry) continue;
    result.push({ passId: pass.passId, ...(entry as object) });
  }
  return result;
}

function lotDutConcentrationOpts(
  rawPasses: SiteBinPass[],
  focusBinNum: number
): Parameters<typeof buildDutConcentrationInsights>[2] {
  const opts: Parameters<typeof buildDutConcentrationInsights>[2] = {
    goodBins: goodBinNumbersFromSiteBinPasses(rawPasses),
  };
  if (Number.isFinite(focusBinNum)) opts.focusBins = [focusBinNum];
  return opts;
}

function compactSiteBinPasses(passes: SiteBinPass[]): unknown[] {
  return passes.map((pass) => {
    // Separate good bins (summary only) and bad bins (full DUT breakdown)
    type MappedBin = { bin: string; isGoodBin?: boolean; totalDieCount: number; [k: string]: unknown };
    const mapped: (MappedBin | null)[] = pass.bins.map((b) => {
      const total = b.duts.reduce((s, d) => s + d.dieCount, 0);
      if (total === 0) return null;
      const dutCount = b.duts.length;
      const avg = dutCount > 0 ? total / dutCount : 0;

      if (avg > GOOD_BIN_AVG_THRESHOLD) {
        // Good / passing bin — summary only
        const min = b.duts.reduce((m, d) => Math.min(m, d.dieCount), Infinity);
        const max = b.duts.reduce((m, d) => Math.max(m, d.dieCount), 0);
        return { bin: b.bin, isGoodBin: true, dutCount, totalDieCount: total, minPerDut: min === Infinity ? 0 : min, maxPerDut: max };
      }
      return { bin: b.bin, dutCount, totalDieCount: total, avgPerDut: Math.round(avg), _duts: b.duts };
    });

    const valid = mapped.filter(Boolean) as MappedBin[];
    const goodBins = valid.filter((b) => b.isGoodBin);
    const badBins  = valid.filter((b) => !b.isGoodBin);

    // Sort bad bins by totalDieCount desc; only show full DUT breakdown for top N
    badBins.sort((a, b) => b.totalDieCount - a.totalDieCount);
    const detailBins = badBins.slice(0, MAX_BAD_BINS_DETAIL);
    const summaryBins = badBins.slice(MAX_BAD_BINS_DETAIL);

    const formattedDetail = detailBins.map((b) => {
      const rawDuts = (b["_duts"] as Array<{ site: number; dieCount: number }>) ?? [];
      const sorted = [...rawDuts].sort((a, z) => z.dieCount - a.dieCount);
      const top = sorted.slice(0, MAX_DUTS_PER_BAD_BIN);
      const extra = sorted.length - top.length;
      const { _duts: _d, ...rest } = b;
      void _d;
      return { ...rest, duts: top, ...(extra > 0 ? { moreDuts: `另有 ${extra} 个 DUT 未展示` } : {}) };
    });

    const formattedSummary = summaryBins.map(({ _duts: _d, ...rest }) => { void _d; return { ...rest, dutBreakdownOmitted: true }; });
    const extraNote = summaryBins.length > 0
      ? [{ note: `另有 ${summaryBins.length} 个低频坏 BIN 仅含汇总（无 DUT 明细）` }]
      : [];

    return {
      passId: pass.passId,
      bins: [...goodBins, ...formattedDetail, ...formattedSummary, ...extraNote],
    };
  });
}

async function toolQueryLotDutBinAgg(
  args: Record<string, unknown>,
  maxChars: number
): Promise<string> {
  const device = typeof args["device"] === "string" ? args["device"].trim() : "";
  const lot = typeof args["lot"] === "string" ? args["lot"].trim() : "";

  if (!device) return "query_lot_dut_bin_agg 参数错误: device 不能为空";
  if (!lot) return "query_lot_dut_bin_agg 参数错误: lot 不能为空";

  const passIds: number[] = [];
  if (typeof args["passId"] === "number") passIds.push(Math.round(args["passId"]));
  if (Array.isArray(args["passIds"])) {
    for (const p of args["passIds"]) {
      if (typeof p === "number") passIds.push(Math.round(p));
    }
  }
  if (passIds.length === 0) passIds.push(1, 3, 5);

  const probeCardType =
    typeof args["probeCardType"] === "string" ? args["probeCardType"].trim() : "";

  const focusBinRaw = args["focusBin"];
  const focusBinNum = typeof focusBinRaw === "number" ? Math.round(focusBinRaw) : NaN;
  const focusBinKey = Number.isFinite(focusBinNum) ? `bin${focusBinNum}` : undefined;

  try {
    if (probeCardType) {
      const testEndWindow = parseSiteBinByLotTestEndWindow({});
      const dummy = tryResolveSiteBinByLotDummyForLot(
        device, lot, probeCardType, passIds, testEndWindow
      );
      if (dummy !== null) {
        const rawPasses = dummy.passes;
        const dutMd = formatDutConcentrationMarkdown(
          buildDutConcentrationInsights(rawPasses, [], lotDutConcentrationOpts(rawPasses, focusBinNum))
        );
        const passes = compactSiteBinPasses(rawPasses);
        const focusBinDuts = focusBinKey ? extractFocusBinDuts(passes, focusBinKey) : undefined;
        const body = truncateResult(
          {
            ...(focusBinDuts?.length ? { focusBin: focusBinKey, focusBinDuts } : {}),
            device, lot, probeCardType: dummy.probeCardType ?? probeCardType,
            waferCount: dummy.waferCount, waferSlots: dummy.waferSlots,
            passes,
          },
          maxChars
        );
        return (dutMd ? dutMd + "\n\n" : "") + body;
      }
      const res = await runOutputSiteBinByLotForLot(
        device, lot, probeCardType, passIds, testEndWindow
      );
      const rawPasses = res.data.passes;
      const dutMd = formatDutConcentrationMarkdown(
        buildDutConcentrationInsights(rawPasses, [], lotDutConcentrationOpts(rawPasses, focusBinNum))
      );
      const passes = compactSiteBinPasses(rawPasses);
      const focusBinDuts = focusBinKey ? extractFocusBinDuts(passes, focusBinKey) : undefined;
      const body = truncateResult(
        {
          ...(focusBinDuts?.length ? { focusBin: focusBinKey, focusBinDuts } : {}),
          device, lot, probeCardType: res.probeCardType ?? probeCardType,
          waferCount: res.waferCount, waferSlots: res.waferSlots,
          passes,
          ...(res.skippedInfPaths.length > 0 ? { skippedWafers: res.skippedInfPaths.length } : {}),
        },
        maxChars
      );
      return (dutMd ? dutMd + "\n\n" : "") + body;
    } else {
      const dummy = tryResolveSiteBinByLotDummyForLotByDirectory(device, lot, passIds);
      if (dummy !== null) {
        const rawPasses = dummy.passes;
        const dutMd = formatDutConcentrationMarkdown(
          buildDutConcentrationInsights(rawPasses, [], lotDutConcentrationOpts(rawPasses, focusBinNum))
        );
        const passes = compactSiteBinPasses(rawPasses);
        const focusBinDuts = focusBinKey ? extractFocusBinDuts(passes, focusBinKey) : undefined;
        const body = truncateResult(
          {
            ...(focusBinDuts?.length ? { focusBin: focusBinKey, focusBinDuts } : {}),
            device, lot,
            waferCount: dummy.waferCount, waferSlots: dummy.waferSlots,
            passes,
          },
          maxChars
        );
        return (dutMd ? dutMd + "\n\n" : "") + body;
      }
      const res = await runOutputSiteBinByLotForLotByDirectory(device, lot, passIds);
      const rawPasses = res.data.passes;
      const dutMd = formatDutConcentrationMarkdown(
        buildDutConcentrationInsights(rawPasses, [], lotDutConcentrationOpts(rawPasses, focusBinNum))
      );
      const passes = compactSiteBinPasses(rawPasses);
      const focusBinDuts = focusBinKey ? extractFocusBinDuts(passes, focusBinKey) : undefined;
      const body = truncateResult(
        {
          ...(focusBinDuts?.length ? { focusBin: focusBinKey, focusBinDuts } : {}),
          device, lot,
          waferCount: res.waferCount, waferSlots: res.waferSlots,
          passes,
        },
        maxChars
      );
      return (dutMd ? dutMd + "\n\n" : "") + body;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e && typeof e === "object" && "statusCode" in e) {
      const code = (e as { statusCode: number }).statusCode;
      if (code === 404) return `query_lot_dut_bin_agg: lot INF 目录未找到 — ${msg}`;
      if (code === 400) return `query_lot_dut_bin_agg 参数错误: ${msg}`;
    }
    return `query_lot_dut_bin_agg 执行失败: ${msg}`;
  }
}

async function toolQueryLotUnderperformingDuts(
  args: Record<string, unknown>,
  maxChars: number,
  options?: RunToolOptions
): Promise<string> {
  const lot = typeof args["lot"] === "string" ? args["lot"].trim() : "";
  if (!lot) return "query_lot_underperforming_duts 参数错误: lot 不能为空";

  const device = typeof args["device"] === "string" ? args["device"].trim() : "";
  const thresholdRaw = args["thresholdRatio"];
  const thresholdRatio =
    typeof thresholdRaw === "number" && Number.isFinite(thresholdRaw)
      ? thresholdRaw
      : undefined;

  const passIds: number[] = [];
  if (typeof args["passId"] === "number") passIds.push(Math.round(args["passId"]));
  if (Array.isArray(args["passIds"])) {
    for (const p of args["passIds"]) {
      if (typeof p === "number") passIds.push(Math.round(p));
    }
  }

  try {
    const result = await runLotUnderperformingDuts({
      lot,
      device: device || undefined,
      passIds: passIds.length > 0 ? passIds : undefined,
      thresholdRatio,
      includeMarkdown: true,
    });
    options?.onUnderperformingDuts?.(result.passes ?? []);
    // 内部工具结果串：用全 DUT 高亮表（非 REST 字段，不违反非破坏约束）
    const md =
      formatAllDutsHighlightMarkdown(result.passes ?? [], result.lot, result.device) ||
      (result.underperformingDutsMarkdown ?? "");
    const { underperformingDutsMarkdown: _md, ...payload } = result;
    void _md;
    const body = truncateResult(payload, maxChars);
    return (md ? md + "\n\n" : "") + body;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e && typeof e === "object" && "statusCode" in e) {
      const code = (e as { statusCode: number }).statusCode;
      if (code === 404) return `query_lot_underperforming_duts: lot 未找到 — ${msg}`;
      if (code === 400) return `query_lot_underperforming_duts 参数错误: ${msg}`;
    }
    return `query_lot_underperforming_duts 执行失败: ${msg}`;
  }
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
      const rawOpts = args["options"];
      const options: string[] | undefined =
        Array.isArray(rawOpts) && rawOpts.length > 0
          ? rawOpts.map(String).filter(Boolean)
          : undefined;
      return { __clarification: question, ...(options ? { __clarification_options: options } : {}) };
    }
    case "get_filter_values":
      return runGetFilterValues(args);
    case "query_lot_dut_bin_agg":
      return toolQueryLotDutBinAgg(args, maxChars);
    case "query_lot_underperforming_duts":
      return toolQueryLotUnderperformingDuts(args, maxChars, options);
    case "query_inf_site_bin_by_dut":
      return toolQueryInfSiteBinByDut(args, maxChars);
    default: {
      // Delegate inf_* tools
      if (name.startsWith("inf_")) {
        const infArgs =
          name === "inf_draw_wafer_map" && options?.history?.length
            ? normalizeInfDrawWaferMapArgs(args, options.history)
            : args;
        const result = await runInfTool(name, infArgs);
        if (result !== null) return result;
      }
      return `未知工具: ${name}`;
    }
  }
}

/**
 * 当 JB lot payload 检出可疑坏 bin（clusteredBadBinAlerts 非空）或用户问题涉及 DUT/卡 vs 工艺时，
 * 自动拉 INF site-bin-bylot 数据，计算 DUT 集中度判别，并将结果 markdown 写入
 * payload["dutConcentrationMarkdown"]。INF 失败时静默跳过，不抛、不阻断主流程。
 */
export async function attachDutConcentrationToJbPayload(
  payload: Record<string, unknown>,
  userText: string
): Promise<void> {
  if (!shouldRunDutAnalysis(userText, payload)) return;

  const device = typeof payload["device"] === "string" ? payload["device"].trim() : "";
  const lot = typeof payload["lot"] === "string" ? payload["lot"].trim() : "";
  if (!device || !lot) return;

  // focusBins 取自 clusteredBadBinAlerts[].bin（数字数组；空则不限）
  const alertsRaw = payload["clusteredBadBinAlerts"];
  const focusBins: number[] = [];
  if (Array.isArray(alertsRaw)) {
    for (const alert of alertsRaw) {
      if (
        alert &&
        typeof alert === "object" &&
        typeof (alert as Record<string, unknown>)["bin"] === "number"
      ) {
        focusBins.push((alert as Record<string, unknown>)["bin"] as number);
      }
    }
  }

  try {
    const passIds = [1, 3, 5];

    // 复用 Task 4 的取数方式（byDirectory，不限 probeCardType）
    const dummy = tryResolveSiteBinByLotDummyForLotByDirectory(device, lot, passIds);
    let rawPasses: SiteBinPass[];
    if (dummy !== null) {
      rawPasses = dummy.passes;
    } else {
      const res = await runOutputSiteBinByLotForLotByDirectory(device, lot, passIds);
      rawPasses = res.data.passes;
    }

    if (!rawPasses || rawPasses.length === 0) return;

    // focusBins 非空 = 仅分析可疑 bin；若这些 bin 在本次 INF 无数据，则不出表
    // （展示其它无关 bin 会误导卡 vs 工艺判断）。focusBins 为空时不限 bin、分析全部。
    // cardByPassId 来自 JB payload，使结论落到「卡 X 的 DUT a/b/c」。
    const cardByPassId =
      (payload["cardByPassId"] as CardByPassIdEntry[] | undefined) ?? [];
    const insights = buildDutConcentrationInsights(rawPasses, cardByPassId, {
      focusBins: focusBins.length ? focusBins : undefined,
    });
    if (insights.length === 0) return;
    const md = formatDutConcentrationMarkdown(insights);
    if (md && md.trim()) {
      payload["dutConcentrationMarkdown"] = md;
    }
  } catch {
    // INF 失败静默跳过，不阻断主流程
  }
}
