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
