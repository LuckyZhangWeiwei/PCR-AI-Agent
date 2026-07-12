/**
 * Post-deploy 真库复验：P0-2/P0-4 + 探针卡 Q1/Q5/Q7
 * 用法：node scripts/verify-realdb-post-deploy-2026-07-12.mjs
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const API_BASE = (process.env.PCR_API_BASE || "http://10.192.130.89:30008").replace(/\/$/, "");
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(REPO_ROOT, "scratchpad", "realdb-post-deploy-2026-07-12.txt");
const AGENT_MODEL = process.env.AGENT_MODEL || "deepseek-ai/DeepSeek-V4-Flash";
const AGENT_TURN_MS = Number(process.env.VERIFY_AGENT_TURN_MS || 600_000);

let gitHead = "?";
try {
  gitHead = execSync("git rev-parse --short HEAD", { cwd: REPO_ROOT }).toString().trim();
} catch {
  /* ignore */
}

const lines = [];
function log(s) {
  lines.push(s);
  console.log(s);
}

async function apiGet(path, params = {}) {
  const u = new URL(`${API_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    u.searchParams.set(k, String(v));
  }
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 180_000);
  try {
    const r = await fetch(u, { signal: ac.signal });
    return { ok: r.ok, status: r.status, json: await r.json(), url: u.toString() };
  } finally {
    clearTimeout(t);
  }
}

async function agentTurn(sessionId, message) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), AGENT_TURN_MS);
  const events = [];
  let text = "";
  let err;
  const body = {
    sessionId,
    message,
    agentConfig: {
      model: AGENT_MODEL,
      maxRounds: 8,
      streamTimeoutSec: 300,
      toolResultMaxChars: 20000,
      ...(process.env.AGENT_API_KEY ? { apiKey: process.env.AGENT_API_KEY } : {}),
    },
  };
  const t0 = Date.now();
  try {
    const res = await fetch(`${API_BASE}/api/v4/agent/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
    }
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() ?? "";
      for (const block of parts) {
        for (const line of block.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          try {
            const ev = JSON.parse(line.slice(6));
            events.push(ev);
            if (ev.type === "text" && ev.delta) text += ev.delta;
            if (ev.type === "error") err = ev.message;
          } catch {
            /* ignore */
          }
        }
      }
    }
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
  } finally {
    clearTimeout(timer);
  }
  return { events, text, err, ms: Date.now() - t0 };
}

function toolNames(events) {
  return events.filter((e) => e.type === "tool_start").map((e) => e.name);
}

function jbPass1YieldFromRows(rows) {
  let gross = 0;
  let bad = 0;
  for (const row of rows) {
    if (Number(row.PASSID ?? row.passId) !== 1) continue;
    const g = Number(row.GROSSDIE ?? 0);
    if (!g) continue;
    gross += g;
    const bins = row.bins;
    if (Array.isArray(bins)) {
      for (const b of bins) {
        if (!b.isGoodBin && Number(b.value) > 0) bad += Number(b.value);
      }
    }
  }
  if (gross <= 0) return null;
  return Math.round((1 - bad / gross) * 1000) / 10;
}

log(`# Post-deploy 真库复验 ${new Date().toISOString()}`);
log(`HEAD: ${gitHead}  API: ${API_BASE}`);
log("");

// ── P0-2 REST ──
log("## P0-2 — NF12595.1A JB vs DUT REST 口径");
const lot = "NF12595.1A";
const dut = await apiGet("/api/v4/inf-analysis/lot-underperforming-duts", { lot, passId: "1" });
const jb = await apiGet("/api/v4/infcontrol-layer-bins/v4", { lot, limit: "200", passId: "1" });
const dutYield = dut.json?.passes?.find((p) => p.passId === 1)?.baseline?.yieldPct;
const jbYield = jb.json?.rows ? jbPass1YieldFromRows(jb.json.rows) : null;
const delta = dutYield != null && jbYield != null ? Math.abs(dutYield - jbYield) : null;
log(`  DUT lotOverall pass1: ${dutYield ?? "null"}%`);
log(`  JB rows approx pass1: ${jbYield ?? "null"}%`);
if (delta != null) {
  log(`  delta: ${delta.toFixed(1)}pp → ${delta <= 2 ? "✅ PASS (≤2pp)" : delta <= 5 ? "⚠️ WARN (≤5pp)" : "❌ FAIL (>5pp)"}`);
}

