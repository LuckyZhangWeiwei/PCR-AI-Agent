// pcr-ai-api/src/lib/agent/agentJbDeterministicReply.ts
/** 总结轮：服务端直出预计算表，LLM 仅写简短解读（禁止改数字）。 */

import {
  formatCardByPassIdMarkdown,
  formatLotYieldOverviewMarkdown,
  formatLotTesterMarkdown,
  formatTestInterruptCountMarkdown,
  formatSlotYieldInterruptMarkdown,
} from "./agentJbHistoryCompact.js";
import type {
  CardByPassIdEntry,
  LotTesterEntry,
  RecentLotByTestEndEntry,
  SlotBadBinsCompactEntry,
} from "./agentJbBinFormat.js";
import { jbWrappedIsEmptyQuery } from "./agentJbBinFormat.js";
import type { ClusteredBadBinAlert } from "./agentJbBadBinCluster.js";
import type { SlotYieldSummaryEntry } from "../jbYieldCalc.js";
import { buildBinSlotTrendMarkdownOnDemand } from "./agentJbBinTrend.js";
import { getJbToolRawJson } from "./agentJbSessionCache.js";
import { extractLotFromUserText } from "./agentInfWaferMapTool.js";
import {
  inferDeviceFromText,
  inferMaskFromText,
  inferPlatformFromText,
  inferRecentMonthsWindow,
  inferTesterIdFromText,
} from "./agentQueryScope.js";

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
  | "lot_listing"
  | "per_slot_bin_ranking"
  | "card_test_overview"
  | "card_dut_question"
  | "generic";

/** Yield Monitor 侧 lot 条目（合并进 lot 列表表）。 */
export type YmLotListingEntry = {
  lot: string;
  device?: string;
  testEnd?: string | null;
};

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

/**
 * 用户要求枚举多个 lot/批次（非 lot 内 wafer/slot 列表）。
 * 例：「近3个月测试的所有 lot 都列出来」「有哪些 lot」。
 */
export function isLotListingQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // lot 内 wafer/slot 枚举（SEC_WAFER_ENUM），不是跨 lot 列表
  if (
    /列出所有\s*wafer|有哪些\s*wafer|每片\s*wafer|逐片|各\s*片/i.test(t) &&
    !/所有\s*lot|全部\s*lot|所有批次|全部批次/i.test(t)
  ) {
    return false;
  }
  if (/所有\s*lot|全部\s*lot|所有批次|全部批次/i.test(t)) return true;
  if (/^全部列(出|表|清单)?$/i.test(t)) return true;
  if (/全部列(出|表)/i.test(t) && !/wafer|片|slot/i.test(t)) return true;
  if (/都列出来|都列出|列出来/i.test(t) && /lot|批次/i.test(t)) return true;
  if (/(列出|有哪些|显示|枚举).*(lot|批次)/i.test(t)) return true;
  if (/(lot|批次).*(列出|有哪些|清单|列表)/i.test(t)) return true;
  // 口语「(都)测试了什么lot / 测了哪些lot / 都有什么批次」——跨 lot 列表，非单 lot 概况。
  // 「什么/哪些/多少」紧接 lot/批次（含「什么lot」「哪些批次」）。wafer/片/slot 是 lot 内枚举，排除。
  if (/(什么|哪些|多少)\s*(lot|批次)/i.test(t) && !/wafer|片|slot/i.test(t)) return true;
  // 最近 N 个 lot + 良率/yield — 仍是跨 lot 枚举（scope 由 resolveJbListingScope 决定）
  if (
    /(最近|最新).*\d*\s*(个)?\s*(lot|批次)/i.test(t) &&
    /(良率|yield|良品率|评价)/i.test(t)
  ) {
    return true;
  }
  // 「什么/哪些/多少」与 lot/批次 分离但同句（「都测试了哪些批次」「跑了多少个lot」）。
  if (
    /(都|测试了|测了|跑了|做了|包含|涉及|有)\s*(什么|哪些|多少)/i.test(t) &&
    /(lot|批次)/i.test(t) &&
    !/wafer|片|slot/i.test(t)
  ) {
    return true;
  }
  return false;
}

/** lot 列表 + fail bin / 嫌疑 DUT 等明细列（比纯 lot 枚举更宽）。 */
export function isLotDetailListingQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (isLotListingQuestion(t)) {
    if (/(fail\s*bin|failed\s*bin|坏\s*bin|失效\s*bin|嫌疑.*dut|嫌疑\s*dut)/i.test(t)) {
      return true;
    }
    if (/\d+\s*个\s*lot/i.test(t)) return true;
  }
  if (/^全部列(出|表|清单)?$/i.test(t)) return true;
  if (/全部列(出|表)/i.test(t) && !/wafer|片|slot/i.test(t)) return true;
  if (
    /(fail\s*bin|failed\s*bin|坏\s*bin|失效\s*bin)/i.test(t) &&
    /(lot|批次)/i.test(t) &&
    /(列|清单|列出来)/i.test(t)
  ) {
    return true;
  }
  if (/嫌疑.*dut/i.test(t) && /(列|清单)/i.test(t)) return true;
  return false;
}

function parseDutNumbersFromTriggerLabel(label: string): number[] {
  const out: number[] = [];
  for (const m of label.matchAll(/dut#\s*(\d+)/gi)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) out.push(n);
  }
  return out;
}

/** YM 各 lot 报警次数（aggregate + 明细行合并）。 */
export function extractYmAlarmCountByLot(
  history: Array<{ role?: string; name?: string; content?: string | null }>
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of history) {
    if (m.role !== "tool") continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(String(m.content ?? "")) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (m.name === "aggregate_yield_triggers") {
      const groups = o["groups"] as Array<Record<string, unknown>> | undefined;
      for (const g of groups ?? []) {
        const lot = String(g["lotId"] ?? g["LOTID"] ?? "").trim();
        const count = Number(g["count"] ?? g["CNT"] ?? 0);
        if (lot && count > 0) counts.set(lot, (counts.get(lot) ?? 0) + count);
      }
    }
    if (m.name === "query_yield_triggers") {
      const rows = o["rows"] as Array<Record<string, unknown>> | undefined;
      for (const r of rows ?? []) {
        const lot = String(r["LOTID"] ?? r["lotId"] ?? "").trim();
        if (lot) counts.set(lot, (counts.get(lot) ?? 0) + 1);
      }
    }
  }
  return counts;
}

