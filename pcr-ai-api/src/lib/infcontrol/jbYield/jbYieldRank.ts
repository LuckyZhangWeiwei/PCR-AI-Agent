/**
 * JB STAR 良率：按 lot 汇总排名、字段说明文案、passId 显示标签。
 */

import { testEndMs } from "./jbYieldRowHelpers.js";
import { buildSlotYieldSummary } from "./jbYieldMetrics.js";

const SLOT_YIELD_GUIDE =
  "slotYieldSummary：每条=一片 wafer 的一个测试层 (lot, slot, passId)；禁止跨 lot 合并同 slot。testInterruptCount=中断次数；有中断时读 interruptSegments（多次中断逐段：中断1…中断N→续测→整片合并）或 slotYieldInterruptMarkdown，禁止把 2 段当成 2 次。JSON 仍含 interruptHalf/completionHalf 摘要。查 BIN 见 badBinSlotTrends。";

const TEST_INTERRUPT_COUNT_GUIDE =
  "testInterruptCountMarkdown / slotYieldSummary[].testInterruptCount：各 wafer×pass 的中断次数；用户问「中断几次」必须读本表数字，禁止用前半/后半两段推断次数。";

const LOT_YIELD_RANK_GUIDE =
  "lotYieldRankByTestEnd：按 lot 汇总良率（该 lot 内所有 slot×passId 的 yieldPct 最小值=lot 代表良率，与报表 LOT Yield% 一致）。按 TESTEND 降序；用户要「良率最差 top N」时按 yieldPct 升序重排。";

export type LotYieldRankEntry = {
  lot: string;
  device: string;
  /** 该 lot 内最差 (slot, passId) 良率 — 与报表 LOT Yield% 排名口径一致 */
  yieldPct: number | null;
  worstSlot: number | null;
  worstPassId: number | null;
  slotPassCount: number;
  testEnd: string | null;
};

/** 按 lot 汇总良率，默认按 TESTEND 降序（最近 lot 在前）。 */
export function buildLotYieldRank(
  rows: Record<string, unknown>[],
  topN = 20
): LotYieldRankEntry[] {
  const byLot = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const lot = String(row.LOT ?? row.lot ?? "").trim();
    if (!lot) continue;
    if (!byLot.has(lot)) byLot.set(lot, []);
    byLot.get(lot)!.push(row);
  }

  const out: LotYieldRankEntry[] = [];
  for (const [lot, lotRows] of byLot.entries()) {
    const slotPassYields: Array<{
      slot: number;
      passId: number;
      yieldPct: number;
    }> = [];
    for (const entry of buildSlotYieldSummary(lotRows)) {
      if (entry.yieldPct === null) continue;
      slotPassYields.push({
        slot: entry.slot,
        passId: entry.passId,
        yieldPct: entry.yieldPct,
      });
    }
    const device = String(
      lotRows[0]?.DEVICE ?? lotRows[0]?.device ?? ""
    ).trim();
    let testEnd: string | null = null;
    let maxTestEndMs = 0;
    for (const row of lotRows) {
      const raw = row.TESTEND ?? row.testEnd ?? row.testend;
      if (raw == null || raw === "") continue;
      const ms = testEndMs(row);
      if (ms >= maxTestEndMs) {
        maxTestEndMs = ms;
        testEnd = String(raw);
      }
    }

    if (slotPassYields.length === 0) {
      out.push({
        lot,
        device,
        yieldPct: null,
        worstSlot: null,
        worstPassId: null,
        slotPassCount: 0,
        testEnd,
      });
      continue;
    }
    const worst = slotPassYields.reduce((a, b) =>
      b.yieldPct < a.yieldPct ? b : a
    );
    out.push({
      lot,
      device,
      yieldPct: worst.yieldPct,
      worstSlot: worst.slot,
      worstPassId: worst.passId,
      slotPassCount: slotPassYields.length,
      testEnd,
    });
  }

  out.sort((a, b) => {
    const ta = a.testEnd ? new Date(a.testEnd).getTime() : 0;
    const tb = b.testEnd ? new Date(b.testEnd).getTime() : 0;
    return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
  });
  return out.slice(0, topN);
}

export function slotYieldSummaryFieldGuide(): string {
  return SLOT_YIELD_GUIDE;
}

export function testInterruptCountFieldGuide(): string {
  return TEST_INTERRUPT_COUNT_GUIDE;
}

export function lotYieldRankFieldGuide(): string {
  return LOT_YIELD_RANK_GUIDE;
}

/** 服务端 markdown / 表头用 pass1|pass3|pass5（不含常温/高温/低温字样）。 */
export function passIdSortLabel(passId: number): string {
  if (passId === 1) return "pass1";
  if (passId === 3) return "pass3";
  if (passId === 5) return "pass5";
  if (passId === 0) return "pass未知";
  return `pass${passId}`;
}
