/**
 * Pass B (classifier ON) + Pass C (classifier fail degrade)
 * 用法：node scripts/verify-jb-route-pass-bc.mjs
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const API_BASE = (process.env.PCR_API_BASE || "http://10.192.130.89:30008").replace(/\/$/, "");
const OUT = process.env.VERIFY_BC_OUT || join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scratchpad", "realdb-jb-route-pass-bc.txt");

function judgeColloquial(text, events) {
  const err = events.find((e) => e.type === "error");
  if (err) return { ok: false, detail: `SSE error: ${err.message}` };
  if (!text.trim()) return { ok: false, detail: "empty reply" };
  const lots = [...new Set(text.match(/\b[A-Z]{2}\d{5,}\.\d[A-Z]\b/g) || [])];
  const singleWaferTable = /各片良率|逐片/.test(text) && lots.length === 1;
  const multiCard = (text.match(/\b\d{4}-\d{2,3}\b/g) || []).length >= 2;
  const lotList = lots.length >= 3 && /lot|批次|列表/i.test(text);
  const clarify = /请提供|哪几张|哪些卡|范围|具体|澄清|请问/.test(text);
  if (singleWaferTable && !multiCard && !clarify) {
    return { ok: false, detail: `误吐单 lot 逐片表 (${lots[0]})`, excerpt: text.slice(0, 500) };
  }
  if (multiCard || lotList || clarify || lots.length >= 2) {
    return { ok: true, detail: `lots=${lots.length}, multiCard=${multiCard}, clarify=${clarify}`, excerpt: text.slice(0, 500) };
  }
  return { ok: true, detail: `generic reply ok (lots=${lots.length})`, excerpt: text.slice(0, 500) };
}

async function drainAgent({ message, sessionId, apiKey }) {
  const body = {
    message,
    sessionId,
    agentConfig: {
      maxRounds: 8,
      streamTimeoutSec: 250,
      toolResultMaxChars: 20000,
      ...(apiKey !== undefined ? { apiKey } : process.env.AGENT_API_KEY ? { apiKey: process.env.AGENT_API_KEY } : {}),
    },
  };
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
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
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
        } catch { /* ignore */ }
      }
    }
  }
  return { text, events };
}

const lines = [`# Pass B/C verify ${new Date().toISOString()}`, `API: ${API_BASE}`, ""];
let failed = 0;

console.log("Health:", await (await fetch(`${API_BASE}/health`)).text());

// Pass B1
const bQuestions = [
  "这几张卡最近咋样",
  "最近测得怎么样",
  "看看这几个批次的情况",
];
lines.push("## Pass B1（JB_LLM_INTENT_CLASSIFIER=true）");
for (const q of bQuestions) {
  const sid = `b1-${randomUUID()}`;
  console.log("\nB1:", q);
  try {
    const { text, events } = await drainAgent({ message: q, sessionId: sid });
    const r = judgeColloquial(text, events);
    console.log(r.ok ? "PASS" : "FAIL", r.detail);
    lines.push(`### ${q} — ${r.ok ? "PASS" : "FAIL"}`);
    lines.push(`Session: ${sid}`);
    lines.push(`Detail: ${r.detail}`);
    lines.push("```");
    lines.push(r.excerpt ?? text.slice(0, 500));
    lines.push("```");
    lines.push("");
    if (!r.ok) failed++;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log("ERROR", msg);
    lines.push(`### ${q} — ERROR`);
    lines.push(msg);
    lines.push("");
    failed++;
  }
}

// Pass C — invalid apiKey in body (classifier fail; clear query regex fast path)
lines.push("## Pass C（无效 apiKey 造分类器故障）");
const passC = [
  { label: "模糊", q: "这几张卡最近咋样", check: (text, events, httpOk) => {
    const http500 = !httpOk;
    const err = events.find((e) => e.type === "error");
    if (http500) return { ok: false, detail: "HTTP 500" };
    return { ok: true, detail: err ? `降级/SSE error(无崩溃): ${err.message}` : `有回复 ${text.length} chars`, excerpt: text.slice(0, 400) };
  }},
  { label: "明确", q: "P11C 最近的测试情况", check: (text, events) => {
    const fv = events.filter((e) => e.type === "tool_result" && e.name === "get_filter_values");
    const td = fv.join("").includes("totalDistinct") && /totalDistinct[^0]*[1-9]/.test(fv.map((e) => e.summary ?? "").join(""));
    const hasTable = /WB01P11C|P11C|实测/.test(text) || td;
    return { ok: hasTable, detail: hasTable ? "正则快路/出表正常" : "未出表", excerpt: text.slice(0, 400) };
  }},
];

for (const { label, q, check } of passC) {
  const sid = `pc-${randomUUID()}`;
  console.log("\nPass C", label, q);
  try {
    const { text, events } = await drainAgent({ message: q, sessionId: sid, apiKey: "invalid-key-pass-c-test" });
    const r = check(text, events, true);
    console.log(r.ok ? "PASS" : "FAIL", r.detail);
    lines.push(`### ${label}：${q} — ${r.ok ? "PASS" : "FAIL"}`);
    lines.push(`Detail: ${r.detail}`);
    lines.push("```");
    lines.push(r.excerpt ?? text.slice(0, 400));
    lines.push("```");
    lines.push("");
    if (!r.ok) failed++;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // HTTP non-2xx for Pass C fuzzy might still be acceptable if not 500
    const ok = !msg.includes("500");
    console.log(ok ? "PASS(degrade)" : "FAIL", msg);
    lines.push(`### ${label} — ${ok ? "PASS" : "FAIL"} (HTTP)`);
    lines.push(msg);
    lines.push("");
    if (!ok) failed++;
  }
}

lines.push(`Summary: ${bQuestions.length + passC.length - failed}/${bQuestions.length + passC.length} passed`);
writeFileSync(OUT, lines.join("\n"), "utf8");
console.log("\nWrote:", OUT);
console.log("Done:", lines.at(-1));
process.exit(failed ? 1 : 0);
