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
  | "single_slot"
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
    /哪台|哪个.*机台|在哪.*机台|哪.*机器|测试机|机台|tester|hostname|TESTERID|HOSTNAME/i.test(
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

/**
 * 用户问某一**特定片** wafer 的情况（第N片 / waferId N / slot N）。
 * 必须高于 isLotOverviewQuestion 检查，避免"第二片的测试情况"被误判为 lot_overview。
 */
export function isSingleSlotQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // "第N片" / "第二片" / "waferId 3" / "slot 3的" etc.
  if (!/第\s*[一二三四五六七八九十百\d]+\s*片|waferId\s*\d+|slot\s*\d+/i.test(t)) return false;
  // 不适用于「每片」「各片」「逐片」这类全批枚举
  if (/每\s*片|每一片|各\s*片|逐\s*片/i.test(t)) return false;
  return true;
}

/** 从用户文字提取 waferId（slot）编号；中文数字一~九也支持。 */
export function extractSlotFromUserText(text: string): number | null {
  const chMap: Record<string, number> = {
    一: 1, 二: 2, 三: 3, 四: 4, 五: 5,
    六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
    十一: 11, 十二: 12, 十三: 13, 十四: 14, 十五: 15,
    十六: 16, 十七: 17, 十八: 18, 十九: 19, 二十: 20,
    二十一: 21, 二十二: 22, 二十三: 23, 二十四: 24, 二十五: 25,
  };
  // Arabic: "第 15 片" / "waferId 15" / "slot 15"
  const arabic = text.match(/(?:第\s*(\d+)\s*片|waferId\s*(\d+)|slot\s*(\d+))/i);
  if (arabic) {
    const n = Number(arabic[1] ?? arabic[2] ?? arabic[3]);
    if (Number.isFinite(n) && n >= 1 && n <= 25) return n;
  }
  // Chinese: "第二片"
  for (const [ch, num] of Object.entries(chMap)) {
    if (new RegExp(`第\\s*${ch}\\s*片`).test(text)) return num;
  }
  return null;
}

/**
 * 条件性/假设性推理问题（「如果两张卡都...」「若出现...下一步怎么」）。
 * 这类问题需要 LLM 领域推理，不能被 equipment 模式吃掉后跳过 LLM。
 */
