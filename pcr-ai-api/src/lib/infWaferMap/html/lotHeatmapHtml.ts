/**
 * Lot-level heatmap HTML generator — shows bad-die frequency across all wafers
 * in a lot as a color-intensity wafer map (green → yellow → red).
 */

import {
  CANVAS_SIZE,
  PADDING,
  COLOR_OUTLINE,
  COLOR_EDGE_BAND,
  HTML_CSS,
  TOOLTIP_JS,
  TAB_SWITCH_JS,
  f,
  esc,
  appendNotch,
} from "./waferMapHtmlShared.js";

export type LotHeatmapPass = {
  label: string;
  /** Die coordinate → count of wafers that had a bad die here. */
  badFreq: Map<string, number>;
  totalWafers: number;
};

type LotHeatmapLayout = {
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

function computeLotHeatmapLayout(allCoords: Set<string>, dieAspect: number): LotHeatmapLayout {
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (const key of allCoords) {
    const [xs, ys] = key.split(",");
    const x = parseInt(xs!, 10), y = parseInt(ys!, 10);
    if (x < xMin) xMin = x; if (x > xMax) xMax = x;
    if (y < yMin) yMin = y; if (y > yMax) yMax = y;
  }
  if (!isFinite(xMin)) { xMin = 0; xMax = 10; yMin = 0; yMax = 10; }

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

function heatColor(t: number): string {
  // 0 → green (#4CAF50), 0.5 → yellow (#FFC107), 1 → red (#F44336)
  t = Math.max(0, Math.min(1, t));
  if (t < 0.5) {
    const x = t * 2;
    const r = Math.round(76 + (255 - 76) * x);
    const g = Math.round(175 + (193 - 175) * x);
    const b = Math.round(80 + (7 - 80) * x);
    return `rgb(${r},${g},${b})`;
  } else {
    const x = (t - 0.5) * 2;
    const r = Math.round(255 + (244 - 255) * x);
    const g = Math.round(193 + (67 - 193) * x);
    const b = Math.round(7 + (54 - 7) * x);
    return `rgb(${r},${g},${b})`;
  }
}

function renderLotHeatmapSvg(
  badFreq: Map<string, number>,
  totalWafers: number,
  allCoords: Set<string>,
  layout: LotHeatmapLayout,
  notchAngle: number
): string[] {
  const { xMin, yMin, cellW, cellH, offX, offY, cx, cy, r, rEdge } = layout;
  const lines: string[] = [];

  lines.push(
    `    <svg width="${CANVAS_SIZE}" height="${CANVAS_SIZE}" xmlns="http://www.w3.org/2000/svg" style="display:block">`
  );
  lines.push(`      <rect width="${CANVAS_SIZE}" height="${CANVAS_SIZE}" fill="#0d0d1e"/>`);
  lines.push(
    `      <circle cx="${f(cx)}" cy="${f(cy)}" r="${f(r)}" fill="none" stroke="${COLOR_OUTLINE}" stroke-width="1.5"/>`
  );
  if (rEdge > cellH) {
    lines.push(
      `      <circle cx="${f(cx)}" cy="${f(cy)}" r="${f(rEdge)}" fill="none" stroke="${COLOR_EDGE_BAND}" stroke-width="0.8" stroke-dasharray="3 3"/>`
    );
  }

  for (const key of allCoords) {
    const [xs, ys] = key.split(",");
    const x = parseInt(xs!, 10), y = parseInt(ys!, 10);
    const sx = offX + (x - xMin) * cellW;
    const sy = offY + (y - yMin) * cellH;
    const freq = badFreq.get(key) ?? 0;
    const intensity = totalWafers > 0 ? freq / totalWafers : 0;

    // Color: green (0) → yellow (0.5) → red (1)
    const fill = heatColor(intensity);
    const tip = `X=${x} Y=${y}|不良片数=${freq}/${totalWafers} (${(intensity * 100).toFixed(1)}%)`;
    lines.push(
      `      <rect x="${f(sx + 0.4)}" y="${f(sy + 0.4)}" width="${f(cellW - 0.8)}" height="${f(cellH - 0.8)}" fill="${fill}" opacity="0.9" data-die="${esc(tip)}"/>`
    );
  }

  appendNotch(lines, cx, cy, r, notchAngle);
  lines.push("    </svg>");
  return lines;
}

function renderLotHeatmapSidebar(label: string, badFreq: Map<string, number>, totalWafers: number): string[] {
  const lines: string[] = [];
  lines.push('  <div class="sidebar">');
  lines.push('    <div class="card">');
  lines.push(`      <h2>${esc(label)}</h2>`);
  lines.push('      <div class="stat-row">');
  lines.push(`        晶圆数：<span class="stat-val">${totalWafers}</span><br/>`);
  lines.push(`        热点坐标数：<span class="stat-val">${badFreq.size}</span>`);
  lines.push("      </div>");
  lines.push("    </div>"); // card
  lines.push('    <div class="card">');
  lines.push("      <h2>颜色说明</h2>");
  lines.push(`      <div class="leg-row"><div class="leg-box" style="background:#4CAF50"></div>0 片不良</div>`);
  lines.push(`      <div class="leg-row"><div class="leg-box" style="background:#FF9800"></div>部分不良</div>`);
  lines.push(`      <div class="leg-row"><div class="leg-box" style="background:#F44336"></div>全部不良</div>`);
  lines.push("    </div>"); // card
  lines.push("  </div>"); // sidebar
  return lines;
}

/**
 * Generate a lot-level heatmap HTML showing bad die frequency across wafers.
 * Color intensity = fraction of wafers with bad die at that coordinate.
 */
export function generateLotHeatmapHtml(
  title: string,
  passes: LotHeatmapPass[],
  allCoords: Set<string>,   // "x,y" strings of all tested positions
  dieAspect: number,
  notchAngle: number,
  possibleDies: Array<{ x: number; y: number }>
): string {
  const multiPass = passes.length > 1;
  const layout = computeLotHeatmapLayout(allCoords, dieAspect);

  const lines: string[] = [];
  lines.push("<!DOCTYPE html>");
  lines.push('<html lang="zh">');
  lines.push("<head>");
  lines.push('<meta charset="utf-8"/>');
  lines.push(`<title>${esc(title)}</title>`);
  lines.push(HTML_CSS);
  lines.push("</head>");
  lines.push("<body>");
  lines.push('<div id="tooltip"></div>');
  lines.push(`<h1>${esc(title)}</h1>`);

  if (multiPass) {
    lines.push('<div class="tabs">');
    passes.forEach((p, i) => {
      const active = i === 0 ? " active" : "";
      lines.push(`  <button class="tab-btn${active}" onclick="showPass(${i})">${esc(p.label)}</button>`);
    });
    lines.push("</div>");
  }

  passes.forEach(({ label, badFreq, totalWafers }, pi) => {
    const panelActive = pi === 0 || !multiPass ? " active" : "";
    lines.push(`<div id="pass-${pi}" class="pass-panel${panelActive}">`);
    lines.push('  <div class="wafer-wrap">');
    lines.push(...renderLotHeatmapSvg(badFreq, totalWafers, allCoords, layout, notchAngle));
    lines.push("  </div>"); // wafer-wrap

    lines.push(...renderLotHeatmapSidebar(label, badFreq, totalWafers));
    lines.push("</div>"); // pass-panel
  });

  lines.push(TOOLTIP_JS);
  if (multiPass) lines.push(TAB_SWITCH_JS);
  lines.push("</body></html>");
  return lines.join("\n");
}
