import assert from "node:assert/strict";
import test from "node:test";

import {
  parseJsonLoose,
  isEnvTruthy,
  isProbeCardVeroPilotEnabled,
  isProbeCardVeroPilotReady,
  getVeroBaseUrl,
} from "../src/lib/vero/veroSimpleAgent.js";
import {
  normalizeProbeCardPerfArgs,
  tryRunProbeCardVeroPilot,
} from "../src/lib/agent/dispatch/directRoutes/agentProbeCardVeroPilot.js";
import type { AgentConfig } from "../src/lib/agent/agentConfig.js";
import type { AgentSseEvent } from "../src/lib/agent/core/agentLoop.js";

test("parseJsonLoose accepts raw, fenced, and sliced JSON", () => {
  assert.deepEqual(parseJsonLoose('{"action":"chat","reply":"hi"}'), {
    action: "chat",
    reply: "hi",
  });
  assert.deepEqual(
    parseJsonLoose('Here:\n```json\n{"action":"tool","tool":"x","args":{}}\n```'),
    { action: "tool", tool: "x", args: {} }
  );
  assert.deepEqual(parseJsonLoose('prefix {"a":1} trailing'), { a: 1 });
});

test("parseJsonLoose throws on non-JSON", () => {
  assert.throws(() => parseJsonLoose("not json at all"), /did not return JSON/);
});

test("isEnvTruthy / pilot flag helpers", () => {
  assert.equal(isEnvTruthy("true"), true);
  assert.equal(isEnvTruthy("1"), true);
  assert.equal(isEnvTruthy("yes"), true);
  assert.equal(isEnvTruthy("false"), false);
  assert.equal(isEnvTruthy(""), false);

  const prevFlag = process.env.AGENT_PROBE_CARD_VERO_PILOT;
  const prevToken = process.env.WCHAT_ACCESS_TOKEN;
  try {
    delete process.env.AGENT_PROBE_CARD_VERO_PILOT;
    delete process.env.WCHAT_ACCESS_TOKEN;
    assert.equal(isProbeCardVeroPilotEnabled(), false);
    assert.equal(isProbeCardVeroPilotReady(), false);

    process.env.AGENT_PROBE_CARD_VERO_PILOT = "true";
    assert.equal(isProbeCardVeroPilotEnabled(), true);
    assert.equal(isProbeCardVeroPilotReady(), false);

    process.env.WCHAT_ACCESS_TOKEN = "tok";
    assert.equal(isProbeCardVeroPilotReady(), true);
  } finally {
    if (prevFlag === undefined) delete process.env.AGENT_PROBE_CARD_VERO_PILOT;
    else process.env.AGENT_PROBE_CARD_VERO_PILOT = prevFlag;
    if (prevToken === undefined) delete process.env.WCHAT_ACCESS_TOKEN;
    else process.env.WCHAT_ACCESS_TOKEN = prevToken;
  }

  assert.ok(getVeroBaseUrl().includes("verostudio"));
});

test("normalizeProbeCardPerfArgs merges LLM args with regex fallbacks", () => {
  const fromLlm = normalizeProbeCardPerfArgs(
    { device: "WA03P02G", passId: 1 },
    "任意问法",
    []
  );
  assert.equal(fromLlm["device"], "WA03P02G");
  assert.equal(fromLlm["passId"], 1);

  const fromText = normalizeProbeCardPerfArgs(
    {},
    "WA03P02G 最好的探针卡和机台组合是哪个 pass1",
    []
  );
  assert.equal(fromText["device"], "WA03P02G");
  assert.equal(fromText["passId"], 1);
});

/**
 * Temporarily sets AGENT_PROBE_CARD_VERO_PILOT / WCHAT_ACCESS_TOKEN for the
 * duration of `fn`, restoring the previous values afterward. Mirrors the
 * withVeroFlag helper in test/agentBriefCommentary.test.ts — needed because
 * emitDeterministicProbeCardPerfReply's default branch independently
 * re-derives Vero-readiness via isProbeCardVeroPilotReady() (env-var-only),
 * regardless of any invokeVero mock injected into tryRunProbeCardVeroPilot.
 */
