// pcr-ai-api/src/lib/agent/core/agentStream.ts
import https from "node:https";
import type { AgentConfig } from "../agentConfig.js";
import {
  repairToolCallGroupsForLlm,
  type ChatMessage,
} from "../agentHistory.js";
import { getConfig } from "../../runtimeConfig.js";
import {
  loadMaskingDictionary,
  createStreamUnmasker,
  type MaskingDictionary,
  type StreamUnmasker,
} from "../agentDataMasking.js";

export type StreamChunk =
  | { type: "delta"; text: string }
  | { type: "tool_calls"; calls: CollectedToolCall[] }
  | { type: "finish"; reason: string }
  | { type: "error"; message: string };

export interface CollectedToolCall {
  index: number;
  id: string;
  name: string;
  args: string; // accumulated JSON string
}

interface RawToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

const DEFAULT_STREAM_TIMEOUT_MS = 150_000;

function getStreamTimeoutMs(config: AgentConfig): number {
  if (Number.isFinite(config.streamTimeoutMs) && config.streamTimeoutMs > 0) {
    return config.streamTimeoutMs;
  }
  if (Number.isFinite(config.streamTimeoutSec) && config.streamTimeoutSec > 0) {
    return config.streamTimeoutSec * 1000;
  }
  return DEFAULT_STREAM_TIMEOUT_MS;
}

function accumulateToolCalls(
  collected: CollectedToolCall[],
  deltas: RawToolCallDelta[]
): void {
  for (const d of deltas) {
    const idx = d.index ?? 0;
    if (!collected[idx]) {
      collected[idx] = { index: idx, id: "", name: "", args: "" };
    }
    if (d.id) collected[idx].id = d.id;
    if (d.function?.name) collected[idx].name = d.function.name;
    if (d.function?.arguments) collected[idx].args += d.function.arguments;
  }
}

export interface LlmRequest {
  model: string;
  messages: unknown[];
  tools?: unknown[];
  tool_choice?: string;
  max_tokens?: number;
}

interface MaskableMessage {
  role?: string;
  content?: string | null;
  tool_calls?: { function?: { arguments?: string } }[];
  [key: string]: unknown;
}

/**
 * Replace real device values / "NXP" in every message's content and tool_calls
 * arguments with stable tokens. Never mutates the original message objects —
 * they may be the same references stored in server-side session history
 * (agentHistory.ts), which must stay unmasked at rest.
 */
export function maskRequestMessages(
  messages: unknown[],
  dict: MaskingDictionary
): unknown[] {
  return messages.map((raw) => {
    const m = raw as MaskableMessage;
    const next: MaskableMessage = { ...m };
    if (typeof m.content === "string") {
      next.content = dict.mask(m.content);
    }
    if (Array.isArray(m.tool_calls)) {
      next.tool_calls = m.tool_calls.map((tc) => {
        if (!tc?.function?.arguments) return tc;
        return {
          ...tc,
          function: { ...tc.function, arguments: dict.mask(tc.function.arguments) },
        };
      });
    }
    return next;
  });
}

