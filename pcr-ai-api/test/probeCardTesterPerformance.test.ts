import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  mean,
  median,
  rowYieldPct,
  sampleStdDev,
  computeProbeCardTesterPerformance,
  buildProbeCardPerfSummaryMarkdown,
} from "../src/lib/probeCard/probeCardTesterPerformance.js";

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

  test("floors at 0 when bad die exceeds GROSSDIE (interrupt-partial row)", () => {
    const row = {
      GROSSDIE: 50,
      PASSBIN: undefined,
      bins: [{ n: 5, value: 80, isGoodBin: false }],
    };
    assert.equal(rowYieldPct(row), 0);
  });
});

function jbRow(opts: {
  cardId: string;
  testerId: string;
  passId: number;
  lot: string;
  testEnd: string;
  grossDie: number;
  badBins?: { n: number; value: number }[];
}): Record<string, unknown> {
  return {
    CARDID: opts.cardId,
    TESTERID: opts.testerId,
    PASSID: opts.passId,
    LOT: opts.lot,
    TESTEND: opts.testEnd,
    GROSSDIE: opts.grossDie,
    PASSBIN: undefined,
    bins: (opts.badBins ?? []).map((b) => ({ n: b.n, value: b.value, isGoodBin: false })),
  };
}

describe("computeProbeCardTesterPerformance: grouping and ranking", () => {
  test("groups by passId, never merges 1/3/5", () => {
    const rows = [
      jbRow({ cardId: "A-01", testerId: "T1", passId: 1, lot: "L1.1A", testEnd: "2026-01-05", grossDie: 100 }),
      jbRow({ cardId: "A-01", testerId: "T1", passId: 3, lot: "L1.1A", testEnd: "2026-01-05", grossDie: 100 }),
    ];
    const groups = computeProbeCardTesterPerformance(rows);
    assert.equal(groups.length, 2);
    assert.deepEqual(groups.map((g) => g.passId).sort(), [1, 3]);
  });

  test("comboRanking sorted by avgYield desc, tie broken by stdDev asc", () => {
    const rows = [
      // Card B: 2 records, both 100% yield -> avg 100, stddev 0
      jbRow({ cardId: "B-01", testerId: "T2", passId: 1, lot: "L1", testEnd: "2026-01-01", grossDie: 100 }),
      jbRow({ cardId: "B-01", testerId: "T2", passId: 1, lot: "L2", testEnd: "2026-02-01", grossDie: 100 }),
      // Card A: 1 record, 90% yield
      jbRow({ cardId: "A-01", testerId: "T1", passId: 1, lot: "L3", testEnd: "2026-01-01", grossDie: 100, badBins: [{ n: 5, value: 10 }] }),
    ];
    const [group] = computeProbeCardTesterPerformance(rows);
    assert.equal(group!.comboRanking[0]!.cardId, "B-01");
    assert.equal(group!.comboRanking[0]!.avgYieldPct, 100);
    assert.equal(group!.comboRanking[1]!.cardId, "A-01");
  });

  test("confidenceTier from lotCount: >=10 高, 3-9 中, <3 低", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      jbRow({ cardId: "C-01", testerId: "T1", passId: 1, lot: `L${i}`, testEnd: "2026-01-01", grossDie: 100 })
    );
    const mid = Array.from({ length: 3 }, (_, i) =>
      jbRow({ cardId: "C-02", testerId: "T1", passId: 1, lot: `M${i}`, testEnd: "2026-01-01", grossDie: 100 })
    );
    const few = [jbRow({ cardId: "C-03", testerId: "T1", passId: 1, lot: "F0", testEnd: "2026-01-01", grossDie: 100 })];
    const [group] = computeProbeCardTesterPerformance([...many, ...mid, ...few]);
    const byId = new Map(group!.cardRanking.map((r) => [r.cardId, r]));
    assert.equal(byId.get("C-01")!.confidenceTier, "高");
    assert.equal(byId.get("C-02")!.confidenceTier, "中");
    assert.equal(byId.get("C-03")!.confidenceTier, "低");
  });

  test("cardRanking assessment: lotCount<3 wins first regardless of yield", () => {
    const rows = [jbRow({ cardId: "D-01", testerId: "T1", passId: 1, lot: "L1", testEnd: "2026-01-01", grossDie: 100 })];
    const [group] = computeProbeCardTesterPerformance(rows);
    assert.equal(group!.cardRanking[0]!.assessment, "样本有限，置信度低");
  });

  test("cardRanking assessment: avgYield far below group mean -> 良率明显偏低", () => {
    // 5 cards with lotCount>=3 each, one is a clear outlier low-yield card
    const good = ["E-01", "E-02", "E-03", "E-04"].flatMap((cardId) =>
      Array.from({ length: 3 }, (_, i) =>
        jbRow({ cardId, testerId: "T1", passId: 1, lot: `${cardId}-${i}`, testEnd: "2026-01-01", grossDie: 100 })
      )
    );
    const bad = Array.from({ length: 3 }, (_, i) =>
      jbRow({ cardId: "E-05", testerId: "T1", passId: 1, lot: `E-05-${i}`, testEnd: "2026-01-01", grossDie: 100, badBins: [{ n: 5, value: 60 }] })
    );
    const [group] = computeProbeCardTesterPerformance([...good, ...bad]);
    const worst = group!.cardRanking.find((r) => r.cardId === "E-05")!;
    assert.equal(worst.assessment, "良率明显偏低");
  });

  // Shared scenario for assessment rules 3 & 4: 4 cards, same passId group,
  // each lotCount=3 (clears rule 1) and same avgYieldPct=95 (clears rule 2 —
  // no outlier vs. group mean). J-01/J-02/J-03 have 3 identical 95% rows each
  // (stdDev = 0). J-04 has rows yielding 100/90/95 (mean 95, sample stdDev =
  // sqrt(((100-95)^2+(90-95)^2+(95-95)^2)/2) = sqrt(50/2) = 5).
  // groupStdDevMedian = median([0,0,0,5]) = (0+0)/2 = 0, so J-04's stdDev (5)
  // is the only one strictly greater than the median.
  function varianceScenarioRows(): Record<string, unknown>[] {
    const flat = ["J-01", "J-02", "J-03"].flatMap((cardId) =>
      Array.from({ length: 3 }, (_, i) =>
        jbRow({
          cardId,
          testerId: "T1",
          passId: 1,
          lot: `${cardId}-${i}`,
          testEnd: "2026-01-01",
          grossDie: 100,
          badBins: [{ n: 5, value: 5 }], // yield 95 every row
        })
      )
    );
    const varied = [
      jbRow({ cardId: "J-04", testerId: "T1", passId: 1, lot: "J-04-0", testEnd: "2026-01-01", grossDie: 100 }), // yield 100
      jbRow({ cardId: "J-04", testerId: "T1", passId: 1, lot: "J-04-1", testEnd: "2026-01-01", grossDie: 100, badBins: [{ n: 5, value: 10 }] }), // yield 90
      jbRow({ cardId: "J-04", testerId: "T1", passId: 1, lot: "J-04-2", testEnd: "2026-01-01", grossDie: 100, badBins: [{ n: 5, value: 5 }] }), // yield 95
    ];
    return [...flat, ...varied];
  }

  test("cardRanking assessment: stdDev above group median -> 波动较大，稳定性差", () => {
    const [group] = computeProbeCardTesterPerformance(varianceScenarioRows());
    const byId = new Map(group!.cardRanking.map((r) => [r.cardId, r]));
    const j04 = byId.get("J-04")!;
    assert.ok(Math.abs(j04.stdDevYieldPct - 5) < 1e-6, `expected stdDev ~5, got ${j04.stdDevYieldPct}`);
    assert.equal(j04.assessment, "波动较大，稳定性差");
  });

  test("cardRanking assessment: average yield, low variance -> 表现稳定", () => {
    const [group] = computeProbeCardTesterPerformance(varianceScenarioRows());
    const byId = new Map(group!.cardRanking.map((r) => [r.cardId, r]));
    const j01 = byId.get("J-01")!;
    assert.equal(j01.stdDevYieldPct, 0);
    assert.equal(j01.assessment, "表现稳定");
  });

  test("cardTrend only includes cards with >=2 distinct months", () => {
    const rows = [
      jbRow({ cardId: "F-01", testerId: "T1", passId: 1, lot: "L1", testEnd: "2026-01-05", grossDie: 100 }),
      jbRow({ cardId: "F-01", testerId: "T1", passId: 1, lot: "L2", testEnd: "2026-02-05", grossDie: 100 }),
      // single-month card excluded
      jbRow({ cardId: "F-02", testerId: "T1", passId: 1, lot: "L3", testEnd: "2026-01-05", grossDie: 100 }),
    ];
    const [group] = computeProbeCardTesterPerformance(rows);
    const cardIds = new Set(group!.cardTrend.map((r) => r.cardId));
    assert.ok(cardIds.has("F-01"));
    assert.ok(!cardIds.has("F-02"));
    assert.equal(group!.cardTrend.filter((r) => r.cardId === "F-01").length, 2);
  });

  test("cardBadBin: top 3 bins by share of that card's total bad die", () => {
    const rows = [
      jbRow({ cardId: "G-01", testerId: "T1", passId: 1, lot: "L1", testEnd: "2026-01-01", grossDie: 200, badBins: [{ n: 7, value: 65 }, { n: 12, value: 20 }, { n: 23, value: 8 }, { n: 40, value: 7 }] }),
    ];
    const [group] = computeProbeCardTesterPerformance(rows);
    const entry = group!.cardBadBin.find((r) => r.cardId === "G-01")!;
    assert.equal(entry.topBins.length, 3);
    assert.equal(entry.topBins[0]!.bin, 7);
    assert.ok(Math.abs(entry.topBins[0]!.pct - 65) < 1e-6);
  });

  test("markdown tables include pass grouping titles, emoji ranks, and section headers", () => {
    const rows = [jbRow({ cardId: "H-01", testerId: "T1", passId: 1, lot: "L1", testEnd: "2026-01-01", grossDie: 100 })];
    const [group] = computeProbeCardTesterPerformance(rows);
    assert.ok(group!.comboRankingMarkdown.includes("H-01"));
    assert.ok(group!.cardRankingMarkdown.includes("H-01"));
    assert.match(group!.comboRankingMarkdown, /#### pass1（sort1 常温）/);
    assert.match(group!.comboRankingMarkdown, /🏆 探针卡\+机台组合排名/);
    assert.match(group!.comboRankingMarkdown, /🥇 1/);
    assert.match(group!.cardRankingMarkdown, /⚠️ 探针卡排名/);
    assert.match(group!.cardTrendMarkdown, /📈 月度趋势：每卡不足 2 个月/);
    assert.doesNotMatch(group!.comboRankingMarkdown, /\(无数据\)/);
  });

  test("buildProbeCardPerfSummaryMarkdown highlights best and worst per pass", () => {
    const rows = [
      jbRow({ cardId: "A-01", testerId: "T1", passId: 1, lot: "L1", testEnd: "2026-01-01", grossDie: 100, badBins: [{ n: 7, value: 1 }] }),
      jbRow({ cardId: "B-02", testerId: "T2", passId: 1, lot: "L2", testEnd: "2026-01-02", grossDie: 100, badBins: [{ n: 7, value: 30 }] }),
    ];
    const [group] = computeProbeCardTesterPerformance(rows);
    const md = buildProbeCardPerfSummaryMarkdown([group!], "WA03P02G");
    assert.match(md, /🏆 \*\*最佳组合\*\*/);
    assert.match(md, /⚠️ \*\*需关注卡\*\*/);
    assert.match(md, /WA03P02G/);
  });

  test("rows with GROSSDIE missing are excluded from all stats", () => {
    const rows = [
      jbRow({ cardId: "I-01", testerId: "T1", passId: 1, lot: "L1", testEnd: "2026-01-01", grossDie: 0 }),
    ];
    const groups = computeProbeCardTesterPerformance(rows);
    assert.equal(groups.length, 0);
  });
});
