import assert from "node:assert/strict";
import test from "node:test";
import {
  isLotOverviewQuestion,
  jbReplySkipsCommentaryLlm,
  detectJbReplyMode,
} from "../src/lib/agent/agentJbDeterministicReply.js";
import {
  canRunLotOverviewDirectRoute,
  jbPayloadMatchesLot,
  lotOverviewNeedsJbRecovery,
} from "../src/lib/agent/agentJbOverviewRoute.js";
import { buildLotOverviewTablesMarkdown } from "../src/lib/agent/agentJbDeterministicReply.js";

test("DR44117.1Y 整体的测试情况 is lot overview", () => {
  const q = "DR44117.1Y 整体的测试情况";
  assert.equal(isLotOverviewQuestion(q), true);
  assert.equal(canRunLotOverviewDirectRoute(q), true);
  assert.equal(detectJbReplyMode(q), "lot_overview");
  assert.equal(jbReplySkipsCommentaryLlm("lot_overview"), false);
});

test("lotOverviewNeedsJbRecovery when model only queried yield", () => {
  const q = "DR44117.1Y 整体的测试情况";
  assert.equal(lotOverviewNeedsJbRecovery(q, "query_yield_triggers"), true);
  assert.equal(lotOverviewNeedsJbRecovery(q, "query_jb_bins"), false);
});

test("buildLotOverviewTablesMarkdown includes cluster section", () => {
  const md = buildLotOverviewTablesMarkdown({
    slotYieldSummary: [{ slot: 1, passId: 1, grossDie: 100, goodDie: 90, badDie: 10, yieldPct: 90, hasInterrupt: false }],
    clusteredBadBinAlertsMarkdown: "| BIN | 测试层 | 类型 | waferId 范围 | 说明 |\n|---:|---:|---:|---:|---|\n| BIN90 | pass1 | 连续聚集 | 1–3 | test |",
    device: "WA00P32P",
    lot: "DR44117.1Y",
  });
  assert.ok(md?.includes("聚集"), md ?? "");
  assert.ok(md?.includes("BIN90"), md ?? "");
});

test("wafermap question is not lot overview direct", () => {
  const q = "画出 DR44117.1Y 第14片 wafermap";
  assert.equal(canRunLotOverviewDirectRoute(q), false);
});

test("jbPayloadMatchesLot", () => {
  assert.equal(jbPayloadMatchesLot({ lot: "DR44117.1Y" }, "dr44117.1y"), true);
  assert.equal(jbPayloadMatchesLot({ lot: "OTHER.1Y" }, "DR44117.1Y"), false);
});