function isConditionalReasoningQuestion(text: string): boolean {
  return /如果|假设|假如|都.*出现|同样.*出现|都.*失效|都.*bin|两张.*都|下一步.*怎么|怎么办|该.*怎么|怎么处理|怎么排查|排查方向|下一步|我.*需要.*做|如何处理/i.test(text);
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

/** 用户问「主要坏 bin」「坏 bin 排行/排名」「常见 fail bin」类问题（无具体 bin 编号）。 */
export function isBadBinRankingQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (extractBinFromUserText(t) != null) return false; // 有具体 bin 号走 bin_trend
  return (
    /主要.*坏\s*bin|坏\s*bin.*主要|坏\s*bin.*排行|排行.*坏\s*bin|坏\s*bin.*排名|排名.*坏\s*bin|top.*bad.*bin|主要.*bad\s*bin|哪些.*坏\s*bin|坏\s*bin.*哪些|坏die.*排行|排行.*坏die/i.test(t) ||
    // 英文 "fail bin" 变体：「常见的 fail bin」「主要 fail bin」「实测 fail bin」
    /常见.*fail\s*bin|fail\s*bin.*常见|主要.*fail\s*bin|fail\s*bin.*主要|实测.*fail\s*bin|fail\s*bin.*失效|fail\s*bin.*排|哪些.*fail\s*bin|fail\s*bin.*哪些/i.test(t)
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
  // "对BINxxx进行统计" — statistics of a specific BIN across wafers
  if (/统计/i.test(text)) return true;
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

/** 服务端表已覆盖用户问题时，不再调 LLM 解读（避免超时）。lot_overview / per_slot_bin_ranking / bad_bin_ranking 需要工程分析，不在此列。 */
export function jbReplySkipsCommentaryLlm(mode: JbReplyMode): boolean {
  return (
    // bad_bin_ranking 移出：「常见 fail bin / 坏 bin 排行」常与「实测失效情况」合问，LLM 解读有价值
    mode === "interrupt_count" ||
    mode === "tester_machine" ||
    mode === "equipment" ||
    mode === "bin_card_attribution" ||
    mode === "lot_yield_ranking" ||
    mode === "card_dut_question"
    // "per_slot_bin_ranking" 已移出：50 行跨片数据 LLM 最有价值（BIN 规律/异常片/pass 对比）
    // "card_yield_compare" 不跳过：LLM 需要推断「哪张卡更差」
  );
}

/** lot 概况：聚集/机台/探针卡/良率 pivot 等完整服务端表。 */
export function buildLotOverviewTablesMarkdown(
  toolPayload: Record<string, unknown>
): string | null {
  const full = formatLotYieldOverviewMarkdown(toolPayload)?.trim();
  if (full) return withAlertsAndPatterns(full, toolPayload);
  return rebuildDeterministicTablesFallback(toolPayload);
}

export function detectJbReplyMode(userMessage: string): JbReplyMode {
  // 条件性/假设性推理问题（「如果两张卡都...下一步怎么做」）须走 LLM，不能被 equipment 短路
  if (isConditionalReasoningQuestion(userMessage)) return "generic";
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
  // 单片问题必须在 lot_overview 之前检查，避免「第二片的测试情况」触发 lot_overview
  if (isSingleSlotQuestion(userMessage)) return "single_slot";
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
    return withPatterns(md ?? null, toolPayload);
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
      return withPatterns(buildCardTestOverviewMarkdown(toolPayload, cardId), toolPayload);
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
    const combined =
      topMd && overview ? `${overview}\n\n${topMd}` :
      topMd ?? overview ?? rebuildDeterministicTablesFallback(toolPayload);
    return withAlertsAndPatterns(combined, toolPayload);
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

  if (mode === "single_slot") {
    const slot = extractSlotFromUserText(userMessage);
    if (slot == null) return buildLotOverviewTablesMarkdown(toolPayload); // fallback
    const lot = String(toolPayload["lot"] ?? "").trim() || undefined;
    const device = String(toolPayload["device"] ?? "").trim() || undefined;
    const parts: string[] = [];

    // 1. 该片良率（中断片 or 无中断片）
    const summary = toolPayload["slotYieldSummary"] as SlotYieldSummaryEntry[] | undefined;
    const slotRows = summary?.filter((r) => r.slot === slot) ?? [];
    const hasInterrupt = slotRows.some((r) => r.hasInterrupt);

    if (hasInterrupt) {
      // 重新渲染只含该 slot 的中断表
      const interruptMd = formatSlotYieldInterruptMarkdown(slotRows, lot, device);
      if (interruptMd.trim()) parts.push(interruptMd.trim());
    } else if (slotRows.length) {
      const lotTag = lot ? `（lot ${lot}${device ? ` ${device}` : ""}）` : "";
      const header = `**waferId ${slot} 良率${lotTag}**\n\n| Slot | 测试层 | 良率% | 坏die |\n|---:|---|---:|---:|`;
      const rows = slotRows.map(
        (r) => `| ${r.slot} | pass${r.passId} | ${r.yieldPct != null ? r.yieldPct.toFixed(2) + "%" : "—"} | ${r.badDie ?? "—"} |`
      );
      parts.push([header, ...rows].join("\n"));
    }

    // 2. 涉及该 slot 的 BIN 警示
    const alerts = toolPayload["clusteredBadBinAlerts"] as ClusteredBadBinAlert[] | undefined;
    const relevantAlerts = alerts?.filter(
      (a) => slot >= a.slotStart && slot <= a.slotEnd
    ) ?? [];
    if (relevantAlerts.length) {
      const alertsMd = toolPayload["clusteredBadBinAlertsMarkdown"];
      if (typeof alertsMd === "string" && alertsMd.trim()) {
        parts.push(alertsMd.trim()); // 输出全部警示表（含该片的行）
      }
    }

    // 3. 探针卡与机台（简短上下文）
    const cardMd = toolPayload["cardByPassIdMarkdown"];
    if (typeof cardMd === "string" && cardMd.trim()) parts.push(cardMd.trim());
    const testerMd = toolPayload["testerIdMarkdown"];
    if (typeof testerMd === "string" && testerMd.trim()) parts.push(testerMd.trim());

    return parts.length ? parts.join("\n\n") : buildLotOverviewTablesMarkdown(toolPayload);
  }

  if (mode === "lot_overview") {
    // Prefer pre-computed overview from cache (built with full cardByPassId array).
    // Without this, formatLotYieldOverviewMarkdown would skip the probe-card section
    // because cardByPassId (raw array) is not persisted in the session cache.
    const precomputed = digest.lotOverview?.trim();
    // If precomputed: append alerts+patterns to it. Otherwise buildLotOverviewTablesMarkdown
    // already calls withAlertsAndPatterns internally, so return it directly.
    if (precomputed) return withAlertsAndPatterns(precomputed, toolPayload);
    return buildLotOverviewTablesMarkdown(toolPayload);
  }

  if (mode === "generic") {
    // 问题中含明确卡号（dddd-dd/ddd）或 DUT/触点关键词时，
    // 缓存的 lotOverview 几乎必然是错误 lot 的数据——直接返回 null，
    // 让 LLM 在总结轮从原始工具 JSON 作答（总结轮禁止再调工具）。
    const asksSpecificCard = /\b\d{4}-\d{2,3}\b/.test(userMessage);
    const asksDut = /(dut|触点)/i.test(userMessage);
    if (asksSpecificCard || asksDut) {
      return null;
    }
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

    if (overview) return withAlertsAndPatterns(overview, toolPayload);
  }

  return rebuildDeterministicTablesFallback(toolPayload);
}

/** serialize 截断后仍可用 yield/interrupt/overview 片段拼表。 */
function rebuildDeterministicTablesFallback(
  toolPayload: Record<string, unknown>
): string | null {
  const overview = formatLotYieldOverviewMarkdown(toolPayload)?.trim();
  if (overview) return withAlertsAndPatterns(overview, toolPayload);

  const parts: string[] = [];
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

  // 警示 / 规律识别合并节放在末尾
  const alertsSection = formatAlertsAndPatternsSection(toolPayload);
  if (alertsSection) parts.push(alertsSection);

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

// ─────────────────────────────────────────────────────────────────────────────
// 主动规律 / 风险识别（从缓存数据推断；无规律时返回 null，不强求输出）
// ─────────────────────────────────────────────────────────────────────────────

type DetectedPattern = {
  severity: "warning" | "info";
  title: string;
  detail: string;
  suggestChart: boolean;
};

type LotRankEntry = {
  lot: string;
  yieldPct: number;
  worstSlot: number;
  worstPassId: number;
  testEnd: string | null;
};

/** 近期 lot 良率连续下降（取末尾 ≤5 个点，至少 3 个连续点全部下降）。 */
function detectYieldDeclineTrend(rank: LotRankEntry[]): DetectedPattern | null {
  const sorted = [...rank]
    .filter((e) => e.testEnd)
    .sort((a, b) => (a.testEnd ?? "").localeCompare(b.testEnd ?? ""))
    .slice(-5);
  if (sorted.length < 3) return null;
  let declining = true;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.yieldPct >= sorted[i - 1]!.yieldPct) { declining = false; break; }
  }
  if (!declining) return null;
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const drop = (first.yieldPct - last.yieldPct).toFixed(1);
  return {
    severity: "warning",
    title: "良率持续下降趋势",
    detail: `近 ${sorted.length} 个 lot（${first.lot} → ${last.lot}）良率连续走低：${first.yieldPct.toFixed(1)}% → ${last.yieldPct.toFixed(1)}%，累计下降 ${drop}pp，建议核查探针卡磨损或工艺漂移。`,
    suggestChart: true,
  };
}

/** 单一 BIN 高度集中（topBIN 占全批坏 die ≥ 65%）。 */
function detectDominantBin(compact: SlotBadBinsCompactEntry[]): DetectedPattern | null {
  const byBin = new Map<number, number>();
  let grand = 0;
  for (const { badBins } of compact) {
    for (const { bin, dieCount } of badBins) {
      byBin.set(bin, (byBin.get(bin) ?? 0) + dieCount);
      grand += dieCount;
    }
  }
  if (grand === 0) return null;
  const top = [...byBin.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!top) return null;
  const [topBin, topCount] = top;
  const ratio = topCount / grand;
  if (ratio < 0.65) return null;
  return {
    severity: "warning",
    title: `BIN${topBin} 单一主导（占 ${(ratio * 100).toFixed(0)}%）`,
    detail: `BIN${topBin} 占全批坏 die 的 ${(ratio * 100).toFixed(0)}%（${topCount}/${grand} 颗），失效模式高度集中，建议优先排查 BIN${topBin} 对应测试项或探针卡接触。`,
    suggestChart: true,
  };
}

/** 同一 waferId 在多个 lot 中均为最差片（≥ 40% 且 ≥ 3 次）。 */
function detectPersistentBadSlot(rank: LotRankEntry[]): DetectedPattern | null {
  if (rank.length < 3) return null;
  const freq = new Map<number, number>();
  for (const { worstSlot } of rank) {
    freq.set(worstSlot, (freq.get(worstSlot) ?? 0) + 1);
  }
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!top) return null;
  const [slot, count] = top;
  if (count < 3 || count / rank.length < 0.4) return null;
  return {
    severity: "warning",
    title: `waferId ${slot} 持续为最差片`,
    detail: `在 ${rank.length} 个 lot 中，waferId ${slot} 有 ${count} 次（${((count / rank.length) * 100).toFixed(0)}%）为最差片位，可能存在系统性片位问题（如 chuck 温度不均或卡盘局部污染）。`,
    suggestChart: false,
  };
}