/** YM 各 lot 嫌疑 DUT（从 TRIGGER_LABEL 解析 dut#）。 */
export function extractYmSuspectDutsByLot(
  history: Array<{ role?: string; name?: string; content?: string | null }>
): Map<string, string[]> {
  const byLot = new Map<string, Set<number>>();
  for (const m of history) {
    if (m.role !== "tool" || m.name !== "query_yield_triggers") continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(String(m.content ?? "")) as Record<string, unknown>;
    } catch {
      continue;
    }
    const rows = o["rows"] as Array<Record<string, unknown>> | undefined;
    for (const r of rows ?? []) {
      const lot = String(r["LOTID"] ?? r["lotId"] ?? "").trim();
      const label = String(r["TRIGGER_LABEL"] ?? r["triggerLabel"] ?? "");
      if (!lot || !label) continue;
      const duts = parseDutNumbersFromTriggerLabel(label);
      if (!duts.length) continue;
      if (!byLot.has(lot)) byLot.set(lot, new Set());
      for (const d of duts) byLot.get(lot)!.add(d);
    }
  }
  const out = new Map<string, string[]>();
  for (const [lot, duts] of byLot) {
    out.set(
      lot,
      [...duts].sort((a, b) => a - b).map((d) => `DUT${d}`)
    );
  }
  return out;
}

type BinTotalsEntry = { lot: string; badBins?: Array<{ bin: number; dieCount: number }> };

/** JB 各 lot TOP fail bin（payload binTotalsByLot + history aggregate_jb_bins）。 */
export function extractTopFailBinByLot(
  toolPayload: Record<string, unknown>,
  history: Array<{ role?: string; name?: string; content?: string | null }>
): Map<string, string> {
  const byLot = new Map<string, Map<number, number>>();

  const binTotals = toolPayload["binTotalsByLot"] as BinTotalsEntry[] | undefined;
  for (const e of binTotals ?? []) {
    const lot = String(e.lot ?? "").trim();
    if (!lot) continue;
    for (const b of e.badBins ?? []) {
      if (!byLot.has(lot)) byLot.set(lot, new Map());
      const m = byLot.get(lot)!;
      m.set(b.bin, (m.get(b.bin) ?? 0) + b.dieCount);
    }
  }

  for (const m of history) {
    if (m.role !== "tool" || m.name !== "aggregate_jb_bins") continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(String(m.content ?? "")) as Record<string, unknown>;
    } catch {
      continue;
    }
    const groups = o["groups"] as Array<Record<string, unknown>> | undefined;
    for (const g of groups ?? []) {
      const lot = String(g["lot"] ?? g["LOT"] ?? "").trim();
      const binRaw = g["bin"] ?? g["BIN"];
      const bin = Number(binRaw);
      const count = Number(g["count"] ?? g["CNT"] ?? 0);
      if (!lot || !Number.isFinite(bin) || count <= 0) continue;
      if (!byLot.has(lot)) byLot.set(lot, new Map());
      const mp = byLot.get(lot)!;
      mp.set(bin, (mp.get(bin) ?? 0) + count);
    }
  }

  const out = new Map<string, string>();
  for (const [lot, bins] of byLot) {
    const top = [...bins.entries()].sort((a, b) => b[1] - a[1])[0];
    out.set(lot, top ? `BIN${top[0]}（${top[1]}）` : "—");
  }
  return out;
}

export type LotListingContext = {
  ymLots?: YmLotListingEntry[];
  ymAlarmCountByLot?: Map<string, number>;
  ymSuspectDutsByLot?: Map<string, string[]>;
  topFailBinByLot?: Map<string, string>;
  detailed?: boolean;
  /** 表头 scope 标签（来自 resolveJbListingScope）。 */
  scopeLabel?: string;
  /** 列/行数呈现（良率列、topN、平均良率）。 */
  presentation?: LotListingPresentation;
};

/** lot 列表表的呈现选项（与查询 scope 解耦）。 */
export type LotListingPresentation = {
  topN?: number;
  includeYield: boolean;
  includeAverageYield: boolean;
};

const ZH_NUM_LISTING: Record<string, number> = {
  一: 1,
  两: 2,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

export function inferLotListingPresentation(text: string): LotListingPresentation {
  const t = text.trim();
  let topN: number | undefined;
  const nMatch = t.match(/top\s*(\d+)|(\d+)\s*个/i);
  if (nMatch) {
    topN = Math.min(Math.max(1, Number(nMatch[1] ?? nMatch[2])), 50);
  }
  const zhMatch = t.match(/([一两二三四五六七八九十两])\s*个\s*(lot|批次)/i);
  if (!topN && zhMatch) {
    const n = ZH_NUM_LISTING[zhMatch[1]!];
    if (n) topN = n;
  }
  const includeYield = /(良率|yield|良品率|评价)/i.test(t);
  const includeAverageYield =
    /平均.*(良率|yield|良品率)/i.test(t) ||
    (includeYield && topN != null);
  return { topN, includeYield, includeAverageYield };
}

export function buildLotListingContext(
  toolPayload: Record<string, unknown>,
  history: Array<{ role?: string; name?: string; content?: string | null }>
): LotListingContext {
  const ymLots = extractYmLotsFromHistory(history);
  return {
    ymLots,
    ymAlarmCountByLot: extractYmAlarmCountByLot(history),
    ymSuspectDutsByLot: extractYmSuspectDutsByLot(history),
    topFailBinByLot: extractTopFailBinByLot(toolPayload, history),
    detailed: false,
  };
}

/** 从 session history 提取 YM 侧不重复 lot（供 lot 列表与 JB 合并）。 */
export function extractYmLotsFromHistory(
  history: Array<{ role?: string; name?: string; content?: string | null }>
): YmLotListingEntry[] {
  const byLot = new Map<string, YmLotListingEntry>();
  for (const m of history) {
    if (m.role !== "tool" || m.name !== "query_yield_triggers") continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(String(m.content ?? "")) as Record<string, unknown>;
    } catch {
      continue;
    }
    const rows = o["rows"] as Array<Record<string, unknown>> | undefined;
    for (const r of rows ?? []) {
      const lot = String(r["LOTID"] ?? r["lotId"] ?? "").trim();
      if (!lot) continue;
      const device = String(r["DEVICE"] ?? r["device"] ?? "").trim();
      const tsRaw = r["TIME_STAMP"] ?? r["timeStamp"];
      const testEnd =
        tsRaw instanceof Date
          ? tsRaw.toISOString()
          : tsRaw != null && String(tsRaw).trim() !== ""
            ? String(tsRaw)
            : null;
      const prev = byLot.get(lot);
      if (
        !prev ||
        (testEnd && (!prev.testEnd || testEnd.localeCompare(prev.testEnd) > 0))
      ) {
        byLot.set(lot, {
          lot,
          device: device || prev?.device,
          testEnd: testEnd ?? prev?.testEnd ?? null,
        });
      }
    }
  }
  return [...byLot.values()].sort((a, b) =>
    (b.testEnd ?? "").localeCompare(a.testEnd ?? "")
  );
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
  // "各 lot 良率 top5" / "WC13N55Z 各 lot 良率 top5"（A1-4；不含「前5个lot各自的良率」口语对比）
  if (/各\s*lot.*(良率|yield).*(top\s*\d+|前\s*\d+\s*个?)/i.test(t)) return true;
  if (/(top\s*\d+|前\s*\d+\s*个?).*各\s*lot.*(良率|yield)/i.test(t)) return true;
  return false;
}

