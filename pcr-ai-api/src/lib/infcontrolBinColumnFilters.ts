import type { BindParameters } from "oracledb";

export type BinColumnFilterFail = { ok: false; error: string };
export type BinColumnFilterOk = { ok: true };

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

function parseCommaSeparatedIntegers(
  raw: unknown,
  label: string,
  opts?: { max?: number; stripBinPrefix?: boolean }
): number[] {
  const s = firstString(raw);
  if (s === undefined) return [];
  const parts = s.split(/[,，\s]+/).map((p) => p.trim()).filter(Boolean);
  const out: number[] = [];
  for (const p of parts) {
    const token = opts?.stripBinPrefix ? p.replace(/^bin\s*/i, "") : p;
    const n = Number(token);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      throw new Error(`Invalid integer in ${label}: ${p}`);
    }
    if (opts?.max !== undefined && (n < 0 || n > opts.max)) {
      throw new Error(`${label}: value must be 0–${opts.max}, got ${n}`);
    }
    out.push(n);
  }
  return out;
}

/** Parse comma-separated bin indices, e.g. "8, 11, 131" or "BIN8, BIN11". */
export function parseBinIndexList(raw: unknown, label: string): number[] {
  return [...new Set(parseCommaSeparatedIntegers(raw, label, { max: 255, stripBinPrefix: true }))];
}

function parseBinDieValueList(raw: unknown, label: string): number[] {
  return parseCommaSeparatedIntegers(raw, label);
}

function validateBinIndex(idx: number, label: string): BinColumnFilterFail | BinColumnFilterOk {
  if (!Number.isInteger(idx) || idx < 0 || idx > 255) {
    return { ok: false, error: `Invalid BIN index in ${label}: ${idx}` };
  }
  return { ok: true };
}

/**
 * JB INFLAYERBINLIST bin column filters (Oracle + Dummy).
 *
 * - **`bins=8,11,131`**: row matches if **any** listed `BINn` column has die count **> 0**.
 * - **`bin8=5` or `bin8=5,10`**: `BIN8` value IN (...), same as legacy v1 keys.
 *
 * @param columnPrefix e.g. `lb.` (v1) or `t2.` (v3)
 */
export function applyInfcontrolBinColumnFilters(
  q: Record<string, unknown>,
  clauses: string[],
  binds: BindParameters,
  applied: Record<string, unknown>,
  columnPrefix: string
): BinColumnFilterFail | BinColumnFilterOk {
  try {
    const binsRaw = firstString(firstQueryValue(q, "bins"));
    if (binsRaw !== undefined) {
      const indices = parseBinIndexList(binsRaw, "bins");
      if (indices.length > 0) {
        const orParts = indices.map(
          (idx) => `NVL(${columnPrefix}BIN${idx}, 0) > 0`
        );
        clauses.push(`(${orParts.join(" OR ")})`);
        applied.bins = indices;
      }
    }

    const binRe = /^bin(\d+)$/i;
    for (const key of Object.keys(q)) {
      const m = key.match(binRe);
      if (!m) continue;
      const idx = Number(m[1]);
      const valid = validateBinIndex(idx, `query key ${key}`);
      if (!valid.ok) return valid;

      const values = parseBinDieValueList(q[key], key);
      if (values.length === 0) continue;
      const placeholders = values
        .map((_, i) => `:f_bin_${idx}_${i}`)
        .join(", ");
      clauses.push(`${columnPrefix}BIN${idx} IN (${placeholders})`);
      applied[`bin${idx}`] = values;
      const bb = binds as Record<string, string | number | Date>;
      values.forEach((v, i) => {
        bb[`f_bin_${idx}_${i}`] = v;
      });
    }

    return { ok: true };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: message };
  }
}

/** Dummy / in-memory row filter mirroring Oracle bin column rules. */
export function rowMatchesInfcontrolBinColumnFilters(
  row: Record<string, unknown>,
  applied: Record<string, unknown>
): boolean {
  if (Array.isArray(applied.bins)) {
    const indices = applied.bins as number[];
    if (
      indices.length > 0 &&
      !indices.some((idx) => Number(row[`BIN${idx}`] ?? 0) > 0)
    ) {
      return false;
    }
  }

  for (const key of Object.keys(applied)) {
    const m = key.match(/^bin(\d+)$/i);
    if (!m) continue;
    const idx = m[1];
    const values = applied[key];
    if (!Array.isArray(values) || values.length === 0) continue;
    const set = new Set(values.map((x) => Number(x)));
    if (!set.has(Number(row[`BIN${idx}`]))) return false;
  }

  return true;
}