/** pass3（高温）平均坏 die 明显高于 pass1（≥ 1.5×），温度敏感性突出。 */
function detectTemperatureSensitivity(compact: SlotBadBinsCompactEntry[]): DetectedPattern | null {
  const byPass = new Map<number, { total: number; n: number }>();
  for (const { passId, badBins } of compact) {
    const total = badBins.reduce((s, b) => s + b.dieCount, 0);
    if (!byPass.has(passId)) byPass.set(passId, { total: 0, n: 0 });
    const e = byPass.get(passId)!;
    e.total += total;
    e.n += 1;
  }
  const p1 = byPass.get(1);
  const p3 = byPass.get(3);
  if (!p1?.n || !p3?.n) return null;
  const avg1 = p1.total / p1.n;
  const avg3 = p3.total / p3.n;
  if (avg1 === 0 || avg3 < avg1 * 1.5) return null;
  return {
    severity: "warning",
    title: "pass3 高温坏 die 显著偏高",
    detail: `pass3 平均 ${avg3.toFixed(0)} 颗/片，约为 pass1（${avg1.toFixed(0)} 颗/片）的 ${(avg3 / avg1).toFixed(1)} 倍，温度敏感性明显，建议核查高温测试项阈值或探针卡高温接触可靠性。`,
    suggestChart: false,
  };
}

