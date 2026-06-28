// test/jbPreLlmDispatch.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickPreLlmRouteOld } from "../src/lib/agent/jbPreLlmDispatch.js";

test("equipment 单 lot 用卡 → equipment", () => {
  assert.equal(pickPreLlmRouteOld("DR44436.1W 用几号卡测试的", []), "equipment");
});
test("lot 列表口语 → lot_listing", () => {
  assert.equal(pickPreLlmRouteOld("WA01P14E 在 b3uflex24 近3个月测试的所有lot都列出来", []), "lot_listing");
});
test("多卡对比 → null(交回 LLM)", () => {
  assert.equal(pickPreLlmRouteOld("把这4张probecard的测试情况做对比", []), null);
});
