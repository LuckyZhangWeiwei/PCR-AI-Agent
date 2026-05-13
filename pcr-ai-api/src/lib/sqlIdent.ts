// 仅允许 Oracle 非引号标识符字符，避免动态 SQL 注入
const IDENT = /^[A-Za-z][A-Za-z0-9_$#]{0,127}$/;

export type ParsedTable =
  | { error: string }
  | { schema: string | null; table: string };

export function parseQualifiedTable(raw: unknown): ParsedTable {
  if (raw == null || typeof raw !== "string") {
    return { error: "Missing table name" };
  }
  const trimmed = raw.trim();
  const parts = trimmed.split(".").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 1 || parts.length > 2) {
    return { error: "Use TABLE or SCHEMA.TABLE" };
  }
  for (const p of parts) {
    if (!IDENT.test(p)) {
      return { error: `Invalid identifier: ${p}` };
    }
  }
  if (parts.length === 1) {
    return { schema: null, table: parts[0].toUpperCase() };
  }
  return { schema: parts[0].toUpperCase(), table: parts[1].toUpperCase() };
}

export function clampLimit(
  raw: unknown,
  fallback: number,
  max: number
): number {
  const n = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(max, n);
}

/**
 * Read a GET query value by canonical `key` with **case-insensitive** parameter
 * names (e.g. `Limit`, `LIMIT`, `limit` all match `"limit"`).
 */
export function queryValueCaseInsensitive(
  q: Record<string, unknown>,
  key: string
): unknown {
  const lower = key.toLowerCase();
  for (const k of Object.keys(q)) {
    if (k.toLowerCase() === lower) return q[k];
  }
  return undefined;
}

/** `clampLimit` on `limit` read with {@link queryValueCaseInsensitive}. */
export function clampLimitFromQuery(
  q: Record<string, unknown>,
  fallback: number,
  max: number
): number {
  return clampLimit(queryValueCaseInsensitive(q, "limit"), fallback, max);
}
