/**
 * JB STAR 良率：与报表 `infGoodBins` 一致。
 * - 无中断：同 slot 多行在 MAX(GROSSDIE) 满片行上累加坏 die。
 * - 有中断：上半段 = INTERRUPT 行；下半段 = 非 INTERRUPT（通常为 TEST 续测完成）。
 *   - `interruptHalf` / `completionHalf` 始终分别计算并输出（上半段 yield 可为 0%）。
 *   - 整片正片（顶层 grossDie/yieldPct）：上半段 good=0 → 仅下半段；上半段 good>0 → 上下半段合并。
 */

import { parsePassBinHyphenGoodBins } from "./passBinSemantics.js";

export const JB_HARD_GOOD_BIN = 1;

type BinCell = {
  n?: number;
  value?: number;
  dieCount?: number;
  isGoodBin?: boolean;
  isGood?: boolean;
};

function addGoodIndex(good: Set<number>, raw: unknown): void {
  const v = typeof raw === "number" ? raw : Number(raw);
  if (Number.isInteger(v) && v >= 0 && v <= 255) good.add(v);
}

/** 单行良品 bin 下标（BIN1 + PASSBIN 段 + bins[].isGoodBin）。 */
export function goodBinIndicesForJbRow(row: Record<string, unknown>): Set<number> {
  const good = new Set<number>();
  addGoodIndex(good, JB_HARD_GOOD_BIN);
  const passBin =
    row.PASSBIN ?? row.passbin ?? row.PassBin ?? row.PASS_BIN;
  for (const n of parsePassBinHyphenGoodBins(passBin)) good.add(n);

  const bins = row.bins;
  if (Array.isArray(bins)) {
    for (const cell of bins) {
      if (cell == null || typeof cell !== "object") continue;
      const c = cell as BinCell;
      const n = Number(c.n ?? (c as { bin?: number }).bin);
      if (!Number.isInteger(n) || n < 0 || n > 255) continue;
      if (c.isGoodBin === true || c.isGood === true) good.add(n);
    }
  }
  return good;
}

/** 单行坏 die 合计（仅非良品 bin 列）。 */
export function badDieFromJbRow(row: Record<string, unknown>): number {
  const good = goodBinIndicesForJbRow(row);
  let total = 0;
  const bins = row.bins;
  if (!Array.isArray(bins)) return 0;
  for (const cell of bins) {
    if (cell == null || typeof cell !== "object") continue;
    const c = cell as BinCell;
    const n = Number(c.n ?? (c as { bin?: number }).bin);
    const v = Number(c.value ?? c.dieCount ?? 0);
    if (!Number.isFinite(n) || !Number.isFinite(v) || v <= 0) continue;
    if (good.has(n)) continue;
    total += v;
  }
  return total;
}

function grossDieFromRow(row: Record<string, unknown>): number {
  const g = Number(row.GROSSDIE ?? row.grossDie ?? 0);
  return Number.isFinite(g) && g > 0 ? g : 0;
}

export function isInterruptPasstype(row: Record<string, unknown>): boolean {
  return (
    String(row.PASSTYPE ?? row.passtype ?? "").trim().toUpperCase() === "INTERRUPT"
  );
}

export type JbYieldMetrics = {
  grossDie: number;
  badDie: number;
  goodDie: number;
  yieldPct: number | null;
};

function metricsFromTotals(grossDie: number, badDie: number): JbYieldMetrics {
  const goodDie = Math.max(0, grossDie - badDie);
  const yieldPct = grossDie > 0 ? (goodDie / grossDie) * 100 : null;
  return { grossDie, badDie, goodDie, yieldPct };
}

/** 一段（多行）的 total / bad / good 相加。 */
export function segmentMetrics(rows: Record<string, unknown>[]): JbYieldMetrics {
  let grossDie = 0;
  let badDie = 0;
  for (const row of rows) {
    grossDie += grossDieFromRow(row);
    badDie += badDieFromJbRow(row);
  }
  return metricsFromTotals(grossDie, badDie);
}

/** 无 INTERRUPT：GROSSDIE 取 MAX，坏 die 仅在满片行累加。 */
function computeNoInterruptYield(rows: Record<string, unknown>[]): JbYieldMetrics {
  if (!rows.length) {
    return { grossDie: 0, badDie: 0, goodDie: 0, yieldPct: null };
  }
  let grossDie = 0;
  for (const row of rows) {
    grossDie = Math.max(grossDie, grossDieFromRow(row));
  }
  if (grossDie <= 0) {
    return { grossDie: 0, badDie: 0, goodDie: 0, yieldPct: null };
  }
  const pool = rows.filter((r) => grossDieFromRow(r) === grossDie);
  let badDie = 0;
  for (const row of pool) badDie += badDieFromJbRow(row);
  return metricsFromTotals(grossDie, badDie);
}

