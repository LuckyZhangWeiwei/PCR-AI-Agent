import test from "node:test";
import assert from "node:assert/strict";
import { resolveDispatch } from "../src/lib/agent/agentSemanticDispatchTable.js";
import type { JbRouteDecision } from "../src/lib/agent/jbRouteResolver.js";

function dec(over: Partial<JbRouteDecision>): JbRouteDecision {
  return {
    mode: "generic", source: "regex", confidence: "high",
    params: {}, reason: "test",
    isMultiCardCompare: false, isMultiLotCompare: false, isDutLevel: false,
    ...over,
  };
}

test("resolveDispatch: bin_card_attribution → aggregate_jb_bins groupBy bin,cardId", () => {
  const r = resolveDispatch(
    dec({ mode: "bin_card_attribution", params: { focusBin: 35 } }),
    "n55z 哪个卡测出bin35 多", []);
  assert.ok(r);
  assert.equal(r!.queryTool, "aggregate_jb_bins");
  assert.equal(r!.renderKind, "aggregate");
  assert.equal(r!.args["groupBy"], "bin,cardId");
});

test("resolveDispatch: 低置信 → null", () => {
  const r = resolveDispatch(
    dec({ mode: "bin_card_attribution", confidence: "low" }),
    "哪个卡 bin35 多", []);
  assert.equal(r, null);
});

test("resolveDispatch: 不在派发表的 mode → null", () => {
  const r = resolveDispatch(dec({ mode: "lot_overview" }), "DR44435.1C 概况", []);
  assert.equal(r, null);
});

test("resolveDispatch: lot_yield_ranking → query_jb_bins + emitTables", () => {
  const r = resolveDispatch(
    dec({ mode: "lot_yield_ranking" }),
    "WA03P02G 各 lot 良率 top5", []);
  assert.ok(r, "WA03P02G 应解析出 device → 非空 plan");
  assert.equal(r!.queryTool, "query_jb_bins");
  assert.equal(r!.renderKind, "emitTables");
  assert.equal(r!.args["device"], "WA03P02G");
});

test("resolveDispatch: lot_yield_ranking 裸 mask N55Z → mask fallback", () => {
  const r = resolveDispatch(
    dec({ mode: "lot_yield_ranking" }),
    "N55Z 各 lot 良率 top5", []);
  assert.ok(r, "N55Z 应走 mask fallback → 非空 plan");
  assert.equal(r!.queryTool, "query_jb_bins");
  assert.equal(r!.renderKind, "emitTables");
  assert.equal(r!.args["mask"], "N55Z");
});
