/**
 * Optional BIN column filters for infcontrol endpoints (manifest: bin0…bin255).
 * Each non-empty line: `12=1,3,5` or `bin12=1,3,5` → query param bin12=1,3,5
 */
export function parseBinFilterLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    let idxPart = t.slice(0, eq).trim().toLowerCase();
    const vals = t.slice(eq + 1).trim();
    if (!vals) continue;
    if (idxPart.startsWith("bin")) idxPart = idxPart.slice(3);
    const n = Number(idxPart);
    if (!Number.isFinite(n) || n < 0 || n > 255) continue;
    out[`bin${n}`] = vals;
  }
  return out;
}
