import assert from "node:assert/strict";
import test from "node:test";

process.env["INFCONTROL_LAYER_BINS_DUMMY"] = "true";
process.env["NODE_ENV"] = "test";

import { runTool } from "../src/lib/agent/agentToolHandlers.js";

test("aggregate_probe_card_tester_performance requires device or mask", async () => {
  const out = await runTool("aggregate_probe_card_tester_performance", {});
  assert.equal(typeof out, "string");
  assert.ok((out as string).includes("device 或 mask"));
});

test("aggregate_probe_card_tester_performance returns grouped markdown tables for a known dummy device", async () => {
  const out = (await runTool("aggregate_probe_card_tester_performance", {
    device: "WA03P02G",
  })) as string;
  assert.equal(typeof out, "string");
  assert.ok(!out.startsWith("aggregate_probe_card_tester_performance 参数错误"));
  const parsed = JSON.parse(out);
  assert.equal(parsed.device, "WA03P02G");
  assert.ok(Array.isArray(parsed.groups));
  if (parsed.groups.length > 0) {
    const g = parsed.groups[0];
    assert.ok([1, 3, 5].includes(g.passId));
    assert.ok(typeof g.comboRankingMarkdown === "string");
    assert.ok(typeof g.cardRankingMarkdown === "string");
    assert.ok(typeof g.cardTrendMarkdown === "string");
    assert.ok(typeof g.cardBadBinMarkdown === "string");
  }
});

test("aggregate_probe_card_tester_performance with passId only returns that pass", async () => {
  const out = (await runTool("aggregate_probe_card_tester_performance", {
    device: "WA03P02G",
    passId: 1,
  })) as string;
  const parsed = JSON.parse(out);
  for (const g of parsed.groups) {
    assert.equal(g.passId, 1);
  }
});
