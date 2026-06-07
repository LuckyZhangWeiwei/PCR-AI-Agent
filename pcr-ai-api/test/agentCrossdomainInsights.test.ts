// pcr-ai-api/test/agentCrossdomainInsights.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildCardDegradationSignal,
  CARD_DEGRADATION_SIGNAL_GUIDE,
} from "../src/lib/agent/agentCrossdomainInsights.js";

/** JB 行：每行一片 wafer。
 *  buildSlotYieldSummary 用 GROSSDIE 和 bins 中坏 die 之差计算良率。
 *  yield% = (GROSSDIE - badDie) / GROSSDIE * 100
 */
function makeJbRow(
  lot: string,
  slot: number,
  testEnd: string,
  passId: number,
  grossDie: number,
  badDie: number
): Record<string, unknown> {
  const goodDie = grossDie - badDie;
  return {
    LOT: lot,
    SLOT: slot,
    TESTEND: testEnd,
    PASSID: passId,
    GROSSDIE: grossDie,
    bins: [
      { n: 1, value: goodDie, isGoodBin: true },
      { n: 10, value: badDie, isGoodBin: false },
    ],
  };
}

function makeYmRow(lotId: string, timeStamp: string): Record<string, unknown> {
  return { LOTID: lotId, TIME_STAMP: timeStamp };
}

describe("CARD_DEGRADATION_SIGNAL_GUIDE", () => {
  it("contains cardDegradationSignal keyword", () => {
    assert.ok(CARD_DEGRADATION_SIGNAL_GUIDE.includes("cardDegradationSignal"));
  });
  it("mentions signalStrength=strong", () => {
    assert.ok(CARD_DEGRADATION_SIGNAL_GUIDE.includes("signalStrength=strong"));
  });
});

describe("buildCardDegradationSignal", () => {
  it("returns null when fewer than 3 lots", () => {
    const jb = [
      makeJbRow("L1", 1, "2025-01-01", 1, 900, 100),
      makeJbRow("L2", 1, "2025-01-02", 1, 900, 100),
    ];
    assert.equal(buildCardDegradationSignal(jb, [], "7747-01"), null);
  });

  it("returns null when all rows lack testEnd", () => {
    const jb = [
      { LOT: "L1", SLOT: 1, TESTEND: "", PASSID: 1, bins: [] },
      { LOT: "L2", SLOT: 1, TESTEND: "", PASSID: 1, bins: [] },
      { LOT: "L3", SLOT: 1, TESTEND: "", PASSID: 1, bins: [] },
    ];
    assert.equal(buildCardDegradationSignal(jb, [], "7747-01"), null);
  });

  it("returns non-null with 3+ lots and correct structure", () => {
    const jb = [
      makeJbRow("L1", 1, "2025-01-01", 1, 950, 50),
      makeJbRow("L2", 1, "2025-02-01", 1, 940, 60),
      makeJbRow("L3", 1, "2025-03-01", 1, 930, 70),
    ];
    const result = buildCardDegradationSignal(jb, [], "7747-01");
    assert.ok(result !== null);
    assert.equal(result.cardId, "7747-01");
    assert.ok(result.analyzedLots >= 3);
    assert.ok(["rising", "stable", "falling", "insufficient_data"].includes(result.ymTrend));
    assert.ok(["falling", "stable", "rising", "insufficient_data"].includes(result.jbYieldTrend));
    assert.ok(["strong", "moderate", "none"].includes(result.signalStrength));
    assert.ok(result.evidence.length > 0);
    assert.ok(result.summaryMarkdown.length > 0);
    assert.ok(result.summaryMarkdown.includes("7747-01"));
  });

  it("jbOnlyLots counts lots without YM data", () => {
    const jb = [
      makeJbRow("L1", 1, "2025-01-01", 1, 900, 100),
      makeJbRow("L2", 1, "2025-02-01", 1, 900, 100),
      makeJbRow("L3", 1, "2025-03-01", 1, 900, 100),
    ];
    const ym = [makeYmRow("L1", "2025-01-01")];  // only L1 in YM
    const result = buildCardDegradationSignal(jb, ym, "7747-01");
    assert.ok(result !== null);
    assert.equal(result.jbOnlyLots, 2);  // L2, L3 not in YM
  });

  it("detects strong signal: ymTrend=rising + jbYieldTrend=falling", () => {
    // 8 lots: early 4 have good yield + low YM triggers; late 4 have bad yield + many triggers
    const jb: Record<string, unknown>[] = [];
    const ym: Record<string, unknown>[] = [];

    // Early lots: 98% yield, 1 YM trigger each
    for (let i = 1; i <= 4; i++) {
      const lot = `E${i}`;
      const date = `2025-0${i}-01`;
      jb.push(makeJbRow(lot, 1, date, 1, 980, 20));
      ym.push(makeYmRow(lot, date));
    }
    // Late lots: 92% yield, 5 YM triggers each
    for (let i = 1; i <= 4; i++) {
      const lot = `L${i}`;
      const date = `2025-0${i + 5}-01`;
      jb.push(makeJbRow(lot, 1, date, 1, 920, 80));
      for (let t = 0; t < 5; t++) ym.push(makeYmRow(lot, date));
    }

    const result = buildCardDegradationSignal(jb, ym, "7747-01");
    assert.ok(result !== null);
    // Both trends should be in concerning direction
    assert.equal(result.ymTrend, "rising");
    assert.equal(result.jbYieldTrend, "falling");
    assert.equal(result.signalStrength, "strong");
  });

  it("detects none when both trends stable", () => {
    const jb: Record<string, unknown>[] = [];
    const ym: Record<string, unknown>[] = [];
    // 6 lots: stable 95% yield, stable 2 YM triggers each
    for (let i = 1; i <= 6; i++) {
      const lot = `S${i}`;
      const date = `2025-0${i}-01`;
      jb.push(makeJbRow(lot, 1, date, 1, 950, 50));
      ym.push(makeYmRow(lot, date));
      ym.push(makeYmRow(lot, date));
    }
    const result = buildCardDegradationSignal(jb, ym, "7747-01");
    assert.ok(result !== null);
    assert.equal(result.signalStrength, "none");
  });

  it("evidence is sorted most-recent first", () => {
    const jb = [
      makeJbRow("L1", 1, "2025-01-01", 1, 900, 100),
      makeJbRow("L2", 1, "2025-02-01", 1, 900, 100),
      makeJbRow("L3", 1, "2025-03-01", 1, 900, 100),
    ];
    const result = buildCardDegradationSignal(jb, [], "7747-01");
    assert.ok(result !== null);
    // Most recent (L3) should be first
    assert.equal(result.evidence[0]!.lot, "L3");
  });

  it("summaryMarkdown contains table header", () => {
    const jb = [
      makeJbRow("L1", 1, "2025-01-01", 1, 900, 100),
      makeJbRow("L2", 1, "2025-02-01", 1, 900, 100),
      makeJbRow("L3", 1, "2025-03-01", 1, 900, 100),
    ];
    const result = buildCardDegradationSignal(jb, [], "7747-01");
    assert.ok(result !== null);
    assert.ok(result.summaryMarkdown.includes("| Lot |"));
    assert.ok(result.summaryMarkdown.includes("YM 触发次数"));
  });
});
