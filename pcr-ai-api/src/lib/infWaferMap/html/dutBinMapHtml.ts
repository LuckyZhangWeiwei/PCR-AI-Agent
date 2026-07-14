/**
 * DUT × BIN relationship map generator (no-color, pattern-based SVG).
 */

import {
  CANVAS_SIZE,
  PADDING,
  COLOR_OUTLINE,
  COLOR_EDGE_BAND,
  HTML_CSS,
  TOOLTIP_JS,
  f,
  esc,
  appendNotch,
} from "./waferMapHtmlShared.js";

export type DutBinDieEntry = {
  x: number;
  y: number;
  bin: number;
  site: number | null;
  isGood: boolean;
};

type DutBinMapLayout = {
  xMin: number;
  yMin: number;
  cellW: number;
  cellH: number;
  offX: number;
  offY: number;
  cx: number;
  cy: number;
  r: number;
  rEdge: number;
};

function computeDutBinMapLayout(dies: DutBinDieEntry[], dieAspect: number): DutBinMapLayout {
  const xs = dies.map((d) => d.x);
  const ys = dies.map((d) => d.y);

  // Avoid spread-into-varargs: crashes with RangeError for >65k dies
  const xMin = xs.reduce((a, b) => (b < a ? b : a), Infinity);
  const xMax = xs.reduce((a, b) => (b > a ? b : a), -Infinity);
  const yMin = ys.reduce((a, b) => (b < a ? b : a), Infinity);
  const yMax = ys.reduce((a, b) => (b > a ? b : a), -Infinity);
  const gridW = xMax - xMin + 1;
  const gridH = yMax - yMin + 1;

  const drawArea = CANVAS_SIZE - 2 * PADDING;
  const cellH = Math.min(drawArea / (gridW * dieAspect), drawArea / gridH);
  const cellW = cellH * dieAspect;
  const actualW = cellW * gridW;
  const actualH = cellH * gridH;
  const offX = PADDING + (drawArea - actualW) / 2;
  const offY = PADDING + (drawArea - actualH) / 2;
  const cx = offX + actualW / 2;
  const cy = offY + actualH / 2;
  const r = Math.max(actualW, actualH) / 2 + Math.max(cellW, cellH) * 0.6;
  const rEdge = r - Math.max(cellW, cellH) * 2.5;

  return { xMin, yMin, cellW, cellH, offX, offY, cx, cy, r, rEdge };
}

function countDutBinCategories(
  dies: DutBinDieEntry[],
  targetDut: number,
  targetBin: number
): { matchCount: number; dutOnlyCount: number; binOnlyCount: number } {
  let matchCount = 0, dutOnlyCount = 0, binOnlyCount = 0;
  for (const d of dies) {
    const isDut = d.site === targetDut;
    const isBin = d.bin === targetBin;
    if (isDut && isBin) matchCount++;
    else if (isDut) dutOnlyCount++;
    else if (isBin) binOnlyCount++;
  }
  return { matchCount, dutOnlyCount, binOnlyCount };
}

