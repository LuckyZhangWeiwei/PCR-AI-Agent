/**
 * 真实 E2E：生产 API + Oracle + SiliconFlow LLM
 * 用法：node scripts/e2e-agent-real.mjs "NF12316.1X 中 每一片的 yield"
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";

const API_BASE = (process.env.PCR_API_BASE || "http://10.192.130.89:30008").replace(
  /\/$/,
  ""
);
const MESSAGE =
  process.argv[2]?.trim() || "NF12316.1X 中 每一片的 yield";
const SESSION_ID = `e2e-${randomUUID()}`;

const body = {
  message: MESSAGE,
  sessionId: SESSION_ID,
  agentConfig: {
    model: process.env.AGENT_MODEL || "deepseek-ai/DeepSeek-V4-Pro",
    maxRounds: 10,
    streamTimeoutSec: 250,
    toolResultMaxChars: 20000,
    ...(process.env.AGENT_API_KEY
      ? { apiKey: process.env.AGENT_API_KEY }
      : {}),
  },
};

console.log("API:", API_BASE);
console.log("Question:", MESSAGE);
console.log("Session:", SESSION_ID);

const health = await fetch(`${API_BASE}/health`);
console.log("Health:", await health.text());

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
  console.error("HTTP", res.status, await res.text());
  process.exit(1);
}

const decoder = new TextDecoder();
let buf = "";
let text = "";
const events = [];
const statuses = [];

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
        if (ev.type === "status" && ev.message) statuses.push(ev.message);
        if (ev.type === "tool_start") statuses.push(`[tool] ${ev.name}`);
        if (ev.type === "error") console.error("\nERROR:", ev.message);
      } catch {
        /* ignore */
      }
    }
  }
}

const outPath = `scripts/e2e-last-${Date.now()}.txt`;
writeFileSync(
  outPath,
  [
    `Q: ${MESSAGE}`,
    `Session: ${SESSION_ID}`,
    "",
    "--- status ---",
    statuses.join("\n"),
    "",
    "--- assistant ---",
    text,
  ].join("\n"),
  "utf8"
);

console.log("\n--- SSE status trail ---");
for (const s of statuses) console.log(s);

console.log("\n--- Assistant (chars:", text.length, ") ---\n");
const preview = text.length > 12000 ? text.slice(0, 12000) + "\n…[truncated]" : text;
console.log(preview || "(empty)");
console.log("\nFull saved:", outPath);

const done = events.some((e) => e.type === "done");
const err = events.find((e) => e.type === "error");
console.log("\nDone:", done, err ? `Error: ${err.message}` : "");
process.exit(err || !text.trim() ? 1 : 0);
