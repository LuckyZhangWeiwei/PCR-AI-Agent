import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
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
        badBins: [
          { bin: 3, dieCount: 5, isGoodBin: false },
          { bin: 7, dieCount: 124, isGoodBin: false },
        ],
      },
      {
        slot: 24,
        badBins: [{ bin: 7, dieCount: 134, isGoodBin: false }],
      },
    ]);
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
        cardId: "7747-01",
        testEnd: "2026-05-25T10:00:00.000Z",
      },
      {
        lot: "TR17367.1T",
        device: "WA02",
        cardId: "7747-01",
        testEnd: "2026-05-22T10:00:00.000Z",
      },
      {
        lot: "TR13069.1F",
        device: "WA01",
        cardId: "7747-01",
        testEnd: "2026-05-20T10:00:00.000Z",
      },
    ]);
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
    const binBySlot = parsed.binBySlot as Record<string, Record<string, number>>;
    const compact = parsed.slotBadBinsCompact as Array<{ slot: number }> | undefined;
    if (compact) {
      assert.deepEqual(
        compact.map((x) => x.slot),
        Array.from({ length: 30 }, (_, i) => i + 1)
      );
    } else {
      assert.equal(Object.keys(binBySlot).length, 30);
      assert.equal(binBySlot["23"]?.["7"], 55);
    }
  });
});
