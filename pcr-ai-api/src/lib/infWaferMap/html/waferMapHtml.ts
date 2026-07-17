/**
 * SVG HTML wafer map generator — TypeScript port of WaferMapGenerator.cs.
 * Generates a standalone HTML file with multi-pass tab switching,
 * hover tooltips, legend, and statistics sidebar.
 */

import type { DieEntry } from "../infWaferMapGeometry.js";
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

// ── Constants (single-generator only) ───────────────────────────────────────

const COLOR_GOOD = "#4CAF50";
const COLOR_UNTESTED = "#607D8B";
const COLORS_BAD = ["#F44336", "#E91E63", "#FF5722", "#FF9800", "#C62828"];

/** 多标签页时不再逐格绘制 tyControl 未测点（每 pass 重复一遍会极慢）。 */
const MAX_UNTESTED_RECTS_SINGLE_PASS = 12_000;

// ── Main generator ─────────────────────────────────────────────────────────

export type WaferMapPass = {
  label: string;
  dies: DieEntry[];
};

type WaferMapLayout = {
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

function computeWaferMapLayout(
  passes: WaferMapPass[],
  possibleDies: Array<{ x: number; y: number }>,
  dieAspect: number
): WaferMapLayout {
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (const { dies } of passes) {
    for (const d of dies) {
      if (d.x < xMin) xMin = d.x; if (d.x > xMax) xMax = d.x;
      if (d.y < yMin) yMin = d.y; if (d.y > yMax) yMax = d.y;
    }
  }
  for (const { x, y } of possibleDies) {
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

function renderWaferMapWaferSvg(
  dies: DieEntry[],
  possibleDies: Array<{ x: number; y: number }>,
  layout: WaferMapLayout,
  notchAngle: number,
  highlight: string,
  drawUntestedGrid: boolean
): string[] {
  const { xMin, yMin, cellW, cellH, offX, offY, cx, cy, r, rEdge } = layout;
  const testedSet = new Set(dies.map((d) => `${d.x},${d.y}`));
  const lines: string[] = [];

  lines.push(
    `    <svg width="${CANVAS_SIZE}" height="${CANVAS_SIZE}" xmlns="http://www.w3.org/2000/svg" style="display:block">`
  );
  lines.push(`      <rect width="${CANVAS_SIZE}" height="${CANVAS_SIZE}" fill="#0d0d1e"/>`);

  // Wafer outline
  lines.push(
    `      <circle cx="${f(cx)}" cy="${f(cy)}" r="${f(r)}" fill="none" stroke="${COLOR_OUTLINE}" stroke-width="1.5"/>`
  );
  // Edge exclusion band
  if (rEdge > cellH) {
    lines.push(
      `      <circle cx="${f(cx)}" cy="${f(cy)}" r="${f(rEdge)}" fill="none" stroke="${COLOR_EDGE_BAND}" stroke-width="0.8" stroke-dasharray="3 3"/>`
    );
  }

  // Untested die (skipped on multi-pass tabs — each pass duplicated the full tyControl grid)
  if (drawUntestedGrid) {
    let untestedDrawn = 0;
    let untestedTotal = 0;
    for (const { x, y } of possibleDies) {
      if (testedSet.has(`${x},${y}`)) continue;
      untestedTotal++;
      if (untestedDrawn >= MAX_UNTESTED_RECTS_SINGLE_PASS) continue;
      untestedDrawn++;
      const sx = offX + (x - xMin) * cellW;
      const sy = offY + (y - yMin) * cellH;
      const tip = `X=${x} Y=${y}|状态=未测`;
      lines.push(
        `      <rect x="${f(sx + 0.5)}" y="${f(sy + 0.5)}" width="${f(cellW - 1)}" height="${f(cellH - 1)}" fill="${COLOR_UNTESTED}" opacity="0.5" data-die="${esc(tip)}"/>`
      );
    }
    if (untestedTotal > untestedDrawn) {
      lines.push(
        `      <!-- untested grid capped: ${untestedDrawn}/${untestedTotal} -->`
      );
    }
  }

  // Tested die
  for (const d of dies) {
    const sx = offX + (d.x - xMin) * cellW;
    const sy = offY + (d.y - yMin) * cellH;
    const fill = d.isGood ? COLOR_GOOD : COLORS_BAD[d.bin % COLORS_BAD.length]!;
    const status = d.isGood ? "良品" : "不良";

    const tipParts = [`X=${d.x} Y=${d.y}`, `Bin=${d.bin}  ${status}`];
    if (d.site != null) tipParts.push(`DUT=${d.site}`);
    if (d.touchCount != null) tipParts.push(`接触=${d.touchCount}次`);
    const tip = tipParts.join("|");

    // Highlight stroke
    let extraStroke = "";
    if (highlight === "edge") {
      const dx = sx + cellW / 2 - cx;
      const dy = sy + cellH / 2 - cy;
      if (Math.sqrt(dx * dx + dy * dy) > r * 0.85)
        extraStroke = ` stroke="#FFD700" stroke-width="1.5"`;
    } else if (highlight.startsWith("bin:")) {
      const hBins = new Set(
        highlight.slice(4).split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n))
      );
      if (hBins.has(d.bin))
        extraStroke = ` stroke="#FFEB3B" stroke-width="1.5"`;
    }

    lines.push(
      `      <rect x="${f(sx + 0.4)}" y="${f(sy + 0.4)}" width="${f(cellW - 0.8)}" height="${f(cellH - 0.8)}" fill="${fill}" opacity="0.9"${extraStroke} data-die="${esc(tip)}"/>`
    );
  }

  // Notch
  appendNotch(lines, cx, cy, r, notchAngle);

  lines.push("    </svg>");
  return lines;
}

function renderWaferMapSidebar(
  label: string,
  dies: DieEntry[],
  possibleDies: Array<{ x: number; y: number }>,
  drawUntestedGrid: boolean,
  multiPass: boolean
): string[] {
  const lines: string[] = [];
  lines.push('  <div class="sidebar">');

  // Legend
  lines.push('    <div class="card">');
  lines.push("      <h2>图例</h2>");
  lines.push(`      <div class="leg-row"><div class="leg-box" style="background:${COLOR_GOOD}"></div>良品</div>`);
  lines.push(`      <div class="leg-row"><div class="leg-box" style="background:${COLORS_BAD[0]}"></div>不良</div>`);

  const distinctBadBins = [...new Set(dies.filter((d) => !d.isGood).map((d) => d.bin))].sort((a, b) => a - b);
  for (const bin of distinctBadBins) {
    const bc = COLORS_BAD[bin % COLORS_BAD.length]!;
    lines.push(`      <div class="leg-row"><div class="leg-box" style="background:${bc}"></div>不良 Bin ${bin}</div>`);
  }
  if (possibleDies.length > 0 && drawUntestedGrid) {
    lines.push(`      <div class="leg-row"><div class="leg-box" style="background:${COLOR_UNTESTED}"></div>未测</div>`);
  } else if (possibleDies.length > 0 && multiPass) {
    lines.push(`      <div class="leg-row"><div class="leg-box" style="background:${COLOR_UNTESTED}"></div>未测（多标签页不逐格绘制）</div>`);
  }
  lines.push("    </div>"); // card

  // Stats
  const goodCount = dies.filter((d) => d.isGood).length;
  const yieldPct = dies.length > 0 ? (goodCount / dies.length) * 100 : 0;
  lines.push('    <div class="card">');
  lines.push(`      <h2>${esc(label)}</h2>`);
  lines.push('      <div class="stat-row">');
  lines.push(`        总 die：<span class="stat-val">${dies.length}</span><br/>`);
  lines.push(`        良品：<span class="stat-val">${goodCount}</span><br/>`);
  lines.push(`        良率：<span class="stat-val">${yieldPct.toFixed(2)}%</span>`);
  lines.push("      </div>");
  lines.push("    </div>"); // card

  lines.push("  </div>"); // sidebar
  return lines;
}

/**
 * Generate a standalone HTML wafer map.
 *
 * @param title        Page title (e.g. "NF12551.1N / Slot 3")
 * @param passes       One entry per pass tab
 * @param possibleDies Testable positions from tyControl (rendered as grey if untested)
 * @param dieAspect    dieWidth / dieHeight (controls rectangle shape)
 * @param notchAngle   Degrees (0=right, 90=bottom, 180=left, 270=top); INF default 270
 * @param goodBins     Set of good bin numbers (for legend / summary)
 * @param highlight    "" | "edge" | "bin:N" | "bin:N,M,..."
 */
export function generateWaferMapHtml(
  title: string,
  passes: WaferMapPass[],
  possibleDies: Array<{ x: number; y: number }>,
  dieAspect: number,
  notchAngle: number,
  goodBins: Set<number>,
  highlight = ""
): string {
  const multiPass = passes.length > 1;
  /** 多 pass 只画已测 die；单 pass 可画未测灰格（带上限）。 */
  const drawUntestedGrid = !multiPass;

  const layout = computeWaferMapLayout(passes, possibleDies, dieAspect);

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

  // ── Tabs ────────────────────────────────────────────────────────────────
  if (multiPass) {
    lines.push('<div class="tabs">');
    passes.forEach((p, i) => {
      const active = i === 0 ? " active" : "";
      lines.push(`  <button class="tab-btn${active}" onclick="showPass(${i})">${esc(p.label)}</button>`);
    });
    lines.push("</div>");
  }

  // ── Per-pass panels ─────────────────────────────────────────────────────
  passes.forEach(({ label, dies }, pi) => {
    const panelActive = pi === 0 || !multiPass ? " active" : "";

    lines.push(`<div id="pass-${pi}" class="pass-panel${panelActive}">`);
    lines.push('  <div class="wafer-wrap">');
    lines.push(...renderWaferMapWaferSvg(dies, possibleDies, layout, notchAngle, highlight, drawUntestedGrid));
    lines.push("  </div>"); // wafer-wrap

    lines.push(...renderWaferMapSidebar(label, dies, possibleDies, drawUntestedGrid, multiPass));
    lines.push("</div>"); // pass-panel
  });

  lines.push(TOOLTIP_JS);
  if (multiPass) lines.push(TAB_SWITCH_JS);
  lines.push("</body></html>");

  return lines.join("\n");
}
