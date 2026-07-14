/**
 * Shared constants/helpers used by more than one of the standalone HTML report
 * generators in this directory (waferMapHtml, lotHeatmapHtml, dutBinMapHtml).
 * `slotTrendHtml.ts` is fully self-contained (own inline CSS/JS) and does not
 * use anything from here.
 */

export const CANVAS_SIZE = 780;
export const PADDING = 52;
export const COLOR_OUTLINE = "#78909C";
export const COLOR_EDGE_BAND = "#37474f";

export const HTML_CSS = `<style>
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

export const TOOLTIP_JS = `<script>
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

export const TAB_SWITCH_JS = `<script>
function showPass(idx){
  document.querySelectorAll('.pass-panel').forEach(function(p,i){
    p.classList.toggle('active',i===idx);
  });
  document.querySelectorAll('.tab-btn').forEach(function(b,i){
    b.classList.toggle('active',i===idx);
  });
}
</script>`;

// ── Formatting helpers ──────────────────────────────────────────────────────

export function f(v: number): string { return v.toFixed(1); }
export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
export function pct(v: number): string { return (v * 100).toFixed(2) + "%"; }

// ── Notch triangle ────────────────────────────────────────────────────────

export function appendNotch(lines: string[], cx: number, cy: number, r: number, notchAngle: number): void {
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
