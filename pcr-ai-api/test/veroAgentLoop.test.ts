import assert from "node:assert/strict";
import test from "node:test";

import { runVeroAgentLoop } from "../src/lib/agent/core/veroAgentLoop.js";
import { clearHistory } from "../src/lib/agent/agentHistory.js";
import type { AgentConfig } from "../src/lib/agent/agentConfig.js";
import type { AgentSseEvent } from "../src/lib/agent/core/agentLoop.js";

const stubConfig: AgentConfig = {
  apiKey: "test",
  apiBase: "http://example.invalid",
  model: "deepseek-ai/DeepSeek-V4-Flash",
  subAgentModel: "deepseek-ai/DeepSeek-V4-Flash",
  maxRounds: 3,
  streamTimeoutSec: 150,
  streamTimeoutMs: 150000,
  toolResultMaxChars: 12000,
  toolResultMaxHistoryChars: 8000,
  largeContext: false,
};

test("runVeroAgentLoop: tool round then final round", async () => {
  process.env["INFCONTROL_LAYER_BINS_DUMMY"] = "true";
  process.env["NODE_ENV"] = "test";
  const sessionId = `vero-loop-${Date.now()}`;
  const events: AgentSseEvent[] = [];
  let call = 0;

  // Deliberately entity-free question text (no device code / lot ID / card ID
  // / bin number, no "探针卡"+"机台"+"组合" combo phrasing): PRE_LLM_DIRECT_ROUTES
  // (reused unchanged from agentLoop.ts, including tryRunProbeCardPerfDirectRoute's
  // own combo-question heuristic) is keyed on specific identifiable entities —
  // see questionHasIdentifiableToolScope's examples in agentLoop.test.ts. A vague
  // question falls through all 15 routes so this mocked invoke is guaranteed to
  // be reached, regardless of what tool the mock itself decides to call.
  await runVeroAgentLoop(
    "帮我看一下最近的整体情况，随便分析一下",
    sessionId,
    stubConfig,
    (e) => events.push(e),
    undefined,
    {
      invoke: async () => {
        call += 1;
        if (call === 1) {
          return JSON.stringify({
            action: "tool",
            tool: "aggregate_probe_card_tester_performance",
            args: { device: "WA03P02G" },
          });
        }
        return JSON.stringify({ action: "final", reply: "组合表现：卡A + 机台1 良率最高。" });
      },
    }
  );

  assert.ok(events.some((e) => e.type === "tool_start"));
  assert.ok(events.some((e) => e.type === "tool_result"));
  assert.ok(events.some((e) => e.type === "done"));
  const text = events
    .filter((e): e is Extract<AgentSseEvent, { type: "text" }> => e.type === "text")
    .map((e) => e.delta)
    .join("");
  assert.ok(text.includes("良率最高"));
  clearHistory(sessionId);
});

test("runVeroAgentLoop: PRE_LLM_DIRECT_ROUTES does not re-run mid-turn after a tool call populates history (regression for code-review finding)", async () => {
  process.env["INFCONTROL_LAYER_BINS_DUMMY"] = "true";
  process.env["NODE_ENV"] = "test";
  const sessionId = `vero-loop-no-hijack-${Date.now()}`;
  const events: AgentSseEvent[] = [];
  let call = 0;

  // Round 1: entity-free question (see comment above), Vero calls a tool
  // whose args include device "WA03P02G". appendSyntheticToolTurn writes
  // this into history as an assistant tool_calls entry, which
  // inferDeviceFromHistory (agentQueryScope.ts) can pick up for ANY later
  // round's resolveJbListingScope call — even though the user's own text
  // never mentioned a device. Before the fix, PRE_LLM_DIRECT_ROUTES ran on
  // every round using getHistory(sessionId), so round 2 could newly satisfy
  // canRunLotListingDirectRoute purely from round 1's tool-call args and
  // short-circuit the turn via tryRunLotListingDirectRoute — even though the
  // old SiliconFlow loop only ever runs these routes once, before any tool
  // has executed (agentLoop.ts's `if (!awaitingSummary)` guard). The fix
  // mirrors that guard here. If it regresses, this test's second `invoke()`
  // call is skipped (hijacked by the direct route) and `call` never reaches 2.
  await runVeroAgentLoop(
    "帮我看一下最近的整体情况，随便分析一下",
    sessionId,
    stubConfig,
    (e) => events.push(e),
    undefined,
    {
      invoke: async () => {
        call += 1;
        if (call === 1) {
          return JSON.stringify({
            action: "tool",
            tool: "aggregate_probe_card_tester_performance",
            args: { device: "WA03P02G" },
          });
        }
        return JSON.stringify({ action: "final", reply: "第二轮 Vero 决策生效，未被直连路由劫持。" });
      },
    }
  );

  assert.equal(call, 2, "round 2 must reach invoke(), not be short-circuited by a direct route");
  const text = events
    .filter((e): e is Extract<AgentSseEvent, { type: "text" }> => e.type === "text")
    .map((e) => e.delta)
    .join("");
  assert.ok(text.includes("未被直连路由劫持"));
  clearHistory(sessionId);
});

