// pcr-ai-api/src/lib/agent/agentJbBinFormat.ts
/** Agent 工具回传：与 aggregate_jb_bins 的 bin/count 语义对齐，避免 n/value 被模型对调。 */

import {
  buildSlotYieldSummary,
  slotYieldSummaryFieldGuide,
  type SlotYieldSummaryEntry,
} from "../jbYieldCalc.js";

export type AgentJbBinEntry = {
  bin: number;
  dieCount: number;
  isGoodBin: boolean;
};

export type SlotBadBinsCompactEntry = {
  slot: number;
  badBins: AgentJbBinEntry[];
};

const BIN_SCHEMA_HINT =
  "每条: bin=BINDie编号(通常较小), dieCount=该BIN的die颗数(可很大); 禁止写成 BIN{dieCount} {bin}颗";

const SLOT_BAD_BINS_COMPACT_GUIDE =
  "slotBadBinsCompact：按 slot 升序，每 slot 汇总全部匹配行的 badBins（同 bin 跨 INTERRUPT/续测行 dieCount 相加）。问「每片 BIN7 颗数」时读此字段，勿依赖 rows。";

export function normalizeBinsForAgent(bins: unknown): AgentJbBinEntry[] {
  if (!Array.isArray(bins)) return [];
  const out: AgentJbBinEntry[] = [];
  for (const item of bins) {
    if (item == null || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const binRaw = row["bin"] ?? row["n"] ?? row["binNumber"];
    const countRaw = row["dieCount"] ?? row["count"] ?? row["value"];
    const bin = Number(binRaw);
    const dieCount = Number(countRaw);
    if (!Number.isFinite(bin) || !Number.isFinite(dieCount)) continue;
    out.push({
      bin,
      dieCount,
      isGoodBin: Boolean(row["isGoodBin"] ?? row["isGood"]),
    });
  }
  out.sort((a, b) => a.bin - b.bin);
  return out;
}

/** 按 slot 汇总坏 bin（紧凑，供 Agent 枚举 1–N 片某 BIN 颗数，避免 rows 被截断）。 */
export function buildSlotBadBinsCompact(
  rows: Record<string, unknown>[]
): SlotBadBinsCompactEntry[] {
  const bySlot = new Map<number, Map<number, number>>();
  for (const row of rows) {
    const slot = Number(row["SLOT"] ?? row["slot"]);
    if (!Number.isFinite(slot) || slot <= 0) continue;
    if (!bySlot.has(slot)) bySlot.set(slot, new Map());
    const binMap = bySlot.get(slot)!;
    const all = normalizeBinsForAgent(row["bins"]);
    for (const { bin, dieCount, isGoodBin } of all) {
      if (isGoodBin) continue;
      binMap.set(bin, (binMap.get(bin) ?? 0) + dieCount);
    }
  }
  const out: SlotBadBinsCompactEntry[] = [];
  for (const slot of [...bySlot.keys()].sort((a, b) => a - b)) {
    const binMap = bySlot.get(slot)!;
    const badBins: AgentJbBinEntry[] = [...binMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([bin, dieCount]) => ({ bin, dieCount, isGoodBin: false }));
    out.push({ slot, badBins });
  }
  return out;
}

/** 将 query_jb_bins 行内的 bins[] 改为 badBins / goodBins（bin + dieCount）。 */
export function formatJbRowsForAgent(
  rows: Record<string, unknown>[]
): Record<string, unknown>[] {
  return rows.map((row) => {
    const { bins: _bins, ...rest } = row;
    const all = normalizeBinsForAgent(_bins);
    const badBins = all.filter((b) => !b.isGoodBin);
    const goodBins = all.filter((b) => b.isGoodBin);
    return { ...rest, badBins, goodBins } as Record<string, unknown>;
  });
}

export function wrapJbQueryResultForAgent(
  rows: Record<string, unknown>[]
): Record<string, unknown> {
  const slotSet = new Set<number>();
  for (const r of rows) {
    const v = r["SLOT"] ?? r["slot"];
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) slotSet.add(n);
  }
  const distinctSlots = [...slotSet].sort((a, b) => a - b);
  const slotYieldSummary = buildSlotYieldSummary(rows);
  const slotBadBinsCompact = buildSlotBadBinsCompact(rows);
  return {
    _binFieldGuide: BIN_SCHEMA_HINT,
    _slotYieldGuide: slotYieldSummaryFieldGuide(),
    _slotBadBinsCompactGuide: SLOT_BAD_BINS_COMPACT_GUIDE,
    count: rows.length,
    distinctSlots,
    slotYieldSummary,
    slotBadBinsCompact,
    rows: formatJbRowsForAgent(rows),
  };
}