// ── P0-4 Agent (split turns) ──
log("\n## P0-4 — good bin 直答（分轮 600s）");
const sidP04 = `post-p04-${randomUUID()}`;
log("  turn1: DR41803.1Y 的测试情况");
const t1 = await agentTurn(sidP04, "DR41803.1Y 的测试情况");
log(`  turn1: ${t1.err ? "ERROR " + t1.err : "ok"} ms=${t1.ms} tools=${toolNames(t1.events).join(",")} len=${t1.text.length}`);
if (!t1.err) {
  log("  turn2: DR41803.1Y 中的 good bin 是多少");
  const t2 = await agentTurn(sidP04, "DR41803.1Y 中的 good bin 是多少");
  const tools = toolNames(t2.events);
  const hasOverview = /分测试层|测试机台|逐片/i.test(t2.text) && t2.text.length > 800;
  const hasBinAnswer = /BIN\d+/i.test(t2.text) && /good\s*bin|良品\s*bin/i.test(t2.text);
  const ok = hasBinAnswer && !hasOverview;
  log(`  turn2: ${t2.err ? "ERROR " + t2.err : ok ? "✅ PASS" : "❌ FAIL"} ms=${t2.ms} tools=${tools.join(",")}`);
  log(`  hasBin=${hasBinAnswer} overviewHijack=${hasOverview}`);
  log("```");
  log(t2.text.slice(0, 800));
  log("```");
}

// ── Q5/Q7 probe card perf ──
log("\n## Q5/Q7 — 探针卡组合排名 + 是否直出表");
const sidQ5 = `post-q5-${randomUUID()}`;
const q = "WA03P02G 这个 device 下最好的探针卡+机台组合是什么，哪张探针卡表现最差";
const tQ5 = await agentTurn(sidQ5, q);
const qTools = toolNames(tQ5.events);
const hitPerf = qTools.includes("aggregate_probe_card_tester_performance");
const hasTableTitle = /探针卡\+机台组合排名|#### pass1（sort1/i.test(tQ5.text);
const llmProseOnly = !hasTableTitle && /数据摘要|最佳组合|最差探针卡/i.test(tQ5.text);
log(`  tools=${qTools.join(",")} ms=${tQ5.ms}`);
log(`  hitPerfTool=${hitPerf} hasTableTitle=${hasTableTitle} llmProseOnly=${llmProseOnly}`);
log(`  Q5 route: ${hitPerf || hasTableTitle ? "✅ PASS" : "❌ FAIL"}`);
log(`  Q7 verbatim tables: ${hasTableTitle ? "✅ PASS" : "❌ FAIL (LLM prose/转述)"}`);
if (tQ5.err) log(`  ERROR: ${tQ5.err}`);
log("```");
log(tQ5.text.slice(0, 1000));
log("```");

// ── Q1 timing via agent tool (same tool path) ──
log("\n## Q1 — aggregate_probe_card_tester_performance 可用性（经 Agent 工具路径）");
if (hitPerf) {
  const perfStart = tQ5.events.find((e) => e.type === "tool_start" && e.name === "aggregate_probe_card_tester_performance");
  log(`  tool invoked: yes, agent turn total ms=${tQ5.ms}`);
  log(`  Q1: ✅ Oracle 路径经 Agent 工具跑通（详见服务端 logAgentSql）`);
} else {
  log("  Q1: ⚠️ 本轮未观察到 perf 工具调用");
}

log("\n## Summary");
log(`P0-2 REST delta: ${delta != null ? delta.toFixed(1) + "pp" : "n/a"}`);
writeFileSync(OUT, lines.join("\n"), "utf8");
console.log("\nWrote:", OUT);
