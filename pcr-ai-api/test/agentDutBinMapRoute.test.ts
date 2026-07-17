import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDutBinMapArgsFromSession,
  sessionCanDrawDutBinMap,
  userWantsDutBinRelationMap,
} from "../src/lib/agent/agentDutBinMapRoute.js";
import { userWantsWaferMapOnly } from "../src/lib/agent/tools/agentInfWaferMapTool.js";
import { isDutBinConcentrationQuestion } from "../src/lib/agent/dispatch/agentQuestionHeuristics.js";

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

test("user question: lot + 第七片 + dut12 + bin61 关系图", () => {
  const q = "Lot: NF13607.1R 画出第七片wafermap dut12 和 bin61 的关系图";
  assert.equal(userWantsDutBinRelationMap(q), true);
  assert.equal(userWantsWaferMapOnly(q), false);
  assert.equal(isDutBinConcentrationQuestion(q), false);

  const args = buildDutBinMapArgsFromSession("sess-test", [], q);
  assert.equal(String(args["lot"]).toUpperCase(), "NF13607.1R");
  assert.equal(args["slot"], 7);
  assert.equal(args["dut"], 12);
  assert.equal(args["bin"], 61);
  assert.equal(sessionCanDrawDutBinMap("sess-test", [], q), true);
});

test("isDutBinConcentrationQuestion still matches count asks without map intent", () => {
  assert.ok(
    isDutBinConcentrationQuestion("NF13607.1R 哪个 DUT 测出 BIN61 最多")
  );
});