function renderDutBinMapSvg(
  dies: DutBinDieEntry[],
  targetDut: number,
  targetBin: number,
  layout: DutBinMapLayout,
  notchAngle: number
): string[] {
  const { xMin, yMin, cellW, cellH, offX, offY, cx, cy, r, rEdge } = layout;
  const lines: string[] = [];
  lines.push(`    <svg width="${CANVAS_SIZE}" height="${CANVAS_SIZE}" xmlns="http://www.w3.org/2000/svg" style="display:block">`);
  lines.push(`      <rect width="${CANVAS_SIZE}" height="${CANVAS_SIZE}" fill="#0d0d1e"/>`);

  // Patterns — stripe pitch adapts to die size; 竖线（其他 DUT×目标 BIN）用高对比青色系
  const pw = Math.max(3, Math.min(8, Math.round(cellW * 0.45)));
  const binStripeW = Math.max(1.1, Math.min(2.2, pw * 0.42));
  lines.push("      <defs>");
  lines.push(`        <pattern id="p-dut" width="${pw}" height="${pw}" patternUnits="userSpaceOnUse">`);
  lines.push(`          <rect width="${pw}" height="${pw}" fill="#0d1830"/>`);
  lines.push(`          <line x1="0" y1="${f(pw / 2)}" x2="${pw}" y2="${f(pw / 2)}" stroke="#8888bb" stroke-width="0.9"/>`);
  lines.push("        </pattern>");
  lines.push(`        <pattern id="p-bin" width="${pw}" height="${pw}" patternUnits="userSpaceOnUse">`);
  lines.push(`          <rect width="${pw}" height="${pw}" fill="#1a3358"/>`);
  lines.push(
    `          <line x1="${f(pw / 2)}" y1="0" x2="${f(pw / 2)}" y2="${pw}" stroke="#4fc3f7" stroke-width="${f(binStripeW)}"/>`
  );
  lines.push(
    `          <line x1="${f(pw * 0.28)}" y1="0" x2="${f(pw * 0.28)}" y2="${pw}" stroke="#b3e5fc" stroke-width="${f(binStripeW * 0.55)}" opacity="0.85"/>`
  );
  lines.push("        </pattern>");
  lines.push("      </defs>");

  // Wafer outline + edge band
  lines.push(`      <circle cx="${f(cx)}" cy="${f(cy)}" r="${f(r)}" fill="none" stroke="${COLOR_OUTLINE}" stroke-width="1.5"/>`);
  if (rEdge > cellH) {
    lines.push(`      <circle cx="${f(cx)}" cy="${f(cy)}" r="${f(rEdge)}" fill="none" stroke="${COLOR_EDGE_BAND}" stroke-width="0.8" stroke-dasharray="3 3"/>`);
  }

  // Draw in z-order: other → dutOnly → binOnly → match (match on top)
  type DrawRule = { pred: (d: DutBinDieEntry) => boolean; fill: string; stroke: string; sw: string; opacity: string };
  const rules: DrawRule[] = [
    { pred: (d) => d.site !== targetDut && d.bin !== targetBin, fill: "#1a1a30", stroke: "none",    sw: "0",   opacity: "0.35" },
    { pred: (d) => d.site === targetDut && d.bin !== targetBin, fill: "url(#p-dut)", stroke: "#6060a0", sw: "0.6", opacity: "0.95" },
    {
      pred: (d) => d.site !== targetDut && d.bin === targetBin,
      fill: "url(#p-bin)",
      stroke: "#29b6f6",
      sw: "1.5",
      opacity: "1",
    },
    { pred: (d) => d.site === targetDut && d.bin === targetBin, fill: "#dcdcff",     stroke: "#a0a0e0", sw: "1.2", opacity: "1.0"  },
  ];

  for (const { pred, fill, stroke, sw, opacity } of rules) {
    for (const d of dies) {
      if (!pred(d)) continue;
      const sx = offX + (d.x - xMin) * cellW;
      const sy = offY + (d.y - yMin) * cellH;
      const isDut = d.site === targetDut;
      const isBin = d.bin === targetBin;
      const cat = isDut && isBin
        ? `DUT${targetDut} ✓  BIN${targetBin} ✓`
        : isDut ? `DUT${targetDut} ✓  bin=${d.bin}`
        : isBin ? `BIN${targetBin} ✓  DUT=${d.site ?? "?"}`
        : `DUT=${d.site ?? "?"}  bin=${d.bin}`;
      const tip = `X=${d.x} Y=${d.y}|${cat}`;
      const stk = stroke !== "none" ? ` stroke="${stroke}" stroke-width="${sw}"` : "";
      lines.push(
        `      <rect x="${f(sx + 0.4)}" y="${f(sy + 0.4)}" width="${f(cellW - 0.8)}" height="${f(cellH - 0.8)}"` +
        ` fill="${fill}" opacity="${opacity}"${stk} data-die="${esc(tip)}"/>`
      );
    }
  }

  appendNotch(lines, cx, cy, r, notchAngle);
  lines.push("    </svg>");
  return lines;
}