/**
 * 同 slot 良率：有 INTERRUPT 时按上半段/下半段规则；否则走无中断逻辑。
 */
export function computeJbYieldMetrics(
  rows: Record<string, unknown>[]
): JbYieldMetrics {
  if (!rows.length) {
    return { grossDie: 0, badDie: 0, goodDie: 0, yieldPct: null };
  }

  const interruptRows = rows.filter(isInterruptPasstype);
  const completionRows = rows.filter((r) => !isInterruptPasstype(r));

  if (interruptRows.length === 0) {
    return computeNoInterruptYield(rows);
  }

  const firstHalf = segmentMetrics(interruptRows);

  if (completionRows.length === 0) {
    return firstHalf;
  }

  const secondHalf = segmentMetrics(completionRows);

  /** 上半段无良品 → 不参与正片，仅用下半段（如 slot21：116/0 + 4732/4487） */
  if (firstHalf.goodDie === 0) {
    return secondHalf;
  }

  const grossDie = firstHalf.grossDie + secondHalf.grossDie;
  const goodDie = firstHalf.goodDie + secondHalf.goodDie;
  const badDie = grossDie - goodDie;
  const yieldPct = grossDie > 0 ? (goodDie / grossDie) * 100 : null;
  return { grossDie, badDie, goodDie, yieldPct };
}

export type SlotYieldSummaryEntry = {
  slot: number;
  /** 整片正片良率（用于结论主数字） */
  grossDie: number;
  badDie: number;
  goodDie: number;
  yieldPct: number | null;
  hasInterrupt: boolean;
  rowCount: number;
  /** 上半片（INTERRUPT），有中断时必有 */
  interruptHalf?: JbYieldMetrics;
  /** 下半片（续测完成，非 INTERRUPT），有中断且存在完成段时必有 */
  completionHalf?: JbYieldMetrics;
};

const SLOT_YIELD_GUIDE =
  "slotYieldSummary：无中断时仅顶层整片。hasInterrupt:true 时须写三项且顺序固定：①整片正片(顶层) ②interruptHalf(前半) ③completionHalf(后半)。任一段 yieldPct=0 或 goodDie=0 仍须输出该段 total/好/坏/0%，禁止因无良品省略。勿只报后半段。";

/** 有 INTERRUPT 时拆出上半/下半；整片正片走 computeJbYieldMetrics。 */
export function computeJbYieldBreakdown(rows: Record<string, unknown>[]): {
  hasInterrupt: boolean;
  interruptHalf: JbYieldMetrics | null;
  completionHalf: JbYieldMetrics | null;
  wholeWafer: JbYieldMetrics;
} {
  const interruptRows = rows.filter(isInterruptPasstype);
  const completionRows = rows.filter((r) => !isInterruptPasstype(r));
  const hasInterrupt = interruptRows.length > 0;
  return {
    hasInterrupt,
    interruptHalf: hasInterrupt ? segmentMetrics(interruptRows) : null,
    completionHalf:
      completionRows.length > 0 ? segmentMetrics(completionRows) : null,
    wholeWafer: computeJbYieldMetrics(rows),
  };
}

export function buildSlotYieldSummary(
  rows: Record<string, unknown>[]
): SlotYieldSummaryEntry[] {
  const bySlot = new Map<number, Record<string, unknown>[]>();
  for (const row of rows) {
    const slot = Number(row.SLOT ?? row.slot);
    if (!Number.isFinite(slot) || slot <= 0) continue;
    if (!bySlot.has(slot)) bySlot.set(slot, []);
    bySlot.get(slot)!.push(row);
  }
  const out: SlotYieldSummaryEntry[] = [];
  for (const slot of [...bySlot.keys()].sort((a, b) => a - b)) {
    const slotRows = bySlot.get(slot)!;
    const b = computeJbYieldBreakdown(slotRows);
    const entry: SlotYieldSummaryEntry = {
      slot,
      grossDie: b.wholeWafer.grossDie,
      badDie: b.wholeWafer.badDie,
      goodDie: b.wholeWafer.goodDie,
      yieldPct: b.wholeWafer.yieldPct,
      hasInterrupt: b.hasInterrupt,
      rowCount: slotRows.length,
    };
    if (b.hasInterrupt && b.interruptHalf) {
      entry.interruptHalf = b.interruptHalf;
    }
    if (b.hasInterrupt && b.completionHalf) {
      entry.completionHalf = b.completionHalf;
    }
    out.push(entry);
  }
  return out;
}

export function slotYieldSummaryFieldGuide(): string {
  return SLOT_YIELD_GUIDE;
}
