import test from "node:test";
import assert from "node:assert/strict";
import { shouldRunDutAnalysis } from "../src/lib/agent/agentDutInsightTrigger.js";

test("user asking card-vs-process triggers", () => {
  assert.equal(shouldRunDutAnalysis("BIN11 是卡的问题还是工艺问题", {}), true);
});
test("user asking about DUT triggers", () => {
  assert.equal(shouldRunDutAnalysis("坏 die 集中在哪个 DUT", {}), true);
});
test("clustered bad bin alerts in payload triggers", () => {
  assert.equal(shouldRunDutAnalysis("DR43782.1A 测试情况", { clusteredBadBinAlerts: [{ bin: 11 }] }), true);
});
test("plain yield question with no alerts does not trigger", () => {
  assert.equal(shouldRunDutAnalysis("DR43782.1A 良率多少", { clusteredBadBinAlerts: [] }), false);
});
