import type { JbReplyMode } from "../../../src/lib/agent/agentJbDeterministicReply.js";

export interface GoldenCase {
  question: string;
  expected: {
    mode: JbReplyMode;
    focusBin?: number;
    isMultiCardCompare: boolean;
    isMultiLotCompare: boolean;
    isDutLevel: boolean;
  };
  seed: string;
}

const F = (
  over: Partial<GoldenCase["expected"]> & { mode: JbReplyMode }
): GoldenCase["expected"] => ({
  isMultiCardCompare: false,
  isMultiLotCompare: false,
  isDutLevel: false,
  ...over,
});

export const routingGolden: GoldenCase[] = [
  // ── bin_card_attribution ─────────────────────────────────────────────
  {
    question: "n55z 哪个卡测出bin35 多",
    expected: F({ mode: "bin_card_attribution", focusBin: 35 }),
    seed: "log mqygf9mq turn1 所答非所问",
  },
  {
    question: "BIN35 集中在哪张卡",
    expected: F({ mode: "bin_card_attribution", focusBin: 35 }),
    seed: "SEC_BIN_ON_CARD",
  },
  {
    question: "各探针卡 BIN35 颗数对比",
    expected: F({ mode: "bin_card_attribution", focusBin: 35 }),
    seed: "SEC_BIN_ON_CARD",
  },
  {
    question: "BIN7 主要是哪块卡打出来的",
    expected: F({ mode: "bin_card_attribution", focusBin: 7 }),
    seed: "SEC_BIN_ON_CARD phrasing variant 哪块卡",
  },
  {
    question: "BIN66 属于哪些探针卡",
    expected: F({ mode: "bin_card_attribution", focusBin: 66 }),
    seed: "SEC_BIN_ON_CARD phrasing variant 属于",
  },
  {
    question: "bin10 和哪些探针有关",
    expected: F({ mode: "bin_card_attribution", focusBin: 10 }),
    seed: "SEC_BIN_ON_CARD phrasing variant 有关",
  },

  // ── equipment ────────────────────────────────────────────────────────
  {
    question: "DR44436.1W 用几号卡测试的",
    expected: F({ mode: "equipment" }),
    seed: "routing.scenarios route-equipment-single-lot",
  },
  {
    question: "DR44435.1C 用的什么卡",
    expected: F({ mode: "equipment" }),
    seed: "isProbeCardQuestion variant 用的什么卡",
  },
  {
    question: "这个lot哪张探针卡",
    expected: F({ mode: "equipment" }),
    seed: "isProbeCardQuestion variant 哪张探针卡",
  },
  {
    question: "这lot哪些die是嫌疑die",
    expected: F({ mode: "equipment", isDutLevel: true }),
    seed: "equipment DUT bail",
  },
  {
    question: "DR44436.1W 用什么卡 哪个dut出问题了",
    expected: F({ mode: "equipment", isDutLevel: true }),
    seed: "equipment probe+DUT combined isDutLevel=true",
  },

  // ── lot_listing ──────────────────────────────────────────────────────
  {
    question: "都测试了什么lot",
    expected: F({ mode: "lot_listing" }),
    seed: "P-B routing.scenarios",
  },
  {
    question: "9416-04 最近两个月测试的lot 列出来",
    expected: F({ mode: "lot_listing" }),
    seed: "log mqygf9mq turn3",
  },
  {
    question: "有哪些批次",
    expected: F({ mode: "lot_listing" }),
    seed: "isLotListingQuestion 有哪些批次",
  },
  {
    question: "全部lot列出来",
    expected: F({ mode: "lot_listing" }),
    seed: "isLotListingQuestion 全部lot列出来",
  },
  {
    question: "这个device所有lot都列出",
    expected: F({ mode: "lot_listing" }),
    seed: "isLotListingQuestion 所有lot列出",
  },

  // ── per_slot_bin_ranking ─────────────────────────────────────────────
  {
    question: "每片坏die情况",
    expected: F({ mode: "per_slot_bin_ranking" }),
    seed: "routing.scenarios route-per-slot-bin",
  },
  {
    question: "各片坏bin排列",
    expected: F({ mode: "per_slot_bin_ranking" }),
    seed: "isPerSlotBadBinRankingQuestion 各片坏bin",
  },
  {
    question: "逐片坏die汇总",
    expected: F({ mode: "per_slot_bin_ranking" }),
    seed: "isPerSlotBadBinRankingQuestion 逐片坏die",
  },

  // ── generic (multi-card compare) ────────────────────────────────────
  {
    question: "把这4张probecard的测试情况做对比",
    expected: F({ mode: "generic", isMultiCardCompare: true }),
    seed: "P-C 多卡对比",
  },
  {
    question: "9416-03 9416-04 两张卡对比坏die",
    expected: F({ mode: "generic", isMultiCardCompare: true }),
    seed: "≥2 卡号",
  },
  {
    question: "这几张卡各自表现怎么样",
    expected: F({ mode: "generic", isMultiCardCompare: true }),
    seed: "isMultiCardComparisonQuestion 各自 phrasing",
  },
  {
    question: "8041-05 和 8041-08 分别情况如何",
    expected: F({ mode: "generic", isMultiCardCompare: true }),
    seed: "isMultiCardComparisonQuestion 两卡号+分别",
  },

  // ── generic (multi-lot compare) ──────────────────────────────────────
  {
    question: "这几个lot分别用什么卡",
    expected: F({ mode: "generic", isMultiLotCompare: true }),
    seed: "多lot bail",
  },
  {
    question: "前5个lot各自的良率",
    expected: F({ mode: "generic", isMultiLotCompare: true }),
    seed: "isMultiLotComparisonQuestion 前N个lot各自",
  },

  // ── generic (conditional reasoning → LLM) ────────────────────────────
  {
    question: "如果两张卡都偏低下一步怎么排查",
    expected: F({ mode: "generic" }),
    seed: "条件性推理→generic",
  },
  {
    question: "假如BIN35是卡的问题该怎么处理",
    expected: F({ mode: "generic" }),
    seed: "isConditionalReasoningQuestion 假如",
  },

  // ── slot_pass_yield ───────────────────────────────────────────────────
  {
    question: "DR44435.1C 各片良率",
    expected: F({ mode: "slot_pass_yield" }),
    seed: "log mqygf9mq turn1 单lot良率",
  },
  {
    question: "DR44435.1C 每片良率是多少",
    expected: F({ mode: "slot_pass_yield" }),
    seed: "isSlotPassYieldQuestion 每片良率 phrasing variant",
  },
  {
    question: "这个lot逐片良率",
    expected: F({ mode: "slot_pass_yield" }),
    seed: "isSlotPassYieldQuestion 逐片良率",
  },

  // ── tester_machine ────────────────────────────────────────────────────
  {
    question: "DR44435.1C 这批用的什么机台",
    expected: F({ mode: "tester_machine" }),
    seed: "tester_machine",
  },
  {
    question: "这个lot在哪台机台跑的",
    expected: F({ mode: "tester_machine" }),
    seed: "isTesterMachineQuestion 在哪台机台",
  },
  {
    question: "DR44436.1W TESTERID是多少",
    expected: F({ mode: "tester_machine" }),
    seed: "isTesterMachineQuestion TESTERID keyword",
  },

  // ── bin_trend ─────────────────────────────────────────────────────────
  {
    question: "DR44435.1C BIN7 按片趋势",
    expected: F({ mode: "bin_trend", focusBin: 7 }),
    seed: "bin_trend",
  },
  {
    question: "DR44435.1C BIN35 各片多少颗",
    expected: F({ mode: "bin_trend", focusBin: 35 }),
    seed: "isBinTrendQuestion 各片多少颗",
  },
  {
    question: "BIN66 逐片分布",
    expected: F({ mode: "bin_trend", focusBin: 66 }),
    seed: "isBinTrendQuestion 逐片分布",
  },

  // ── interrupt_count ───────────────────────────────────────────────────
  {
    question: "DR44435.1C 测试中断了几次",
    expected: F({ mode: "interrupt_count" }),
    seed: "interrupt_count",
  },
  {
    question: "这批lot中断了多少次",
    expected: F({ mode: "interrupt_count" }),
    seed: "isInterruptCountQuestion 中断多少次 phrasing",
  },

  // ── lot_overview ──────────────────────────────────────────────────────
  {
    question: "DR44435.1C 概况",
    expected: F({ mode: "lot_overview" }),
    seed: "lot_overview",
  },
  {
    question: "DR44436.1W 整体测试情况怎么样",
    expected: F({ mode: "lot_overview" }),
    seed: "isLotOverviewQuestion 整体测试情况",
  },
  {
    question: "DR44435.1C 批次情况",
    expected: F({ mode: "lot_overview" }),
    seed: "isLotOverviewQuestion 批次情况",
  },

  // ── single_slot ───────────────────────────────────────────────────────
  {
    question: "DR44435.1C 第3片wafer坏bin",
    expected: F({ mode: "single_slot" }),
    seed: "single_slot",
  },
  {
    question: "这lot第5片情况",
    expected: F({ mode: "single_slot" }),
    seed: "isSingleSlotQuestion 第N片情况",
  },
  {
    question: "slot 12 的测试结果",
    expected: F({ mode: "single_slot" }),
    seed: "isSingleSlotQuestion slot N phrasing",
  },

  // ── lot_yield_ranking ─────────────────────────────────────────────────
  {
    question: "N55Z device 各 lot 良率 top5",
    expected: F({ mode: "lot_yield_ranking" }),
    seed: "lot_yield_ranking",
  },
  {
    question: "最近良率最差的几个lot",
    expected: F({ mode: "lot_yield_ranking" }),
    seed: "isLotYieldRankingQuestion 最差的几个lot",
  },
  {
    question: "lot良率排名 bottom3",
    expected: F({ mode: "lot_yield_ranking" }),
    seed: "isLotYieldRankingQuestion lot良率排名 bottom",
  },

  // ── card_yield_compare ────────────────────────────────────────────────
  {
    question: "哪张卡良率最低",
    expected: F({ mode: "card_yield_compare" }),
    seed: "card_yield_compare",
  },
  {
    question: "哪张卡良率更差",
    expected: F({ mode: "card_yield_compare" }),
    seed: "isCardYieldCompareQuestion 哪张卡良率更差",
  },
  {
    question: "探针卡哪个最差",
    expected: F({ mode: "card_yield_compare" }),
    seed: "isCardYieldCompareQuestion 探针卡哪个最差",
  },

  // ── bad_bin_ranking ───────────────────────────────────────────────────
  {
    question: "主要坏bin有哪些",
    expected: F({ mode: "bad_bin_ranking" }),
    seed: "isBadBinRankingQuestion 主要坏bin 无具体编号",
  },
  {
    question: "常见fail bin是什么",
    expected: F({ mode: "bad_bin_ranking" }),
    seed: "isBadBinRankingQuestion 常见fail bin",
  },
  {
    question: "坏die排行榜",
    expected: F({ mode: "bad_bin_ranking" }),
    seed: "isBadBinRankingQuestion 坏die排行 no specific BIN",
  },

  // ── card_test_overview ────────────────────────────────────────────────
  {
    question: "9416-04 这张卡的测试情况",
    expected: F({ mode: "card_test_overview" }),
    seed: "isCardTestOverviewQuestion 卡号+测试情况",
  },
  {
    question: "8041-08 使用情况怎么样",
    expected: F({ mode: "card_test_overview" }),
    seed: "isCardTestOverviewQuestion 卡号+使用情况",
  },

  // ── card_dut_question ─────────────────────────────────────────────────
  {
    question: "9416-04 哪个dut失效最多",
    expected: F({ mode: "card_dut_question" }),
    seed: "isCardDutQuestion 卡号+dut失效",
  },
  {
    question: "8041-05 哪个site有问题",
    expected: F({ mode: "card_dut_question" }),
    seed: "isCardDutQuestion 卡号+site问题",
  },
];
