/** Pure utilities for Yield% computation, DUT label parsing, tree building, and date shortcuts. */

import { collectGoodBinNumbersFromJbRow } from "./infGoodBins";
import type { InfcontrolLayerBinV3Row } from "../api/types";

// ── Yield% ─────────────────────────────────────────────────────────────────

type BinCell = { n: number; value: number; isGoodBin: boolean };

function badDieFromJbListRow(
  row: { bins?: BinCell[]; GROSSDIE?: number; grossDie?: number } & InfcontrolLayerBinV3Row
): number {
  const good = collectGoodBinNumbersFromJbRow(row as InfcontrolLayerBinV3Row);
  let bad = 0;
  if (!Array.isArray(row.bins)) return 0;
  for (const b of row.bins) {
    const n = Number(b.n);
    const v = Number(b.value);
    if (!Number.isFinite(n) || !Number.isFinite(v) || v <= 0) continue;
    if (good.has(n) || b.isGoodBin) continue;
    bad += v;
  }
  return bad;
}

function grossDieFromRow(row: { GROSSDIE?: number; grossDie?: number }): number {
  const g = Number(row.GROSSDIE ?? row.grossDie ?? 0);
  return Number.isFinite(g) && g > 0 ? g : 0;
}

/**
 * JB 列表行良率（与 API `jbYieldCalc` 一致）：
 * GROSSDIE 取组内 MAX；坏 die 仅在 GROSSDIE 等于该 max 的行上累加；BIN1 为良品。
 */
export function computeYieldPct(
  rows: Array<
    { bins?: BinCell[]; GROSSDIE?: number; grossDie?: number } & InfcontrolLayerBinV3Row
  >
): number | null {
  if (!rows.length) return null;
  let grossDie = 0;
  for (const row of rows) grossDie = Math.max(grossDie, grossDieFromRow(row));
  if (grossDie <= 0) return null;
  let badDie = 0;
  for (const row of rows) {
    if (grossDieFromRow(row) !== grossDie) continue;
    badDie += badDieFromJbListRow(row);
  }
  return ((grossDie - badDie) / grossDie) * 100;
}

/** Color based on yield%: ≥95 green, 80-95 yellow/orange, <80 red. */
export function yieldColor(pct: number | null): string {
  if (pct === null) return "#8b949e";
  if (pct >= 95) return "#3fb950";
  if (pct >= 80) return "#d29922";
  return "#ff7b72";
}

// ── DUT parsing ────────────────────────────────────────────────────────────

const DUT_RE = /on\s+dut#\s*(\d+)/i;

/** Parse dutNumber from TRIGGER_LABEL "on dut# N". Returns null if no match. */
export function parseDutNumber(label: unknown): number | null {
  if (typeof label !== "string") return null;
  const m = label.match(DUT_RE);
  return m ? Number(m[1]) : null;
}

/** Tally DUT numbers from a list of rows, returning top-N entries. */
export function tallyDutNumbers(
  rows: Array<{ dutNumber?: number | null }>,
  top = 20
): Array<{ dut: number; count: number }> {
  const m = new Map<number, number>();
  for (const row of rows) {
    const d = row.dutNumber;
    if (d !== null && d !== undefined && Number.isFinite(d)) {
      m.set(d, (m.get(d) ?? 0) + 1);
    }
  }
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([dut, count]) => ({ dut, count }));
}

// ── Tree building ──────────────────────────────────────────────────────────

export type TreeNode = {
  id: string;
  dimKey: string;
  dimValue: string;
  total: number;
  children: TreeNode[];
};

/**
 * Build a tree from flat aggregate groups.
 * `dims` is an ordered array of part keys, e.g. ["device", "lotId", "probeCard"].
 * Each group's `parts` must contain values for all dims listed.
 */
export function buildTree(
  groups: Array<{ key: string; count: number; parts: Record<string, string> }>,
  dims: string[]
): TreeNode[] {
  if (dims.length === 0) return [];

  type Bucket = { total: number; children: Map<string, Bucket> };
  const root: Map<string, Bucket> = new Map();

  function ensureBucket(map: Map<string, Bucket>, key: string): Bucket {
    if (!map.has(key)) map.set(key, { total: 0, children: new Map() });
    return map.get(key)!;
  }

  for (const g of groups) {
    let currentMap: Map<string, Bucket> = root;
    for (let di = 0; di < dims.length; di++) {
      const dimVal = g.parts[dims[di]] ?? "—";
      const bucket = ensureBucket(currentMap, dimVal);
      bucket.total += g.count;
      currentMap = bucket.children;
    }
  }

  function toNodes(
    map: Map<string, Bucket>,
    dimIndex: number,
    parentId: string
  ): TreeNode[] {
    const nodes: TreeNode[] = [];
    for (const [dimValue, bucket] of map.entries()) {
      const id = parentId ? `${parentId}|${dimValue}` : dimValue;
      nodes.push({
        id,
        dimKey: dims[dimIndex],
        dimValue,
        total: bucket.total,
        children:
          dimIndex + 1 < dims.length
            ? toNodes(bucket.children, dimIndex + 1, id)
            : [],
      });
    }
    return nodes.sort((a, b) => b.total - a.total);
  }

  return toNodes(root, 0, "");
}

// ── Date shortcuts ─────────────────────────────────────────────────────────

function padDate(n: number): string {
  return String(n).padStart(2, "0");
}

function toDatetimeLocal(d: Date): string {
  return (
    `${d.getFullYear()}-${padDate(d.getMonth() + 1)}-${padDate(d.getDate())}` +
    `T${padDate(d.getHours())}:${padDate(d.getMinutes())}`
  );
}

export function dateShortcutToday(): [string, string] {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return [toDatetimeLocal(start), toDatetimeLocal(now)];
}

export function dateShortcutLast7Days(): [string, string] {
  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() - 7);
  return [toDatetimeLocal(start), toDatetimeLocal(now)];
}

export function dateShortcutThisMonth(): [string, string] {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  return [toDatetimeLocal(start), toDatetimeLocal(now)];
}
