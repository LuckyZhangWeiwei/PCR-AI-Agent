import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  wrapJbQueryResultForAgent,
  serializeJbQueryResultForAgent,
} from "../src/lib/agent/agentJbBinFormat.js";
import {
  compactJbBinsForHistory,
  formatSlotYieldInterruptMarkdown,
  formatSlotYieldMarkdownFromToolJson,
} from "../src/lib/agent/agentJbHistoryCompact.js";

function mock25SlotRows(): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (let slot = 1; slot <= 25; slot++) {
    for (const passId of [3, 5]) {
      rows.push({
        LOT: "NF12827.1R",
        DEVICE: "WB10N57U",
        SLOT: slot,
        PASSID: passId,
        CARDID: passId === 3 ? "8003-21" : "8003-05",
        GROSSDIE: 5000,
        PASSTYPE: "TEST",
        bins: [
          { n: 1, value: 4800, isGoodBin: true },
          { n: 8, value: 50, isGoodBin: false },
        ],
      });
    }
  }
  return rows;
}

describe("agentJbHistoryCompact", () => {
  it("serializeJbQueryResultForAgent fits 12000 for 25-slot lot", () => {
    const wrapped = wrapJbQueryResultForAgent(mock25SlotRows());
    const json = serializeJbQueryResultForAgent(wrapped, 12000);
    assert.ok(json.length <= 12000, `length ${json.length}`);
    const parsed = JSON.parse(json) as {
      slotYieldSummary?: unknown[];
    };
    assert.equal(parsed.slotYieldSummary?.length, 50);
  });

  it("compactJbBinsForHistory keeps yield core and badBinSlotTrends", () => {
    const wrapped = wrapJbQueryResultForAgent(mock25SlotRows(), {
      lotScopedFullRows: true,
    });
    const full = serializeJbQueryResultForAgent(wrapped, 12000);
    const hist = compactJbBinsForHistory(full, 12000);
    assert.ok(hist.length <= 12000);
    const parsed = JSON.parse(hist) as {
      slotYieldSummary?: unknown[];
      yieldByPassId?: unknown[];
      passIdsPresent?: number[];
      badBinSlotTrends?: unknown[];
      yieldByPassIdMarkdown?: string;
    };
    assert.ok(parsed.passIdsPresent?.length);
    assert.ok(
      parsed.yieldByPassId?.length ||
        parsed.yieldByPassIdMarkdown ||
        parsed.badBinSlotTrends?.length
    );
  });

  it("yieldByPassId and pivot separate sort2 and sort3", () => {
    const rows = mock25SlotRows();
    const wrapped = wrapJbQueryResultForAgent(rows);
    const byPass = wrapped.yieldByPassId as Array<{
      passId: number;
      grossDie: number;
    }>;
    assert.equal(byPass.length, 2);
    assert.equal(byPass[0]!.passId, 3);
    assert.equal(byPass[1]!.passId, 5);
    const pivot = wrapped.slotYieldPivot as { passIds: number[] };
    assert.deepEqual(pivot.passIds, [3, 5]);
    assert.ok(String(wrapped.slotYieldPivotMarkdown).includes("pass3"));
    assert.ok(String(wrapped.slotYieldPivotMarkdown).includes("pass5"));
    assert.ok(!String(wrapped.slotYieldPivotMarkdown).includes("高温"));
    const summary = wrapped.slotYieldSummary as unknown[];
    assert.equal(summary.length, 50);
  });

  it("formatSlotYieldInterruptMarkdown lists whole then halves with 0%", () => {
    const rows = [
      {
        SLOT: 22,
        PASSID: 3,
        PASSNUM: 1,
        GROSSDIE: 100,
        PASSTYPE: "INTERRUPT",
        bins: [{ n: 5, value: 100, isGoodBin: false }],
      },
      {
        SLOT: 22,
        PASSID: 3,
        PASSNUM: 2,
        GROSSDIE: 4748,
        PASSTYPE: "TEST",
        bins: [
          { n: 1, value: 4500, isGoodBin: true },
          { n: 5, value: 248, isGoodBin: false },
        ],
      },
    ] as Record<string, unknown>[];
    const wrapped = wrapJbQueryResultForAgent(rows);
    const summary = wrapped.slotYieldSummary as import("../src/lib/infcontrol/jbYieldCalc.js").SlotYieldSummaryEntry[];
    const md = formatSlotYieldInterruptMarkdown(summary, "NF12773.1H", "DEV");
    assert.ok(md.includes("测试中断"));
    assert.ok(md.includes("| 22 |"));
    assert.ok(md.includes("整片正片（合并）"));
    assert.ok(md.includes("前半段"));
    assert.ok(md.includes("后半段"));
    const wholeIdx = md.lastIndexOf("整片正片（合并）");
    const firstIdx = md.indexOf("前半段");
    const secondIdx = md.indexOf("后半段");
    assert.ok(firstIdx < secondIdx && secondIdx < wholeIdx);
    assert.ok(md.includes("| 0% |") || md.includes("| 0 |"));
    assert.ok(String(wrapped.slotYieldInterruptMarkdown).includes("整片正片（合并）"));
  });

  it("compactJbBinsForHistory keeps passIdsPresent and overview markdown", () => {
    const wrapped = wrapJbQueryResultForAgent(mock25SlotRows(), {
      lotScopedFullRows: true,
    });
    const full = serializeJbQueryResultForAgent(wrapped, 12000);
    const hist = compactJbBinsForHistory(full, 6000);
    const parsed = JSON.parse(hist) as {
      passIdsPresent?: number[];
      lotYieldOverviewMarkdown?: string;
      yieldByPassIdMarkdown?: string;
    };
    assert.ok(parsed.passIdsPresent?.includes(3));
    assert.ok(
      parsed.lotYieldOverviewMarkdown?.includes("分测试层") ||
        parsed.yieldByPassIdMarkdown?.includes("分测试层")
    );
  });

  it("compactJbBinsForHistory keeps interruptHalf in slim summary", () => {
    const rows = [
      {
        SLOT: 21,
        PASSID: 1,
        PASSNUM: 1,
        GROSSDIE: 116,
        PASSTYPE: "INTERRUPT",
        bins: [{ n: 5, value: 116, isGoodBin: false }],
      },
      {
        SLOT: 21,
        PASSID: 1,
        PASSNUM: 2,
        GROSSDIE: 4732,
        PASSTYPE: "TEST",
        bins: [
          { n: 1, value: 4487, isGoodBin: true },
          { n: 5, value: 245, isGoodBin: false },
        ],
      },
    ] as Record<string, unknown>[];
    const wrapped = wrapJbQueryResultForAgent(rows);
    const full = serializeJbQueryResultForAgent(wrapped, 12000);
    const hist = compactJbBinsForHistory(full, 6000);
    const parsed = JSON.parse(hist) as {
      slotYieldSummary?: Array<{
        interruptHalf?: { yieldPct: number };
      }>;
      slotYieldInterruptMarkdown?: string;
    };
    const s21 = parsed.slotYieldSummary?.find((e) => e.interruptHalf);
    assert.equal(s21?.interruptHalf?.yieldPct, 0);
    assert.ok(parsed.slotYieldInterruptMarkdown?.includes("前半段"));
  });

  it("formatSlotYieldMarkdownFromToolJson lists all slots", () => {
    const wrapped = wrapJbQueryResultForAgent(mock25SlotRows());
    const full = serializeJbQueryResultForAgent(wrapped, 12000);
    const hist = compactJbBinsForHistory(full, 6000);
    const md = formatSlotYieldMarkdownFromToolJson(hist);
    assert.ok(md);
    assert.ok(md!.includes("NF12827.1R"));
    assert.ok(md!.includes("| 1 |"));
    assert.ok(md!.includes("| 25 |"));
    assert.ok(md!.includes("99") || md!.includes("98"));
  });
});
