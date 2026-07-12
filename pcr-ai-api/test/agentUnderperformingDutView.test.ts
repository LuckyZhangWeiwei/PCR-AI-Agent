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

test("formatAllDutsHighlightMarkdown: 低于阈值行 🔴+加粗，低于平均行 🟡，达标(≥平均)行不标", () => {
  const md = formatAllDutsHighlightMarkdown([pass()], "DR43782.1A", "WA03P02G");
  assert.match(md, /🔴 \*\*DUT12\*\*/); // 61.27 < 72.29(阈值) → 红
  assert.match(md, /🟡 DUT8/); // 73.53 < 96.38(平均) 但 ≥ 阈值 → 黄
  assert.doesNotMatch(md, /🔴 \*\*DUT3\*\*/); // 98.05 ≥ 平均 → 不标
  assert.doesNotMatch(md, /🟡 DUT3/);
  assert.match(md, /lot 整体 96\.38% · 阈值 72\.29%/);
  assert.match(md, /DR43782\.1A（WA03P02G）/);
});

test("formatAllDutsHighlightMarkdown: 恰等于阈值不标红，但仍低于平均标黄", () => {
  const p = pass({
    allDuts: [{ dut: 5, goodDie: 1, totalDie: 1, yieldPct: 72.29 }],
    underperformingDuts: [],
  });
  const md = formatAllDutsHighlightMarkdown([p], "L", "D");
  assert.doesNotMatch(md, /🔴/);
  assert.match(md, /🟡 DUT5/); // 72.29 < 96.38(平均) → 黄
});

test("formatAllDutsHighlightMarkdown: baseline=null 或空 DUT 跳过；全空返回空串", () => {
  const p = pass({ baseline: null, allDuts: [] });
  assert.equal(formatAllDutsHighlightMarkdown([p], "L", "D"), "");
});

test("formatAllDutsHighlightMarkdown: DUT数 ≤30 时每行一个 DUT，按编号升序排列", () => {
  const md = formatAllDutsHighlightMarkdown([pass()], "L", "D");
  // 表头只有 1 组「DUT | 良率% | good/total」（DUT 数未超过并排阈值）
  assert.match(md, /\| DUT \| 良率% \| good\/total \|\n\|:--\|---:\|---:\|/);
  const lines = md.split("\n").filter((l) => /^\|\s*(🔴 \*\*|🟡 )?DUT\d/.test(l));
  // 按 DUT 编号升序：DUT3（绿）、DUT8（黄）、DUT12（红）（而非按良率排序）
  assert.match(lines[0], /^\| DUT3 \|/);
  assert.match(lines[1], /^\| 🟡 DUT8 \|/);
  assert.match(lines[2], /^\| 🔴 \*\*DUT12\*\*/);
});

test("formatAllDutsHighlightMarkdown: DUT数 >30 时一行并排 3 个 DUT，按编号升序排列", () => {
  const many = pass({
    dutCount: 32,
    allDuts: Array.from({ length: 32 }, (_, i) => ({
      dut: 31 - i, // 乱序传入，验证输出按编号升序重排
      goodDie: 90,
      totalDie: 100,
      yieldPct: 90,
    })),
    underperformingDuts: [],
  });
  const md = formatAllDutsHighlightMarkdown([many], "L", "D");
  // 表头含 3 组「DUT | 良率% | good/total」
  assert.match(md, /\| DUT \| 良率% \| good\/total \| DUT \| 良率% \| good\/total \| DUT \| 良率% \| good\/total \|/);
  // 全部 yieldPct=90 < 96.38(平均) 且 ≥ 72.29(阈值) → 全部黄标，行以 "🟡 DUT0" 开头
  const firstBodyLine = md.split("\n").find((l) => l.startsWith("| 🟡 DUT0"));
  assert.ok(firstBodyLine, "首行应从 DUT0 开始（按编号升序）");
  assert.match(firstBodyLine!, /DUT0 .* DUT1 .* DUT2 /);
});

test("formatAllDutsHighlightMarkdown: 整体良率0% 退化 → 异常提示，非「全部达标」，且无表体", () => {
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
  assert.doesNotMatch(md, /\| DUT \| 良率%/); // 不出大表
});

test("buildUnderperformingDutScatterOptions: 退化 pass（整体良率 0%）跳过", () => {
  const zero = pass({
    lotGoodDie: 0,
    baseline: { method: "lotOverall", yieldPct: 0, thresholdPct: 0, thresholdRatio: 0.75 },
    allDuts: [{ dut: 0, goodDie: 0, totalDie: 26, yieldPct: 0 }],
    underperformingDuts: [],
  });
  assert.equal(buildUnderperformingDutScatterOptions([zero]).length, 0);
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
