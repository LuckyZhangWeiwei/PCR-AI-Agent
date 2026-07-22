// pcr-ai-api/src/lib/agent/core/veroAgentLoop.ts
import type { AgentConfig } from "../agentConfig.js";
import {
  getHistory,
  appendMessages,
  getSummary,
  storeSummary,
  popOldMessagesForSummarization,
  type ChatMessage,
} from "../agentHistory.js";
import { invokeVeroSimpleAgent } from "../../vero/veroSimpleAgent.js";
import { historyAwaitingToolSummary } from "./agentToolStatus.js";
import { lastUserMessageText, emitTextInChunks } from "./agentLoopShared.js";
import { chartToolFallbackMessage } from "./agentJbFallbackReply.js";
import type { AgentSseEvent } from "./agentLoop.js";
import {
  prepareRunVeroAgentLoopContext,
  summarizeHistoryViaVero,
  type VeroInvokeFn,
} from "./veroAgentLoopSetup.js";
import {
  buildVeroRoundSystemPrompt,
  serializeHistoryForVeroPrompt,
  isVeroPromptOverBudget,
} from "./veroAgentLoopPrompt.js";
import {
  parseVeroRoundDecision,
  type VeroRoundDecision,
  type VeroReplyDecision,
} from "./veroAgentProtocol.js";
import { executeVeroToolDecision } from "./veroAgentToolExecutor.js";

// PRE_LLM direct routes: same server-side, model-agnostic logic the old
// SiliconFlow loop uses. Extracted to a shared module (agentPreLlmDirectRoutes.ts)
// so this array can't drift out of sync with agentLoop.ts's copy. Deterministic
// JB/probe-card summary calls and the awaitingSummary-gated mid-loop recovery
// branches (wafer-map plan, touchdown, DUT×BIN map/yield chart) are NOT ported
// in this first version — see plan Task 6 / design doc §1.2.
import { PRE_LLM_DIRECT_ROUTES } from "./agentPreLlmDirectRoutes.js";

const MAX_VERO_ROUND_RETRIES = 1;

// A plain `decision.action === "final" || decision.action === "chat"` inline
// check does not narrow `decision` to `VeroToolDecision` in the following
// code under this codebase's tsconfig (verified: TS does not always combine
// two `||`-joined discriminant equality checks into an else-branch narrowing
// even with an explicit `else`) — a named type-guard function narrows
// reliably instead, with identical runtime semantics.
function isVeroReplyDecision(d: VeroRoundDecision): d is VeroReplyDecision {
  return d.action === "final" || d.action === "chat";
}

