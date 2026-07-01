import assert from "node:assert/strict";
import test from "node:test";
import {
  canRunMaskScopeDirectRoute,
  maskScopeFilterValuesArgs,
  maskScopeJbQueryArgs,
} from "../src/lib/agent/agentJbMaskScopeRoute.js";

test("canRunMaskScopeDirectRoute: P11C 测试情况", () => {
  assert.ok(canRunMaskScopeDirectRoute("P11C 最近的测试情况"));
  assert.ok(!canRunMaskScopeDirectRoute("NF13338.1K 概况"));
  assert.ok(!canRunMaskScopeDirectRoute("这几张卡最近咋样"));
});

test("maskScopeFilterValuesArgs / maskScopeJbQueryArgs", () => {
  const q = "P11C 最近的测试情况";
  assert.deepEqual(maskScopeFilterValuesArgs(q), {
    domain: "both",
    field: "device",
    mask: "P11C",
    limit: 10,
  });
  const jb = maskScopeJbQueryArgs(q);
  assert.equal(jb?.["mask"], "P11C");
  assert.equal(jb?.["limit"], 200);
});
