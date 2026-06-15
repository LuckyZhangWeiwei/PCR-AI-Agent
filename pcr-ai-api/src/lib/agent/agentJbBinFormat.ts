// pcr-ai-api/src/lib/agent/agentJbBinFormat.ts
/** Agent 工具回传：与 aggregate_jb_bins 的 bin/count 语义对齐，避免 n/value 被模型对调。 */

import {
  buildLotYieldRank,
  buildSlotYieldSummary,
  buildSlotYieldPivot,
  buildYieldByPassId,
  isInterruptPasstype,
  lotYieldRankFieldGuide,
  passIdFromJbRow,
  passNumFromJbRow,
  slotYieldInterruptFieldGuide,
  slotYieldPivotFieldGuide,
  slotYieldSummaryFieldGuide,
  testInterruptCountFieldGuide,
  yieldByPassFieldGuide,
  type LotYieldRankEntry,
  type SlotYieldSummaryEntry,
} from "../jbYieldCalc.js";
import {
  formatCardByPassIdMarkdown,
  formatLotYieldOverviewMarkdown,
  formatLotTesterMarkdown,
  formatSlotYieldInterruptMarkdown,
  formatTestInterruptCountMarkdown,
  formatSlotYieldPivotMarkdown,
  formatYieldByPassSection,
} from "./agentJbHistoryCompact.js";
import { clearJbToolRawJson, storeJbToolRawJson } from "./agentJbSessionCache.js";
import {
  jbYieldCoreFields,
  jbYieldCoreFieldsForSerialize,
} from "./agentJbYieldCore.js";
import {
  BAD_BIN_SLOT_TRENDS_GUIDE,
  buildBadBinSlotTrends,
  buildSlotsByPassId,
  slimRowsForBinTrend,
  SLOTS_BY_PASS_GUIDE,
  type BadBinSlotTrendEntry,
} from "./agentJbBinTrend.js";
import {
  buildClusteredBadBinAlerts,
  CLUSTERED_BAD_BIN_ALERTS_GUIDE,
  formatClusteredBadBinAlertsMarkdown,
  type ClusteredBadBinAlert,
} from "./agentJbBadBinCluster.js";
import {
  CARD_DEGRADATION_SIGNAL_GUIDE,
  type CardDegradationSignal,
} from "./agentCrossdomainInsights.js";

export { jbYieldCoreFields } from "./agentJbYieldCore.js";

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
  /** 该 (slot,passId) 组内是否有测试中断/续测（INTERRUPT、PASSNUM 递增或同 PASSNUM 多行） */
  hasTestInterrupt: boolean;
  /**
   * 业务上换卡必伴随中断；为 true 表示数据里有多卡但未检出中断（可能 limit 截断缺行）
   */
  cardChangeWithoutInterrupt?: boolean;
};

/** lot 返回行内各 pass 出现的 CARDID（跨 slot 汇总，用于 sort1/2/3 各用哪张卡） */
export type CardByPassIdEntry = {
  passId: number;
  cardIds: string[];
  /** 任一 (slot, passId) 组内是否中途换卡 */
  hasCardChange: boolean;
};

/** 各 lot 在返回行内出现的测试机（JB 列 TESTERID，API 参数 testerId）。 */
export type LotTesterEntry = {
  lot: string;
  /** 该 lot 全部匹配行中的不同 TESTERID（升序） */
  testerIds: string[];
  /** 最近 TESTEND 行上的 TESTERID（汇报「在哪台机台测」时优先用） */
  primaryTesterId: string;
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
  /** 该 lot 在返回行内的不同 slot 编号列表（升序） */
  slots: number[];
  /** 该 lot 在返回行内的不同 slot 数（= slots.length） */
  slotCount: number;
};


const BIN_SCHEMA_HINT =
  "每条: bin=BINDie编号(通常较小), dieCount=该BIN的die颗数(可很大); 禁止写成 BIN{dieCount} {bin}颗";

const SLOT_BAD_BINS_COMPACT_GUIDE =
  "slotBadBinsCompact：按 (slot, passId, cardId) 分组；JSON 过大时会被截断，**禁止**用于「BIN 按片趋势」（须读 badBinSlotTrends）。仅同一 pass 同片多 CARDID=中途换卡。";

const CARD_CHANGES_BY_SLOT_PASS_GUIDE =
  "cardChangesBySlotPass：仅同一 (slot,passId) 多 CARDID=中途换卡；业务上换卡必有测试中断(hasTestInterrupt)。hasCardChange 时须同时写中断/续测与前后卡号，读 slotYieldSummary。cardChangeWithoutInterrupt=true 表示缺 INTERRUPT 行。";

const CARD_BY_PASS_ID_GUIDE =
  "cardByPassId：各 passId 在返回行内的 CARDID 集合。pass1 与 pass3 各用一卡为正常；结论用 pass1/3/5，禁止写常温/高温/低温。";

