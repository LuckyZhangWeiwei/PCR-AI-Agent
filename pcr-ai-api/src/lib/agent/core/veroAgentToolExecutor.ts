// pcr-ai-api/src/lib/agent/core/veroAgentToolExecutor.ts
import type { AgentConfig } from "../agentConfig.js";
import { getHistory, appendSyntheticToolTurn } from "../agentHistory.js";
import { runTool, type ChartSentinel, type ClarificationSentinel } from "../tools/agentToolHandlers.js";
import { validateAndFixToolArgs } from "../agentToolValidator.js";
import { storeJbQuerySessionCache } from "../jb/agentJbBinFormat.js";
import { toolStatusLabel } from "./agentToolStatus.js";
import { toolResultForHistory } from "./agentLoopShared.js";
import { tryEmitUnderperformingDutScatter } from "../tools/agentToolUnderperformingDutsRender.js";
import type { AgentSseEvent } from "./agentLoop.js";
import type { VeroToolDecision } from "./veroAgentProtocol.js";
import { VERO_TOOL_RESULT_MAX_HISTORY_CHARS } from "./veroAgentLoopConfig.js";

export type VeroToolExecutionOutcome = "chart" | "clarification" | "ok" | "error";

/**
 * Execute a single Vero-decided tool call, append the result to session
 * history (as a synthetic assistant tool_calls + tool turn — same shape the
 * old SiliconFlow loop's executeRoundToolCalls uses, via
 * appendSyntheticToolTurn), and emit the matching SSE events. Returns which
 * kind of outcome happened so the caller (veroAgentLoop.ts) can decide
 * whether to short-circuit (chart / clarification never loop back).
 */
export async function executeVeroToolDecision(
  sessionId: string,
  decision: VeroToolDecision,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void,
  userQuestion: string
): Promise<VeroToolExecutionOutcome> {
  const { args: fixedArgs, notes } = validateAndFixToolArgs(decision.tool, decision.args, userQuestion);
  if (notes.length > 0) {
    console.log(`[validator] ${decision.tool}: ${notes.join("; ")}`);
  }

  emit({ type: "tool_start", name: decision.tool, args: fixedArgs });
  emit({ type: "status", message: `正在${toolStatusLabel(decision.tool)}…` });

  let historyContent: string;
  let outcome: VeroToolExecutionOutcome = "ok";
  let jbCacheForHistory: string | undefined;

  try {
    const toolResult = await runTool(decision.tool, fixedArgs, {
      toolResultMaxChars: agentConfig.toolResultMaxChars,
      history: getHistory(sessionId),
      userText: userQuestion,
      onJbBinsWrapped: (wrapped) => {
        jbCacheForHistory = storeJbQuerySessionCache(sessionId, wrapped);
      },
      onUnderperformingDuts: (passes) => {
        tryEmitUnderperformingDutScatter(passes, emit);
      },
    });

    if (typeof toolResult === "object" && toolResult !== null && "__chartOption" in toolResult) {
      emit({ type: "chart", option: (toolResult as ChartSentinel).__chartOption });
      historyContent = "[图表已生成]";
      outcome = "chart";
    } else if (typeof toolResult === "object" && toolResult !== null && "__clarification" in toolResult) {
      const question = (toolResult as ClarificationSentinel).__clarification;
      const clarOptions = (toolResult as ClarificationSentinel).__clarification_options;
      emit({ type: "clarification", question, ...(clarOptions ? { options: clarOptions } : {}) });
      historyContent = `[已向用户提问：${question}]`;
      outcome = "clarification";
    } else {
      const rawContent = typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult);
      historyContent = toolResultForHistory(
        decision.tool,
        rawContent,
        VERO_TOOL_RESULT_MAX_HISTORY_CHARS,
        agentConfig.toolResultMaxChars,
        jbCacheForHistory
      );
    }
  } catch (err) {
    historyContent = `工具执行失败: ${err instanceof Error ? err.message : String(err)}`;
    outcome = "error";
  }

  emit({ type: "tool_result", name: decision.tool, summary: historyContent.slice(0, 200) });
  appendSyntheticToolTurn(sessionId, {
    name: decision.tool,
    args: fixedArgs,
    content: historyContent,
    toolCallId: `vero_${decision.tool}_${Date.now()}`,
  });

  return outcome;
}
