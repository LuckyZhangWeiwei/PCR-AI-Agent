// test/jbIntentClassifier.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { callJbIntentClassifier } from "../src/lib/agent/jbIntentClassifier.js";
import { resolveAgentConfig } from "../src/lib/agent/agentConfig.js";

const cfg: any = { subAgentModel: "x", apiKey: "k" };

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

test("解析合法 JSON → mode+params", async () => {
  const chat = async () => '{"mode":"equipment","confidence":"high","focusBin":null}';
  const r = await callJbIntentClassifier("这片用啥卡", {}, cfg, { chat });
  assert.equal(r?.mode, "equipment");
});

test("未知 mode → null", async () => {
  const chat = async () => '{"mode":"nonsense"}';
  const r = await callJbIntentClassifier("x", {}, cfg, { chat });
  assert.equal(r, null);
});

test("非法 JSON → null", async () => {
  const chat = async () => "not json";
  const r = await callJbIntentClassifier("x", {}, cfg, { chat });
  assert.equal(r, null);
});

test("no chat override, Vero ready -> default classifier routes through Vero (deps.invokeVero), never falls back to SiliconFlow", async () => {
  await withVeroFlag(true, "tok", async () => {
    let veroInvokeCalled = false;
    const r = await callJbIntentClassifier("这片用啥卡", {}, cfg, {
      invokeVero: async () => {
        veroInvokeCalled = true;
        return '{"mode":"equipment","confidence":"high","focusBin":null}';
      },
    });
    assert.equal(
      veroInvokeCalled,
      true,
      "default classifier chat must route through Vero when the generic loop is ready"
    );
    assert.equal(r?.mode, "equipment");
  });
});

test("no chat override, Vero not ready -> default classifier never calls invokeVero (falls back to the SiliconFlow path)", async () => {
  await withVeroFlag(false, undefined, async () => {
    let veroInvokeCalled = false;
    const config = resolveAgentConfig({
      apiKey: "sk-test",
      apiBase: "https://127.0.0.1:1",
      model: "test-model",
      subAgentModel: "test-sub-model",
      streamTimeoutMs: 200,
    });
    await callJbIntentClassifier("这片用啥卡", {}, config, {
      invokeVero: async () => {
        veroInvokeCalled = true;
        return "should not be called";
      },
    });
    assert.equal(veroInvokeCalled, false);
  });
});
