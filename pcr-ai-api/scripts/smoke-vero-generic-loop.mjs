/**
 * One-shot live smoke: Vero-driven generic agent loop (Dummy JB, real Vero call).
 *
 * Usage (from pcr-ai-api):
 *   npx tsx scripts/smoke-vero-generic-loop.mjs
 *
 * Reads WCHAT_ACCESS_TOKEN from .env via a tiny inline loader, or from process.env.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

function loadDotEnv() {
  const envPath = join(root, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const i = trimmed.indexOf("=");
    const key = trimmed.slice(0, i).trim();
    let value = trimmed.slice(i + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv();
process.env.INFCONTROL_LAYER_BINS_DUMMY = process.env.INFCONTROL_LAYER_BINS_DUMMY || "true";

const { getVeroBaseUrl, getVeroAccessToken } = await import("../src/lib/vero/veroSimpleAgent.ts");
const { runVeroAgentLoop } = await import("../src/lib/agent/core/veroAgentLoop.ts");

const tokenPreview = (getVeroAccessToken() || "").slice(0, 12) + "…";
console.log("=== Vero generic-loop smoke ===");
console.log("base:", getVeroBaseUrl());
console.log("token:", tokenPreview);

if (!getVeroAccessToken()) {
  console.error("FAIL: set WCHAT_ACCESS_TOKEN in .env or the environment");
  process.exit(1);
}

const stubConfig = {
  apiKey: "unused",
  apiBase: "http://example.invalid",
  model: "deepseek-ai/DeepSeek-V4-Flash",
  subAgentModel: "deepseek-ai/DeepSeek-V4-Flash",
  maxRounds: 5,
  streamTimeoutSec: 150,
  streamTimeoutMs: 150000,
  toolResultMaxChars: 12000,
  toolResultMaxHistoryChars: 8000,
  largeContext: false,
};

const events = [];
const q = "WA03P02G 最近的探针卡机台组合表现怎么样";
console.log("\n--- runVeroAgentLoop (real Vero, Dummy JB tool data) ---");
await runVeroAgentLoop(q, `smoke-vero-loop-${Date.now()}`, stubConfig, (e) => {
  events.push(e);
  if (e.type === "status") console.log("[status]", e.message);
  if (e.type === "tool_start") console.log("[tool_start]", e.name, e.args);
  if (e.type === "tool_result") console.log("[tool_result]", e.summary?.slice(0, 120));
  if (e.type === "error") console.log("[error]", e.message);
});

const text = events
  .filter((e) => e.type === "text")
  .map((e) => e.delta)
  .join("");
console.log("\ndone event:", events.some((e) => e.type === "done"));
console.log("text length:", text.length);
console.log("text preview:\n", text.slice(0, 1200));

if (!events.some((e) => e.type === "done")) {
  console.error("\nFAIL: loop did not complete with a done event");
  process.exit(1);
}
console.log("\nOK: Vero generic-loop smoke passed");
