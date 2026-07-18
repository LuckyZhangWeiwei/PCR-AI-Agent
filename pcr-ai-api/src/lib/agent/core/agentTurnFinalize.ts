// pcr-ai-api/src/lib/agent/core/agentTurnFinalize.ts — post-stream finish/fallback handling extracted from agentLoop.ts (Round 4)
import type { AgentConfig } from "../agentConfig.js";
import { getHistory, appendMessages, type ToolCall } from "../agentHistory.js";
import { questionHasIdentifiableToolScope } from "../dispatch/agentQuestionHeuristics.js";
import {
  buildFactSheetFromHistory,
  factCheckSummaryText,
} from "../agentFactChecker.js";
import { lastToolMessage } from "./agentLoopShared.js";
import { chartToolFallbackMessage, finishWithJbServerTablesFallback } from "./agentJbFallbackReply.js";
import { executeRoundToolCalls } from "./agentRoundToolExecutor.js";
import type { CollectedToolCall } from "./agentStream.js";
import type { AgentSseEvent } from "./agentLoop.js";

/**
 * Post-stream finish/fallback handling: decides what happens once the LLM
 * stream for this round has finished. Covers the "model only announced but
 * didn't actually call a tool" retry, the empty-textBuffer fallback paths
 * (generate_chart fallback / JB server-tables fallback / generic error),
 * the fact-check pass, appending the assistant turn to history, executing
 * any requested tool calls, the ask_clarification short-circuit, and the
 * generate_chart-only-round shortcut.
 *
 * The original inline code had several `return;` statements that exited
 * `runAgentLoop` entirely, and one `continue;` that skipped to the next
 * `for` iteration. Neither can be expressed directly inside a helper
 * function, so both are surfaced via the returned `action` field
 * (`"return" | "continue" | "proceed"`) for the caller to act on exactly as
 * the inlined code did. `announcementNudgeUsed` is a `let` in the caller
 * that persists across round iterations; since a primitive cannot be
 * mutated through a closure, its (possibly updated) value is threaded back
 * through the return value too, and the caller must reassign it.
 * Behavior-identical to the code inlined at this point in the loop before
 * this split.
 */
export async function finalizeStreamedTurn(
  sessionId: string,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void,
  round: number,
  maxRounds: number,
  userQuestion: string,
  awaitingSummary: boolean,
  announcementNudgeUsedIn: boolean,
  finishReason: string,
  toolCalls: CollectedToolCall[],
  textBuffer: string
): Promise<{
  action: "return" | "continue" | "proceed";
  announcementNudgeUsed: boolean;
}> {
  let announcementNudgeUsed = announcementNudgeUsedIn;

  if (finishReason !== "tool_calls" || toolCalls.length === 0) {
    // 首轮模型只承诺"马上查"却未真正调用工具(见 prompt/agentPrompt.ts 硬规则)——
    // 代码兜底重试一次:不落盘这条未完成的文字,加强系统提示后重新请求,而不是把
    // "确认性文字"当成最终答案直接结束整轮对话。
    if (
      !awaitingSummary &&
      !announcementNudgeUsed &&
      round < maxRounds - 1 &&
      questionHasIdentifiableToolScope(userQuestion)
    ) {
      announcementNudgeUsed = true;
      emit({ type: "status", message: "检测到尚未真正查询，正在重新调用工具…" });
      return { action: "continue", announcementNudgeUsed };
    }
    if (awaitingSummary && !textBuffer.trim()) {
      const lastTool = lastToolMessage(getHistory(sessionId));
      if (lastTool?.name === "generate_chart") {
        const note = chartToolFallbackMessage(lastTool);
        appendMessages(sessionId, { role: "assistant", content: note });
        emit({ type: "text", delta: note });
        emit({ type: "done" });
        return { action: "return", announcementNudgeUsed };
      }
      if (finishWithJbServerTablesFallback(sessionId, userQuestion, emit)) {
        return { action: "return", announcementNudgeUsed };
      }
      emit({
        type: "error",
        message:
          "模型未返回分析结论（工具数据已在上方）。请点「重试」，或缩小查询范围后重新提问。",
      });
      return { action: "return", announcementNudgeUsed };
    }
    // Fact check: verify the LLM's conclusion against tool-result data (summary round only).
    // Log mismatches server-side only — the text is already streamed to the client, and
    // appending a visible correction note confuses users (they see contradictory text).
    if (awaitingSummary && textBuffer.trim()) {
      const facts = buildFactSheetFromHistory(getHistory(sessionId));
      const checkResult = factCheckSummaryText(textBuffer, facts);
      if (!checkResult.ok) {
        console.warn(`[factchecker/${sessionId}] ${checkResult.issue}`);
      }
    }
    appendMessages(sessionId, { role: "assistant", content: textBuffer });
    emit({ type: "done" });
    return { action: "return", announcementNudgeUsed };
  }

  // Record assistant turn with tool_calls
  const assistantToolCalls: ToolCall[] = toolCalls.map((tc) => ({
    id: tc.id || `call_${round}_${tc.index}`,
    type: "function",
    function: { name: tc.name, arguments: tc.args },
  }));
  appendMessages(sessionId, {
    role: "assistant",
    content: textBuffer || null,
    tool_calls: assistantToolCalls,
  });

  await executeRoundToolCalls(
    sessionId,
    agentConfig,
    emit,
    toolCalls,
    assistantToolCalls,
    round,
    userQuestion
  );

  // If agent asked for clarification, stop this round and wait for user reply
  const askedClarification = toolCalls.some((tc) => tc.name === "ask_clarification");
  if (askedClarification) {
    emit({ type: "done" });
    return { action: "return", announcementNudgeUsed };
  }

  // generate_chart: chart is already shown via SSE — GLM often returns empty on the
  // follow-up summary round; skip that round and close with a short confirmation.
  const onlyGenerateChart =
    toolCalls.length > 0 && toolCalls.every((tc) => tc.name === "generate_chart");
  if (onlyGenerateChart) {
    const lastTool = lastToolMessage(getHistory(sessionId));
    if (lastTool?.name === "generate_chart") {
      const note = chartToolFallbackMessage(lastTool);
      appendMessages(sessionId, { role: "assistant", content: note });
      emit({ type: "text", delta: note });
      emit({ type: "done" });
      return { action: "return", announcementNudgeUsed };
    }
  }

  return { action: "proceed", announcementNudgeUsed };
}
