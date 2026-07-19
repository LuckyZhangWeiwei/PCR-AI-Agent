// pcr-ai-api/src/lib/agent/core/agentLoop.ts
import type { AgentConfig } from "../agentConfig.js";
import {
  getHistory,
  appendMessages,
  getSummary,
  type ChatMessage,
} from "../agentHistory.js";
import { streamSiliconFlow, type CollectedToolCall } from "./agentStream.js";
import {
  lastToolMessage,
  emitTextInChunks,
  lastUserMessageText,
} from "./agentLoopShared.js";
import {
  isTouchdownQuestion,
  isTestItemMappingQuestion,
} from "../jb/agentJbQuestionClassifiers.js";
import {
  planWaferMapRoute,
} from "../agentWaferMapRoute.js";
import {
  lotOverviewNeedsJbRecovery,
} from "../agentJbOverviewRoute.js";
import {
  lotListingNeedsJbRecovery,
} from "../agentJbLotListingRoute.js";
import {
  scopedBadBinNeedsAggregateRecovery,
} from "../agentJbScopedBadBinRoute.js";
import {
  userWantsDutBinRelationMap,
} from "../agentDutBinMapRoute.js";
// ── Extracted sibling modules (split from the original agentLoop.ts) ──────────
import { createDeepSeekFilter } from "./agentEmbeddedToolParsing.js";
import {
  isLastToolEmptyResult,
  historyAwaitingToolSummary,
} from "./agentToolStatus.js";
import { tryRunSemanticDispatchDirectRoute } from "../dispatch/agentSemanticDispatch.js";
import {
  applyWaferMapRoutePlan,
  tryRunWaferMapWithAutoDeviceLookup,
  tryRunDutBinMapDirectRoute,
  tryRunDutYieldChartDirectRoute,
  userWantsDutYieldChart,
} from "../dispatch/directRoutes/agentWaferMapDirectRoutes.js";
import {
  tryRunLotOverviewDirectRoute,
  tryRunMaskScopeDirectRoute,
  tryRunListingTimeClarifyDirectRoute,
  tryRunLotListingDirectRoute,
  tryRunEquipmentDirectRoute,
  tryRunPerSlotBinRankingDirectRoute,
} from "../dispatch/directRoutes/agentJbLotDirectRoutes.js";
import {
  tryRunScopedBadBinDirectRoute,
  tryRunBinLotRankingDirectRoute,
  tryRunGoodBinValueDirectRoute,
  tryRunUnscopedBinClarifyDirectRoute,
  tryRunDeterministicJbSummary,
} from "../dispatch/directRoutes/agentJbBinDirectRoutes.js";
import {
  tryRunDutBinAggDirectRoute,
  tryRunDutBinAggAutoRoute,
  tryRunDutFocusBinsDirectRoute,
  tryRunDutFocusBinsAutoRoute,
  tryRunUnderperformingDutDirectRoute,
} from "../dispatch/directRoutes/agentDutAggDirectRoutes.js";
import {
  tryRunProbeCardPerfDirectRoute,
  tryRunDeterministicProbeCardPerfSummary,
} from "../dispatch/directRoutes/agentProbeCardDirectRoutes.js";
// ── Round 4 split: setup / prompt / tool-call / guard / finalize helpers ──────
import { prepareRunAgentLoopContext } from "./agentLoopSetup.js";
import { mergeStructuredWithEmbedded } from "./agentToolCallMerge.js";
import { selectToolSchemas } from "./agentToolSchemaSelect.js";
import { runTouchdownSummaryReply } from "./agentTouchdownReply.js";
import {
  getSummaryContext,
  buildRoundSystemPrompt,
  buildSummaryUserNudge,
  type SummaryContext,
} from "./agentRoundPrompt.js";
import { applySummaryRoundToolCallGuard } from "./agentSummaryGuard.js";
import { runPendingQueryFollowUp } from "./agentPendingQueryFollowUp.js";
import { finalizeStreamedTurn } from "./agentTurnFinalize.js";

export type AgentSseEvent =
  | { type: "text"; delta: string }
  | { type: "status"; message: string }
  | { type: "tool_start"; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; name: string; summary: string }
  | { type: "chart"; option: object }
  | { type: "clarification"; question: string; options?: string[] }
  | { type: "done" }
  | { type: "error"; message: string };

