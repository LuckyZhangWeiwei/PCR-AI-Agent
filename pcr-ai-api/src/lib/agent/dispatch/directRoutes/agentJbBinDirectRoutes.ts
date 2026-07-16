// pcr-ai-api/src/lib/agent/dispatch/directRoutes/agentJbBinDirectRoutes.ts
// JB BIN scoped/ranking/good-bin/unscoped-clarify direct routes + deterministic JB
// summary, extracted verbatim from core/agentLoop.ts (Round 3 split, Task 7).
import type { AgentConfig } from "../../agentConfig.js";
import { getHistory, appendMessages, type ChatMessage } from "../../agentHistory.js";
import { runTool } from "../../tools/agentToolHandlers.js";
import {
  lastToolMessage,
  emitTextInChunks,
  toolResultForHistory,
} from "../../core/agentLoopShared.js";
import type { AgentSseEvent } from "../../core/agentLoop.js";
import { emitDeterministicJbTablesReply } from "../../render/agentJbTablesReply.js";
import { renderAggregateJbBinsResult } from "../../render/agentAggregateBinsRender.js";
import {
  buildScopeLabelFromAggregateArgs,
  findLastToolCallArgs,
} from "../../agentQueryScope.js";
import { buildAggregateBinRankingMarkdown } from "../../jb/agentJbRankingMarkdown.js";
import {
  DETERMINISTIC_DATA_SECTION_TITLE,
  DETERMINISTIC_COMMENTARY_SECTION_TITLE,
  stampFirstTestNote,
} from "../../jb/agentJbOverviewMarkdown.js";
import {
  isLotListingQuestion,
  isGoodBinValueQuestion,
  isSingleWaferDieClusterQuestion,
} from "../../jb/agentJbQuestionClassifiers.js";
import {
  canRunScopedBadBinDirectRoute,
  scopedBadBinAggregateArgsFromUser,
} from "../../agentJbScopedBadBinRoute.js";
import {
  binLotRankingAggregateArgsFromUser,
  canRunBinLotRankingDirectRoute,
} from "../../agentJbBinLotRankingRoute.js";
import {
  buildUnscopedBinClarifyMessage,
  canRunUnscopedBinClarify,
} from "../../agentJbUnscopedBinRoute.js";
import { storeJbQuerySessionCache } from "../../jb/agentJbBinFormat.js";
import {
  buildLotOverviewQueryArgs,
  getCachedJbPayloadForLot,
} from "../../agentJbOverviewRoute.js";
import {
  parseJbToolPayload,
  resolveJbToolPayload,
  buildGoodBinValueMarkdown,
} from "../../jb/agentJbPayloadResolve.js";
import { extractLotFromUserText } from "../../tools/agentInfWaferMapTool.js";

/**
 * 「WA01P14E @ b3uflex24 近3个月主要 failed bin」：直连 aggregate_jb_bins(groupBy:bin)，
 * 禁止回退 session 单 lot 概况。
 */
export async function tryRunScopedBadBinDirectRoute(
  sessionId: string,
  userQuestion: string,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void
): Promise<boolean> {
  const history = getHistory(sessionId);
  if (!canRunScopedBadBinDirectRoute(userQuestion, history)) return false;

  const aggArgs = scopedBadBinAggregateArgsFromUser(userQuestion, history);
  if (!aggArgs) return false;

  emit({ type: "status", message: "正在聚合 JB 坏 BIN 排行…" });
  emit({ type: "tool_start", name: "aggregate_jb_bins", args: aggArgs });

  let aggRaw = "";
  try {
    const aggResult = await runTool("aggregate_jb_bins", aggArgs, {
      toolResultMaxChars: agentConfig.toolResultMaxChars,
      history,
    });
    aggRaw = typeof aggResult === "string" ? aggResult : JSON.stringify(aggResult);
    emit({
      type: "tool_result",
      name: "aggregate_jb_bins",
      summary: aggRaw.slice(0, 200),
    });
    appendMessages(sessionId, {
      role: "tool",
      name: "aggregate_jb_bins",
      tool_call_id: `jb_scoped_bin_${Date.now()}`,
      content: aggRaw.slice(0, agentConfig.toolResultMaxChars),
    });
  } catch (e) {
    const msg = `JB 坏 BIN 聚合失败: ${e instanceof Error ? e.message : String(e)}`;
    emit({ type: "text", delta: msg });
    appendMessages(sessionId, { role: "assistant", content: msg });
    emit({ type: "done" });
    return true;
  }

  const scopeLabel = buildScopeLabelFromAggregateArgs(aggArgs);
  const table = buildAggregateBinRankingMarkdown(aggRaw, scopeLabel);
  if (!table?.trim()) {
    const err = `JB STAR 在 ${scopeLabel} 未聚合到坏 BIN 数据；请确认 device / 机台 / 时间范围。`;
    emit({ type: "text", delta: err });
    appendMessages(sessionId, { role: "assistant", content: err });
    emit({ type: "done" });
    return true;
  }

  const msg = stampFirstTestNote(
    `${DETERMINISTIC_DATA_SECTION_TITLE}\n\n${table}\n\n` +
      `${DETERMINISTIC_COMMENTARY_SECTION_TITLE}\n\n` +
      `*以上为 ${scopeLabel} 范围内坏 BIN 按 dieCount 降序汇总。如需某 lot 逐片趋势，请指定批次号。*`
  );
  emit({ type: "status", message: "正在输出坏 BIN 排行表…" });
  emitTextInChunks(msg, emit);
  appendMessages(sessionId, { role: "assistant", content: msg });
  emit({ type: "done" });
  return true;
}

