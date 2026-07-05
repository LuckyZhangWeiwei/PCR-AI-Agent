/**
 * 低良率 DUT 展示层（纯函数，无副作用）：给 Agent 回复生成
 * ① 全 DUT 良率高亮表（低于阈值 🔴+加粗，低于平均（但达标）🟡 标注，与散点图三色带一致）
 * ② 每 pass 一张散点 option（见同文件 buildUnderperformingDutScatterOptions）。
 * 数据来自昨天的 computeUnderperformingDutsForPass；本模块不取数、不碰 SQL/Dummy/REST。
 */

import type {
  DutYieldEntry,
  PassUnderperformingDutsResult,
} from "../lotUnderperformingDuts.js";

const RED_DOT = "🔴";
const YELLOW_DOT = "🟡";

/** DUT 数超过此值时，一行并排显示多个 DUT（缩短长列表行数）；否则每行一个 DUT。 */
const DUTS_PER_ROW_THRESHOLD = 30;
const DUTS_PER_ROW_WIDE = 3;

type DutBand = "red" | "yellow" | "none";

/** 与散点图 `dutBandColor` 同一套三色带判定：红<阈值、黄<平均（但达标）、绿其余。 */
function dutBand(yieldPct: number, avg: number, threshold: number, degenerate: boolean): DutBand {
  if (degenerate) return "none";
  if (yieldPct < threshold) return "red";
  if (yieldPct < avg) return "yellow";
  return "none";
}

/** 一个 DUT 的三列单元（DUT | 良率% | good/total）；红=🔴+加粗，黄=🟡 前缀。 */
function dutCellTriple(d: DutYieldEntry, band: DutBand): string {
  if (band === "red") {
    return `${RED_DOT} **DUT${d.dut}** | **${d.yieldPct}** | **${d.goodDie}/${d.totalDie}**`;
  }
  if (band === "yellow") {
    return `${YELLOW_DOT} DUT${d.dut} | ${d.yieldPct} | ${d.goodDie}/${d.totalDie}`;
  }
  return `DUT${d.dut} | ${d.yieldPct} | ${d.goodDie}/${d.totalDie}`;
}

export function formatAllDutsHighlightMarkdown(
  passResults: PassUnderperformingDutsResult[],
  lot: string,
  device: string
): string {
  const blocks: string[] = [];
  for (const pass of passResults) {
    if (!pass.baseline || pass.allDuts.length === 0) continue;
    const avg = pass.baseline.yieldPct;
    const threshold = pass.baseline.thresholdPct;
    // 按 DUT 编号排列，方便对照物理位置；低良率标注仍按阈值判定，与排序无关。
    const rows = [...pass.allDuts].sort((a, b) => a.dut - b.dut);

    // 退化情形：整体良率 0%（无良品 die 落入良品 bin）→ 相对阈值恒为 0，
    // 严格小于永不成立，勿显示误导性的「全部达标」，改为异常提示。
    const degenerate = avg <= 0;
    const bands = rows.map((d) => dutBand(d.yieldPct, avg, threshold, degenerate));
    const hasRed = bands.includes("red");
    const hasYellow = bands.includes("yellow");

    const legendParts: string[] = [];
    if (hasRed) legendParts.push(`低于阈值 ${RED_DOT} 标注`);
    if (hasYellow) legendParts.push(`低于平均 ${YELLOW_DOT} 标注`);
    const header = degenerate
      ? `### ${pass.sortLabel} — ⚠️ 整体良率 0%（无良品 die 落入良品 bin），无法按相对阈值判别；疑该测试层非完整 TEST 层或良品 bin 非 BIN1，请核对 pass/bin 口径`
      : `### ${pass.sortLabel} — lot 整体 ${avg}% · 阈值 ${threshold}%（${
          legendParts.length > 0 ? legendParts.join(" · ") : "全部达标"
        }）`;

    // 多列表格：DUT 数超过阈值时每行并排多个 DUT（缩短长列表行数），否则每行一个。
    const dutsPerRow = rows.length > DUTS_PER_ROW_THRESHOLD ? DUTS_PER_ROW_WIDE : 1;
    const headerCells = Array.from({ length: dutsPerRow }, () => "DUT | 良率% | good/total").join(" | ");
    const sepCells = Array.from({ length: dutsPerRow }, () => ":--|---:|---:").join("|");
    const lines = [header, "", `| ${headerCells} |`, `|${sepCells}|`];

    for (let i = 0; i < rows.length; i += dutsPerRow) {
      const group = rows.slice(i, i + dutsPerRow);
      const cells = group.map((d, j) => dutCellTriple(d, bands[i + j]));
      while (cells.length < dutsPerRow) cells.push("  |  |  "); // 末行补空列
      lines.push(`| ${cells.join(" | ")} |`);
    }
    blocks.push(lines.join("\n"));
  }
  if (blocks.length === 0) return "";
  return `**Lot ${lot}（${device}）各 DUT 良率**\n\n${blocks.join("\n\n")}`;
}

/** 良率相对 lot 平均 / 阈值 的色带：绿≥平均、黄平均~阈值、红<阈值（与表格 `dutBand` 同一套判定）。 */
function dutBandColor(yieldPct: number, avg: number, threshold: number): string {
  const band = dutBand(yieldPct, avg, threshold, false);
  if (band === "red") return "#e15b64";
  if (band === "yellow") return "#f0a020";
  return "#4caf50"; // 绿：高于/等于平均
}

export type PassScatterOption = { passId: number; sortLabel: string; option: object };

export function buildUnderperformingDutScatterOptions(
  passResults: PassUnderperformingDutsResult[]
): PassScatterOption[] {
  const out: PassScatterOption[] = [];
  for (const pass of passResults) {
    if (!pass.baseline || pass.allDuts.length === 0) continue;
    const avg = pass.baseline.yieldPct;
    const threshold = pass.baseline.thresholdPct;
    const duts = [...pass.allDuts].sort((a, b) => a.dut - b.dut);
    const option = {
      title: { text: `${pass.sortLabel} 各 DUT 良率分布`, left: 24, top: 6 },
      tooltip: { trigger: "item" },
      // 右侧留白给 markLine 的「lot平均/阈值」标签；顶部留白避免与左对齐后的标题重叠；
      // left 与 title.left 对齐（containLabel 会在此基础上自动为 y 轴刻度让出空间）。
      grid: { top: 70, left: 24, right: 120, bottom: 60, containLabel: true },
      xAxis: { type: "category", data: duts.map((d) => `DUT${d.dut}`), name: "DUT" },
      yAxis: { type: "value", name: "良率%", min: 0, max: 100 },
      series: [
        {
          type: "scatter",
          symbolSize: 12,
          data: duts.map((d) => ({
            value: [`DUT${d.dut}`, d.yieldPct],
            itemStyle: { color: dutBandColor(d.yieldPct, avg, threshold) },
          })),
          markLine: {
            silent: true,
            symbol: "none",
            data: [
              {
                yAxis: avg,
                label: { formatter: `lot平均 ${avg}%` },
                lineStyle: { color: "#4a90d9", type: "dashed" },
              },
              {
                yAxis: threshold,
                label: { formatter: `阈值 ${threshold}%` },
                lineStyle: { color: "#e15b64", type: "dashed" },
              },
            ],
          },
        },
      ],
    };
    out.push({ passId: pass.passId, sortLabel: pass.sortLabel, option });
  }
  return out;
}
