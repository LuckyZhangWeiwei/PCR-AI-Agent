/**
 * Agent 回答准确性 8 项 + 探针卡组合排名（Q1/Q5 抽样）真库验证
 * 用法：node scripts/verify-realdb-agent-accuracy-2026-07-12.mjs
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const API_BASE = (process.env.PCR_API_BASE || "http://10.192.130.89:30008").replace(/\/$/, "");
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(REPO_ROOT, "scratchpad", "realdb-agent-accuracy-2026-07-12.txt");
const FETCH_MS = Number(process.env.VERIFY_FETCH_MS || 180_000);
const AGENT_MODEL = process.env.AGENT_MODEL || "deepseek-ai/DeepSeek-V4-Flash";

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
  const t = setTimeout(() => ac.abort(), FETCH_MS);
  try {
    const r = await fetch(u, { signal: ac.signal });
    const text = await r.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { _raw: text.slice(0, 800), _status: r.status };
    }
    return { ok: r.ok, status: r.status, json, url: u.toString() };
  } finally {
    clearTimeout(t);
  }
}

async function drainAgent(messages, sessionId) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 360_000);
  let text = "";
  const events = [];
  let err;
  try {
    for (const msg of messages) {
      const body = {
        sessionId,
        message: msg,
        agentConfig: {
          model: AGENT_MODEL,
          maxRounds: 8,
          streamTimeoutSec: 250,
          toolResultMaxChars: 20000,
          ...(process.env.AGENT_API_KEY ? { apiKey: process.env.AGENT_API_KEY } : {}),
        },
      };
      const res = await fetch(`${API_BASE}/api/v4/agent/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`HTTP ${res.status}: ${t.slice(0, 400)}`);
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
    }
  } finally {
    clearTimeout(timer);
  }
  return { events, text, err };
}

function toolNames(events) {
  return events.filter((e) => e.type === "tool_start").map((e) => e.name);
}

function parsePassBinHyphen(passBin) {
  const out = new Set([1]);
  for (const part of String(passBin ?? "").split("-")) {
    const n = Number(part.trim());
    if (Number.isInteger(n) && n >= 0 && n <= 255) out.add(n);
  }
  return out;
}

log(`# Agent accuracy + probe-card perf 真库验证 ${new Date().toISOString()}`);
log(`本地 repo HEAD: ${gitHead}（远程是否 pm2 reload 此 commit 需对照行为）`);
log(`API: ${API_BASE}`);
log(`Agent model: ${AGENT_MODEL}`);
log("");

const health = await fetch(`${API_BASE}/health`);
log(`Health: ${await health.text()}`);
log("");

// ── REST: lot-underperforming-duts vs JB PASSBIN 口径 ──
log("## REST — lot-underperforming-duts 与 JB 良率对齐（P0-2/P0-3）");

const probeLots = ["NF12595.1A", "DR41803.1Y", "NF12499.1N"];
let restOk = 0;
for (const lot of probeLots) {
  log(`\n### Lot ${lot}`);
  const dut = await apiGet("/api/v4/inf-analysis/lot-underperforming-duts", { lot, passId: "1" });
  if (!dut.ok) {
    log(`  lot-underperforming-duts FAIL HTTP ${dut.status}: ${JSON.stringify(dut.json).slice(0, 200)}`);
    continue;
  }
  const jb = await apiGet("/api/v4/infcontrol-layer-bins/v4", { lot, limit: "50", passId: "1" });
  const jbRows = jb.json?.rows ?? [];
  const pass1 = (dut.json.passes ?? []).find((p) => p.passId === 1);
  const dutYield = pass1?.baseline?.yieldPct;
  log(`  device=${dut.json.device} probeCardType=${dut.json.probeCardType}`);
  log(`  DUT pass1 lotOverall yieldPct=${dutYield ?? "null"}`);
  if (dutYield != null && dutYield <= 0 && jbRows.length > 0) {
    const passBins = new Set();
    for (const row of jbRows) {
      if (Number(row.PASSID ?? row.passId) !== 1) continue;
      for (const n of parsePassBinHyphen(row.PASSBIN ?? row.passbin)) passBins.add(n);
    }
    log(`  JB PASSBIN good bins (pass1): ${[...passBins].sort((a, b) => a - b).join(",")}`);
    if ([...passBins].some((b) => b !== 1)) {
      log(`  ⚠️ FAIL: JB 有非 BIN1 良品 bin 但 DUT baseline=0% — 口径可能未对齐或未部署 ee48ab2`);
    } else {
      log(`  NOTE: baseline=0% 且 JB 仅 BIN1 — 可能真库无 INF 良品 die`);
    }
  } else if (dutYield != null && dutYield > 0) {
    log(`  ✅ pass1 baseline > 0%`);
    restOk++;
  }
}

log(`\nREST 抽样: ${restOk}/${probeLots.length} lot pass1 baseline>0%`);

// ── Agent SSE scenarios ──
const scenarios = [
  {
    id: "P0-4-goodbin",
    setup: ["DR41803.1Y 的测试情况"],
    ask: "DR41803.1Y 中的 good bin 是多少",
    check(events, text) {
      const tools = toolNames(events);
      const hasOverview = /分测试层|测试机台|逐片|slot/i.test(text) && text.length > 800;
      const hasBinAnswer = /BIN\d+/i.test(text) && /good\s*bin|良品\s*bin/i.test(text);
      const ok = hasBinAnswer && !hasOverview;
      return {
        ok,
        detail: ok
          ? `直答 good bin，无概况表劫持 tools=${tools.join(",")}`
          : `hasBin=${hasBinAnswer} overviewHijack=${hasOverview} tools=${tools.join(",")}`,
        excerpt: text.slice(0, 600),
      };
    },
  },
  {
    id: "P1-5-device-listing",
    setup: [],
    ask: "WA01N39W 的测试情况",
    check(events, text) {
      const lotRows = (text.match(/\b[A-Z]{2}\d{5,}\.\d[A-Z]\b/g) || []).length;
      const hasDutGrid = /\| DUT \| 良率%/i.test(text) || /\| DUT0 \|/i.test(text);
      const hasTesterInTitle = /机台\s*=\s*b3/i.test(text.split("\n").slice(0, 8).join("\n"));
      const ok = lotRows >= 2 && !hasDutGrid && !hasTesterInTitle;
      return {
        ok,
        detail: `lotRows~${lotRows} dutGrid=${hasDutGrid} testerInTitle=${hasTesterInTitle}`,
        excerpt: text.slice(0, 500),
      };
    },
  },
  {
    id: "P2-8a-cardId",
    setup: [],
    ask: "9440-03 卡的测试情况",
    check(events, text) {
      const tools = toolNames(events);
      const elapsed = events.some((e) => e.type === "done");
      const emptySpin = text.length < 50 && !elapsed;
      const hasData = text.length > 100;
      const ok = hasData && !emptySpin;
      return {
        ok,
        detail: `tools=${tools.join(",")} textLen=${text.length}`,
        excerpt: text.slice(0, 500),
      };
    },
  },
  {
    id: "Q5-probe-card-combo",
    setup: [],
    ask: "WA03P02G 这个 device 下最好的探针卡+机台组合是什么，哪张探针卡表现最差",
    check(events, text) {
      const tools = toolNames(events);
      const hitNew = tools.includes("aggregate_probe_card_tester_performance");
      const hijacked = tools.includes("query_jb_bins") && !hitNew;
      const hasTableTitle = /探针卡\+机台组合排名|pass1（sort1/i.test(text);
      const ok = hitNew || hasTableTitle;
      return {
        ok,
        detail: `tools=${tools.join(",")} tableTitle=${hasTableTitle} hijacked=${hijacked}`,
        excerpt: text.slice(0, 600),
      };
    },
  },
];

log("\n## Agent SSE 场景");
let agentPass = 0;
for (const sc of scenarios) {
  const sid = `v-acc-${sc.id}-${randomUUID()}`;
  log(`\n### ${sc.id} session=${sid}`);
  try {
    const msgs = [...sc.setup, sc.ask];
    const { events, text, err } = await drainAgent(msgs, sid);
    const r = sc.check(events, text);
    log(r.ok ? "PASS" : "FAIL", "-", r.detail);
    if (err) log("  SSE error:", err);
    log("```");
    log(r.excerpt);
    log("```");
    if (r.ok) agentPass++;
  } catch (e) {
    log("ERROR:", e instanceof Error ? e.message : String(e));
  }
}

log(`\n## Summary`);
log(`REST baseline>0%: ${restOk}/${probeLots.length}`);
log(`Agent SSE: ${agentPass}/${scenarios.length} passed`);
log(`\nNote: Agent B 路 goodBins payload 修复需远程 pm2 reload 至 commit ${gitHead} 后完全生效。`);

writeFileSync(OUT, lines.join("\n"), "utf8");
console.log("\nWrote:", OUT);
process.exit(agentPass === scenarios.length && restOk >= 1 ? 0 : 1);