function renderDutBinMapSidebar(
  passLabel: string,
  targetDut: number,
  targetBin: number,
  matchCount: number,
  dutOnlyCount: number,
  binOnlyCount: number,
  dutBinRate: string
): string[] {
  const lines: string[] = [];
  lines.push('  <div class="sidebar">');
  lines.push('    <div class="card"><h2>图例（无颜色）</h2>');
  const legItems = [
    { label: `DUT${targetDut} ＆ BIN${targetBin}（双匹配）`, svgFill: "#dcdcff", svgStroke: "#a0a0e0" },
    { label: `DUT${targetDut}（其他 bin）横线`, patternId: "p-dut" },
    { label: `BIN${targetBin}（其他 DUT）青色竖线`, patternId: "p-bin" },
    { label: "其他 die（极暗）", svgFill: "#1a1a30" },
  ];
  for (const item of legItems) {
    const inner = "patternId" in item
      ? `<svg width="13" height="13" xmlns="http://www.w3.org/2000/svg" style="display:inline-block;margin-right:6px"><defs><pattern id="l-${item.patternId}" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="4" fill="${item.patternId === "p-bin" ? "#1a3358" : "#0d1830"}"/>${item.patternId === "p-dut" ? '<line x1="0" y1="2" x2="4" y2="2" stroke="#8888bb" stroke-width="0.9"/>' : '<line x1="2" y1="0" x2="2" y2="4" stroke="#4fc3f7" stroke-width="1.3"/><line x1="1.1" y1="0" x2="1.1" y2="4" stroke="#b3e5fc" stroke-width="0.7"/>'}</pattern></defs><rect width="13" height="13" fill="url(#l-${item.patternId})" stroke="${item.patternId === "p-bin" ? "#29b6f6" : "#6060a0"}" stroke-width="${item.patternId === "p-bin" ? "1" : "0.6"}"/></svg>${esc(item.label)}`
      : `<div class="leg-box" style="background:${"svgFill" in item ? item.svgFill : "#888"};border:1px solid ${"svgStroke" in item ? item.svgStroke : "transparent"}"></div>${esc(item.label)}`;
    const wrapStyle = "patternId" in item ? 'style="display:flex;align-items:center;margin:4px 0;font-size:11px;color:#b0bec5"' : 'class="leg-row"';
    lines.push(`      <div ${wrapStyle}>${inner}</div>`);
  }
  lines.push("    </div>");

  lines.push('    <div class="card">');
  lines.push(`      <h2>${esc(passLabel)}</h2>`);
  lines.push(`      <div class="stat-row">`);
  lines.push(`        双匹配 die：<span class="stat-val">${matchCount}</span><br/>`);
  lines.push(`        DUT${targetDut} 其他 bin：<span class="stat-val">${dutOnlyCount}</span><br/>`);
  lines.push(`        BIN${targetBin} 其他 DUT：<span class="stat-val">${binOnlyCount}</span><br/>`);
  lines.push(`        DUT${targetDut} 中 BIN${targetBin} 占比：<span class="stat-val">${dutBinRate}%</span>`);
  lines.push("      </div>");
  lines.push("    </div>");
  lines.push("  </div>"); // sidebar
  return lines;
}

/**
 * Generate a wafer map showing the relationship between a specific DUT and a
 * specific BIN using SVG patterns instead of colors (no-color design).
 *
 * Four categories rendered with patterns/shapes only:
 *   match   = target DUT AND target BIN → bright white fill (most important)
 *   dutOnly = target DUT, different BIN → horizontal stripes
 *   binOnly = target BIN, different DUT → vertical stripes
 *   other   = neither                  → very dim background
 */
export function generateDutBinMapHtml(
  title: string,
  dies: DutBinDieEntry[],
  targetDut: number,
  targetBin: number,
  dieAspect: number,
  notchAngle: number,
  passLabel: string
): string {
  const xs = dies.map((d) => d.x);
  if (xs.length === 0) return `<html><body><p>无 die 数据</p></body></html>`;

  const layout = computeDutBinMapLayout(dies, dieAspect);
  const { matchCount, dutOnlyCount, binOnlyCount } = countDutBinCategories(dies, targetDut, targetBin);
  const dutTotal = matchCount + dutOnlyCount;
  const dutBinRate = dutTotal > 0 ? ((matchCount / dutTotal) * 100).toFixed(1) : "0.0";

  const lines: string[] = [];
  lines.push("<!DOCTYPE html><html lang=\"zh\">");
  lines.push("<head><meta charset=\"utf-8\"/>");
  lines.push(`<title>${esc(title)}</title>`);
  lines.push(HTML_CSS);
  lines.push("</head><body>");
  lines.push('<div id="tooltip"></div>');
  lines.push(`<h1>${esc(title)}</h1>`);

  lines.push('<div class="pass-panel active">');
  lines.push('  <div class="wafer-wrap">');
  lines.push(...renderDutBinMapSvg(dies, targetDut, targetBin, layout, notchAngle));
  lines.push("  </div>"); // wafer-wrap

  lines.push(...renderDutBinMapSidebar(passLabel, targetDut, targetBin, matchCount, dutOnlyCount, binOnlyCount, dutBinRate));
  lines.push("</div>"); // pass-panel

  lines.push(TOOLTIP_JS);
  lines.push("</body></html>");
  return lines.join("\n");
}
