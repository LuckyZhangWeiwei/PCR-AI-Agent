import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildSlotsByPassId,
  formatBinSlotTrendMarkdown,
} from "../src/lib/agent/agentJbBinTrend.js";
import { wrapJbQueryResultForAgent } from "../src/lib/agent/agentJbBinFormat.js";

describe("agentJbBinTrend", () => {
  it("slot 1 pass1 with interrupt still has BIN7 in trend table", () => {
    const rows = [
      {
        LOT: "NF12316.1X",
        DEVICE: "DEV",
        SLOT: 1,
        PASSID: 1,
        PASSNUM: 1,
        PASSTYPE: "INTERRUPT",
        CARDID: "8041-05",
        GROSSDIE: 100,
        bins: [{ n: 5, value: 100, isGoodBin: false }],
      },
      {
        LOT: "NF12316.1X",
        DEVICE: "DEV",
        SLOT: 1,
        PASSID: 1,
        PASSNUM: 2,
        PASSTYPE: "TEST",
        CARDID: "8041-05",
        GROSSDIE: 4300,
        bins: [
          { n: 1, value: 4200, isGoodBin: true },
          { n: 7, value: 95, isGoodBin: false },
        ],
      },
      {
        LOT: "NF12316.1X",
        SLOT: 1,
        PASSID: 3,
        PASSTYPE: "TEST",
        CARDID: "8041-03",
        GROSSDIE: 4300,
        bins: [{ n: 1, value: 4290, isGoodBin: true }],
      },
    ] as Record<string, unknown>[];

    const slotsByPass = buildSlotsByPassId(rows);
    const p1 = slotsByPass.find((x) => x.passId === 1)!;
    assert.ok(p1.slots.includes(1), "slot 1 must be in passId=1 list");

    const md = formatBinSlotTrendMarkdown(rows, 7, 1, "NF12316.1X", "DEV");
    assert.ok(md.includes("| 1 |"));
    assert.ok(md.includes("95"));
    assert.ok(md.includes("是"), "interrupt flag");
    assert.ok(md.includes("BIN7前半"));
    assert.ok(md.includes("BIN7后半"));
    assert.ok(md.includes("前半良率"));
    assert.ok(md.includes("后半良率"));
    assert.ok(md.includes("整片良率"));
    assert.ok(!md.includes("无常温"));
    assert.ok(!md.includes("无测试行"), "slot 1 pass1 has rows");
    assert.ok(md.includes("BIN7 + 良率"), "interrupt detail table");

    const wrapped = wrapJbQueryResultForAgent(rows, { lotScopedFullRows: true });
    const trends = wrapped.badBinSlotTrends as Array<{
      bin: number;
      passId: number;
      markdown: string;
    }>;
    const bin7p1 = trends.find((t) => t.bin === 7 && t.passId === 1);
    assert.ok(bin7p1?.markdown.includes("| 1 |"));
    assert.ok(bin7p1!.markdown.includes("95"));
  });
});