async function withVeroFlag<T>(
  enabled: boolean,
  token: string | undefined,
  fn: () => Promise<T>
): Promise<T> {
  const prevFlag = process.env.AGENT_PROBE_CARD_VERO_PILOT;
  const prevToken = process.env.WCHAT_ACCESS_TOKEN;
  process.env.AGENT_PROBE_CARD_VERO_PILOT = enabled ? "true" : "false";
  if (token === undefined) delete process.env.WCHAT_ACCESS_TOKEN;
  else process.env.WCHAT_ACCESS_TOKEN = token;
  try {
    return await fn();
  } finally {
    if (prevFlag === undefined) delete process.env.AGENT_PROBE_CARD_VERO_PILOT;
    else process.env.AGENT_PROBE_CARD_VERO_PILOT = prevFlag;
    if (prevToken === undefined) delete process.env.WCHAT_ACCESS_TOKEN;
    else process.env.WCHAT_ACCESS_TOKEN = prevToken;
  }
}

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

test("tryRunProbeCardVeroPilot handles chat action from mocked Vero", async () => {
  process.env["INFCONTROL_LAYER_BINS_DUMMY"] = "true";
  process.env["NODE_ENV"] = "test";

  const events: AgentSseEvent[] = [];
  const emit = (e: AgentSseEvent) => events.push(e);

  const ok = await tryRunProbeCardVeroPilot(
    `vero-pilot-chat-${Date.now()}`,
    "你好",
    stubConfig,
    emit,
    {
      invokeVero: async () =>
        JSON.stringify({ action: "chat", reply: "请提供 device 与探针卡问题。" }),
    }
  );
  assert.equal(ok, true);
  assert.ok(events.some((e) => e.type === "done"));
  const text = events
    .filter((e): e is Extract<AgentSseEvent, { type: "text" }> => e.type === "text")
    .map((e) => e.delta)
    .join("");
  assert.ok(text.includes("device"));
});

test("tryRunProbeCardVeroPilot extract→tool→tables→commentary with mocks", async () => {
  process.env["INFCONTROL_LAYER_BINS_DUMMY"] = "true";
  process.env["NODE_ENV"] = "test";

  await withVeroFlag(true, "tok", async () => {
    const events: AgentSseEvent[] = [];
    const emit = (e: AgentSseEvent) => events.push(e);
    let extractCalls = 0;
    let commentaryCalls = 0;

    const ok = await tryRunProbeCardVeroPilot(
      `vero-pilot-tool-${Date.now()}`,
      "WA03P02G 最好的探针卡和机台组合是哪个",
      stubConfig,
      emit,
      {
        invokeVero: async (prompt, systemPrompt) => {
          if (systemPrompt.includes("parameter extractor")) {
            extractCalls += 1;
            return JSON.stringify({
              action: "tool",
              tool: "aggregate_probe_card_tester_performance",
              args: { device: "WA03P02G", passId: 1 },
            });
          }
          commentaryCalls += 1;
          assert.ok(prompt.includes("实测数据") || prompt.includes("用户问题") || prompt.length > 50);
          return (
            "### 数据解读\n组合表现稳定。\n\n### 专业建议\n" +
            "1. Wafer Test：关注 pass1。\n" +
            "2. Probe Card：按排名优先用高置信卡。\n" +
            "3. DUT 维护：低良率卡做针尖检查。"
          );
        },
      }
    );
    assert.equal(ok, true);
    assert.equal(extractCalls, 1);
    assert.equal(commentaryCalls, 1);
    assert.ok(events.some((e) => e.type === "tool_start"));
    assert.ok(events.some((e) => e.type === "tool_result"));
    assert.ok(events.some((e) => e.type === "done"));
    const text = events
      .filter((e): e is Extract<AgentSseEvent, { type: "text" }> => e.type === "text")
      .map((e) => e.delta)
      .join("");
    assert.ok(text.includes("实测数据") || text.includes("一眼重点") || text.includes("组合"));
    assert.ok(text.includes("数据解读") || text.includes("分析结论") || text.includes("专业建议"));
  });
});

test("tryRunProbeCardVeroPilot returns false when extract fails (fallback path)", async () => {
  const events: AgentSseEvent[] = [];
  const ok = await tryRunProbeCardVeroPilot(
    `vero-pilot-fail-${Date.now()}`,
    "WA03P02G 探针卡机台组合",
    stubConfig,
    (e) => events.push(e),
    {
      invokeVero: async () => {
        throw new Error("vero down");
      },
    }
  );
  assert.equal(ok, false);
  assert.ok(!events.some((e) => e.type === "done"));
});