/** 多张探针卡使用时各卡主导坏 BIN 不同，提示换卡引入新失效模式。 */
function detectCardChangeBinShift(compact: SlotBadBinsCompactEntry[]): DetectedPattern | null {
  const byCard = new Map<string, Map<number, number>>();
  for (const { cardId, badBins } of compact) {
    if (!byCard.has(cardId)) byCard.set(cardId, new Map());
    const bins = byCard.get(cardId)!;
    for (const { bin, dieCount } of badBins) {
      bins.set(bin, (bins.get(bin) ?? 0) + dieCount);
    }
  }
  if (byCard.size < 2) return null;
  const dominant = new Map<string, number>();
  for (const [cardId, bins] of byCard) {
    const top = [...bins.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top) dominant.set(cardId, top[0]);
  }
  if (new Set(dominant.values()).size < 2) return null;
  const detail = [...dominant.entries()].map(([c, b]) => `${c}→BIN${b}`).join("，");
  return {
    severity: "info",
    title: "换卡前后主导坏 BIN 不同",
    detail: `本批多张探针卡的主导坏 BIN 不同（${detail}），换卡可能引入不同失效模式，建议对比换卡前后各片 BIN 分布。`,
    suggestChart: false,
  };
}

/**
 * 相同卡类型（4位型号相同）在同一 pass 中，不同物理卡出现相同主导坏 BIN。
 *
 * 触发场景：
 *   - 同 lot 同 pass 发生换卡（不同槽位范围各用一张卡），两张卡型号相同
 *   - 同 slot+pass 被同型号的不同卡重测（再测场景）
 * 两张不同物理卡出现相同失效 BIN 模式 → 排除探针卡个体因素 →
 * 极度可能是测试机台或测试程序问题。
 */
