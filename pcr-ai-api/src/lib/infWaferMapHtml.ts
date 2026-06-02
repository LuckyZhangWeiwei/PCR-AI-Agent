/**
 * SVG HTML wafer map generator — TypeScript port of WaferMapGenerator.cs.
 * Generates a standalone HTML file with multi-pass tab switching,
 * hover tooltips, legend, and statistics sidebar.
 */

import type { DieEntry } from "./infWaferMap.js";

// ── Constants ──────────────────────────────────────────────────────────────

const CANVAS_SIZE = 780;
const PADDING = 52;
const COLOR_GOOD = "#4CAF50";
const COLOR_UNTESTED = "#607D8B";
const COLOR_OUTLINE = "#78909C";
const COLOR_EDGE_BAND = "#37474f";
const COLORS_BAD = ["#F44336", "#E91E63", "#FF5722", "#FF9800", "#C62828"];

const HTML_CSS = `<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#1a1a2e;color:#cfd8dc;font-family:'Segoe UI',Consolas,sans-serif;padding:16px}
h1{font-size:15px;color:#64b5f6;margin-bottom:14px;letter-spacing:.4px}
.tabs{display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap}
.tab-btn{background:#263238;color:#90a4ae;border:1px solid #37474f;
          padding:5px 16px;border-radius:4px;cursor:pointer;font-size:12px;transition:.15s all}
.tab-btn:hover{background:#37474f;color:#eceff1}
.tab-btn.active{background:#1565c0;color:#fff;border-color:#1976d2}
.pass-panel{display:none}
.pass-panel.active{display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap}
.wafer-wrap{background:#0d0d1e;border-radius:10px;padding:8px;
            box-shadow:0 4px 20px rgba(0,0,0,.6)}
.sidebar{min-width:160px;max-width:200px}
.card{background:#16213e;border-radius:7px;padding:12px;margin-bottom:12px}
.card h2{font-size:12px;color:#90caf9;margin-bottom:8px;font-weight:600}
.leg-row{display:flex;align-items:center;gap:8px;margin:4px 0;font-size:11px;color:#b0bec5}
.leg-box{width:13px;height:13px;border-radius:2px;flex-shrink:0}
.stat-row{font-size:11px;color:#b0bec5;line-height:1.8}
.stat-val{color:#eceff1;font-weight:600}
#tooltip{position:fixed;background:rgba(10,10,30,.92);color:#e0f7fa;
          padding:8px 12px;border-radius:5px;font-size:11px;pointer-events:none;
          display:none;border:1px solid #455a64;white-space:pre;line-height:1.65;
          z-index:999;box-shadow:0 2px 8px #000a}
</style>`;

const TOOLTIP_JS = `<script>
(function(){
  var tip=document.getElementById('tooltip');
  document.querySelectorAll('[data-die]').forEach(function(el){
    el.addEventListener('mouseover',function(e){
      tip.textContent=e.target.getAttribute('data-die').replace(/\\|/g,'\\n');
      tip.style.display='block';
    });
    el.addEventListener('mousemove',function(e){
      tip.style.left=(e.clientX+14)+'px';
      tip.style.top=(e.clientY-10)+'px';
    });
    el.addEventListener('mouseout',function(){tip.style.display='none';});
  });
})();
</script>`;

const TAB_SWITCH_JS = `<script>
function showPass(idx){
  document.querySelectorAll('.pass-panel').forEach(function(p,i){
    p.classList.toggle('active',i===idx);
  });
  document.querySelectorAll('.tab-btn').forEach(function(b,i){
    b.classList.toggle('active',i===idx);
  });
}
</script>`;

// ── Helpers ────────────────────────────────────────────────────────────────

function f(v: number): string { return v.toFixed(1); }
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function pct(v: number): string { return (v * 100).toFixed(2) + "%"; }

// ── Main generator ─────────────────────────────────────────────────────────

export type WaferMapPass = {
  label: string;
  dies: DieEntry[];
};

