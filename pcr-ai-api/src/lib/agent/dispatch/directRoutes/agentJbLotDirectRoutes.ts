// pcr-ai-api/src/lib/agent/dispatch/directRoutes/agentJbLotDirectRoutes.ts
// JB lot / mask-scope / lot-listing / equipment / per-slot-bin-ranking deterministic
// direct routes, extracted verbatim from core/agentLoop.ts (Round 3 split, Task 6).
import type { AgentConfig } from "../../agentConfig.js";
import { getHistory, appendMessages } from "../../agentHistory.js";
import { runTool } from "../../tools/agentToolHandlers.js";
import {
  storeJbQuerySessionCache,
  jbWrappedIsEmptyQuery,
} from "../../jb/agentJbBinFormat.js";
import { toolResultForHistory } from "../../core/agentLoopShared.js";
import type { AgentSseEvent } from "../../core/agentLoop.js";
import {
  parseJbToolPayload,
  resolveJbToolPayload,
} from "../../jb/agentJbPayloadResolve.js";
import { emitDeterministicJbTablesReply } from "../../render/agentJbTablesReply.js";
import {
  buildLotOverviewQueryArgs,
  canRunLotOverviewDirectRoute,
  getCachedJbPayloadForLot,
} from "../../agentJbOverviewRoute.js";
import {
  buildListingTimeClarifyMessage,
  canRunListingTimeClarify,
  canRunLotListingDirectRoute,
  lotListingAggregateArgsFromUser,
  lotListingQueryArgsFromUser,
} from "../../agentJbLotListingRoute.js";
import { emitTextInChunks } from "../../core/agentLoopShared.js";
import {
  canRunMaskScopeDirectRoute,
  maskScopeFilterValuesArgs,
  maskScopeJbQueryArgs,
} from "../../agentJbMaskScopeRoute.js";
import {
  isLotDetailListingQuestion,
  isLotYieldRankingQuestion,
  isPerSlotBadBinRankingQuestion,
  isProbeCardQuestion,
  isBinCardAttributionQuestion,
  isTesterMachineQuestion,
  isProbeCardTesterPerformanceQuestion,
} from "../../jb/agentJbQuestionClassifiers.js";
import { inferLotListingPresentation } from "../../jb/agentJbListingMarkdown.js";
import {
  requiresNewDataQuery,
  cachedJbScopeMismatchReason,
  equipmentRouteCrossLotBail,
} from "../agentQuestionHeuristics.js";
import { resolveJbRoute } from "../../jbRouteResolver.js";
import { extractLotFromUserText } from "../../tools/agentInfWaferMapTool.js";

/**
 * 「DR44117.1Y 整体测试情况」：服务端 query_jb_bins + 表，不走首轮/解读 LLM。
 */
export async function tryRunLotOverviewDirectRoute(
  sessionId: string,
  userQuestion: string,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void
): Promise<boolean> {
  if (!canRunLotOverviewDirectRoute(userQuestion)) return false;

  const lot = extractLotFromUserText(userQuestion)!;
  let payload = getCachedJbPayloadForLot(sessionId, lot);

  if (!payload) {
    const queryArgs = buildLotOverviewQueryArgs(lot);
    emit({ type: "status", message: `正在查询 ${lot} JB STAR 数据…` });
    emit({ type: "tool_start", name: "query_jb_bins", args: queryArgs });

    let jbCacheForHistory: string | undefined;
    try {
      const toolResult = await runTool("query_jb_bins", queryArgs, {
        toolResultMaxChars: agentConfig.toolResultMaxChars,
        history: getHistory(sessionId),
        onJbBinsWrapped: (wrapped) => {
          jbCacheForHistory = storeJbQuerySessionCache(sessionId, wrapped);
        },
      });
      const rawContent =
        typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult);
      const historyContent = toolResultForHistory(
        "query_jb_bins",
        rawContent,
        agentConfig.toolResultMaxHistoryChars,
        agentConfig.toolResultMaxChars,
        jbCacheForHistory
      );
      emit({
        type: "tool_result",
        name: "query_jb_bins",
        summary: historyContent.slice(0, 200),
      });
      const callId = `jb_overview_${Date.now()}`;
      appendMessages(sessionId, {
        role: "tool",
        name: "query_jb_bins",
        tool_call_id: callId,
        content: historyContent,
      });
      payload =
        (jbCacheForHistory ? parseJbToolPayload(jbCacheForHistory) : null) ??
        resolveJbToolPayload(sessionId, historyContent);
    } catch (e) {
      const msg = `JB 查询失败: ${e instanceof Error ? e.message : String(e)}`;
      emit({ type: "text", delta: msg });
      appendMessages(sessionId, { role: "assistant", content: msg });
      emit({ type: "done" });
      return true;
    }
  }

  if (!payload) {
    const err = `已查询 ${lot}，但无法生成概况表。请点「重试」或缩小时间范围。`;
    emit({ type: "text", delta: err });
    appendMessages(sessionId, { role: "assistant", content: err });
    emit({ type: "done" });
    return true;
  }

  return emitDeterministicJbTablesReply(
    sessionId,
    userQuestion,
    payload,
    agentConfig,
    emit
  );
}

