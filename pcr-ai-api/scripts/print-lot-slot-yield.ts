import { readFileSync } from "node:fs";
import { enrichInfcontrolLayerBinRowV2 } from "../src/lib/passBinSemantics.js";
import {
  buildSlotYieldSummary,
  buildSlotYieldPivot,
  passIdSortLabel,
} from "../src/lib/jbYieldCalc.js";

const lot = process.argv[2] ?? "NF13137.1H";
const device = process.argv[3] ?? "WK71N94W";
const path = process.argv[4] ?? "tmp-lot.json";

const raw = JSON.parse(readFileSync(path, "utf8")) as {
  count: number;
  rows: Record<string, unknown>[];
};
const rows = raw.rows.map((r) => enrichInfcontrolLayerBinRowV2(r));
const summary = buildSlotYieldSummary(rows);
const pivot = buildSlotYieldPivot(summary);

console.log(`${lot} / ${device} — 每片良率 (pass1, 修复后本地计算, API 行数=${raw.count})`);
console.log("");
console.log("| waferId | grossDie | goodDie | badDie | yield% | 中断 | 中断次数 |");
console.log("|---:|---:|---:|---:|---:|:---:|:---:|");

for (const slot of pivot.slots) {
  const cell = pivot.cells[`${slot}:1`];
  const e = summary.find((s) => s.slot === slot && s.passId === 1);
  if (!cell || !e) continue;
  const y =
    cell.yieldPct !== null ? `${cell.yieldPct.toFixed(2)}%` : "—";
  console.log(
    `| ${slot} | ${cell.grossDie} | ${cell.goodDie} | ${cell.badDie} | ${y} | ${e.hasInterrupt ? "是" : "否"} | ${e.testInterruptCount} |`
  );
}

const interrupted = summary
  .filter((s) => s.hasInterrupt && s.passId === 1)
  .sort((a, b) => a.slot - b.slot);

if (interrupted.length) {
  console.log("");
  console.log("### 有中断片：前半 → 后半 → 整片");
  console.log("");
  console.log("| waferId | 段 | grossDie | goodDie | badDie | yield% |");
  console.log("|---:|---|---:|---:|---:|---:|");
  for (const e of interrupted) {
    const sort = passIdSortLabel(e.passId);
    if (e.interruptSegments?.length) {
      for (const seg of e.interruptSegments) {
        const m = seg.metrics;
        const y =
          m.yieldPct !== null ? `${m.yieldPct.toFixed(2)}%` : "—";
        console.log(
          `| ${e.slot} | ${seg.label} | ${m.grossDie} | ${m.goodDie} | ${m.badDie} | ${y} |`
        );
      }
    }
  }
}