async function invokeVeroRoundWithRetry(
  invoke: VeroInvokeFn,
  prompt: string,
  systemPrompt: string
): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_VERO_ROUND_RETRIES; attempt++) {
    try {
      return await invoke(prompt, systemPrompt);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Distinct tool names that produced a (non-error) result in this session's history so far. */
function executedToolNames(history: ChatMessage[]): string[] {
  const names = new Set<string>();
  for (const m of history) {
    if (m.role === "tool" && m.name) names.add(m.name);
  }
  return [...names];
}

async function compactHistoryForBudget(sessionId: string, invoke: VeroInvokeFn): Promise<void> {
  const old = popOldMessagesForSummarization(sessionId);
  if (old.length === 0) return;
  const existing = getSummary(sessionId);
  const toSummarize = existing
    ? [{ role: "assistant" as const, content: `【已有摘要】\n${existing}` }, ...old]
    : old;
  const newSummary = await summarizeHistoryViaVero(toSummarize, invoke);
  if (newSummary) storeSummary(sessionId, newSummary);
}

/**
 * Vero-driven generic ReAct loop. Entered via agentLoop.ts's runAgentLoop()
 * when isVeroGenericLoopReady() is true. PRE_LLM_DIRECT_ROUTES / tool
 * execution / session history are reused from the SiliconFlow loop; only
 * "which tool to call next / when to finalize" is re-implemented against
 * Vero's simple-agent/invoke JSON protocol (veroAgentProtocol.ts).
 * See docs/superpowers/specs/2026-07-21-vero-generic-agent-loop-design.md.
 */
export async function runVeroAgentLoop(
  message: string,
  sessionId: string,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void,
  options?: { resume?: boolean },
  deps?: { invoke?: VeroInvokeFn }
): Promise<void> {
  const invoke: VeroInvokeFn = deps?.invoke ?? invokeVeroSimpleAgent;

  const { feedbackInjection, manifest } = await prepareRunVeroAgentLoopContext(
    message,
    sessionId,
    emit,
    invoke,
    options
  );

  const maxRounds = agentConfig.maxRounds;

  for (let round = 0; round < maxRounds; round++) {
    const history = getHistory(sessionId);
    const userQuestion = lastUserMessageText(history, message);

    // Mirrors agentLoop.ts: PRE_LLM_DIRECT_ROUTES only runs before any tool has
    // executed this turn. Without this gate, a tool result written into history
    // by an earlier round in this same turn can flip a route's own gating
    // (e.g. resolveJbListingScope inferring a device/card from history) from
    // false to true, hijacking the turn mid-analysis. See code review finding.
    if (!historyAwaitingToolSummary(history)) {
      let handledByDirectRoute = false;
      for (const runDirectRoute of PRE_LLM_DIRECT_ROUTES) {
        if (await runDirectRoute(sessionId, userQuestion, agentConfig, emit)) {
          handledByDirectRoute = true;
          break;
        }
      }
      if (handledByDirectRoute) return;
    }

    const isLastRound = round === maxRounds - 1;
    const systemPrompt = buildVeroRoundSystemPrompt({ manifest, feedbackInjection, isLastRound });
    let historyText = serializeHistoryForVeroPrompt(getHistory(sessionId), getSummary(sessionId));
    let promptText = `${systemPrompt}\n\n对话记录：\n${historyText}\n\n请给出下一步 action JSON。`;

    if (isVeroPromptOverBudget(promptText)) {
      emit({ type: "status", message: "正在压缩历史对话…" });
      await compactHistoryForBudget(sessionId, invoke);
      historyText = serializeHistoryForVeroPrompt(getHistory(sessionId), getSummary(sessionId));
      promptText = `${systemPrompt}\n\n对话记录：\n${historyText}\n\n请给出下一步 action JSON。`;
    }

    let raw: string;
    try {
      raw = await invokeVeroRoundWithRetry(invoke, promptText, systemPrompt);
    } catch (err) {
      emit({ type: "error", message: `Vero 调用失败: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }

    let decision: VeroRoundDecision;
    try {
      decision = parseVeroRoundDecision(raw);
    } catch (err) {
      emit({ type: "error", message: `Vero 返回内容无法解析: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }

    if (isVeroReplyDecision(decision)) {
      emitTextInChunks(decision.reply, emit);
      appendMessages(sessionId, { role: "assistant", content: decision.reply });
      emit({ type: "done" });
      return;
    }

    const outcome = await executeVeroToolDecision(sessionId, decision, agentConfig, emit, userQuestion);

    if (outcome === "clarification") {
      emit({ type: "done" });
      return;
    }
    if (outcome === "chart") {
      const lastMsg = getHistory(sessionId).at(-1);
      const note = lastMsg ? chartToolFallbackMessage(lastMsg) : "图表已生成，请查看上方。";
      appendMessages(sessionId, { role: "assistant", content: note });
      emit({ type: "text", delta: note });
      emit({ type: "done" });
      return;
    }

    emit({ type: "status", message: "正在分析工具结果…" });
  }

  // maxRounds exhausted without a "final"/"chat" decision. Per design doc §3.3:
  // if any tool already ran, summarize what data was gathered instead of
  // showing a bare error — don't fabricate a conclusion, just tell the user
  // what was queried and that they should retry/narrow the question.
  const ranTools = executedToolNames(getHistory(sessionId));
  if (ranTools.length > 0) {
    const note =
      `已完成以下查询：${ranTools.join("、")}，但未能在 ${maxRounds} 轮内给出最终结论。` +
      "请点击「重试」继续，或缩小查询范围后重新提问。";
    appendMessages(sessionId, { role: "assistant", content: note });
    emit({ type: "text", delta: note });
    emit({ type: "done" });
    return;
  }

  emit({
    type: "error",
    message: "已达最大轮数仍未得出结论，请缩小查询范围或点击「重试」。",
  });
}
