import assert from "node:assert/strict";
import test from "node:test";

import { executeVeroToolDecision } from "../src/lib/agent/core/veroAgentToolExecutor.js";
import { clearHistory, getHistory } from "../src/lib/agent/agentHistory.js";
import type { AgentConfig } from "../src/lib/agent/agentConfig.js";
import type { AgentSseEvent } from "../src/lib/agent/core/agentLoop.js";
import type { VeroToolDecision } from "../src/lib/agent/core/veroAgentProtocol.js";

const stubConfig: AgentConfig = {
  apiKey: "test",
  apiBase: "http://example.invalid",
  model: "deepseek-ai/DeepSeek-V4-Flash",
  subAgentModel: "deepseek-ai/DeepSeek-V4-Flash",
  maxRounds: 5,
  streamTimeoutSec: 150,
  streamTimeoutMs: 150000,
  toolResultMaxChars: 12000,
  toolResultMaxHistoryChars: 8000,
  largeContext: false,
};

test("executeVeroToolDecision runs a normal tool and appends synthetic history", async () => {
  process.env["INFCONTROL_LAYER_BINS_DUMMY"] = "true";
  process.env["NODE_ENV"] = "test";
  const sessionId = `vero-tool-ok-${Date.now()}`;
  const events: AgentSseEvent[] = [];
  const decision: VeroToolDecision = {
    action: "tool",
    tool: "aggregate_probe_card_tester_performance",
    args: { device: "WA03P02G" },
  };
  const outcome = await executeVeroToolDecision(
    sessionId,
    decision,
    stubConfig,
    (e) => events.push(e),
    "WA03P02G 探针卡机台组合表现"
  );
  assert.equal(outcome, "ok");
  assert.ok(events.some((e) => e.type === "tool_start"));
  assert.ok(events.some((e) => e.type === "tool_result"));
  const history = getHistory(sessionId);
  assert.equal(history.length, 2);
  assert.equal(history[0].role, "assistant");
  assert.equal(history[1].role, "tool");
  clearHistory(sessionId);
});

test("executeVeroToolDecision returns 'chart' and emits a chart SSE event", async () => {
  const sessionId = `vero-tool-chart-${Date.now()}`;
  const events: AgentSseEvent[] = [];
  const decision: VeroToolDecision = {
    action: "tool",
    tool: "generate_chart",
    args: {
      chartType: "bar",
      title: "Device Triggers",
      data: { labels: ["WA03P02G", "WB04P02G"], series: [{ name: "Count", values: [42, 18] }] },
    },
  };
  const outcome = await executeVeroToolDecision(sessionId, decision, stubConfig, (e) => events.push(e), "画个图");
  assert.equal(outcome, "chart");
  assert.ok(events.some((e) => e.type === "chart"));
  const history = getHistory(sessionId);
  assert.equal(String(history[1].content), "[图表已生成]");
  clearHistory(sessionId);
});

test("executeVeroToolDecision returns 'clarification' and emits a clarification SSE event", async () => {
  const sessionId = `vero-tool-clar-${Date.now()}`;
  const events: AgentSseEvent[] = [];
  const decision: VeroToolDecision = {
    action: "tool",
    tool: "ask_clarification",
    args: { question: "请提供 device 或 lot", options: ["device", "lot"] },
  };
  const outcome = await executeVeroToolDecision(sessionId, decision, stubConfig, (e) => events.push(e), "帮我查一下");
  assert.equal(outcome, "clarification");
  const clarEvent = events.find((e) => e.type === "clarification");
  assert.ok(clarEvent);
  clearHistory(sessionId);
});
