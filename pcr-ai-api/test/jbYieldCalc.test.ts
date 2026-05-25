import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  badDieFromJbRow,
  buildSlotYieldSummary,
  computeJbYieldMetrics,
} from "../src/lib/jbYieldCalc.js";

describe("jbYieldCalc", () => {
  it("uses MAX GROSSDIE across rows, not sum", () => {
    const rows = [
      {
        GROSSDIE: 4732,
        PASSTYPE: "INTERRUPT",
        PASSBIN: "1",
        bins: [
          { n: 1, value: 4500, isGoodBin: true },
          { n: 5, value: 100, isGoodBin: false },
          { n: 10, value: 110, isGoodBin: false },
        ],
      },
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
});
