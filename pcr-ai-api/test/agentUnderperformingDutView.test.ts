import assert from "node:assert/strict";
import test from "node:test";
import {
  formatAllDutsHighlightMarkdown,
  buildUnderperformingDutScatterOptions,
} from "../src/lib/agent/agentUnderperformingDutView.js";
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

test("formatAllDutsHighlightMarkdown: 多列布局，一行并排多个 DUT", () => {
  const md = formatAllDutsHighlightMarkdown([pass()], "L", "D");
  // 表头一行含 3 组「DUT | 良率% | good/total」
  assert.match(md, /\| DUT \| 良率% \| good\/total \| DUT \| 良率% \| good\/total \| DUT \| 良率% \| good\/total \|/);
  // 3 个 DUT 在同一行（升序 sort 后 DUT12 最低排首）
  const bodyLine = md.split("\n").find((l) => l.includes("DUT12") && l.includes("DUT8") && l.includes("DUT3"));
  assert.ok(bodyLine, "三个 DUT 应并排在同一行");
});

test("formatAllDutsHighlightMarkdown: 整体良率0% 退化 → 异常提示，非「全部达标」", () => {
  const zero = pass({
    lotGoodDie: 0,
    baseline: { method: "lotOverall", yieldPct: 0, thresholdPct: 0, thresholdRatio: 0.75 },
    allDuts: [
      { dut: 0, goodDie: 0, totalDie: 26, yieldPct: 0 },
      { dut: 1, goodDie: 0, totalDie: 24, yieldPct: 0 },
    ],
    underperformingDuts: [],
  });
  const md = formatAllDutsHighlightMarkdown([zero], "NF12499.1N", "WA03P02G");
  assert.match(md, /⚠️ 整体良率 0%/);
  assert.doesNotMatch(md, /全部达标/);
  assert.doesNotMatch(md, /🔴/); // 退化时不误标红
});

test("buildUnderperformingDutScatterOptions: 三色带 + 平均/阈值 markLine", () => {
  const opts = buildUnderperformingDutScatterOptions([pass()]);
  assert.equal(opts.length, 1);
  const series = (opts[0].option as any).series[0];
  const colors = series.data.map((p: any) => p.itemStyle.color);
  // DUT3=98.05(≥96.38 绿) DUT8=73.53(72.29~96.38 黄) DUT12=61.27(<72.29 红)
  // data 按 dut 升序：3,8,12
  assert.equal(colors[0], "#4caf50");
  assert.equal(colors[1], "#f0a020");
  assert.equal(colors[2], "#e15b64");
  const markYs = series.markLine.data.map((m: any) => m.yAxis).sort((a: number, b: number) => a - b);
  assert.deepEqual(markYs, [72.29, 96.38]);
});

test("buildUnderperformingDutScatterOptions: baseline=null / 空 DUT 跳过", () => {
  const p = pass({ baseline: null, allDuts: [] });
  assert.equal(buildUnderperformingDutScatterOptions([p]).length, 0);
});