/**
 * 「P11C 最近的测试情况」等 mask/device 级概况：get_filter_values + query_jb_bins + 服务端表，
 * 不经过 LLM（Pass C invalid apiKey 降级）。
 */
export async function tryRunMaskScopeDirectRoute(
  sessionId: string,
  userQuestion: string,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void
): Promise<boolean> {
  const history = getHistory(sessionId);
  if (!canRunMaskScopeDirectRoute(userQuestion, history)) return false;

  const fvArgs = maskScopeFilterValuesArgs(userQuestion);
  if (fvArgs) {
    emit({ type: "status", message: "正在查询 mask 对应 device…" });
    emit({ type: "tool_start", name: "get_filter_values", args: fvArgs });
    try {
      const fvResult = await runTool("get_filter_values", fvArgs, {
        toolResultMaxChars: agentConfig.toolResultMaxChars,
        history,
      });
      const fvRaw =
        typeof fvResult === "string" ? fvResult : JSON.stringify(fvResult);
      emit({
        type: "tool_result",
        name: "get_filter_values",
        summary: fvRaw.slice(0, 200),
      });
      appendMessages(sessionId, {
        role: "tool",
        name: "get_filter_values",
        tool_call_id: `mask_fv_${Date.now()}`,
        content: fvRaw.slice(0, agentConfig.toolResultMaxChars ?? 12000),
      });
    } catch {
      // filter 失败不阻断 — 继续 query_jb_bins
    }
  }

  const queryArgs = maskScopeJbQueryArgs(userQuestion, history);
  if (!queryArgs) return false;

  emit({ type: "status", message: "正在查询 JB STAR 数据…" });
  emit({ type: "tool_start", name: "query_jb_bins", args: queryArgs });

  let payload: Record<string, unknown> | null = null;
  try {
    let jbCacheForHistory: string | undefined;
    const toolResult = await runTool("query_jb_bins", queryArgs, {
      toolResultMaxChars: agentConfig.toolResultMaxChars,
      history,
      onJbBinsWrapped: (wrapped) => {
        jbCacheForHistory = storeJbQuerySessionCache(sessionId, wrapped);
      },
    });
    const rawContent =
      typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult);
    const historyContent = toolResultForHistory(
      "query_jb_bins",
      rawContent,
      agentConfig.toolResultMaxHistoryChars,
      agentConfig.toolResultMaxChars,
      jbCacheForHistory
    );
    emit({
      type: "tool_result",
      name: "query_jb_bins",
      summary: historyContent.slice(0, 200),
    });
    appendMessages(sessionId, {
      role: "tool",
      name: "query_jb_bins",
      tool_call_id: `mask_scope_${Date.now()}`,
      content: historyContent,
    });
    payload =
      (jbCacheForHistory ? parseJbToolPayload(jbCacheForHistory) : null) ??
      resolveJbToolPayload(sessionId, historyContent);
  } catch {
    return false;
  }

  if (!payload || jbWrappedIsEmptyQuery(payload)) return false;

  return emitDeterministicJbTablesReply(
    sessionId,
    userQuestion,
    payload,
    agentConfig,
    emit,
    { withCommentaryLlm: false }
  );
}

/**
 * 卡 / device / 跨 lot 列表问法已能解析 scope，但未给时间窗 → 先澄清（数据量过大）。
 * 须排在 tryRunLotListingDirectRoute 之前。
 */
export async function tryRunListingTimeClarifyDirectRoute(
  sessionId: string,
  userQuestion: string,
  _agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void
): Promise<boolean> {
  const history = getHistory(sessionId);
  if (!canRunListingTimeClarify(userQuestion, history)) return false;

  const msg = buildListingTimeClarifyMessage(userQuestion, history);
  emit({ type: "status", message: "跨 lot 查询需先限定时间范围…" });
  emitTextInChunks(msg, emit);
  appendMessages(sessionId, { role: "assistant", content: msg });
  emit({ type: "done" });
  return true;
}

