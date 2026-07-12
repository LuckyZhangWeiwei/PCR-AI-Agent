/**
 * JB STAR 良率：与报表 `infGoodBins` 一致。
 * - 无中断：同 slot 多行在 MAX(GROSSDIE) 满片行上累加坏 die。
 * - 有中断/续测分段（同 slot、同 passId）：见 splitSlotIntoHalves — INTERRUPT 行，或 PASSNUM 递增，或同 PASSNUM 多行按 TESTEND 最早/最晚拆前后半。
 *   - `interruptHalf` / `completionHalf` 始终分别计算并输出（上半段 yield 可为 0%）。
 *   - 整片正片（顶层 grossDie/yieldPct）：上半段 good=0 → 仅下半段；上半段 good>0 → 上下半段合并。
 */

import { parsePassBinHyphenGoodBins } from "../passBinSemantics.js";

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

function binsArrayFromJbRow(row: Record<string, unknown>): BinCell[] {
  const bins = row.bins;
  if (Array.isArray(bins)) {
    return bins.filter(
      (cell) => cell != null && typeof cell === "object"
    ) as BinCell[];
  }
  if (bins != null && typeof bins === "object") {
    const out: BinCell[] = [];
    for (const [key, cell] of Object.entries(bins as Record<string, unknown>)) {
      if (cell == null || typeof cell !== "object") continue;
      const n = Number(key);
      if (!Number.isInteger(n) || n < 0 || n > 255) continue;
      const c = cell as BinCell & { isGood?: boolean };
      out.push({
        n,
        value: c.value ?? c.dieCount,
        dieCount: c.dieCount ?? c.value,
        isGoodBin: c.isGoodBin ?? c.isGood,
        isGood: c.isGood ?? c.isGoodBin,
      });
    }
    return out;
  }
  return [];
}

/** 单行良品 bin 下标（BIN1 + PASSBIN 段 + bins[].isGoodBin）。 */
export function goodBinIndicesForJbRow(row: Record<string, unknown>): Set<number> {
  const good = new Set<number>();
  addGoodIndex(good, JB_HARD_GOOD_BIN);
  const passBin =
    row.PASSBIN ?? row.passbin ?? row.PassBin ?? row.PASS_BIN;
  for (const n of parsePassBinHyphenGoodBins(passBin)) good.add(n);

  for (const cell of binsArrayFromJbRow(row)) {
    const c = cell as BinCell;
    const n = Number(c.n ?? (c as { bin?: number }).bin);
    if (!Number.isInteger(n) || n < 0 || n > 255) continue;
    if (c.isGoodBin === true || c.isGood === true) good.add(n);
  }
  // Agent 格式化行（formatJbRowsForAgent）：bins[] 已拆成 goodBins / badBins
  const agentGood = row.goodBins ?? row.goodbins;
  if (Array.isArray(agentGood)) {
    for (const cell of agentGood) {
      if (cell == null || typeof cell !== "object") continue;
      const c = cell as { bin?: number; n?: number };
      const n = Number(c.bin ?? c.n);
      if (Number.isInteger(n) && n >= 0 && n <= 255) good.add(n);
    }
  }
  return good;
}

