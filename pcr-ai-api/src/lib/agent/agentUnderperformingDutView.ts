/**
 * 低良率 DUT 展示层（纯函数，无副作用）：给 Agent 回复生成
 * ① 全 DUT 良率高亮表（低于 lot平均×阈值比 的 DUT 用 🔴+加粗标注）
 * ② 每 pass 一张散点 option（见同文件 buildUnderperformingDutScatterOptions，Task 2）。
 * 数据来自昨天的 computeUnderperformingDutsForPass；本模块不取数、不碰 SQL/Dummy/REST。
 */

import type { PassUnderperformingDutsResult } from "../lotUnderperformingDuts.js";

const RED_DOT = "🔴";

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
    const rows = [...pass.allDuts].sort(
      (a, b) => a.yieldPct - b.yieldPct || a.dut - b.dut
    );

    // Check if there are any underperforming DUTs
    const hasUnderperforming = rows.some(d => d.yieldPct < threshold);

    const lines = [
      `### ${pass.sortLabel} — lot 整体 ${avg}% · 阈值 ${threshold}%（${hasUnderperforming ? `低于阈值 ${RED_DOT} 标注` : "全部达标"})`,
      "",
      "| DUT | 良率% | good/total | 状态 |",
      "|:--|---:|---:|:--|",
    ];
    for (const d of rows) {
      if (d.yieldPct < threshold) {
        lines.push(
          `| ${RED_DOT} **DUT${d.dut}** | **${d.yieldPct}** | **${d.goodDie}/${d.totalDie}** | **低于阈值** |`
        );
      } else {
        lines.push(`| DUT${d.dut} | ${d.yieldPct} | ${d.goodDie}/${d.totalDie} |  |`);
      }
    }
    blocks.push(lines.join("\n"));
  }
  if (blocks.length === 0) return "";
  return `**Lot ${lot}（${device}）各 DUT 良率**\n\n${blocks.join("\n\n")}`;
}

/** 良率相对 lot 平均 / 阈值 的色带：绿≥平均、黄平均~阈值、红<阈值。 */
function dutBandColor(yieldPct: number, avg: number, threshold: number): string {
  if (yieldPct < threshold) return "#e15b64"; // 红：低于阈值
  if (yieldPct < avg) return "#f0a020"; // 黄：低于平均但达标
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
      title: { text: `${pass.sortLabel} 各 DUT 良率分布` },
      tooltip: { trigger: "item" },
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
