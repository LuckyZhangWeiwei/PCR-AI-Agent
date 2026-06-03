import assert from "node:assert/strict";
import test from "node:test";
import { userWantsDutBinRelationMap } from "../src/lib/agent/agentDutBinMapRoute.js";
import { userWantsWaferMapOnly } from "../src/lib/agent/agentInfWaferMapTool.js";

test("DUT×BIN relation vs plain BIN highlight wafermap", () => {
  const q = "画出 bin15 和 相关dut 的关系 的wafermap";
  assert.equal(userWantsDutBinRelationMap(q), true);
  assert.equal(userWantsWaferMapOnly(q), false);
});

test("plain BIN highlight still wafer-only", () => {
  const q = "画出bin15 所在位置的 wafermap";
  assert.equal(userWantsDutBinRelationMap(q), false);
  assert.equal(userWantsWaferMapOnly(q), true);
});