/** 单行坏 die 合计（仅非良品 bin 列）。 */
export function badDieFromJbRow(row: Record<string, unknown>): number {
  const good = goodBinIndicesForJbRow(row);
  let total = 0;
  const bins = binsArrayFromJbRow(row);
  if (!bins.length) return 0;
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

/** 中断后仅复测失败 die 的小 pass；不参与前后半分段良率。 */
export function isRetestBinPasstype(row: Record<string, unknown>): boolean {
  return (
    String(row.PASSTYPE ?? row.passtype ?? "").trim().toUpperCase() === "RETESTBIN"
  );
}

function testEndMs(row: Record<string, unknown>): number {
  const raw = row.TESTEND ?? row.testEnd ?? row.testend;
  if (raw == null || raw === "") return 0;
  const t = new Date(String(raw)).getTime();
  return Number.isFinite(t) ? t : 0;
}

export function passIdFromJbRow(row: Record<string, unknown>): number {
  const v = Number(row.PASSID ?? row.passId ?? 0);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

export function passNumFromJbRow(row: Record<string, unknown>): number {
  const v = Number(row.PASSNUM ?? row.passNum ?? 0);
  return Number.isFinite(v) && v > 0 ? Math.round(v) : 1;
}

export function lotFromJbRow(row: Record<string, unknown>): string {
  return String(row.LOT ?? row.lot ?? "").trim();
}

/** 多行合计指定坏 bin 的 dieCount（含 INTERRUPT/续测各行）。 */
export function sumBadBinDieOnRows(
  rows: Record<string, unknown>[],
  bin: number
): number {
  let total = 0;
  for (const row of rows) {
    const good = goodBinIndicesForJbRow(row);
    for (const cell of binsArrayFromJbRow(row)) {
      if (cell == null || typeof cell !== "object") continue;
      const c = cell as BinCell;
      const n = Number(c.n ?? (c as { bin?: number }).bin);
      const v = Number(c.value ?? c.dieCount ?? 0);
      if (!Number.isFinite(n) || n !== bin || !Number.isFinite(v) || v <= 0)
        continue;
      if (good.has(n)) continue;
      total += v;
    }
  }
  return total;
}

export type BinDieByHalves = {
  total: number;
  firstHalf: number;
  secondHalf: number;
  segmented: boolean;
};

/** 同 (slot,passId) 组：前半/后半/合计坏 bin dieCount。 */
export function binDieByHalvesForGroup(
  groupRows: Record<string, unknown>[],
  bin: number
): BinDieByHalves {
  const split = splitPassGroupIntoHalves(groupRows);
  if (!split.segmented) {
    const total = sumBadBinDieOnRows(groupRows, bin);
    return { total, firstHalf: 0, secondHalf: 0, segmented: false };
  }
  const firstHalf = sumBadBinDieOnRows(split.firstHalfRows, bin);
  const secondHalf = sumBadBinDieOnRows(split.secondHalfRows, bin);
  return {
    total: firstHalf + secondHalf,
    firstHalf,
    secondHalf,
    segmented: true,
  };
}

/**
 * 同 (slot, passId) 组内的测试中断次数（非「前半/后半」段数；多段续测可 >2）。
 * - 有 PASSTYPE=INTERRUPT 行：计 INTERRUPT 行数。
 * - 否则 PASSNUM 递增：max(PASSNUM)−min(PASSNUM)。
 * - 否则同 PASSNUM 多行 TEST（按 TESTEND 续测）：TEST 行数−1。
 */
export function countTestInterruptEvents(
  group: Record<string, unknown>[]
): number {
  if (group.length < 2) return 0;

  const interruptRows = group.filter(isInterruptPasstype);
  if (interruptRows.length > 0) {
    return interruptRows.length;
  }

  const passNums = group.map(passNumFromJbRow);
  const minPn = Math.min(...passNums);
  const maxPn = Math.max(...passNums);
  if (maxPn > minPn) {
    return maxPn - minPn;
  }

  const testRows = group.filter((r) => !isInterruptPasstype(r));
  if (testRows.length >= 2) {
    return testRows.length - 1;
  }

  return 0;
}

/** 同 (slot, passId) 下是否应拆前后半（与 agentPrompt / HANDOFF 一致）。 */
export function splitPassGroupIntoHalves(
  group: Record<string, unknown>[]
): {
  segmented: boolean;
  firstHalfRows: Record<string, unknown>[];
  secondHalfRows: Record<string, unknown>[];
} {
  const interruptRows = group.filter(isInterruptPasstype);
  if (interruptRows.length > 0) {
    return {
      segmented: true,
      firstHalfRows: interruptRows,
      secondHalfRows: group.filter((r) => !isInterruptPasstype(r)),
    };
  }

  if (group.length < 2) {
    return { segmented: false, firstHalfRows: [], secondHalfRows: [] };
  }

  const retestRows = group.filter(isRetestBinPasstype);
  const testRows = group.filter(
    (r) => !isInterruptPasstype(r) && !isRetestBinPasstype(r)
  );
  // 单次 TEST + RETESTBIN：正片良率取满片 TEST 行（MAX GROSSDIE），RETESTBIN 仅复测失败 die。
  if (
    retestRows.length > 0 &&
    testRows.length === 1 &&
    retestRows.length + testRows.length === group.length
  ) {
    return { segmented: false, firstHalfRows: [], secondHalfRows: [] };
  }

  const passNums = group
    .filter((r) => !isRetestBinPasstype(r))
    .map(passNumFromJbRow);
  const minPn = Math.min(...passNums);
  const maxPn = Math.max(...passNums);

  if (maxPn > minPn) {
    return {
      segmented: true,
      firstHalfRows: group.filter(
        (r) => !isRetestBinPasstype(r) && passNumFromJbRow(r) === minPn
      ),
      secondHalfRows: group.filter(
        (r) => !isRetestBinPasstype(r) && passNumFromJbRow(r) > minPn
      ),
    };
  }

  const sorted = [...group]
    .filter((r) => !isRetestBinPasstype(r))
    .sort((a, b) => testEndMs(a) - testEndMs(b));
  if (sorted.length < 2) {
    return { segmented: false, firstHalfRows: [], secondHalfRows: [] };
  }
  return {
    segmented: true,
    firstHalfRows: [sorted[0]!],
    secondHalfRows: sorted.slice(1),
  };
}

/**
 * 同 slot 拆前后半：先按 passId 分组，取第一个发生续测/中断的 pass 组（passId 升序）。
 */
export function splitSlotIntoHalves(rows: Record<string, unknown>[]): {
  segmented: boolean;
  firstHalfRows: Record<string, unknown>[];
  secondHalfRows: Record<string, unknown>[];
} {
  const byPassId = new Map<number, Record<string, unknown>[]>();
  for (const row of rows) {
    const pid = passIdFromJbRow(row);
    if (!byPassId.has(pid)) byPassId.set(pid, []);
    byPassId.get(pid)!.push(row);
  }

  for (const pid of [...byPassId.keys()].sort((a, b) => a - b)) {
    const split = splitPassGroupIntoHalves(byPassId.get(pid)!);
    if (split.segmented) {
      return split;
    }
  }

  return { segmented: false, firstHalfRows: [], secondHalfRows: [] };
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

const SLOT_YIELD_GUIDE =
  "slotYieldSummary：每条=一片 wafer 的一个测试层 (lot, slot, passId)；禁止跨 lot 合并同 slot。testInterruptCount=中断次数；有中断时读 interruptSegments（多次中断逐段：中断1…中断N→续测→整片合并）或 slotYieldInterruptMarkdown，禁止把 2 段当成 2 次。JSON 仍含 interruptHalf/completionHalf 摘要。查 BIN 见 badBinSlotTrends。";

const TEST_INTERRUPT_COUNT_GUIDE =
  "testInterruptCountMarkdown / slotYieldSummary[].testInterruptCount：各 wafer×pass 的中断次数；用户问「中断几次」必须读本表数字，禁止用前半/后半两段推断次数。";

const LOT_YIELD_RANK_GUIDE =
  "lotYieldRankByTestEnd：按 lot 汇总良率（该 lot 内所有 slot×passId 的 yieldPct 最小值=lot 代表良率，与报表 LOT Yield% 一致）。按 TESTEND 降序；用户要「良率最差 top N」时按 yieldPct 升序重排。";

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
