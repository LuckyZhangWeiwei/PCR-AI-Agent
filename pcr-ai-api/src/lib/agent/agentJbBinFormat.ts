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
  /** PASSID：sort1→1，sort2→3，sort3→5 */
  passId: number;
  /** 该行/段测试使用的探针卡 */
  cardId: string;
  badBins: AgentJbBinEntry[];
};

/** 中途换卡：同一 (slot, passId) 内出现多个 CARDID。不同 pass 用不同卡不算换卡。 */
export type CardChangeBySlotPassEntry = {
  slot: number;
  passId: number;
  cardIds: string[];
  hasCardChange: boolean;
};

/** lot 返回行内各 pass 出现的 CARDID（跨 slot 汇总，用于 sort1/2/3 各用哪张卡） */
export type CardByPassIdEntry = {
  passId: number;
  cardIds: string[];
  /** 任一 (slot, passId) 组内是否中途换卡 */
  hasCardChange: boolean;
};

export type RecentLotByTestEndEntry = {
  lot: string;
  device: string;
  /** 该 lot 在返回行内全部不同的 CARDID（升序） */
  cardIds: string[];
  /** 该 lot 是否在任一 (slot, passId) 内中途换卡（非「pass1 与 pass3 各用一卡」） */
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
  "slotBadBinsCompact：按 (slot, passId, cardId) 分组。仅同一 pass 同片多 CARDID=中途换卡；pass1 与 pass3 不同卡正常，禁止合并。同组内 INTERRUPT/续测行 dieCount 相加。";

const CARD_CHANGES_BY_SLOT_PASS_GUIDE =
  "cardChangesBySlotPass：仅当同一 (slot, passId) 多 CARDID 时 hasCardChange=true。勿把 pass1=8041-08 与 pass3=8041-05 写成「24 片中途换卡」；读 cardByPassId。";

const CARD_BY_PASS_ID_GUIDE =
  "cardByPassId：各 passId 在返回行内的 CARDID 集合。常温 pass1 与高温 pass3 各用一卡为正常；结论须按 pass 写清卡号。";

const RECENT_LOTS_GUIDE =
  "recentLotsByTestEnd：按 lot MAX(TESTEND) 降序 top5；hasCardChangeInLot 仅表示同 (slot,pass) 中途换卡，非多 pass 各一卡。cardIds 为行集内全部卡号；禁止用 aggregate 代替。";

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

function passIdFromRow(row: Record<string, unknown>): number {
  const n = Number(row["PASSID"] ?? row["passId"] ?? row["passid"]);
  return Number.isFinite(n) ? n : 0;
}

function slotPassKey(slot: number, passId: number): string {
  return `${slot}\0${passId}`;
}

/** 同一 (slot, passId) 内多 CARDID → 中途换卡。 */
export function buildCardChangesBySlotPass(
  rows: Record<string, unknown>[]
): CardChangeBySlotPassEntry[] {
  const bySlotPass = new Map<string, Set<string>>();
  for (const row of rows) {
    const slot = Number(row["SLOT"] ?? row["slot"]);
    if (!Number.isFinite(slot) || slot <= 0) continue;
    const passId = passIdFromRow(row);
    const cid = cardIdFromRow(row);
    if (!cid) continue;
    const key = slotPassKey(slot, passId);
    if (!bySlotPass.has(key)) bySlotPass.set(key, new Set());
    bySlotPass.get(key)!.add(cid);
  }
  const out: CardChangeBySlotPassEntry[] = [];
  for (const key of [...bySlotPass.keys()].sort()) {
    const [slotStr, passStr] = key.split("\0");
    const slot = Number(slotStr);
    const passId = Number(passStr);
    const cardIds = [...bySlotPass.get(key)!].sort((a, b) => a.localeCompare(b));
    out.push({
      slot,
      passId,
      cardIds,
      hasCardChange: cardIds.length > 1,
    });
  }
  return out.sort(
    (a, b) => a.slot - b.slot || a.passId - b.passId
  );
}

/** 各 passId 在返回行内出现的 CARDID（跨 slot）。 */
export function buildCardByPassId(
  rows: Record<string, unknown>[]
): CardByPassIdEntry[] {
  const slotPassChanges = buildCardChangesBySlotPass(rows);
  const byPass = new Map<number, Set<string>>();
  const passHasChange = new Map<number, boolean>();
  for (const row of rows) {
    const passId = passIdFromRow(row);
    const cid = cardIdFromRow(row);
    if (!cid) continue;
    if (!byPass.has(passId)) byPass.set(passId, new Set());
    byPass.get(passId)!.add(cid);
  }
  for (const { passId, hasCardChange } of slotPassChanges) {
    if (hasCardChange) passHasChange.set(passId, true);
  }
  return [...byPass.keys()]
    .sort((a, b) => a - b)
    .map((passId) => ({
      passId,
      cardIds: [...byPass.get(passId)!].sort((a, b) => a.localeCompare(b)),
      hasCardChange: passHasChange.get(passId) ?? false,
    }));
}

function lotHasMidRunCardChange(rows: Record<string, unknown>[]): boolean {
  return buildCardChangesBySlotPass(rows).some((e) => e.hasCardChange);
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
        hasCardChangeInLot: lotHasMidRunCardChange(rows),
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

/** 按 (slot, passId, cardId) 汇总坏 bin。 */
export function buildSlotBadBinsCompact(
  rows: Record<string, unknown>[]
): SlotBadBinsCompactEntry[] {
  const byKey = new Map<string, Map<number, number>>();
  const order: Array<{ slot: number; passId: number; cardId: string }> = [];
  for (const row of rows) {
    const slot = Number(row["SLOT"] ?? row["slot"]);
    if (!Number.isFinite(slot) || slot <= 0) continue;
    const passId = passIdFromRow(row);
    const cardId = cardIdFromRow(row) || "(unknown)";
    const key = `${slot}\0${passId}\0${cardId}`;
    if (!byKey.has(key)) {
      byKey.set(key, new Map());
      order.push({ slot, passId, cardId });
    }
    const binMap = byKey.get(key)!;
    const all = normalizeBinsForAgent(row["bins"]);
    for (const { bin, dieCount, isGoodBin } of all) {
      if (isGoodBin) continue;
      binMap.set(bin, (binMap.get(bin) ?? 0) + dieCount);
    }
  }
  order.sort(
    (a, b) =>
      a.slot - b.slot ||
      a.passId - b.passId ||
      a.cardId.localeCompare(b.cardId)
  );
  const out: SlotBadBinsCompactEntry[] = [];
  for (const { slot, passId, cardId } of order) {
    const binMap = byKey.get(`${slot}\0${passId}\0${cardId}`)!;
    const badBins: AgentJbBinEntry[] = [...binMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([bin, dieCount]) => ({ bin, dieCount, isGoodBin: false }));
    out.push({ slot, passId, cardId, badBins });
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
  const cardChangesBySlotPass = buildCardChangesBySlotPass(rows);
  const cardByPassId = buildCardByPassId(rows);
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
    _cardChangesBySlotPassGuide: CARD_CHANGES_BY_SLOT_PASS_GUIDE,
    _cardByPassIdGuide: CARD_BY_PASS_ID_GUIDE,
    _recentLotsGuide: RECENT_LOTS_GUIDE,
    _bin10Vs66ByLotGuide: BIN10_VS66_BY_LOT_GUIDE,
    count: rows.length,
    distinctSlots,
    distinctLotCount,
    recentLotsByTestEnd,
    bin10Vs66ByLot,
    cardChangesBySlotPass,
    cardByPassId,
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

/** "slot:passId:cardId" → { bin号字符串: dieCount }。 */
export function buildBinBySlotMap(
  compact: SlotBadBinsCompactEntry[]
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const { slot, passId, cardId, badBins } of compact) {
    const m: Record<string, number> = {};
    for (const { bin, dieCount } of badBins) {
      if (dieCount > 0) m[String(bin)] = dieCount;
    }
    out[`${slot}:${passId}:${cardId}`] = m;
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
    "明细 rows 已省略以控制体积；请用 recentLotsByTestEnd、cardByPassId、cardChangesBySlotPass、bin10Vs66ByLot、slotBadBinsCompact、binBySlot、slotYieldSummary、distinctSlots";

  const slim = fitsLimit(withoutRows, maxChars);
  if (slim) return slim;

  const ultra: Record<string, unknown> = {
    _binFieldGuide: wrapped["_binFieldGuide"],
    _slotBadBinsCompactGuide: wrapped["_slotBadBinsCompactGuide"],
    _cardChangesBySlotPassGuide: wrapped["_cardChangesBySlotPassGuide"],
    _cardByPassIdGuide: wrapped["_cardByPassIdGuide"],
    _recentLotsGuide: wrapped["_recentLotsGuide"],
    _bin10Vs66ByLotGuide: wrapped["_bin10Vs66ByLotGuide"],
    _rowsNote: withoutRows["_rowsNote"],
    rowsOmitted: true,
    rowCount,
    count: wrapped["count"],
    distinctSlots: wrapped["distinctSlots"],
    distinctLotCount: wrapped["distinctLotCount"],
    recentLotsByTestEnd: wrapped["recentLotsByTestEnd"],
    cardChangesBySlotPass: wrapped["cardChangesBySlotPass"],
    cardByPassId: wrapped["cardByPassId"],
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
