import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compactJbCacheForHistory } from "../src/lib/agent/jb/agentJbHistoryCompact.js";

describe("multiLotListing history compact", () => {
  it("compactJbCacheForHistory keeps recentLotsByTestEnd when over limit", () => {
    const payload = {
      lot: "DR45679.1J",
      device: "WA00P14R",
      totalDistinctLots: 10,
      distinctLotCount: 10,
      multiLotYieldScope: true,
      topBadBins: [{ bin: 13, dieCount: 4379 }],
      recentLotsByTestEnd: Array.from({ length: 10 }, (_, i) => ({
        lot: `DR4567${i}.1J`,
        device: "WA00P14R",
        testEnd: "2026-06-01",
        slotCount: 25,
      })),
      slotYieldSummary: Array.from({ length: 75 }, (_, i) => ({
        slot: (i % 25) + 1,
        passId: 1,
        yieldPct: 80,
        grossDie: 1000,
        badDie: 200,
        goodDie: 800,
      })),
    };
    const cacheJson = JSON.stringify(payload);
    const compact = compactJbCacheForHistory(cacheJson, 2500);
    const o = JSON.parse(compact) as Record<string, unknown>;
    assert.equal(o.totalDistinctLots, 10);
    assert.equal((o.recentLotsByTestEnd as unknown[]).length, 10);
  });
});
