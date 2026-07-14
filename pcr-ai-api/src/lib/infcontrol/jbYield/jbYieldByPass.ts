/**
 * JB STAR 良率：按 passId 汇总、slot×pass 良率矩阵（pivot）、中断专表。
 */

import type { JbYieldMetrics, SlotYieldSummaryEntry, YieldInterruptSegment } from "./jbYieldMetrics.js";
import { buildSlotYieldSummary } from "./jbYieldMetrics.js";
import { passIdSortLabel } from "./jbYieldRank.js";

export type YieldByPassEntry = {
  passId: number;
  sortLabel: string;
  grossDie: number;
  goodDie: number;
  badDie: number;
  yieldPct: number | null;
  slotCount: number;
};

/** 按 passId 汇总当前行集（各 slot 该层良率之和），用于分 sort 批次良率。 */
export function buildYieldByPassId(
  rows: Record<string, unknown>[]
): YieldByPassEntry[] {
  const summary = buildSlotYieldSummary(rows);
  const byPass = new Map<
    number,
    { grossDie: number; goodDie: number; badDie: number; slots: Set<number> }
  >();
  for (const e of summary) {
    if (!byPass.has(e.passId)) {
      byPass.set(e.passId, {
        grossDie: 0,
        goodDie: 0,
        badDie: 0,
        slots: new Set(),
      });
    }
    const t = byPass.get(e.passId)!;
    t.grossDie += e.grossDie;
    t.goodDie += e.goodDie;
    t.badDie += e.badDie;
    t.slots.add(e.slot);
  }
  return [...byPass.keys()]
    .sort((a, b) => a - b)
    .map((passId) => {
      const t = byPass.get(passId)!;
      const yieldPct =
        t.grossDie > 0 ? (t.goodDie / t.grossDie) * 100 : null;
      return {
        passId,
        sortLabel: passIdSortLabel(passId),
        grossDie: t.grossDie,
        goodDie: t.goodDie,
        badDie: t.badDie,
        yieldPct,
        slotCount: t.slots.size,
      };
    });
}

export type SlotYieldPivotCell = {
  yieldPct: number | null;
  grossDie: number;
  badDie: number;
  goodDie: number;
};

export type SlotYieldPivot = {
  passIds: number[];
  passLabels: string[];
  slots: number[];
  cells: Record<string, SlotYieldPivotCell>;
};

export function buildSlotYieldPivot(
  summary: SlotYieldSummaryEntry[]
): SlotYieldPivot {
  const passIds = [...new Set(summary.map((e) => e.passId))].sort(
    (a, b) => a - b
  );
  const slots = [...new Set(summary.map((e) => e.slot))].sort((a, b) => a - b);
  const cells: Record<string, SlotYieldPivotCell> = {};
  for (const e of summary) {
    cells[`${e.slot}:${e.passId}`] = {
      yieldPct: e.yieldPct,
      grossDie: e.grossDie,
      badDie: e.badDie,
      goodDie: e.goodDie,
    };
  }
  return {
    passIds,
    passLabels: passIds.map(passIdSortLabel),
    slots,
    cells,
  };
}

const YIELD_BY_PASS_GUIDE =
  "yieldByPassId：按测试层(passId)汇总良率，每层一行；多 sort 时禁止把不同 pass 的 die 相加成一个总良率。";

const SLOT_YIELD_PIVOT_GUIDE =
  "slotYieldPivot：各 slot 在每一 pass 的良率矩阵；汇报各片良率时优先用 slotYieldPivotMarkdown 或按 pass 分列，禁止只列 25 行单层。";

export function yieldByPassFieldGuide(): string {
  return YIELD_BY_PASS_GUIDE;
}

export function slotYieldPivotFieldGuide(): string {
  return SLOT_YIELD_PIVOT_GUIDE;
}

/** 各片良率简表：有中断时展示首段 TEST（interruptHalf），整片合并见 interruptSegments。 */
export function slotPivotDisplayMetrics(
  entry: SlotYieldSummaryEntry
): JbYieldMetrics {
  if (entry.hasInterrupt && entry.interruptHalf) {
    return entry.interruptHalf;
  }
  return {
    grossDie: entry.grossDie,
    badDie: entry.badDie,
    goodDie: entry.goodDie,
    yieldPct: entry.yieldPct,
  };
}

const SLOT_YIELD_INTERRUPT_GUIDE =
  "slotYieldInterruptMarkdown：有中断时按 interruptSegments 逐段输出（多次中断：中断1…N→续测→整片合并；0%也写）。禁止仅报后半或把 2 段当成中断次数。";

export function slotYieldInterruptFieldGuide(): string {
  return SLOT_YIELD_INTERRUPT_GUIDE;
}

export type SlotYieldInterruptRow = {
  slot: number;
  passId: number;
  sortLabel: string;
  hasInterrupt: true;
  testInterruptCount: number;
  wholeWafer: JbYieldMetrics;
  interruptHalf: JbYieldMetrics;
  completionHalf?: JbYieldMetrics;
  interruptSegments?: YieldInterruptSegment[];
};

/** 仅 hasInterrupt:true 的 (slot, passId)，供 Agent 中断良率表。 */
export function buildSlotYieldInterruptRows(
  summary: SlotYieldSummaryEntry[]
): SlotYieldInterruptRow[] {
  const out: SlotYieldInterruptRow[] = [];
  for (const e of summary) {
    if (!e.hasInterrupt || !e.interruptHalf) continue;
    out.push({
      slot: e.slot,
      passId: e.passId,
      sortLabel: passIdSortLabel(e.passId),
      hasInterrupt: true,
      testInterruptCount: e.testInterruptCount,
      wholeWafer: {
        grossDie: e.grossDie,
        badDie: e.badDie,
        goodDie: e.goodDie,
        yieldPct: e.yieldPct,
      },
      interruptHalf: e.interruptHalf,
      completionHalf: e.completionHalf,
      interruptSegments: e.interruptSegments,
    });
  }
  return out.sort((a, b) => a.slot - b.slot || a.passId - b.passId);
}
