/**
 * 验证 HANDOFF / NEXT_STEPS：P-A ~ P-D（真库 Agent SSE）
 * 用法：node scripts/verify-handoff-steps.mjs [pa|pb|pc|pd|all]
 */
import { randomUUID } from "node:crypto";

const API_BASE = (process.env.PCR_API_BASE || "http://10.192.130.89:30008").replace(/\/$/, "");
const STEP = (process.argv[2] || "all").toLowerCase();

const SCENARIOS = {
  pa: {
    label: "P-A get_filter_values mask P11C",
    messages: [{ role: "user", content: "P11C 最近的测试情况" }],
    check(events, text) {
      const toolResults = events.filter((e) => e.type === "tool_result" && e.name === "get_filter_values");
      const joined = toolResults.map((e) => e.summary || e.content || "").join("\n");
      const hay = joined + text;
      if (/WB01P11C/.test(hay) && !/"values"\s*:\s*\[\s*\]/.test(joined)) {
        return { ok: true, detail: "found WB01P11C in get_filter_values or reply" };
      }
      if (/totalDistinct"\s*:\s*0/.test(joined) && !/WB01P11C/.test(hay)) {
        return { ok: false, detail: "get_filter_values still empty (server may need npm run build && pm2 reload)" };
      }
      return { ok: /WB01P11C|P11C/.test(hay), detail: hay.slice(0, 300) };
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
      if (lotHits >= 3) return { ok: true, detail: `listed ~${lotHits} lot ids` };
      if (singleOverview) return { ok: false, detail: "looks like single-lot wafer overview, not lot list" };
      return { ok: lotHits >= 2, detail: text.slice(0, 400) };
    },
  },
  pc: {
    label: "P-C multi-card comparison bail",
    sessionPrefix: "pc-",
    messages: [
      { role: "user", content: "9416 卡的测试情况" },
      { role: "user", content: "把这4张probecard的测试情况做对比" },
    ],
    check(events, text) {
      const instantTable = events.some(
        (e) => e.type === "text" && typeof e.delta === "string" && e.delta.includes("探针卡/机台")
      );
      const multiCard = /9416-0[1-4]|对比|分别|各卡/.test(text);
      if (instantTable && !multiCard) return { ok: false, detail: "instant single-lot card table without comparison" };
      return { ok: multiCard, detail: text.slice(0, 400) };
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
      if (binOnly) return { ok: false, detail: "bin ranking without lot dimension" };
      return { ok: hasLot && hasBin40, detail: text.slice(0, 400) };
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
    const setupBody = {
      sessionId,
      message: msg,
      agentConfig: body.agentConfig,
    };
    await drainAgent(setupBody);
  }

  console.log(`  [check]`, body.message);
  const { events, text, err } = await drainAgent(body);
  const result = scenario.check(events, text);
  console.log(result.ok ? "PASS" : "FAIL", "-", result.detail);
  if (err) console.log("  error event:", err);
  return result.ok;
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
  console.error("Unknown step:", STEP, "use pa|pb|pc|pd|all");
  process.exit(2);
}

console.log("API:", API_BASE);
const health = await fetch(`${API_BASE}/health`);
console.log("Health:", await health.text());

let failed = 0;
for (const k of keys) {
  try {
    const ok = await runScenario(k, SCENARIOS[k]);
    if (!ok) failed++;
  } catch (e) {
    console.log("FAIL -", e instanceof Error ? e.message : String(e));
    failed++;
  }
}

console.log(`\nDone: ${keys.length - failed}/${keys.length} passed`);
process.exit(failed ? 1 : 0);
