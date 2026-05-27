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

export type RecentLotByTestEndEntry = {
  lot: string;
  device: string;
  cardId: string;
  testEnd: string | null;
  testerId?: string;
};

export type LotBinPairCompareEntry = {
  lot: string;
  device: string;
  bin10: number;
  bin66: number;
  /** bin10 − bin66；正数表示 BIN10 更多 */
  diff: number;
  bin10GtBin66: boolean;
};

const BIN_SCHEMA_HINT =
  "每条: bin=BINDie编号(通常较小), dieCount=该BIN的die颗数(可很大); 禁止写成 BIN{dieCount} {bin}颗";

const SLOT_BAD_BINS_COMPACT_GUIDE =
  "slotBadBinsCompact：按 slot 升序，每 slot 汇总全部匹配行的 badBins（同 bin 跨 INTERRUPT/续测行 dieCount 相加）。问「每片 BIN7 颗数」时读此字段，勿依赖 rows。";

const RECENT_LOTS_GUIDE =
  "recentLotsByTestEnd：按 lot 取 MAX(TESTEND) 后降序，默认 top 5。问「某卡最近 N 个 lot」时读此字段；禁止用 aggregate_jb_bins（聚合按坏 die 排序，不是测试时间）。";

const BIN10_VS66_BY_LOT_GUIDE =
  "bin10Vs66ByLot：按 lot 汇总全部匹配行（跨 slot/pass 相加）的 BIN10 与 BIN66 dieCount 及 diff=bin10−bin66。问「by lot BIN10 是否多于 BIN66」时读此字段；禁止用 aggregate 表格里单列 BIN66 代表整 lot。";

function testEndMsFromRow(row: Record<string, unknown>): number {
  const raw = row["TESTEND"] ?? row["testEnd"] ?? row["testend"];
  if (raw == null || raw === "") return 0;
  const t = new Date(String(raw)).getTime();
  return Number.isFinite(t) ? t : 0;
}

/** 按 lot 聚合最近 TESTEND，降序取 topN（用于「7747-01 最近五个 lot」类问题）。 */
export function buildRecentLotsByTestEnd(
  rows: Record<string, unknown>[],
  topN = 5
): RecentLotByTestEndEntry[] {
  const byLot = new Map<
    string,
    RecentLotByTestEndEntry & { _testEndMs: number }
  >();
  for (const row of rows) {
    const lot = String(row["LOT"] ?? row["lot"] ?? "").trim();
    if (!lot) continue;
    const ms = testEndMsFromRow(row);
    const teRaw = row["TESTEND"] ?? row["testEnd"];
    const testEnd = teRaw != null && teRaw !== "" ? String(teRaw) : null;
    const prev = byLot.get(lot);
    if (!prev || ms > prev._testEndMs) {
      const tester = String(row["TESTERID"] ?? row["testerId"] ?? "").trim();
      byLot.set(lot, {
        lot,
        device: String(row["DEVICE"] ?? row["device"] ?? "").trim(),
        cardId: String(row["CARDID"] ?? row["cardid"] ?? "").trim(),
        testEnd,
        ...(tester ? { testerId: tester } : {}),
        _testEndMs: ms,
      });
    }
  }
  return [...byLot.values()]
    .sort((a, b) => b._testEndMs - a._testEndMs)
    .slice(0, topN)
    .map(({ _testEndMs: _omit, ...rest }) => rest);
}

/** 按 lot 汇总坏 bin（跨 slot / INTERRUPT 行 dieCount 相加）。 */
export function buildBinTotalsByLot(
  rows: Record<string, unknown>[]
): Array<{ lot: string; device: string; badBins: AgentJbBinEntry[] }> {
  const byLot = new Map<string, { device: string; bins: Map<number, number> }>();
  for (const row of rows) {
    const lot = String(row["LOT"] ?? row["lot"] ?? "").trim();
    if (!lot) continue;
    if (!byLot.has(lot)) {
      byLot.set(lot, {
        device: String(row["DEVICE"] ?? row["device"] ?? "").trim(),
        bins: new Map(),
      });
    }
    const entry = byLot.get(lot)!;
    for (const { bin, dieCount, isGoodBin } of normalizeBinsForAgent(row["bins"])) {
      if (isGoodBin) continue;
      entry.bins.set(bin, (entry.bins.get(bin) ?? 0) + dieCount);
    }
  }
  return [...byLot.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([lot, { device, bins }]) => ({
      lot,
      device,
      badBins: [...bins.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([bin, dieCount]) => ({ bin, dieCount, isGoodBin: false })),
    }));
}

/** 按 lot 对比 BIN10 与 BIN66 总量（用户常问「by lot 谁多」）。 */
export function buildBin10Vs66ByLot(
  rows: Record<string, unknown>[]
): LotBinPairCompareEntry[] {
  const out: LotBinPairCompareEntry[] = [];
  for (const { lot, device, badBins } of buildBinTotalsByLot(rows)) {
    const bin10 = badBins.find((b) => b.bin === 10)?.dieCount ?? 0;
    const bin66 = badBins.find((b) => b.bin === 66)?.dieCount ?? 0;
    if (bin10 === 0 && bin66 === 0) continue;
    const diff = bin10 - bin66;
    out.push({ lot, device, bin10, bin66, diff, bin10GtBin66: diff > 0 });
  }
  return out.sort((a, b) => b.diff - a.diff);
}

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
  const recentLotsByTestEnd = buildRecentLotsByTestEnd(rows, 5);
  const bin10Vs66ByLot = buildBin10Vs66ByLot(rows);
  const distinctLotCount = new Set(
    rows
      .map((r) => String(r["LOT"] ?? r["lot"] ?? "").trim())
      .filter(Boolean)
  ).size;
  return {
    _binFieldGuide: BIN_SCHEMA_HINT,
    _slotYieldGuide: slotYieldSummaryFieldGuide(),
    _slotBadBinsCompactGuide: SLOT_BAD_BINS_COMPACT_GUIDE,
    _recentLotsGuide: RECENT_LOTS_GUIDE,
    _bin10Vs66ByLotGuide: BIN10_VS66_BY_LOT_GUIDE,
    count: rows.length,
    distinctSlots,
    distinctLotCount,
    recentLotsByTestEnd,
    bin10Vs66ByLot,
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
    "明细 rows 已省略以控制体积；请用 recentLotsByTestEnd、bin10Vs66ByLot、slotBadBinsCompact、binBySlot、slotYieldSummary、distinctSlots";

  const slim = fitsLimit(withoutRows, maxChars);
  if (slim) return slim;

  const ultra: Record<string, unknown> = {
    _binFieldGuide: wrapped["_binFieldGuide"],
    _slotBadBinsCompactGuide: wrapped["_slotBadBinsCompactGuide"],
    _recentLotsGuide: wrapped["_recentLotsGuide"],
    _bin10Vs66ByLotGuide: wrapped["_bin10Vs66ByLotGuide"],
    _rowsNote: withoutRows["_rowsNote"],
    rowsOmitted: true,
    rowCount,
    count: wrapped["count"],
    distinctSlots: wrapped["distinctSlots"],
    distinctLotCount: wrapped["distinctLotCount"],
    recentLotsByTestEnd: wrapped["recentLotsByTestEnd"],
    bin10Vs66ByLot: wrapped["bin10Vs66ByLot"],
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
