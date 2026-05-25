/**
 * JB STAR 良率：与报表 `infGoodBins` / Agent prompt 一致。
 * - 同一 slot 多行（多 pass / passNum / INTERRUPT+TEST）时 **GROSSDIE 取 MAX**，不累加。
 * - 坏 die 按行累加；良品 = BIN1 + PASSBIN `-` 分段 + bins[].isGoodBin。
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

export type JbYieldMetrics = {
  grossDie: number;
  badDie: number;
  goodDie: number;
  yieldPct: number | null;
};

/**
 * 多行（同 slot 的全部层测 / passNum 行）良率。
 * - **GROSSDIE** 取组内 **MAX**（完整片数，如 4848），不对多行求和。
 * - **坏 die** 仅在 **GROSSDIE 等于该 MAX** 的行上累加（同一完整片上的多 pass / passNum）；
 *   较低 GROSSDIE 的 INTERRUPT 行（如 4732）不计入，避免把中断片当最终良率。
 */
export function computeJbYieldMetrics(
  rows: Record<string, unknown>[]
): JbYieldMetrics {
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
  const goodDie = Math.max(0, grossDie - badDie);
  const yieldPct = (goodDie / grossDie) * 100;
  return { grossDie, badDie, goodDie, yieldPct };
}

export type SlotYieldSummaryEntry = {
  slot: number;
  grossDie: number;
  badDie: number;
  goodDie: number;
  yieldPct: number | null;
  /** 组内是否含 INTERRUPT 行 */
  hasInterrupt: boolean;
  /** 参与汇总的明细行数 */
  rowCount: number;
};

const SLOT_YIELD_GUIDE =
  "slotYieldSummary 按 SLOT 汇总：grossDie=MAX(GROSSDIE)；badDie=仅 GROSSDIE 等于该 max 的各行坏 bin 之和（同片完整测试上的多 passNum）；较低 GROSSDIE 的 INTERRUPT 行不计入。勿对 GROSSDIE 求和。列表 limit 截断会导致缺行、良率偏低。";

/** 按 slot 升序汇总良率（用于 lot 级 wafer 列表）。 */
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
    const m = computeJbYieldMetrics(slotRows);
    const hasInterrupt = slotRows.some(
      (r) => String(r.PASSTYPE ?? r.passtype ?? "").trim().toUpperCase() === "INTERRUPT"
    );
    out.push({
      slot,
      grossDie: m.grossDie,
      badDie: m.badDie,
      goodDie: m.goodDie,
      yieldPct: m.yieldPct,
      hasInterrupt,
      rowCount: slotRows.length,
    });
  }
  return out;
}

export function slotYieldSummaryFieldGuide(): string {
  return SLOT_YIELD_GUIDE;
}
