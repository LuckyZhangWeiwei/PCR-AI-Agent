import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  badDieFromJbRow,
  binDieByHalvesForGroup,
  buildLotYieldRank,
  buildSlotYieldSummary,
  buildYieldByPassId,
  buildYieldInterruptSegments,
  computeJbYieldMetrics,
  countTestInterruptEvents,
} from "../src/lib/jbYieldCalc.js";

describe("jbYieldCalc", () => {
  it("no interrupt: uses MAX GROSSDIE pool only", () => {
    const rows = [
      {
        GROSSDIE: 4848,
        PASSTYPE: "TEST",
        PASSBIN: "1",
        bins: [
          { n: 1, value: 4662, isGoodBin: true },
          { n: 5, value: 90, isGoodBin: false },
          { n: 10, value: 96, isGoodBin: false },
        ],
      },
    ];
    const m = computeJbYieldMetrics(rows);
    assert.equal(m.grossDie, 4848);
    assert.equal(m.badDie, 90 + 96);
    assert.ok(m.yieldPct !== null && Math.abs(m.yieldPct - 96.16) < 0.05);
  });

  it("interrupt first half good=0: yield is second half only (slot 21 pattern)", () => {
    const rows = [
      {
        GROSSDIE: 116,
        PASSTYPE: "INTERRUPT",
        PASSBIN: "1",
        bins: [{ n: 5, value: 116, isGoodBin: false }],
      },
      {
        GROSSDIE: 4732,
        PASSTYPE: "TEST",
        PASSBIN: "1",
        bins: [
          { n: 1, value: 4487, isGoodBin: true },
          { n: 5, value: 245, isGoodBin: false },
        ],
      },
    ];
    const m = computeJbYieldMetrics(rows);
    assert.equal(m.grossDie, 4732);
    assert.equal(m.goodDie, 4487);
    assert.equal(m.badDie, 245);
    assert.ok(m.yieldPct !== null && Math.abs(m.yieldPct - 94.82) < 0.05);
  });

  it("interrupt first half good>0: merges good and gross across halves", () => {
    const rows = [
      {
        GROSSDIE: 100,
        PASSTYPE: "INTERRUPT",
        PASSBIN: "1",
        bins: [
          { n: 1, value: 80, isGoodBin: true },
          { n: 5, value: 10, isGoodBin: false },
        ],
      },
      {
        GROSSDIE: 200,
        PASSTYPE: "TEST",
        PASSBIN: "1",
        bins: [
          { n: 1, value: 170, isGoodBin: true },
          { n: 5, value: 20, isGoodBin: false },
        ],
      },
    ];
    const m = computeJbYieldMetrics(rows);
    assert.equal(m.grossDie, 300);
    assert.equal(m.goodDie, 270);
    assert.equal(m.badDie, 30);
    assert.ok(m.yieldPct !== null && Math.abs(m.yieldPct - 90) < 0.1);
  });

  it("BIN1 counts as good even when PASSBIN omits 1", () => {
    const row = {
      GROSSDIE: 100,
      PASSBIN: "2-55",
      bins: [
        { n: 1, value: 80, isGoodBin: false },
        { n: 5, value: 20, isGoodBin: false },
      ],
    };
    assert.equal(badDieFromJbRow(row), 20);
    const m = computeJbYieldMetrics([row]);
    assert.equal(m.yieldPct, 80);
  });

  it("buildSlotYieldSummary sorts slots ascending", () => {
    const summary = buildSlotYieldSummary([
      { SLOT: 3, GROSSDIE: 100, bins: [{ n: 2, value: 10, isGoodBin: false }] },
      { SLOT: 1, GROSSDIE: 100, bins: [{ n: 2, value: 5, isGoodBin: false }] },
    ]);
    assert.deepEqual(
      summary.map((s) => s.slot),
      [1, 3]
    );
    assert.equal(summary[0]!.badDie, 5);
    assert.equal(summary[1]!.badDie, 10);
  });

  it("binDieByHalvesForGroup sums bin on first and second half rows", () => {
    const rows = [
      {
        SLOT: 1,
        PASSID: 1,
        PASSTYPE: "INTERRUPT",
        bins: [{ n: 7, value: 10, isGoodBin: false }],
      },
      {
        SLOT: 1,
        PASSID: 1,
        PASSNUM: 2,
        PASSTYPE: "TEST",
        bins: [
          { n: 7, value: 80, isGoodBin: false },
          { n: 1, value: 100, isGoodBin: true },
        ],
      },
    ];
    const h = binDieByHalvesForGroup(rows, 7);
    assert.equal(h.segmented, true);
    assert.equal(h.firstHalf, 10);
    assert.equal(h.secondHalf, 80);
    assert.equal(h.total, 90);
  });

  it("buildSlotYieldSummary exposes upper, lower, and whole wafer for interrupt", () => {
    const rows = [
      {
        SLOT: 22,
        GROSSDIE: 116,
        PASSTYPE: "INTERRUPT",
        PASSBIN: "1",
        bins: [{ n: 5, value: 116, isGoodBin: false }],
      },
      {
        SLOT: 22,
        GROSSDIE: 2011,
        PASSTYPE: "TEST",
        PASSBIN: "1",
        bins: [
          { n: 1, value: 1908, isGoodBin: true },
          { n: 5, value: 103, isGoodBin: false },
        ],
      },
    ];
    const summary = buildSlotYieldSummary(rows);
    const s = summary.find((x) => x.slot === 22)!;
    assert.equal(s.hasInterrupt, true);
    assert.equal(s.interruptHalf!.grossDie, 116);
    assert.equal(s.interruptHalf!.goodDie, 0);
    assert.equal(s.interruptHalf!.yieldPct, 0);
    assert.equal(s.completionHalf!.grossDie, 2011);
    assert.equal(s.completionHalf!.goodDie, 1908);
    assert.ok(
      s.completionHalf!.yieldPct !== null &&
        Math.abs(s.completionHalf!.yieldPct - 94.88) < 0.05
    );
    assert.equal(s.grossDie, 2011);
    assert.equal(s.goodDie, 1908);
    assert.ok(s.yieldPct !== null && Math.abs(s.yieldPct - 94.88) < 0.05);
  });

  it("splits by PASSNUM when passNum increases (passId unchanged)", () => {
    const rows = [
      {
        SLOT: 5,
        PASSID: 1,
        PASSNUM: 1,
        PASSTYPE: "TEST",
        GROSSDIE: 100,
        bins: [{ n: 5, value: 100, isGoodBin: false }],
      },
      {
        SLOT: 5,
        PASSID: 1,
        PASSNUM: 2,
        PASSTYPE: "TEST",
        GROSSDIE: 200,
        bins: [
          { n: 1, value: 180, isGoodBin: true },
          { n: 5, value: 20, isGoodBin: false },
        ],
      },
    ];
    const s = buildSlotYieldSummary(rows).find((x) => x.slot === 5)!;
    assert.equal(s.hasInterrupt, true);
    assert.equal(s.interruptHalf!.grossDie, 100);
    assert.equal(s.completionHalf!.grossDie, 200);
  });

  it("buildSlotYieldSummary emits separate entries per passId on same slot", () => {
    const rows = [
      {
        SLOT: 1,
        PASSID: 1,
        GROSSDIE: 100,
        PASSTYPE: "TEST",
        bins: [
          { n: 1, value: 95, isGoodBin: true },
          { n: 5, value: 5, isGoodBin: false },
        ],
      },
      {
        SLOT: 1,
        PASSID: 3,
        GROSSDIE: 100,
        PASSTYPE: "TEST",
        bins: [
          { n: 1, value: 70, isGoodBin: true },
          { n: 5, value: 30, isGoodBin: false },
        ],
      },
    ];
    const summary = buildSlotYieldSummary(rows);
    assert.equal(summary.length, 2);
    const p1 = summary.find((x) => x.passId === 1)!;
    const p3 = summary.find((x) => x.passId === 3)!;
    assert.equal(p1.slot, 1);
    assert.equal(p3.slot, 1);
    assert.ok(p1.yieldPct !== null && Math.abs(p1.yieldPct - 95) < 0.1);
    assert.ok(p3.yieldPct !== null && Math.abs(p3.yieldPct - 70) < 0.1);
  });

  it("buildYieldByPassId sums per passId not across passes", () => {
    const rows = [
      {
        LOT: "L1",
        SLOT: 1,
        PASSID: 3,
        GROSSDIE: 1000,
        bins: [
          { n: 1, value: 900, isGoodBin: true },
          { n: 5, value: 100, isGoodBin: false },
        ],
      },
      {
        LOT: "L1",
        SLOT: 1,
        PASSID: 5,
        GROSSDIE: 2000,
        bins: [
          { n: 1, value: 1800, isGoodBin: true },
          { n: 5, value: 200, isGoodBin: false },
        ],
      },
    ];
    const byPass = buildYieldByPassId(rows);
    assert.equal(byPass.length, 2);
    assert.equal(byPass[0]!.passId, 3);
    assert.equal(byPass[0]!.grossDie, 1000);
    assert.equal(byPass[1]!.passId, 5);
    assert.equal(byPass[1]!.grossDie, 2000);
  });

  it("buildLotYieldRank uses worst slot×pass yield per lot and sorts by testEnd desc", () => {
    const rows = [
      {
        LOT: "LOT_A",
        DEVICE: "WA01",
        SLOT: 1,
        PASSID: 1,
        GROSSDIE: 100,
        TESTEND: "2026-05-20T10:00:00.000Z",
        bins: [
          { n: 1, value: 90, isGoodBin: true },
          { n: 5, value: 10, isGoodBin: false },
        ],
      },
      {
        LOT: "LOT_A",
        DEVICE: "WA01",
        SLOT: 2,
        PASSID: 1,
        GROSSDIE: 100,
        TESTEND: "2026-05-20T11:00:00.000Z",
        bins: [
          { n: 1, value: 50, isGoodBin: true },
          { n: 5, value: 50, isGoodBin: false },
        ],
      },
      {
        LOT: "LOT_B",
        DEVICE: "WA01",
        SLOT: 1,
        PASSID: 1,
        GROSSDIE: 100,
        TESTEND: "2026-05-25T10:00:00.000Z",
        bins: [
          { n: 1, value: 98, isGoodBin: true },
          { n: 5, value: 2, isGoodBin: false },
        ],
      },
    ];
    const rank = buildLotYieldRank(rows, 10);
    assert.deepEqual(rank.map((x) => x.lot), ["LOT_B", "LOT_A"]);
    const lotA = rank.find((x) => x.lot === "LOT_A")!;
    assert.ok(lotA.yieldPct !== null && Math.abs(lotA.yieldPct - 50) < 0.1);
    assert.equal(lotA.worstSlot, 2);
    const lotB = rank.find((x) => x.lot === "LOT_B")!;
    assert.ok(lotB.yieldPct !== null && Math.abs(lotB.yieldPct - 98) < 0.1);
  });

  it("countTestInterruptEvents counts multiple INTERRUPT rows", () => {
    const group = [
      { PASSTYPE: "INTERRUPT", PASSNUM: 1 },
      { PASSTYPE: "INTERRUPT", PASSNUM: 1 },
      { PASSTYPE: "INTERRUPT", PASSNUM: 1 },
      { PASSTYPE: "INTERRUPT", PASSNUM: 1 },
      { PASSTYPE: "TEST", PASSNUM: 2, GROSSDIE: 100, bins: [] },
    ] as Record<string, unknown>[];
    assert.equal(countTestInterruptEvents(group), 4);
    const summary = buildSlotYieldSummary([
      { SLOT: 1, PASSID: 1, ...group[0] },
      { SLOT: 1, PASSID: 1, ...group[1] },
      { SLOT: 1, PASSID: 1, ...group[2] },
      { SLOT: 1, PASSID: 1, ...group[3] },
      { SLOT: 1, PASSID: 1, ...group[4] },
    ]);
    assert.equal(summary[0]!.testInterruptCount, 4);
    const segs = summary[0]!.interruptSegments;
    assert.ok(segs && segs.length >= 6, "4 interrupts + resume + whole");
    assert.equal(segs![0]!.label, "中断1");
    assert.equal(segs![3]!.label, "中断4");
    assert.equal(segs![segs!.length - 1]!.label, "整片正片（合并）");
    const built = buildYieldInterruptSegments(group.map((r, i) => ({
      SLOT: 1,
      PASSID: 1,
      ...r,
    })));
    assert.equal(built?.filter((s) => s.label.startsWith("中断")).length, 4);
  });

  it("countTestInterruptEvents uses PASSNUM delta when no INTERRUPT rows", () => {
    const group = [
      { SLOT: 5, PASSID: 1, PASSNUM: 1, PASSTYPE: "TEST", GROSSDIE: 100, bins: [] },
      { SLOT: 5, PASSID: 1, PASSNUM: 2, PASSTYPE: "TEST", GROSSDIE: 100, bins: [] },
      { SLOT: 5, PASSID: 1, PASSNUM: 3, PASSTYPE: "TEST", GROSSDIE: 100, bins: [] },
    ] as Record<string, unknown>[];
    assert.equal(countTestInterruptEvents(group), 2);
    const summary = buildSlotYieldSummary(group);
    assert.equal(summary[0]!.testInterruptCount, 2);
  });

  it("countTestInterruptEvents: three INTERRUPT rows on slot 4", () => {
    const rows = [
      { SLOT: 4, PASSID: 1, PASSTYPE: "INTERRUPT", PASSNUM: 1, GROSSDIE: 10, bins: [] },
      { SLOT: 4, PASSID: 1, PASSTYPE: "INTERRUPT", PASSNUM: 1, GROSSDIE: 10, bins: [] },
      { SLOT: 4, PASSID: 1, PASSTYPE: "INTERRUPT", PASSNUM: 1, GROSSDIE: 10, bins: [] },
      { SLOT: 4, PASSID: 1, PASSTYPE: "TEST", PASSNUM: 2, GROSSDIE: 100, bins: [{ n: 1, value: 90, isGoodBin: true }] },
    ] as Record<string, unknown>[];
    assert.equal(countTestInterruptEvents(rows), 3);
    assert.equal(buildSlotYieldSummary(rows)[0]!.testInterruptCount, 3);
  });

  it("resume: two TEST rows same PASSNUM split by TESTEND (NF12773 slot22 pattern)", () => {
    const rows = [
      {
        SLOT: 22,
        GROSSDIE: 960,
        PASSTYPE: "TEST",
        TESTEND: "2026-05-23T13:07:22.000Z",
        PASSBIN: "1",
        bins: [
          { n: 1, value: 800, isGoodBin: true },
          { n: 5, value: 160, isGoodBin: false },
        ],
      },
      {
        SLOT: 22,
        GROSSDIE: 2011,
        PASSTYPE: "TEST",
        TESTEND: "2026-05-23T15:41:23.000Z",
        PASSBIN: "1",
        bins: [
          { n: 1, value: 1908, isGoodBin: true },
          { n: 5, value: 103, isGoodBin: false },
        ],
      },
    ];
    const summary = buildSlotYieldSummary(rows);
    const s = summary.find((x) => x.slot === 22)!;
    assert.equal(s.hasInterrupt, true);
    assert.equal(s.interruptHalf!.grossDie, 960);
    assert.equal(s.completionHalf!.grossDie, 2011);
    assert.equal(s.grossDie, 2971);
    assert.equal(s.goodDie, 2708);
    assert.ok(s.yieldPct !== null && Math.abs(s.yieldPct - 91.15) < 0.1);
  });

  it("same PASSNUM multi TEST resume: 前半/后半/整片, not per-row 续测段", () => {
    const mk = (i: number, good: number, bad: number) => ({
      SLOT: 1,
      PASSID: 1,
      PASSNUM: 1,
      PASSTYPE: "TEST",
      GROSSDIE: 370,
      PASSBIN: "1",
      TESTEND: `2026-06-01T10:${String(i).padStart(2, "0")}:00.000Z`,
      bins: [
        { n: 1, value: good, isGoodBin: true },
        { n: 5, value: bad, isGoodBin: false },
      ],
    });
    const rows = [mk(0, 270, 100), mk(1, 299, 71), mk(2, 300, 70)];
    const summary = buildSlotYieldSummary(rows);
    const s = summary[0]!;
    assert.equal(s.hasInterrupt, true);
    assert.equal(s.testInterruptCount, 2);
    const segs = s.interruptSegments!;
    assert.equal(segs.length, 3);
    assert.equal(segs[0]!.label, "前半段");
    assert.equal(segs[0]!.metrics.grossDie, 370);
    assert.equal(segs[1]!.label, "后半段");
    assert.equal(segs[1]!.metrics.grossDie, 740);
    assert.equal(segs[2]!.label, "整片正片（合并）");
    assert.equal(segs[2]!.metrics.grossDie, 1110);
    assert.ok(!segs.some((x) => x.label.startsWith("续测段")));
  });

  it("object bins map: bad die counted for yield", () => {
    const row = {
      GROSSDIE: 370,
      PASSTYPE: "TEST",
      PASSBIN: "1-2",
      bins: {
        "1": { value: 300, isGood: true },
        "5": { value: 70, isGood: false },
      },
    };
    assert.equal(badDieFromJbRow(row), 70);
    const m = computeJbYieldMetrics([row]);
    assert.ok(m.yieldPct !== null && Math.abs(m.yieldPct - 81.08) < 0.1);
  });

  it("excludes PASSID=99 Current layer from slotYieldSummary", () => {
    const rows = [
      {
        SLOT: 1,
        PASSID: 1,
        PASSNUM: 1,
        PASSTYPE: "TEST",
        GROSSDIE: 370,
        PASSBIN: "1",
        bins: [{ n: 1, value: 308, isGoodBin: true }, { n: 5, value: 62, isGoodBin: false }],
      },
      {
        SLOT: 1,
        PASSID: 1,
        PASSNUM: 2,
        PASSTYPE: "RETESTBIN",
        GROSSDIE: 10,
        PASSBIN: "1",
        bins: [{ n: 1, value: 7, isGoodBin: true }],
      },
      {
        SLOT: 1,
        PASSID: 99,
        PASSNUM: 99,
        PASSTYPE: "NA",
        LAYERNAME: "Current",
        GROSSDIE: 370,
        PASSBIN: "1",
        bins: { "1": { value: 312, isGood: true } },
      },
    ];
    const summary = buildSlotYieldSummary(rows);
    assert.equal(summary.length, 1);
    assert.equal(summary[0]!.passId, 1);
    assert.equal(summary[0]!.hasInterrupt, false);
    assert.equal(summary[0]!.testInterruptCount, 0);
    assert.equal(summary[0]!.badDie, 62);
    assert.ok(
      summary[0]!.yieldPct !== null &&
        Math.abs(summary[0]!.yieldPct - 83.24) < 0.1
    );
  });

  it("does not merge rows from different lots into fake interrupt", () => {
    const rows = [
      {
        LOT: "LOT_A",
        SLOT: 1,
        PASSID: 1,
        PASSTYPE: "TEST",
        GROSSDIE: 1365,
        bins: [
          { n: 1, value: 1200, isGoodBin: true },
          { n: 6, value: 165, isGoodBin: false },
        ],
      },
      {
        LOT: "LOT_B",
        SLOT: 1,
        PASSID: 1,
        PASSTYPE: "TEST",
        GROSSDIE: 8190,
        bins: [
          { n: 1, value: 7000, isGoodBin: true },
          { n: 6, value: 1190, isGoodBin: false },
        ],
      },
    ];
    const summary = buildSlotYieldSummary(rows);
    assert.equal(summary.length, 2);
    assert.equal(summary.every((e) => !e.hasInterrupt), true);
    const lotA = summary.find((e) => e.lot === "LOT_A")!;
    const lotB = summary.find((e) => e.lot === "LOT_B")!;
    assert.equal(lotA.grossDie, 1365);
    assert.equal(lotB.grossDie, 8190);
  });

  it("NF13137 pattern: single TEST + RETESTBIN uses TEST row yield (slot 2)", () => {
    const rows = [
      {
        SLOT: 2,
        PASSID: 1,
        PASSNUM: 1,
        PASSTYPE: "TEST",
        GROSSDIE: 370,
        PASSBIN: "1-2",
        bins: [
          { n: 1, value: 291, isGoodBin: true },
          { n: 5, value: 79, isGoodBin: false },
        ],
      },
      {
        SLOT: 2,
        PASSID: 1,
        PASSNUM: 2,
        PASSTYPE: "RETESTBIN",
        GROSSDIE: 18,
        PASSBIN: "1-2",
        bins: [{ n: 1, value: 10, isGoodBin: true }],
      },
    ];
    const s = buildSlotYieldSummary(rows)[0]!;
    assert.equal(s.hasInterrupt, false);
    assert.equal(s.badDie, 79);
    assert.ok(s.yieldPct !== null && Math.abs(s.yieldPct - 78.65) < 0.1);
  });
});
