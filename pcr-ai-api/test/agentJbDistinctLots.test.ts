import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildInfcontrolLayerBinsV3DistinctLotsSql } from "../src/lib/apiV3ListSql.js";
import { buildDistinctLotsFromMatchingRows } from "../src/lib/agent/agentJbDistinctLots.js";

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
});
