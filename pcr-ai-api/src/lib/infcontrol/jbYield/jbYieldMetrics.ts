/**
 * JB STAR 良率：单 slot/pass 组的良率指标计算与整片 slot 汇总。
 * - 无中断：同 slot 多行在 MAX(GROSSDIE) 满片行上累加坏 die。
 * - 有中断/续测分段（同 slot、同 passId）：`interruptHalf` / `completionHalf` 始终分别计算并输出
 *   （上半段 yield 可为 0%）。整片正片（顶层 grossDie/yieldPct）：上半段 good=0 → 仅下半段；
 *   上半段 good>0 → 上下半段合并。
 */

import {
  badDieFromJbRow,
  isInterruptPasstype,
  lotFromJbRow,
  passIdFromJbRow,
  passNumFromJbRow,
  testEndMs,
} from "./jbYieldRowHelpers.js";
import {
  countTestInterruptEvents,
  splitPassGroupIntoHalves,
  splitSlotIntoHalves,
} from "./jbYieldHalves.js";

function grossDieFromRow(row: Record<string, unknown>): number {
  const g = Number(row.GROSSDIE ?? row.grossDie ?? 0);
  return Number.isFinite(g) && g > 0 ? g : 0;
}

function metricsFromTotals(grossDie: number, badDie: number): JbYieldMetrics {
  const goodDie = Math.max(0, grossDie - badDie);
  const yieldPct = grossDie > 0 ? (goodDie / grossDie) * 100 : null;
  return { grossDie, badDie, goodDie, yieldPct };
}

function computeSegmentedWholeWafer(
  firstHalf: JbYieldMetrics,
  secondHalf: JbYieldMetrics
): JbYieldMetrics {
  if (firstHalf.goodDie === 0) {
    return secondHalf;
  }
  const grossDie = firstHalf.grossDie + secondHalf.grossDie;
  const goodDie = firstHalf.goodDie + secondHalf.goodDie;
  const badDie = grossDie - goodDie;
  const yieldPct = grossDie > 0 ? (goodDie / grossDie) * 100 : null;
  return { grossDie, badDie, goodDie, yieldPct };
}

export type JbYieldMetrics = {
  grossDie: number;
  badDie: number;
  goodDie: number;
  yieldPct: number | null;
};

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

  const split = splitSlotIntoHalves(rows);
  if (!split.segmented) {
    return computeNoInterruptYield(rows);
  }

  const firstHalf = segmentMetrics(split.firstHalfRows);
  if (!split.secondHalfRows.length) {
    return firstHalf;
  }
  const secondHalf = segmentMetrics(split.secondHalfRows);
  return computeSegmentedWholeWafer(firstHalf, secondHalf);
}

/** 单次中断/续测段良率（多次中断时逐段列出，最后含整片合并）。 */
export type YieldInterruptSegment = {
  label: string;
  metrics: JbYieldMetrics;
};

export type SlotYieldSummaryEntry = {
  /** 批次；多 lot 行集时与 slot 共同唯一标识一片 wafer */
  lot?: string;
  slot: number;
  /** PASSID：sort1→1，sort2→3，sort3→5 */
  passId: number;
  /** 整片正片良率（用于结论主数字） */
  grossDie: number;
  badDie: number;
  goodDie: number;
  yieldPct: number | null;
  hasInterrupt: boolean;
  /** 该 (slot,passId) 测试中断次数；勿把良率表段数当成次数 */
  testInterruptCount: number;
  rowCount: number;
  /** 前半段（INTERRUPT 或较早续测 TEST），hasInterrupt 时必有；多次中断时仅为首段摘要 */
  interruptHalf?: JbYieldMetrics;
  /** 后半段（续测完成），hasInterrupt 且存在完成段时必有 */
  completionHalf?: JbYieldMetrics;
  /** 多次中断/多 passNum/多续测行：逐段 + 整片合并（展示用，优先于仅前半/后半） */
  interruptSegments?: YieldInterruptSegment[];
};

function sortGroupRowsByTime(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return [...rows].sort((a, b) => {
    const d = testEndMs(a) - testEndMs(b);
    if (d !== 0) return d;
    return passNumFromJbRow(a) - passNumFromJbRow(b);
  });
}

/**
 * 同 (slot,passId) 有序段：多行 INTERRUPT → 中断1…N；否则前半→后半→整片（同 PASSNUM 多行续测也合并为前后半，禁止逐行续测段）。
 */
