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
  /** 该行/段测试使用的探针卡；同 slot 多卡时会有多条记录 */
  cardId: string;
  badBins: AgentJbBinEntry[];
};

export type CardChangeBySlotEntry = {
  slot: number;
  cardIds: string[];
  /** 同一片 wafer（slot）在返回行内出现多个不同 CARDID */
  hasCardChange: boolean;
};

export type RecentLotByTestEndEntry = {
  lot: string;
  device: string;
  /** 该 lot 在返回行内全部不同的 CARDID（升序） */
  cardIds: string[];
  /** 该 lot 是否曾换卡（cardIds.length > 1） */
  hasCardChangeInLot: boolean;
  /** 最近一条 TESTEND 行上的 CARDID（勿单独当作整 lot 唯一卡号） */
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
  "slotBadBinsCompact：按 slot、cardId 分组（同 slot 不同 CARDID=中途换卡，禁止合并）。同 (slot,cardId) 内 INTERRUPT/续测行同 bin dieCount 相加。问「每片 BIN7 颗数」须按对应 cardId 读，勿依赖 rows。";

const CARD_CHANGES_BY_SLOT_GUIDE =
  "cardChangesBySlot：同 slot 出现多个 CARDID 时 hasCardChange=true；结论须分卡列出，禁止写「整批统一一张卡」。";

const RECENT_LOTS_GUIDE =
  "recentLotsByTestEnd：按 lot 取 MAX(TESTEND) 后降序，默认 top 5；含 cardIds 与 hasCardChangeInLot。cardId 仅为最近一行卡号，整 lot 以 cardIds 为准；禁止用 aggregate_jb_bins（聚合按坏 die 排序，不是测试时间）。";

const BIN10_VS66_BY_LOT_GUIDE =
  "bin10Vs66ByLot：按 lot 汇总全部匹配行（跨 slot/pass 相加）的 BIN10 与 BIN66 dieCount 及 diff=bin10−bin66。问「by lot BIN10 是否多于 BIN66」时读此字段；禁止用 aggregate 表格里单列 BIN66 代表整 lot。";

function testEndMsFromRow(row: Record<string, unknown>): number {
  const raw = row["TESTEND"] ?? row["testEnd"] ?? row["testend"];
  if (raw == null || raw === "") return 0;
  const t = new Date(String(raw)).getTime();
  return Number.isFinite(t) ? t : 0;
}

function cardIdFromRow(row: Record<string, unknown>): string {
  return String(row["CARDID"] ?? row["cardid"] ?? "").trim();
}

/** 同 slot 内 CARDID 是否不一致（中途换卡）。 */
export function buildCardChangesBySlot(
  rows: Record<string, unknown>[]
): CardChangeBySlotEntry[] {
  const bySlot = new Map<number, Set<string>>();
  for (const row of rows) {
    const slot = Number(row["SLOT"] ?? row["slot"]);
    if (!Number.isFinite(slot) || slot <= 0) continue;
    const cid = cardIdFromRow(row);
    if (!cid) continue;
    if (!bySlot.has(slot)) bySlot.set(slot, new Set());
    bySlot.get(slot)!.add(cid);
  }
  const out: CardChangeBySlotEntry[] = [];
  for (const slot of [...bySlot.keys()].sort((a, b) => a - b)) {
    const cardIds = [...bySlot.get(slot)!].sort((a, b) => a.localeCompare(b));
    out.push({
      slot,
      cardIds,
      hasCardChange: cardIds.length > 1,
    });
  }
  return out;
}

/** 按 lot 聚合最近 TESTEND，降序取 topN（用于「7747-01 最近五个 lot」类问题）。 */
export function buildRecentLotsByTestEnd(
  rows: Record<string, unknown>[],
  topN = 5
): RecentLotByTestEndEntry[] {
  const byLot = new Map<
    string,
    RecentLotByTestEndEntry & { _testEndMs: number; _cardIdSet: Set<string> }
  >();
  for (const row of rows) {
    const lot = String(row["LOT"] ?? row["lot"] ?? "").trim();
    if (!lot) continue;
    const ms = testEndMsFromRow(row);
    const cid = cardIdFromRow(row);
    let entry = byLot.get(lot);
    if (!entry) {
      entry = {
        lot,
        device: String(row["DEVICE"] ?? row["device"] ?? "").trim(),
        cardIds: [],
        hasCardChangeInLot: false,
        cardId: "",
        testEnd: null,
        _testEndMs: 0,
        _cardIdSet: new Set(),
      };
      byLot.set(lot, entry);
    }
    if (cid) entry._cardIdSet.add(cid);
    const teRaw = row["TESTEND"] ?? row["testEnd"];
    const testEnd = teRaw != null && teRaw !== "" ? String(teRaw) : null;
    if (!entry._testEndMs || ms > entry._testEndMs) {
      const tester = String(row["TESTERID"] ?? row["testerId"] ?? "").trim();
      entry.device = String(row["DEVICE"] ?? row["device"] ?? "").trim() || entry.device;
      entry.cardId = cid;
      entry.testEnd = testEnd;
      entry._testEndMs = ms;
      if (tester) entry.testerId = tester;
    }
  }
  return [...byLot.values()]
    .sort((a, b) => b._testEndMs - a._testEndMs)
    .slice(0, topN)
    .map((e) => {
      const cardIds = [...e._cardIdSet].sort((a, b) => a.localeCompare(b));
      const { _testEndMs: _omitMs, _cardIdSet: _omitSet, ...rest } = e;
      return {
        ...rest,
        cardIds,
        hasCardChangeInLot: cardIds.length > 1,
        cardId: rest.cardId || (cardIds[cardIds.length - 1] ?? ""),
      };
    });
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

/** 按 (slot, cardId) 汇总坏 bin（同 slot 换卡不合并）。 */
export function buildSlotBadBinsCompact(
  rows: Record<string, unknown>[]
): SlotBadBinsCompactEntry[] {
  const bySlotCard = new Map<string, Map<number, number>>();
  const slotCardOrder: Array<{ slot: number; cardId: string }> = [];
  for (const row of rows) {
    const slot = Number(row["SLOT"] ?? row["slot"]);
    if (!Number.isFinite(slot) || slot <= 0) continue;
    const cardId = cardIdFromRow(row) || "(unknown)";
    const key = `${slot}\0${cardId}`;
    if (!bySlotCard.has(key)) {
      bySlotCard.set(key, new Map());
      slotCardOrder.push({ slot, cardId });
    }
    const binMap = bySlotCard.get(key)!;
    const all = normalizeBinsForAgent(row["bins"]);
    for (const { bin, dieCount, isGoodBin } of all) {
      if (isGoodBin) continue;
      binMap.set(bin, (binMap.get(bin) ?? 0) + dieCount);
    }
  }
  slotCardOrder.sort((a, b) => a.slot - b.slot || a.cardId.localeCompare(b.cardId));
  const out: SlotBadBinsCompactEntry[] = [];
  for (const { slot, cardId } of slotCardOrder) {
    const binMap = bySlotCard.get(`${slot}\0${cardId}`)!;
    const badBins: AgentJbBinEntry[] = [...binMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([bin, dieCount]) => ({ bin, dieCount, isGoodBin: false }));
    out.push({ slot, cardId, badBins });
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
  const cardChangesBySlot = buildCardChangesBySlot(rows);
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
    _cardChangesBySlotGuide: CARD_CHANGES_BY_SLOT_GUIDE,
    _recentLotsGuide: RECENT_LOTS_GUIDE,
    _bin10Vs66ByLotGuide: BIN10_VS66_BY_LOT_GUIDE,
    count: rows.length,
    distinctSlots,
    distinctLotCount,
    recentLotsByTestEnd,
    bin10Vs66ByLot,
    cardChangesBySlot,
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

/** "slot:cardId" → { bin号字符串: dieCount }；同 slot 多卡不覆盖。 */
export function buildBinBySlotMap(
  compact: SlotBadBinsCompactEntry[]
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const { slot, cardId, badBins } of compact) {
    const m: Record<string, number> = {};
    for (const { bin, dieCount } of badBins) {
      if (dieCount > 0) m[String(bin)] = dieCount;
    }
    out[`${slot}:${cardId}`] = m;
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
    "明细 rows 已省略以控制体积；请用 recentLotsByTestEnd、cardChangesBySlot、bin10Vs66ByLot、slotBadBinsCompact、binBySlot、slotYieldSummary、distinctSlots";

  const slim = fitsLimit(withoutRows, maxChars);
  if (slim) return slim;

  const ultra: Record<string, unknown> = {
    _binFieldGuide: wrapped["_binFieldGuide"],
    _slotBadBinsCompactGuide: wrapped["_slotBadBinsCompactGuide"],
    _cardChangesBySlotGuide: wrapped["_cardChangesBySlotGuide"],
    _recentLotsGuide: wrapped["_recentLotsGuide"],
    _bin10Vs66ByLotGuide: wrapped["_bin10Vs66ByLotGuide"],
    _rowsNote: withoutRows["_rowsNote"],
    rowsOmitted: true,
    rowCount,
    count: wrapped["count"],
    distinctSlots: wrapped["distinctSlots"],
    distinctLotCount: wrapped["distinctLotCount"],
    recentLotsByTestEnd: wrapped["recentLotsByTestEnd"],
    cardChangesBySlot: wrapped["cardChangesBySlot"],
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
