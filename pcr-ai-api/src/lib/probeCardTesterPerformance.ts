import { badDieFromJbRow } from "./jbYieldCalc.js";

// ─── stats helpers ──────────────────────────────────────────────────────────

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/** Sample standard deviation (n-1 denominator). 0 when fewer than 2 values. */
export function sampleStdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const sumSq = values.reduce((s, v) => s + (v - m) * (v - m), 0);
  return Math.sqrt(sumSq / (values.length - 1));
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

// ─── per-row yield ──────────────────────────────────────────────────────────

function grossDieOf(row: Record<string, unknown>): number {
  const g = Number((row as Record<string, unknown>)["GROSSDIE"] ?? (row as Record<string, unknown>)["grossDie"] ?? 0);
  return Number.isFinite(g) && g > 0 ? g : 0;
}

/**
 * Per-row yield percentage (0-100). `row` must already be enriched (has
 * `row.bins[]`, see `enrichJbRow` / `enrichInfcontrolLayerBinRowV2`). Reuses
 * `badDieFromJbRow` (BIN1-hard-good + PASSBIN hyphen tokens + bins[].isGoodBin
 * union) — do not reimplement bad-die counting here.
 * Returns null when GROSSDIE is missing/zero (row excluded from stats).
 */
export function rowYieldPct(row: Record<string, unknown>): number | null {
  const grossDie = grossDieOf(row);
  if (grossDie <= 0) return null;
  const bad = badDieFromJbRow(row);
  return (1 - bad / grossDie) * 100;
}