/**
 * 「WA01P14E 在 b3uflex24 近 3 个月所有 lot 列出来」：直连 query_jb_bins + lot 表，
 * 不经过首轮 LLM（避免 get_filter_values 空结果后误判无机台）。
 * 亦覆盖「6081-03 最近一个月怎样」「WA01N39W 近 3 个月怎样」。
 */
export async function tryRunLotListingDirectRoute(
  sessionId: string,
  userQuestion: string,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void
): Promise<boolean> {
  if (!canRunLotListingDirectRoute(userQuestion, getHistory(sessionId))) return false;

  const queryArgs = lotListingQueryArgsFromUser(userQuestion, getHistory(sessionId));
  if (!queryArgs) return false;

  emit({ type: "status", message: "正在查询 JB STAR lot 列表…" });
  emit({ type: "tool_start", name: "query_jb_bins", args: queryArgs });

  let jbCacheForHistory: string | undefined;
  let payload: Record<string, unknown> | null = null;
  try {
    const toolResult = await runTool("query_jb_bins", queryArgs, {
      toolResultMaxChars: agentConfig.toolResultMaxChars,
      history: getHistory(sessionId),
      onJbBinsWrapped: (wrapped) => {
        jbCacheForHistory = storeJbQuerySessionCache(sessionId, wrapped);
      },
    });
    const rawContent =
      typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult);
    const historyContent = toolResultForHistory(
      "query_jb_bins",
      rawContent,
      agentConfig.toolResultMaxHistoryChars,
      agentConfig.toolResultMaxChars,
      jbCacheForHistory
    );
    emit({
      type: "tool_result",
      name: "query_jb_bins",
      summary: historyContent.slice(0, 200),
    });
    appendMessages(sessionId, {
      role: "tool",
      name: "query_jb_bins",
      tool_call_id: `jb_lot_list_${Date.now()}`,
      content: historyContent,
    });
    payload =
      (jbCacheForHistory ? parseJbToolPayload(jbCacheForHistory) : null) ??
      resolveJbToolPayload(sessionId, historyContent);
  } catch (e) {
    const msg = `JB lot 列表查询失败: ${e instanceof Error ? e.message : String(e)}`;
    emit({ type: "text", delta: msg });
    appendMessages(sessionId, { role: "assistant", content: msg });
    emit({ type: "done" });
    return true;
  }

  if (!payload || jbWrappedIsEmptyQuery(payload)) {
    const err = "JB STAR 未查到匹配 lot；请确认 device / 机台 / 时间范围。";
    emit({ type: "text", delta: err });
    appendMessages(sessionId, { role: "assistant", content: err });
    emit({ type: "done" });
    return true;
  }

  // 富表需要 per-lot 主要坏 bin：detail 列表或概况（含 mask/device「测试情况」）均补 aggregate
  const needsFailBinAgg =
    isLotDetailListingQuestion(userQuestion) ||
    Boolean(inferLotListingPresentation(userQuestion).includeFailBins);
  if (needsFailBinAgg) {
    const aggArgs = lotListingAggregateArgsFromUser(
      userQuestion,
      getHistory(sessionId),
      payload
    );
    if (aggArgs) {
      emit({ type: "status", message: "正在按 lot 聚合 JB 坏 BIN…" });
      emit({ type: "tool_start", name: "aggregate_jb_bins", args: aggArgs });
      try {
        const aggResult = await runTool("aggregate_jb_bins", aggArgs, {
          toolResultMaxChars: agentConfig.toolResultMaxChars,
          history: getHistory(sessionId),
        });
        const aggRaw =
          typeof aggResult === "string" ? aggResult : JSON.stringify(aggResult);
        emit({
          type: "tool_result",
          name: "aggregate_jb_bins",
          summary: aggRaw.slice(0, 200),
        });
        appendMessages(sessionId, {
          role: "tool",
          name: "aggregate_jb_bins",
          tool_call_id: `jb_lot_agg_${Date.now()}`,
          content: aggRaw.slice(0, agentConfig.toolResultMaxChars),
        });
      } catch {
        // 列表仍可输出，仅缺 per-lot fail bin 列
      }
    }
  }

  return emitDeterministicJbTablesReply(
    sessionId,
    userQuestion,
    payload,
    agentConfig,
    emit,
    { withCommentaryLlm: false }
  );
}