function trySerialize(obj: unknown): string | null {
  try {
    return JSON.stringify(obj);
  } catch {
    return null;
  }
}

function fitsLimit(obj: unknown, maxChars: number): string | null {
  const s = trySerialize(obj);
  if (s && s.length <= maxChars) return s;
  return null;
}

/** slot → { bin号字符串: dieCount }，比 slotBadBinsCompact 更省 token。 */
export function buildBinBySlotMap(
  compact: SlotBadBinsCompactEntry[]
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const { slot, badBins } of compact) {
    const m: Record<string, number> = {};
    for (const { bin, dieCount } of badBins) {
      if (dieCount > 0) m[String(bin)] = dieCount;
    }
    out[String(slot)] = m;
  }
  return out;
}

function minimalSlotYieldSummary(
  entries: SlotYieldSummaryEntry[]
): Array<{
  slot: number;
  grossDie: number;
  badDie: number;
  yieldPct: number | null;
  hasInterrupt: boolean;
}> {
  return entries.map((e) => ({
    slot: e.slot,
    grossDie: e.grossDie,
    badDie: e.badDie,
    yieldPct: e.yieldPct,
    hasInterrupt: e.hasInterrupt,
  }));
}

/** 超限时省略 rows，保留 slotBadBinsCompact / slotYieldSummary 等摘要。 */
export function serializeJbQueryResultForAgent(
  wrapped: Record<string, unknown>,
  maxChars: number
): string {
  const full = fitsLimit(wrapped, maxChars);
  if (full) return full;

  const rows = wrapped["rows"];
  const rowCount = Array.isArray(rows) ? rows.length : Number(wrapped["count"] ?? 0);
  const compact = wrapped["slotBadBinsCompact"] as SlotBadBinsCompactEntry[] | undefined;
  const yieldSummary = wrapped["slotYieldSummary"] as SlotYieldSummaryEntry[] | undefined;

  const withoutRows: Record<string, unknown> = { ...wrapped };
  delete withoutRows["rows"];
  withoutRows["rowsOmitted"] = true;
  withoutRows["rowCount"] = rowCount;
  withoutRows["_rowsNote"] =
    "明细 rows 已省略以控制体积；请用 slotBadBinsCompact、binBySlot、slotYieldSummary、distinctSlots";

  const slim = fitsLimit(withoutRows, maxChars);
  if (slim) return slim;

  const ultra: Record<string, unknown> = {
    _binFieldGuide: wrapped["_binFieldGuide"],
    _slotBadBinsCompactGuide: wrapped["_slotBadBinsCompactGuide"],
    _rowsNote: withoutRows["_rowsNote"],
    rowsOmitted: true,
    rowCount,
    count: wrapped["count"],
    distinctSlots: wrapped["distinctSlots"],
    binBySlot: compact ? buildBinBySlotMap(compact) : {},
    slotYieldSummary: yieldSummary
      ? minimalSlotYieldSummary(yieldSummary)
      : [],
  };
  const ultraJson = fitsLimit(ultra, maxChars);
  if (ultraJson) return ultraJson;

  const s = trySerialize(ultra);
  return s ?? "(结果序列化失败)";
}