/** 用户问「哪个 lot 的 BINnn 最多」（须带 lot 维度排行，非纯 bin 总量）。 */
export function isBinLotRankingQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (extractBinFromUserText(t) == null) return false;
  if (extractLotFromUserText(t)) return false;
  return /哪个\s*lot|哪\s*个\s*批次|lot.*最多|哪个批次|哪批/i.test(t);
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
  return /(测试情况|的情况|整体情况|使用情况|历次测试|测试结果|性能|效果怎样|效果怎么样|效果如何)/i.test(
    t
  );
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

/**
 * 用户问**某一片**（上下文指代「这片 / 该片」，未给数字）wafer 的**坏 die 空间聚集**。
 * JB lot 数据无 die 坐标，整 lot 确定性 BIN 趋势表答不了此问题（会落成「套话」）。
 * 命中后 agentLoop 应 bail，交回 LLM（可在下一轮 inf_draw_wafer_map 看空间分布）。
 * 注意：必须是「这片/该片」单片指代——「这批 lot 聚集」走整 lot 警示表，不在此列。
 */
export function isSingleWaferDieClusterQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // 明确给了片号（第N片 / slot N）的另由 single_slot 处理，不在此函数范围
  if (extractSlotFromUserText(t) != null) return false;
  const singleWaferRef =
    /这\s*片|这个\s*wafer|该\s*片|此\s*片|这\s*颗?\s*wafer|这\s*wafer|这\s*一?\s*片/i.test(
      t
    );
  if (!singleWaferRef) return false;
  return /聚集|集中.*分布|分布.*集中|空间.*分布|cluster|扎堆|成片|连片|区域.*集中/i.test(
    t
  );
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
    // fail / failed bin 变体
    /常见.*fail(?:ed)?\s*bin|fail(?:ed)?\s*bin.*常见|主要.*fail(?:ed)?\s*bin|fail(?:ed)?\s*bin.*主要|实测.*fail(?:ed)?\s*bin|fail(?:ed)?\s*bin.*失效|fail(?:ed)?\s*bin.*排|哪些.*fail(?:ed)?\s*bin|fail(?:ed)?\s*bin.*哪些/i.test(t) ||
    // 跨 lot 总坏 die / 总坏 bin 聚合（用户问 device/mask 整体坏 die 分布，不限单 lot）
    /总的?\s*坏\s*die|坏\s*die\s*总|总\s*坏\s*die|累计.*坏\s*die|坏\s*die.*累计|总.*fail.*die|fail.*die.*总/i.test(t) ||
    // 「哪个坏 die / bin 最多」「最多的坏 die / bin」——坏 die 排名的口语问法
    /哪\s*个?.{0,4}坏\s*die.{0,4}最多|坏\s*die.{0,4}最多|最多.{0,4}坏\s*die|哪\s*个?.{0,4}坏\s*bin.{0,4}最多|坏\s*bin.{0,4}最多|最多.{0,4}坏\s*bin|哪\s*个?\s*bin.{0,4}(?:die|颗).{0,4}最多/i.test(t)
  );
}

/** 用户未指定 lot，但 session 缓存是单 lot — 禁止用该 lot 概况答 scoped 问题。 */
export function isCrossLotQuestionMisalignedWithPayload(
  userMessage: string,
  toolPayload: Record<string, unknown>
): boolean {
  if (extractLotFromUserText(userMessage)) return false;
  const payloadLot = String(
    toolPayload["lot"] ?? toolPayload["primaryLot"] ?? ""
  ).trim();
  if (!payloadLot) return false;

  const hasScope =
    Boolean(inferDeviceFromText(userMessage)) ||
    Boolean(inferMaskFromText(userMessage)) ||
    Boolean(inferPlatformFromText(userMessage)) ||
    Boolean(inferTesterIdFromText(userMessage)) ||
    Boolean(inferRecentMonthsWindow(userMessage).testEndFrom) ||
    /这个\s*device|该\s*device|这\s*[三3]\s*个?月|近\s*[三3]\s*个?月|最近\s*[三3]\s*个?月/i.test(
      userMessage
    );

  if (!hasScope) return false;
  return (
    isBadBinRankingQuestion(userMessage) ||
    isLotListingQuestion(userMessage) ||
    /主要|排行|fail|failed|坏\s*bin/i.test(userMessage)
  );
}

/**
 * 用户问 mask/device 级（无具体 lot），但 payload 仅是该 family 的单个 / 限量 lot
 * （multiLotYieldScope 或 distinctLots>1 或 recentLots>1）。此时不能用某一个 lot 的
 * 概况 / 卡归属表代答 mask 全量问题——应改出多 lot 列表或跨 lot 聚合。
 *
 * 与 isCrossLotQuestionMisalignedWithPayload 区别：后者要求「坏 bin 排行 / 列表」类关键词；
 * 本函数面向「测试情况 / 概况 / BINxx 归到哪张卡」这类**未带排行关键词**的 mask 级问题。
 */
/** payload 覆盖多个 lot（multiLotYieldScope / distinctLots>1 / recentLots>1）。 */
export function payloadCoversMultipleLots(
  toolPayload: Record<string, unknown>
): boolean {
  const distinct = Number(
    toolPayload["totalDistinctLots"] ??
      toolPayload["distinctLotCount"] ??
      toolPayload["multiLotDistinctCount"] ??
      0
  );
  const recent = toolPayload["recentLotsByTestEnd"];
  return (
    toolPayload["multiLotYieldScope"] === true ||
    distinct > 1 ||
    (Array.isArray(recent) && recent.length > 1)
  );
}

export function isMaskLevelQuestionOnMultiLotPayload(
  userMessage: string,
  toolPayload: Record<string, unknown>
): boolean {
  if (extractLotFromUserText(userMessage)) return false;
  const hasMaskOrDevice =
    Boolean(inferMaskFromText(userMessage)) ||
    Boolean(inferDeviceFromText(userMessage));
  if (!hasMaskOrDevice) return false;
  return payloadCoversMultipleLots(toolPayload);
}

/**
 * 用户问某探针卡**型号**整体测试情况（4 位数字 + 「卡 / probe card / 型号」，无 `-NN` 具体卡号、
 * 无具体 lot）。如「9416 卡的测试情况」。卡型横跨大量 lot——query_jb_bins(probeCardType) 只回
 * 最新单 lot，绝不能代表整卡型 → bail 交回 LLM 跨 lot/结合 YM 聚合作答。
 * 具体卡号（9416-04）走 card_test_overview / card_dut_question，不在此列。
 */
export function isCardTypeLevelOverviewQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (extractLotFromUserText(t)) return false;
  if (/\b\d{4}-\d{2,3}\b/.test(t)) return false; // 具体卡号另有分支
  if (!/\b\d{4}\b/.test(t)) return false;
  if (!/卡|probe\s*card|型号|card\s*type/i.test(t)) return false;
  return /(测试情况|的情况|整体情况|使用情况|历次测试|测试结果|性能|概况|怎么样|如何)/i.test(t);
}

/**
 * 多张探针卡「测试情况对比」泛问（无具体单 lot、未限定单一深挖卡号），如
 * 「把这4张probecard的测试情况做对比」「这几张卡分别怎样」。equipment 单 lot 卡表会答非所问
 * （只回最新单 lot 的卡/机台）→ bail 交回 LLM 跨卡 / 结合 YM 作答。
 * 「哪张卡良率更差」走 card_yield_compare（需确定性表），不在此列。
 */
export function isMultiCardComparisonQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // ≥2 个完整卡号（dddd-dd）即视为多卡对比——即使没出现「卡」字，且优先于 lot 排除（卡号 9416-01 可能被误当 lot）。
  const cardNums = (t.match(/\d{4}-\d{2,3}/g) ?? []).length;
  if (!/卡|probe\s*card|cardid/i.test(t) && cardNums < 2) return false;
  if (cardNums < 2 && extractLotFromUserText(t)) return false; // 指定单 lot 另走概况
  const multiCard =
    cardNums >= 2 ||
    /(这|那)?\s*[2-9两三四五六七八九]\s*张/.test(t) ||
    /多张|几张|这些卡|各\s*张|每\s*张/i.test(t);
  if (!multiCard) return false;
  return /对比|比较|分别|各自|测试情况|的情况|概况|怎样|如何/i.test(t);
}

/**
 * 跨多 lot 对比/枚举类问题（无具体单 lot）：「前5个lot都用什么卡」「这几个lot各自…」。
 * 本轮若 query_jb_bins 了多个 lot，单 lot 确定性概况会答非所问 → 交回 LLM 用全量历史作答。
 */
export function isMultiLotComparisonQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (extractLotFromUserText(t)) return false; // 指定了具体单 lot 不算
  return /各自|分别|这几个|这些\s*lot|前\s*\d+\s*个?\s*lot|这\s*\d+\s*个?\s*lot|都\s*(用|是|为)|哪些\s*lot|逐个|对比/i.test(
    t
  );
}

/** equipment 直连路由的 DUT 级 bail:问 dut/嫌疑die 时不走单 lot equipment 缓存表,交回 LLM。 */
export function equipmentRouteDutLevelBail(text: string): boolean {
  return /\bdut\b|嫌疑\s*die|哪些?\s*die/i.test(text);
}

/** 把三个 bail 谓词集中成一个决策对象,供 jbRouteResolver 单点产出。
 * 纯聚合：三个字段各自独立调用对应谓词,不做仲裁/互斥。
 * 已知点(留待阶段三派发时处理):多卡对比串(如「这4张卡对比」)会同时令
 * isMultiLotCompare=true(谓词的「对比」关键词双命中)。阶段二无害——多卡 bail
 * 在消费侧(agentLoop ~938)先于多 lot bail(~952)短路;阶段三让 flag 驱动确定性
 * 派发时,需在此引入明确的 flag 优先级并加测试,届时再改为互斥。
 */
