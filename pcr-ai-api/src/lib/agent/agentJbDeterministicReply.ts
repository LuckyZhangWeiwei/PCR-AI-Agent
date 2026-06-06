// pcr-ai-api/src/lib/agent/agentJbDeterministicReply.ts
/** 总结轮：服务端直出预计算表，LLM 仅写简短解读（禁止改数字）。 */

import {
  formatCardByPassIdMarkdown,
  formatLotYieldOverviewMarkdown,
  formatLotTesterMarkdown,
  formatTestInterruptCountMarkdown,
  formatSlotYieldInterruptMarkdown,
} from "./agentJbHistoryCompact.js";
import type { CardByPassIdEntry, LotTesterEntry, SlotBadBinsCompactEntry } from "./agentJbBinFormat.js";
import type { ClusteredBadBinAlert } from "./agentJbBadBinCluster.js";
import type { SlotYieldSummaryEntry } from "../jbYieldCalc.js";
import { buildBinSlotTrendMarkdownOnDemand } from "./agentJbBinTrend.js";
import { getJbToolRawJson } from "./agentJbSessionCache.js";

export type BinTrendDigest = {
  bin: number;
  passId: number;
  markdown: string;
};

export type AgentTablesDigest = {
  lotOverview?: string;
  binTrends?: BinTrendDigest[];
  passIdsPresent?: number[];
};

export type JbReplyMode =
  | "lot_overview"
  | "bin_trend"
  | "slot_pass_yield"
  | "interrupt_count"
  | "tester_machine"
  | "equipment"
  | "bad_bin_ranking"
  | "bin_card_attribution"
  | "card_yield_compare"
  | "lot_yield_ranking"
  | "per_slot_bin_ranking"
  | "card_test_overview"
  | "card_dut_question"
  | "generic";

/** 用户问在哪台机台/测试机测（JB testerId / YM hostname）。 */
export function isTesterMachineQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (
    /哪台|哪个.*机台|在哪.*机台|哪.*机器|在哪个.*测试|测试机|机台|tester|hostname|TESTERID|HOSTNAME/i.test(
      t
    )
  ) {
    return true;
  }
  return false;
}

/** 用户问探针卡号（CARDID / 几号卡）。 */
export function isProbeCardQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return /几号卡|哪张.*卡|哪个.*卡|探针卡|probe\s*card|CARDID|卡号|用的.*卡|哪块卡/i.test(
    t
  );
}

/** 用户问某个具体 BIN 编号是哪张（些）探针卡测出来的，或 BIN 与探针卡/channel 的关系（逐卡归因）。 */
export function isBinCardAttributionQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (!/\bBIN\s*\d{1,3}\b|\bbin\s*\d{1,3}\b/i.test(t)) return false;
  return /哪张.*卡|哪个.*卡|是.*卡|哪块卡|用的.*卡|什么.*卡|属于.*卡|哪张.*探针|哪些.*卡|哪些.*探针|和.*探针.*有关|探针.*有关|卡.*有关|哪些.*channel/i.test(t);
}

/** 用户比较两张或多张探针卡的良率/坏 die（哪张更差/更好）。 */
export function isCardYieldCompareQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/哪张.*(良率|yield|更差|更好|最差|最好|最低|最高)|(?:良率|yield).*(哪张|更差|更好|最差)/i.test(t)) {
    return true;
  }
  const twoCards = (t.match(/\d{4}-\d{2,3}/g) ?? []).length >= 2;
  if (twoCards && /(哪张|哪个|良率|yield|更差|更好|最差|最好)/i.test(t)) {
    return true;
  }
  if (/探针卡.*(更差|更好|最差|最好|更低|更高|哪.*差|哪.*好)/i.test(t)) {
    return true;
  }
  return false;
}

/** 用户按良率排名多个 lot（最差/最低的 N 个 lot）。 */
export function isLotYieldRankingQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // "良品率/良率最差的N个lot" / "yield最差的lot"
  if (/(良品率|良率|yield).*(最差|最低|worst|bottom)/i.test(t)) return true;
  // "最差的N个lot" / "测试良率最差"
  if (/(最差|最低).*(lot|批次)/i.test(t)) return true;
  // "lot良率排行/排名"
  if (/(lot|批次).*(良率|良品率|yield).*(排行|排名|ranking)/i.test(t)) return true;
  return false;
}

/** 用户要看每片 wafer 的坏 bin 排名（每片前 N 名）。 */
export function isPerSlotBadBinRankingQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // 必须含「每片/每一片/各片」类逐片含义
  const perSlice = /(每片|每一片|各片|逐片|每个.*wafer|每个.*waferId|每个.*slot)/i.test(t);
  if (!perSlice) return false;
  return /(坏\s*bin|坏die|坏\s*BIN|bad\s*bin)/i.test(t);
}

/** 用户询问某张探针卡中哪个 DUT 有问题（卡号 + DUT/site 类关键词）。 */
export function isCardDutQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (!/\b\d{4}-\d{2,3}\b/.test(t)) return false;
  return /(哪个.*dut|dut.*哪个|哪个.*site|site.*哪个|dut.*问题|dut.*坏|哪个.*触点|触点.*问题|dut.*失效|哪个.*不良|dut.*异常)/i.test(t);
}

/** 用户询问某张探针卡的测试概况（卡号格式 dddd-dd/ddd + 概况关键词）。 */
export function isCardTestOverviewQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (!/\b\d{4}-\d{2,3}\b/.test(t)) return false;
  return /(测试情况|的情况|整体情况|使用情况|历次测试|测试结果|性能)/i.test(t);
}

/** 从用户文字提取探针卡 ID（dddd-dd/ddd 格式）。 */
function extractCardIdFromUserText(text: string): string | null {
  const m = text.match(/\b(\d{4}-\d{2,3})\b/);
  return m ? m[1]! : null;
}

