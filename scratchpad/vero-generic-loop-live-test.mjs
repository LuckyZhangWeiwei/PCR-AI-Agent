/**
 * Live Vero generic-loop tests for HANDOFF_CURSOR_VERO_GENERIC_LOOP_TEST.md
 * Not committed — scratchpad only. Does not print tokens.
 *
 * Usage: cd pcr-ai-api && npx tsx ../scratchpad/vero-generic-loop-live-test.mjs
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";
import { generateKeyPairSync } from "node:crypto";
import net from "node:net";

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
// Keep Path B pilot on (realistic) — questions below must avoid its regex.

const { invokeVeroSimpleAgent, parseJsonLoose } = await import(
  "../pcr-ai-api/src/lib/vero/veroSimpleAgent.ts"
);
const { runVeroAgentLoop } = await import(
  "../pcr-ai-api/src/lib/agent/core/veroAgentLoop.ts"
);
const { parseVeroRoundDecision } = await import(
  "../pcr-ai-api/src/lib/agent/core/veroAgentProtocol.ts"
);

const results = [];
const logLines = [];

function log(...args) {
  const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  console.log(line);
  logLines.push(line);
}

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

function classifyRawJson(raw) {
  const t = String(raw || "").trim();
  let mode = "unknown";
  try {
    JSON.parse(t);
    mode = "bare_json";
  } catch {
    if (/```(?:json)?/i.test(t)) mode = "fenced_json";
    else if (t.includes("{") && t.includes("}")) mode = "slice_fallback";
    else mode = "unparseable";
  }
  let decisionOk = false;
  let decisionSummary = "";
  try {
    const d = parseVeroRoundDecision(t);
    decisionOk = true;
    decisionSummary =
      d.action === "tool"
        ? `tool:${d.tool}`
        : `${d.action}:replyLen=${d.reply?.length ?? 0}`;
  } catch (e) {
    decisionSummary = `PARSE_FAIL:${e instanceof Error ? e.message : String(e)}`;
  }
  return { mode, decisionOk, decisionSummary, rawPreview: t.slice(0, 400), rawLen: t.length };
}

async function runQuestion(label, question, configOverrides = {}) {
  log(`\n========== ${label} ==========`);
  log("Q:", question);

  const veroCalls = [];
  const events = [];
  const promptSizes = [];

  const wrappedInvoke = async (prompt, systemPrompt) => {
    const promptChars = String(prompt || "").length;
    const systemChars = String(systemPrompt || "").length;
    promptSizes.push({ promptChars, systemChars, total: promptChars });
    log(`[vero#${veroCalls.length + 1}] invoke promptChars=${promptChars}`);
    const started = Date.now();
    const raw = await invokeVeroSimpleAgent(prompt, systemPrompt);
    const ms = Date.now() - started;
    const meta = classifyRawJson(raw);
    veroCalls.push({ ms, ...meta });
    log(
      `[vero#${veroCalls.length}] ${ms}ms mode=${meta.mode} ok=${meta.decisionOk} → ${meta.decisionSummary}`
    );
    if (meta.mode !== "bare_json") {
      log(`[vero#${veroCalls.length}] rawPreview:`, meta.rawPreview.replace(/\n/g, "\\n"));
    }
    return raw;
  };

  const t0 = Date.now();
  try {
    await runVeroAgentLoop(
      question,
      `live-test-${label}-${Date.now()}`,
      stubConfig(configOverrides),
      (e) => {
        events.push(e);
        if (e.type === "status") log("[status]", e.message);
        if (e.type === "tool_start") log("[tool_start]", e.name, e.args);
        if (e.type === "tool_result")
          log("[tool_result]", String(e.summary ?? "").slice(0, 160));
        if (e.type === "error") log("[error]", e.message);
      },
      undefined,
      { invoke: wrappedInvoke }
    );
  } catch (err) {
    log("[THROW]", err instanceof Error ? err.message : String(err));
  }
  const elapsedMs = Date.now() - t0;

  const text = events
    .filter((e) => e.type === "text")
    .map((e) => e.delta)
    .join("");
  const toolStarts = events.filter((e) => e.type === "tool_start");
  const statuses = events.filter((e) => e.type === "status").map((e) => e.message);
  const done = events.some((e) => e.type === "done");
  const err = events.find((e) => e.type === "error");
  const compressed = statuses.some((s) => String(s).includes("正在压缩历史对话"));
  const hitPilot =
    statuses.some((s) => String(s).includes("Vero 试点")) ||
    statuses.some((s) => String(s).includes("探针卡/机台组合"));

  const row = {
    label,
    question,
    elapsedMs,
    done,
    error: err?.message ?? null,
    veroCallCount: veroCalls.length,
    veroModes: veroCalls.map((c) => c.mode),
    veroDecisions: veroCalls.map((c) => c.decisionSummary),
    toolNames: toolStarts.map((t) => t.name),
    toolCount: toolStarts.length,
    multiRoundTools: toolStarts.length >= 2,
    hitDirectOrPilot: hitPilot || (veroCalls.length === 0 && toolStarts.length > 0),
    compressed,
    maxPromptChars: promptSizes.length
      ? Math.max(...promptSizes.map((p) => p.promptChars))
      : 0,
    textLen: text.length,
    textPreview: text.slice(0, 500),
    statuses,
  };
  results.push(row);
  log(
    `SUMMARY ${label}: done=${done} veroCalls=${veroCalls.length} tools=${toolStarts.length} multiRound=${row.multiRoundTools} pilot/direct=${row.hitDirectOrPilot} compressed=${compressed} maxPrompt=${row.maxPromptChars} textLen=${text.length} ${elapsedMs}ms`
  );
  return row;
}

async function testTimeout() {
  log("\n========== 3.4 timeout (local hang HTTPS) ==========");
  // Self-signed cert; TLS may succeed then hang on HTTP response.
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  // Minimal PEM via openssl not available — use TCP accept-and-hold instead.
  // TCP: accept connection, never reply → client timeout should fire.
  const server = net.createServer((socket) => {
    // hold open; do not write
    socket.on("error", () => {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `https://127.0.0.1:${port}`;
  const timeoutMs = 5000;
  const t0 = Date.now();
  let outcome = "unknown";
  let errMsg = "";
  try {
    await invokeVeroSimpleAgent("ping", "sys", {
      baseUrl,
      timeoutMs,
    });
    outcome = "unexpected_success";
  } catch (e) {
    errMsg = e instanceof Error ? e.message : String(e);
    const elapsed = Date.now() - t0;
    if (/timed out/i.test(errMsg) && elapsed >= timeoutMs - 500) {
      outcome = "timeout_ok";
    } else if (/timeout|ECONN|socket|TLS|certificate|hang up/i.test(errMsg)) {
      outcome = `error_before_or_alt:${errMsg.slice(0, 120)}`;
    } else {
      outcome = `other_error:${errMsg.slice(0, 160)}`;
    }
    log(`timeout test elapsed=${elapsed}ms outcome=${outcome}`);
    log(`err: ${errMsg.slice(0, 300)}`);
  }
  server.close();
  results.push({
    label: "3.4-timeout",
    outcome,
    errMsg: errMsg.slice(0, 300),
    timeoutMs,
  });
  return outcome;
}

async function testTlsBaseline() {
  log("\n========== 3.7 TLS ping ==========");
  const t0 = Date.now();
  try {
    const raw = await invokeVeroSimpleAgent(
      'Reply with exactly this JSON and nothing else: {"action":"chat","reply":"PONG"}',
      "You are a test harness. Output only JSON."
    );
    const ms = Date.now() - t0;
    const meta = classifyRawJson(raw);
    log(`TLS ok in ${ms}ms mode=${meta.mode} → ${meta.decisionSummary}`);
    results.push({ label: "3.7-tls", ok: true, ms, ...meta });
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log("TLS FAIL:", msg.slice(0, 300));
    results.push({ label: "3.7-tls", ok: false, error: msg.slice(0, 300) });
    return false;
  }
}

// ── run suite ──────────────────────────────────────────────────────────────
log("=== Vero generic-loop LIVE suite ===");
log("base:", process.env.VERO_BASE_URL);
log("token set:", Boolean(process.env.WCHAT_ACCESS_TOKEN));

await testTlsBaseline();

// 3.2 open questions (avoid device/card/lot/bin + probe-card combo phrases)
await runQuestion("3.2a", "最近整体测试情况怎么样，有什么值得关注的吗");
await runQuestion("3.2b", "帮我看看现在有没有什么异常趋势");
await runQuestion("3.2c", "随便挑一个最近的批次，分析一下良率");

// 3.3: encourage tool that embeds a device, then continue analysis
await runQuestion(
  "3.3",
  "请先查一下最近有哪些 device 在测，再挑其中一个分析它最近批次的良率概况，不要只列名单"
);

// 3.5: push larger tool results (Dummy may still be small)
await runQuestion(
  "3.5",
  "请尽量多查几轮：先拉最近 lot 列表，再聚合坏 bin，再按机台聚合，把能查的都查了再总结"
);

// 3.6: force early final / fallback with maxRounds=2
await runQuestion(
  "3.6-maxRounds2",
  "请依次：1) 查最近 lot 列表 2) 再查其中一个 lot 的明细 3) 再聚合坏 bin 趋势，最后给出完整结论",
  { maxRounds: 2 }
);

await testTimeout();

const outPath = join(__dirname, "vero-generic-loop-live-results.json");
writeFileSync(outPath, JSON.stringify(results, null, 2), "utf8");
const logPath = join(__dirname, "vero-generic-loop-live-log.txt");
writeFileSync(logPath, logLines.join("\n"), "utf8");
log("\nWrote", outPath);
log("Wrote", logPath);
log("\n=== DONE ===");
