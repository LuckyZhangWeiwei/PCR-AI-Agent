/**
 * 步骤 3：JB_DETERMINISTIC_DISPATCH=true + JB_LLM_INTENT_CLASSIFIER=true
 * - 回归 A1-1 派发仍生效
 * - FLIP Test B2 口语长尾
 *
 * 用法：node scripts/verify-step3-classifier.mjs
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dir, "..", "..");
const API_BASE = (process.env.PCR_API_BASE || "http://10.192.130.89:30008").replace(/\/$/, "");
const OUT_PATH =
  process.env.VERIFY_OUT || join(REPO_ROOT, "scratchpad", "step3-classifier-2026-06-30.txt");

function agentConfig(extra = {}) {
  return {
    maxRounds: 8,
    streamTimeoutSec: 250,
    toolResultMaxChars: 20000,
    ...(process.env.AGENT_API_KEY ? { apiKey: process.env.AGENT_API_KEY } : {}),
    ...extra,
  };
}

async function drainAgent({ sessionId, message }) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 360_000);
  let res;
  try {
    res = await fetch(`${API_BASE}/api/v4/agent/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, message, agentConfig: agentConfig() }),
      signal: ac.signal,
    });
  } finally {
    clearTimeout(t);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);

  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
  const events = [];
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
        } catch {
          /* ignore */
        }
      }
    }
  }
  return { events, text };
}

const SCENARIOS = [
  {
    id: "reg-a1-1",
    label: "回归 A1-1 派发+分类器同开",
    message: "n55z 哪个卡测出bin35 多",
    check(events, text) {
      const start = events.find((e) => e.type === "tool_start");
      const dispatch = events.some((e) => e.type === "status" && String(e.message ?? "").includes("直发"));
      const cards = [...new Set(text.match(/\b\d{4}-\d{2,3}\b/g) || [])];
      const ok = start?.name === "aggregate_jb_bins" && /BIN\s*35|bin35/i.test(text) && cards.length >= 2;
      return {
        ok,
        detail: `dispatch=${dispatch} first=${start?.name ?? "none"} cards=${cards.length}`,
        excerpt: text.slice(0, 550),
      };
    },
  },
  {
    id: "b2-1",
    label: "B2 各张探针卡 bin8 分布",
    message: "各张探针卡 bin8 分布怎么样",
    check(_events, text) {
      const cards = (text.match(/\b\d{4}-\d{2,3}\b/g) || []).length;
      const bin8 = /BIN\s*8|bin8/i.test(text);
      const clarify = /请提供|哪几张|哪些卡|具体|澄清|device|lot/i.test(text);
      const bad = /各片良率|逐片/.test(text) && cards < 2;
      const ok = !bad && (cards >= 2 || bin8 || clarify) && text.trim().length > 30;
      return { ok, detail: `cards=${cards} bin8=${bin8} clarify=${clarify}`, excerpt: text.slice(0, 550) };
    },
  },
  {
    id: "b2-2",
    label: "B2 近期哪几批良率掉得厉害",
    message: "近期哪几批良率掉得厉害",
    check(_events, text) {
      const lots = [...new Set(text.match(/\b[A-Z]{2}\d{5,}\.\d[A-Z]\b/g) || [])];
      const yieldTalk = /良率|yield|下降|掉|低/i.test(text);
      const ok = text.trim().length > 30 && (lots.length >= 2 || yieldTalk);
      return { ok, detail: `lots=${lots.length} yieldTalk=${yieldTalk}`, excerpt: text.slice(0, 550) };
    },
  },
  {
    id: "b2-3",
    label: "B2 哪片卡 bin35 出得最多",
    message: "哪片卡 bin35 出得最多",
    check(events, text) {
      const start = events.find((e) => e.type === "tool_start");
      const cards = [...new Set(text.match(/\b\d{4}-\d{2,3}\b/g) || [])];
      const bin35 = /BIN\s*35|bin35/i.test(text);
      const ok = (start?.name === "aggregate_jb_bins" || cards.length >= 1) && bin35 && text.trim().length > 20;
      return {
        ok,
        detail: `first=${start?.name ?? "none"} cards=${cards.join(",") || "none"}`,
        excerpt: text.slice(0, 550),
      };
    },
  },
];

console.log("API:", API_BASE);
console.log("Health:", await (await fetch(`${API_BASE}/health`)).text());

const lines = [
  `# Step 3 classifier verify ${new Date().toISOString()}`,
  `API: ${API_BASE}`,
  `Expected: JB_DETERMINISTIC_DISPATCH=true, JB_LLM_INTENT_CLASSIFIER=true`,
  "",
];

let failed = 0;
for (const s of SCENARIOS) {
  const sessionId = `${s.id}-${randomUUID()}`;
  console.log(`\n=== ${s.id}: ${s.label} ===`);
  console.log("Session:", sessionId);
  try {
    const { events, text } = await drainAgent({ sessionId, message: s.message });
    const r = s.check(events, text);
    console.log(r.ok ? "PASS" : "FAIL", "-", r.detail);
    lines.push(`## ${s.id.toUpperCase()} — ${r.ok ? "PASS" : "FAIL"}`);
    lines.push(`Session: ${sessionId}`);
    lines.push(`Q: ${s.message}`);
    lines.push(`Detail: ${r.detail}`);
    lines.push("```");
    lines.push(r.excerpt);
    lines.push("```");
    lines.push("");
    if (!r.ok) failed++;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log("ERROR", msg);
    lines.push(`## ${s.id.toUpperCase()} — ERROR`);
    lines.push(msg);
    lines.push("");
    failed++;
  }
}

lines.push(`Summary: ${SCENARIOS.length - failed}/${SCENARIOS.length} passed`);
writeFileSync(OUT_PATH, lines.join("\n"), "utf8");
console.log("\nWrote:", OUT_PATH);
console.log(`Done: ${SCENARIOS.length - failed}/${SCENARIOS.length} passed`);
process.exit(failed ? 1 : 0);