function detectSameCardTypeSameBin(compact: SlotBadBinsCompactEntry[]): DetectedPattern | null {
  // 从 cardId 提取4位型号前缀（"7747-03" → "7747"；匹配失败则取整串）
  function cardTypeOf(id: string): string {
    return id.match(/^(\d{4})-/)?.[1] ?? id;
  }

  // 按 (cardType, passId) 分组：收集该型号该 pass 下所有物理卡及各自的坏 BIN 汇总
  const groups = new Map<string, { cards: Map<string, Map<number, number>> }>();
  for (const { passId, cardId, badBins } of compact) {
    const ct = cardTypeOf(cardId);
    const gk = `${ct}|${passId}`;
    if (!groups.has(gk)) groups.set(gk, { cards: new Map() });
    const { cards } = groups.get(gk)!;
    if (!cards.has(cardId)) cards.set(cardId, new Map());
    const bins = cards.get(cardId)!;
    for (const { bin, dieCount } of badBins) {
      bins.set(bin, (bins.get(bin) ?? 0) + dieCount);
    }
  }

  for (const [gk, { cards }] of groups) {
    if (cards.size < 2) continue; // 需要 2 张以上不同物理卡

    // 取每张卡的主导 BIN（top-1）
    const topBins: number[] = [];
    for (const bins of cards.values()) {
      const top = [...bins.entries()].sort((a, b) => b[1] - a[1])[0];
      if (top) topBins.push(top[0]);
    }
    if (topBins.length < 2) continue;

    // 所有物理卡的 top-1 BIN 必须一致
    const sharedBin = topBins[0]!;
    if (!topBins.every((b) => b === sharedBin)) continue;

    const [ct, passIdStr] = gk.split("|") as [string, string];
    const passId = Number(passIdStr);
    const cardList = [...cards.keys()].join("、");
    return {
      severity: "warning",
      title: `同型号卡 ${ct} 在 pass${passId} 均以 BIN${sharedBin} 为主导失效`,
      detail:
        `${cards.size} 张同型号探针卡（${cardList}）在 pass${passId} 的主导坏 BIN 均为 BIN${sharedBin}。` +
        `不同物理卡出现相同 BIN 失效模式，已排除探针卡个体因素，` +
        `**极度可能是测试机台或测试程序问题**——建议优先核查机台状态与测试程序版本，` +
        `并对比各张卡对应槽位的 DUT 坏 die 分布（可请求晶圆图或 DUT×BIN 关系图）。`,
      suggestChart: true,
    };
  }
  return null;
}

/**
 * 从 toolPayload 提取数据规律。无规律时返回 null，不强求输出。
 * 供 buildDeterministicJbTables 在适当模式下追加。
 */
export function detectAndFormatDataPatterns(
  toolPayload: Record<string, unknown>
): string | null {
  const compact = toolPayload["slotBadBinsCompact"] as SlotBadBinsCompactEntry[] | undefined;
  const rank = toolPayload["lotYieldRankByTestEnd"] as LotRankEntry[] | undefined;

  const found: DetectedPattern[] = [];
  if (rank?.length) {
    const t = detectYieldDeclineTrend(rank); if (t) found.push(t);
    const s = detectPersistentBadSlot(rank); if (s) found.push(s);
  }
  if (compact?.length) {
    const d = detectDominantBin(compact); if (d) found.push(d);
    const tp = detectTemperatureSensitivity(compact); if (tp) found.push(tp);
    const cs = detectCardChangeBinShift(compact); if (cs) found.push(cs);
    const sct = detectSameCardTypeSameBin(compact); if (sct) found.push(sct);
  }
  if (found.length === 0) return null;

  const lines = found.map((p) => {
    const icon = p.severity === "warning" ? "⚠️" : "💡";
    return `- ${icon} **${p.title}**：${p.detail}`;
  });
  return lines.join("\n");
}

/**
 * 合并「聚集性/突增坏 bin 警示」与「AI 自动规律识别」为一节，放在输出末尾。
 * 两者均无数据时返回 null。
 */
function formatAlertsAndPatternsSection(
  toolPayload: Record<string, unknown>
): string | null {
  const parts: string[] = [];
  const clusterMd = toolPayload["clusteredBadBinAlertsMarkdown"];
  if (typeof clusterMd === "string" && clusterMd.trim()) {
    parts.push(clusterMd.trim());
  }
  const patterns = detectAndFormatDataPatterns(toolPayload);
  if (patterns) parts.push(patterns);
  if (parts.length === 0) return null;
  return `### 🔍 警示 / 规律识别\n\n${parts.join("\n\n")}`;
}

/** 在基础输出后追加规律识别段（base 为 null 时直接返回 null）。 */
function withPatterns(
  base: string | null,
  toolPayload: Record<string, unknown>
): string | null {
  if (!base) return base;
  const patterns = detectAndFormatDataPatterns(toolPayload);
  return patterns ? `${base}\n\n${patterns}` : base;
}

/** generic / slot_pass_yield 模式：在 overview 后追加合并警示+规律节。 */
function withAlertsAndPatterns(
  base: string | null,
  toolPayload: Record<string, unknown>
): string | null {
  if (!base) return base;
  const section = formatAlertsAndPatternsSection(toolPayload);
  return section ? `${base}\n\n${section}` : base;
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
  "⚠️ 本次调用无工具可用，**禁止输出任何工具调用格式**（含 <tool_call>、<｜tool▁、JSON function call 等）；直接输出纯文字。\n\n" +
  "**输出格式（严格遵守）**\n" +
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
