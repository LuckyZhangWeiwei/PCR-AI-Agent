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
