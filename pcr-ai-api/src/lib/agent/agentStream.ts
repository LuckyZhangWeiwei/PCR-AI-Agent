// pcr-ai-api/src/lib/agent/agentStream.ts
import https from "node:https";
import type { AgentConfig } from "./agentConfig.js";

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

const DEFAULT_STREAM_TIMEOUT_MS = 270_000;

function getStreamTimeoutMs(): number {
  const raw = process.env.AGENT_STREAM_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_STREAM_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_STREAM_TIMEOUT_MS;
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
}

export function streamSiliconFlow(
  request: LlmRequest,
  config: AgentConfig,
  onChunk: (chunk: StreamChunk) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeoutMs = getStreamTimeoutMs();
    const body = JSON.stringify({
      ...request,
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

    const clearRequestTimeout = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
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

          const content = choice.delta?.content;
          if (typeof content === "string" && content.length > 0) {
            onChunk({ type: "delta", text: content });
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
        if (collected.length > 0) {
          onChunk({ type: "tool_calls", calls: collected.filter(Boolean) });
        }
        onChunk({ type: "finish", reason: finishReason });
        resolve();
      });

      res.on("error", (err) => {
        if (settled) return;
        settled = true;
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

    const timeoutMessage = `Request timeout after ${timeoutMs}ms`;
    const handleTimeout = () => {
      if (settled) return;
      settled = true;
      clearRequestTimeout();
      onChunk({ type: "error", message: timeoutMessage });
      req.destroy(new Error(timeoutMessage));
      resolve();
    };

    timeoutId = setTimeout(handleTimeout, timeoutMs);
    req.setTimeout(timeoutMs, handleTimeout);

    req.write(body);
    req.end();
  });
}
