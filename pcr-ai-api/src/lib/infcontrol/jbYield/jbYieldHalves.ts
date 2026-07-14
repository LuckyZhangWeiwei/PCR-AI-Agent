/**
 * JB STAR 良率：中断/续测分段（前半/后半）拆分逻辑。
 * 见 splitSlotIntoHalves — INTERRUPT 行，或 PASSNUM 递增，或同 PASSNUM 多行按 TESTEND 最早/最晚拆前后半。
 */

import {
  isInterruptPasstype,
  isRetestBinPasstype,
  passIdFromJbRow,
  passNumFromJbRow,
  sumBadBinDieOnRows,
  testEndMs,
} from "./jbYieldRowHelpers.js";

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