/**
 * Generate a standalone HTML wafer map.
 *
 * @param title        Page title (e.g. "NF12551.1N / Slot 3")
 * @param passes       One entry per pass tab
 * @param possibleDies Testable positions from tyControl (rendered as grey if untested)
 * @param dieAspect    dieWidth / dieHeight (controls rectangle shape)
 * @param notchAngle   Degrees (0=right, 90=bottom, 180=left, 270=top); INF default 270
 * @param goodBins     Set of good bin numbers (for legend / summary)
 * @param highlight    "" | "edge" | "bin:N"
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

  // ── Coordinate bounds (union of all passes + possible) ─────────────────
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
    const testedSet = new Set(dies.map((d) => `${d.x},${d.y}`));
    const goodCount = dies.filter((d) => d.isGood).length;
    const yieldPct = dies.length > 0 ? (goodCount / dies.length) * 100 : 0;

    lines.push(`<div id="pass-${pi}" class="pass-panel${panelActive}">`);
    lines.push('  <div class="wafer-wrap">');
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

    // Untested die
    for (const { x, y } of possibleDies) {
      if (testedSet.has(`${x},${y}`)) continue;
      const sx = offX + (x - xMin) * cellW;
      const sy = offY + (y - yMin) * cellH;
      const tip = `X=${x} Y=${y}|状态=未测`;
      lines.push(
        `      <rect x="${f(sx + 0.5)}" y="${f(sy + 0.5)}" width="${f(cellW - 1)}" height="${f(cellH - 1)}" fill="${COLOR_UNTESTED}" opacity="0.5" data-die="${esc(tip)}"/>`
      );
    }

    // Tested die
    for (const d of dies) {
      const sx = offX + (d.x - xMin) * cellW;
      const sy = offY + (d.y - yMin) * cellH;
      const fill = d.isGood ? COLOR_GOOD : COLORS_BAD[d.bin % COLORS_BAD.length]!;
      const status = d.isGood ? "良品" : "不良";

      const tipParts = [`X=${d.x} Y=${d.y}`, `Bin=${d.bin}  ${status}`];
      if (d.site != null) tipParts.push(`站点=${d.site}`);
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
        const hBin = parseInt(highlight.slice(4), 10);
        if (!isNaN(hBin) && d.bin === hBin)
          extraStroke = ` stroke="#FFEB3B" stroke-width="1.5"`;
      }

      lines.push(
        `      <rect x="${f(sx + 0.4)}" y="${f(sy + 0.4)}" width="${f(cellW - 0.8)}" height="${f(cellH - 0.8)}" fill="${fill}" opacity="0.9"${extraStroke} data-die="${esc(tip)}"/>`
      );
    }

    // Notch
    appendNotch(lines, cx, cy, r, notchAngle);

    lines.push("    </svg>");
    lines.push("  </div>"); // wafer-wrap

    // ── Sidebar ────────────────────────────────────────────────────────
    lines.push('  <div class="sidebar">');

    // Legend
    lines.push('    <div class="card">');
    lines.push("      <h2>图例</h2>");
    lines.push(`      <div class="leg-row"><div class="leg-box" style="background:${COLOR_GOOD}"></div>良品</div>`);
    lines.push(`      <div class="leg-row"><div class="leg-box" style="background:${COLORS_BAD[0]}"></div>不良</div>`);

    const distinctBadBins = [...new Set(dies.filter((d) => !d.isGood).map((d) => d.bin))].sort((a, b) => a - b);
    for (const bin of distinctBadBins) {
      const bc = COLORS_BAD[bin % COLORS_BAD.length]!;
      if (bc !== COLORS_BAD[0]) {
        lines.push(`      <div class="leg-row"><div class="leg-box" style="background:${bc}"></div>不良 Bin ${bin}</div>`);
      }
    }
    if (possibleDies.length > 0) {
      lines.push(`      <div class="leg-row"><div class="leg-box" style="background:${COLOR_UNTESTED}"></div>未测</div>`);
    }
    lines.push("    </div>"); // card

    // Stats
    lines.push('    <div class="card">');
    lines.push(`      <h2>${esc(label)}</h2>`);
    lines.push('      <div class="stat-row">');
    lines.push(`        总 die：<span class="stat-val">${dies.length}</span><br/>`);
    lines.push(`        良品：<span class="stat-val">${goodCount}</span><br/>`);
    lines.push(`        良率：<span class="stat-val">${yieldPct.toFixed(2)}%</span>`);
    lines.push("      </div>");
    lines.push("    </div>"); // card

    lines.push("  </div>"); // sidebar
    lines.push("</div>"); // pass-panel
  });

  lines.push(TOOLTIP_JS);
  if (multiPass) lines.push(TAB_SWITCH_JS);
  lines.push("</body></html>");

  return lines.join("\n");
}

// ── Notch triangle ────────────────────────────────────────────────────────

function appendNotch(lines: string[], cx: number, cy: number, r: number, notchAngle: number): void {
  const rad = (notchAngle * Math.PI) / 180;
  const perpRad = rad + Math.PI / 2;
  const notchSz = r * 0.028;

  const bx1 = cx + r * Math.cos(rad) + notchSz * Math.cos(perpRad);
  const by1 = cy + r * Math.sin(rad) + notchSz * Math.sin(perpRad);
  const bx2 = cx + r * Math.cos(rad) - notchSz * Math.cos(perpRad);
  const by2 = cy + r * Math.sin(rad) - notchSz * Math.sin(perpRad);
  const tipR = r - notchSz * 1.8;
  const nx = cx + tipR * Math.cos(rad);
  const ny = cy + tipR * Math.sin(rad);

  lines.push(
    `      <polygon class="notch" points="${f(bx1)},${f(by1)} ${f(bx2)},${f(by2)} ${f(nx)},${f(ny)}" fill="#90a4ae"/>`
  );
}

// ── Lot heatmap HTML ──────────────────────────────────────────────────────

export type LotHeatmapPass = {
  label: string;
  /** Die coordinate → count of wafers that had a bad die here. */
  badFreq: Map<string, number>;
  totalWafers: number;
};

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

  // Bounds
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
    lines.push("  </div>"); // wafer-wrap

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
    lines.push("</div>"); // pass-panel
  });

  lines.push(TOOLTIP_JS);
  if (multiPass) lines.push(TAB_SWITCH_JS);
  lines.push("</body></html>");
  return lines.join("\n");
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

