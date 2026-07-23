import assert from "node:assert/strict";
import test from "node:test";

import { emitBriefCommentaryOrFallback } from "../src/lib/agent/render/agentBriefCommentary.js";
import { resolveAgentConfig } from "../src/lib/agent/agentConfig.js";
import type { AgentSseEvent } from "../src/lib/agent/core/agentLoop.js";
import { DETERMINISTIC_COMMENTARY_SECTION_TITLE } from "../src/lib/agent/jb/agentJbOverviewMarkdown.js";

const baseConfig = resolveAgentConfig({
  apiKey: "sk-test",
  apiBase: "https://api.siliconflow.cn/v1",
  model: "test-model",
  subAgentModel: "test-sub-model",
});

async function withVeroFlag<T>(
  enabled: boolean,
  token: string | undefined,
  fn: () => Promise<T>
): Promise<T> {
  const prevFlag = process.env.AGENT_VERO_GENERIC_LOOP;
  const prevToken = process.env.WCHAT_ACCESS_TOKEN;
  process.env.AGENT_VERO_GENERIC_LOOP = enabled ? "true" : "false";
  if (token === undefined) delete process.env.WCHAT_ACCESS_TOKEN;
  else process.env.WCHAT_ACCESS_TOKEN = token;
  try {
    return await fn();
  } finally {
    if (prevFlag === undefined) delete process.env.AGENT_VERO_GENERIC_LOOP;
    else process.env.AGENT_VERO_GENERIC_LOOP = prevFlag;
    if (prevToken === undefined) delete process.env.WCHAT_ACCESS_TOKEN;
    else process.env.WCHAT_ACCESS_TOKEN = prevToken;
  }
}

test("emitBriefCommentaryOrFallback: Vero ready + invoke returns text -> chunks it out, returns it, never touches SiliconFlow", async () => {
  await withVeroFlag(true, "tok", async () => {
    const events: AgentSseEvent[] = [];
    const result = await emitBriefCommentaryOrFallback(
      "问题",
      "| a | b |",
      { engineeringContext: "ctx" },
      baseConfig,
      (e) => events.push(e),
      { invoke: async () => "这是解读内容。" }
    );
    assert.equal(result, "这是解读内容。");
    assert.ok(events.some((e) => e.type === "status"));
    const text = events
      .filter((e): e is Extract<AgentSseEvent, { type: "text" }> => e.type === "text")
      .map((e) => e.delta)
      .join("");
    assert.ok(text.includes(DETERMINISTIC_COMMENTARY_SECTION_TITLE));
    assert.ok(text.includes("这是解读内容。"));
  });
});

test("emitBriefCommentaryOrFallback: Vero ready + invoke throws -> returns failure fallback text, includes the error message", async () => {
  await withVeroFlag(true, "tok", async () => {
    const result = await emitBriefCommentaryOrFallback(
      "问题",
      "| a | b |",
      {},
      baseConfig,
      () => {},
      {
        invoke: async () => {
          throw new Error("vero down");
        },
      }
    );
    assert.ok(result.includes("解读生成失败"));
    assert.ok(result.includes("vero down"));
  });
});

test("emitBriefCommentaryOrFallback: Vero ready + invoke returns empty/whitespace -> returns empty fallback text", async () => {
  await withVeroFlag(true, "tok", async () => {
    const result = await emitBriefCommentaryOrFallback(
      "问题",
      "| a | b |",
      {},
      baseConfig,
      () => {},
      { invoke: async () => "   " }
    );
    assert.ok(result.includes("模型未返回解读"));
  });
});

test("emitBriefCommentaryOrFallback: Vero not ready -> never calls invoke, falls back to the SiliconFlow path", async () => {
  await withVeroFlag(false, undefined, async () => {
    let invokeCalled = false;
    const events: AgentSseEvent[] = [];
    // Point apiBase at an unroutable host with a short timeout so the
    // SiliconFlow branch resolves quickly through its own error handling
    // (the wire-level behavior of streamSiliconFlow itself is already
    // covered end-to-end by agentStream.test.ts) — this test only needs to
    // prove the Vero invoke path is never reached when the flag is off.
    const config = resolveAgentConfig({
      apiKey: "sk-test",
      apiBase: "https://127.0.0.1:1",
      model: "test-model",
      subAgentModel: "test-sub-model",
      streamTimeoutMs: 200,
    });
    const result = await emitBriefCommentaryOrFallback(
      "问题",
      "| a | b |",
      {},
      config,
      (e) => events.push(e),
      {
        invoke: async () => {
          invokeCalled = true;
          return "should not be called";
        },
      }
    );
    assert.equal(invokeCalled, false);
    assert.ok(result.length > 0);
    assert.ok(events.some((e) => e.type === "status"));
  });
});

test("emitBriefCommentaryOrFallback: systemPrompt override is used in the Vero branch instead of BRIEF_COMMENTARY_SYSTEM", async () => {
  await withVeroFlag(true, "tok", async () => {
    let sawCustomSystemInMessage = false;
    await emitBriefCommentaryOrFallback(
      "问题",
      "| a | b |",
      {},
      baseConfig,
      () => {},
      {
        systemPrompt: "CUSTOM_PROBE_CARD_SYSTEM_MARKER",
        invoke: async (message) => {
          sawCustomSystemInMessage = message.includes("CUSTOM_PROBE_CARD_SYSTEM_MARKER");
          return "解读文本。";
        },
      }
    );
    assert.ok(sawCustomSystemInMessage, "systemPrompt override must reach the Vero invoke call");
  });
});

test("emitBriefCommentaryOrFallback: alsoReadyWhen()=true routes to Vero even when AGENT_VERO_GENERIC_LOOP is off", async () => {
  await withVeroFlag(false, "tok", async () => {
    let invokeCalled = false;
    const result = await emitBriefCommentaryOrFallback(
      "问题",
      "| a | b |",
      {},
      baseConfig,
      () => {},
      {
        alsoReadyWhen: () => true,
        invoke: async () => {
          invokeCalled = true;
          return "解读文本。";
        },
      }
    );
    assert.equal(invokeCalled, true, "alsoReadyWhen()=true must force the Vero branch");
    assert.equal(result, "解读文本。");
  });
});

test("emitBriefCommentaryOrFallback: alsoReadyWhen()=false and AGENT_VERO_GENERIC_LOOP off -> still falls back to SiliconFlow", async () => {
  await withVeroFlag(false, undefined, async () => {
    let invokeCalled = false;
    const config = resolveAgentConfig({
      apiKey: "sk-test",
      apiBase: "https://127.0.0.1:1",
      model: "test-model",
      subAgentModel: "test-sub-model",
      streamTimeoutMs: 200,
    });
    const result = await emitBriefCommentaryOrFallback(
      "问题",
      "| a | b |",
      {},
      config,
      () => {},
      {
        alsoReadyWhen: () => false,
        invoke: async () => {
          invokeCalled = true;
          return "should not be called";
        },
      }
    );
    assert.equal(invokeCalled, false);
    assert.ok(result.length > 0);
  });
});
