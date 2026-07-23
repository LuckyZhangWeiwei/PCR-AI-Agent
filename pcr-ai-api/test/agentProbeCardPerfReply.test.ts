import assert from "node:assert/strict";
import test from "node:test";

import { emitDeterministicProbeCardPerfReply } from "../src/lib/agent/render/agentProbeCardPerfReply.js";
import { resolveAgentConfig } from "../src/lib/agent/agentConfig.js";
import type { AgentSseEvent } from "../src/lib/agent/core/agentLoop.js";

const baseConfig = resolveAgentConfig({
  apiKey: "sk-test",
  apiBase: "https://api.siliconflow.cn/v1",
  model: "test-model",
  subAgentModel: "test-sub-model",
});

async function withEnv<T>(
  vars: Record<string, string | undefined>,
  fn: () => Promise<T>
): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const samplePayload = {
  device: "WA03P02G",
  groups: [
    {
      passId: 1,
      comboRanking: [],
      cardRanking: [],
      comboRankingMarkdown: "| combo | yield |\n|---|---|\n| A | 99% |",
    },
  ],
};

test("emitDeterministicProbeCardPerfReply: default branch (no invokeCommentary/streamCommentary) uses Vero when AGENT_VERO_GENERIC_LOOP is ready, via veroInvoke seam", async () => {
  await withEnv(
    { AGENT_VERO_GENERIC_LOOP: "true", WCHAT_ACCESS_TOKEN: "tok", AGENT_PROBE_CARD_VERO_PILOT: undefined },
    async () => {
      const events: AgentSseEvent[] = [];
      let veroInvokeCalled = false;
      const ok = await emitDeterministicProbeCardPerfReply(
        `probe-card-perf-reply-${Date.now()}`,
        "WA03P02G 最好的探针卡+机台组合",
        samplePayload,
        baseConfig,
        (e) => events.push(e),
        {
          veroInvoke: async () => {
            veroInvokeCalled = true;
            return "探针卡组合表现稳定。";
          },
        }
      );
      assert.equal(ok, true);
      assert.equal(veroInvokeCalled, true, "default branch must route through Vero via the veroInvoke seam when the generic loop is ready");
      const text = events
        .filter((e): e is Extract<AgentSseEvent, { type: "text" }> => e.type === "text")
        .map((e) => e.delta)
        .join("");
      assert.ok(text.includes("探针卡组合表现稳定"));
    }
  );
});

test("emitDeterministicProbeCardPerfReply: default branch uses Vero when only AGENT_PROBE_CARD_VERO_PILOT is ready (AGENT_VERO_GENERIC_LOOP off)", async () => {
  await withEnv(
    { AGENT_VERO_GENERIC_LOOP: "false", AGENT_PROBE_CARD_VERO_PILOT: "true", WCHAT_ACCESS_TOKEN: "tok" },
    async () => {
      const events: AgentSseEvent[] = [];
      let veroInvokeCalled = false;
      const ok = await emitDeterministicProbeCardPerfReply(
        `probe-card-perf-reply-${Date.now()}`,
        "WA03P02G 最好的探针卡+机台组合",
        samplePayload,
        baseConfig,
        (e) => events.push(e),
        {
          veroInvoke: async () => {
            veroInvokeCalled = true;
            return "探针卡组合表现稳定。";
          },
        }
      );
      assert.equal(ok, true);
      assert.equal(
        veroInvokeCalled,
        true,
        "AGENT_PROBE_CARD_VERO_PILOT=true alone must be enough to route commentary through Vero, even with AGENT_VERO_GENERIC_LOOP off — no regression for Path-B-only deployments"
      );
    }
  );
});

test("emitDeterministicProbeCardPerfReply: neither flag ready -> falls back to SiliconFlow, never calls veroInvoke", async () => {
  await withEnv(
    { AGENT_VERO_GENERIC_LOOP: "false", AGENT_PROBE_CARD_VERO_PILOT: undefined, WCHAT_ACCESS_TOKEN: undefined },
    async () => {
      const events: AgentSseEvent[] = [];
      let veroInvokeCalled = false;
      const config = resolveAgentConfig({
        apiKey: "sk-test",
        apiBase: "https://127.0.0.1:1",
        model: "test-model",
        subAgentModel: "test-sub-model",
        streamTimeoutMs: 200,
      });
      const ok = await emitDeterministicProbeCardPerfReply(
        `probe-card-perf-reply-${Date.now()}`,
        "WA03P02G 最好的探针卡+机台组合",
        samplePayload,
        config,
        (e) => events.push(e),
        {
          veroInvoke: async () => {
            veroInvokeCalled = true;
            return "should not be called";
          },
        }
      );
      assert.equal(ok, true);
      assert.equal(veroInvokeCalled, false);
    }
  );
});