/**
 * 「哪个 lot BIN40 最多」：直连 aggregate_jb_bins(groupBy:"bin,lot") + 指定 BIN 的 lot 排行（P-D）。
 */
export async function tryRunBinLotRankingDirectRoute(
  sessionId: string,
  userQuestion: string,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void
): Promise<boolean> {
  const history = getHistory(sessionId);
  if (!canRunBinLotRankingDirectRoute(userQuestion, history)) return false;

  const aggArgs = binLotRankingAggregateArgsFromUser(userQuestion, history);
  if (!aggArgs) return false;

  emit({ type: "status", message: "正在聚合 BIN×lot 排行…" });
  emit({ type: "tool_start", name: "aggregate_jb_bins", args: aggArgs });

  let aggRaw = "";
  try {
    const aggResult = await runTool("aggregate_jb_bins", aggArgs, {
      toolResultMaxChars: agentConfig.toolResultMaxChars,
      history,
    });
    aggRaw = typeof aggResult === "string" ? aggResult : JSON.stringify(aggResult);
    emit({
      type: "tool_result",
      name: "aggregate_jb_bins",
      summary: aggRaw.slice(0, 200),
    });
    appendMessages(sessionId, {
      role: "tool",
      name: "aggregate_jb_bins",
      tool_call_id: `jb_bin_lot_${Date.now()}`,
      content: aggRaw.slice(0, agentConfig.toolResultMaxChars),
    });
  } catch (e) {
    const msg = `BIN×lot 聚合失败: ${e instanceof Error ? e.message : String(e)}`;
    emit({ type: "text", delta: msg });
    appendMessages(sessionId, { role: "assistant", content: msg });
    emit({ type: "done" });
    return true;
  }

  const scopeLabel = buildScopeLabelFromAggregateArgs(aggArgs);
  const rendered = renderAggregateJbBinsResult(aggRaw, userQuestion, scopeLabel);
  if (!rendered?.table?.trim()) return false;

  const block = stampFirstTestNote(
    `${DETERMINISTIC_DATA_SECTION_TITLE}\n\n${rendered.table}\n\n` +
      `${DETERMINISTIC_COMMENTARY_SECTION_TITLE}\n\n${rendered.commentaryNote}`
  );
  emit({ type: "status", message: rendered.statusMessage || "正在输出 BIN×lot 排行…" });
  emitTextInChunks(block, emit);
  appendMessages(sessionId, { role: "assistant", content: block });
  emit({ type: "done" });
  return true;
}

/**
 * A2-4 兜底：bin 归因/排行类问句带无法识别的疑似 scope token（如 ZZZZZ），
 * 且无任何可解析 scope 时，直接澄清而非交 LLM 空转（250s idle 超时）。
 * 置于 PRE_LLM 直连链末端——前面所有能解析 scope 的路由都没接住时才兜底。
 */
export async function tryRunUnscopedBinClarifyDirectRoute(
  sessionId: string,
  userQuestion: string,
  _agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void
): Promise<boolean> {
  const history = getHistory(sessionId);
  if (!canRunUnscopedBinClarify(userQuestion, history)) return false;

  const msg = buildUnscopedBinClarifyMessage(userQuestion);
  emit({ type: "status", message: "未识别数据范围，正在请求澄清…" });
  emitTextInChunks(msg, emit);
  appendMessages(sessionId, { role: "assistant", content: msg });
  emit({ type: "done" });
  return true;
}

/**
 * 「DR41803.1Y 中的 good bin 是多少」：从 JB payload 直出良品 bin，不走 lot 概况表。
 */
export async function tryRunGoodBinValueDirectRoute(
  sessionId: string,
  userQuestion: string,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void
): Promise<boolean> {
  if (!isGoodBinValueQuestion(userQuestion)) return false;
  const lot = extractLotFromUserText(userQuestion);
  if (!lot) return false;

  let payload = getCachedJbPayloadForLot(sessionId, lot);
  if (!payload) {
    const queryArgs = buildLotOverviewQueryArgs(lot);
    emit({ type: "status", message: `正在查询 ${lot} JB STAR 良品 bin…` });
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
      const callId = `jb_goodbin_${Date.now()}`;
      appendMessages(sessionId, {
        role: "tool",
        name: "query_jb_bins",
        tool_call_id: callId,
        content: historyContent,
      });
      payload =
        (jbCacheForHistory ? parseJbToolPayload(jbCacheForHistory) : null) ??
        resolveJbToolPayload(sessionId, historyContent);
    } catch {
      return false;
    }
  }

  const md = payload ? buildGoodBinValueMarkdown(payload) : null;
  if (!md?.trim()) return false;

  const block = stampFirstTestNote(`${DETERMINISTIC_DATA_SECTION_TITLE}\n\n${md}`);
  emit({ type: "status", message: "正在输出良品 bin…" });
  emitTextInChunks(block, emit);
  appendMessages(sessionId, { role: "assistant", content: block });
  emit({ type: "done" });
  return true;
}

