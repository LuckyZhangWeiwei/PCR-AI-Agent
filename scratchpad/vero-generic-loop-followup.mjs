/**
 * Follow-ups: 3.6 maxRounds exhaustion + 3.5 larger prompts.
 */
import { readFileSync, existsSync, writeFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiRoot = join(__dirname, "..", "pcr-ai-api");

function loadDotEnv() {
  const envPath = join(apiRoot, ".env");
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
process.env.INFCONTROL_LAYER_BINS_DUMMY = "true";
process.env.YIELD_MONITOR_TRIGGERS_DUMMY = "true";

const { invokeVeroSimpleAgent } = await import(
  "../pcr-ai-api/src/lib/vero/veroSimpleAgent.ts"
);
const { runVeroAgentLoop } = await import(
  "../pcr-ai-api/src/lib/agent/core/veroAgentLoop.ts"
);
const { parseVeroRoundDecision } = await import(
  "../pcr-ai-api/src/lib/agent/core/veroAgentProtocol.ts"
);
const { VERO_PROMPT_CHAR_BUDGET } = await import(
  "../pcr-ai-api/src/lib/agent/core/veroAgentLoopConfig.ts"
);

console.log("VERO_PROMPT_CHAR_BUDGET =", VERO_PROMPT_CHAR_BUDGET);

function stubConfig(overrides = {}) {
  return {
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
    ...overrides,
  };
}

async function runQuestion(label, question, configOverrides = {}) {
  console.log(`\n========== ${label} ==========`);
  console.log("Q:", question);
  const veroCalls = [];
  const events = [];
  const promptSizes = [];

  const wrappedInvoke = async (prompt, systemPrompt) => {
    const promptChars = String(prompt || "").length;
    promptSizes.push(promptChars);
    console.log(`[vero#${veroCalls.length + 1}] promptChars=${promptChars}`);
    const started = Date.now();
    const raw = await invokeVeroSimpleAgent(prompt, systemPrompt);
    const ms = Date.now() - started;
    let decisionSummary = "?";
    let isLastRoundHint = false;
    try {
      const d = parseVeroRoundDecision(raw);
      decisionSummary =
        d.action === "tool"
          ? `tool:${d.tool}`
          : `${d.action}:replyLen=${d.reply?.length ?? 0}`;
    } catch (e) {
      decisionSummary = `FAIL:${e instanceof Error ? e.message : String(e)}`;
    }
    // detect last-round instruction presence in system prompt
    isLastRoundHint = /最后一轮|必须返回.*final|action:\s*"?final"?/i.test(
      String(systemPrompt)
    );
    veroCalls.push({ ms, decisionSummary, isLastRoundHint, promptChars });
    console.log(
      `[vero#${veroCalls.length}] ${ms}ms → ${decisionSummary} lastRoundHint=${isLastRoundHint}`
    );
    console.log(`[vero#${veroCalls.length}] rawPreview:`, String(raw).slice(0, 280).replace(/\n/g, "\\n"));
    return raw;
  };

  const t0 = Date.now();
  await runVeroAgentLoop(
    question,
    `live-followup-${label}-${Date.now()}`,
    stubConfig(configOverrides),
    (e) => {
      events.push(e);
      if (e.type === "status") console.log("[status]", e.message);
      if (e.type === "tool_start") console.log("[tool_start]", e.name, e.args);
      if (e.type === "tool_result")
        console.log("[tool_result]", String(e.summary ?? "").slice(0, 140));
      if (e.type === "error") console.log("[error]", e.message);
      if (e.type === "text") console.log("[text]", String(e.delta ?? "").slice(0, 200));
    },
    undefined,
    { invoke: wrappedInvoke }
  );

  const text = events
    .filter((e) => e.type === "text")
    .map((e) => e.delta)
    .join("");
  const tools = events.filter((e) => e.type === "tool_start").map((e) => e.name);
  const compressed = events.some(
    (e) => e.type === "status" && String(e.message).includes("正在压缩历史对话")
  );
  const fallback = /未能在 \d+ 轮内给出最终结论/.test(text);
  const row = {
    label,
    question,
    elapsedMs: Date.now() - t0,
    veroCallCount: veroCalls.length,
    veroDecisions: veroCalls.map((c) => c.decisionSummary),
    lastRoundHints: veroCalls.map((c) => c.isLastRoundHint),
    tools,
    compressed,
    maxPromptChars: promptSizes.length ? Math.max(...promptSizes) : 0,
    budget: VERO_PROMPT_CHAR_BUDGET,
    text,
    fallbackExhausted: fallback,
    done: events.some((e) => e.type === "done"),
  };
  console.log("SUMMARY", JSON.stringify(row, null, 2));
  appendFileSync(
    join(__dirname, "vero-generic-loop-live-results.json"),
    "\n\n// followup " + label + "\n" + JSON.stringify(row, null, 2),
    "utf8"
  );
  writeFileSync(
    join(__dirname, `vero-generic-loop-followup-${label}.json`),
    JSON.stringify(row, null, 2),
    "utf8"
  );
  return row;
}

// 3.6: same style as successful 3.2a but maxRounds=2 — expect tool then final OR exhausted fallback
await runQuestion(
  "3.6b",
  "最近整体测试情况怎么样，有什么值得关注的吗；请尽量多查几轮工具再总结",
  { maxRounds: 2 }
);

// 3.5b: force larger history via multi-tool then ask again in same script with high limit
await runQuestion(
  "3.5b",
  "查最近良率监控按 device 聚合，再按 probeCard 聚合，再按机台 hostname 聚合，把结果都拿全再总结异常",
  { maxRounds: 5 }
);
