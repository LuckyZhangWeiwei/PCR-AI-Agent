import assert from "node:assert/strict";
import test from "node:test";
import { formatAllDutsHighlightMarkdown } from "../src/lib/agent/agentUnderperformingDutView.js";
import type { PassUnderperformingDutsResult } from "../src/lib/lotUnderperformingDuts.js";

function pass(overrides: Partial<PassUnderperformingDutsResult> = {}): PassUnderperformingDutsResult {
  return {
    passId: 1,
    sortLabel: "常温 sort1",
    dutCount: 3,
    lotGoodDie: 900,
    lotTotalDie: 1000,
    baseline: { method: "lotOverall", yieldPct: 96.38, thresholdPct: 72.29, thresholdRatio: 0.75 },
    allDuts: [
      { dut: 3, goodDie: 402, totalDie: 410, yieldPct: 98.05 },
      { dut: 8, goodDie: 300, totalDie: 408, yieldPct: 73.53 },
      { dut: 12, goodDie: 250, totalDie: 408, yieldPct: 61.27 },
    ],
    underperformingDuts: [
      { dut: 12, goodDie: 250, totalDie: 408, yieldPct: 61.27, gapToThresholdPct: -11.02 },
    ],
    ...overrides,
  };
}

test("formatAllDutsHighlightMarkdown: 低于阈值行 🔴+加粗，达标行不标", () => {
  const md = formatAllDutsHighlightMarkdown([pass()], "DR43782.1A", "WA03P02G");
  assert.match(md, /🔴 \*\*DUT12\*\*/); // 61.27 < 72.29 → 高亮
  assert.doesNotMatch(md, /🔴 \*\*DUT3\*\*/); // 98.05 达标
  assert.match(md, /lot 整体 96\.38% · 阈值 72\.29%/);
  assert.match(md, /DR43782\.1A（WA03P02G）/);
});

test("formatAllDutsHighlightMarkdown: 恰等于阈值不高亮（严格小于）", () => {
  const p = pass({
    allDuts: [{ dut: 5, goodDie: 1, totalDie: 1, yieldPct: 72.29 }],
    underperformingDuts: [],
  });
  const md = formatAllDutsHighlightMarkdown([p], "L", "D");
  assert.doesNotMatch(md, /🔴/);
});

test("formatAllDutsHighlightMarkdown: baseline=null 或空 DUT 跳过；全空返回空串", () => {
  const p = pass({ baseline: null, allDuts: [] });
  assert.equal(formatAllDutsHighlightMarkdown([p], "L", "D"), "");
});
