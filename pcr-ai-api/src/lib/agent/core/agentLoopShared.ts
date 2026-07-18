// pcr-ai-api/src/lib/agent/core/agentLoopShared.ts — leaf utilities extracted from agentLoop.ts (Round 3, Task 1)
import type { ChatMessage } from "../agentHistory.js";
import {
  compactJbBinsForHistory,
  compactJbCacheForHistory,
} from "../jb/agentJbHistoryCompact.js";
import type { AgentSseEvent } from "./agentLoop.js";

export function lastToolMessage(history: ChatMessage[]): ChatMessage | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "tool") return history[i];
  }
  return undefined;
}

export function lastUserMessageText(
  history: ChatMessage[],
  fallback: string
): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === "user" && m.content?.trim()) {
      return String(m.content).trim();
    }
  }
  return fallback.trim();
}

export function emitTextInChunks(text: string, emit: (event: AgentSseEvent) => void): void {
  const size = 500;
  for (let i = 0; i < text.length; i += size) {
    emit({ type: "text", delta: text.slice(i, i + size) });
  }
}

/**
 * 从 streamSiliconFlow 错误消息提取人类可读摘要。
 * 支持 "HTTP 4xx: {json}" 格式（七牛云、SiliconFlow 等）。
 */
export function cleanStreamErrorMessage(raw: string): string {
  try {
    const m = raw.match(/^(HTTP \d+):\s*(\{[\s\S]*)/);
    if (m) {
      const prefix = m[1];
      const jsonStr = m[2]!;
      let msg: string | undefined;
      try {
        const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
        const errObj = parsed["error"] as Record<string, unknown> | undefined;
        msg =
          (typeof errObj?.["message"] === "string" ? errObj["message"] : undefined) ??
          (typeof parsed["message"] === "string" ? parsed["message"] : undefined);
      } catch {
        // 截断 JSON：用正则直接提取 message 值
        const mm = jsonStr.match(/"message"\s*:\s*"([^"]+)/);
        if (mm) msg = mm[1];
      }
      if (msg) {
        return `${prefix}: ${msg.slice(0, 80)}${msg.length > 80 ? "…" : ""}`;
      }
    }
  } catch { /* ignore */ }
  return raw.slice(0, 100);
}

export function toolResultForHistory(
  toolName: string,
  rawContent: string,
  maxHistoryChars: number,
  toolResultMaxChars?: number,
  jbCacheJson?: string
): string {
  if (toolName === "query_jb_bins") {
    const cap = Math.min(maxHistoryChars, toolResultMaxChars ?? maxHistoryChars);
    if (jbCacheJson?.trim()) {
      return compactJbCacheForHistory(jbCacheJson, cap);
    }
    return compactJbBinsForHistory(rawContent, cap);
  }
  return rawContent.slice(0, maxHistoryChars);
}