const RECENT_LOTS_GUIDE =
  "recentLotsByTestEnd：按 lot MAX(TESTEND) 降序 top20（返回行集内）；每 lot 含 slotCount、slots、cardIds、testerId（最近 TESTEND 行机台）、hasCardChangeInLot。机台汇总见 testerByLot / testerIdMarkdown（JB=TESTERID；Yield Monitor 同机台字段为 HOSTNAME/hostname）。";

const TESTER_BY_LOT_GUIDE =
  "testerByLot / testerIdMarkdown：JB STAR 机台=INFLAYERBINLIST.TESTERID（API testerId）。用户问「在哪台机台/测试机测」须读本表；与 Yield Monitor 的 HOSTNAME（API hostname）为同一机台不同列名。";

const BIN_TOTALS_BY_LOT_GUIDE =
  "binTotalsByLot：按 lot 汇总全部匹配行（跨 slot/pass 相加）的各坏 bin dieCount，每 lot 一行，badBins=[{bin,dieCount}]。对比任意两个 bin（如 BIN10 vs BIN66）：从 badBins 按 bin 编号查 dieCount，相减得 diff，缺失视为 0；禁止用 aggregate 排名表做横向对比。";

const LOT_YIELD_RANK_GUIDE = lotYieldRankFieldGuide();

const TOP_BAD_BINS_GUIDE =
  "topBadBins：当前查询范围内（如已传 lot 则仅该 lot）坏 bin 按 dieCount 降序 Top15；单 lot 概况/坏 bin 排名读此字段，禁止无 lot 的 aggregate_jb_bins。";

export type TopBadBinEntry = { bin: number; dieCount: number };

/** 当前返回行集内坏 bin 合计排名（单 lot 概况用，替代无过滤 aggregate）。 */
export function buildTopBadBins(
  rows: Record<string, unknown>[],
  topN = 15
): TopBadBinEntry[] {
  const totals = new Map<number, number>();
  for (const row of rows) {
    for (const { bin, dieCount, isGoodBin } of normalizeBinsForAgent(row["bins"])) {
      if (isGoodBin || dieCount <= 0) continue;
      totals.set(bin, (totals.get(bin) ?? 0) + dieCount);
    }
  }
  return [...totals.entries()]
    .map(([bin, dieCount]) => ({ bin, dieCount }))
    .sort((a, b) => b.dieCount - a.dieCount)
    .slice(0, topN);
}

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

/** 换卡场景须能看到的「测试中断」：INTERRUPT 行和/或 PASSNUM 递增（不含仅同 PASSNUM 多行 TEST）。 */
function groupHasExplicitTestInterrupt(
  group: Record<string, unknown>[]
): boolean {
  if (group.some(isInterruptPasstype)) return true;
  if (group.length < 2) return false;
  const passNums = group.map(passNumFromJbRow);
  return Math.max(...passNums) > Math.min(...passNums);
}

