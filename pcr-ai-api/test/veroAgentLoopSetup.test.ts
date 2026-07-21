import assert from "node:assert/strict";
import test from "node:test";

import {
  summarizeHistoryViaVero,
  prepareRunVeroAgentLoopContext,
} from "../src/lib/agent/core/veroAgentLoopSetup.js";
import { clearHistory, appendMessages, getHistory, type ChatMessage } from "../src/lib/agent/agentHistory.js";
import type { AgentSseEvent } from "../src/lib/agent/core/agentLoop.js";

test("summarizeHistoryViaVero returns empty string for no content-bearing messages", async () => {
  const summary = await summarizeHistoryViaVero(
    [{ role: "tool", name: "x", content: "irrelevant" }],
    async () => "should not be called"
  );
  assert.equal(summary, "");
});

test("summarizeHistoryViaVero returns the invoked Vero text, trimmed", async () => {
  const history: ChatMessage[] = [
    { role: "user", content: "WA03P02G 良率如何" },
    { role: "assistant", content: "良率 95%" },
  ];
  const summary = await summarizeHistoryViaVero(
    history,
    async () => "  查询上下文：device=WA03P02G\n良率 95%  "
  );
  assert.equal(summary, "查询上下文：device=WA03P02G\n良率 95%");
});

test("summarizeHistoryViaVero is best-effort: returns '' when Vero throws", async () => {
  const history: ChatMessage[] = [{ role: "user", content: "hi" }];
  const summary = await summarizeHistoryViaVero(history, async () => {
    throw new Error("vero down");
  });
  assert.equal(summary, "");
});

test("prepareRunVeroAgentLoopContext appends the user message and fetches manifest", async () => {
  const sessionId = `vero-setup-${Date.now()}`;
  const events: AgentSseEvent[] = [];
  const { feedbackInjection, manifest } = await prepareRunVeroAgentLoopContext(
    "你好",
    sessionId,
    (e) => events.push(e),
    async () => "摘要"
  );
  assert.equal(typeof feedbackInjection, "string");
  assert.ok(manifest === undefined || typeof manifest === "object");
  assert.ok(events.some((e) => e.type === "status" && e.message.includes("系统信息")));
  assert.equal(getHistory(sessionId)[0]?.content, "你好");
  clearHistory(sessionId);
});

test("prepareRunVeroAgentLoopContext skips appending user message when resume=true", async () => {
  const sessionId = `vero-setup-resume-${Date.now()}`;
  appendMessages(sessionId, { role: "user", content: "第一条" });
  await prepareRunVeroAgentLoopContext(
    "第一条",
    sessionId,
    () => {},
    async () => "",
    { resume: true }
  );
  assert.equal(getHistory(sessionId).length, 1);
  clearHistory(sessionId);
});