function formatEquipmentTables(toolPayload: Record<string, unknown>): string | null {
  const parts: string[] = [];
  const cardDirect = toolPayload["cardByPassIdMarkdown"];
  if (typeof cardDirect === "string" && cardDirect.trim()) {
    parts.push(cardDirect.trim());
  } else {
    const cardMd = formatCardByPassIdMarkdown(
      (toolPayload["cardByPassId"] as CardByPassIdEntry[] | undefined) ?? []
    );
    if (cardMd.trim()) parts.push(cardMd.trim());
  }

  const testerDirect = toolPayload["testerIdMarkdown"];
  if (typeof testerDirect === "string" && testerDirect.trim()) {
    parts.push(testerDirect.trim());
  } else {
    const byLot = toolPayload["testerByLot"] as LotTesterEntry[] | undefined;
    if (byLot?.length) {
      const lot = String(toolPayload["lot"] ?? "").trim();
      const md = formatLotTesterMarkdown(byLot, lot || undefined);
      if (md.trim()) parts.push(md.trim());
    } else {
      const tid = toolPayload["testerId"];
      if (typeof tid === "string" && tid.trim()) {
        const lot = String(toolPayload["lot"] ?? "").trim();
        parts.push(
          lot
            ? `**${lot}** 测试机台（JB TESTERID）：**${tid.trim()}**`
            : `测试机台（JB TESTERID）：**${tid.trim()}**`
        );
      }
    }
  }

  return parts.length ? parts.join("\n\n") : null;
}

/** 用户问各片/某片「中断几次」等次数类问题。 */
export function isInterruptCountQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/中断.*(几次|多少次|多少\s*次|次数)|(几次|多少次|多少\s*次).*中断/i.test(t)) {
    return true;
  }
  if (/INTERRUPT.*(count|times|how many)/i.test(t)) return true;
  return false;
}

/** 从用户问题识别 BIN 编号（BIN7 / bin7 / bin 7）。 */
export function extractBinFromUserText(text: string): number | null {
  const patterns = [
    /\bBIN\s*[#:]?\s*(\d{1,3})\b/i,
    /\bbin\s*[#:]?\s*(\d{1,3})\b/i,
    /(?:BIN|bin)(\d{1,3})\b/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isFinite(n) && n >= 0 && n <= 255) return n;
  }
  return null;
}

/** 是否 lot 整体/概况类问题（非单一 BIN 趋势）。 */
export function isLotOverviewQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (extractBinFromUserText(t) != null && /趋势|按\s*slot|各\s*片|1\s*[-~–]\s*25|每\s*片/i.test(t)) {
    return false;
  }
  if (extractBinFromUserText(t) != null && !/整体|概况|测试情况|重新计算/i.test(t)) {
    return false;
  }
  return /整体|概况|测试情况|重新计算|lot\s*概况|批次.*情况/i.test(t);
}

/** 用户问「主要坏 bin」「坏 bin 排行/排名」类问题（无具体 bin 编号）。 */
export function isBadBinRankingQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (extractBinFromUserText(t) != null) return false; // 有具体 bin 号走 bin_trend
  return /主要.*坏\s*bin|坏\s*bin.*主要|坏\s*bin.*排行|排行.*坏\s*bin|坏\s*bin.*排名|排名.*坏\s*bin|top.*bad.*bin|主要.*bad\s*bin|哪些.*坏\s*bin|坏\s*bin.*哪些|坏die.*排行|排行.*坏die/i.test(
    t
  );
}

export function isBinTrendQuestion(text: string): boolean {
  const bin = extractBinFromUserText(text);
  if (bin == null) return false;
  // Explicit trend keywords
  if (/趋势|按\s*slot|各\s*片|1\s*[-~–]\s*25|每\s*片|分布|颗数/i.test(text)) return true;
  // Count / quantity questions about a specific BIN — implies per-slot breakdown
  if (/有多少|多少颗|多少\s*die|坏\s*die|坏\s*bin|各\s*片|片的|wafer.*bin|bin.*wafer/i.test(text)) return true;
  // Interrupt-segment BIN questions
  if (/中断|interrupt|前半|后半|续测|半段/i.test(text)) return true;
  return false;
}

/** 每片 wafer × 每个 pass 的良率%（非 BIN 趋势、非仅 lot 概况一句）。 */
export function isSlotPassYieldQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (isBinTrendQuestion(t)) return false;
  if (!/良率|yield/i.test(t)) return false;
  if (
    /每\s*片|每个\s*pass|各\s*片|逐\s*片|每\s*个\s*sort|pass\s*1.*pass\s*3|各\s*测试层/i.test(
      t
    )
  ) {
    return true;
  }
  if (/wafer/i.test(t) && /pass|sort|测试层/i.test(t)) return true;
  return false;
}

/** 服务端表已覆盖用户问题时，不再调 LLM 解读（避免 120s 超时）。lot_overview 需要表+简短解读，不在此列。 */
export function jbReplySkipsCommentaryLlm(mode: JbReplyMode): boolean {
  return (
    mode === "bad_bin_ranking" ||
    mode === "interrupt_count" ||
    mode === "tester_machine" ||
    mode === "equipment" ||
    mode === "bin_card_attribution" ||
    mode === "lot_yield_ranking" ||
    mode === "per_slot_bin_ranking" ||
    mode === "card_dut_question"
    // "card_yield_compare" 不跳过：LLM 需要推断「哪张卡更差」
  );
}

/** lot 概况：聚集/机台/探针卡/良率 pivot 等完整服务端表。 */
export function buildLotOverviewTablesMarkdown(
  toolPayload: Record<string, unknown>
): string | null {
  const full = formatLotYieldOverviewMarkdown(toolPayload)?.trim();
  if (full) return full;
  return rebuildDeterministicTablesFallback(toolPayload);
}

export const JB_TABLES_ONLY_FOOTER =
  "\n\n---\n\n*以上为服务端实测表。如需某 BIN 逐片趋势或晶圆图，请继续提问。*";

