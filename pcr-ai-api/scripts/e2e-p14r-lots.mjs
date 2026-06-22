/**
 * Agent E2E：列出P14R 最近两个月测试的所有lot
 *   node scripts/e2e-p14r-lots.mjs [API_BASE]
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";

const API_BASE = (process.argv[2] || process.env.PCR_API_BASE || "http://127.0.0.1:30018").replace(/\/$/, "");
const MESSAGE = "列出P14R 最近两个月测试的所有lot";
const SESSION_ID = `e2e-p14r-${randomUUID()}`;

const body = {
  message: MESSAGE,
  sessionId: SESSION_ID,
  agentConfig: {
    model: process.env.AGENT_MODEL || "deepseek-ai/DeepSeek-V4-Pro",
    maxRounds: 8,
    streamTimeoutSec: 300,
    toolResultMaxChars: 30000,
    ...(process.env.AGENT_API_KEY ? { apiKey: process.env.AGENT_API_KEY } : {}),
  },
};

console.log("API:", API_BASE);
console.log("Question:", MESSAGE);

const res = await fetch(`${API_BASE}/api/v4/agent/chat`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(420_000),
});

if (!res.ok) {
  console.error("HTTP", res.status, await res.text());
  process.exit(1);
}

let buf = "";
let text = "";
const tools = [];
let jbLots = null;
let jbTotal = null;
let ymLots = null;

for await (const chunk of res.body) {
  buf += new TextDecoder().decode(chunk);
  const parts = buf.split("\n\n");
  buf = parts.pop() ?? "";
  for (const block of parts) {
    for (const line of block.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const ev = JSON.parse(line.slice(6));
      if (ev.type === "text" && ev.delta) text += ev.delta;
      if (ev.type === "tool_start") tools.push(ev.name);
      if (ev.type === "tool_end") {
        if (ev.name === "query_jb_bins") {
          try {
            const j = JSON.parse(ev.result);
            jbTotal = j.totalDistinctLots ?? j.distinctLotCount;
            jbLots = (j.recentLotsByTestEnd ?? []).map((x) => x.lot);
          } catch {
            /* compact cache */
          }
        }
        if (ev.name === "query_yield_triggers") {
          try {
            const j = JSON.parse(ev.result);
            ymLots = [
              ...new Set(
                (j.rows ?? [])
                  .map((r) => String(r.LOTID ?? r.lotId ?? "").trim())
                  .filter(Boolean)
              ),
            ];
          } catch {}
        }
      }
      if (ev.type === "error") console.error("\nERROR:", ev.message);
    }
  }
}

console.log("\nTools:", tools.join(" → "));
if (jbTotal != null) {
  console.log(`JB totalDistinctLots: ${jbTotal}`);
  console.log(`JB lots (${jbLots?.length ?? 0}):`, jbLots?.join(", "));
}
if (ymLots) console.log(`YM lots (${ymLots.length}):`, ymLots.join(", "));

console.log("\n--- Assistant ---\n");
console.log(text || "(empty)");

const expectLots = [
  "DR45679.1J",
  "DR45160.1A",
  "DR44943.1W",
  "DR45159.1J",
  "DR44944.1L",
  "DR44716.44N",
  "DR44716.1R",
  "DR44714.1H",
  "DR44942.1C",
  "DR44715.1Y",
];

const jbOk = jbTotal === 10;
const answerMentions10 =
  /10\s*个\s*lot|共\s*10|10\s*个批次|10\s*个/i.test(text) ||
  expectLots.filter((l) => text.includes(l)).length >= 8;

writeFileSync("scripts/e2e-p14r-last.txt", text, "utf8");
console.log("\n--- Check ---");
console.log("JB tool returned 10 lots:", jbOk ? "PASS" : `FAIL (${jbTotal})`);
console.log("Answer lists ~10 lots:", answerMentions10 ? "PASS" : "FAIL");

process.exit(jbOk && text.trim() && answerMentions10 ? 0 : 1);
