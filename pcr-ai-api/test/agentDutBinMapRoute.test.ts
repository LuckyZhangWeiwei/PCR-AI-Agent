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

test("buildDutBinMapArgsFromSession does not leak device from a different lot in history (regression)", () => {
  // Session previously queried lot A (device OLDDEV1); user now switches to a
  // brand-new lot B that hasn't had its own query_jb_bins this session.
  const history = [
    {
      role: "tool" as const,
      name: "query_jb_bins",
      content: JSON.stringify({ device: "OLDDEV1", lot: "NF11111.1A" }),
    },
  ];
  const q = "Lot: NF99999.9Z 画出第3片 dut5 和 bin20 的关系图";

  const args = buildDutBinMapArgsFromSession("sess-cross-lot", history, q);
  assert.equal(String(args["lot"]).toUpperCase(), "NF99999.9Z");
  // Must NOT silently reuse the old lot's device for the new lot — leave empty
  // so the caller's JB auto-lookup fetches the correct device instead.
  assert.equal(args["device"], "");
});

test("buildDutBinMapArgsFromSession still uses history device when lot matches (no regression)", () => {
  const history = [
    {
      role: "tool" as const,
      name: "query_jb_bins",
      content: JSON.stringify({ device: "DEV1", lot: "NF22222.1A" }),
    },
  ];
  const q = "画出第3片 dut5 和 bin20 的关系图"; // no explicit lot — falls back to history lot

  const args = buildDutBinMapArgsFromSession("sess-same-lot", history, q);
  assert.equal(String(args["lot"]).toUpperCase(), "NF22222.1A");
  assert.equal(args["device"], "DEV1");
});