// ── Slot-trend SVG chart ──────────────────────────────────────────────────

/**
 * Generate a slot-trend yield-over-time SVG line chart embedded in HTML.
 */
export function generateSlotTrendHtml(
  title: string,
  wafers: Array<{ slot: string; waferId: string; yield: number }>,
  firstHalfAvg: number,
  secondHalfAvg: number
): string {
  const W = 700, H = 400, ML = 60, MR = 20, MT = 40, MB = 60;
  const plotW = W - ML - MR;
  const plotH = H - MT - MB;

  const n = wafers.length;
  const xStep = n > 1 ? plotW / (n - 1) : 0;

  function px(i: number): number { return ML + i * xStep; }
  function py(y: number): number { return MT + plotH * (1 - y); }

  const lines: string[] = [];
  lines.push("<!DOCTYPE html>");
  lines.push('<html lang="zh"><head><meta charset="utf-8"/>');
  lines.push(`<title>${esc(title)}</title>`);
  lines.push(`<style>body{background:#1a1a2e;color:#cfd8dc;font-family:'Segoe UI',Consolas,sans-serif;padding:16px}
h1{font-size:15px;color:#64b5f6;margin-bottom:14px}
svg text{font-family:'Segoe UI',Consolas,sans-serif}
#tooltip{position:fixed;background:rgba(10,10,30,.92);color:#e0f7fa;padding:6px 10px;border-radius:4px;font-size:11px;pointer-events:none;display:none;border:1px solid #455a64;white-space:pre;z-index:999}
</style>`);
  lines.push("</head><body>");
  lines.push('<div id="tooltip"></div>');
  lines.push(`<h1>${esc(title)}</h1>`);
  lines.push(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`);
  lines.push(`<rect width="${W}" height="${H}" fill="#0d0d1e"/>`);

  // Half shading
  const halfX = ML + plotW / 2;
  lines.push(`<rect x="${ML}" y="${MT}" width="${plotW / 2}" height="${plotH}" fill="#1a2040" opacity="0.5"/>`);
  lines.push(`<rect x="${halfX}" y="${MT}" width="${plotW / 2}" height="${plotH}" fill="#1e3040" opacity="0.5"/>`);

  // Grid lines (every 10%)
  for (let yv = 0; yv <= 100; yv += 10) {
    const yp = py(yv / 100);
    lines.push(`<line x1="${ML}" y1="${yp.toFixed(1)}" x2="${W - MR}" y2="${yp.toFixed(1)}" stroke="#2a3050" stroke-width="0.8"/>`);
    lines.push(`<text x="${ML - 6}" y="${(yp + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="#7080a0">${yv}%</text>`);
  }

  // Average lines
  const y1 = py(firstHalfAvg);
  const y2 = py(secondHalfAvg);
  lines.push(`<line x1="${ML}" y1="${y1.toFixed(1)}" x2="${halfX.toFixed(1)}" y2="${y1.toFixed(1)}" stroke="#64b5f6" stroke-width="1" stroke-dasharray="4 3"/>`);
  lines.push(`<text x="${ML + 4}" y="${(y1 - 4).toFixed(1)}" font-size="9" fill="#64b5f6">前半均值${(firstHalfAvg * 100).toFixed(1)}%</text>`);
  lines.push(`<line x1="${halfX.toFixed(1)}" y1="${y2.toFixed(1)}" x2="${W - MR}" y2="${y2.toFixed(1)}" stroke="#ef9a9a" stroke-width="1" stroke-dasharray="4 3"/>`);
  lines.push(`<text x="${(halfX + 4).toFixed(1)}" y="${(y2 - 4).toFixed(1)}" font-size="9" fill="#ef9a9a">后半均值${(secondHalfAvg * 100).toFixed(1)}%</text>`);

  // Line + points
  if (n > 1) {
    const pts = wafers.map((w, i) => `${px(i).toFixed(1)},${py(w.yield).toFixed(1)}`).join(" ");
    lines.push(`<polyline points="${pts}" fill="none" stroke="#4fc3f7" stroke-width="2"/>`);
  }

  for (let i = 0; i < wafers.length; i++) {
    const w = wafers[i]!;
    const x = px(i), y = py(w.yield);
    const tip = `Slot ${w.slot} (${w.waferId})&#10;良率 ${(w.yield * 100).toFixed(2)}%`;
    lines.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" fill="#4fc3f7" stroke="#0d0d1e" stroke-width="1" data-tip="${esc(tip)}"/>`);
    if (i % Math.max(1, Math.floor(n / 10)) === 0) {
      lines.push(`<text x="${x.toFixed(1)}" y="${(H - MB + 16).toFixed(1)}" text-anchor="middle" font-size="9" fill="#7080a0">${esc(w.slot)}</text>`);
    }
  }

  // Axes
  lines.push(`<line x1="${ML}" y1="${MT}" x2="${ML}" y2="${MT + plotH}" stroke="#546e7a" stroke-width="1"/>`);
  lines.push(`<line x1="${ML}" y1="${MT + plotH}" x2="${W - MR}" y2="${MT + plotH}" stroke="#546e7a" stroke-width="1"/>`);
  lines.push(`<text x="${W / 2}" y="${H - 4}" text-anchor="middle" font-size="11" fill="#90a4ae">Slot 顺序</text>`);

  lines.push("</svg>");
  lines.push(`<script>
var tip=document.getElementById('tooltip');
document.querySelectorAll('[data-tip]').forEach(function(el){
  el.addEventListener('mouseover',function(e){tip.innerHTML=e.target.getAttribute('data-tip');tip.style.display='block';});
  el.addEventListener('mousemove',function(e){tip.style.left=(e.clientX+14)+'px';tip.style.top=(e.clientY-10)+'px';});
  el.addEventListener('mouseout',function(){tip.style.display='none';});
});
</script>`);
  lines.push("</body></html>");
  return lines.join("\n");
}

