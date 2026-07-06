/** Pure utilities for Yield% computation, DUT label parsing, tree building, and date shortcuts. */

import { collectGoodBinNumbersFromJbRow } from "./infGoodBins";
import type { InfcontrolLayerBinV3Row } from "../api/types";

// ── Yield% ─────────────────────────────────────────────────────────────────

type BinCell = { n: number; value: number; isGoodBin: boolean };

type JbYieldRow = {
  bins?: BinCell[];
  GROSSDIE?: number;
  grossDie?: number;
  PASSTYPE?: string;
} & InfcontrolLayerBinV3Row;

function isInterruptRow(row: JbYieldRow): boolean {
  return String(row.PASSTYPE ?? "").trim().toUpperCase() === "INTERRUPT";
}

function badDieFromJbListRow(row: JbYieldRow): number {
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

function segmentYieldPct(rows: JbYieldRow[]): number | null {
  let gross = 0;
  let bad = 0;
  for (const row of rows) {
    gross += grossDieFromRow(row);
    bad += badDieFromJbListRow(row);
  }
  if (gross <= 0) return null;
  return ((gross - bad) / gross) * 100;
}

function computeNoInterruptYieldPct(rows: JbYieldRow[]): number | null {
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

function testEndMs(row: JbYieldRow): number {
  const raw = (row as { TESTEND?: string }).TESTEND;
  if (raw == null || raw === "") return 0;
  const t = new Date(String(raw)).getTime();
  return Number.isFinite(t) ? t : 0;
}

function passIdFromRow(row: JbYieldRow): number {
  const v = Number((row as { PASSID?: number }).PASSID ?? 0);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function passNumFromRow(row: JbYieldRow): number {
  const v = Number((row as { PASSNUM?: number }).PASSNUM ?? 0);
  return Number.isFinite(v) && v > 0 ? Math.round(v) : 1;
}

function splitPassGroup(rows: JbYieldRow[]): {
  segmented: boolean;
  firstHalf: JbYieldRow[];
  secondHalf: JbYieldRow[];
} {
  const interruptRows = rows.filter(isInterruptRow);
  if (interruptRows.length > 0) {
    return {
      segmented: true,
      firstHalf: interruptRows,
      secondHalf: rows.filter((r) => !isInterruptRow(r)),
    };
  }
  if (rows.length < 2) {
    return { segmented: false, firstHalf: [], secondHalf: [] };
  }
  const passNums = rows.map(passNumFromRow);
  const minPn = Math.min(...passNums);
  const maxPn = Math.max(...passNums);
  if (maxPn > minPn) {
    return {
      segmented: true,
      firstHalf: rows.filter((r) => passNumFromRow(r) === minPn),
      secondHalf: rows.filter((r) => passNumFromRow(r) > minPn),
    };
  }
  const sorted = [...rows].sort((a, b) => testEndMs(a) - testEndMs(b));
  return {
    segmented: true,
    firstHalf: [sorted[0]!],
    secondHalf: sorted.slice(1),
  };
}

function splitSlotRows(rows: JbYieldRow[]): {
  segmented: boolean;
  firstHalf: JbYieldRow[];
  secondHalf: JbYieldRow[];
} {
  const byPassId = new Map<number, JbYieldRow[]>();
  for (const row of rows) {
    const pid = passIdFromRow(row);
    if (!byPassId.has(pid)) byPassId.set(pid, []);
    byPassId.get(pid)!.push(row);
  }
  for (const pid of [...byPassId.keys()].sort((a, b) => a - b)) {
    const split = splitPassGroup(byPassId.get(pid)!);
    if (split.segmented) return split;
  }
  return { segmented: false, firstHalf: [], secondHalf: [] };
}

/**
 * JB 良率（与 API `jbYieldCalc` 一致）：INTERRUPT 或续测双 TEST 时按上半/下半段规则合并。
 */
export function computeYieldPct(rows: JbYieldRow[]): number | null {
  if (!rows.length) return null;

  const split = splitSlotRows(rows);
  if (!split.segmented) {
    return computeNoInterruptYieldPct(rows);
  }

  if (!split.secondHalf.length) return segmentYieldPct(split.firstHalf);

  // Mirror API jbYieldCalc.computeSegmentedWholeWafer:
  // if firstHalf.goodDie === 0 → return secondHalf yield (may be null)
  let grossUp = 0;
  let badUp = 0;
  for (const row of split.firstHalf) {
    grossUp += grossDieFromRow(row);
    badUp += badDieFromJbListRow(row);
  }
  const goodUp = Math.max(0, grossUp - badUp);

  const secondPct = segmentYieldPct(split.secondHalf);
  if (goodUp === 0) return secondPct;

  const firstPct = segmentYieldPct(split.firstHalf);
  if (firstPct === null) return secondPct;
  if (secondPct === null) return firstPct;

  let grossDown = 0;
  let badDown = 0;
  for (const row of split.secondHalf) {
    grossDown += grossDieFromRow(row);
    badDown += badDieFromJbListRow(row);
  }
  const gross = grossUp + grossDown;
  const good = goodUp + Math.max(0, grossDown - badDown);
  return gross > 0 ? (good / gross) * 100 : null;
}

/** Color based on yield%: ≥95 green, 80-95 yellow/orange, <80 red. */
export function yieldColor(pct: number | null): string {
  if (pct === null) return "var(--muted)";
  if (pct >= 95) return "var(--green)";
  if (pct >= 80) return "var(--yellow)";
  return "var(--red-text)";
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

// ── Period window (周/月报警统计) ────────────────────────────────────────

export type PeriodKey = "week" | "month";

/**
 * 当前周期窗口 + 等长的紧邻前一周期窗口（用于环比）。
 * 本周 = 最近 7 天；本月 = 自然月 1 日至今。
 * 环比窗口取与当前窗口等长的紧邻前段，使"本月至今 N 天" vs "上月同样 N 天"公平对比。
 */
export function periodWindow(
  period: PeriodKey,
  now: Date = new Date()
): { start: Date; end: Date; prevStart: Date; prevEnd: Date } {
  const end = now;
  const start =
    period === "week"
      ? new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
      : new Date(now.getFullYear(), now.getMonth(), 1);
  const durationMs = end.getTime() - start.getTime();
  const prevEnd = start;
  const prevStart = new Date(start.getTime() - durationMs);
  return { start, end, prevStart, prevEnd };
}

export type PeriodBucket = { start: Date; end: Date; label: string };

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatMonthDay(d: Date): string {
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
}

function formatYearMonth(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

/**
 * 近 `count` 个周期窗口，按时间从旧到新排列，供趋势柱图 x 轴使用。
 * week：`count` 个连续、不重叠的滚动 7 天窗口，最新一个是 `[now-7d, now]`。
 * month：`count` 个自然月窗口，最新一个是「本月 1 日至 now」（可能是不完整月份），
 * 其余为完整自然月。
 */
export function recentPeriodBuckets(
  period: PeriodKey,
  count: number,
  now: Date = new Date()
): PeriodBucket[] {
  const buckets: PeriodBucket[] = [];
  if (period === "week") {
    const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
    for (let i = 0; i < count; i++) {
      const end = new Date(now.getTime() - i * WEEK_MS);
      const start = new Date(end.getTime() - WEEK_MS);
      buckets.push({ start, end, label: `${formatMonthDay(start)}-${formatMonthDay(end)}` });
    }
  } else {
    for (let i = 0; i < count; i++) {
      const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const end = i === 0 ? now : new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      buckets.push({ start, end, label: formatYearMonth(start) });
    }
  }
  return buckets.reverse();
}

/** 派生聚合维度 `bin` 的展示格式：数字 → `BIN n`；`goodbin` → `GOODBIN`；空 → `(未知)`。 */
export function formatBinLabel(bin: string): string {
  const v = bin.trim();
  if (v === "") return "(未知)";
  if (v.toLowerCase() === "goodbin") return "GOODBIN";
  return `BIN ${v}`;
}
