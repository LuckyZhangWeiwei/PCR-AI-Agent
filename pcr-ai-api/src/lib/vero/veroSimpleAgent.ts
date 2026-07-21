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

/** Feature flag: the generic ReAct loop (all free-form questions, not just
 * probe-card×tester) uses Vero when true — see docs/superpowers/specs/
 * 2026-07-21-vero-generic-agent-loop-design.md. */
export function isVeroGenericLoopEnabled(): boolean {
  return isEnvTruthy(process.env.AGENT_VERO_GENERIC_LOOP);
}

/** Generic loop is usable only when flag is on and a bearer token is present. */
export function isVeroGenericLoopReady(): boolean {
  return isVeroGenericLoopEnabled() && getVeroAccessToken().length > 0;
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
 * Response shape: `{ response: string }`
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
