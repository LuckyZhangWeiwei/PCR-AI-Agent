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

/** 用户问某个具体 BIN 编号是哪张探针卡测出来的（逐卡归因）。 */
export function isBinCardAttributionQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (!/\bBIN\s*\d{1,3}\b|\bbin\s*\d{1,3}\b/i.test(t)) return false;
  return /哪张.*卡|哪个.*卡|是.*卡|哪块卡|用的.*卡|什么.*卡|属于.*卡|哪张.*探针/i.test(t);
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
    mode === "bin_card_attribution"
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
  if (isSlotPassYieldQuestion(userMessage)) return "slot_pass_yield";
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

/** 根据用户问题从工具 JSON 选出应直出的 markdown 表（不改写）。 */
export function buildDeterministicJbTables(
  userMessage: string,
  toolPayload: Record<string, unknown>
): string | null {
  const digest = digestFromPayload(toolPayload);
  const mode = detectJbReplyMode(userMessage);

  if (mode === "bin_card_attribution") {
    const bin = extractBinFromUserText(userMessage);
    if (bin != null) {
      const compact = toolPayload["slotBadBinsCompact"] as SlotBadBinsCompactEntry[] | undefined;
      if (compact?.length) {
        const lot = String(toolPayload["lot"] ?? "").trim() || undefined;
        const md = buildBinCardAttributionMarkdown(compact, bin, lot);
        if (md) return md;
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
