// pcr-ai-api/src/lib/agent/core/veroAgentLoopPrompt.ts
import { buildSystemPrompt } from "../prompt/agentPrompt.js";
import type { DataManifest } from "../agentManifest.js";
import type { ChatMessage } from "../agentHistory.js";
import { VERO_ACTION_PROTOCOL_INSTRUCTIONS, renderToolSchemasAsText } from "./veroAgentProtocol.js";
import { TOOL_SCHEMAS } from "./agentToolSchemas.js";
import { VERO_PROMPT_CHAR_BUDGET } from "./veroAgentLoopConfig.js";

export { VERO_PROMPT_CHAR_BUDGET };

/**
 * System prompt for one round of the Vero-driven generic loop: same domain
 * rules the SiliconFlow loop uses (buildSystemPrompt — BIN semantics, pass
 * mapping, etc., model-agnostic), plus the tool list rendered as text and
 * the JSON action protocol instructions (see veroAgentProtocol.ts).
 */
export function buildVeroRoundSystemPrompt(params: {
  manifest: DataManifest | undefined;
  feedbackInjection: string;
  isLastRound: boolean;
}): string {
  const domainRules = buildSystemPrompt(params.manifest, "general");
  const toolSchemasText = renderToolSchemasAsText(TOOL_SCHEMAS);
  const lastRoundNote = params.isLastRound
    ? "\n\n【最后一轮】这是本次对话允许的最后一轮，你必须返回 action:final 或 action:chat，禁止再返回 action:tool。"
    : "";
  return (
    [
      domainRules,
      params.feedbackInjection,
      "可用工具：\n" + toolSchemasText,
      VERO_ACTION_PROTOCOL_INSTRUCTIONS,
    ]
      .filter((s) => s && s.trim())
      .join("\n\n") + lastRoundNote
  );
}

/**
 * Even more forceful variant of the last-round prompt, used for the single
 * forced-final retry when the model still returned action:"tool" on the
 * actual last round despite buildVeroRoundSystemPrompt's isLastRound hint
 * (see runVeroAgentLoop). Cursor's real-network test found the model does
 * not reliably obey that hint alone (see
 * docs/HANDOFF_CURSOR_VERO_GENERIC_LOOP_TEST_RESULTS.md §3.6) — this is the
 * one additional nudge before the loop falls back to the deterministic
 * "已完成以下查询…" summary without ever executing the rejected tool.
 */
export function buildVeroForceFinalSystemPrompt(params: {
  manifest: DataManifest | undefined;
  feedbackInjection: string;
}): string {
  const base = buildVeroRoundSystemPrompt({ ...params, isLastRound: true });
  return (
    base +
    "\n\n【强制收尾】你刚才仍然试图调用工具，但轮次已经用尽，系统不会再执行任何工具调用。" +
    "现在必须且只能返回 {\"action\":\"final\",\"reply\":\"...\"} 或 {\"action\":\"chat\",\"reply\":\"...\"}，" +
    "基于已经拿到的数据给出简短结论；再返回 action:tool 会被直接丢弃，对用户没有任何帮助。"
  );
}

/**
 * Serialize recent history + rolling summary into plain text for a single
 * prompt string — Vero has no messages[] array, so the whole conversation
 * must be flattened into one string per round.
 */
export function serializeHistoryForVeroPrompt(
  history: ChatMessage[],
  summary: string | undefined
): string {
  const lines: string[] = [];
  if (summary) lines.push(`【历史对话摘要】\n${summary}`);
  for (const m of history) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      lines.push(`用户: ${String(m.content ?? "")}`);
    } else if (m.role === "assistant") {
      if (m.content) lines.push(`AI: ${String(m.content)}`);
      for (const tc of m.tool_calls ?? []) {
        lines.push(`AI 调用工具: ${tc.function.name}(${tc.function.arguments})`);
      }
    } else if (m.role === "tool") {
      lines.push(`工具[${m.name ?? "unknown"}]结果: ${String(m.content ?? "")}`);
    }
  }
  return lines.join("\n");
}

/**
 * True when system + history + latest question would exceed the 128K-safe
 * char budget (design doc §4.2). Callers should compress history and rebuild
 * the prompt before sending when this returns true.
 */
export function isVeroPromptOverBudget(promptText: string): boolean {
  return promptText.length > VERO_PROMPT_CHAR_BUDGET;
}