/**
 * 总结轮：先 SSE 直出服务端表，再让 LLM 只写 3–8 句解读（不改表中数字）。
 * @returns true 表示已完整结束本轮（调用方应 return）。
 */
/** 多批次聚合结果（aggregate_jb_bins groupBy:"lot"）→ 服务端直出跨批次 BIN 对比表。 */
function findLastAggregateJbBinsArgs(
  history: ChatMessage[]
): Record<string, unknown> | null {
  return findLastToolCallArgs(history, "aggregate_jb_bins");
}

export async function tryRunDeterministicJbSummary(
  sessionId: string,
  userQuestion: string,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void
): Promise<boolean> {
  const history = getHistory(sessionId);
  const lastTool = lastToolMessage(history);
  const lotListing = isLotListingQuestion(userQuestion);
  if (
    lastTool?.name !== "query_jb_bins" &&
    lastTool?.name !== "aggregate_jb_bins" &&
    !(lotListing && lastTool?.name === "query_yield_triggers") &&
    !(lotListing && lastTool?.name === "aggregate_yield_triggers")
  ) {
    return false;
  }

  if (
    lotListing &&
    (lastTool?.name === "query_yield_triggers" ||
      lastTool?.name === "aggregate_yield_triggers")
  ) {
    return emitDeterministicJbTablesReply(
      sessionId,
      userQuestion,
      {},
      agentConfig,
      emit
    );
  }

  // Cross-lot aggregate_jb_bins: emit server-generated per-lot BIN table directly.
  // Do NOT use the single-lot session cache — it would show the wrong lot.
  if (lastTool.name === "aggregate_jb_bins") {
    const aggContent = String(lastTool.content ?? "");
    const aggArgs =
      findLastAggregateJbBinsArgs(history) ??
      scopedBadBinAggregateArgsFromUser(userQuestion, history);
    const scopeLabel = aggArgs
      ? buildScopeLabelFromAggregateArgs(aggArgs)
      : undefined;
    const rendered = renderAggregateJbBinsResult(aggContent, userQuestion, scopeLabel);
    if (rendered) {
      const dataBlock = rendered.withDataTitle
        ? `${DETERMINISTIC_DATA_SECTION_TITLE}\n\n${rendered.table}`
        : rendered.table;
      const msg = stampFirstTestNote(
        !rendered.commentaryNote
          ? dataBlock
          : rendered.withDataTitle
            ? `${dataBlock}\n\n${DETERMINISTIC_COMMENTARY_SECTION_TITLE}\n\n${rendered.commentaryNote}`
            : `${dataBlock}\n\n${rendered.commentaryNote}`
      );
      if (rendered.statusMessage) {
        emit({ type: "status", message: rendered.statusMessage });
      }
      emitTextInChunks(msg, emit);
      appendMessages(sessionId, { role: "assistant", content: msg });
      emit({ type: "done" });
      return true;
    }
    // Single-lot aggregate or mis-scoped: do not fall through to session cache for scoped fail-bin questions
    if (canRunScopedBadBinDirectRoute(userQuestion, history)) {
      return false;
    }
  }

  // 单片坏 die 空间聚集问题（「这片 wafer 是否有坏 die 聚集」）：JB lot 数据无 die 坐标，
  // 整 lot 确定性 BIN 趋势表答不了 → bail 交回 LLM（可下一轮 inf_draw_wafer_map 看空间分布），
  // 避免重复输出整 lot 警示表的「套话」。
  if (
    lastTool.name === "query_jb_bins" &&
    isSingleWaferDieClusterQuestion(userQuestion)
  ) {
    console.warn(
      `[jbDeterministic/singleWaferClusterBail] 单片空间聚集问题不出整 lot 表，交回 LLM；问「${userQuestion.slice(0, 40)}」。`
    );
    return false;
  }

  const payload = resolveJbToolPayload(
    sessionId,
    String(lastTool.content ?? ""),
    extractLotFromUserText(userQuestion)
      ? { preferredLot: extractLotFromUserText(userQuestion)! }
      : undefined
  );
  if (!payload) return false;

  // 多卡 / 多 lot 「单 lot 表答非所问」的 bail 已收口到 emitDeterministicJbTablesReply 入口
  // （统一守卫），summary 轮的单 lot 概况出口即下方 `return emitDeterministicJbTablesReply(...)`，
  // 会被守卫放行。
  return emitDeterministicJbTablesReply(
    sessionId,
    userQuestion,
    payload,
    agentConfig,
    emit
  );
}
