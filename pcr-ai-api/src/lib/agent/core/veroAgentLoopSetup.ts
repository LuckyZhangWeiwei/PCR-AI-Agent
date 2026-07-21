import {
  appendMessages,
  needsSummarization,
  popOldMessagesForSummarization,
  storeSummary,
  getSummary,
  type ChatMessage,
} from "../agentHistory.js";
import { fetchOrCacheManifest, type DataManifest } from "../agentManifest.js";
import { buildFeedbackInjection } from "../agentFeedback.js";
import type { AgentSseEvent } from "./agentLoop.js";
import { VERO_SUMMARIZE_THRESHOLD } from "./veroAgentLoopConfig.js";

export type VeroInvokeFn = (prompt: string, systemPrompt: string) => Promise<string>;

/**
 * Calls Vero to produce a compact Chinese summary of older conversation
 * turns. Mirrors agentLoopSetup.ts's summarizeHistory but goes through Vero
 * instead of streamSiliconFlow — the Vero loop must not depend on
 * SiliconFlow at all. Best-effort: returns "" on failure so a summarization
 * hiccup never blocks the turn.
 */
export async function summarizeHistoryViaVero(
  oldMessages: ChatMessage[],
  invoke: VeroInvokeFn
): Promise<string> {
  const lines: string[] = [];
  for (const m of oldMessages) {
    if (!m.content || m.role === "tool") continue;
    const label = m.role === "user" ? "用户" : "AI";
    lines.push(`[${label}]: ${String(m.content).slice(0, 600)}`);
  }
  if (lines.length === 0) return "";

  const prompt =
    "请将以下探针卡良率分析系统的历史对话压缩为简洁的中文摘要（不超过400字）。\n" +
    "【必须保留，不可省略】：\n" +
    "  - 所有出现过的 device 产品代码（如 WA03P02G）\n" +
    "  - 所有出现过的 lot ID（含完整后缀，如 NF12592.1Y）\n" +
    "  - 所有出现过的 slot / wafer 槽位号\n" +
    "  - 所有出现过的探针卡号（如 7747-03）\n" +
    "  - 关键数字结论、已确认的异常发现、当前分析方向\n" +
    "【格式】先列出「查询上下文：device=X, lot=X, slot=X」，再写分析摘要。\n" +
    "禁止使用 Markdown 图片语法。\n\n对话历史：\n" +
    lines.join("\n");

  try {
    const summary = await invoke(prompt, "你是对话历史压缩助手，只输出摘要正文，不要额外解释。");
    return summary.trim();
  } catch {
    return "";
  }
}

/**
 * Pre-loop setup for runVeroAgentLoop: record the user turn, roll up old
 * history into a Vero-generated summary when the Vero-calibrated threshold
 * is exceeded, and fetch the API manifest (timeout-capped). Mirrors
 * agentLoopSetup.ts's prepareRunAgentLoopContext but never touches
 * SiliconFlow.
 */
export async function prepareRunVeroAgentLoopContext(
  message: string,
  sessionId: string,
  emit: (event: AgentSseEvent) => void,
  invoke: VeroInvokeFn,
  options?: { resume?: boolean }
): Promise<{ feedbackInjection: string; manifest: DataManifest | undefined }> {
  const feedbackInjection = await buildFeedbackInjection(message).catch(() => "");

  if (!options?.resume) {
    appendMessages(sessionId, { role: "user", content: message });
  }

  if (needsSummarization(sessionId, VERO_SUMMARIZE_THRESHOLD)) {
    const old = popOldMessagesForSummarization(sessionId);
    if (old.length > 0) {
      emit({ type: "status", message: "正在压缩历史对话…" });
      const existing = getSummary(sessionId);
      const toSummarize: ChatMessage[] = existing
        ? [{ role: "assistant", content: `【已有摘要】\n${existing}` }, ...old]
        : old;
      const newSummary = await summarizeHistoryViaVero(toSummarize, invoke);
      if (newSummary) storeSummary(sessionId, newSummary);
    }
  }

  emit({ type: "status", message: "正在准备系统信息…" });
  const manifest = await Promise.race([
    fetchOrCacheManifest(),
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 5000)),
  ]).catch(() => undefined);

  return { feedbackInjection, manifest };
}
