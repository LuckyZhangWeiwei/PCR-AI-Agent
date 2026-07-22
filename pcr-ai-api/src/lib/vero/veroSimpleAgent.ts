// pcr-ai-api/src/lib/vero/veroSimpleAgent.ts
// Vero Studio Path B client: POST /api/simple-agent/invoke (Bearer token).
// Mirrors C:\Users\nxf83192\vero-agent-demo\agent-b.js — no MCP, no undici.

import https from "node:https";
import { URL } from "node:url";

const DEFAULT_VERO_BASE = "https://verostudio.sw.nxp.com";

export function isEnvTruthy(raw: string | undefined): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** Feature flag: only the probe-card×tester pilot uses Vero when true. */
export function isProbeCardVeroPilotEnabled(): boolean {
  return isEnvTruthy(process.env.AGENT_PROBE_CARD_VERO_PILOT);
}

export function getVeroAccessToken(): string {
  return (process.env.WCHAT_ACCESS_TOKEN ?? "").trim();
}

export function getVeroBaseUrl(): string {
  return (process.env.VERO_BASE_URL ?? DEFAULT_VERO_BASE).replace(/\/$/, "");
}

/** Pilot is usable only when flag is on and a bearer token is present. */
export function isProbeCardVeroPilotReady(): boolean {
  return isProbeCardVeroPilotEnabled() && getVeroAccessToken().length > 0;
}

function veroTlsInsecure(): boolean {
  if (isEnvTruthy(process.env.VERO_TLS_STRICT)) return false;
  const env = process.env.VERO_TLS_INSECURE?.trim();
  if (env !== undefined && env !== "") {
    return isEnvTruthy(env);
  }
  // Corp MITM default (same rationale as SiliconFlow); set VERO_TLS_STRICT=true to enforce.
  return true;
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

/**
 * Loose JSON parse: raw object, fenced ```json```, or first `{…}` slice.
 * Throws if nothing parses.
 */
export function parseJsonLoose(text: string): unknown {
  const raw = String(text || "").trim();
  try {
    return JSON.parse(raw);
  } catch {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) return JSON.parse(fenced[1]!.trim());
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(raw.slice(start, end + 1));
    }
    throw new Error(`LLM did not return JSON: ${raw.slice(0, 200)}`);
  }
}

async function postJsonHttps(
  urlStr: string,
  body: string,
  headers: Record<string, string>
): Promise<{ status: number; text: string }> {
  const u = new URL(urlStr);
  const insecure = veroTlsInsecure();
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        method: "POST",
        headers: {
          ...headers,
          "Content-Length": Buffer.byteLength(body),
        },
        rejectUnauthorized: !insecure,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) =>
          chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
        );
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/**
 * POST {VERO_BASE}/api/simple-agent/invoke
 * Response shape: `{ response: string }` (non-streaming — use for JSON extract).
 *
 * Uses node:https (not undici) so corp TLS inspection can set rejectUnauthorized=false.
 */
export async function invokeVeroSimpleAgent(
  prompt: string,
  systemPrompt: string,
  options?: { token?: string; baseUrl?: string }
): Promise<string> {
  const token = (options?.token ?? getVeroAccessToken()).trim();
  if (!token) {
    throw new Error("Missing WCHAT_ACCESS_TOKEN for Vero simple-agent");
  }
  const base = (options?.baseUrl ?? getVeroBaseUrl()).replace(/\/$/, "");
  const url = `${base}/api/simple-agent/invoke`;
  const body = JSON.stringify({ prompt, system_prompt: systemPrompt });
  const headers = authHeaders(token);

  const { status, text } = await postJsonHttps(url, body, headers);
  if (status < 200 || status >= 300) {
    throw new Error(`simple-agent failed (${status}): ${text.slice(0, 500)}`);
  }
  const data = JSON.parse(text) as { response?: unknown };
  return String(data.response ?? "");
}

export type VeroStreamTokenHandler = (token: string) => void;

/**
 * WChat streaming path (see wchat/c/268418 + vero-agent-demo/agent.js):
 *   1) POST /api/agent/chat → { conversation_id }
 *   2) GET  /api/conversations/{id}/stream (SSE) → token events
 *
 * Use for user-visible commentary. Extract/JSON stays on invokeVeroSimpleAgent.
 */
