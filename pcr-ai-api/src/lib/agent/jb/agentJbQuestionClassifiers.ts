// pcr-ai-api/src/lib/agent/jb/agentJbQuestionClassifiers.ts
/** JB STAR 确定性直答的问句分类器（isXxxQuestion）+ 意图 flag + detectJbReplyMode。 */

import { extractLotFromUserText } from "../tools/agentInfWaferMapTool.js";
import {
  inferDeviceFromText,
  inferMaskFromText,
  inferPlatformFromText,
  inferRecentMonthsWindow,
  inferTesterIdFromText,
} from "../agentQueryScope.js";

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
  | "good_bin_value"
  | "generic";

/** 用户问「good bin / 良品 bin 是多少」（具体字段问句，非 lot 概况）。 */
export function isGoodBinValueQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (!/(?:good\s*bin|goodbin|良品\s*bin)/i.test(t)) return false;
  if (!/(?:是多少|哪个|什么|几号|多少|哪一个)/i.test(t)) return false;
  // 「BIN55 是 good bin 吗」类确认问法 → 不走直答（勿把「是多少」里的「是」误判为确认）
  if (/(?:是|是否|算|属于)(?!多少).{0,16}(?:good\s*bin|goodbin|良品\s*bin)/i.test(t)) return false;
  if (/(?:good\s*bin|goodbin|良品\s*bin).{0,8}(?:吗\s*$|吗？|吗\?)/i.test(t)) return false;
  // 趋势/数量变化类 → 放行 LLM
  if (/趋势|走势|变化|分布/i.test(t)) return false;
  return true;
}

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

/**
 * 「探针卡+机台组合」「表现/组合排名」类问法属于跨卡跨机台的组合排名分析
 * （aggregate_probe_card_tester_performance 的目标场景），不是本模块要抢答的
 * 单 lot 两张卡良率对比——即使句子里同时出现「探针卡」与「最好/最差」也不能
 * 算 card_yield_compare，否则 resolveDispatch 会在 LLM 前把它直发成
 * query_jb_bins，新工具永远选不到（2026-07-11 真实 MiniMax-M2.5 联调复现）。
 */
/** 探针卡+机台「组合排名」类问法（aggregate_probe_card_tester_performance 目标场景）。 */
export function isProbeCardComboRankingQuestion(text: string): boolean {
  return /组合|机台.*(?:卡|探针)|(?:卡|探针).*机台/i.test(text);
}

/** @deprecated 内部别名，与 isProbeCardComboRankingQuestion 相同 */
function isCardComboRankingQuestion(text: string): boolean {
  return isProbeCardComboRankingQuestion(text);
}

/** 用户比较两张或多张探针卡的良率/坏 die（哪张更差/更好）。 */
export function isCardYieldCompareQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (isCardComboRankingQuestion(t)) return false;
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
 * 探针卡/机台组合表现排名类问法 — PRE_LLM 直调 aggregate_probe_card_tester_performance。
 * 不含单 lot 两张卡良率对比（card_yield_compare）。
 */
export function isProbeCardTesterPerformanceQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (isCardComboRankingQuestion(t)) return true;
  // 「和什么卡什么机台搭配最合适」— 卡+机台搭配/最合适，与「组合排名」同工具
  if (
    /(?:卡|探针).*(?:机台|tester)|(?:机台|tester).*(?:卡|探针)/i.test(t) &&
    /(?:搭配|匹配|组合|最合适|最好|最佳|推荐)/i.test(t)
  ) {
    return true;
  }
  // 「用什么/哪个 probecard/探针卡 … 最好/最佳」— 跨 lot 卡排名，非单 lot 卡枚举
  if (
    /(?:什么|哪个|哪张|哪种)\s*(?:探针\s*卡|probe\s*card|probecard)/i.test(t) &&
    /(?:最好|最佳|最差|推荐|合适)/i.test(t)
  ) {
    return true;
  }
  // 「… probecard/探针卡 测试最好」— 常见口语（探针卡哪个最差 仍走 card_yield_compare）
  if (
    /(?:探针\s*卡|probe\s*card|probecard).*(?:测试)?(?:最好|最佳)/i.test(t) &&
    !/(?:探针\s*卡|probe\s*card|probecard).*?(?:什么|哪个|哪张|哪种).*?(?:最差|更差)/i.test(t)
  ) {
    return true;
  }
  if (isCardYieldCompareQuestion(t) && !isProbeCardComboRankingQuestion(t)) return false;
  if (/探针卡.*(?:表现|组合).*(?:排名|最好|最差)/i.test(t)) return true;
  if (/(?:组合|表现).*(?:排名).*(?:探针卡|机台)/i.test(t)) return true;
  if (/最好的探针卡\+?机台|探针卡\+机台组合/i.test(t)) return true;
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

/**
 * lot 概况已含服务端「警示 / 规律识别」时跳过慢 LLM 解读。
 * 典型路径：测试情况 → JB 表 + DUT 追加后总耗时易超客户端超时；规律节已含工程提示。
 */
export function lotOverviewSkipsCommentaryAfterAlerts(
  mode: JbReplyMode,
  tablesMarkdown: string,
  payload: Record<string, unknown>
): boolean {
  if (mode !== "lot_overview") return false;
  if (tablesMarkdown.includes("### 🔍 警示") || tablesMarkdown.includes("### 警示")) {
    return true;
  }
  const clusterMd = payload["clusteredBadBinAlertsMarkdown"];
  if (typeof clusterMd === "string" && clusterMd.trim()) return true;
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
    mode === "card_dut_question" ||
    mode === "good_bin_value"
    // "per_slot_bin_ranking" 已移出：50 行跨片数据 LLM 最有价值（BIN 规律/异常片/pass 对比）
    // "card_yield_compare" 不跳过：LLM 需要推断「哪张卡更差」
  );
}

export function detectJbReplyMode(userMessage: string): JbReplyMode {
  // 条件性/假设性推理问题（「如果两张卡都...下一步怎么做」）须走 LLM，不能被 equipment 短路
  if (isConditionalReasoningQuestion(userMessage)) return "generic";
  // Specific attribution/compare modes take priority over generic equipment check
  if (isBinCardAttributionQuestion(userMessage)) return "bin_card_attribution";
  if (isCardYieldCompareQuestion(userMessage)) return "card_yield_compare";
  // 跨 lot 探针卡排名（aggregate_probe_card_tester_performance）不能走 equipment 单 lot 卡表
  if (isProbeCardTesterPerformanceQuestion(userMessage)) return "generic";
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
  if (isGoodBinValueQuestion(userMessage)) return "good_bin_value";
  if (isLotOverviewQuestion(userMessage)) return "lot_overview";
  return "generic";
}
