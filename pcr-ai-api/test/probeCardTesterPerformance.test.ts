import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  mean,
  median,
  rowYieldPct,
  sampleStdDev,
} from "../src/lib/probeCardTesterPerformance.js";

describe("probeCardTesterPerformance: stats helpers", () => {
  test("mean of a simple array", () => {
    assert.equal(mean([1, 2, 3]), 2);
    assert.equal(mean([10]), 10);
  });

  test("sampleStdDev uses n-1 denominator, 0 for <2 values", () => {
    assert.equal(sampleStdDev([]), 0);
    assert.equal(sampleStdDev([5]), 0);
    // population {2,4,4,4,5,5,7,9}, sample stddev = 2.13809...
    const v = sampleStdDev([2, 4, 4, 4, 5, 5, 7, 9]);
    assert.ok(Math.abs(v - 2.138089935) < 1e-6, `got ${v}`);
  });

  test("median for odd and even length arrays", () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([1, 2, 3, 4]), 2.5);
    assert.equal(median([7]), 7);
  });
});

describe("probeCardTesterPerformance: rowYieldPct", () => {
  test("computes yield from GROSSDIE and a bad bin", () => {
    const row = {
      GROSSDIE: 100,
      PASSBIN: undefined,
      bins: [{ n: 5, value: 10, isGoodBin: false }],
    };
    assert.equal(rowYieldPct(row), 90);
  });

  test("returns null when GROSSDIE is missing or zero", () => {
    assert.equal(rowYieldPct({ bins: [] }), null);
    assert.equal(rowYieldPct({ GROSSDIE: 0, bins: [] }), null);
  });

  test("BIN1 is always a good bin even if bins[] marks it bad (regression: old draft missed this)", () => {
    const row = {
      GROSSDIE: 100,
      PASSBIN: undefined,
      // BIN1 present with isGoodBin:false — a naive PASSBIN-only parser would
      // count it as bad die. badDieFromJbRow must still treat n=1 as good via
      // JB_HARD_GOOD_BIN, so yield must be 100, not 100 - 20/100*100 = 80.
      bins: [{ n: 1, value: 20, isGoodBin: false }],
    };
    assert.equal(rowYieldPct(row), 100);
  });

  test("PASSBIN hyphen-token good bins are excluded from bad die", () => {
    const row = {
      GROSSDIE: 100,
      PASSBIN: "3-9",
      bins: [
        { n: 3, value: 5, isGoodBin: false },
        { n: 9, value: 5, isGoodBin: false },
        { n: 12, value: 10, isGoodBin: false },
      ],
    };
    // bins 3 and 9 are good (PASSBIN token), only bin 12's 10 die are bad
    assert.equal(rowYieldPct(row), 90);
  });
});
