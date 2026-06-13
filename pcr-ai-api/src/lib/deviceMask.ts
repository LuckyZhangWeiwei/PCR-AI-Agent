/**
 * Returns the last 4 characters of a device string (the "mask" product identifier).
 * Returns null if the device value is empty.
 *
 * Example: "WA03P02G" → "P02G"
 */
export function deviceMask(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  return s.length > 0 ? s.slice(-4) : null;
}

/** Base segment = part before first `-` or `_` (if any). */
export function deviceBaseSegment(device: unknown): string {
  const s = String(device ?? "").trim();
  const sepIdx = s.search(/[-_]/);
  return sepIdx >= 0 ? s.slice(0, sepIdx) : s;
}

/** Mask = last 4 chars of base segment (agent / filter semantics). */
export function deviceBaseMask(device: unknown): string | null {
  const base = deviceBaseSegment(device);
  return base.length >= 4 ? base.slice(-4).toUpperCase() : null;
}

const MASK_TOKEN_RE = /^[A-Za-z0-9]{4}$/;

export function looksLikeDeviceMaskToken(value: unknown): boolean {
  const s = String(value ?? "").trim();
  return MASK_TOKEN_RE.test(s);
}

/** True when device code matches a 4-char mask (base-segment suffix or substring). */
export function deviceMatchesMask(device: unknown, mask: unknown): boolean {
  const m = String(mask ?? "").trim().toUpperCase();
  if (!m) return false;
  const baseMask = deviceBaseMask(device);
  if (baseMask === m) return true;
  return String(device ?? "").trim().toUpperCase().includes(m);
}

/**
 * Oracle WHERE fragment for matching device column against a mask bind.
 * Dual condition: base-segment last-4 OR substring (covers WA03P02G → P02G).
 */
export function deviceMaskOracleWhere(column: string, bindName: string): string {
  return `(
    UPPER(SUBSTR(REGEXP_REPLACE(TRIM(${column}), '[-_].*', ''), -4)) = UPPER(:${bindName})
    OR UPPER(TRIM(${column})) LIKE '%' || UPPER(:${bindName}) || '%'
  )`;
}
