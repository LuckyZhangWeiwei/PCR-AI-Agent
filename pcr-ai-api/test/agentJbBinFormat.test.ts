import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatJbRowsForAgent,
  normalizeBinsForAgent,
  wrapJbQueryResultForAgent,
} from "../src/lib/agent/agentJbBinFormat.js";

describe("agentJbBinFormat", () => {
  it("maps n/value to bin/dieCount", () => {
    const bins = [
      { n: 8, value: 37, isGoodBin: false },
      { n: 3, value: 41, isGoodBin: false },
      { n: 250, value: 7890, isGoodBin: true },
    ];
    assert.deepEqual(normalizeBinsForAgent(bins), [
      { bin: 3, dieCount: 41, isGoodBin: false },
      { bin: 8, dieCount: 37, isGoodBin: false },
      { bin: 250, dieCount: 7890, isGoodBin: true },
    ]);
  });

  it("splits badBins and goodBins on rows", () => {
    const [row] = formatJbRowsForAgent([
      {
        LOT: "TR21237.1Y",
        bins: [
          { n: 15, value: 22, isGoodBin: false },
          { n: 250, value: 7890, isGoodBin: true },
        ],
      },
    ]);
    assert.equal((row as { bins?: unknown }).bins, undefined);
    assert.deepEqual(row.badBins, [{ bin: 15, dieCount: 22, isGoodBin: false }]);
    assert.deepEqual(row.goodBins, [{ bin: 250, dieCount: 7890, isGoodBin: true }]);
  });

  it("wrapJbQueryResultForAgent includes field guide and empty distinctSlots", () => {
    const out = wrapJbQueryResultForAgent([]);
    assert.ok(String(out._binFieldGuide).includes("dieCount"));
    assert.equal(out.count, 0);
    assert.deepEqual(out.distinctSlots, []);
  });

  it("wrapJbQueryResultForAgent computes distinctSlots sorted ascending", () => {
    const rows = [
      { SLOT: 3, bins: [] },
      { SLOT: 1, bins: [] },
      { SLOT: 3, bins: [] },
      { SLOT: 25, bins: [] },
      { SLOT: 2, bins: [] },
    ] as Record<string, unknown>[];
    const out = wrapJbQueryResultForAgent(rows);
    assert.deepEqual(out.distinctSlots, [1, 2, 3, 25]);
    assert.equal(out.count, 5);
  });
});
