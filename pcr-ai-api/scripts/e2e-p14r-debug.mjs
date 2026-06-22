/**
 * Agent E2E v2：捕获 tool_start 参数 + tool_result
 */
import { randomUUID } from "node:crypto";

const API_BASE = (process.argv[2] || "http://127.0.0.1:30018").replace(/\/$/, "");
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

const res = await fetch(`${API_BASE}/api/v4/agent/chat`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(420_000),
});

let buf = "", text = "";
const toolLog = [];

for await (const chunk of res.body) {
  buf += new TextDecoder().decode(chunk);
  const parts = buf.split("\n\n"); buf = parts.pop() ?? "";
  for (const block of parts) {
    for (const line of block.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const ev = JSON.parse(line.slice(6));
      if (ev.type === "text" && ev.delta) text += ev.delta;
      if (ev.type === "tool_start") toolLog.push({ name: ev.name, args: ev.args });
      if (ev.type === "tool_result" && ev.name === "query_jb_bins") {
        toolLog.push({ name: "query_jb_bins_result_snip", summary: ev.summary });
      }
      if (ev.type === "error") console.error("ERR:", ev.message);
    }
  }
}

console.log("=== Tool calls ===");
for (const t of toolLog) console.log(JSON.stringify(t, null, 2));
console.log("\n=== Answer ===\n", text);