test("runVeroAgentLoop: chat-only round finalizes without a tool call", async () => {
  const sessionId = `vero-loop-chat-${Date.now()}`;
  const events: AgentSseEvent[] = [];
  await runVeroAgentLoop(
    "你好",
    sessionId,
    stubConfig,
    (e) => events.push(e),
    undefined,
    { invoke: async () => JSON.stringify({ action: "chat", reply: "你好，请问需要查询什么？" }) }
  );
  assert.ok(events.some((e) => e.type === "done"));
  assert.ok(!events.some((e) => e.type === "tool_start"));
  clearHistory(sessionId);
});

test("runVeroAgentLoop: Vero failure emits an error event, no crash", async () => {
  const sessionId = `vero-loop-fail-${Date.now()}`;
  const events: AgentSseEvent[] = [];
  await runVeroAgentLoop(
    "任意问题",
    sessionId,
    stubConfig,
    (e) => events.push(e),
    undefined,
    {
      invoke: async () => {
        throw new Error("vero unreachable");
      },
    }
  );
  const errEvent = events.find((e) => e.type === "error");
  assert.ok(errEvent);
  assert.ok(String((errEvent as { message: string }).message).includes("Vero 调用失败"));
  clearHistory(sessionId);
});

test("runVeroAgentLoop: malformed JSON emits a parse-error event", async () => {
  const sessionId = `vero-loop-badjson-${Date.now()}`;
  const events: AgentSseEvent[] = [];
  await runVeroAgentLoop(
    "任意问题",
    sessionId,
    stubConfig,
    (e) => events.push(e),
    undefined,
    { invoke: async () => "not json at all" }
  );
  const errEvent = events.find((e) => e.type === "error");
  assert.ok(errEvent);
  assert.ok(String((errEvent as { message: string }).message).includes("无法解析"));
  clearHistory(sessionId);
});

test("runVeroAgentLoop: exhausting maxRounds after a tool ran falls back to a text summary, not a bare error", async () => {
  process.env["INFCONTROL_LAYER_BINS_DUMMY"] = "true";
  process.env["NODE_ENV"] = "test";
  const sessionId = `vero-loop-maxrounds-${Date.now()}`;
  const events: AgentSseEvent[] = [];
  const config: AgentConfig = { ...stubConfig, maxRounds: 1 };
  await runVeroAgentLoop(
    "随便问点什么，且不匹配任何 direct route",
    sessionId,
    config,
    (e) => events.push(e),
    undefined,
    {
      invoke: async () =>
        JSON.stringify({
          action: "tool",
          tool: "aggregate_probe_card_tester_performance",
          args: { device: "WA03P02G" },
        }),
    }
  );
  // A tool did run this turn (even though it never reached "final"), so the
  // loop must not show a bare error — it should summarize what ran and let
  // the user retry/narrow the question (design doc §3.3: "有数据就整理成
  // 文字，不生造内容").
  assert.ok(!events.some((e) => e.type === "error"));
  assert.ok(events.some((e) => e.type === "done"));
  const text = events
    .filter((e): e is Extract<AgentSseEvent, { type: "text" }> => e.type === "text")
    .map((e) => e.delta)
    .join("");
  assert.ok(text.includes("aggregate_probe_card_tester_performance"));
  assert.ok(text.includes("重试"));
  clearHistory(sessionId);
});

test("runVeroAgentLoop: maxRounds=0 (no round ever runs, no tool history) emits a bare error", async () => {
  const sessionId = `vero-loop-maxrounds-empty-${Date.now()}`;
  const events: AgentSseEvent[] = [];
  const zeroRoundConfig: AgentConfig = { ...stubConfig, maxRounds: 0 };
  await runVeroAgentLoop(
    "随便问点什么",
    sessionId,
    zeroRoundConfig,
    (e) => events.push(e),
    undefined,
    { invoke: async () => JSON.stringify({ action: "final", reply: "不会用到" }) }
  );
  // No round ran at all, so there is no tool history to summarize — this is
  // the one case with genuinely nothing to fall back on, so a plain error is
  // correct (contrast with the "ran a tool but hit maxRounds" case above).
  const errEvent = events.find((e) => e.type === "error");
  assert.ok(errEvent);
  assert.ok(String((errEvent as { message: string }).message).includes("最大轮数"));
  clearHistory(sessionId);
});
