import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildTopBadBins,
  buildBin10Vs66ByLot,
  buildCardByPassId,
  buildCardChangesBySlotPass,
  buildRecentLotsByTestEnd,
  buildSlotBadBinsCompact,
  formatJbRowsForAgent,
  normalizeBinsForAgent,
  serializeJbQueryResultForAgent,
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

  it("wrapJbQueryResultForAgent serializes interruptHalf yieldPct 0 in slotYieldSummary", () => {
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
    const out = wrapJbQueryResultForAgent(rows);
    const json = JSON.stringify(out);
    assert.ok(json.includes('"yieldPct":0'), "JSON must include yieldPct 0 for zero-yield half");
    const summary = out.slotYieldSummary as Array<{
      slot: number;
      interruptHalf?: { yieldPct: number | null; goodDie: number };
    }>;
    const s21 = summary.find((x) => x.slot === 21)!;
    assert.equal(s21.interruptHalf!.goodDie, 0);
    assert.equal(s21.interruptHalf!.yieldPct, 0);
    assert.ok(String(out._slotYieldGuide).includes("0%"));
    const md = String(out.slotYieldInterruptMarkdown);
    assert.ok(md.includes("整片正片（合并）"));
    assert.ok(md.includes("前半段"));
    assert.ok(md.includes("后半段"));
    const firstIdx = md.indexOf("前半段");
    const secondIdx = md.indexOf("后半段");
    const wholeIdx = md.indexOf("整片正片（合并）");
    assert.ok(firstIdx < secondIdx && secondIdx < wholeIdx);
    const ultra = serializeJbQueryResultForAgent(out, 8000);
    const parsed = JSON.parse(ultra) as {
      slotYieldInterruptMarkdown?: string;
      slotYieldSummary?: Array<{ interruptHalf?: { yieldPct: number } }>;
    };
    if (parsed.slotYieldInterruptMarkdown) {
      assert.ok(parsed.slotYieldInterruptMarkdown.includes("前半段"));
    }
    const slim = parsed.slotYieldSummary?.find((x) => x.slot === 21);
    if (slim?.interruptHalf) assert.equal(slim.interruptHalf.yieldPct, 0);
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

  it("buildSlotBadBinsCompact sums bad bins per slot across rows", () => {
    const rows = [
      {
        SLOT: 23,
        bins: [
          { n: 7, value: 100, isGoodBin: false },
          { n: 3, value: 5, isGoodBin: false },
        ],
      },
      {
        SLOT: 23,
        bins: [{ n: 7, value: 24, isGoodBin: false }],
      },
      {
        SLOT: 24,
        bins: [{ n: 7, value: 134, isGoodBin: false }],
      },
    ] as Record<string, unknown>[];
    const compact = buildSlotBadBinsCompact(rows);
    assert.deepEqual(compact, [
      {
        slot: 23,
        passId: 0,
        cardId: "(unknown)",
        badBins: [
          { bin: 3, dieCount: 5, isGoodBin: false },
          { bin: 7, dieCount: 124, isGoodBin: false },
        ],
      },
      {
        slot: 24,
        passId: 0,
        cardId: "(unknown)",
        badBins: [{ bin: 7, dieCount: 134, isGoodBin: false }],
      },
    ]);
  });

  it("buildSlotBadBinsCompact does not merge different CARDID on same slot and pass", () => {
    const rows = [
      {
        SLOT: 1,
        PASSID: 1,
        CARDID: "6093-01",
        PASSTYPE: "INTERRUPT",
        bins: [{ n: 7, value: 10, isGoodBin: false }],
      },
      {
        SLOT: 1,
        PASSID: 1,
        CARDID: "6095-02",
        PASSTYPE: "TEST",
        bins: [{ n: 7, value: 20, isGoodBin: false }],
      },
    ] as Record<string, unknown>[];
    assert.deepEqual(buildSlotBadBinsCompact(rows), [
      {
        slot: 1,
        passId: 1,
        cardId: "6093-01",
        badBins: [{ bin: 7, dieCount: 10, isGoodBin: false }],
      },
      {
        slot: 1,
        passId: 1,
        cardId: "6095-02",
        badBins: [{ bin: 7, dieCount: 20, isGoodBin: false }],
      },
    ]);
    assert.deepEqual(buildCardChangesBySlotPass(rows), [
      {
        slot: 1,
        passId: 1,
        cardIds: ["6093-01", "6095-02"],
        hasCardChange: true,
        hasTestInterrupt: true,
      },
    ]);
  });

  it("flags cardChangeWithoutInterrupt when multi CARDID but no interrupt rows", () => {
    const rows = [
      { SLOT: 2, PASSID: 1, CARDID: "A-01", PASSTYPE: "TEST", bins: [] },
      { SLOT: 2, PASSID: 1, CARDID: "B-02", PASSTYPE: "TEST", bins: [] },
    ] as Record<string, unknown>[];
    const [entry] = buildCardChangesBySlotPass(rows);
    assert.equal(entry!.hasCardChange, true);
    assert.equal(entry!.hasTestInterrupt, false);
    assert.equal(entry!.cardChangeWithoutInterrupt, true);
  });

  it("different passId with different CARDID is not mid-run card change", () => {
    const rows = [
      {
        SLOT: 1,
        PASSID: 1,
        CARDID: "8041-08",
        LOT: "L1",
        bins: [{ n: 7, value: 10, isGoodBin: false }],
      },
      {
        SLOT: 1,
        PASSID: 3,
        CARDID: "8041-05",
        LOT: "L1",
        bins: [{ n: 7, value: 20, isGoodBin: false }],
      },
    ] as Record<string, unknown>[];
    assert.deepEqual(buildCardChangesBySlotPass(rows), [
      {
        slot: 1,
        passId: 1,
        cardIds: ["8041-08"],
        hasCardChange: false,
        hasTestInterrupt: false,
      },
      {
        slot: 1,
        passId: 3,
        cardIds: ["8041-05"],
        hasCardChange: false,
        hasTestInterrupt: false,
      },
    ]);
    assert.deepEqual(buildCardByPassId(rows), [
      { passId: 1, cardIds: ["8041-08"], hasCardChange: false },
      { passId: 3, cardIds: ["8041-05"], hasCardChange: false },
    ]);
    const [lot] = buildRecentLotsByTestEnd(rows, 5);
    assert.equal(lot!.hasCardChangeInLot, false);
  });

  it("wrapJbQueryResultForAgent includes slotBadBinsCompact guide", () => {
    const out = wrapJbQueryResultForAgent([
      { SLOT: 1, bins: [{ n: 7, value: 10, isGoodBin: false }] },
    ] as Record<string, unknown>[]);
    assert.ok(String(out._slotBadBinsCompactGuide).includes("slotBadBinsCompact"));
    const compact = out.slotBadBinsCompact as Array<{ slot: number; badBins: unknown[] }>;
    assert.equal(compact[0]!.slot, 1);
    assert.deepEqual(compact[0]!.badBins, [
      { bin: 7, dieCount: 10, isGoodBin: false },
    ]);
  });

  it("buildRecentLotsByTestEnd uses max TESTEND per lot and sorts desc", () => {
    const rows = [
      { LOT: "TR13069.1F", DEVICE: "WA01", CARDID: "7747-01", TESTEND: "2026-05-20T10:00:00.000Z", SLOT: 1 },
      { LOT: "TR13073.1Y", DEVICE: "WA01", CARDID: "7747-01", TESTEND: "2026-05-25T10:00:00.000Z", SLOT: 2 },
      { LOT: "TR13069.1F", DEVICE: "WA01", CARDID: "7747-01", TESTEND: "2026-05-10T10:00:00.000Z", SLOT: 3 },
      { LOT: "TR17367.1T", DEVICE: "WA02", CARDID: "7747-01", TESTEND: "2026-05-22T10:00:00.000Z", SLOT: 1 },
    ] as Record<string, unknown>[];
    assert.deepEqual(buildRecentLotsByTestEnd(rows, 3), [
      {
        lot: "TR13073.1Y",
        device: "WA01",
        cardIds: ["7747-01"],
        hasCardChangeInLot: false,
        cardId: "7747-01",
        testEnd: "2026-05-25T10:00:00.000Z",
        slots: [2],
        slotCount: 1,
      },
      {
        lot: "TR17367.1T",
        device: "WA02",
        cardIds: ["7747-01"],
        hasCardChangeInLot: false,
        cardId: "7747-01",
        testEnd: "2026-05-22T10:00:00.000Z",
        slots: [1],
        slotCount: 1,
      },
      {
        lot: "TR13069.1F",
        device: "WA01",
        cardIds: ["7747-01"],
        hasCardChangeInLot: false,
        cardId: "7747-01",
        testEnd: "2026-05-20T10:00:00.000Z",
        slots: [1, 3],
        slotCount: 2,
      },
    ]);
  });

  it("buildRecentLotsByTestEnd hasCardChangeInLot only for same (slot,pass) multi CARDID", () => {
    const rows = [
      {
        LOT: "DR45459.1A",
        DEVICE: "WA02N27G",
        CARDID: "6093-01",
        PASSID: 1,
        TESTEND: "2026-05-29T15:04:11.000Z",
        SLOT: 5,
      },
      {
        LOT: "DR45459.1A",
        DEVICE: "WA02N27G",
        CARDID: "6095-02",
        PASSID: 3,
        TESTEND: "2026-05-28T10:00:00.000Z",
        SLOT: 1,
      },
    ] as Record<string, unknown>[];
    const [lot] = buildRecentLotsByTestEnd(rows, 5);
    assert.equal(lot!.lot, "DR45459.1A");
    assert.equal(lot!.hasCardChangeInLot, false);
    assert.deepEqual(lot!.cardIds, ["6093-01", "6095-02"]);
    assert.equal(lot!.cardId, "6093-01");
  });

  it("buildRecentLotsByTestEnd hasCardChangeInLot is per-lot, not contaminated by other lots", () => {
    // Bug regression: lotHasMidRunCardChange(rows) used to scan ALL rows, so any lot
    // with a card change would set hasCardChangeInLot=true for every lot in the result.
    const rows = [
      // Lot A: same slot+pass, two different CARDIDs → mid-run card change
      { LOT: "A", SLOT: 1, PASSID: 1, CARDID: "6093-01", PASSTYPE: "INTERRUPT", TESTEND: "2026-05-29T10:00:00.000Z", bins: [] },
      { LOT: "A", SLOT: 1, PASSID: 1, CARDID: "6095-02", PASSTYPE: "TEST",      TESTEND: "2026-05-29T11:00:00.000Z", bins: [] },
      // Lot B: single card, no change
      { LOT: "B", SLOT: 1, PASSID: 1, CARDID: "7747-01", PASSTYPE: "TEST",      TESTEND: "2026-05-28T10:00:00.000Z", bins: [] },
    ] as Record<string, unknown>[];
    const result = buildRecentLotsByTestEnd(rows, 5);
    const lotA = result.find((x) => x.lot === "A")!;
    const lotB = result.find((x) => x.lot === "B")!;
    assert.equal(lotA.hasCardChangeInLot, true, "lot A should have card change");
    assert.equal(lotB.hasCardChangeInLot, false, "lot B must NOT be contaminated by lot A");
  });

  it("buildRecentLotsByTestEnd uses first-row values when all TESTEND are null", () => {
    // Bug regression: !entry._testEndMs was always true when ms=0, so every row
    // overwrote cardId/device — last-row-wins instead of first-row-wins.
    const rows = [
      { LOT: "X", DEVICE: "D1", CARDID: "first-card", PASSTYPE: "TEST", bins: [] },
      { LOT: "X", DEVICE: "D2", CARDID: "second-card", PASSTYPE: "TEST", bins: [] },
    ] as Record<string, unknown>[];
    const [lot] = buildRecentLotsByTestEnd(rows, 5);
    assert.equal(lot!.cardId, "first-card", "first row should win when TESTEND is absent");
  });

  it("buildCardChangesBySlotPass hasTestInterrupt false for normal multi-TEST same-PASSNUM group", () => {
    // Bug regression: splitPassGroupIntoHalves.segmented returns true for 2+ TEST rows
    // at the same PASSNUM even with no interrupt, causing a false hasTestInterrupt.
    const rows = [
      { SLOT: 3, PASSID: 1, CARDID: "7747-01", PASSTYPE: "TEST", PASSNUM: 1, bins: [] },
      { SLOT: 3, PASSID: 1, CARDID: "7747-01", PASSTYPE: "TEST", PASSNUM: 1, bins: [] },
    ] as Record<string, unknown>[];
    const [entry] = buildCardChangesBySlotPass(rows);
    assert.equal(entry!.hasCardChange, false);
    assert.equal(entry!.hasTestInterrupt, false, "normal multi-TEST rows must not be flagged as interrupted");
  });

  it("wrapJbQueryResultForAgent includes recentLotsByTestEnd", () => {
    const out = wrapJbQueryResultForAgent([
      { LOT: "A", DEVICE: "D", CARDID: "7747-01", TESTEND: "2026-05-01T00:00:00.000Z", SLOT: 1, bins: [] },
      { LOT: "B", DEVICE: "D", CARDID: "7747-01", TESTEND: "2026-05-02T00:00:00.000Z", SLOT: 1, bins: [] },
    ] as Record<string, unknown>[]);
    assert.ok(String(out._recentLotsGuide).includes("recentLotsByTestEnd"));
    assert.equal(out.distinctLotCount, 2);
    const recent = out.recentLotsByTestEnd as Array<{ lot: string }>;
    assert.deepEqual(recent.map((x) => x.lot), ["B", "A"]);
  });

  it("buildTopBadBins sums bad bins across rows in scope", () => {
    const rows = [
      {
        LOT: "NF12827.1R",
        SLOT: 1,
        bins: [
          { n: 8, value: 100, isGoodBin: false },
          { n: 3, value: 10, isGoodBin: false },
        ],
      },
      {
        LOT: "NF12827.1R",
        SLOT: 2,
        bins: [
          { n: 8, value: 50, isGoodBin: false },
          { n: 15, value: 200, isGoodBin: false },
        ],
      },
    ] as Record<string, unknown>[];
    assert.deepEqual(buildTopBadBins(rows, 5), [
      { bin: 15, dieCount: 200 },
      { bin: 8, dieCount: 150 },
      { bin: 3, dieCount: 10 },
    ]);
    const out = wrapJbQueryResultForAgent(rows);
    assert.ok(String(out._topBadBinsGuide).includes("topBadBins"));
    assert.deepEqual(out.topBadBins, buildTopBadBins(rows, 15));
  });

  it("buildBin10Vs66ByLot sums per lot across slots", () => {
    const rows = [
      {
        LOT: "TR13069.1F",
        DEVICE: "WA01",
        SLOT: 1,
        bins: [
          { n: 66, value: 3000, isGoodBin: false },
          { n: 10, value: 100, isGoodBin: false },
        ],
      },
      {
        LOT: "TR13069.1F",
        DEVICE: "WA01",
        SLOT: 2,
        bins: [
          { n: 66, value: 2000, isGoodBin: false },
          { n: 10, value: 4000, isGoodBin: false },
        ],
      },
      {
        LOT: "TR13073.1Y",
        DEVICE: "WA01",
        SLOT: 1,
        bins: [{ n: 66, value: 5000, isGoodBin: false }],
      },
    ] as Record<string, unknown>[];
    const out = buildBin10Vs66ByLot(rows);
    const t1 = out.find((x) => x.lot === "TR13069.1F")!;
    assert.equal(t1.bin10, 4100);
    assert.equal(t1.bin66, 5000);
    assert.equal(t1.bin10GtBin66, false);
    const t2 = out.find((x) => x.lot === "TR13073.1Y")!;
    assert.equal(t2.bin10, 0);
    assert.equal(t2.bin66, 5000);
  });

  it("wrapJbQueryResultForAgent includes lotYieldRankByTestEnd", () => {
    const out = wrapJbQueryResultForAgent([
      {
        LOT: "L1",
        DEVICE: "D",
        SLOT: 1,
        PASSID: 1,
        GROSSDIE: 100,
        TESTEND: "2026-05-02T00:00:00.000Z",
        bins: [
          { n: 1, value: 80, isGoodBin: true },
          { n: 5, value: 20, isGoodBin: false },
        ],
      },
      {
        LOT: "L2",
        DEVICE: "D",
        SLOT: 1,
        PASSID: 1,
        GROSSDIE: 100,
        TESTEND: "2026-05-03T00:00:00.000Z",
        bins: [
          { n: 1, value: 95, isGoodBin: true },
          { n: 5, value: 5, isGoodBin: false },
        ],
      },
    ] as Record<string, unknown>[]);
    assert.ok(String(out._lotYieldRankGuide).includes("lotYieldRankByTestEnd"));
    const rank = out.lotYieldRankByTestEnd as Array<{ lot: string; yieldPct: number }>;
    assert.deepEqual(rank.map((x) => x.lot), ["L2", "L1"]);
    assert.ok(Math.abs(rank[1]!.yieldPct - 80) < 0.1);
  });

  it("wrapJbQueryResultForAgent includes bin10Vs66ByLot", () => {
    const out = wrapJbQueryResultForAgent([
      {
        LOT: "L1",
        DEVICE: "D",
        SLOT: 1,
        bins: [
          { n: 10, value: 50, isGoodBin: false },
          { n: 66, value: 10, isGoodBin: false },
        ],
      },
    ] as Record<string, unknown>[]);
    assert.ok(String(out._bin10Vs66ByLotGuide).includes("bin10Vs66ByLot"));
    const cmp = out.bin10Vs66ByLot as Array<{ lot: string; bin10GtBin66: boolean }>;
    assert.equal(cmp[0]!.bin10GtBin66, true);
  });

  it("serializeJbQueryResultForAgent omits rows when payload too large", () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      SLOT: i + 1,
      LOT: "NF12316.1X",
      DEVICE: "WA03P02G",
      CARDID: "8041-05",
      TESTERID: "b3uflex17",
      PASSID: 1,
      GROSSDIE: 5000,
      bins: Array.from({ length: 20 }, (__, j) => ({
        n: j + 2,
        value: 50 + j,
        isGoodBin: false,
      })),
    })) as Record<string, unknown>[];
    const wrapped = wrapJbQueryResultForAgent(rows);
    const json = serializeJbQueryResultForAgent(wrapped, 6000);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    assert.equal(parsed.rowsOmitted, true);
    assert.equal(parsed.rowCount, 30);
    assert.equal(parsed.rows, undefined);
    assert.ok(!json.endsWith("…(truncated)"), "must remain valid JSON");
    const summary = parsed.slotYieldSummary as Array<{ slot: number }> | undefined;
    const compact = parsed.slotBadBinsCompact as Array<{ slot: number }> | undefined;
    const binBySlot = parsed.binBySlot as
      | Record<string, Record<string, number>>
      | undefined;
    if (compact) {
      assert.deepEqual(
        compact.map((x) => x.slot),
        Array.from({ length: 30 }, (_, i) => i + 1)
      );
    } else if (summary?.length) {
      assert.equal(summary.length, 30);
      assert.equal(summary.find((x) => x.slot === 23)?.slot, 23);
    } else if (binBySlot) {
      assert.equal(Object.keys(binBySlot).length, 30);
      assert.equal(binBySlot["23:1:8041-05"]?.["7"], 55);
    } else {
      assert.fail("expected slotBadBinsCompact, slotYieldSummary, or binBySlot");
    }
  });
});