/**
 * 探针卡 / 机台 直连路由：用户追问 "probecard是什么" 等时，直接从 session 缓存输出
 * equipment 表，不走 LLM，避免 LLM 用历史上下文把上一轮的 lot 总览表重复输出一次。
 * 注意：跨批次/时间范围/多 lot 查询不适用，此时 session 缓存仅含单批次数据。
 */
export async function tryRunEquipmentDirectRoute(
  sessionId: string,
  userQuestion: string,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void
): Promise<boolean> {
  if (!isProbeCardQuestion(userQuestion) && !isTesterMachineQuestion(userQuestion)) {
    return false;
  }
  if (isProbeCardTesterPerformanceQuestion(userQuestion)) return false;
  if (requiresNewDataQuery(userQuestion)) return false;
  // lot 良率排行需跨 lot 聚合，session 单批 equipment 缓存不能代答（A1-4）。
  if (isLotYieldRankingQuestion(userQuestion)) return false;
  // "包含机台/增加机台" 是对综合列表的补充修饰词，不是独立的机台查询——
  // 此时用户想要的是 bin fail 全量列表 + 机台号，不能只输出设备表，否则会反复输出同一段短表。
  if (/(增加|加上|包含|含).*机台|机台.*列表|列表.*机台/.test(userQuestion)) return false;
  // 「BIN X 集中在哪张卡」需跨卡聚合（aggregate_jb_bins groupBy:bin,cardId），不能吐缓存 equipment 表
  if (isBinCardAttributionQuestion(userQuestion)) {
    console.warn(
      `[equipmentRoute/skip:binOnCard] BIN-on-card 归因需 aggregate_jb_bins(groupBy:"bin,cardId")，` +
        `不吐缓存 equipment 表：「${userQuestion.slice(0, 50)}」`
    );
    return false;
  }
  // 问到 DUT 级归属（如「把对应的卡和 dut 都列出来」）：equipment 缓存表只有卡号 + 机台，
  // **没有 DUT 数据**（DUT 归属需 query_lot_dut_bin_agg）→ 用缓存只能出残缺答案（见 B4）。
  // bail 交回 LLM，由其调 query_lot_dut_bin_agg 补全 DUT。
  if (resolveJbRoute(userQuestion).isDutLevel) {
    console.warn(
      `[equipmentRoute/skip:dutLevel] DUT 级归属 equipment 缓存无此数据，交回 LLM：「${userQuestion.slice(0, 50)}」`
    );
    return false;
  }
  // 多卡「测试情况对比」的 bail 已收口到 emitDeterministicJbTablesReply 入口（统一守卫），
  // 此处不再单独拦截——本路由末尾 `return emitDeterministicJbTablesReply(...)` 会被该守卫放行。
  // 跨多 lot 的分析/选择问题：缓存仅单批，无法回答「哪个 lot 和卡/DUT 有关」
  if (equipmentRouteCrossLotBail(userQuestion)) {
    console.warn(
      `[equipmentRoute/skip:crossLot] 跨多 lot 分析问题不能用单批缓存作答：「${userQuestion.slice(0, 50)}」`
    );
    return false;
  }
  const payload = resolveJbToolPayload(sessionId);
  if (!payload) return false;
  // 缓存产品/批次与问题不一致 → 拒绝吐陈旧缓存（避免 N55Z 问题被 P11C 缓存张冠李戴）
  const mismatch = cachedJbScopeMismatchReason(payload, userQuestion);
  if (mismatch) {
    console.warn(
      `[equipmentRoute/skip:staleCacheScopeMismatch] 拒绝用缓存作答：${mismatch}；` +
        `问题=「${userQuestion.slice(0, 50)}」→ 应重新查询/澄清`
    );
    return false;
  }
  return emitDeterministicJbTablesReply(sessionId, userQuestion, payload, agentConfig, emit);
}

/**
 * 逐片坏 bin 排名直连路由：session 缓存已有 slotBadBinsCompact 时直接出表，
 * 不经 LLM 工具调用（避免模型误选 aggregate_jb_bins 导致死循环）。
 */
export async function tryRunPerSlotBinRankingDirectRoute(
  sessionId: string,
  userQuestion: string,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void
): Promise<boolean> {
  if (!isPerSlotBadBinRankingQuestion(userQuestion)) return false;
  const lot = extractLotFromUserText(userQuestion);
  const payload = lot
    ? getCachedJbPayloadForLot(sessionId, lot)
    : resolveJbToolPayload(sessionId);
  if (!payload) return false;
  const compact = payload["slotBadBinsCompact"];
  if (!Array.isArray(compact) || compact.length === 0) return false;
  return emitDeterministicJbTablesReply(sessionId, userQuestion, payload, agentConfig, emit);
}
