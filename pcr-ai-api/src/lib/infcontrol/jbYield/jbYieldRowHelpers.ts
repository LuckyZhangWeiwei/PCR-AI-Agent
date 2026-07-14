/**
 * JB STAR 良率：单行/多行基础读取与坏 die 汇总辅助函数。
 * - `goodBinIndicesForJbRow` / `badDieFromJbRow`：与报表 `infGoodBins` 一致的良品 bin 判定。
 * - `isInterruptPasstype` / `isRetestBinPasstype` / `passIdFromJbRow` / `passNumFromJbRow` /
 *   `lotFromJbRow` / `testEndMs`：跨 jbYield/ 各文件共用的行字段读取。
 */

import { parsePassBinHyphenGoodBins } from "../../passBinSemantics.js";

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

/** 行的 TESTEND 时间戳（ms），无法解析时返回 0。跨 halves/metrics/rank 共用。 */
export function testEndMs(row: Record<string, unknown>): number {
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
