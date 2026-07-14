/**
 * Slot-trend yield-over-time SVG line chart generator, embedded in a
 * standalone HTML file. Fully self-contained (own CSS/JS) — does not share
 * layout/rendering logic with the wafer-map style generators in this
 * directory.
 */

import { esc } from "./waferMapHtmlShared.js";

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
