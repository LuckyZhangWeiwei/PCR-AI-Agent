/**
 * One-shot live smoke: Vero WChat simple-agent + probe-card Path B (Dummy JB).
 *
 * Usage (from pcr-ai-api):
 *   npx tsx scripts/smoke-vero-probe-card-pilot.mjs
 *
 * Reads WCHAT_ACCESS_TOKEN / AGENT_PROBE_CARD_VERO_PILOT from .env via loadEnv if present,
 * or from process.env.
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
process.env.AGENT_PROBE_CARD_VERO_PILOT = "true";

const { invokeVeroSimpleAgent, parseJsonLoose, isProbeCardVeroPilotReady, getVeroBaseUrl } =
  await import("../src/lib/vero/veroSimpleAgent.ts");
const { tryRunProbeCardVeroPilot, PROBE_CARD_VERO_EXTRACT_SYSTEM } = await import(
  "../src/lib/agent/dispatch/directRoutes/agentProbeCardVeroPilot.ts"
);

const tokenPreview = (process.env.WCHAT_ACCESS_TOKEN || "").slice(0, 12) + "…";
console.log("=== Vero Path B smoke ===");
console.log("base:", getVeroBaseUrl());
console.log("token:", tokenPreview);
console.log("pilotReady:", isProbeCardVeroPilotReady());

if (!isProbeCardVeroPilotReady()) {
  console.error("FAIL: set AGENT_PROBE_CARD_VERO_PILOT=true and WCHAT_ACCESS_TOKEN");
  process.exit(1);
}

// 1) Raw WChat simple-agent ping
console.log("\n--- 1) simple-agent/invoke ping ---");
const ping = await invokeVeroSimpleAgent(
  "Reply with exactly: PONG",
  "You are a ping checker. Reply with only the word PONG."
);
console.log("ping response:", JSON.stringify(ping).slice(0, 200));

// 2) Extract JSON for probe-card question
console.log("\n--- 2) extract args ---");
const q = "WA03P02G 最好的探针卡和机台组合是哪个";
const extractRaw = await invokeVeroSimpleAgent(
  `Conversation so far:\n(empty)\n\nLatest user message:\n${q}\n\nExtract the next action JSON now.`,
  PROBE_CARD_VERO_EXTRACT_SYSTEM
);
console.log("extract raw:", extractRaw.slice(0, 400));
const decision = parseJsonLoose(extractRaw);
console.log("extract parsed:", JSON.stringify(decision, null, 2).slice(0, 500));

// 3) Full Path B pilot (Dummy tool + Vero commentary)
console.log("\n--- 3) full Path B pilot (Dummy) ---");
const events = [];
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

const ok = await tryRunProbeCardVeroPilot(
  `smoke-vero-${Date.now()}`,
  q,
  stubConfig,
  (e) => {
    events.push(e);
    if (e.type === "status") console.log("[status]", e.message);
    if (e.type === "tool_start") console.log("[tool_start]", e.name, e.args);
    if (e.type === "tool_result") console.log("[tool_result]", e.summary?.slice(0, 120));
    if (e.type === "error") console.log("[error]", e.message);
  }
);

const text = events
  .filter((e) => e.type === "text")
  .map((e) => e.delta)
  .join("");
console.log("\nhandled:", ok);
console.log("done event:", events.some((e) => e.type === "done"));
console.log("text length:", text.length);
console.log("text preview:\n", text.slice(0, 1200));
if (text.length > 1200) console.log("\n...[truncated]...\n", text.slice(-600));

if (!ok || !events.some((e) => e.type === "done")) {
  console.error("\nFAIL: pilot did not complete");
  process.exit(1);
}
console.log("\nOK: Vero WChat Path B smoke passed");
