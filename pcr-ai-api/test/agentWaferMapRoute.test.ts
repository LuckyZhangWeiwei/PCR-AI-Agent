import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage } from "../src/lib/agent/agentHistory.js";
import { extractBinNumberFromText } from "../src/lib/agent/agentInfWaferMapTool.js";
import { planWaferMapRoute } from "../src/lib/agent/agentWaferMapRoute.js";

const LOT = "DR44117.1Y";
const DEVICE = "WA00P32P";

test("planWaferMapRoute: not wafer intent", () => {
  const plan = planWaferMapRoute(
    "s1",
    [],
    "DR44117.1Y lot 概况和聚集",
    "user_turn"
  );
  assert.equal(plan.isWaferMapIntent, false);
  assert.equal(plan.action.kind, "not_applicable");
});

test("planWaferMapRoute: user_turn direct draw after prior inf_draw", () => {
  const history: ChatMessage[] = [
    {
      role: "tool",
      name: "inf_draw_wafer_map",
      content:
        "**晶圆图已生成** → [x](/wafermaps/a.html)\n" +
        `Device: ${DEVICE}  Lot: ${LOT}  Wafer: 14  Slot: 14`,
    },
    { role: "user", content: "画出bin15 所在位置的 wafermap" },
  ];
  const plan = planWaferMapRoute(
    "s1",
    history,
    "画出bin15 所在位置的 wafermap",
    "user_turn"
  );
  assert.equal(plan.isWaferMapIntent, true);
  assert.equal(plan.skipJbDeterministicSummary, true);
  assert.equal(plan.action.kind, "draw");
  if (plan.action.kind === "draw") {
    assert.equal(plan.action.args.lot, LOT);
    assert.equal(plan.action.args.slot, 14);
    assert.equal(plan.action.args.highlight, "bin:15");
    assert.equal(plan.action.args.passes, "composite");
  }
});

test("planWaferMapRoute: user_turn needs jb when no session context", () => {
  const plan = planWaferMapRoute(
    "s1",
    [{ role: "user", content: `画出 ${LOT} 第14片wafer` }],
    `画出 ${LOT} 第14片wafer`,
    "user_turn"
  );
  assert.equal(plan.action.kind, "need_jb_lookup");
  assert.equal(plan.skipJbDeterministicSummary, true);
});

test("extractBinNumberFromText: various Chinese/English BIN patterns", () => {
  assert.equal(extractBinNumberFromText("BIN7"), 7);
  assert.equal(extractBinNumberFromText("bin 7"), 7);
  assert.equal(extractBinNumberFromText("highlight BIN7"), 7);
  assert.equal(extractBinNumberFromText("高亮BIN7"), 7);
  assert.equal(extractBinNumberFromText("7号bin"), 7);
  assert.equal(extractBinNumberFromText("7号BIN"), 7);
  assert.equal(extractBinNumberFromText("7 bin"), 7);
  assert.equal(extractBinNumberFromText("高亮7号bin的die"), 7);
  assert.equal(extractBinNumberFromText("BIN号7"), 7);
  assert.equal(extractBinNumberFromText("标出第7号bin"), 7);
  assert.equal(extractBinNumberFromText("no bin here"), undefined);
});

test("planWaferMapRoute: after_jb_bins with BIN highlight", () => {
  const jbJson = JSON.stringify({ device: DEVICE, lot: LOT });
  // User asked for wafermap + BIN highlight in one message; JB lookup happened first
  const history: ChatMessage[] = [
    { role: "user", content: `画出 ${LOT} 第14片wafer，高亮BIN7` },
    { role: "tool", name: "query_jb_bins", content: jbJson },
  ];
  const plan = planWaferMapRoute(
    "wafer-bin-highlight-after-jb-test",
    history,
    `画出 ${LOT} 第14片wafer，高亮BIN7`,
    "after_jb_bins",
    "query_jb_bins",
    jbJson
  );
  assert.equal(plan.action.kind, "draw");
  if (plan.action.kind === "draw") {
    assert.equal(plan.action.args.slot, 14);
    assert.equal(plan.action.args.highlight, "bin:7", "BIN highlight must be extracted from user message");
  }
});

test("planWaferMapRoute: after_jb_bins draws with payload", () => {
  const jbJson = JSON.stringify({ device: DEVICE, lot: LOT });
  const history: ChatMessage[] = [
    { role: "user", content: `画出 ${LOT} 第14片wafer` },
    { role: "tool", name: "query_jb_bins", content: jbJson },
  ];
  const plan = planWaferMapRoute(
    "wafer-route-after-jb-test",
    history,
    `画出 ${LOT} 第14片wafer`,
    "after_jb_bins",
    "query_jb_bins",
    jbJson
  );
  assert.equal(plan.action.kind, "draw");
  if (plan.action.kind === "draw") {
    assert.equal(plan.action.args.device, DEVICE);
    assert.equal(plan.action.args.lot, LOT);
    assert.equal(plan.action.args.slot, 14);
  }
});
