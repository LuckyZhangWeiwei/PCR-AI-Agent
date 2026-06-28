/**
 * 验证 HANDOFF / NEXT_STEPS：P-A ~ P-F（真库 Agent SSE，严格判定）
 * 用法：node scripts/verify-handoff-steps.mjs [pa|pb|pc|pd|pf|all]
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dir, "..", "..");

const API_BASE = (process.env.PCR_API_BASE || "http://10.192.130.89:30008").replace(/\/$/, "");
const STEP = (process.argv[2] || "all").toLowerCase();
const OUT_PATH = process.env.VERIFY_OUT || join(REPO_ROOT, "scratchpad", "reverify-2026-06-27.txt");

function parseFilterValuesTotalDistinct(events) {
  const chunks = events
    .filter((e) => e.type === "tool_result" && e.name === "get_filter_values")
    .map((e) => String(e.summary ?? e.content ?? ""));
  const joined = chunks.join("\n");
  const m = joined.match(/"totalDistinct"\s*:\s*(\d+)/);
  return { totalDistinct: m ? Number(m[1]) : null, raw: joined.slice(0, 500) };
}

function count9416Cards(text) {
  return new Set([...text.matchAll(/\b9416-0[1-4]\b/g)].map((m) => m[0]));
}

const SCENARIOS = {
  pa: {
    label: "P-A get_filter_values mask P11C (strict)",
    messages: [{ role: "user", content: "P11C 最近的测试情况" }],
    check(events, text) {
      const { totalDistinct, raw } = parseFilterValuesTotalDistinct(events);
      if (totalDistinct != null && totalDistinct > 0) {
        return { ok: true, detail: `get_filter_values totalDistinct=${totalDistinct}`, excerpt: raw };
      }
      return {
        ok: false,
        detail:
          totalDistinct === 0
            ? "get_filter_values totalDistinct=0 (dist likely not reloaded)"
            : "no get_filter_values tool_result in SSE",
        excerpt: raw || text.slice(0, 300),
      };
    },
  },
  pb: {
    label: "P-B lot listing 口语",
    sessionPrefix: "pb-",
    messages: [
      { role: "user", content: "uflex 最近三天" },
      { role: "user", content: "都测试了什么lot" },
    ],
    check(_events, text) {
      const lotHits = (text.match(/\b[A-Z]{2}\d{5,}\.\d[A-Z]\b/g) || []).length;
      const singleOverview = /逐片|slot\s*\d|第\s*\d+\s*片/.test(text) && lotHits <= 1;
      if (lotHits >= 3) return { ok: true, detail: `listed ~${lotHits} lot ids`, excerpt: text.slice(0, 400) };
      if (singleOverview) return { ok: false, detail: "single-lot wafer overview", excerpt: text.slice(0, 400) };
      return { ok: lotHits >= 2, detail: text.slice(0, 400), excerpt: text.slice(0, 400) };
    },
  },
  pc: {
    label: "P-C multi-card comparison bail (strict)",
    sessionPrefix: "pc-",
    messages: [
      { role: "user", content: "9416 卡的测试情况" },
      { role: "user", content: "把这4张probecard的测试情况做对比" },
    ],
    check(_events, text) {
      const cards = count9416Cards(text);
      const compareLang = /对比|比较|分别|各自/.test(text);
      const equipmentTable = /各测试层探针卡|测试机台|批次 lot \| 机台/.test(text);
      const singleLot = /\bDR\d{5,}\.\d[A-Z]\b/.test(text);

      if (equipmentTable && cards.size <= 1 && singleLot && !compareLang) {
        return {
          ok: false,
          detail: `single-lot equipment table; cards=${[...cards].join(",") || "none"}`,
          excerpt: text.slice(0, 600),
        };
      }
      if (cards.size >= 2) {
        return { ok: true, detail: `multi-card: ${[...cards].join(", ")}`, excerpt: text.slice(0, 600) };
      }
      if (compareLang && cards.size >= 2) {
        return { ok: true, detail: "comparison + multiple cards", excerpt: text.slice(0, 600) };
      }
      return { ok: false, detail: `cards=${cards.size}, compareLang=${compareLang}`, excerpt: text.slice(0, 600) };
    },
  },
  pd: {
    label: "P-D bin+lot after platform window",
    sessionPrefix: "pd-",
    messages: [
      { role: "user", content: "uflex 最近三天的测试情况" },
      { role: "user", content: "哪个lot bin40最多" },
    ],
    check(_events, text) {
      const hasLot = /\b[A-Z]{2}\d{5,}\.\d[A-Z]\b/.test(text);
      const hasBin40 = /BIN\s*40|bin40/i.test(text);
      const binOnly = /主要坏\s*BIN|BIN40.*BIN\d+/i.test(text) && !hasLot;
      if (binOnly) return { ok: false, detail: "bin ranking without lot", excerpt: text.slice(0, 400) };
      return { ok: hasLot && hasBin40, detail: text.slice(0, 400), excerpt: text.slice(0, 400) };
    },
  },
  pf: {
    label: "P-F focusBin + goodBins (query_lot_dut_bin_agg)",
    sessionPrefix: "pf-",
    messages: [
      { role: "user", content: "NF13322.1J 哪一片 wafer bin79 最多" },
      { role: "user", content: "哪个卡 哪个dut 测试出的 bin79 最多" },
    ],
    check(events, text) {
      const toolChunks = events
        .filter((e) => e.type === "tool_result" && e.name === "query_lot_dut_bin_agg")
        .map((e) => String(e.summary ?? ""));
      const hay = toolChunks.join("\n") + text;
      const concTable = /坏 die 的 DUT 集中度/.test(hay);
      const badGood = /\|\s*BIN1\s*\||\|\s*BIN55\s*\|/.test(hay);
      const hasBin79 = /\|\s*BIN79\s*\|/i.test(hay) || /BIN79/i.test(hay);
      if (!concTable && toolChunks.length === 0) {
        return { ok: false, detail: "no query_lot_dut_bin_agg tool_result", excerpt: hay.slice(0, 500) };
      }
      if (badGood) {
        return { ok: false, detail: "concentration table still has BIN1/BIN55", excerpt: hay.slice(0, 800) };
      }
      if (hasBin79) {
        return { ok: true, detail: "BIN79 present, no BIN1/BIN55 in table", excerpt: hay.slice(0, 800) };
      }
      return { ok: false, detail: "missing BIN79 in output", excerpt: hay.slice(0, 500) };
    },
  },
};

async function runScenario(key, scenario) {
  const sessionId = `${scenario.sessionPrefix || "v-"}${randomUUID()}`;
  const body = {
    sessionId,
    message: scenario.messages.at(-1).content,
    agentConfig: {
      maxRounds: 8,
      streamTimeoutSec: 250,
      toolResultMaxChars: 20000,
      ...(process.env.AGENT_API_KEY ? { apiKey: process.env.AGENT_API_KEY } : {}),
    },
  };

  console.log(`\n=== ${key.toUpperCase()}: ${scenario.label} ===`);
  console.log("Session:", sessionId);

  for (let i = 0; i < scenario.messages.length - 1; i++) {
    const msg = scenario.messages[i].content;
    console.log(`  [setup ${i + 1}]`, msg);
    await drainAgent({ sessionId, message: msg, agentConfig: body.agentConfig });
  }

  console.log(`  [check]`, body.message);
  const { events, text, err } = await drainAgent(body);
  const result = scenario.check(events, text);
  console.log(result.ok ? "PASS" : "FAIL", "-", result.detail);
  if (err) console.log("  error event:", err);
  return { key, ok: result.ok, detail: result.detail, excerpt: result.excerpt ?? "", sessionId };
}

async function drainAgent(body) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 360_000);
  let res;
  try {
    res = await fetch(`${API_BASE}/api/v4/agent/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`HTTP ${res.status}: ${t.slice(0, 500)}`);
  }

  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
  const events = [];
  let err;

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
  return { events, text, err };
}

const keys = STEP === "all" ? Object.keys(SCENARIOS) : [STEP];
if (!keys.every((k) => SCENARIOS[k])) {
  console.error("Unknown step:", STEP, "use pa|pb|pc|pd|pf|all");
  process.exit(2);
}

console.log("API:", API_BASE);
const health = await fetch(`${API_BASE}/health`);
console.log("Health:", await health.text());

const lines = [
  `# Handoff reverify ${new Date().toISOString()}`,
  `API: ${API_BASE}`,
  `STEP: ${STEP}`,
  "",
];

let failed = 0;
for (const k of keys) {
  try {
    const r = await runScenario(k, SCENARIOS[k]);
    lines.push(`## ${k.toUpperCase()} — ${r.ok ? "PASS" : "FAIL"}`);
    lines.push(`Session: ${r.sessionId}`);
    lines.push(`Detail: ${r.detail}`);
    lines.push("```");
    lines.push(r.excerpt);
    lines.push("```");
    lines.push("");
    if (!r.ok) failed++;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log("FAIL -", msg);
    lines.push(`## ${k.toUpperCase()} — ERROR`);
    lines.push(msg);
    lines.push("");
    failed++;
  }
}

lines.push(`Summary: ${keys.length - failed}/${keys.length} passed`);
try {
  writeFileSync(OUT_PATH, lines.join("\n"), "utf8");
  console.log("\nWrote:", OUT_PATH);
} catch (e) {
  console.warn("Could not write", OUT_PATH, e);
}

console.log(`\nDone: ${keys.length - failed}/${keys.length} passed`);
process.exit(failed ? 1 : 0);
