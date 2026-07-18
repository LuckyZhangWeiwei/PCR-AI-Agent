// pcr-ai-api/src/lib/agent/core/agentSummaryGuard.ts — summary-round tool-call guard extracted from agentLoop.ts (Round 4)
import type { CollectedToolCall } from "./agentStream.js";
import { finishWithJbServerTablesFallback } from "./agentJbFallbackReply.js";
import type { AgentSseEvent } from "./agentLoop.js";

/**
 * Summary-round guard: after data tools run, the model must produce text OR
 * call a conclusion tool (generate_chart / ask_clarification). Data-fetch
 * tools are blocked to prevent infinite loops; conclusion tools are
 * explicitly allowed.
 *
 * Bug A — embedded data-fetch calls: model produced "让我再查一下…" text
 *   + an embedded tool call. Silently emitting that as `done` misleads user.
 * Bug B — structured data-fetch tool_calls: providers sometimes emit these
 *   even without a tool schema, consuming rounds until maxRounds is reached.
 *
 * `toolCalls` is mutated in place (same array reference) to mirror the
 * original inline splice/push semantics. `finishReason` cannot be mutated
 * through a closure (primitive `let` in the caller), so it is threaded
 * through the return value instead. The original inline block used a bare
 * `return;` to exit `runAgentLoop` entirely in two places — since a `return`
 * inside this helper would only exit the helper, those spots are converted
 * to `shouldReturn: true`, and the caller must `return` when it sees that.
 * Behavior-identical to the code inlined at this point in the loop before
 * this split.
 */
export function applySummaryRoundToolCallGuard(
  sessionId: string,
  userQuestion: string,
  emit: (event: AgentSseEvent) => void,
  awaitingSummary: boolean,
  toolCalls: CollectedToolCall[],
  embeddedCalls: CollectedToolCall[],
  textBuffer: string,
  finishReason: string
): { finishReason: string; shouldReturn: boolean } {
  if (!awaitingSummary) {
    return { finishReason, shouldReturn: false };
  }

  // generate_chart and ask_clarification are legitimate conclusion steps.
  const isConclusionTool = (name: string) =>
    name === "generate_chart" || name === "ask_clarification";

  // Structured tool_calls: keep only conclusion tools, discard data tools.
  if (toolCalls.length > 0) {
    const kept = toolCalls.filter((tc) => isConclusionTool(tc.name));
    toolCalls.splice(0, toolCalls.length, ...kept);
    if (toolCalls.length > 0) finishReason = "tool_calls";
  }

  // Embedded calls: conclusion tools → merge; data tools → handle below.
  if (embeddedCalls.length > 0) {
    const allowedEmb = embeddedCalls.filter((ec) => isConclusionTool(ec.name));
    const blockedEmb = embeddedCalls.filter((ec) => !isConclusionTool(ec.name));

    if (allowedEmb.length > 0 && toolCalls.length === 0) {
      // generate_chart / ask_clarification embedded → merge and execute.
      toolCalls.push(...allowedEmb);
      finishReason = "tool_calls";
    } else if (blockedEmb.length > 0 && allowedEmb.length === 0) {
      // Data-fetch embedded call in summary round.
      if (!textBuffer.trim()) {
        if (finishWithJbServerTablesFallback(sessionId, userQuestion, emit)) {
          return { finishReason, shouldReturn: true };
        }
        emit({
          type: "error",
          message:
            "模型未返回分析结论（工具数据已在上方）。请点「重试」，或缩小查询范围后重新提问。",
        });
        return { finishReason, shouldReturn: true };
      }
      // Has partial text (e.g. "JB 数据为空，让我换个方式：") → emit it as
      // the answer rather than erroring; the blocked call is discarded.
      // Fall through to the normal text-output path below.
    }
  }

  return { finishReason, shouldReturn: false };
}