// ── DUT × BIN relationship map (no-color, pattern-based) ─────────────────

export type DutBinDieEntry = {
  x: number;
  y: number;
  bin: number;
  site: number | null;
  isGood: boolean;
};

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
  const ys = dies.map((d) => d.y);
  if (xs.length === 0) return `<html><body><p>无 die 数据</p></body></html>`;

  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
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

  // Count categories
  let matchCount = 0, dutOnlyCount = 0, binOnlyCount = 0;
  for (const d of dies) {
    const isDut = d.site === targetDut;
    const isBin = d.bin === targetBin;
    if (isDut && isBin) matchCount++;
    else if (isDut) dutOnlyCount++;
    else if (isBin) binOnlyCount++;
  }
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
  lines.push(`    <svg width="${CANVAS_SIZE}" height="${CANVAS_SIZE}" xmlns="http://www.w3.org/2000/svg" style="display:block">`);
  lines.push(`      <rect width="${CANVAS_SIZE}" height="${CANVAS_SIZE}" fill="#0d0d1e"/>`);

  // Patterns — stripe pitch adapts to die size
  const pw = Math.max(3, Math.min(8, Math.round(cellW * 0.45)));
  lines.push("      <defs>");
  lines.push(`        <pattern id="p-dut" width="${pw}" height="${pw}" patternUnits="userSpaceOnUse">`);
  lines.push(`          <rect width="${pw}" height="${pw}" fill="#0d1830"/>`);
  lines.push(`          <line x1="0" y1="${f(pw / 2)}" x2="${pw}" y2="${f(pw / 2)}" stroke="#8888bb" stroke-width="0.9"/>`);
  lines.push("        </pattern>");
  lines.push(`        <pattern id="p-bin" width="${pw}" height="${pw}" patternUnits="userSpaceOnUse">`);
  lines.push(`          <rect width="${pw}" height="${pw}" fill="#0d1830"/>`);
  lines.push(`          <line x1="${f(pw / 2)}" y1="0" x2="${f(pw / 2)}" y2="${pw}" stroke="#8888bb" stroke-width="0.9"/>`);
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
    { pred: (d) => d.site !== targetDut && d.bin === targetBin, fill: "url(#p-bin)", stroke: "#6060a0", sw: "0.6", opacity: "0.95" },
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
  lines.push("  </div>"); // wafer-wrap

  // Sidebar
  lines.push('  <div class="sidebar">');
  lines.push('    <div class="card"><h2>图例（无颜色）</h2>');
  const legItems = [
    { label: `DUT${targetDut} ＆ BIN${targetBin}（双匹配）`, svgFill: "#dcdcff", svgStroke: "#a0a0e0" },
    { label: `DUT${targetDut}（其他 bin）横线`, patternId: "p-dut" },
    { label: `BIN${targetBin}（其他 DUT）竖线`, patternId: "p-bin" },
    { label: "其他 die（极暗）", svgFill: "#1a1a30" },
  ];
  for (const item of legItems) {
    const inner = "patternId" in item
      ? `<svg width="13" height="13" xmlns="http://www.w3.org/2000/svg" style="display:inline-block;margin-right:6px"><defs><pattern id="l-${item.patternId}" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="4" fill="#0d1830"/>${item.patternId === "p-dut" ? '<line x1="0" y1="2" x2="4" y2="2" stroke="#8888bb" stroke-width="0.9"/>' : '<line x1="2" y1="0" x2="2" y2="4" stroke="#8888bb" stroke-width="0.9"/>'}</pattern></defs><rect width="13" height="13" fill="url(#l-${item.patternId})" stroke="#6060a0" stroke-width="0.6"/></svg>${esc(item.label)}`
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
  lines.push("</div>"); // pass-panel

  lines.push(TOOLTIP_JS);
  lines.push("</body></html>");
  return lines.join("\n");
}
