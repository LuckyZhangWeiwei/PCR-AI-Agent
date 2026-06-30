/**
 * 步骤 2：JB_DETERMINISTIC_DISPATCH=true + JB_LLM_INTENT_CLASSIFIER=false
 * FLIP Test A（派发）+ A2（不误伤）
 *
 * 用法：node scripts/verify-step2-dispatch.mjs [a1|a2|all]
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dir, "..", "..");
const API_BASE = (process.env.PCR_API_BASE || "http://10.192.130.89:30008").replace(/\/$/, "");
const STEP = (process.argv[2] || "all").toLowerCase();
const OUT_PATH =
  process.env.VERIFY_OUT || join(REPO_ROOT, "scratchpad", "step2-dispatch-2026-06-30.txt");

function agentConfig() {
  return {
    maxRounds: 8,
    streamTimeoutSec: 250,
    toolResultMaxChars: 20000,
    ...(process.env.AGENT_API_KEY ? { apiKey: process.env.AGENT_API_KEY } : {}),
  };
}

async function drainAgent({ sessionId, message, setup = [] }) {
  const cfg = agentConfig();
  for (const msg of setup) {
    await postChat({ sessionId, message: msg, agentConfig: cfg });
  }
  return postChat({ sessionId, message, agentConfig: cfg });
}

async function postChat(body) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 360_000);
  let res;
  try {
    res = await fetch(`${API_BASE}/api/v4/agent/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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

function firstTool(events) {
  const start = events.find((e) => e.type === "tool_start");
  const calls = events.filter((e) => e.type === "tool_call" || e.type === "tool_calls");
  return {
    start,
    dispatchStatus: events.some(
      (e) => e.type === "status" && String(e.message ?? "").includes("直发查询")
    ),
    allStarts: events.filter((e) => e.type === "tool_start").map((e) => ({
      name: e.name,
      args: e.args,
    })),
  };
}

function hasBinCardTable(text) {
  const cards = [...new Set([...(text.match(/\b\d{4}-\d{2,3}\b/g) || [])])];
  const bin35 = /BIN\s*35|bin35/i.test(text);
  const table = /\|.*卡|探针卡|cardId/i.test(text) || cards.length >= 2;
  return { cards, bin35, table, cardCount: cards.length };
}

const A1 = {
  "a1-1": {
    label: "A1-1 n55z 哪个卡 bin35 多 → aggregate bin×card",
    message: "n55z 哪个卡测出bin35 多",
    check(events, text) {
      const { start, dispatchStatus, allStarts } = firstTool(events);
      const { cards, bin35, table, cardCount } = hasBinCardTable(text);
      const agg = start?.name === "aggregate_jb_bins";
      const groupBy = String(JSON.stringify(start?.args ?? "")).includes("cardId");
      const singleLotWafer = /逐片|各片良率/.test(text) && cardCount < 2;
      if (singleLotWafer) {
        return { ok: false, detail: "single-lot wafer table (dispatch miss)", excerpt: text.slice(0, 600) };
      }
      if (agg && groupBy && (bin35 || table)) {
        return {
          ok: true,
          detail: `dispatch=${dispatchStatus} tool=${start?.name} groupBy ok cards=${cardCount}`,
          excerpt: text.slice(0, 600),
          tools: allStarts,
        };
      }
      return {
        ok: agg || (table && bin35),
        detail: `dispatch=${dispatchStatus} first=${start?.name ?? "none"} groupByCard=${groupBy} bin35=${bin35} cards=${cardCount}`,
        excerpt: text.slice(0, 600),
        tools: allStarts,
      };
    },
  },
  "a1-2": {
    label: "A1-2 BIN35 集中在哪张卡",
    message: "BIN35 集中在哪张卡",
    setup: [{ role: "user", content: "n55z 最近测试情况" }],
    async run() {
      const sessionId = `a12-${randomUUID()}`;
      const { events, text, err } = await drainAgent({
        sessionId,
        message: "BIN35 集中在哪张卡",
        setup: ["n55z 最近测试情况"],
      });
      return { sessionId, events, text, err };
    },
    check(events, text) {
      const { start, dispatchStatus } = firstTool(events);
      const { cards, bin35 } = hasBinCardTable(text);
      const ok = (start?.name === "aggregate_jb_bins" || cards.length >= 2) && bin35;
      return {
        ok,
        detail: `dispatch=${dispatchStatus} first=${start?.name ?? "none"} cards=${cards.join(",") || "none"}`,
        excerpt: text.slice(0, 600),
      };
    },
  },
  "a1-4": {
    label: "A1-4 WC13N55Z 各 lot 良率 top5",
    message: "WC13N55Z 各 lot 良率 top5",
    check(events, text) {
      const { start, dispatchStatus } = firstTool(events);
      const lots = [...new Set(text.match(/\b[A-Z]{2}\d{5,}\.\d[A-Z]\b/g) || [])];
      const yieldTable = /良率|yield/i.test(text) && lots.length >= 2;
      const ok =
        start?.name === "query_jb_bins" ||
        (yieldTable && lots.length >= 2);
      return {
        ok,
        detail: `dispatch=${dispatchStatus} first=${start?.name ?? "none"} lots=${lots.length}`,
        excerpt: text.slice(0, 600),
      };
    },
  },
};

const A2 = {
  "a2-1": {
    label: "A2-1 单 lot 概况不误伤",
    message: "NF13338.1K 概况",
    check(events, text) {
      const { start } = firstTool(events);
      const overview = /概况|良率|lot/i.test(text);
      const wrongAgg = start?.name === "aggregate_jb_bins" && String(JSON.stringify(start?.args ?? "")).includes("cardId");
      if (wrongAgg) {
        return { ok: false, detail: "lot overview hijacked by bin×card aggregate", excerpt: text.slice(0, 400) };
      }
      return {
        ok: overview,
        detail: `first=${start?.name ?? "none"} overview=${overview}`,
        excerpt: text.slice(0, 500),
      };
    },
  },
  "a2-4": {
    label: "A2-4 不存在 mask bin99 优雅回落",
    message: "ZZZZZ 哪个卡测出bin99 多",
    check(events, text) {
      const err = events.find((e) => e.type === "error");
      if (err) {
        return { ok: false, detail: `SSE error: ${err.message}`, excerpt: text.slice(0, 300) };
      }
      const emptyHint = /无数据|没有|未找到|0\s*条|空/i.test(text);
      const hasText = text.trim().length > 20;
      return {
        ok: hasText && !/^\s*$/.test(text),
        detail: hasText ? `reply ok emptyHint=${emptyHint}` : "blank reply (dead-end)",
        excerpt: text.slice(0, 500),
      };
    },
  },
};

async function runCase(key, scenario) {
  const sessionId = `${key}-${randomUUID()}`;
  console.log(`\n=== ${key.toUpperCase()}: ${scenario.label} ===`);
  console.log("Session:", sessionId);

  let events, text, err;
  if (scenario.run) {
    const r = await scenario.run();
    ({ events, text, err } = r);
  } else {
    if (scenario.setup?.length) {
      for (const s of scenario.setup) {
        console.log("  [setup]", typeof s === "string" ? s : s.content);
        await drainAgent({
          sessionId,
          message: typeof s === "string" ? s : s.content,
        });
      }
    }
    console.log("  [check]", scenario.message);
    ({ events, text, err } = await drainAgent({ sessionId, message: scenario.message }));
  }

  if (err) console.log("  error event:", err);
  const result = scenario.check(events, text);
  console.log(result.ok ? "PASS" : "FAIL", "-", result.detail);
  return { key, sessionId, ok: result.ok, detail: result.detail, excerpt: result.excerpt ?? "", tools: result.tools };
}

const groups = {
  a1: Object.entries(A1),
  a2: Object.entries(A2),
  all: [...Object.entries(A1), ...Object.entries(A2)],
};

const entries = groups[STEP] ?? groups.all;
if (!entries.length) {
  console.error("Use a1|a2|all");
  process.exit(2);
}

console.log("API:", API_BASE);
console.log("Health:", await (await fetch(`${API_BASE}/health`)).text());

const lines = [
  `# Step 2 dispatch verify ${new Date().toISOString()}`,
  `API: ${API_BASE}`,
  `STEP: ${STEP}`,
  `Expected: JB_DETERMINISTIC_DISPATCH=true, JB_LLM_INTENT_CLASSIFIER=false`,
  "",
];

let failed = 0;
for (const [key, scenario] of entries) {
  try {
    const r = await runCase(key, scenario);
    lines.push(`## ${key.toUpperCase()} — ${r.ok ? "PASS" : "FAIL"}`);
    lines.push(`Session: ${r.sessionId}`);
    lines.push(`Detail: ${r.detail}`);
    if (r.tools) lines.push(`Tools: ${JSON.stringify(r.tools)}`);
    lines.push("```");
    lines.push(r.excerpt);
    lines.push("```");
    lines.push("");
    if (!r.ok) failed++;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log("ERROR", msg);
    lines.push(`## ${key.toUpperCase()} — ERROR`);
    lines.push(msg);
    lines.push("");
    failed++;
  }
}

lines.push(`Summary: ${entries.length - failed}/${entries.length} passed`);
writeFileSync(OUT_PATH, lines.join("\n"), "utf8");
console.log("\nWrote:", OUT_PATH);
console.log(`Done: ${entries.length - failed}/${entries.length} passed`);
process.exit(failed ? 1 : 0);
