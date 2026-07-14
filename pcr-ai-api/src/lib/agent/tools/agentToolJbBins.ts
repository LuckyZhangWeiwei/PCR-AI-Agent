// pcr-ai-api/src/lib/agent/tools/agentToolJbBins.ts
import { withConnection } from "../../../oracle.js";
import oracledb from "oracledb";
import { logAgentSql } from "../agentSqlDebugLog.js";
import {
  parseInfcontrolLayerBinsV3Query,
} from "../../infcontrol/infcontrolLayerBinFilters.js";
import {
  parseInfcontrolLayerBinsV3AggregateQuery,
} from "../../infcontrol/infcontrolLayerBinV3Aggregate.js";
import {
  buildInfcontrolLayerBinAggregateSql,
  buildInfcontrolLayerBinMatchingCountSql,
  buildInfcontrolLayerBinAggregateGroupParts,
  type InfcontrolLayerBinGroupBy,
} from "../../infcontrol/infcontrolLayerBinAggregate.js";
import {
  infcontrolLayerBinsUseDummy,
} from "../../infcontrol/infcontrolLayerBinDummy.js";
import {
  filterInfcontrolLayerBinV3DummyRows,
  filterInfcontrolLayerBinV3DummyRowsMatching,
  aggregateInfcontrolLayerBinV3DummyRows,
} from "../../infcontrol/infcontrolLayerBinDummyV3.js";
import {
  buildInfcontrolLayerBinsV3Sql,
  buildInfcontrolLayerBinsV3SqlFullMatching,
} from "../../apiV3ListSql.js";
import {
  serializeJbQueryResultForAgent,
  wrapJbQueryResultForAgent,
} from "../jb/agentJbBinFormat.js";
import {
  buildDistinctLotsFromMatchingRows,
  fetchOracleDistinctLotsForJb,
} from "../agentJbDistinctLots.js";
import {
  buildCardDegradationSignal,
  type CardDegradationSignal,
} from "../agentCrossdomainInsights.js";
import {
  clampLimit,
  truncateResult,
  enrichJbRow,
  attachDutConcentrationToJbPayload,
  type RunToolOptions,
} from "./agentToolHandlers.js";
import { fetchYmRowsForCard } from "./agentToolYieldTriggers.js";

const TOOL_LIST_LIMIT = 50;
const TOOL_LIST_LIMIT_MAX = 200;

/** 指定 lot 时须取全量行，否则 TESTEND DESC + limit 会丢掉较早的 sort1（passId=1）行。 */
export function isJbLotScopedAgentQuery(args: Record<string, unknown>): boolean {
  return Boolean(String(args["lot"] ?? "").trim());
}

export function jbQueryHasTimeFilter(args: Record<string, unknown>): boolean {
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

export async function toolQueryJbBins(
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

export function aggregateJbBinsHasScopeFilter(args: Record<string, unknown>): boolean {
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

export async function toolAggregateJbBins(
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