export async function streamSiliconFlow(
  request: LlmRequest,
  config: AgentConfig,
  onChunk: (chunk: StreamChunk) => void
): Promise<void> {
  const maskingEnabled = getConfig().dataMaskingEnabled;
  const dict: MaskingDictionary | null = maskingEnabled
    ? await loadMaskingDictionary()
    : null;
  // MiniMax 等要求每条 tool 消息前必须有带匹配 tool_calls 的 assistant；
  // PRE_LLM 直连路由历史上常只写 tool，此处统一修补后再脱敏出站。
  const repairedMessages = repairToolCallGroupsForLlm(
    request.messages as ChatMessage[]
  );
  const outboundMessages = dict
    ? maskRequestMessages(repairedMessages, dict)
    : repairedMessages;

  return new Promise((resolve, reject) => {
    const timeoutMs = getStreamTimeoutMs(config);
    const body = JSON.stringify({
      ...request,
      messages: outboundMessages,
      stream: true,
      stream_options: { include_usage: true },
    });

    let url: URL;
    try {
      url = new URL(`${config.apiBase}/chat/completions`);
    } catch {
      reject(new Error(`Invalid apiBase: ${config.apiBase}`));
      return;
    }

    const options: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Length": String(Buffer.byteLength(body)),
      },
      rejectUnauthorized: false, // matches siliconflowChat.ts pattern
    };

    let settled = false;
    let timeoutId: NodeJS.Timeout | undefined;
    const unmasker: StreamUnmasker | null = dict ? createStreamUnmasker(dict) : null;

    const flushUnmaskTail = () => {
      if (!unmasker) return;
      const tail = unmasker.finalize();
      if (tail) onChunk({ type: "delta", text: tail });
    };

    const clearRequestTimeout = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
    };

    const timeoutMessage = `Request timeout after ${timeoutMs}ms`;
    const handleTimeout = () => {
      if (settled) return;
      settled = true;
      clearRequestTimeout();
      flushUnmaskTail();
      onChunk({ type: "error", message: timeoutMessage });
      req.destroy(new Error(timeoutMessage));
      resolve();
    };

    const req = https.request(options, (res) => {
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        let errBody = "";
        res.on("data", (c: Buffer) => { errBody += c.toString(); });
        res.on("end", () => {
          if (settled) return;
          settled = true;
          onChunk({
            type: "error",
            message: `HTTP ${res.statusCode}: ${errBody.slice(0, 200)}`,
          });
          resolve();
        });
        return;
      }

      const collected: CollectedToolCall[] = [];
      let buffer = "";
      let finishReason = "stop";

      res.on("data", (chunk: Buffer) => {
        // Idle timeout: reset while bytes keep flowing (avoids dying mid-stream).
        clearRequestTimeout();
        timeoutId = setTimeout(handleTimeout, timeoutMs);

        buffer += chunk.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;
          const data = trimmed.slice(6);
          if (data === "[DONE]") continue;

          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }

          const p = parsed as {
            choices?: {
              delta?: {
                content?: string;
                tool_calls?: RawToolCallDelta[];
              };
              finish_reason?: string | null;
            }[];
          };

          const choice = p.choices?.[0];
          if (!choice) continue;

          const delta = choice.delta as {
            content?: string;
            reasoning_content?: string;
            tool_calls?: RawToolCallDelta[];
          } | undefined;

          // Reasoning belongs in reasoning_content; never forward to UI text stream.
          if (typeof delta?.content === "string" && delta.content.length > 0) {
            const text = unmasker ? unmasker.push(delta.content) : delta.content;
            if (text) onChunk({ type: "delta", text });
          }

          const toolCallDeltas = choice.delta?.tool_calls;
          if (Array.isArray(toolCallDeltas) && toolCallDeltas.length > 0) {
            accumulateToolCalls(collected, toolCallDeltas);
          }

          if (choice.finish_reason) {
            finishReason = choice.finish_reason;
          }
        }
      });

      res.on("end", () => {
        if (settled) return;
        settled = true;
        clearRequestTimeout();
        flushUnmaskTail();
        if (collected.length > 0) {
          const calls = collected
            .filter(Boolean)
            .map((c) => (dict ? { ...c, args: dict.unmask(c.args) } : c));
          onChunk({ type: "tool_calls", calls });
        }
        onChunk({ type: "finish", reason: finishReason });
        resolve();
      });

      res.on("error", (err) => {
        if (settled) return;
        settled = true;
        flushUnmaskTail();
        onChunk({ type: "error", message: err.message });
        resolve();
      });
    });

    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearRequestTimeout();
      reject(err);
    });

    timeoutId = setTimeout(handleTimeout, timeoutMs);

    req.write(body);
    req.end();
  });
}
