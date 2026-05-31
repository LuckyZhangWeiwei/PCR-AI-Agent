import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildBriefCommentaryUserMessage,
  buildDeterministicJbTables,
  buildEngineeringContextFromPayload,
  detectJbReplyMode,
  extractBinFromUserText,
  isBinTrendQuestion,
} from "../src/lib/agent/agentJbDeterministicReply.js";
import { wrapJbQueryResultForAgent } from "../src/lib/agent/agentJbBinFormat.js";
import { serializeJbQueryResultForAgent } from "../src/lib/agent/agentJbBinFormat.js";

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
    const ctx = buildEngineeringContextFromPayload({
      passIdsPresent: [1, 3],
      cardChangesBySlotPass: [{ slot: 1, passId: 1, hasCardChange: true, hasTestInterrupt: true }],
    });
    assert.ok(ctx.includes("passId"));
    assert.ok(ctx.includes("换卡"));
  });
});
