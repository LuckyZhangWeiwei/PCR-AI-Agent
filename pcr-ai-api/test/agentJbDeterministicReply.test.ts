import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildBriefCommentaryUserMessage,
  buildDeterministicJbTables,
  buildEngineeringContextFromPayload,
  detectJbReplyMode,
  extractBinFromUserText,
  isBinTrendQuestion,
  isInterruptCountQuestion,
  isProbeCardQuestion,
  isTesterMachineQuestion,
  isSlotPassYieldQuestion,
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
    assert.ok(isSlotPassYieldQuestion("给出 每片wafer 每个pass 的yield"));
    assert.equal(
      detectJbReplyMode("给出 每片wafer 每个pass 的yield"),
      "slot_pass_yield"
    );
    assert.ok(isInterruptCountQuestion("DR45459.1A 第1片中断几次"));
    assert.equal(
      detectJbReplyMode("lot DR45459.1A 各片中断多少次"),
      "interrupt_count"
    );
    assert.ok(isTesterMachineQuestion("DR45459.1A 在哪个机台测试的"));
    assert.equal(
      detectJbReplyMode("DR45459.1A 用的哪台测试机"),
      "tester_machine"
    );
    assert.ok(isProbeCardQuestion("DR45459.1A 用几号卡"));
    assert.equal(
      detectJbReplyMode("DR45459.1A 用几号卡，在哪个机器测试的"),
      "equipment"
    );
    // English "fail bin" variants → bad_bin_ranking
    assert.equal(
      detectJbReplyMode("DR43102.1H 实测失效情况,以及常见的fail bin"),
      "bad_bin_ranking"
    );
    assert.equal(
      detectJbReplyMode("这批主要的fail bin有哪些"),
      "bad_bin_ranking"
    );
    assert.equal(
      detectJbReplyMode("常见fail bin排行"),
      "bad_bin_ranking"
    );
    // Specific BIN number → should NOT be bad_bin_ranking (goes to bin_trend)
    assert.notEqual(
      detectJbReplyMode("BIN55 的 fail bin 情况"),
      "bad_bin_ranking"
    );
  });

  it("buildDeterministicJbTables equipment includes card and tester", () => {
    const payload = {
      lot: "DR45459.1A",
      cardByPassId: [
        { passId: 1, cardIds: ["8041-05"], hasCardChangeInPass: false },
        { passId: 3, cardIds: ["8041-06"], hasCardChangeInPass: false },
      ],
      testerByLot: [
        {
          lot: "DR45459.1A",
          primaryTesterId: "b3j75062",
          testerIds: ["b3j75062"],
        },
      ],
    };
    const md = buildDeterministicJbTables(
      "DR45459.1A 用几号卡，在哪个机器测试的",
      payload
    );
    assert.ok(md?.includes("cardByPassId") || md?.includes("8041-05"));
    assert.ok(md?.includes("b3j75062"));
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

  it("buildDeterministicJbTables returns tester machine table", () => {
    const rows = [
      {
        LOT: "DR45459.1A",
        SLOT: 1,
        PASSID: 1,
        TESTERID: "b3uflex17",
        TESTEND: "2026-05-29T10:00:00.000Z",
        bins: [],
      },
    ] as Record<string, unknown>[];
    const wrapped = wrapJbQueryResultForAgent(rows, { lotScopedFullRows: true });
    const md = buildDeterministicJbTables(
      "DR45459.1A 在哪个机台测试",
      wrapped
    );
    assert.ok(md);
    assert.ok(md!.includes("b3uflex17"));
    assert.ok(md!.includes("TESTERID"));
  });

  it("buildDeterministicJbTables returns interrupt count table", () => {
    const rows = [
      { LOT: "DR45459.1A", SLOT: 1, PASSID: 1, PASSTYPE: "INTERRUPT", PASSNUM: 1, GROSSDIE: 10, bins: [] },
      { LOT: "DR45459.1A", SLOT: 1, PASSID: 1, PASSTYPE: "INTERRUPT", PASSNUM: 1, GROSSDIE: 10, bins: [] },
      { LOT: "DR45459.1A", SLOT: 1, PASSID: 1, PASSTYPE: "INTERRUPT", PASSNUM: 1, GROSSDIE: 10, bins: [] },
      { LOT: "DR45459.1A", SLOT: 1, PASSID: 1, PASSTYPE: "INTERRUPT", PASSNUM: 1, GROSSDIE: 10, bins: [] },
      { LOT: "DR45459.1A", SLOT: 1, PASSID: 1, PASSTYPE: "TEST", PASSNUM: 2, GROSSDIE: 100, bins: [{ n: 1, value: 90, isGoodBin: true }] },
      { LOT: "DR45459.1A", SLOT: 5, PASSID: 1, PASSTYPE: "TEST", PASSNUM: 1, GROSSDIE: 100, bins: [] },
      { LOT: "DR45459.1A", SLOT: 5, PASSID: 1, PASSTYPE: "TEST", PASSNUM: 3, GROSSDIE: 100, bins: [{ n: 1, value: 90, isGoodBin: true }] },
    ] as Record<string, unknown>[];
    const wrapped = wrapJbQueryResultForAgent(rows, { lotScopedFullRows: true });
    const md = buildDeterministicJbTables(
      "DR45459.1A 第1片和第5片各中断几次",
      wrapped
    );
    assert.ok(md);
    assert.ok(md!.includes("测试中断次数"));
    assert.ok(md!.includes("| 1 |"));
    assert.ok(md!.includes("| 4 |"));
    assert.ok(md!.includes("| 5 |"));
    assert.ok(md!.includes("| 2 |"));
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