export async function streamVeroAgentChat(
  message: string,
  onToken: VeroStreamTokenHandler,
  options?: { token?: string; baseUrl?: string; conversationId?: number | null }
): Promise<{ conversationId: number; reply: string }> {
  const token = (options?.token ?? getVeroAccessToken()).trim();
  if (!token) {
    throw new Error("Missing WCHAT_ACCESS_TOKEN for Vero agent chat stream");
  }
  const base = (options?.baseUrl ?? getVeroBaseUrl()).replace(/\/$/, "");

  const startBody: Record<string, unknown> = { message };
  if (options?.conversationId != null) {
    startBody.conversation_id = options.conversationId;
  }
  const start = await postJsonHttps(
    `${base}/api/agent/chat`,
    JSON.stringify(startBody),
    authHeaders(token)
  );
  if (start.status < 200 || start.status >= 300) {
    throw new Error(
      `agent/chat failed (${start.status}): ${start.text.slice(0, 500)}`
    );
  }
  const meta = JSON.parse(start.text) as {
    conversation_id?: number | string;
  };
  const conversationId = Number(meta.conversation_id);
  if (!Number.isFinite(conversationId)) {
    throw new Error(`agent/chat missing conversation_id: ${start.text.slice(0, 200)}`);
  }

  const reply = await readVeroConversationSse(
    `${base}/api/conversations/${conversationId}/stream`,
    token,
    onToken
  );
  return { conversationId, reply };
}

/** Fold system instructions into a single user message (agent/chat has no system_prompt). */
export function buildVeroChatMessageWithSystem(
  systemPrompt: string,
  userPrompt: string
): string {
  return (
    `${systemPrompt.trim()}\n\n` +
    `---\n\n` +
    `${userPrompt.trim()}\n\n` +
    `重要：不要调用任何工具 / MCP；只输出最终中文正文。`
  );
}

async function readVeroConversationSse(
  urlStr: string,
  token: string,
  onToken: VeroStreamTokenHandler
): Promise<string> {
  const u = new URL(urlStr);
  const insecure = veroTlsInsecure();
  const parts: string[] = [];

  await new Promise<void>((resolve, reject) => {
    const req = https.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "text/event-stream",
        },
        rejectUnauthorized: !insecure,
      },
      (res) => {
        if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
          const chunks: Buffer[] = [];
          res.on("data", (c) =>
            chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
          );
          res.on("end", () => {
            reject(
              new Error(
                `conversation stream failed (${res.statusCode}): ${Buffer.concat(chunks).toString("utf8").slice(0, 500)}`
              )
            );
          });
          return;
        }

        let buffer = "";
        let settled = false;
        const finish = (err?: Error) => {
          if (settled) return;
          settled = true;
          if (err) reject(err);
          else resolve();
        };

        res.on("data", (chunk) => {
          buffer += Buffer.isBuffer(chunk)
            ? chunk.toString("utf8")
            : String(chunk);
          while (buffer.includes("\n\n")) {
            const idx = buffer.indexOf("\n\n");
            const rawEvent = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const dataLines = rawEvent
              .split(/\r?\n/)
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5));
            if (dataLines.length === 0) continue;
            let event: Record<string, unknown>;
            try {
              event = JSON.parse(dataLines.join("\n")) as Record<
                string,
                unknown
              >;
            } catch {
              continue;
            }
            const eventType = String(event.type ?? event.event ?? "");
            if (eventType === "token") {
              const content = String(event.content ?? "");
              if (content) {
                parts.push(content);
                onToken(content);
              }
            } else if (
              eventType === "done" ||
              eventType === "end" ||
              eventType === "error"
            ) {
              // Match vero-agent-demo/agent.js: ignore premature done before any
              // token (WChat may emit done after an empty/tool phase, then stream
              // the real reply). Only terminate once tokens started, or on error.
              if (eventType === "error") {
                const err =
                  event.error ?? event.content ?? JSON.stringify(event);
                finish(new Error(`stream error: ${String(err)}`));
                try {
                  res.destroy();
                } catch {
                  /* ignore */
                }
                return;
              }
              if (parts.length === 0) {
                continue;
              }
              finish();
              try {
                res.destroy();
              } catch {
                /* ignore */
              }
              return;
            }
          }
        });
        res.on("end", () => finish());
        res.on("error", (e) => finish(e));
      }
    );
    req.on("error", reject);
    req.end();
  });

  return parts.join("");
}
