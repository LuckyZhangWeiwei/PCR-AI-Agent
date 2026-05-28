/**
 * Tester platform families inferred from HOSTNAME (Yield Monitor) or machine id strings.
 * e.g. b3uflex01 → UFLEX, b3flex01 → FLEX (UFLEX checked before FLEX).
 */
export const TESTER_PLATFORMS = [
  "J750",
  "FLEX",
  "UFLEX",
  "PS16",
  "MST",
  "93K",
] as const;

export type TesterPlatform = (typeof TESTER_PLATFORMS)[number];

export function normalizeTesterPlatform(raw: string): TesterPlatform | undefined {
  const u = raw.trim().toUpperCase();
  return (TESTER_PLATFORMS as readonly string[]).includes(u)
    ? (u as TesterPlatform)
    : undefined;
}

/** Classify a HOSTNAME into a platform (UFLEX before FLEX). */
export function classifyTesterPlatform(machineId: string): TesterPlatform | null {
  const h = machineId.trim().toLowerCase();
  if (!h) return null;
  if (h.includes("uflex")) return "UFLEX";
  if (h.includes("flex")) return "FLEX";
  if (h.includes("ps16")) return "PS16";
  if (h.includes("j750")) return "J750";
  if (h.includes("mst")) return "MST";
  if (h.includes("93k")) return "93K";
  return null;
}

export function machineIdMatchesPlatform(
  machineId: string,
  platform: TesterPlatform
): boolean {
  return classifyTesterPlatform(machineId) === platform;
}

/** Oracle predicate on HOSTNAME / TESTERID column expression (already qualified, e.g. t.HOSTNAME). */
export function buildPlatformColumnPredicate(
  columnSql: string,
  platform: TesterPlatform
): string {
  const col = `LOWER(TRIM(${columnSql}))`;
  switch (platform) {
    case "UFLEX":
      return `REGEXP_LIKE(${col}, 'uflex')`;
    case "FLEX":
      return `REGEXP_LIKE(${col}, 'flex') AND NOT REGEXP_LIKE(${col}, 'uflex')`;
    case "PS16":
      return `REGEXP_LIKE(${col}, 'ps16')`;
    case "J750":
      return `REGEXP_LIKE(${col}, 'j750')`;
    case "MST":
      return `REGEXP_LIKE(${col}, 'mst')`;
    case "93K":
      return `REGEXP_LIKE(${col}, '93k')`;
    default: {
      const _e: never = platform;
      return _e;
    }
  }
}

function firstQueryValue(q: Record<string, unknown>, key: string): unknown {
  const lower = key.toLowerCase();
  for (const k of Object.keys(q)) {
    if (k.toLowerCase() === lower) return q[k];
  }
  return undefined;
}

function firstString(raw: unknown): string | undefined {
  if (raw == null) return undefined;
  if (Array.isArray(raw)) {
    const a = raw[0];
    if (a == null) return undefined;
    return String(a).trim();
  }
  const s = String(raw).trim();
  return s === "" ? undefined : s;
}

export type ApplyPlatformFilterResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Append platform WHERE clause when query param `platform` is set.
 * @param hostnameColumnSql e.g. `t.HOSTNAME` or `t2.TESTERID`
 */
export function applyPlatformQueryFilter(
  q: Record<string, unknown>,
  clauses: string[],
  applied: Record<string, unknown>,
  hostnameColumnSql: string
): ApplyPlatformFilterResult {
  const raw = firstString(firstQueryValue(q, "platform"));
  if (raw === undefined) return { ok: true };
  const platform = normalizeTesterPlatform(raw);
  if (!platform) {
    return {
      ok: false,
      error: `Invalid platform "${raw}"; use one of: ${TESTER_PLATFORMS.join(", ")}`,
    };
  }
  clauses.push(buildPlatformColumnPredicate(hostnameColumnSql, platform));
  applied.platform = platform;
  return { ok: true };
}

export function filterRowsByAppliedPlatform<T>(
  rows: T[],
  getMachineId: (row: T) => string,
  applied: Record<string, unknown>
): T[] {
  if (applied.platform === undefined) return rows;
  const platform = normalizeTesterPlatform(String(applied.platform));
  if (!platform) return rows;
  return rows.filter((r) => machineIdMatchesPlatform(getMachineId(r), platform));
}
