import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildBriefCommentaryUserMessage,
  buildDeterministicJbTables,
  buildEngineeringContextFromPayload,
  detectJbReplyMode,
  extractBinFromUserText,
  isBinTrendQuestion,
  resolveJbToolPayload,
} from "../src/lib/agent/agentJbDeterministicReply.js";
import {
  compactJbCacheForHistory,
} from "../src/lib/agent/agentJbHistoryCompact.js";
import {
  clearJbToolRawJson,
  storeJbToolRawJson,
} from "../src/lib/agent/agentJbSessionCache.js";
import {
  buildJbSessionCacheJson,
  serializeJbQueryResultForAgent,
  wrapJbQueryResultForAgent,
} from "../src/lib/agent/agentJbBinFormat.js";

describe("agentJbDeterministicReply", () => {
  it("detects bin trend vs lot overview", () => {
    assert.equal(
      detectJbReplyMode("NF12316.1X 中 bin7 的趋势"),
      "bin_trend"
    );
    assert.equal(
      detectJbReplyMode("NF12827.1R 整体的测试情况 请重新计算"),
      "lot_overview"
    );
    assert.equal(extractBinFromUserText("BIN7 按 slot"), 7);
    assert.equal(extractBinFromUserText("NF12316.1X 中bin7 的趋势"), 7);
    assert.equal(
      detectJbReplyMode("NF12316.1X 中bin7 的趋势"),
      "bin_trend"
    );
    assert.equal(
      detectJbReplyMode("NF12316.1X 中bin7 的趋势 请重新计算"),
      "bin_trend"
    );
  });

  it("resolveJbToolPayload reads history when session cache cleared", () => {
    const rows = [
      {
        LOT: "NF12316.1X",
        SLOT: 1,
        PASSID: 1,
        PASSTYPE: "TEST",
        bins: [{ n: 7, value: 12, isGoodBin: false }],
      },
    ] as Record<string, unknown>[];
    const wrapped = wrapJbQueryResultForAgent(rows, { lotScopedFullRows: true });
    const cacheJson = buildJbSessionCacheJson(wrapped);
    const hist = compactJbCacheForHistory(cacheJson, 12000);
    const sid = "test-resolve-jb-payload";
    clearJbToolRawJson(sid);
    const fromHist = resolveJbToolPayload(sid, hist);
    assert.ok(fromHist);
    assert.ok(Array.isArray(fromHist!._trendRows));
    storeJbToolRawJson(sid, cacheJson);
    const fromCache = resolveJbToolPayload(sid, hist);
    assert.equal(fromCache!._jbSessionCacheVersion, 4);
    clearJbToolRawJson(sid);
  });

  it("buildDeterministicJbTables picks bin trend markdown", () => {
    const rows = [
      {
        LOT: "NF12316.1X",
        SLOT: 1,
        PASSID: 1,
        PASSTYPE: "INTERRUPT",
        bins: [{ n: 7, value: 5, isGoodBin: false }],
      },
      {
        LOT: "NF12316.1X",
        SLOT: 1,
        PASSID: 1,
        PASSNUM: 2,
        PASSTYPE: "TEST",
        bins: [
          { n: 1, value: 4000, isGoodBin: true },
          { n: 7, value: 90, isGoodBin: false },
        ],
      },
      {
        LOT: "NF12316.1X",
        SLOT: 2,
        PASSID: 1,
        PASSTYPE: "TEST",
        bins: [
          { n: 1, value: 4000, isGoodBin: true },
          { n: 7, value: 100, isGoodBin: false },
        ],
      },
    ] as Record<string, unknown>[];
    const wrapped = wrapJbQueryResultForAgent(rows, { lotScopedFullRows: true });
    const json = serializeJbQueryResultForAgent(wrapped, 50000);
    const payload = JSON.parse(json) as Record<string, unknown>;
    const md = buildDeterministicJbTables(
      "NF12316.1X 中 bin7 的趋势",
      payload
    );
    assert.ok(md);
    assert.ok(isBinTrendQuestion("NF12316.1X 中 bin7 的趋势"));
    assert.ok(md!.includes("BIN7"));
    assert.ok(md!.includes("| 1 |"));
    assert.ok(md!.includes("90"));
  });

  it("brief commentary prompt requests wafer test probe card dut advice", () => {
    const msg = buildBriefCommentaryUserMessage("NF12316.1X bin7 趋势", "| 1 | 90 |", {
      engineeringContext: "passId: 1,3",
      yieldMonitorNote: "已查 Yield Monitor",
    });
    assert.ok(msg.includes("### 专业建议"));
    assert.ok(msg.includes("Wafer Test"));
    assert.ok(msg.includes("Probe Card"));
    assert.ok(msg.includes("DUT"));
    assert.ok(msg.includes("waferId") || msg.includes("术语"));
    const ctx = buildEngineeringContextFromPayload({
      passIdsPresent: [1, 3],
      cardChangesBySlotPass: [{ slot: 1, passId: 1, hasCardChange: true, hasTestInterrupt: true }],
    });
    assert.ok(ctx.includes("passId"));
    assert.ok(ctx.includes("换卡"));
  });
});
