// pcr-ai-api/src/lib/agent/core/agentRoundToolExecutor.ts — round tool-call execution extracted from agentLoop.ts (Round 4)
import type { AgentConfig } from "../agentConfig.js";
import { getHistory, appendMessages, type ToolCall } from "../agentHistory.js";
import { runTool, type ChartSentinel, type ClarificationSentinel } from "../tools/agentToolHandlers.js";
import { validateAndFixToolArgs } from "../agentToolValidator.js";
import { storeJbQuerySessionCache } from "../jb/agentJbBinFormat.js";
import { toolStatusLabel } from "./agentToolStatus.js";
import { toolResultForHistory } from "./agentLoopShared.js";
import { tryEmitUnderperformingDutScatter } from "../tools/agentToolUnderperformingDutsRender.js";
import type { CollectedToolCall } from "./agentStream.js";
import type { AgentSseEvent } from "./agentLoop.js";

// ── Tool resource group for parallel execution ─────────────────────────────
// Tools in the same group share a connection pool and must run sequentially.
// Tools in different groups have independent I/O and can run concurrently.
// "probeweb" and "main" are separate Oracle pools — safe to run in parallel.
// "perl" tools invoke Perl scripts and have no Oracle dependency.
// "pure" tools (generate_chart, ask_clarification) do only in-process work.
type ToolResourceGroup = "probeweb" | "main" | "perl" | "pure";

function getToolResourceGroup(name: string): ToolResourceGroup {
  if (name === "query_yield_triggers" || name === "aggregate_yield_triggers") {
    return "probeweb";
  }
  if (
    name === "query_jb_bins" ||
    name === "aggregate_jb_bins" ||
    name === "get_filter_values"
  ) {
    return "main";
  }
  if (name === "generate_chart" || name === "ask_clarification") {
    return "pure";
  }
  // query_lot_dut_bin_agg, query_inf_site_bin_by_dut, inf_* — Perl / file I/O
  return "perl";
}

/**
 * Execute one round's tool calls, then append their results to history.
 * Same-pool tools run sequentially; cross-pool tools run concurrently.
 * SSE events (tool_start / tool_result / chart / clarification) are emitted as each
 * tool completes; tool messages are appended in original tool_calls order afterward so
 * the next LLM round sees a consistent sequence regardless of execution order.
 *
 * Parallelism is safe because:
 *   • "probeweb" (withProbeWebConnection) and "main" (withConnection) are
 *     independent Oracle pools — concurrent use does not exceed per-pool limits.
 *   • "perl" tools invoke Perl scripts with no Oracle dependency.
 *   • "pure" tools (generate_chart, ask_clarification) are in-process only.
 *   Tools within the same group always run sequentially (pool constraint).
 * Behavior-identical to the inline tool-execution phase it replaces.
 */
export async function executeRoundToolCalls(
  sessionId: string,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void,
  toolCalls: CollectedToolCall[],
  assistantToolCalls: ToolCall[],
  round: number,
  userQuestion: string
): Promise<void> {
  type ToolRunResult = { historyContent: string; callId: string; toolName: string };
  const toolRunResults: ToolRunResult[] = new Array(toolCalls.length);

  type ToolSlot = {
    tc: CollectedToolCall;
    tcIdx: number;
    parsedArgs: Record<string, unknown>;
    callId: string;
  };
  const resourceGroups = new Map<ToolResourceGroup, ToolSlot[]>();
  for (let tcIdx = 0; tcIdx < toolCalls.length; tcIdx++) {
    const tc = toolCalls[tcIdx];
    let parsedArgs: Record<string, unknown> = {};
    try {
      parsedArgs = JSON.parse(tc.args || "{}") as Record<string, unknown>;
    } catch {
      parsedArgs = {};
    }
    const callId = assistantToolCalls[tcIdx]?.id ?? `call_${round}_${tc.index}`;
    const group = getToolResourceGroup(tc.name);
    if (!resourceGroups.has(group)) resourceGroups.set(group, []);
    resourceGroups.get(group)!.push({ tc, tcIdx, parsedArgs, callId });
  }

  await Promise.all(
    Array.from(resourceGroups.values()).map(async (slots) => {
      for (const { tc, tcIdx, parsedArgs, callId } of slots) {
        // Auto-correct known arg mistakes before execution (prefer rules here
        // over prompt rules — see agentToolValidator.ts for the rationale).
        const { args: fixedArgs, notes: validatorNotes } = validateAndFixToolArgs(
          tc.name, parsedArgs, userQuestion
        );
        if (validatorNotes.length > 0) {
          // Transparently log what was fixed; parsedArgs in tool_start shows the FIXED args
          // so the LLM history reflects what was actually executed.
          console.log(`[validator] ${tc.name}: ${validatorNotes.join("; ")}`);
        }

        emit({ type: "tool_start", name: tc.name, args: fixedArgs });
        emit({ type: "status", message: `正在${toolStatusLabel(tc.name)}…` });

        let historyContent: string;
        let jbCacheForHistory: string | undefined;
        try {
          const toolResult = await runTool(tc.name, fixedArgs, {
            toolResultMaxChars: agentConfig.toolResultMaxChars,
            history: getHistory(sessionId),
            onJbBinsWrapped: (wrapped) => {
              jbCacheForHistory = storeJbQuerySessionCache(sessionId, wrapped);
            },
            onUnderperformingDuts: (passes) => {
              tryEmitUnderperformingDutScatter(passes, emit);
            },
          });
          if (
            typeof toolResult === "object" &&
            toolResult !== null &&
            "__chartOption" in toolResult
          ) {
            emit({ type: "chart", option: (toolResult as ChartSentinel).__chartOption });
            historyContent = "[图表已生成]";
          } else if (
            typeof toolResult === "object" &&
            toolResult !== null &&
            "__clarification" in toolResult
          ) {
            const question = (toolResult as ClarificationSentinel).__clarification;
            const clarOptions = (toolResult as ClarificationSentinel).__clarification_options;
            emit({ type: "clarification", question, ...(clarOptions ? { options: clarOptions } : {}) });
            historyContent = `[已向用户提问：${question}]`;
          } else {
            const rawContent =
              typeof toolResult === "string"
                ? toolResult
                : JSON.stringify(toolResult);
            historyContent = toolResultForHistory(
              tc.name,
              rawContent,
              agentConfig.toolResultMaxHistoryChars,
              agentConfig.toolResultMaxChars,
              jbCacheForHistory
            );
          }
        } catch (err) {
          historyContent = `工具执行失败: ${err instanceof Error ? err.message : String(err)}`;
        }

        emit({ type: "tool_result", name: tc.name, summary: historyContent.slice(0, 200) });
        toolRunResults[tcIdx] = { historyContent, callId, toolName: tc.name };
      }
    })
  );

  // Append tool messages in original order (tool_call_id must align with
  // the assistant's tool_calls sequence for all LLM providers)
  for (const result of toolRunResults) {
    appendMessages(sessionId, {
      role: "tool",
      tool_call_id: result.callId,
      name: result.toolName,
      content: result.historyContent,
    });
  }
}