/** 同一 (slot, passId) 内多 CARDID → 中途换卡；换卡组内应能检出测试中断。 */
export function buildCardChangesBySlotPass(
  rows: Record<string, unknown>[]
): CardChangeBySlotPassEntry[] {
  const bySlotPass = new Map<string, { cardIds: Set<string>; group: Record<string, unknown>[] }>();
  for (const row of rows) {
    const slot = Number(row["SLOT"] ?? row["slot"]);
    if (!Number.isFinite(slot) || slot <= 0) continue;
    const passId = passIdFromRow(row);
    const cid = cardIdFromRow(row);
    const key = slotPassKey(slot, passId);
    if (!bySlotPass.has(key)) {
      bySlotPass.set(key, { cardIds: new Set(), group: [] });
    }
    const entry = bySlotPass.get(key)!;
    entry.group.push(row);
    if (cid) entry.cardIds.add(cid);
  }
  const out: CardChangeBySlotPassEntry[] = [];
  for (const key of [...bySlotPass.keys()].sort()) {
    const [slotStr, passStr] = key.split("\0");
    const slot = Number(slotStr);
    const passId = Number(passStr);
    const { cardIds: cardSet, group } = bySlotPass.get(key)!;
    const cardIds = [...cardSet].sort((a, b) => a.localeCompare(b));
    const hasCardChange = cardIds.length > 1;
    // Fix: always use groupHasExplicitTestInterrupt (INTERRUPT row or PASSNUM increase).
    // splitPassGroupIntoHalves.segmented fires on any 2+ TEST rows at the same PASSNUM,
    // producing false hasTestInterrupt:true on normal multi-row groups with no card change.
    const hasTestInterrupt = groupHasExplicitTestInterrupt(group);
    const item: CardChangeBySlotPassEntry = {
      slot,
      passId,
      cardIds,
      hasCardChange,
      hasTestInterrupt,
    };
    if (hasCardChange && !hasTestInterrupt) {
      item.cardChangeWithoutInterrupt = true;
    }
    out.push(item);
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

/** 按 lot 汇总 TESTERID；primary = 该 lot 最近 TESTEND 行上的机台。 */
export function buildTesterByLot(
  rows: Record<string, unknown>[]
): LotTesterEntry[] {
  const byLot = new Map<
    string,
    { testers: Set<string>; bestMs: number; primary: string }
  >();
  for (const row of rows) {
    const lot = String(row["LOT"] ?? row["lot"] ?? "").trim();
    if (!lot) continue;
    const tester = String(row["TESTERID"] ?? row["testerId"] ?? "").trim();
    if (!byLot.has(lot)) {
      byLot.set(lot, { testers: new Set(), bestMs: 0, primary: "" });
    }
    const e = byLot.get(lot)!;
    if (tester) e.testers.add(tester);
    const ms = testEndMsFromRow(row);
    if (ms >= e.bestMs) {
      e.bestMs = ms;
      if (tester) e.primary = tester;
    }
  }
  return [...byLot.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((lot) => {
      const e = byLot.get(lot)!;
      const testerIds = [...e.testers].sort((a, b) => a.localeCompare(b));
      const primaryTesterId =
        e.primary || testerIds[0] || "";
      return { lot, testerIds, primaryTesterId };
    });
}

export function primaryTesterIdForLot(
  entries: LotTesterEntry[],
  lot: string
): string | undefined {
  const key = lot.trim();
  if (!key) return undefined;
  const hit = entries.find((e) => e.lot === key);
  return hit?.primaryTesterId || hit?.testerIds[0];
}

/** serialize 截断时用紧凑机台摘要（省略 testerIds 列表）。 */
export function minimalTesterByLot(
  entries: LotTesterEntry[]
): Array<{ lot: string; primaryTesterId: string }> {
  return entries
    .filter((e) => e.primaryTesterId)
    .map((e) => ({ lot: e.lot, primaryTesterId: e.primaryTesterId }));
}

function testerFieldsForSerialize(
  wrapped: Record<string, unknown>
): Record<string, unknown> {
  const byLot = wrapped["testerByLot"] as LotTesterEntry[] | undefined;
  const out: Record<string, unknown> = {};
  if (byLot?.length) out.testerByLot = minimalTesterByLot(byLot);
  if (wrapped["testerId"]) out.testerId = wrapped["testerId"];
  return out;
}

/** 按 lot 聚合最近 TESTEND，降序取 topN（用于「7747-01 最近五个 lot」类问题）。 */
export function buildRecentLotsByTestEnd(
  rows: Record<string, unknown>[],
  topN = 5
): RecentLotByTestEndEntry[] {
  const byLot = new Map<
    string,
    RecentLotByTestEndEntry & { _testEndMs: number; _cardIdSet: Set<string>; _slotSet: Set<number>; _initialized: boolean; _lotRows: Record<string, unknown>[] }
  >();
  for (const row of rows) {
    const lot = String(row["LOT"] ?? row["lot"] ?? "").trim();
    if (!lot) continue;
    const ms = testEndMsFromRow(row);
    const cid = cardIdFromRow(row);
    const slotN = Number(row["SLOT"] ?? row["slot"]);
    let entry = byLot.get(lot);
    if (!entry) {
      entry = {
        lot,
        device: String(row["DEVICE"] ?? row["device"] ?? "").trim(),
        cardIds: [],
        hasCardChangeInLot: false,
        cardId: "",
        testEnd: null,
        slots: [],
        slotCount: 0,
        _testEndMs: 0,
        _cardIdSet: new Set(),
        _slotSet: new Set(),
        _initialized: false,
        _lotRows: [],
      };
      byLot.set(lot, entry);
    }
    if (cid) entry._cardIdSet.add(cid);
    if (Number.isFinite(slotN) && slotN > 0) entry._slotSet.add(slotN);
    entry._lotRows.push(row);
    const teRaw = row["TESTEND"] ?? row["testEnd"];
    const testEnd = teRaw != null && teRaw !== "" ? String(teRaw) : null;
    // Fix: use _initialized flag so null-TESTEND rows (ms=0) only set values on
    // the first row — preventing subsequent null-TESTEND rows from overwriting.
    if (!entry._initialized || (ms > 0 && ms > entry._testEndMs)) {
      entry._initialized = true;
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
      const slots = [...e._slotSet].sort((a, b) => a - b);
      const { _testEndMs: _omitMs, _cardIdSet: _omitSet, _slotSet: _omitSlotSet, _initialized: _omitInit, _lotRows: _omitLotRows, ...rest } = e;
      return {
        ...rest,
        cardIds,
        slots,
        slotCount: slots.length,
        // Fix: pass only this lot's rows so multi-lot queries don't contaminate each other.
        hasCardChangeInLot: lotHasMidRunCardChange(_omitLotRows),
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

const PASS_IDS_PRESENT_GUIDE =
  "passIdsPresent：本批返回行内出现的全部 PASSID（1=pass1，3=pass3，5=pass5）。禁止在未出现 1 时写「无 pass1」；有则必须写 pass1 良率（读 yieldByPassId）。用户说常温/高温/低温时映射到 1/3/5，回复勿写温区字眼。";

const LOT_QUERY_FULL_ROWS_GUIDE =
  "指定 lot 查询已拉取该 lot 全部匹配行（不限 200、默认 TESTEND 自 2020 起）；整体良率须读 lotYieldOverviewMarkdown / yieldByPassIdMarkdown（每层 sort 一行），禁止把多层 die 相加成一个「整体良率」。";

const MULTI_LOT_YIELD_SCOPE_GUIDE =
  "多 lot 行集（mask/device 未指定 lot）：良率/中断/探针卡表仅针对 primary lot（TESTEND 最新批）；须读 recentLotsByTestEnd / lotYieldRankByTestEnd 列全部 lot，或对各 lot 分别 query_jb_bins(lot)。";

/** mask/device 多 lot 时：良率表仅算 primary lot，避免跨 lot 合并同 slot。 */
export function rowsForYieldAggregates(
  rows: Record<string, unknown>[],
  opts: {
    primaryLot: string;
    distinctLotCount: number;
    lotScopedFullRows?: boolean;
  }
): Record<string, unknown>[] {
  if (opts.lotScopedFullRows || opts.distinctLotCount <= 1) return rows;
  const lot = opts.primaryLot.trim();
  if (!lot) return rows;
  return rows.filter(
    (r) => String(r["LOT"] ?? r["lot"] ?? "").trim() === lot
  );
}

export function wrapJbQueryResultForAgent(
  rows: Record<string, unknown>[],
  meta?: {
    lotScopedFullRows?: boolean;
    cardDegradationSignal?: CardDegradationSignal | null;
  }
): Record<string, unknown> {
  const slotSet = new Set<number>();
  const lotSlotPairs = new Set<string>();
  for (const r of rows) {
    const lot = String(r["LOT"] ?? r["lot"] ?? "").trim();
    const v = r["SLOT"] ?? r["slot"];
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) {
      slotSet.add(n);
      if (lot) lotSlotPairs.add(`${lot}|${n}`);
    }
  }
  const distinctSlots = [...slotSet].sort((a, b) => a - b);
  // Correct wafer count: distinct (lot, slot) pairs — not just slot numbers.
  // distinctSlots.length undercounts when different lots share the same slot number.
  const distinctLotSlotCount = lotSlotPairs.size;
  const distinctLotCount = new Set(
    rows
      .map((r) => String(r["LOT"] ?? r["lot"] ?? "").trim())
      .filter(Boolean)
  ).size;
  const primaryLot = String(rows[0]?.["LOT"] ?? rows[0]?.["lot"] ?? "").trim();
  const primaryDevice = String(
    rows[0]?.["DEVICE"] ?? rows[0]?.["device"] ?? ""
  ).trim();
  const yieldRows = rowsForYieldAggregates(rows, {
    primaryLot,
    distinctLotCount,
    lotScopedFullRows: meta?.lotScopedFullRows,
  });
  const slotYieldSummary = buildSlotYieldSummary(yieldRows);
  const yieldByPassId = buildYieldByPassId(yieldRows);
  const slotYieldPivot = buildSlotYieldPivot(slotYieldSummary);
  const lotYieldRankByTestEnd = buildLotYieldRank(rows, 20);
  const slotBadBinsCompact = buildSlotBadBinsCompact(yieldRows);
  const topBadBins = buildTopBadBins(yieldRows, 15);
  const cardChangesBySlotPass = buildCardChangesBySlotPass(yieldRows);
  const cardByPassId = buildCardByPassId(yieldRows);
  const recentLotsByTestEnd = buildRecentLotsByTestEnd(rows, 20);
  const testerByLot = buildTesterByLot(rows);
  const binTotalsByLot = buildBinTotalsByLot(rows);
  const shouldDetectClusteredBins =
    Boolean(meta?.lotScopedFullRows) ||
    distinctLotCount === 1 ||
    Boolean(primaryLot);
  const clusteredBadBinAlerts: ClusteredBadBinAlert[] = shouldDetectClusteredBins
    ? buildClusteredBadBinAlerts(yieldRows, topBadBins)
    : [];
  const passIdSet = new Set<number>();
  for (const r of yieldRows) {
    const pid = passIdFromJbRow(r);
    if (pid > 0) passIdSet.add(pid);
  }
  const passIdsPresent = [...passIdSet].sort((a, b) => a - b);
  const slotsByPassId = buildSlotsByPassId(yieldRows);
  const badBinSlotTrends = meta?.lotScopedFullRows
    ? buildBadBinSlotTrends(
        yieldRows,
        topBadBins,
        primaryLot || undefined,
        primaryDevice || undefined,
        15
      )
    : [];
  const multiLotYieldScope =
    distinctLotCount > 1 && !meta?.lotScopedFullRows;
  const result: Record<string, unknown> = {
    lot: primaryLot || undefined,
    device: primaryDevice || undefined,
    ...(multiLotYieldScope
      ? {
          _multiLotYieldScopeGuide: MULTI_LOT_YIELD_SCOPE_GUIDE,
          multiLotYieldScope: true,
          multiLotYieldScopeLot: primaryLot || undefined,
          multiLotDistinctCount: distinctLotCount,
        }
      : {}),
    _binFieldGuide: BIN_SCHEMA_HINT,
    _slotYieldGuide: slotYieldSummaryFieldGuide(),
    _slotBadBinsCompactGuide: SLOT_BAD_BINS_COMPACT_GUIDE,
    _cardChangesBySlotPassGuide: CARD_CHANGES_BY_SLOT_PASS_GUIDE,
    _cardByPassIdGuide: CARD_BY_PASS_ID_GUIDE,
    _recentLotsGuide: RECENT_LOTS_GUIDE,
    _binTotalsByLotGuide: BIN_TOTALS_BY_LOT_GUIDE,
    _lotYieldRankGuide: LOT_YIELD_RANK_GUIDE,
    _topBadBinsGuide: TOP_BAD_BINS_GUIDE,
    _yieldByPassGuide: yieldByPassFieldGuide(),
    _slotYieldPivotGuide: slotYieldPivotFieldGuide(),
    _slotYieldInterruptGuide: slotYieldInterruptFieldGuide(),
    _testInterruptCountGuide: testInterruptCountFieldGuide(),
    _testerByLotGuide: TESTER_BY_LOT_GUIDE,
    _passIdsPresentGuide: PASS_IDS_PRESENT_GUIDE,
    _slotsByPassGuide: SLOTS_BY_PASS_GUIDE,
    _badBinSlotTrendsGuide: BAD_BIN_SLOT_TRENDS_GUIDE,
    _clusteredBadBinAlertsGuide: CLUSTERED_BAD_BIN_ALERTS_GUIDE,
    ...(meta?.cardDegradationSignal
      ? {
          _cardDegradationSignalGuide: CARD_DEGRADATION_SIGNAL_GUIDE,
          cardDegradationSignal: meta.cardDegradationSignal,
        }
      : {}),
    ...(meta?.lotScopedFullRows
      ? { _lotQueryGuide: LOT_QUERY_FULL_ROWS_GUIDE, lotQueryFullRows: true }
      : {}),
    passIdsPresent: passIdsPresent,
    slotsByPassId,
    badBinSlotTrends,
    count: rows.length,
    distinctSlots,
    distinctLotCount,
    distinctLotSlotCount,
    recentLotsByTestEnd,
    testerByLot,
    testerIdMarkdown:
      testerByLot.length > 0
        ? formatLotTesterMarkdown(testerByLot, primaryLot || undefined)
        : undefined,
    binTotalsByLot,
    cardChangesBySlotPass,
    cardByPassId,
    slotYieldSummary,
    yieldByPassId,
    yieldByPassIdMarkdown:
      yieldByPassId.length > 0
        ? formatYieldByPassSection(yieldByPassId)
        : undefined,
    cardByPassIdMarkdown:
      cardByPassId.length > 0
        ? formatCardByPassIdMarkdown(cardByPassId)
        : undefined,
    slotYieldPivot,
    slotYieldPivotMarkdown:
      slotYieldPivot.passIds.length > 0
        ? formatSlotYieldPivotMarkdown(
            slotYieldPivot,
            primaryLot || undefined,
            primaryDevice || undefined,
            slotYieldSummary
          )
        : undefined,
    testInterruptCountMarkdown: (() => {
      const md = formatTestInterruptCountMarkdown(
        slotYieldSummary,
        primaryLot || undefined,
        primaryDevice || undefined
      );
      return md || undefined;
    })(),
    slotYieldInterruptMarkdown: (() => {
      const md = formatSlotYieldInterruptMarkdown(
        slotYieldSummary,
        primaryLot || undefined,
        primaryDevice || undefined
      );
      return md || undefined;
    })(),
    lotYieldRankByTestEnd,
    slotBadBinsCompact,
    topBadBins,
    clusteredBadBinAlerts,
    clusteredBadBinAlertsMarkdown:
      clusteredBadBinAlerts.length > 0
        ? formatClusteredBadBinAlertsMarkdown(
            clusteredBadBinAlerts,
            primaryLot || undefined,
            primaryDevice || undefined
          )
        : undefined,
    rows: formatJbRowsForAgent(rows),
  };
  if (primaryLot && testerByLot.length) {
    const tid = primaryTesterIdForLot(testerByLot, primaryLot);
    if (tid) result.testerId = tid;
  } else if (distinctLotCount === 1 && testerByLot.length === 1) {
    const tid = testerByLot[0]!.primaryTesterId;
    if (tid) result.testerId = tid;
  }
  if (meta?.lotScopedFullRows) {
    const overview = formatLotYieldOverviewMarkdown(result);
    if (overview) result.lotYieldOverviewMarkdown = overview;
  } else if (multiLotYieldScope && yieldRows.length > 0) {
    const overview = formatLotYieldOverviewMarkdown(result);
    if (overview) result.lotYieldOverviewMarkdown = overview;
  }
  const binTrends = result.badBinSlotTrends as
    | Array<{ bin: number; passId: number; markdown: string }>
    | undefined;
  result.agentTablesDigest = {
    lotOverview:
      typeof result.lotYieldOverviewMarkdown === "string"
        ? result.lotYieldOverviewMarkdown
        : undefined,
    binTrends: binTrends?.map(({ bin, passId, markdown }) => ({
      bin,
      passId,
      markdown,
    })),
    passIdsPresent: result.passIdsPresent as number[] | undefined,
  };
  return result;
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
): Array<Record<string, unknown>> {
  return entries.map((e) => {
    const row: Record<string, unknown> = {
      slot: e.slot,
      passId: e.passId,
      grossDie: e.grossDie,
      badDie: e.badDie,
      goodDie: e.goodDie,
      yieldPct: e.yieldPct,
      hasInterrupt: e.hasInterrupt,
    };
    if (e.testInterruptCount > 0) row.testInterruptCount = e.testInterruptCount;
    if (e.hasInterrupt && e.interruptHalf) row.interruptHalf = e.interruptHalf;
    if (e.hasInterrupt && e.completionHalf) row.completionHalf = e.completionHalf;
    if (e.interruptSegments?.length) {
      row.interruptSegments = e.interruptSegments.map((s) => ({
        label: s.label,
        metrics: {
          grossDie: s.metrics.grossDie,
          badDie: s.metrics.badDie,
          goodDie: s.metrics.goodDie,
          yieldPct: s.metrics.yieldPct,
        },
      }));
    }
    return row;
  });
}

function minimalLotYieldRank(entries: LotYieldRankEntry[]): LotYieldRankEntry[] {
  return entries.map((e) => ({
    lot: e.lot,
    device: e.device,
    yieldPct: e.yieldPct,
    worstSlot: e.worstSlot,
    worstPassId: e.worstPassId,
    slotPassCount: e.slotPassCount,
    testEnd: e.testEnd,
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
  // 长 markdown 由 session cache 保留；serialize 优先 slotYieldSummary / testerByLot
  delete withoutRows["testerIdMarkdown"];
  delete withoutRows["lotYieldOverviewMarkdown"];
  delete withoutRows["testInterruptCountMarkdown"];
  delete withoutRows["clusteredBadBinAlertsMarkdown"];
  delete withoutRows["agentTablesDigest"];
  delete withoutRows["slotBadBinsCompact"];
  delete withoutRows["recentLotsByTestEnd"];
  delete withoutRows["lotYieldRankByTestEnd"];
  delete withoutRows["binTotalsByLot"];
  delete withoutRows["cardDegradationSignal"];
  delete withoutRows["cardChangesBySlotPass"];
  for (const k of Object.keys(withoutRows)) {
    if (k.startsWith("_") && k.endsWith("Guide")) delete withoutRows[k];
  }
  withoutRows["rowsOmitted"] = true;
  withoutRows["rowCount"] = rowCount;
  withoutRows["_rowsNote"] =
    "明细 rows 已省略以控制体积；请用 lotYieldRankByTestEnd、slotYieldSummary、recentLotsByTestEnd、cardByPassId、cardChangesBySlotPass、binTotalsByLot、slotBadBinsCompact、binBySlot、distinctLotSlotCount、distinctSlots";

  const slim = fitsLimit(withoutRows, maxChars);
  if (slim) return slim;

  const core = jbYieldCoreFieldsForSerialize(wrapped);
  const lotScoped = Boolean(wrapped["lotQueryFullRows"]);
  if (lotScoped && yieldSummary?.length) {
    const yieldFirst: Record<string, unknown> = {
      ...core,
      lotQueryFullRows: true,
      _rowsNote:
        "lot 全量查询：每片×每 pass 良率% 读 slotYieldPivotMarkdown、slotYieldInterruptMarkdown、slotYieldSummary[].yieldPct；禁止用 binBySlot 累加坏 die 代替良率",
      rowsOmitted: true,
      rowCount,
      passIdsPresent: wrapped["passIdsPresent"],
      slotsByPassId: wrapped["slotsByPassId"],
      cardByPassId: wrapped["cardByPassId"],
      cardChangesBySlotPass: wrapped["cardChangesBySlotPass"],
      ...testerFieldsForSerialize(wrapped),
      slotYieldSummary: minimalSlotYieldSummary(yieldSummary),
    };
    let yieldFirstJson = fitsLimit(yieldFirst, maxChars);
    if (!yieldFirstJson) {
      yieldFirst.slotYieldPivotMarkdown = wrapped["slotYieldPivotMarkdown"];
      yieldFirstJson = fitsLimit(yieldFirst, maxChars);
    }
    if (yieldFirstJson) return yieldFirstJson;

    const trimmed = minimalSlotYieldSummary(yieldSummary);
    while (trimmed.length > 0) {
      const attempt = JSON.stringify({
        ...core,
        lotQueryFullRows: true,
        _rowsNote:
          "slotYieldSummary 已截短；良率% 以 yieldByPassIdMarkdown 与各片 pivot 为准",
        rowsOmitted: true,
        rowCount,
        ...testerFieldsForSerialize(wrapped),
        slotYieldPivotMarkdown: wrapped["slotYieldPivotMarkdown"],
        testInterruptCountMarkdown: wrapped["testInterruptCountMarkdown"],
        slotYieldInterruptMarkdown: wrapped["slotYieldInterruptMarkdown"],
        yieldByPassIdMarkdown: wrapped["yieldByPassIdMarkdown"],
        slotYieldSummary: trimmed,
      });
      if (attempt.length <= maxChars) return attempt;
      trimmed.pop();
    }
  }

  const withSummaryOnly: Record<string, unknown> = {
    ...core,
    _rowsNote: withoutRows["_rowsNote"],
    rowsOmitted: true,
    rowCount,
    ...testerFieldsForSerialize(wrapped),
    slotYieldSummary: yieldSummary
      ? minimalSlotYieldSummary(yieldSummary)
      : [],
  };
  const summaryOnlyJson = fitsLimit(withSummaryOnly, maxChars);
  if (summaryOnlyJson) return summaryOnlyJson;

  const withBinBySlot: Record<string, unknown> = {
    ...withSummaryOnly,
    binBySlot: compact?.length ? buildBinBySlotMap(compact) : {},
  };
  const binBySlotJson = fitsLimit(withBinBySlot, maxChars);
  if (binBySlotJson) return binBySlotJson;

  const ultra: Record<string, unknown> = {
    ...core,
    _slotYieldGuide: wrapped["_slotYieldGuide"],
    _rowsNote: withoutRows["_rowsNote"],
    rowsOmitted: true,
    rowCount,
    count: wrapped["count"],
    distinctLotCount: wrapped["distinctLotCount"],
    cardByPassId: wrapped["cardByPassId"],
    cardChangesBySlotPass: wrapped["cardChangesBySlotPass"],
    ...testerFieldsForSerialize(wrapped),
    slotYieldPivot:
      yieldSummary && yieldSummary.length > 0
        ? buildSlotYieldPivot(yieldSummary)
        : wrapped["slotYieldPivot"],
    slotYieldSummary: yieldSummary
      ? minimalSlotYieldSummary(yieldSummary)
      : [],
  };
  const ultraJson = fitsLimit(ultra, maxChars);
  if (ultraJson) return ultraJson;

  if (yieldSummary?.length) {
    const trimmed = minimalSlotYieldSummary(yieldSummary);
    while (trimmed.length > 0) {
      const attempt = JSON.stringify({
        ...core,
        _rowsNote: "slotYieldSummary 已截短；批次良率以 yieldByPassIdMarkdown 为准",
        rowsOmitted: true,
        rowCount,
        ...testerFieldsForSerialize(wrapped),
        slotYieldSummary: trimmed,
      });
      if (attempt.length <= maxChars) return attempt;
      trimmed.pop();
    }
  }

  if (wrapped["lotQueryFullRows"]) {
    const lotFlagJson = fitsLimit(
      {
        ...core,
        lotQueryFullRows: true,
        rowsOmitted: true,
        rowCount,
        ...testerFieldsForSerialize(wrapped),
        _rowsNote: "payload 过大；请缩小 lot 或依赖 session 缓存中的 lotYieldOverviewMarkdown",
      },
      maxChars
    );
    if (lotFlagJson) return lotFlagJson;
  }

  const coreJson = fitsLimit(
    {
      ...core,
      _rowsNote: "结果过大已极简；请读 lotYieldOverviewMarkdown / yieldByPassIdMarkdown",
      rowsOmitted: true,
      rowCount,
    },
    maxChars
  );
  if (coreJson) return coreJson;
  return JSON.stringify({
    _error: "结果序列化失败",
    lot: wrapped["lot"],
    passIdsPresent: wrapped["passIdsPresent"],
    yieldByPassIdMarkdown: wrapped["yieldByPassIdMarkdown"],
  });
}

/**
 * 总结轮专用：在 serialize 截断之前缓存 markdown / 摘要（不含 rows）。
 * 避免 toolResult 超限时丢失 lotYieldOverviewMarkdown / badBinSlotTrends。
 */
export function jbWrappedHasYieldData(wrapped: Record<string, unknown>): boolean {
  const summary = wrapped["slotYieldSummary"] as SlotYieldSummaryEntry[] | undefined;
  if (summary && summary.length > 0) return true;
  const rows = wrapped["rows"];
  if (Array.isArray(rows) && rows.length > 0) return true;
  const count = Number(wrapped["count"] ?? 0);
  return Number.isFinite(count) && count > 0;
}

/** 显式零行 query_jb_bins 回传（非探针卡/机台等元数据片段）。 */
export function jbWrappedIsEmptyQuery(wrapped: Record<string, unknown>): boolean {
  if (Array.isArray(wrapped["cardByPassId"]) && wrapped["cardByPassId"].length > 0) {
    return false;
  }
  if (Array.isArray(wrapped["testerByLot"]) && wrapped["testerByLot"].length > 0) {
    return false;
  }
  if (Array.isArray(wrapped["_trendRows"]) && wrapped["_trendRows"].length > 0) {
    return false;
  }
  const summary = wrapped["slotYieldSummary"] as SlotYieldSummaryEntry[] | undefined;
  if (summary && summary.length > 0) return false;
  const overview = wrapped["lotYieldOverviewMarkdown"];
  if (typeof overview === "string" && overview.trim()) return false;
  const rows = wrapped["rows"];
  if (Array.isArray(rows) && rows.length > 0) return false;
  const count = Number(wrapped["count"]);
  if (Number.isFinite(count) && count === 0) return true;
  return false;
}

/** 无实测行时不写入会话缓存，避免空查询后仍直出旧 lot 表。 */
export function storeJbQuerySessionCache(
  sessionId: string,
  wrapped: Record<string, unknown>
): string | undefined {
  if (!jbWrappedHasYieldData(wrapped)) {
    clearJbToolRawJson(sessionId);
    return undefined;
  }
  const json = buildJbSessionCacheJson(wrapped);
  storeJbToolRawJson(sessionId, json);
  return json;
}

export function buildJbSessionCacheJson(wrapped: Record<string, unknown>): string {
  const lotScoped = Boolean(wrapped["lotQueryFullRows"]);
  const summary = wrapped["slotYieldSummary"] as
    | SlotYieldSummaryEntry[]
    | undefined;
  const rows = wrapped["rows"] as Record<string, unknown>[] | undefined;
  const lot = String(wrapped["lot"] ?? "").trim() || undefined;
  const device = String(wrapped["device"] ?? "").trim() || undefined;
  const topBadBins = wrapped["topBadBins"] as
    | Array<{ bin: number; dieCount: number }>
    | undefined;

  const cache: Record<string, unknown> = {
    ...jbYieldCoreFields(wrapped),
    _jbSessionCacheVersion: 5,
  };

  if (summary?.length) {
    cache["slotYieldSummary"] = minimalSlotYieldSummary(summary);
  }

  const compact = wrapped["slotBadBinsCompact"] as SlotBadBinsCompactEntry[] | undefined;
  if (compact?.length) {
    cache["slotBadBinsCompact"] = compact;
  }

  const rank = wrapped["lotYieldRankByTestEnd"] as Array<unknown> | undefined;
  if (rank?.length) {
    cache["lotYieldRankByTestEnd"] = rank;
  }

  if (lotScoped && summary?.length) {
    const overview = formatLotYieldOverviewMarkdown({
      ...wrapped,
      slotYieldSummary: summary,
    });
    if (overview) cache["lotYieldOverviewMarkdown"] = overview;
  }

  if (lotScoped && rows?.length) {
    cache["_trendRows"] = slimRowsForBinTrend(rows);
    // Reuse the already-computed trends from wrapJbQueryResultForAgent (maxBins=15),
    // sliced to 8 for the cache — avoids re-running the O(bins×passes×slots×rows) loop.
    const existingTrends = wrapped["badBinSlotTrends"] as BadBinSlotTrendEntry[] | undefined;
    if (existingTrends?.length) {
      cache["badBinSlotTrends"] = existingTrends.slice(0, 8);
    }
  }

  const binTrends = cache["badBinSlotTrends"] as
    | Array<{ bin: number; passId: number; markdown: string }>
    | undefined;
  cache["agentTablesDigest"] = {
    lotOverview:
      typeof cache["lotYieldOverviewMarkdown"] === "string"
        ? cache["lotYieldOverviewMarkdown"]
        : undefined,
    binTrends: binTrends?.map(({ bin, passId, markdown }) => ({
      bin,
      passId,
      markdown,
    })),
    passIdsPresent: cache["passIdsPresent"],
  };

  return JSON.stringify(cache);
}