export function extractJbIntentFlags(q: string): {
  isMultiCardCompare: boolean;
  isMultiLotCompare: boolean;
  isDutLevel: boolean;
} {
  return {
    isMultiCardCompare: isMultiCardComparisonQuestion(q),
    isMultiLotCompare: isMultiLotComparisonQuestion(q),
    isDutLevel: equipmentRouteDutLevelBail(q),
  };
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
    mode === "lot_listing" ||
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
  // 多卡「测试情况对比」必须先于 equipment：否则「这4张卡对比」被单 lot 卡表劫持（答非所问）。
  if (isMultiCardComparisonQuestion(userMessage)) return "generic";
  if (isTesterMachineQuestion(userMessage) && isProbeCardQuestion(userMessage)) {
    return "equipment";
  }
  if (isProbeCardQuestion(userMessage)) return "equipment";
  if (isTesterMachineQuestion(userMessage)) return "tester_machine";
  if (isInterruptCountQuestion(userMessage)) return "interrupt_count";
  if (isBinTrendQuestion(userMessage)) return "bin_trend";
  if (isBadBinRankingQuestion(userMessage)) return "bad_bin_ranking";
  if (isLotYieldRankingQuestion(userMessage)) return "lot_yield_ranking";
  if (isLotListingQuestion(userMessage)) return "lot_listing";
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

type LotYieldRankRow = {
  lot: string;
  device: string;
  yieldPct: number;
  worstSlot: number;
  worstPassId: number;
  testEnd: string | null;
};

/** 跨 lot 良率表（lotYieldRankByTestEnd；供 lot_listing 与 card_test_overview 共用）。 */
function buildLotYieldRankListingMarkdown(
  rank: LotYieldRankRow[],
  options: {
    scopeTag: string;
    totalLots: number;
    presentation: LotListingPresentation;
  }
): string | null {
  if (!rank.length) return null;
  const { scopeTag, totalLots, presentation } = options;
  const topN = presentation.topN;
  const sorted = [...rank].sort((a, b) =>
    (b.testEnd ?? "").localeCompare(a.testEnd ?? "")
  );
  const slice = topN != null ? sorted.slice(0, topN) : sorted;
  if (!slice.length) return null;

  const rows = [
    "| # | lot | device | 良率% | 最差片 / pass | 测试结束 |",
    "|---:|---|---|---:|---|---|",
    ...slice.map((e, i) => {
      const passLabel = `waferId ${e.worstSlot} / pass${e.worstPassId}`;
      const testEnd = e.testEnd ? String(e.testEnd).slice(0, 10) : "—";
      return `| ${i + 1} | ${e.lot} | ${e.device} | ${e.yieldPct.toFixed(2)}% | ${passLabel} | ${testEnd} |`;
    }),
  ];

  let header = `**测试 lot 良率列表${scopeTag}**`;
  if (topN != null) {
    header =
      `**测试 lot 良率列表${scopeTag}（最近 ${slice.length} 个 lot` +
      (totalLots > slice.length ? `，该范围共 ${totalLots} 个 lot` : "") +
      `，按 TESTEND 降序）**`;
  } else if (totalLots > slice.length) {
    header = `**测试 lot 良率列表${scopeTag}（共 ${totalLots} 个 lot，下表列 ${slice.length} 个）**`;
  }

  let body = `${header}\n\n${rows.join("\n")}`;
  if (presentation.includeAverageYield && slice.length > 0) {
    const avg =
      slice.reduce((s, e) => s + e.yieldPct, 0) / slice.length;
    body += `\n\n**平均良率（上述 ${slice.length} 个 lot）：${avg.toFixed(2)}%**`;
  }
  return body;
}

/** 跨 lot 列表（JB recentLotsByTestEnd + YM 合并；可选 fail bin / 嫌疑 DUT / 良率列）。 */
export function buildRecentLotsListingMarkdown(
  toolPayload: Record<string, unknown>,
  ctx?: Partial<LotListingContext>
): string | null {
  const presentation = ctx?.presentation ?? {
    includeYield: false,
    includeAverageYield: false,
  };
  const rank = toolPayload["lotYieldRankByTestEnd"] as
    | LotYieldRankRow[]
    | undefined;
  const totalDistinct = Number(
    toolPayload["totalDistinctLots"] ??
      toolPayload["distinctLotCount"] ??
      toolPayload["multiLotDistinctCount"] ??
      rank?.length ??
      0
  );

  const scopeTag = ctx?.scopeLabel
    ? `（${ctx.scopeLabel}）`
    : (() => {
        const scopeDevice = String(toolPayload["device"] ?? "").trim();
        const scopeTester = String(toolPayload["testerId"] ?? "").trim();
        const scopeParts = [
          scopeDevice ? `device=${scopeDevice}` : "",
          scopeTester ? `机台=${scopeTester}` : "",
        ].filter(Boolean);
        return scopeParts.length ? `（${scopeParts.join("，")}）` : "";
      })();

  if (presentation.includeYield && rank?.length) {
    return buildLotYieldRankListingMarkdown(rank, {
      scopeTag,
      totalLots: totalDistinct || rank.length,
      presentation,
    });
  }

  const recent = toolPayload["recentLotsByTestEnd"] as
    | RecentLotByTestEndEntry[]
    | undefined;
  const ymLots = ctx?.ymLots;
  const ymAlarm = ctx?.ymAlarmCountByLot ?? new Map<string, number>();
  const ymSuspect = ctx?.ymSuspectDutsByLot ?? new Map<string, string[]>();
  const topFail = ctx?.topFailBinByLot ?? new Map<string, string>();
  const detailed = Boolean(ctx?.detailed);

  type Row = {
    lot: string;
    device: string;
    testEnd: string;
    slotCount: string;
    source: string;
  };
  const rows: Row[] = [];
  const seen = new Set<string>();

  for (const e of recent ?? []) {
    const lot = String(e.lot ?? "").trim();
    if (!lot || seen.has(lot)) continue;
    seen.add(lot);
    const ymCount = ymAlarm.get(lot) ?? 0;
    rows.push({
      lot,
      device: String(e.device ?? "").trim() || "—",
      testEnd: e.testEnd ? String(e.testEnd).slice(0, 10) : "—",
      slotCount:
        typeof e.slotCount === "number" && e.slotCount > 0
          ? String(e.slotCount)
          : "—",
      source: ymCount > 0 ? "JB+YM" : "JB STAR",
    });
  }

  // 单 lot 的 query_jb_bins（如 cardId 仅命中 1 个 JB lot）不进入 recentLotsByTestEnd
  // （multiLotListingFields 仅在 distinctLotCount>1 时保留该字段）→ 该 JB lot 会从列表里消失，
  // 只剩 YM 告警 lot（见 B5）。这里用 payload 主 lot 兜底补一行 JB STAR。
  const primaryLot = String(toolPayload["lot"] ?? "").trim();
  if (primaryLot && !seen.has(primaryLot)) {
    seen.add(primaryLot);
    const ymCount = ymAlarm.get(primaryLot) ?? 0;
    const yieldByPassId = toolPayload["yieldByPassId"] as
      | Array<Record<string, unknown>>
      | undefined;
    const slotCountNum = Array.isArray(yieldByPassId)
      ? Math.max(
          0,
          ...yieldByPassId.map((p) =>
            typeof p["slotCount"] === "number" ? (p["slotCount"] as number) : 0
          )
        )
      : 0;
    rows.push({
      lot: primaryLot,
      device: String(toolPayload["device"] ?? "").trim() || "—",
      testEnd: toolPayload["testEnd"]
        ? String(toolPayload["testEnd"]).slice(0, 10)
        : "—",
      slotCount: slotCountNum > 0 ? String(slotCountNum) : "—",
      source: ymCount > 0 ? "JB+YM" : "JB STAR",
    });
  }

  for (const ym of ymLots ?? []) {
    const lot = String(ym.lot ?? "").trim();
    if (!lot || seen.has(lot)) continue;
    seen.add(lot);
    rows.push({
      lot,
      device: String(ym.device ?? "").trim() || "—",
      testEnd: ym.testEnd ? String(ym.testEnd).slice(0, 10) : "—",
      slotCount: "—",
      source: "仅 YM 告警",
    });
  }

  // YM aggregate 里有、JB 枚举未覆盖的 lot
  for (const [lot, count] of ymAlarm) {
    if (seen.has(lot) || count <= 0) continue;
    seen.add(lot);
    rows.push({
      lot,
      device: "—",
      testEnd: "—",
      slotCount: "—",
      source: "仅 YM 告警",
    });
  }

  if (rows.length === 0) return null;

  rows.sort((a, b) => {
    if (a.testEnd === "—" && b.testEnd !== "—") return 1;
    if (b.testEnd === "—" && a.testEnd !== "—") return -1;
    return b.testEnd.localeCompare(a.testEnd);
  });

  const totalKnown = Math.max(totalDistinct, rows.length);

  const displayRows =
    presentation.topN != null ? rows.slice(0, presentation.topN) : rows;

  let header = `**测试 lot 列表${scopeTag}（共 ${totalKnown} 个 lot，按测试结束时间降序）**`;
  if (totalDistinct > 0 && displayRows.length < totalDistinct) {
    header = `**测试 lot 列表${scopeTag}（共 ${totalDistinct} 个 lot，下表列前 ${displayRows.length} 个）**`;
  } else if (presentation.topN != null) {
    header = `**测试 lot 列表${scopeTag}（最近 ${displayRows.length} 个 lot）**`;
  }

  const tableRows = detailed
    ? [
        "| # | Lot | Device | 测试结束 | 片数 | TOP fail BIN | YM 报警 | 嫌疑 DUT | 数据来源 |",
        "|---:|---|---|---|---:|---|---:|---|---|",
        ...displayRows.map((r, i) => {
          const alarm = ymAlarm.get(r.lot);
          const duts = ymSuspect.get(r.lot)?.join("、") ?? "—";
          const failBin = topFail.get(r.lot) ?? "—";
          return `| ${i + 1} | ${r.lot} | ${r.device} | ${r.testEnd} | ${r.slotCount} | ${failBin} | ${alarm != null && alarm > 0 ? alarm : "—"} | ${duts} | ${r.source} |`;
        }),
      ]
    : [
        "| # | Lot | Device | 测试结束 | 片数 | 数据来源 |",
        "|---:|---|---|---|---:|---|",
        ...displayRows.map((r, i) =>
          `| ${i + 1} | ${r.lot} | ${r.device} | ${r.testEnd} | ${r.slotCount} | ${r.source} |`
        ),
      ];

  const footer =
    rows.length >= 1
      ? "\n\n如需深入分析某批次，请告知上表中的 lot 号。"
      : "";
  return `${header}\n\n${tableRows.join("\n")}${footer}`;
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

  // 4. 近期 lot 测试记录（与 lot_listing 共用良率表）
  const rank = toolPayload["lotYieldRankByTestEnd"] as LotYieldRankRow[] | undefined;
  if (rank?.length) {
    const lotYieldMd = buildLotYieldRankListingMarkdown(rank, {
      scopeTag: `（cardId=${cardId}）`,
      totalLots: rank.length,
      presentation: { topN: 10, includeYield: true, includeAverageYield: false },
    });
    if (lotYieldMd) parts.push(lotYieldMd);
  }

  return parts.length ? parts.join("\n\n") : null;
}

/** 根据用户问题从工具 JSON 选出应直出的 markdown 表（不改写）。 */
export function buildDeterministicJbTables(
  userMessage: string,
  toolPayload: Record<string, unknown>,
  listingCtx?: Partial<LotListingContext>,
  modeOverride?: JbReplyMode
): string | null {
  const mode = modeOverride ?? detectJbReplyMode(userMessage);

  if (mode === "lot_listing") {
    const detailed = isLotDetailListingQuestion(userMessage);
    const presentation =
      listingCtx?.presentation ?? inferLotListingPresentation(userMessage);
    return buildRecentLotsListingMarkdown(toolPayload, {
      ...listingCtx,
      detailed,
      presentation,
    });
  }

  if (jbWrappedIsEmptyQuery(toolPayload)) return null;
  const digest = digestFromPayload(toolPayload);

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
    // mask/device 级「BINxx 集中在哪张卡」但 payload 仅单 lot（如「N55Z bin35 集中到哪张卡」
    // → query_jb_bins(mask) 只回最新 lot DR44436.1W）。单 lot 的 slotBadBinsCompact 不能代表
    // 整个 family，bail → 让上层走 aggregate_jb_bins(mask, groupBy:"bin,cardId") 跨 lot 聚合。
    if (isMaskLevelQuestionOnMultiLotPayload(userMessage, toolPayload)) {
      console.warn(
        `[jbDeterministic/binCardMaskScope] BIN 卡归属问题「${userMessage.slice(0, 40)}」为 mask/device 级，` +
          `但 payload 仅 lot=${String(toolPayload["lot"] ?? "?")}（distinctLots=` +
          `${toolPayload["totalDistinctLots"] ?? toolPayload["distinctLotCount"]}）→ ` +
          `不能用单 lot slotBadBinsCompact 代答；应 aggregate_jb_bins(mask, groupBy:"bin,cardId") 跨 lot 聚合。`
      );
      return null;
    }
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
    if (isCrossLotQuestionMisalignedWithPayload(userMessage, toolPayload)) {
      return null;
    }
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
    // mask/device 级「测试情况 / 概况」但 payload 含多个 lot（如「P11C 最近一个月测试情况」
    // → query_jb_bins(mask) 只锁定最新单 lot）。出该单 lot 概况会答非所问，改出多 lot 列表。
    if (isMaskLevelQuestionOnMultiLotPayload(userMessage, toolPayload)) {
      const listing = buildRecentLotsListingMarkdown(toolPayload, listingCtx);
      if (listing?.trim()) return listing;
    }
    // 卡型级「9416 卡的测试情况」：payload 仅该卡型最新单 lot，不能代表整卡型 →
    // bail 让 LLM 跨 lot 结合 YM 聚合作答（aggregate_yield_triggers 已可按 probeCard 枚举）。
    if (isCardTypeLevelOverviewQuestion(userMessage)) {
      console.warn(
        `[jbDeterministic/cardTypeOverviewBail] 卡型级问题「${userMessage.slice(0, 40)}」` +
          `payload 仅 lot=${String(toolPayload["lot"] ?? "?")}，不能代表整卡型 → 交回 LLM 跨 lot 作答。`
      );
      return null;
    }
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
    if (isCrossLotQuestionMisalignedWithPayload(userMessage, toolPayload)) {
      return null;
    }
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

/** aggregate_jb_bins(groupBy:"bin") → 跨 lot 坏 BIN 排行表。含 lot 维度时返回 null（交 buildMultiLotBinTable）。 */
export function buildAggregateBinRankingMarkdown(
  rawContent: string,
  scopeLabel?: string
): string | null {
  let agg: Record<string, unknown>;
  try {
    agg = JSON.parse(rawContent) as Record<string, unknown>;
  } catch {
    return null;
  }
  const groups = agg["groups"] as Array<Record<string, unknown>> | undefined;
  if (!groups?.length) return null;

  if (groups.some((g) => String(g["lot"] ?? "").trim())) return null;
  // 含 device 维度（groupBy "device,bin"）时纯 BIN 排行会跨 device 求和、丢掉 device 列
  // （见 B1：用户「把 device 也要列出来」却仍只出 BIN 排行）→ 交回 buildBinDeviceAggregateMarkdown。
  if (groups.some((g) => String(g["device"] ?? g["DEVICE"] ?? "").trim())) {
    return null;
  }

  const bins = groups
    .map((g) => {
      const binRaw = g["bin"] ?? g["BIN"];
      const binNum = Number(String(binRaw ?? "").replace(/^BIN/i, ""));
      const count = Number(g["count"] ?? g["CNT"] ?? 0);
      return {
        bin: Number.isFinite(binNum) && binNum > 0 ? binNum : null,
        count,
      };
    })
    .filter((b) => b.bin != null && b.count > 0)
    .sort((a, b) => b.count - a.count);

  if (!bins.length) return null;

  const total = bins.reduce((s, b) => s + b.count, 0);
  const totalRows = Number(agg["totalRowsMatching"] ?? 0);
  const scope = scopeLabel?.trim() || "查询范围";
  const header = `**主要坏 BIN 排行（${scope}，Top ${bins.length}，坏 die 合计 ${total}${totalRows > 0 ? `，匹配 ${totalRows} 行` : ""}）**`;
  const rows = [
    "| # | BIN | 坏 die 颗数 | 占比 |",
    "|---:|---|---:|---:|",
    ...bins.map((b, i) => {
      const pct = total > 0 ? ((b.count / total) * 100).toFixed(1) : "0.0";
      return `| ${i + 1} | BIN${b.bin} | ${b.count} | ${pct}% |`;
    }),
  ];
  // 纯 bin 合计跨该范围全部 lot，无法定位具体批次——引导按 lot 下钻（见 P-D）。
  const footnote =
    "\n\n*以上为查询范围内各 BIN 的坏 die 合计排行（未区分批次）。" +
    "如需定位到具体批次，请问「哪个 lot 的 BIN<n> 最多」（按 bin+lot 排行）。*";
  return `${header}\n\n${rows.join("\n")}${footnote}`;
}

/**
 * aggregate_jb_bins(groupBy:"bin,cardId") 的卡归属渲染。
 * buildAggregateBinRankingMarkdown 只取 bin+count，会把「bin35 在 9416-04/03/01」
 * 渲染成重复的 BIN35 行、丢掉 cardId（用户问「集中在哪张卡」却看不到卡号）。
 * - focusBin 有值（如「bin35 集中在哪张卡」）→ 仅列该 BIN 各卡坏 die 排行。
 * - focusBin 无值（如「9406 各卡对比」）→ bin×card 全表按坏 die 降序。
 * groups 无 cardId 时返回 null，交回 buildAggregateBinRankingMarkdown。
 */
export function buildBinCardAggregateMarkdown(
  rawContent: string,
  scopeLabel?: string,
  focusBin?: number | null
): string | null {
  let agg: Record<string, unknown>;
  try {
    agg = JSON.parse(rawContent) as Record<string, unknown>;
  } catch {
    return null;
  }
  const groups = agg["groups"] as Array<Record<string, unknown>> | undefined;
  if (!groups?.length) return null;
  // 必须含 cardId（即 groupBy 含 cardId）才走本渲染
  if (!groups.some((g) => String(g["cardId"] ?? g["CARDID"] ?? "").trim())) {
    return null;
  }

  type Row = { bin: number; cardId: string; count: number };
  const rows: Row[] = groups
    .map((g) => {
      const binNum = Number(String(g["bin"] ?? g["BIN"] ?? "").replace(/^BIN/i, ""));
      return {
        bin: binNum,
        cardId: String(g["cardId"] ?? g["CARDID"] ?? "").trim(),
        count: Number(g["count"] ?? g["CNT"] ?? 0),
      };
    })
    .filter((r) => Number.isFinite(r.bin) && r.bin > 0 && r.cardId && r.count > 0);
  if (!rows.length) return null;

  const scope = scopeLabel?.trim() || "查询范围";
  const totalRows = Number(agg["totalRowsMatching"] ?? 0);
  const rowsSuffix = totalRows > 0 ? `，匹配 ${totalRows} 行` : "";

  if (focusBin != null) {
    const forBin = rows
      .filter((r) => r.bin === focusBin)
      .sort((a, b) => b.count - a.count);
    if (!forBin.length) return null; // 该 BIN 不在结果里 → 交回通用渲染
    const total = forBin.reduce((s, r) => s + r.count, 0);
    const lines = [
      `**BIN${focusBin} 坏 die 所属探针卡（${scope}，坏 die 合计 ${total}${rowsSuffix}）**`,
      "",
      `| # | 探针卡 (CARDID) | BIN${focusBin} 坏 die 颗数 | 占比 |`,
      "|---:|---|---:|---:|",
      ...forBin.map((r, i) => {
        const pct = total > 0 ? ((r.count / total) * 100).toFixed(1) : "0.0";
        return `| ${i + 1} | ${r.cardId} | ${r.count} | ${pct}% |`;
      }),
    ];
    return lines.join("\n");
  }

  const sorted = rows.sort((a, b) => b.count - a.count).slice(0, 30);
  const total = rows.reduce((s, r) => s + r.count, 0);
  const lines = [
    `**坏 BIN × 探针卡（${scope}，Top ${sorted.length}，坏 die 合计 ${total}${rowsSuffix}）**`,
    "",
    "| # | BIN | 探针卡 (CARDID) | 坏 die 颗数 | 占比 |",
    "|---:|---|---|---:|---:|",
    ...sorted.map((r, i) => {
      const pct = total > 0 ? ((r.count / total) * 100).toFixed(1) : "0.0";
      return `| ${i + 1} | BIN${r.bin} | ${r.cardId} | ${r.count} | ${pct}% |`;
    }),
  ];
  return lines.join("\n");
}

/**
 * aggregate_jb_bins(groupBy:"device,bin") 的 device 归属渲染（镜像 buildBinCardAggregateMarkdown）。
 * buildAggregateBinRankingMarkdown 只取 bin+count，会把含 device 的结果跨 device 求和、丢掉 device 列
 * （见 B1：用户「把 device 也要列出来」却仍只出纯 BIN 排行）。
 * - focusBin 有值 → 仅列该 BIN 在各 device 的坏 die 排行。
 * - focusBin 无值 → bin×device 全表按坏 die 降序（单 device 时每行 device 相同，仍满足「列出 device」诉求）。
 * groups 无 device 时返回 null，交回 buildAggregateBinRankingMarkdown。
 */
export function buildBinDeviceAggregateMarkdown(
  rawContent: string,
  scopeLabel?: string,
  focusBin?: number | null
): string | null {
  let agg: Record<string, unknown>;
  try {
    agg = JSON.parse(rawContent) as Record<string, unknown>;
  } catch {
    return null;
  }
  const groups = agg["groups"] as Array<Record<string, unknown>> | undefined;
  if (!groups?.length) return null;
  // 必须含 device（即 groupBy 含 device）才走本渲染
  if (!groups.some((g) => String(g["device"] ?? g["DEVICE"] ?? "").trim())) {
    return null;
  }

  type Row = { bin: number; device: string; count: number };
  const rows: Row[] = groups
    .map((g) => {
      const binNum = Number(String(g["bin"] ?? g["BIN"] ?? "").replace(/^BIN/i, ""));
      return {
        bin: binNum,
        device: String(g["device"] ?? g["DEVICE"] ?? "").trim(),
        count: Number(g["count"] ?? g["CNT"] ?? 0),
      };
    })
    .filter((r) => Number.isFinite(r.bin) && r.bin > 0 && r.device && r.count > 0);
  if (!rows.length) return null;

  const scope = scopeLabel?.trim() || "查询范围";
  const totalRows = Number(agg["totalRowsMatching"] ?? 0);
  const rowsSuffix = totalRows > 0 ? `，匹配 ${totalRows} 行` : "";

  if (focusBin != null) {
    const forBin = rows
      .filter((r) => r.bin === focusBin)
      .sort((a, b) => b.count - a.count);
    if (!forBin.length) return null; // 该 BIN 不在结果里 → 交回通用渲染
    const total = forBin.reduce((s, r) => s + r.count, 0);
    const lines = [
      `**BIN${focusBin} 坏 die 所属 device（${scope}，坏 die 合计 ${total}${rowsSuffix}）**`,
      "",
      `| # | Device | BIN${focusBin} 坏 die 颗数 | 占比 |`,
      "|---:|---|---:|---:|",
      ...forBin.map((r, i) => {
        const pct = total > 0 ? ((r.count / total) * 100).toFixed(1) : "0.0";
        return `| ${i + 1} | ${r.device} | ${r.count} | ${pct}% |`;
      }),
    ];
    return lines.join("\n");
  }

  const sorted = rows.sort((a, b) => b.count - a.count).slice(0, 30);
  const total = rows.reduce((s, r) => s + r.count, 0);
  const lines = [
    `**坏 BIN × Device（${scope}，Top ${sorted.length}，坏 die 合计 ${total}${rowsSuffix}）**`,
    "",
    "| # | BIN | Device | 坏 die 颗数 | 占比 |",
    "|---:|---|---|---:|---:|",
    ...sorted.map((r, i) => {
      const pct = total > 0 ? ((r.count / total) * 100).toFixed(1) : "0.0";
      return `| ${i + 1} | BIN${r.bin} | ${r.device} | ${r.count} | ${pct}% |`;
    }),
  ];
  return lines.join("\n");
}

/**
 * 用户问「哪个 lot BINnn 最多」：aggregate_jb_bins(groupBy 含 bin,lot[,cardId]) 结果里
 * 按**指定 bin** 在各 lot 的坏 die 颗数排 lot（而非 multiLotBinTable 的「坏die总量」口径——
 * 后者会把总坏die多但该 bin 少的 lot 误排第一，如 DR41662.1J(bin35=968) 排在
 * DR42190.1X(bin35=1402) 之前）。无 lot 维度或该 bin 不在结果里 → 返回 null 交回其它渲染。
 * 若 groups 含 cardId，附「探针卡」列直接回答「都是用什么卡测试的」。
 */
export function buildBinFocusedLotRankingMarkdown(
  rawContent: string,
  focusBin: number | null | undefined,
  scopeLabel?: string,
  restrictLots?: string[]
): string | null {
  if (focusBin == null) return null;
  let agg: Record<string, unknown>;
  try {
    agg = JSON.parse(rawContent) as Record<string, unknown>;
  } catch {
    return null;
  }
  const groups = agg["groups"] as Array<Record<string, unknown>> | undefined;
  if (!groups?.length) return null;
  // 必须含 lot 维度（否则交回 buildBinCardAggregateMarkdown / multiLotBinTable）
  if (!groups.some((g) => String(g["lot"] ?? g["LOT"] ?? "").trim())) return null;
  const hasCard = groups.some((g) => String(g["cardId"] ?? g["CARDID"] ?? "").trim());

  // 用户点名了多个具体 lot（如「DR44039.1Y、DR44040.1R… 这4个lot 有测出 bin35吗」）→
  // 仅保留这些 lot，并对没出现的 lot 显式补 0 行，直接回答「有没有测出」（见 B3）。
  const restrictSet =
    restrictLots && restrictLots.length >= 2
      ? new Set(restrictLots.map((l) => l.toUpperCase()))
      : null;

  type LotAgg = { lot: string; count: number; cards: Map<string, number> };
  const byLot = new Map<string, LotAgg>();
  for (const g of groups) {
    const binNum = Number(String(g["bin"] ?? g["BIN"] ?? "").replace(/^BIN/i, ""));
    if (binNum !== focusBin) continue;
    const lot = String(g["lot"] ?? g["LOT"] ?? "").trim();
    if (!lot) continue;
    if (restrictSet && !restrictSet.has(lot.toUpperCase())) continue;
    const count = Number(g["count"] ?? g["CNT"] ?? 0);
    if (!(count > 0)) continue;
    const cardId = String(g["cardId"] ?? g["CARDID"] ?? "").trim();
    let entry = byLot.get(lot);
    if (!entry) {
      entry = { lot, count: 0, cards: new Map() };
      byLot.set(lot, entry);
    }
    entry.count += count;
    if (cardId) entry.cards.set(cardId, (entry.cards.get(cardId) ?? 0) + count);
  }
  // 限定 lot 集合：被点名但本 BIN 颗数为 0 的 lot 也要列出（答「没测出」）。
  if (restrictSet) {
    for (const l of restrictLots!) {
      if (![...byLot.keys()].some((k) => k.toUpperCase() === l.toUpperCase())) {
        byLot.set(l, { lot: l, count: 0, cards: new Map() });
      }
    }
  }
  const ranked = [...byLot.values()].sort((a, b) => b.count - a.count);
  if (!ranked.length) return null;

  const scope = scopeLabel?.trim() || "查询范围";
  const total = ranked.reduce((s, r) => s + r.count, 0);
  const scopeHint = restrictSet ? `指定 ${restrictSet.size} 个 lot，` : "";
  const header = hasCard
    ? `| # | Lot | BIN${focusBin} 坏 die 颗数 | 占比 | 探针卡 |`
    : `| # | Lot | BIN${focusBin} 坏 die 颗数 | 占比 |`;
  const divider = hasCard ? "|---:|---|---:|---:|---|" : "|---:|---|---:|---:|";
  const lines = [
    `**各 lot BIN${focusBin} 坏 die 排行（${scope}，${scopeHint}坏 die 合计 ${total}）**`,
    "",
    header,
    divider,
    ...ranked.map((r, i) => {
      const pct = total > 0 ? ((r.count / total) * 100).toFixed(1) : "0.0";
      if (!hasCard) return `| ${i + 1} | ${r.lot} | ${r.count} | ${pct}% |`;
      const cards =
        [...r.cards.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([c]) => c)
          .join(", ") || "—";
      return `| ${i + 1} | ${r.lot} | ${r.count} | ${pct}% | ${cards} |`;
    }),
  ];
  return lines.join("\n");
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
  // DUT 集中度判别表（仅在 clusteredBadBinAlerts 触发自动注入时存在）
  const dutMd = toolPayload["dutConcentrationMarkdown"];
  if (typeof dutMd === "string" && dutMd.trim()) {
    parts.push(dutMd.trim());
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

/**
 * lot / wafer / yield 数据来源说明脚注：所有服务端确定性数据表均基于首测（first test），
 * 不含 Auto retest（重测）。追加在数据块下方，随数据进消息内容（导出历史时一并保留）。
 */
export const FIRST_TEST_ONLY_NOTE =
  "> *所有数据只包含 first test，不包含 Auto retest*";

/**
 * 在确定性数据块末尾追加 {@link FIRST_TEST_ONLY_NOTE}。**幂等**：已含该脚注或空串则原样返回，
 * 故可在数据块构造点安全调用，即使同一内容被多处包裹也不会重复追加。
 */
export function stampFirstTestNote(dataBlock: string): string {
  if (!dataBlock || dataBlock.includes(FIRST_TEST_ONLY_NOTE)) return dataBlock;
  return `${dataBlock}\n\n${FIRST_TEST_ONLY_NOTE}`;
}

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
        if ((hit.testerIds?.length ?? 0) > 1) {
          lines.push(`本批该 lot 还曾出现机台：${hit.testerIds!.join(", ")}`);
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