export function detectJbReplyMode(userMessage: string): JbReplyMode {
  // Specific attribution/compare modes take priority over generic equipment check
  if (isBinCardAttributionQuestion(userMessage)) return "bin_card_attribution";
  if (isCardYieldCompareQuestion(userMessage)) return "card_yield_compare";
  if (isTesterMachineQuestion(userMessage) && isProbeCardQuestion(userMessage)) {
    return "equipment";
  }
  if (isProbeCardQuestion(userMessage)) return "equipment";
  if (isTesterMachineQuestion(userMessage)) return "tester_machine";
  if (isInterruptCountQuestion(userMessage)) return "interrupt_count";
  if (isBinTrendQuestion(userMessage)) return "bin_trend";
  if (isBadBinRankingQuestion(userMessage)) return "bad_bin_ranking";
  if (isLotYieldRankingQuestion(userMessage)) return "lot_yield_ranking";
  if (isPerSlotBadBinRankingQuestion(userMessage)) return "per_slot_bin_ranking";
  if (isSlotPassYieldQuestion(userMessage)) return "slot_pass_yield";
  if (isCardDutQuestion(userMessage)) return "card_dut_question";
  if (isCardTestOverviewQuestion(userMessage)) return "card_test_overview";
  if (isLotOverviewQuestion(userMessage)) return "lot_overview";
  return "generic";
}

export function parseJbToolPayload(
  raw: string
): Record<string, unknown> | null {
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    return o && typeof o === "object" ? o : null;
  } catch {
    return null;
  }
}

/** 内存缓存优先，否则解析工具 history（含 compact 后的 _trendRows）。 */
export function resolveJbToolPayload(
  sessionId: string,
  toolContent?: string
): Record<string, unknown> | null {
  const cached = getJbToolRawJson(sessionId);
  if (cached) {
    const p = parseJbToolPayload(cached);
    if (p) return p;
  }
  if (toolContent?.trim()) {
    return parseJbToolPayload(toolContent);
  }
  return null;
}

function digestFromPayload(o: Record<string, unknown>): AgentTablesDigest {
  const direct = o["agentTablesDigest"] as AgentTablesDigest | undefined;
  if (direct && (direct.lotOverview || direct.binTrends?.length)) {
    return direct;
  }
  return {
    lotOverview:
      typeof o["lotYieldOverviewMarkdown"] === "string"
        ? o["lotYieldOverviewMarkdown"]
        : undefined,
    binTrends: Array.isArray(o["badBinSlotTrends"])
      ? (o["badBinSlotTrends"] as BinTrendDigest[])
      : undefined,
    passIdsPresent: Array.isArray(o["passIdsPresent"])
      ? (o["passIdsPresent"] as number[])
      : undefined,
  };
}

function pickPassIdForBinTrend(
  userMessage: string,
  trends: BinTrendDigest[],
  passIdsPresent?: number[]
): number | null {
  if (/常温|sort\s*1|pass\s*1|passId\s*[=:]?\s*1/i.test(userMessage)) return 1;
  if (/高温|sort\s*2|pass\s*3|passId\s*[=:]?\s*3/i.test(userMessage)) return 3;
  if (/低温|sort\s*3|pass\s*5|passId\s*[=:]?\s*5/i.test(userMessage)) return 5;
  const inTrends = [...new Set(trends.map((t) => t.passId))].sort((a, b) => a - b);
  if (inTrends.length === 1) return inTrends[0]!;
  if (passIdsPresent?.includes(1) && inTrends.includes(1)) return 1;
  if (inTrends.length) return inTrends[0] ?? null;
  if (passIdsPresent?.includes(1)) return 1;
  return passIdsPresent?.[0] ?? null;
}

/** 从用户文字提取"前N名"数字（支持中文：前五名=5，前3名=3）。 */
function extractTopN(text: string, defaultN = 5): number {
  const mArabic = text.match(/top\s*(\d+)|前\s*(\d+)\s*名|前\s*(\d+)/i);
  if (mArabic) {
    const n = Number(mArabic[1] ?? mArabic[2] ?? mArabic[3]);
    if (Number.isFinite(n) && n > 0 && n <= 50) return n;
  }
  const zhMap: Record<string, number> = {
    "一": 1, "二": 2, "三": 3, "四": 4, "五": 5,
    "六": 6, "七": 7, "八": 8, "九": 9, "十": 10,
  };
  const mZh = text.match(/前([一二三四五六七八九十]+)名?/);
  if (mZh) {
    const n = zhMap[mZh[1]!];
    if (n) return n;
  }
  return defaultN;
}

