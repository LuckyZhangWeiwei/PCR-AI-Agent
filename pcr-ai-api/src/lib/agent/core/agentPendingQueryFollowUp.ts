// pcr-ai-api/src/lib/agent/core/agentPendingQueryFollowUp.ts — pending two-step query follow-up extracted from agentLoop.ts (Round 4)
import type { AgentConfig } from "../agentConfig.js";
import { getHistory, appendMessages } from "../agentHistory.js";
import { runTool } from "../tools/agentToolHandlers.js";
import { detectPendingQuery } from "../agentPendingQuery.js";
import { resolveJbToolPayload } from "../jb/agentJbPayloadResolve.js";
import { lastToolMessage } from "./agentLoopShared.js";
import type { AgentSseEvent } from "./agentLoop.js";

/**
 * General pending-query mechanism: when a two-step query reaches the summary
 * round without its second tool call having been executed (because the
 * summary round blocks tool calls), this detects the gap via
 * `detectPendingQuery` and executes the follow-up tool.
 *
 * The original inline block used a bare `continue;` on success to loop the
 * caller's `for` round back so the next iteration (still a summary round)
 * has complete data for a proper LLM summary. A `continue` inside this
 * helper would only affect a loop local to the helper (there is none), so
 * the signal is threaded back via `shouldContinue`, and the caller must
 * `continue` its round loop when it sees that.
 * Behavior-identical to the code inlined at this point in the loop before
 * this split.
 */
export async function runPendingQueryFollowUp(
  sessionId: string,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void,
  userQuestion: string
): Promise<{ shouldContinue: boolean }> {
  const lastTool = lastToolMessage(getHistory(sessionId));
  if (lastTool) {
    const jbPayload = resolveJbToolPayload(sessionId, String(lastTool.content ?? ""));
    const pending = detectPendingQuery(
      userQuestion,
      lastTool.name ?? "",
      jbPayload ?? {},
      getHistory(sessionId)
    );
    if (pending) {
      emit({ type: "status", message: pending.statusLabel });
      emit({ type: "tool_start", name: pending.toolName, args: pending.args });
      try {
        const toolResult = await runTool(pending.toolName, pending.args, {
          toolResultMaxChars: agentConfig.toolResultMaxChars,
          history: getHistory(sessionId),
        });
        const rawContent =
          typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult);
        emit({
          type: "tool_result",
          name: pending.toolName,
          summary: rawContent.slice(0, 200),
        });
        appendMessages(sessionId, {
          role: "tool",
          name: pending.toolName,
          tool_call_id: `pending_${Date.now()}`,
          content: rawContent.slice(0, agentConfig.toolResultMaxChars),
        });
        // History now has complete data; loop back so the next round
        // (still a summary round) has everything needed for a full answer.
        return { shouldContinue: true };
      } catch {
        // Pending query failed — fall through to deterministic routes / LLM summary
      }
    }
  }
  return { shouldContinue: false };
}