export async function runAgentLoop(
  message: string,
  sessionId: string,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void,
  options?: { resume?: boolean }
): Promise<void> {
  const { feedbackInjection, manifest } = await prepareRunAgentLoopContext(
    message,
    sessionId,
    agentConfig,
    emit,
    options
  );

  // 声明式有序直连调度表(范围 B / spec §4.2):取代原 5 条顺序 if。各 runner 内部 self-gate,
  // 顺序即优先级,与旧 if 链按构造等价(同序、同 runner、同门槛)。新增 pre-LLM 直连只需加进此数组。
  // 注:不按 detectJbReplyMode 的 mode 建表——mode 与 canRunXxx 门槛非 1:1(mode 更宽),
  // 按 mode 路由会把门槛不满足的问句误路由;有序 runner 列表才是真正等价的声明式形式。
  const PRE_LLM_DIRECT_ROUTES: Array<typeof tryRunLotListingDirectRoute> = [
    tryRunUnderperformingDutDirectRoute,
    tryRunGoodBinValueDirectRoute,
    tryRunProbeCardPerfDirectRoute,
    tryRunDutFocusBinsDirectRoute,
    tryRunDutBinAggDirectRoute,
    tryRunBinLotRankingDirectRoute,
    tryRunListingTimeClarifyDirectRoute,
    tryRunLotListingDirectRoute,
    tryRunScopedBadBinDirectRoute,
    tryRunMaskScopeDirectRoute,
    tryRunLotOverviewDirectRoute,
    tryRunEquipmentDirectRoute,
    tryRunPerSlotBinRankingDirectRoute,
    tryRunSemanticDispatchDirectRoute,
    tryRunUnscopedBinClarifyDirectRoute,
  ];

  const maxRounds = agentConfig.maxRounds;
  // 首轮"只承诺查询、未真正调用工具"时的一次性纠正重试标记(跨 round 迭代持久)。
  let announcementNudgeUsed = false;
  for (let round = 0; round < maxRounds; round++) {
    const history = getHistory(sessionId);
    const summary = getSummary(sessionId);
    const awaitingSummary = historyAwaitingToolSummary(history);
    const summaryCtx: SummaryContext = awaitingSummary ? getSummaryContext(history) : "jb";
    const userQuestion = lastUserMessageText(history, message);

    const lastTool = lastToolMessage(history);
    const waferPlan = planWaferMapRoute(
      sessionId,
      history,
      userQuestion,
      awaitingSummary ? "after_jb_bins" : "user_turn",
      lastTool?.name,
      lastTool ? String(lastTool.content ?? "") : undefined
    );

    if (awaitingSummary && lotListingNeedsJbRecovery(userQuestion, lastTool?.name, history)) {
      const listingRecovered = await tryRunLotListingDirectRoute(
        sessionId,
        userQuestion,
        agentConfig,
        emit
      );
      if (listingRecovered) return;
    }

    if (awaitingSummary && scopedBadBinNeedsAggregateRecovery(userQuestion, lastTool?.name, history)) {
      const binRecovered = await tryRunScopedBadBinDirectRoute(
        sessionId,
        userQuestion,
        agentConfig,
        emit
      );
      if (binRecovered) return;
    }

    if (awaitingSummary && lotOverviewNeedsJbRecovery(userQuestion, lastTool?.name)) {
      const recovered = await tryRunLotOverviewDirectRoute(
        sessionId,
        userQuestion,
        agentConfig,
        emit
      );
      if (recovered) return;
    }

    if (isTestItemMappingQuestion(userQuestion)) {
      const msg =
        "BIN 编号与测试项的对应关系存储在测试程序（test program）中，JB STAR / Yield Monitor 数据库不包含该映射，系统无法告知 BIN 对应的具体测试项名称。\n\n" +
        "如需了解，请在 Uflex / J750 测试机上查阅 Pattern/Flow 定义，或联系测试工程师获取对应产品的测试程序文档。";
      emitTextInChunks(msg, emit);
      appendMessages(sessionId, { role: "assistant", content: msg });
      emit({ type: "done" });
      return;
    }

    if (!awaitingSummary) {
      // DUT×BIN 关系图须先于 PRE_LLM（含 query_lot_dut_bin_agg），避免「画出关系图」被 lot 聚合劫持
      const dutBinDone = await tryRunDutBinMapDirectRoute(
        sessionId,
        userQuestion,
        emit,
        agentConfig
      );
      if (dutBinDone) return;

      // 有序直连调度:依次调用,首个返回 true 即结束;各 runner 内部 self-gate。
      // 等价于原 5 条顺序 if(同序、同 runner、同门槛)。范围 B / spec §4.2。
      for (const runDirectRoute of PRE_LLM_DIRECT_ROUTES) {
        if (await runDirectRoute(sessionId, userQuestion, agentConfig, emit)) return;
      }

      // lot+slot 已知但 device 未知 → 自动 query_jb_bins 取 device，不经 LLM
      if (waferPlan.isWaferMapIntent && waferPlan.action.kind === "need_jb_lookup") {
        const autoDrawn = await tryRunWaferMapWithAutoDeviceLookup(
          sessionId,
          userQuestion,
          agentConfig,
          emit
        );
        if (autoDrawn) return;
      }

      const drawn = await applyWaferMapRoutePlan(
        sessionId,
        waferPlan,
        history,
        emit
      );
      if (drawn) return;
    } else if (waferPlan.isWaferMapIntent) {
      const drawn = await applyWaferMapRoutePlan(
        sessionId,
        waferPlan,
        history,
        emit
      );
      if (drawn) return;
    } else if (awaitingSummary && userWantsDutBinRelationMap(userQuestion) && lastTool?.name === "query_jb_bins") {
      // Summary 轮：query_jb_bins 已完成，尝试直接画 DUT×BIN 关系图
      const dutBinDone = await tryRunDutBinMapDirectRoute(
        sessionId,
        userQuestion,
        emit,
        agentConfig
      );
      if (dutBinDone) return;
      // 无法画图（通常缺少片号）— 给出明确提示而非输出 JB 表
      const msg = "已查询 JB 数据。画 DUT×BIN 关系图还需要**片号（slot/waferId）**，如「第5片」或「slot=14」，以及 BIN 编号。请补充后重试。";
      emitTextInChunks(msg, emit);
      appendMessages(sessionId, { role: "assistant", content: msg });
      emit({ type: "done" });
      return;
    } else if (awaitingSummary && userWantsDutYieldChart(userQuestion) && lastTool?.name === "inf_site_stats") {
      // Summary 轮：inf_site_stats 已完成，直接生成 DUT 良率柱状图
      const chartDone = await tryRunDutYieldChartDirectRoute(sessionId, userQuestion, history, emit);
      if (chartDone) return;
    } else if (
      awaitingSummary &&
      isTouchdownQuestion(userQuestion) &&
      (lastTool?.name === "query_jb_bins" || lastTool?.name === "aggregate_jb_bins")
    ) {
      // Touchdown 问题：JB 数据已拿到 device/lot，但 touch 数据在 INF 文件中，需逐片调用
      await runTouchdownSummaryReply(sessionId, userQuestion, lastTool, emit);
      return;
    }

    if (awaitingSummary && !waferPlan.skipJbDeterministicSummary) {
      const pendingResult = await runPendingQueryFollowUp(
        sessionId,
        agentConfig,
        emit,
        userQuestion
      );
      if (pendingResult.shouldContinue) continue;

      // ── Specialised deterministic routes (formatted output + LLM commentary) ──
      // DUT 聚焦坏 BIN：query_inf_site_bin_by_dut(focusDut) 后直出排行表，避免 Top8 截断假阴性
      const dutFocusHandled = await tryRunDutFocusBinsAutoRoute(
        sessionId,
        userQuestion,
        agentConfig,
        emit
      );
      if (dutFocusHandled) return;

      // DUT×BIN 自动聚合路由：用户问"哪个 DUT 的 BIN X 最多"，query_jb_bins 已得到
      // device/lot，自动调 query_lot_dut_bin_agg，避免 LLM 在总结轮承诺查询却无法执行。
      const dutBinHandled = await tryRunDutBinAggAutoRoute(
        sessionId,
        userQuestion,
        agentConfig,
        emit
      );
      if (dutBinHandled) return;

      const probeCardPerfHandled = await tryRunDeterministicProbeCardPerfSummary(
        sessionId,
        userQuestion,
        agentConfig,
        emit
      );
      if (probeCardPerfHandled) return;

      const handled = await tryRunDeterministicJbSummary(
        sessionId,
        userQuestion,
        agentConfig,
        emit
      );
      if (handled) return;
    }

    const systemContent = buildRoundSystemPrompt(
      sessionId,
      history,
      userQuestion,
      manifest,
      feedbackInjection,
      awaitingSummary,
      waferPlan,
      summaryCtx,
      announcementNudgeUsed
    );

    const messages: ChatMessage[] = [
      { role: "system", content: systemContent },
      ...(summary
        ? [{ role: "system" as const, content: `【历史对话摘要】\n${summary}` }]
        : []),
      ...history,
    ];

    const dsFilter = createDeepSeekFilter(emit);
    const toolCalls: CollectedToolCall[] = [];
    let finishReason = "stop";
    let streamError: string | undefined;

    if (awaitingSummary) {
      emit({ type: "status", message: "正在生成分析结论…" });
    }

    // Summary round: do NOT send tool schemas. Sending schemas with tool_choice:"none"
    // causes some models (e.g. DeepSeek-V4-Pro) to still emit structured tool_calls,
    // which get blocked by the guard below and leave textBuffer empty → error.
    // Without schemas the model is forced to produce text.
    // Explicit format instruction as the final user-turn — DeepSeek-V4-Pro
    // responds more reliably to a user-role reminder than to system nudge alone.
    // Content varies by summaryCtx so the model knows the exact expected structure.

    // When tools returned empty/zero results, inject a natural-language fallback hint so
    // the LLM produces its own "no data found" explanation instead of returning nothing
    // and triggering a hardcoded server-side message.
    const emptyResultHint = isLastToolEmptyResult(lastTool)
      ? "\n\n【工具返回空结果】上述工具未查到任何记录。请直接用自然语言告知用户未找到数据，" +
        "分析可能原因（如筛选条件过窄、时间范围不含数据），并给出 1–2 条排查建议。" +
        "不要强制使用固定分节结构，不要编造数据。"
      : "";

    const summaryUserNudge = buildSummaryUserNudge(summaryCtx, emptyResultHint);
    await streamSiliconFlow(
      awaitingSummary
        ? {
            model: agentConfig.model,
            messages: [...messages, summaryUserNudge],
            // Summary round is text-only. Large-context models (128K max output) can
            // produce much longer analyses; 16384 gives room for multi-lot tables.
            // Smaller-context models get 4096 (≈3000 Chinese words), which is ample.
            max_tokens: agentConfig.largeContext ? 16384 : 4096,
          }
        : {
            model: agentConfig.model,
            messages,
            tools: selectToolSchemas(messages) as unknown as unknown[],
            tool_choice: "auto",
            // 8192 for tool rounds: model may emit long tool arguments or interleave
            // analysis text with tool calls.
            max_tokens: 8192,
          },
      agentConfig,
      (chunk) => {
        switch (chunk.type) {
          case "delta":
            // Route through DeepSeek token filter; it handles emit internally.
            dsFilter.push(chunk.text);
            break;
          case "tool_calls":
            toolCalls.push(...chunk.calls);
            break;
          case "finish":
            finishReason = chunk.reason;
            break;
          case "error":
            streamError = chunk.message;
            break;
        }
      }
    );

    // Flush any buffered text and collect any embedded DeepSeek tool calls.
    const embeddedCalls = dsFilter.finalize();
    const textBuffer = dsFilter.cleanText; // clean text (no tokens) for history

    if (embeddedCalls.length > 0 && !awaitingSummary) {
      // SiliconFlow / GLM / MiniMax may put calls in content; structured tool_calls
      // are often {} or truncated JSON — merge usable args from embedded markup.
      if (toolCalls.length === 0) {
        toolCalls.push(...embeddedCalls);
      } else {
        const merged = mergeStructuredWithEmbedded(toolCalls, embeddedCalls);
        toolCalls.length = 0;
        toolCalls.push(...merged);
      }
      finishReason = "tool_calls";
    }

    const guardResult = applySummaryRoundToolCallGuard(
      sessionId,
      userQuestion,
      emit,
      awaitingSummary,
      toolCalls,
      embeddedCalls,
      textBuffer,
      finishReason
    );
    finishReason = guardResult.finishReason;
    if (guardResult.shouldReturn) return;

    if (streamError) {
      if (textBuffer) {
        appendMessages(sessionId, { role: "assistant", content: textBuffer });
      }
      emit({ type: "error", message: streamError });
      return;
    }

    const finalizeOutcome = await finalizeStreamedTurn(
      sessionId,
      agentConfig,
      emit,
      round,
      maxRounds,
      userQuestion,
      awaitingSummary,
      announcementNudgeUsed,
      finishReason,
      toolCalls,
      textBuffer
    );
    announcementNudgeUsed = finalizeOutcome.announcementNudgeUsed;
    if (finalizeOutcome.action === "return") return;
    if (finalizeOutcome.action === "continue") continue;

    // Continue to next round — let user know LLM is processing tool results
    emit({ type: "status", message: "正在分析工具结果…" });
  }

  emit({
    type: "error",
    message: `已达到最大推理轮数（${maxRounds}轮），请精简问题后重试，或在设置中提高「最大推理轮数」`,
  });
}
