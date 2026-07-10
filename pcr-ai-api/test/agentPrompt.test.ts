import assert from "node:assert/strict";
import test from "node:test";
import { buildSystemPrompt, classifyIntent } from "../src/lib/agent/agentPrompt.js";

test("classifyIntent: combo/trend/bad-bin questions route to card_probe", () => {
  assert.equal(classifyIntent("这个device下最好的探针卡+机台组合是什么"), "card_probe");
  assert.equal(classifyIntent("探针卡表现排名"), "card_probe");
  assert.equal(classifyIntent("这张卡良率是不是在变差"), "card_probe");
  assert.equal(classifyIntent("这张卡常见坏bin是什么，是不是接触不良"), "card_probe");
  assert.equal(classifyIntent("哪个探针卡+测试机组合最佳搭配"), "card_probe");
});

test("buildSystemPrompt: card_probe intent includes the new tool name and guardrail", () => {
  const prompt = buildSystemPrompt(undefined, "card_probe");
  assert.ok(prompt.includes("aggregate_probe_card_tester_performance"));
  assert.ok(prompt.includes("边缘接触不良"), "must document the spatial-claim guardrail");
});

test("SEC_TERMS_AND_TOOLS tool list mentions the new tool", () => {
  const prompt = buildSystemPrompt(undefined, "general");
  assert.ok(prompt.includes("aggregate_probe_card_tester_performance"));
});