/** 逐片 top-N 坏 bin 排名表（来自 slotBadBinsCompact，按 slot×passId 汇总）。 */
function buildPerSlotBadBinRankingMarkdown(
  toolPayload: Record<string, unknown>,
  userMessage: string
): string | null {
  type CompactEntry = {
    slot: number;
    passId: number;
    cardId: string;
    badBins: Array<{ bin: number; dieCount: number }>;
  };
  const compact = toolPayload["slotBadBinsCompact"] as CompactEntry[] | undefined;
  if (!compact?.length) return null;

  const n = extractTopN(userMessage, 5);

  // Aggregate by (slot, passId) across all cardIds
  const bySlotPass = new Map<string, { slot: number; passId: number; bins: Map<number, number> }>();
  for (const { slot, passId, badBins } of compact) {
    const key = `${slot}:${passId}`;
    if (!bySlotPass.has(key)) bySlotPass.set(key, { slot, passId, bins: new Map() });
    const entry = bySlotPass.get(key)!;
    for (const { bin, dieCount } of badBins) {
      entry.bins.set(bin, (entry.bins.get(bin) ?? 0) + dieCount);
    }
  }
  if (bySlotPass.size === 0) return null;

  const sorted = [...bySlotPass.values()].sort(
    (a, b) => a.slot - b.slot || a.passId - b.passId
  );
  const lot = String(toolPayload["lot"] ?? "").trim() || undefined;
  const lotTag = lot ? `（lot ${lot}）` : "";

  const rows = [
    `| waferId | 测试层 | 坏 die 最多的前 ${n} 个 BIN（BIN×颗数） |`,
    "|---|---|---|",
    ...sorted.map(({ slot, passId, bins }) => {
      const topBins = [...bins.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .map(([b, c]) => `BIN${b}×${c}`)
        .join(", ");
      return `| waferId ${slot} | pass${passId} | ${topBins || "—"} |`;
    }),
  ];
  return `**各片 waferId 坏 bin 前 ${n} 名${lotTag}**\n\n${rows.join("\n")}`;
}

/** 按卡汇总 lot 内各 BIN 的坏 die 颗数，并列出主要坏 BIN。 */
function buildCardBadDieSummaryMarkdown(
  compact: SlotBadBinsCompactEntry[],
  lot?: string
): string | null {
  const byCard = new Map<string, { total: number; bins: Map<number, number> }>();
  for (const { cardId, badBins } of compact) {
    if (!byCard.has(cardId)) byCard.set(cardId, { total: 0, bins: new Map() });
    const entry = byCard.get(cardId)!;
    for (const { bin, dieCount } of badBins) {
      entry.total += dieCount;
      entry.bins.set(bin, (entry.bins.get(bin) ?? 0) + dieCount);
    }
  }
  if (byCard.size === 0) return null;
  const sorted = [...byCard.entries()].sort((a, b) => b[1].total - a[1].total);
  const lotTag = lot ? `（lot ${lot}）` : "";
  const rows = [
    "| 探针卡 (CARDID) | 总坏 die 颗数 | 主要坏 BIN（前 3） |",
    "|---|---|---|",
  ];
  for (const [cardId, { total, bins }] of sorted) {
    const topBins = [...bins.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([b, c]) => `BIN${b}×${c}`)
      .join(", ");
    rows.push(`| ${cardId} | ${total} | ${topBins || "—"} |`);
  }
  return `**各探针卡坏 die 汇总${lotTag}**\n\n${rows.join("\n")}`;
}

/** 按良率升序列出 lot 排名表（用于「良品率最差的 N 个 lot」）。 */
function buildLotYieldRankingMarkdown(
  toolPayload: Record<string, unknown>,
  userMessage: string
): string | null {
  type RankEntry = {
    lot: string;
    device: string;
    yieldPct: number;
    worstSlot: number;
    worstPassId: number;
    testEnd: string | null;
  };
  const rank = toolPayload["lotYieldRankByTestEnd"] as RankEntry[] | undefined;
  if (!rank?.length) return null;

  // Extract N from "最差的5个lot" or "top 5"
  const nMatch = userMessage.match(/top\s*(\d+)|(\d+)\s*个/i);
  const n = nMatch
    ? Math.min(Math.max(1, Number(nMatch[1] ?? nMatch[2])), 50)
    : 5;

  const sorted = [...rank].sort((a, b) => a.yieldPct - b.yieldPct).slice(0, n);
  const totalLots = rank.length;

  const rows = [
    "| lot | device | 最差 (waferId / pass) | 良率% | 测试结束时间 |",
    "|---|---|---|---|---|",
    ...sorted.map((e) => {
      const passLabel = `waferId ${e.worstSlot} / pass${e.worstPassId}`;
      const testEnd = e.testEnd ? String(e.testEnd).slice(0, 10) : "—";
      return `| ${e.lot} | ${e.device} | ${passLabel} | ${e.yieldPct.toFixed(1)}% | ${testEnd} |`;
    }),
  ];
  const header = `**良率最差 ${sorted.length} 个 lot（共 ${totalLots} 个 lot，按最差 slot×pass 良率% 升序）**`;
  return `${header}\n\n${rows.join("\n")}`;
}

/** 按卡汇总某 BIN 的坏 die 颗数（所有卡均列出，0 颗也显示）。 */
function buildBinCardAttributionMarkdown(
  compact: SlotBadBinsCompactEntry[],
  bin: number,
  lot?: string
): string | null {
  const byCard = new Map<string, number>();
  for (const { cardId } of compact) {
    if (!byCard.has(cardId)) byCard.set(cardId, 0);
  }
  for (const { cardId, badBins } of compact) {
    const found = badBins.find((b) => b.bin === bin);
    if (found && found.dieCount > 0) {
      byCard.set(cardId, (byCard.get(cardId) ?? 0) + found.dieCount);
    }
  }
  if (![...byCard.values()].some((c) => c > 0)) return null;
  const sorted = [...byCard.entries()].sort((a, b) => b[1] - a[1]);
  const lotTag = lot ? `（lot ${lot}）` : "";
  const rows = [
    `| 探针卡 (CARDID) | BIN${bin} 坏 die 颗数 |`,
    `|---|---|`,
    ...sorted.map(([cardId, count]) => `| ${cardId} | ${count} |`),
  ];
  return `**BIN${bin} 坏 die 所属探针卡${lotTag}**\n\n${rows.join("\n")}`;
}

/** 探针卡 DUT 定位：该卡坏 die 汇总 + 最差片排行 + 引导用户继续问 DUT 晶圆图。 */
function buildCardDutQuestionMarkdown(
  toolPayload: Record<string, unknown>,
  cardId: string
): string | null {
  const compact = toolPayload["slotBadBinsCompact"] as SlotBadBinsCompactEntry[] | undefined;
  const lot = String(toolPayload["lot"] ?? "").trim() || undefined;
  const parts: string[] = [];

  if (compact?.length) {
    const cardEntries = compact.filter((e) => e.cardId === cardId);
    if (cardEntries.length) {
      // 1. 该卡 BIN 级坏 die 汇总
      const cardSummary = buildCardBadDieSummaryMarkdown(cardEntries, lot);
      if (cardSummary) parts.push(cardSummary);

      // 2. 该卡各片坏 die 合计排行（找最差片，供用户继续提问）
      const bySlot = new Map<string, { slot: number; passId: number; total: number }>();
      for (const { slot, passId, badBins } of cardEntries) {
        const key = `${slot}:${passId}`;
        if (!bySlot.has(key)) bySlot.set(key, { slot, passId, total: 0 });
        bySlot.get(key)!.total += badBins.reduce((s, b) => s + b.dieCount, 0);
      }
      const worstSlots = [...bySlot.values()]
        .filter((e) => e.total > 0)
        .sort((a, b) => b.total - a.total)
        .slice(0, 5);
      if (worstSlots.length) {
        const lotTag = lot ? `（lot ${lot}）` : "";
        const rows = [
          "| waferId | 测试层 | 总坏 die 颗数 |",
          "|---|---|---|",
          ...worstSlots.map((e) => `| waferId ${e.slot} | pass${e.passId} | ${e.total} |`),
        ];
        parts.push(`**探针卡 ${cardId} 各片坏 die 排行${lotTag}（前 5）**\n\n${rows.join("\n")}`);
      }

      // 3. DUT 级定位引导
      const worst = worstSlots[0];
      if (worst) {
        parts.push(
          `> **DUT 级定位**：以上为 BIN 级汇总，无法直接指出具体触点。` +
          `要确认哪个 DUT 有问题，请继续提问：\n` +
          `> 「画出 waferId ${worst.slot} 的 DUT 坏 bin 图」\n` +
          `> 系统将调用 INF DUT×BIN 晶圆图（inf_draw_dut_bin_map），直观显示各触点坏 die 颜色。`
        );
      } else {
        parts.push(
          `> **DUT 级定位**：以上为 BIN 级汇总。要确认哪个 DUT 有问题，请提问：「画出某片 wafer 的 DUT 坏 bin 图」。`
        );
      }
      return parts.join("\n\n");
    }
  }

  // 无 slotBadBinsCompact 数据时：直接给出引导
  return (
    `> **DUT 级定位**：当前 session 未包含探针卡 ${cardId} 的逐片 BIN 数据。` +
    `请先查询该卡对应的 lot（如 \`query_jb_bins(cardId="${cardId}")\`），` +
    `再提问：「画出某片 wafer 的 DUT 坏 bin 图」。`
  );
}

/** 探针卡测试概况：良率表 + 卡分配 + 该卡坏 die 排行 + 近期 lot 记录。 */
function buildCardTestOverviewMarkdown(
  toolPayload: Record<string, unknown>,
  cardId: string
): string | null {
  const parts: string[] = [];
  const lot = String(toolPayload["lot"] ?? "").trim() || undefined;

  // 1. 良率总览
  const yieldMd = toolPayload["yieldByPassIdMarkdown"];
  if (typeof yieldMd === "string" && yieldMd.trim()) {
    parts.push(yieldMd.trim());
  }

  // 2. 各 pass 探针卡分配
  const cardMd = toolPayload["cardByPassIdMarkdown"];
  if (typeof cardMd === "string" && cardMd.trim()) {
    parts.push(cardMd.trim());
  } else {
    const built = formatCardByPassIdMarkdown(
      (toolPayload["cardByPassId"] as CardByPassIdEntry[] | undefined) ?? []
    );
    if (built.trim()) parts.push(built.trim());
  }

  // 3. 该卡坏 die 排行（来自 slotBadBinsCompact）
  const compact = toolPayload["slotBadBinsCompact"] as SlotBadBinsCompactEntry[] | undefined;
  if (compact?.length) {
    const cardEntries = compact.filter((e) => e.cardId === cardId);
    if (cardEntries.length) {
      const binTotals = new Map<number, number>();
      for (const { badBins } of cardEntries) {
        for (const { bin, dieCount } of badBins) {
          binTotals.set(bin, (binTotals.get(bin) ?? 0) + dieCount);
        }
      }
      if (binTotals.size > 0) {
        const sorted = [...binTotals.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10);
        const lotTag = lot ? `（lot ${lot}）` : "";
        const rows = [
          "| BIN | 坏 die 颗数 |",
          "|---|---|",
          ...sorted.map(([b, c]) => `| BIN${b} | ${c} |`),
        ];
        parts.push(`**探针卡 ${cardId} 坏 die 排行${lotTag}**\n\n${rows.join("\n")}`);
      }
    }
  }

  // 4. 近期 lot 测试记录（按 testEnd 降序，最多 10 条）
  type RankEntry = {
    lot: string;
    device: string;
    yieldPct: number;
    worstSlot: number;
    worstPassId: number;
    testEnd: string | null;
  };
  const rank = toolPayload["lotYieldRankByTestEnd"] as RankEntry[] | undefined;
  if (rank?.length) {
    const recent = [...rank]
      .sort((a, b) =>
        (b.testEnd ?? "").localeCompare(a.testEnd ?? "")
      )
      .slice(0, 10);
    const rows = [
      "| lot | device | 良率% | 最差片 / pass | 测试结束时间 |",
      "|---|---|---|---|---|",
      ...recent.map((e) => {
        const passLabel = `waferId ${e.worstSlot} / pass${e.worstPassId}`;
        const testEnd = e.testEnd ? String(e.testEnd).slice(0, 10) : "—";
        return `| ${e.lot} | ${e.device} | ${e.yieldPct.toFixed(1)}% | ${passLabel} | ${testEnd} |`;
      }),
    ];
    parts.push(`**近期 lot 测试记录（按 testEnd 降序）**\n\n${rows.join("\n")}`);
  }

  return parts.length ? parts.join("\n\n") : null;
}

/** 根据用户问题从工具 JSON 选出应直出的 markdown 表（不改写）。 */
export function buildDeterministicJbTables(
  userMessage: string,
  toolPayload: Record<string, unknown>
): string | null {
  const digest = digestFromPayload(toolPayload);
  const mode = detectJbReplyMode(userMessage);

  if (mode === "lot_yield_ranking") {
    const md = buildLotYieldRankingMarkdown(toolPayload, userMessage);
    if (md) return md;
    // Fallback: let LLM answer from lotYieldRankByTestEnd in tool result
    return null;
  }

  if (mode === "per_slot_bin_ranking") {
    const md = buildPerSlotBadBinRankingMarkdown(toolPayload, userMessage);
    if (md) return md;
    return null;
  }

  if (mode === "card_dut_question") {
    const cardId = extractCardIdFromUserText(userMessage);
    if (cardId) {
      return buildCardDutQuestionMarkdown(toolPayload, cardId);
    }
    return null;
  }

  if (mode === "card_test_overview") {
    const cardId = extractCardIdFromUserText(userMessage);
    if (cardId) {
      const md = buildCardTestOverviewMarkdown(toolPayload, cardId);
      if (md) return md;
    }
    return null;
  }

  if (mode === "bin_card_attribution") {
    const bin = extractBinFromUserText(userMessage);
    if (bin != null) {
      const compact = toolPayload["slotBadBinsCompact"] as SlotBadBinsCompactEntry[] | undefined;
      if (compact?.length) {
        const lot = String(toolPayload["lot"] ?? "").trim() || undefined;
        const md = buildBinCardAttributionMarkdown(compact, bin, lot);
        if (md) {
          // 追问 channel/DUT 时补充引导（bin_card_attribution 只能给到卡级）
          if (/channel|DUT|site|触点|哪个.*dut|哪个.*site/i.test(userMessage)) {
            return (
              md +
              `\n\n> **DUT/channel 级分析**：上表为卡级汇总（slotBadBinsCompact）。要确认 BIN${bin} 由哪个 DUT（probe card 触点）测出，请继续提问：「BIN${bin} 与 DUT 的关系晶圆图」，系统将调用 \`query_inf_site_bin_by_dut\` 给出 DUT×BIN 细分。`
            );
          }
          return md;
        }
      }
    }
    return formatEquipmentTables(toolPayload);
  }

  if (mode === "card_yield_compare") {
    const parts: string[] = [];
    const lot = String(toolPayload["lot"] ?? "").trim() || undefined;
    const device = String(toolPayload["device"] ?? "").trim() || undefined;

    const compact = toolPayload["slotBadBinsCompact"] as SlotBadBinsCompactEntry[] | undefined;
    if (compact?.length) {
      const cardSummary = buildCardBadDieSummaryMarkdown(compact, lot);
      if (cardSummary) parts.push(cardSummary);
    }

    const interruptMd = toolPayload["slotYieldInterruptMarkdown"];
    if (typeof interruptMd === "string" && interruptMd.trim()) {
      parts.push(interruptMd.trim());
    } else {
      const summary = toolPayload["slotYieldSummary"] as SlotYieldSummaryEntry[] | undefined;
      if (summary?.length) {
        const rebuilt = formatSlotYieldInterruptMarkdown(summary, lot, device);
        if (rebuilt.trim()) parts.push(rebuilt.trim());
      }
    }

    const cardMd = toolPayload["cardByPassIdMarkdown"];
    if (typeof cardMd === "string" && cardMd.trim()) {
      parts.push(cardMd.trim());
    } else {
      const cardByPassId = toolPayload["cardByPassId"] as CardByPassIdEntry[] | undefined;
      if (cardByPassId?.length) {
        const built = formatCardByPassIdMarkdown(cardByPassId);
        if (built.trim()) parts.push(built.trim());
      }
    }

    return parts.length ? parts.join("\n\n") : formatEquipmentTables(toolPayload);
  }

  if (mode === "equipment") {
    return formatEquipmentTables(toolPayload);
  }

  if (mode === "tester_machine") {
    return formatEquipmentTables(toolPayload);
  }

  if (mode === "bad_bin_ranking") {
    const topMd = formatTopBadBinsMarkdown(toolPayload);
    const overview = digest.lotOverview?.trim() || formatLotYieldOverviewMarkdown(toolPayload)?.trim();
    if (topMd && overview) return `${overview}\n\n${topMd}`;
    if (topMd) return topMd;
    if (overview) return overview;
    return rebuildDeterministicTablesFallback(toolPayload);
  }

  if (mode === "interrupt_count") {
    const direct = toolPayload["testInterruptCountMarkdown"];
    if (typeof direct === "string" && direct.trim()) return direct.trim();
    const summary = toolPayload["slotYieldSummary"] as
      | SlotYieldSummaryEntry[]
      | undefined;
    if (summary?.length) {
      const lot = String(toolPayload["lot"] ?? "").trim();
      const device = String(toolPayload["device"] ?? "").trim();
      const md = formatTestInterruptCountMarkdown(
        summary,
        lot || undefined,
        device || undefined
      );
      if (md.trim()) return md;
    }
    return null;
  }

  if (mode === "bin_trend") {
    const bin = extractBinFromUserText(userMessage);
    if (bin == null) return null;
    const trends = digest.binTrends ?? [];
    const matches = trends.filter((t) => Number(t.bin) === bin);
    if (matches.length) {
      const passId = pickPassIdForBinTrend(
        userMessage,
        matches,
        digest.passIdsPresent
      );
      const chosen =
        passId != null
          ? matches.filter((t) => t.passId === passId)
          : matches;
      if (chosen.length) {
        if (chosen.length === 1) return chosen[0]!.markdown;
        return chosen.map((t) => t.markdown).join("\n\n");
      }
    }
    const onDemand = buildBinSlotTrendMarkdownOnDemand(
      toolPayload,
      bin,
      userMessage
    );
    if (onDemand?.trim()) return onDemand;
    return null;
  }

  if (mode === "lot_overview") {
    // Prefer pre-computed overview from cache (built with full cardByPassId array).
    // Without this, formatLotYieldOverviewMarkdown would skip the probe-card section
    // because cardByPassId (raw array) is not persisted in the session cache.
    const precomputed = digest.lotOverview?.trim();
    if (precomputed) return precomputed;
    return buildLotOverviewTablesMarkdown(toolPayload);
  }

  if (mode === "slot_pass_yield" || mode === "generic") {
    const overview =
      digest.lotOverview?.trim() ||
      formatLotYieldOverviewMarkdown(toolPayload)?.trim();

    // When the user also mentions a specific BIN (e.g. "整体情况中BIN7有多少"),
    // append the BIN slot-trend tables (including interrupt前/后段 columns) so the
    // model gets per-slot bad-die data without needing to "calculate" anything.
    const bin = extractBinFromUserText(userMessage);
    if (bin != null && digest.binTrends?.length) {
      const matches = digest.binTrends.filter((t) => Number(t.bin) === bin);
      if (matches.length) {
        const binMd = matches.map((t) => t.markdown).join("\n\n");
        if (overview) return `${overview}\n\n${binMd}`;
        return binMd;
      }
      // Try on-demand generation from _trendRows
      const onDemand = buildBinSlotTrendMarkdownOnDemand(toolPayload, bin, userMessage);
      if (onDemand?.trim()) {
        if (overview) return `${overview}\n\n${onDemand.trim()}`;
        return onDemand.trim();
      }
    }

    if (overview) return overview;
  }

  return rebuildDeterministicTablesFallback(toolPayload);
}

/** serialize 截断后仍可用 yield/interrupt/overview 片段拼表。 */
function rebuildDeterministicTablesFallback(
  toolPayload: Record<string, unknown>
): string | null {
  const overview = formatLotYieldOverviewMarkdown(toolPayload)?.trim();
  if (overview) return overview;

  const parts: string[] = [];
  const clusterMd = toolPayload["clusteredBadBinAlertsMarkdown"];
  if (typeof clusterMd === "string" && clusterMd.trim()) {
    parts.push(clusterMd.trim());
  }
  const cardMd = toolPayload["cardByPassIdMarkdown"];
  if (typeof cardMd === "string" && cardMd.trim()) {
    parts.push(cardMd.trim());
  } else {
    const built = formatCardByPassIdMarkdown(
      (toolPayload["cardByPassId"] as CardByPassIdEntry[] | undefined) ?? []
    );
    if (built.trim()) parts.push(built.trim());
  }
  const testerMd = toolPayload["testerIdMarkdown"];
  if (typeof testerMd === "string" && testerMd.trim()) {
    parts.push(testerMd.trim());
  }
  const countMd = toolPayload["testInterruptCountMarkdown"];
  if (typeof countMd === "string" && countMd.trim()) {
    parts.push(countMd.trim());
  }
  const interruptMd = toolPayload["slotYieldInterruptMarkdown"];
  if (typeof interruptMd === "string" && interruptMd.trim()) {
    parts.push(interruptMd.trim());
  }
  const yieldMd = toolPayload["yieldByPassIdMarkdown"];
  if (typeof yieldMd === "string" && yieldMd.trim()) {
    parts.push(yieldMd.trim());
  }
  const pivotMd = toolPayload["slotYieldPivotMarkdown"];
  if (typeof pivotMd === "string" && pivotMd.trim()) {
    parts.push(pivotMd.trim());
  }
  // Top bad bins ranking — essential for "what are the main bad bins" queries
  const topBadBinsMd = formatTopBadBinsMarkdown(toolPayload);
  if (topBadBinsMd) parts.push(topBadBinsMd);

  return parts.length ? parts.join("\n\n") : null;
}

/** Build a compact markdown table of topBadBins from the tool payload. */
function formatTopBadBinsMarkdown(toolPayload: Record<string, unknown>): string | null {
  const raw = toolPayload["topBadBins"];
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const entries = (raw as Array<{ bin: number; dieCount: number }>)
    .filter((e) => e.dieCount > 0)
    .slice(0, 15);
  if (entries.length === 0) return null;
  const lot =
    (typeof toolPayload["lot"] === "string" ? toolPayload["lot"] : "") ||
    (typeof toolPayload["primaryLot"] === "string" ? toolPayload["primaryLot"] : "");
  const header = lot ? `主要坏 bin 排行（lot ${lot}，坏 bin dieCount 降序 Top ${entries.length}）`
    : `主要坏 bin 排行（坏 bin dieCount 降序 Top ${entries.length}）`;
  const rows = ["| BIN | 坏 die 颗数 |", "|---|---|",
    ...entries.map((e) => `| BIN${e.bin} | ${e.dieCount} |`),
  ];
  return `**${header}**\n\n${rows.join("\n")}`;
}

export const DETERMINISTIC_TABLES_HEADER =
  "以下**仅实测数据表**（服务端生成），数字与表一致；**勿在表内或表尾加「结论/解读/建议」列或长段文字**。";

/** 与 agentLoop 拼接：数据段标题（与「分析结论」段分开展示）。 */
export const DETERMINISTIC_DATA_SECTION_TITLE = "## 实测数据";
export const DETERMINISTIC_COMMENTARY_SECTION_TITLE = "## 分析结论";

export const BRIEF_COMMENTARY_SYSTEM =
  "你是资深晶圆测试（Wafer Test）与探针卡（Probe Card）可靠性工程师，熟悉 JB STAR、Yield Monitor、INF map 与 DUT 维护。" +
  "术语：JB 字段 slot = waferId（第几片 wafer，对用户写 waferId）；INF 字段 dut = 探针卡触点（对用户写 DUT，勿写 site）。" +
  "用户消息含【实测数据表】，表中数字为最终结论，禁止修改、平均或合并 sort/半片。\n\n" +
  "**输出格式（DeepSeek-V4-Pro 必须严格遵守）**\n" +
  "- 只输出下方两个小节，不加任何前言、不复述题目、不重新画表格\n" +
  "- **绝对禁止 markdown 表格**（`| col |` 形式）；绝对禁止重复粘贴上方数据\n" +
  "- 结论只用纯文字段落或 `-` 无序列表，不用任何表格\n\n" +
  "### 数据解读\n" +
  "**严格 3 句以内（≤ 150 字），纯文字**：\n" +
  "- 句 1：若有「聚集性/突增坏 bin 警示」或 clusteredBadBinAlerts，**首句必须点明 BIN、waferId 范围与类型**（突增/聚集/递升），禁止只报 topBadBins 合计；无警示则直接报最关键的良率/BIN 异常片\n" +
  "- 句 2：对比维度——占批次比例、与次高的差距、pass 间差异、片间突变区间\n" +
  "- 句 3（可选）：有 INTERRUPT 时体现各中断段→整片合并逻辑；有多 lot 时给批间差异\n" +
  "- **禁止**：逐行复述表中每个数字；把解读写进表格；合并多 pass 良率\n\n" +
  "### 专业建议\n" +
  "**严格 3 条，每条 1 句（≤ 50 字），极度专业、可执行**：\n" +
  "1. **Wafer Test**：pass1/3/5 各层、INTERRUPT/续测、tester 稳定性、工艺 vs 机台因素；禁止写常温/高温/低温\n" +
  "2. **Probe Card**：CARDID、清卡/针压/overdrive、中途换卡与污染、bin 模式指向测试项还是接触\n" +
  "3. **DUT 维护**：针尖磨损/氧化、单 DUT vs 邻域 vs 全卡贬损、align/清针/换卡；无依据时建议补查 delta_diff 或 INF DUT map\n" +
  "禁止编造表中未出现的现象；禁止输出第 4 条或更多建议。";

/** 从 JB 工具 JSON 提取工程上下文，供解读/建议引用（非数字）。 */
export function buildEngineeringContextFromPayload(
  payload: Record<string, unknown>
): string {
  const lines: string[] = [];

  const passIds = payload.passIdsPresent as number[] | undefined;
  if (passIds?.length) {
    lines.push(`本批出现的测试层 passId：${passIds.join(", ")}`);
  }

  const clusterAlerts = payload.clusteredBadBinAlerts as
    | ClusteredBadBinAlert[]
    | undefined;
  if (clusterAlerts?.length) {
    lines.push(
      `聚集性/突增坏 bin（须首段点明）：${clusterAlerts
        .slice(0, 6)
        .map((a) => `BIN${a.bin} ${a.sortLabel} ${a.detail}`)
        .join("；")}${clusterAlerts.length > 6 ? "…" : ""}`
    );
  }

  const cardMd = payload.cardByPassIdMarkdown;
  if (typeof cardMd === "string" && cardMd.trim()) {
    lines.push("各 sort 探针卡见上表 cardByPassId 段。");
  }

  const changes = payload.cardChangesBySlotPass as
    | Array<{ slot: number; passId: number; hasCardChange: boolean; hasTestInterrupt: boolean }>
    | undefined;
  if (changes?.length) {
    const bad = changes.filter((c) => c.hasCardChange || c.hasTestInterrupt);
    if (bad.length) {
      lines.push(
        `中途换卡/中断 (waferId/slot,passId)：${bad
          .map((c) => `${c.slot}/pass${c.passId}`)
          .slice(0, 8)
          .join(", ")}${bad.length > 8 ? "…" : ""}`
      );
    }
  }

  const testerMd = payload.testerIdMarkdown;
  if (typeof testerMd === "string" && testerMd.trim()) {
    lines.push("机台见上表 testerIdMarkdown（JB TESTERID）。");
  } else {
    const byLot = payload.testerByLot as LotTesterEntry[] | undefined;
    const lot = String(payload.lot ?? "").trim();
    if (byLot?.length) {
      const hit = lot
        ? byLot.find((e) => e.lot === lot)
        : byLot.length === 1
          ? byLot[0]
          : undefined;
      if (hit?.primaryTesterId) {
        lines.push(
          `测试机台（JB TESTERID${lot ? `，lot ${lot}` : ""}）：${hit.primaryTesterId}`
        );
        if (hit.testerIds.length > 1) {
          lines.push(`本批该 lot 还曾出现机台：${hit.testerIds.join(", ")}`);
        }
      }
    } else {
      const tester = payload.testerId ?? payload.TESTERID;
      if (tester) lines.push(`测试机台（JB TESTERID）：${String(tester)}`);
    }
  }

  return lines.length ? lines.join("\n") : "（无额外工程上下文字段）";
}

export function buildYieldMonitorContextNote(
  historyNote?: string
): string {
  if (!historyNote?.trim()) return "";
  return `\n【Yield Monitor 补充】\n${historyNote.trim()}\n`;
}

export function buildBriefCommentaryUserMessage(
  userQuestion: string,
  tablesMarkdown: string,
  options?: { engineeringContext?: string; yieldMonitorNote?: string }
): string {
  const ctx = options?.engineeringContext?.trim() ?? "";
  const ym = buildYieldMonitorContextNote(options?.yieldMonitorNote);
  return (
    `【实测数据表 — 禁止改数字；勿重复粘贴全表；你的回复里禁止再用表格】\n\n${tablesMarkdown}\n\n` +
    `---\n\n【工程上下文】\n${ctx || "（见上表）"}${ym}\n\n` +
    `【用户问题】\n${userQuestion}\n\n` +
    `请按 system 要求仅输出「### 数据解读」「### 专业建议」两节（**纯文字，禁止 | 表格 |**）；专业建议须覆盖 Wafer Test、Probe Card、DUT 维护，极度专业且简短。` +
    `正文用 waferId 指代片号（表头 slot 列除外）、用 DUT 指代触点（勿写 site）；测试层用 pass1/3/5，禁止常温/高温/低温。`
  );
}
