// test/jbIntentClassifier.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { callJbIntentClassifier } from "../src/lib/agent/jbIntentClassifier.js";

const cfg: any = { subAgentModel: "x", apiKey: "k" };

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