export function buildYieldInterruptSegments(
  group: Record<string, unknown>[]
): YieldInterruptSegment[] | undefined {
  if (group.length < 2) return undefined;
  const sorted = sortGroupRowsByTime(group);
  const whole = computeJbYieldMetrics(group);
  const interruptRows = sorted.filter(isInterruptPasstype);

  if (interruptRows.length >= 2) {
    const segs: YieldInterruptSegment[] = interruptRows.map((row, i) => ({
      label: `中断${i + 1}`,
      metrics: segmentMetrics([row]),
    }));
    const testRows = sorted.filter((r) => !isInterruptPasstype(r));
    if (testRows.length) {
      segs.push({ label: "续测完成", metrics: segmentMetrics(testRows) });
    }
    segs.push({ label: "整片正片（合并）", metrics: whole });
    return segs;
  }

  const split = splitPassGroupIntoHalves(group);
  if (!split.segmented) return undefined;
  const segs: YieldInterruptSegment[] = [
    { label: "前半段", metrics: segmentMetrics(split.firstHalfRows) },
  ];
  if (split.secondHalfRows.length) {
    segs.push({ label: "后半段", metrics: segmentMetrics(split.secondHalfRows) });
  }
  segs.push({ label: "整片正片（合并）", metrics: whole });
  return segs;
}

/** 拆出前半/后半；整片正片走 computeJbYieldMetrics。 */
export function computeJbYieldBreakdown(rows: Record<string, unknown>[]): {
  hasInterrupt: boolean;
  interruptHalf: JbYieldMetrics | null;
  completionHalf: JbYieldMetrics | null;
  wholeWafer: JbYieldMetrics;
} {
  const split = splitSlotIntoHalves(rows);
  return {
    hasInterrupt: split.segmented,
    interruptHalf: split.segmented
      ? segmentMetrics(split.firstHalfRows)
      : null,
    completionHalf:
      split.segmented && split.secondHalfRows.length > 0
        ? segmentMetrics(split.secondHalfRows)
        : null,
    wholeWafer: computeJbYieldMetrics(rows),
  };
}

function slotPassGroupKey(
  lot: string,
  slot: number,
  passId: number
): string {
  return `${lot}\0${slot}\0${passId}`;
}

/** 良率汇总用行：排除 Current 层（PASSID≥99 / LAYERNAME=Current / PASSTYPE=NA）。 */
export function yieldSummaryEligibleRow(
  row: Record<string, unknown>
): boolean {
  const passId = passIdFromJbRow(row);
  if (passId >= 99) return false;
  const passtype = String(row.PASSTYPE ?? row.passtype ?? "")
    .trim()
    .toUpperCase();
  if (passtype === "NA") return false;
  const layer = String(row.LAYERNAME ?? row.layerName ?? "")
    .trim()
    .toUpperCase();
  if (layer === "CURRENT") return false;
  return true;
}

export function buildSlotYieldSummary(
  rows: Record<string, unknown>[]
): SlotYieldSummaryEntry[] {
  const eligible = rows.filter(yieldSummaryEligibleRow);
  const bySlotPass = new Map<string, Record<string, unknown>[]>();
  for (const row of eligible) {
    const slot = Number(row.SLOT ?? row.slot);
    if (!Number.isFinite(slot) || slot <= 0) continue;
    const passId = passIdFromJbRow(row);
    const lot = lotFromJbRow(row);
    const key = slotPassGroupKey(lot, slot, passId);
    if (!bySlotPass.has(key)) bySlotPass.set(key, []);
    bySlotPass.get(key)!.push(row);
  }
  const out: SlotYieldSummaryEntry[] = [];
  for (const key of [...bySlotPass.keys()].sort((a, b) => {
    const [lotA, s1, p1] = a.split("\0");
    const [lotB, s2, p2] = b.split("\0");
    const lotCmp = lotA.localeCompare(lotB);
    if (lotCmp !== 0) return lotCmp;
    return Number(s1) - Number(s2) || Number(p1) - Number(p2);
  })) {
    const [lot, slotStr, passStr] = key.split("\0");
    const slot = Number(slotStr);
    const passId = Number(passStr);
    const groupRows = bySlotPass.get(key)!;
    const b = computeJbYieldBreakdown(groupRows);
    const testInterruptCount = b.hasInterrupt ? countTestInterruptEvents(groupRows) : 0;
    const entry: SlotYieldSummaryEntry = {
      ...(lot ? { lot } : {}),
      slot,
      passId,
      grossDie: b.wholeWafer.grossDie,
      badDie: b.wholeWafer.badDie,
      goodDie: b.wholeWafer.goodDie,
      yieldPct: b.wholeWafer.yieldPct,
      hasInterrupt: b.hasInterrupt,
      testInterruptCount,
      rowCount: groupRows.length,
    };
    if (b.hasInterrupt && b.interruptHalf) {
      entry.interruptHalf = b.interruptHalf;
    }
    if (b.hasInterrupt && b.completionHalf) {
      entry.completionHalf = b.completionHalf;
    }
    if (b.hasInterrupt) {
      const segments = buildYieldInterruptSegments(groupRows);
      if (segments?.length) entry.interruptSegments = segments;
    }
    out.push(entry);
  }
  return out;
}
