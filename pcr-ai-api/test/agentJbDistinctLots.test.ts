import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildInfcontrolLayerBinsV3DistinctLotsSql } from "../src/lib/apiV3ListSql.js";
import {
  buildDistinctLotsFromMatchingRows,
  JB_LISTING_FULL_ROWS_MAX_LOTS,
  shouldFetchFullRowsForListing,
} from "../src/lib/agent/agentJbDistinctLots.js";
import { wrapJbQueryResultForAgent } from "../src/lib/agent/jb/agentJbBinFormat.js";

describe("agentJbDistinctLots", () => {
  it("buildInfcontrolLayerBinsV3DistinctLotsSql groups by lot with same WHERE as list", () => {
    const sql = buildInfcontrolLayerBinsV3DistinctLotsSql("t1.DEVICE = :device");
    assert.match(sql, /GROUP BY t1\.LOT, t1\.DEVICE/);
    assert.match(sql, /COUNT\(DISTINCT t1\.SLOT\)/);
    assert.match(sql, /FETCH FIRST :lot_lim ROWS ONLY/);
    assert.match(sql, /t1\.DEVICE = :device/);
  });

  it("buildDistinctLotsFromMatchingRows counts all lots in matching set", () => {
    const rows = [
      { LOT: "A", DEVICE: "D", TESTEND: "2026-06-02", SLOT: 1 },
      { LOT: "A", DEVICE: "D", TESTEND: "2026-06-03", SLOT: 2 },
      { LOT: "B", DEVICE: "D", TESTEND: "2026-06-01", SLOT: 1 },
      { LOT: "C", DEVICE: "D", TESTEND: "2026-05-01", SLOT: 1 },
    ] as Record<string, unknown>[];
    const { lots, totalDistinct } = buildDistinctLotsFromMatchingRows(rows, 10);
    assert.equal(totalDistinct, 3);
    assert.deepEqual(lots.map((l) => l.lot), ["A", "B", "C"]);
    assert.equal(lots[0]!.slotCount, 2);
  });

  it("shouldFetchFullRowsForListing only for small distinct lot counts", () => {
    assert.equal(shouldFetchFullRowsForListing(0), false);
    assert.equal(shouldFetchFullRowsForListing(1), true);
    assert.equal(shouldFetchFullRowsForListing(14), true);
    assert.equal(
      shouldFetchFullRowsForListing(JB_LISTING_FULL_ROWS_MAX_LOTS),
      true
    );
    assert.equal(
      shouldFetchFullRowsForListing(JB_LISTING_FULL_ROWS_MAX_LOTS + 1),
      false
    );
  });

  it("full matching rows cover yield rank for all lots when totalDistinct ≤ 20", () => {
    // Simulate >200 detail rows across 3 lots (would truncate under limit 200).
    const rows: Record<string, unknown>[] = [];
    for (let lotIdx = 0; lotIdx < 3; lotIdx++) {
      const lot = `LOT_${lotIdx}`;
      for (let i = 0; i < 80; i++) {
        rows.push({
          LOT: lot,
          DEVICE: "D",
          SLOT: (i % 25) + 1,
          PASSID: 1,
          CARDID: `CARD-${lotIdx}`,
          TESTEND: `2026-07-${String(19 - lotIdx).padStart(2, "0")}T00:00:00.000Z`,
          GROSSDIE: 100,
          bins: [
            { n: 1, value: 90 - lotIdx, isGoodBin: true },
            { n: 7, value: 10 + lotIdx, isGoodBin: false },
          ],
        });
      }
    }
    assert.ok(rows.length > 200);
    const { lots, totalDistinct } = buildDistinctLotsFromMatchingRows(rows);
    assert.equal(totalDistinct, 3);
    assert.ok(shouldFetchFullRowsForListing(totalDistinct));
    const out = wrapJbQueryResultForAgent(rows, {
      recentLotsOverride: lots,
      totalDistinctLots: totalDistinct,
    });
    const rank = out.lotYieldRankByTestEnd as Array<{ lot: string }>;
    assert.equal(rank.length, 3);
    const recent = out.recentLotsByTestEnd as Array<{
      lot: string;
      cardIds: string[];
    }>;
    for (const e of recent) {
      assert.ok(e.cardIds.length > 0, `expected cardIds for ${e.lot}`);
    }
  });
});
