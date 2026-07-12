import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildBriefCommentaryUserMessage,
  buildAggregateBinRankingMarkdown,
  buildBinCardAggregateMarkdown,
  buildBinDeviceAggregateMarkdown,
  buildBinFocusedLotRankingMarkdown,
  buildDeterministicJbTables,
  buildEngineeringContextFromPayload,
  buildRecentLotsListingMarkdown,
  detectJbReplyMode,
  equipmentRouteDutLevelBail,
  extractBinFromUserText,
  extractYmLotsFromHistory,
  isBinTrendQuestion,
  isInterruptCountQuestion,
  isLotListingQuestion,
  isLotYieldRankingQuestion,
  isBinLotRankingQuestion,
  isMultiLotComparisonQuestion,
  isMultiCardComparisonQuestion,
  isProbeCardQuestion,
  isTesterMachineQuestion,
  isSlotPassYieldQuestion,
  isSingleWaferDieClusterQuestion,
  isCardTypeLevelOverviewQuestion,
  resolveJbToolPayload,
  shouldAppendUnderperformingDutYield,
  lotOverviewSkipsCommentaryAfterAlerts,
  buildDeterministicLotOverviewCommentary,
  isGoodBinValueQuestion,
  isProbeCardTesterPerformanceQuestion,
  buildGoodBinValueMarkdown,
  stampFirstTestNote,
  FIRST_TEST_ONLY_NOTE,
} from "../src/lib/agent/agentJbDeterministicReply.js";
import {
  compactJbCacheForHistory,
} from "../src/lib/agent/agentJbHistoryCompact.js";
import {
  clearJbToolRawJson,
  storeJbToolRawJson,
} from "../src/lib/agent/agentJbSessionCache.js";
import {
  buildJbSessionCacheJson,
  serializeJbQueryResultForAgent,
  wrapJbQueryResultForAgent,
} from "../src/lib/agent/agentJbBinFormat.js";

describe("agentJbDeterministicReply", () => {
  it("equipmentRouteDutLevelBail: DUT/嫌疑die 类问句为 true,纯卡问句为 false", () => {
    assert.equal(equipmentRouteDutLevelBail("ok 把对应用的卡 和 dut lot 都列出来"), true);
    assert.equal(equipmentRouteDutLevelBail("哪些 die 是嫌疑"), true);
    assert.equal(equipmentRouteDutLevelBail("这批用的什么卡"), false);
  });

  it("detects bin trend vs lot overview", () => {
    assert.equal(
      detectJbReplyMode("NF12316.1X 中 bin7 的趋势"),
      "bin_trend"
    );
    assert.equal(
      detectJbReplyMode("NF12827.1R 整体的测试情况 请重新计算"),
      "lot_overview"
    );
    assert.equal(extractBinFromUserText("BIN7 按 slot"), 7);
    assert.equal(extractBinFromUserText("NF12316.1X 中bin7 的趋势"), 7);
    assert.equal(
      detectJbReplyMode("NF12316.1X 中bin7 的趋势"),
      "bin_trend"
    );
    assert.equal(
      detectJbReplyMode("NF12316.1X 中bin7 的趋势 请重新计算"),
      "bin_trend"
    );
    assert.ok(isSlotPassYieldQuestion("给出 每片wafer 每个pass 的yield"));
    assert.equal(
      detectJbReplyMode("给出 每片wafer 每个pass 的yield"),
      "slot_pass_yield"
    );
    assert.ok(isInterruptCountQuestion("DR45459.1A 第1片中断几次"));
    assert.equal(
      detectJbReplyMode("lot DR45459.1A 各片中断多少次"),
      "interrupt_count"
    );
    assert.ok(isTesterMachineQuestion("DR45459.1A 在哪个机台测试的"));
    assert.equal(
      detectJbReplyMode("DR45459.1A 用的哪台测试机"),
      "tester_machine"
    );
    assert.ok(isProbeCardQuestion("DR45459.1A 用几号卡"));
    assert.equal(
      detectJbReplyMode("DR45459.1A 用几号卡，在哪个机器测试的"),
      "equipment"
    );
    // English "fail bin" variants → bad_bin_ranking
    assert.equal(
      detectJbReplyMode("DR43102.1H 实测失效情况,以及常见的fail bin"),
      "bad_bin_ranking"
    );
    assert.equal(
      detectJbReplyMode("这批主要的fail bin有哪些"),
      "bad_bin_ranking"
    );
    assert.equal(
      detectJbReplyMode("常见fail bin排行"),
      "bad_bin_ranking"
    );
    assert.equal(
      detectJbReplyMode("这3个月中这个device在 b3uflex24 主要的测试出的failed bin"),
      "bad_bin_ranking"
    );
    // Specific BIN number → should NOT be bad_bin_ranking (goes to bin_trend)
    assert.notEqual(
      detectJbReplyMode("BIN55 的 fail bin 情况"),
      "bad_bin_ranking"
    );
  });

  it("detects lot listing vs single-lot overview", () => {
    const q =
      "WA01P14E 在 b3uflex24 台近 3 个月 测试的所有lot 都列出来";
    assert.ok(isLotListingQuestion(q));
    assert.equal(detectJbReplyMode(q), "lot_listing");
    assert.notEqual(detectJbReplyMode(q), "lot_overview");
  });

  // P-B：「(都)测试了什么lot / 测了哪些lot」必须走 lot_listing，不是单 lot 概况。
  it("P-B: '都测试了什么lot' routes to lot_listing not lot_overview", () => {
    for (const q of [
      "都测试了什么lot",
      "测了哪些lot",
      "这几天都有什么批次",
      "跑了多少个lot",
    ]) {
      assert.ok(isLotListingQuestion(q), `isLotListingQuestion("${q}")`);
      assert.equal(detectJbReplyMode(q), "lot_listing", `detectJbReplyMode("${q}")`);
    }
    // 单 lot 概况不应被误判为列表
    assert.equal(isLotListingQuestion("P11C 最近一个月的测试情况"), false);
    // lot 内逐片枚举仍排除
    assert.equal(isLotListingQuestion("这个lot有哪些wafer"), false);
  });

  it("isLotYieldRankingQuestion matches WC13N55Z 各 lot 良率 top5 (A1-4)", () => {
    assert.ok(isLotYieldRankingQuestion("WC13N55Z 各 lot 良率 top5"));
    assert.equal(detectJbReplyMode("WC13N55Z 各 lot 良率 top5"), "lot_yield_ranking");
  });

  it("isBinLotRankingQuestion matches 哪个lot bin40最多 (P-D)", () => {
    assert.ok(isBinLotRankingQuestion("哪个lot bin40最多"));
  });

  // P-C：多卡「测试情况对比」交回 LLM（generic），不被单 lot equipment 表劫持；单卡仍 equipment。
  it("P-C: multi-card comparison bails to generic, single-card stays equipment", () => {
    for (const q of [
      "把这4张probecard 的测试情况 做一个对比",
      "把这4张probecard的测试情况做对比",
      "这几张卡分别怎样",
      "9416-01 和 9416-04 对比一下",
    ]) {
      assert.ok(isMultiCardComparisonQuestion(q), `isMultiCardComparisonQuestion("${q}")`);
      assert.equal(detectJbReplyMode(q), "generic", `detectJbReplyMode("${q}")`);
    }
    // 单卡 / 单 lot 用卡问句仍走 equipment（不被新分支误吞）
    assert.equal(isMultiCardComparisonQuestion("DR44436.1W 用什么卡测试的"), false);
    assert.equal(isMultiCardComparisonQuestion("这片用的什么卡"), false);
    assert.equal(detectJbReplyMode("DR44436.1W 用几号卡测试的"), "equipment");
  });

  it("探针卡+机台组合排名问法不应被 card_yield_compare 抢答（REQ-KLWT-019 real-model 回归，2026-07-11）", () => {
    // isCardYieldCompareQuestion 的 `探针卡.*(最好|最差|...)` 正则会命中这类句子，
    // 导致 resolveDispatch 在 LLM 前直发 query_jb_bins，aggregate_probe_card_tester_performance
    // 永远拿不到被 LLM 选中的机会（真实 MiniMax-M2.5 模型联调复现，见交接文档）。
    assert.equal(
      detectJbReplyMode(
        "WA03P02G 这个 device 下最好的探针卡+机台组合是什么，哪张探针卡表现最差"
      ),
      "equipment"
    );
    assert.equal(
      detectJbReplyMode("帮我看一下 WA03P02G 的探针卡表现排名和组合排名"),
      "equipment"
    );
    // 既有单卡对比问法必须继续命中 card_yield_compare（不能被本次修复误伤）
    assert.equal(detectJbReplyMode("哪张卡良率最低"), "card_yield_compare");
    assert.equal(detectJbReplyMode("探针卡哪个最差"), "card_yield_compare");
    assert.equal(detectJbReplyMode("这两张卡哪张良率更差"), "card_yield_compare");
  });

  it("buildAggregateBinRankingMarkdown from scoped aggregate", () => {
    const md = buildAggregateBinRankingMarkdown(
      JSON.stringify({
        totalRowsMatching: 500,
        groups: [
          { bin: 61, count: 900 },
          { bin: 60, count: 650 },
          { bin: 131, count: 120 },
        ],
      }),
      "WA01P14E @b3uflex24"
    );
    assert.ok(md?.includes("BIN61"));
    assert.ok(md?.includes("900"));
    assert.ok(md?.includes("占比"));
  });

  it("isMultiLotComparisonQuestion detects cross-lot card listing", () => {
    assert.ok(isMultiLotComparisonQuestion("前5个lot 都是用什么卡测试的"));
    assert.ok(isMultiLotComparisonQuestion("这几个lot 用各自用什么卡测试的"));
    assert.ok(isMultiLotComparisonQuestion("这5个lot 分别用什么卡"));
    // 指定单 lot → 不算（应正常出单 lot 概况）
    assert.equal(isMultiLotComparisonQuestion("DR44049.1X 用什么卡"), false);
    // 无跨 lot 关键词
    assert.equal(isMultiLotComparisonQuestion("这个device 测试情况"), false);
  });

  it("buildBinCardAggregateMarkdown focusBin lists cards for one BIN", () => {
    const raw = JSON.stringify({
      totalRowsMatching: 3445,
      groups: [
        { bin: "35", cardId: "9416-04", count: 14388 },
        { bin: "35", cardId: "9416-03", count: 13662 },
        { bin: "35", cardId: "9416-01", count: 12905 },
        { bin: "32", cardId: "9416-01", count: 12067 },
        { bin: "35", cardId: "9416-02", count: 9283 },
      ],
    });
    const md = buildBinCardAggregateMarkdown(raw, "mask N55Z", 35);
    assert.ok(md?.includes("BIN35 坏 die 所属探针卡"));
    assert.ok(md?.includes("9416-04"));
    assert.ok(md?.includes("14388"));
    // 不含 BIN32 行（focusBin 只看 35）
    assert.equal(md?.includes("12067"), false);
    // 第一行应是颗数最多的 9416-04
    const firstCardLine = md!.split("\n").find((l) => l.includes("| 1 |"));
    assert.ok(firstCardLine?.includes("9416-04"));
  });

  it("buildBinCardAggregateMarkdown no focusBin renders bin×card table", () => {
    const raw = JSON.stringify({
      totalRowsMatching: 6123,
      groups: [
        { bin: "152", cardId: "9406-01", count: 148464 },
        { bin: "152", cardId: "9406-05", count: 109628 },
        { bin: "20", cardId: "9406-01", count: 82232 },
      ],
    });
    const md = buildBinCardAggregateMarkdown(raw, "probeCardType 9406", null);
    assert.ok(md?.includes("坏 BIN × 探针卡"));
    assert.ok(md?.includes("9406-01"));
    assert.ok(md?.includes("9406-05"));
    assert.ok(md?.includes("BIN152"));
  });

  it("buildBinCardAggregateMarkdown returns null when groups lack cardId", () => {
    const raw = JSON.stringify({
      groups: [
        { bin: "35", count: 14388 },
        { bin: "32", count: 12067 },
      ],
    });
    assert.equal(buildBinCardAggregateMarkdown(raw, "mask N55Z", 35), null);
  });

  // B5（S5-T1 真库回归）：cardId 仅命中 1 个 JB lot 时，recentLotsByTestEnd 不进缓存，
  // 旧行为列表只剩 YM 告警 lot、丢掉该 JB lot。兜底用 payload 主 lot 补一行 JB STAR。
  it("buildRecentLotsListingMarkdown includes single JB lot from payload.lot when recentLotsByTestEnd absent", () => {
    const payload = {
      lot: "DR44037.1N",
      device: "WC13N55Z",
      yieldByPassId: [{ passId: 1, slotCount: 1 }],
      // 注意：无 recentLotsByTestEnd（模拟单 lot 缓存）
    } as Record<string, unknown>;
    const md = buildRecentLotsListingMarkdown(payload, {
      ymLots: [{ lot: "DR43338.1R", device: "WC13N55Z", testEnd: "2026-06-04" }],
    });
    assert.ok(md?.includes("DR44037.1N"), "JB lot must not be dropped");
    assert.ok(md?.includes("JB STAR"));
    assert.ok(md?.includes("DR43338.1R"), "YM lot still listed");
  });

  // B3（S4-T3 真库回归）：用户点名 4 个 lot 问「有测出 bin35 吗」→ 仅保留这 4 个 lot，
  // 缺失的显式补 0（旧行为给全局排行，3 个被问的 lot 根本没出现）。
  it("buildBinFocusedLotRankingMarkdown restricts to named lots and shows 0 for absent", () => {
    const raw = JSON.stringify({
      totalRowsMatching: 980,
      groups: [
        { bin: "35", lot: "DR41662.1J", count: 968 },
        { bin: "35", lot: "DR44039.1Y", count: 358 },
        { bin: "35", lot: "DR42190.1X", count: 1402 }, // 未点名 → 应被排除
        { bin: "2", lot: "DR44040.1R", count: 500 }, // 非 bin35
      ],
    });
    const md = buildBinFocusedLotRankingMarkdown(raw, 35, "device WC13N55Z", [
      "DR44039.1Y",
      "DR44040.1R",
      "DR43338.1R",
      "DR41662.1J",
    ]);
    assert.ok(md?.includes("DR41662.1J"));
    assert.ok(md?.includes("DR44039.1Y"));
    // 未点名的 lot 不出现
    assert.equal(md?.includes("DR42190.1X"), false);
    // 被点名但本 bin 为 0 的 lot 仍列出（DR44040.1R 只有 bin2、DR43338.1R 无数据）
    assert.ok(md?.includes("DR44040.1R"));
    assert.ok(md?.includes("DR43338.1R"));
  });

  // B1（S3-T2 真库回归）：用户「把 device 也要列出来」→ groupBy "device,bin"。
  // 旧行为：落到 buildAggregateBinRankingMarkdown 渲染纯 BIN 排行、丢掉 device 列。
  it("buildBinDeviceAggregateMarkdown renders BIN×device table (single device keeps device column)", () => {
    const raw = JSON.stringify({
      totalRowsMatching: 401,
      groups: [
        { device: "WB01P11C", bin: "2", mask: "P11C", count: 10031 },
        { device: "WB01P11C", bin: "6", mask: "P11C", count: 7579 },
        { device: "WB01P11C", bin: "9", mask: "P11C", count: 4201 },
      ],
    });
    const md = buildBinDeviceAggregateMarkdown(raw, "mask P11C", null);
    assert.ok(md?.includes("WB01P11C"), "device column must be present");
    assert.ok(md?.includes("BIN2"));
    assert.ok(md?.includes("10031"));
    assert.ok(md?.includes("Device"));
  });

  it("buildBinDeviceAggregateMarkdown focusBin lists devices for one BIN", () => {
    const raw = JSON.stringify({
      totalRowsMatching: 980,
      groups: [
        { device: "WC13N55Z", bin: "35", count: 819 },
        { device: "WC12N55Z", bin: "35", count: 358 },
        { device: "WC13N55Z", bin: "2", count: 1512 },
      ],
    });
    const md = buildBinDeviceAggregateMarkdown(raw, "mask N55Z", 35);
    assert.ok(md?.includes("BIN35 坏 die 所属 device"));
    assert.ok(md?.includes("WC13N55Z"));
    assert.ok(md?.includes("819"));
    // focusBin 只看 35，不含 BIN2 的 1512
    assert.equal(md?.includes("1512"), false);
  });

  it("buildBinDeviceAggregateMarkdown returns null when groups lack device", () => {
    const raw = JSON.stringify({
      groups: [
        { bin: "2", count: 10031 },
        { bin: "6", count: 7579 },
      ],
    });
    assert.equal(buildBinDeviceAggregateMarkdown(raw, "mask P11C", null), null);
  });

  // B1 防御：纯 BIN 排行渲染器遇到含 device 维度的 groups 必须 bail（避免跨 device 求和、丢列）。
  it("buildAggregateBinRankingMarkdown returns null when groups contain device dimension", () => {
    const raw = JSON.stringify({
      groups: [
        { device: "WB01P11C", bin: "2", count: 10031 },
        { device: "WB01P11C", bin: "6", count: 7579 },
      ],
    });
    assert.equal(buildAggregateBinRankingMarkdown(raw, "mask P11C"), null);
  });

  // P2: 「哪个 lot BIN35 最多」必须按 BIN35 颗数排 lot，而非坏 die 总量
  // （否则 DR41662(bin35=968,总2024) 会排在 DR42190(bin35=1402,总1402) 之前 — 误导）。
  it("buildBinFocusedLotRankingMarkdown ranks lots by the named BIN, not total bad die", () => {
    const raw = JSON.stringify({
      totalRowsMatching: 972,
      groups: [
        { bin: "18", lot: "DR41662.1J", count: 1056 },
        { bin: "35", lot: "DR41662.1J", count: 968 },
        { bin: "35", lot: "DR42190.1X", count: 1402 },
        { bin: "2", lot: "DR44312.1Y", count: 1512 },
      ],
    });
    const md = buildBinFocusedLotRankingMarkdown(raw, 35, "device WC13N55Z");
    assert.ok(md?.includes("各 lot BIN35 坏 die 排行"));
    // DR42190.1X(1402) 必须排在 DR41662.1J(968) 之前
    const firstRow = md!.split("\n").find((l) => l.includes("| 1 |"));
    assert.ok(firstRow?.includes("DR42190.1X"));
    assert.ok(firstRow?.includes("1402"));
    const secondRow = md!.split("\n").find((l) => l.includes("| 2 |"));
    assert.ok(secondRow?.includes("DR41662.1J"));
    // 与 BIN35 无关的 lot（只有 BIN2/BIN18）不应出现
    assert.equal(md?.includes("DR44312.1Y"), false);
  });

  it("buildBinFocusedLotRankingMarkdown appends card column when groups have cardId", () => {
    const raw = JSON.stringify({
      groups: [
        { bin: "35", lot: "TR21699.1W", cardId: "7810-04", count: 1337 },
        { bin: "35", lot: "TR21697.1K", cardId: "7810-04", count: 1216 },
      ],
    });
    const md = buildBinFocusedLotRankingMarkdown(raw, 35, "mask P11C");
    assert.ok(md?.includes("探针卡"));
    assert.ok(md?.includes("7810-04"));
    const firstRow = md!.split("\n").find((l) => l.includes("| 1 |"));
    assert.ok(firstRow?.includes("TR21699.1W"));
  });

  it("buildBinFocusedLotRankingMarkdown returns null without lot dimension or when bin absent", () => {
    // 无 lot 维度（groupBy bin,cardId）→ 交回 buildBinCardAggregateMarkdown
    const noLot = JSON.stringify({
      groups: [{ bin: "35", cardId: "9416-04", count: 12901 }],
    });
    assert.equal(buildBinFocusedLotRankingMarkdown(noLot, 35), null);
    // 该 bin 不在结果里
    const noBin = JSON.stringify({
      groups: [{ bin: "2", lot: "DR44312.1Y", count: 1512 }],
    });
    assert.equal(buildBinFocusedLotRankingMarkdown(noBin, 35), null);
    // focusBin 为 null
    assert.equal(buildBinFocusedLotRankingMarkdown(noLot, null), null);
  });

  // P7: 「这片 wafer 是否有坏 die 聚集性」(单片空间聚集) 不能被整 lot 表答
  it("isSingleWaferDieClusterQuestion detects contextual single-wafer clustering", () => {
    assert.ok(isSingleWaferDieClusterQuestion("这片wafer 是否有坏die 聚集性问题"));
    assert.ok(isSingleWaferDieClusterQuestion("这个wafer 坏die 集中在哪个区域分布"));
    assert.ok(isSingleWaferDieClusterQuestion("该片 是否扎堆"));
    // 给了具体片号 → 由 single_slot 处理，不在此函数
    assert.equal(isSingleWaferDieClusterQuestion("第14片 坏die 聚集吗"), false);
    // lot/批次级聚集 → 整 lot 警示表
    assert.equal(isSingleWaferDieClusterQuestion("这批lot 有没有聚集坏bin"), false);
    // 无聚集关键词
    assert.equal(isSingleWaferDieClusterQuestion("这片wafer 良率多少"), false);
  });

  // P5: 「9416 卡的测试情况」是卡型级，不能用单 lot 概况代答
  it("isCardTypeLevelOverviewQuestion detects bare card-type overview", () => {
    assert.ok(isCardTypeLevelOverviewQuestion("9416 卡的测试情况"));
    assert.ok(isCardTypeLevelOverviewQuestion("8003 型号整体情况怎么样"));
    // 具体卡号 → card_test_overview / card_dut，不在此列
    assert.equal(isCardTypeLevelOverviewQuestion("9416-04 卡的测试情况"), false);
    // 给了具体 lot → 单 lot 概况
    assert.equal(isCardTypeLevelOverviewQuestion("DR44436.1W 测试情况"), false);
    // 无 4 位卡型数字
    assert.equal(isCardTypeLevelOverviewQuestion("这个卡的测试情况"), false);
  });

  it("buildRecentLotsListingMarkdown merges JB and YM lots", () => {
    const md = buildRecentLotsListingMarkdown(
      {
        device: "WA01P14E",
        testerId: "b3uflex24",
        totalDistinctLots: 3,
        recentLotsByTestEnd: [
          {
            lot: "NF13256.1R",
            device: "WA01P14E",
            testEnd: "2026-06-01T00:00:00.000Z",
            slotCount: 21,
            cardIds: [],
            hasCardChangeInLot: false,
            cardId: "",
            slots: [],
          },
          {
            lot: "NF12576.1X",
            device: "WA01P14E",
            testEnd: "2026-05-15T00:00:00.000Z",
            slotCount: 25,
            cardIds: [],
            hasCardChangeInLot: false,
            cardId: "",
            slots: [],
          },
        ],
      },
      {
        ymLots: [
          { lot: "NF12000.1Y", device: "WA01P14E", testEnd: "2026-04-01T00:00:00.000Z" },
        ],
        ymAlarmCountByLot: new Map([["NE91236.1W", 10]]),
      }
    );
    assert.ok(md?.includes("NF13256.1R"));
    assert.ok(md?.includes("NF12576.1X"));
    assert.ok(md?.includes("NF12000.1Y"));
    assert.ok(md?.includes("NE91236.1W"));
    assert.ok(md?.includes("共 4 个 lot"));
  });

  it("buildRecentLotsListingMarkdown detailed mode shows fail bin and suspect DUT", () => {
    const md = buildRecentLotsListingMarkdown(
      {
        device: "WA01P14E",
        testerId: "b3uflex24",
        totalDistinctLots: 1,
        recentLotsByTestEnd: [
          {
            lot: "NF12576.1X",
            device: "WA01P14E",
            testEnd: "2026-06-01",
            slotCount: 25,
            cardIds: [],
            hasCardChangeInLot: false,
            cardId: "",
            slots: [],
          },
        ],
      },
      {
        detailed: true,
        topFailBinByLot: new Map([["NF12576.1X", "BIN61（530）"]]),
        ymAlarmCountByLot: new Map([["NF12576.1X", 2]]),
        ymSuspectDutsByLot: new Map([["NF12576.1X", ["DUT2", "DUT54"]]]),
      }
    );
    assert.ok(md?.includes("TOP fail BIN"));
    assert.ok(md?.includes("BIN61（530）"));
    assert.ok(md?.includes("DUT2"));
    assert.ok(md?.includes("YM 报警"));
  });

  it("buildDeterministicJbTables lot_listing skips single-lot overview", () => {
    const payload = {
      lot: "NF13256.1R",
      device: "WA01P14E",
      multiLotYieldScope: true,
      totalDistinctLots: 2,
      recentLotsByTestEnd: [
        {
          lot: "NF13256.1R",
          device: "WA01P14E",
          testEnd: "2026-06-01",
          slotCount: 21,
          cardIds: [],
          hasCardChangeInLot: false,
          cardId: "",
          slots: [],
        },
        {
          lot: "NF12576.1X",
          device: "WA01P14E",
          testEnd: "2026-05-15",
          slotCount: 25,
          cardIds: [],
          hasCardChangeInLot: false,
          cardId: "",
          slots: [],
        },
      ],
      lotYieldOverviewMarkdown: "**NF13256.1R 不应出现**",
    };
    const md = buildDeterministicJbTables(
      "WA01P14E b3uflex24 近3个月所有 lot 列出来",
      payload
    );
    assert.ok(md?.includes("测试 lot 列表"));
    assert.ok(md?.includes("NF12576.1X"));
    assert.equal(md?.includes("不应出现"), false);
  });

  it("buildDeterministicJbTables mask-level 测试情况 emits multi-lot listing not single-lot overview", () => {
    const payload = {
      lot: "TR23373.1T",
      device: "WB01P11C",
      multiLotYieldScope: true,
      totalDistinctLots: 16,
      recentLotsByTestEnd: [
        {
          lot: "TR23373.1T",
          device: "WB01P11C",
          testEnd: "2026-06-26",
          slotCount: 10,
          cardIds: [],
          hasCardChangeInLot: false,
          cardId: "",
          slots: [],
        },
        {
          lot: "TR22423.1A",
          device: "WB01P11C",
          testEnd: "2026-06-26",
          slotCount: 25,
          cardIds: [],
          hasCardChangeInLot: false,
          cardId: "",
          slots: [],
        },
      ],
      // 单 lot 概况 markdown：若被误用会出现在输出里
      lotYieldOverviewMarkdown: "**TR23373.1T 单 lot 概况不应出现**",
      agentTablesDigest: { lotOverview: "**TR23373.1T 单 lot 概况不应出现**" },
    };
    // "P11C 最近一个月的测试情况" → lot_overview 模式，但 mask 级多 lot
    assert.equal(detectJbReplyMode("P11C 最近一个月的测试情况"), "lot_overview");
    const md = buildDeterministicJbTables("P11C 最近一个月的测试情况", payload);
    assert.ok(md?.includes("TR22423.1A"), "应列出其它 lot");
    assert.equal(md?.includes("单 lot 概况不应出现"), false);
  });

  it("buildDeterministicJbTables lot-scoped 测试情况 keeps single-lot overview (regression)", () => {
    const payload = {
      lot: "TR21697.1K",
      device: "WB01P11C",
      multiLotYieldScope: true,
      totalDistinctLots: 16,
      recentLotsByTestEnd: [
        { lot: "TR21697.1K", device: "WB01P11C", testEnd: "2026-06-05", slotCount: 25 },
        { lot: "TR22423.1A", device: "WB01P11C", testEnd: "2026-06-26", slotCount: 25 },
      ],
      agentTablesDigest: { lotOverview: "**TR21697.1K 单 lot 概况**" },
    };
    // 句中带具体 lot → 仍走单 lot 概况，不退化成列表
    const md = buildDeterministicJbTables("TR21697.1K 测试情况", payload);
    assert.ok(md?.includes("TR21697.1K 单 lot 概况"));
  });

  it("buildDeterministicJbTables bin_card_attribution bails on mask-level single-lot payload", () => {
    const payload = {
      lot: "DR44436.1W",
      device: "WC13N55Z",
      multiLotYieldScope: true,
      totalDistinctLots: 8,
      slotBadBinsCompact: [
        { slot: 1, passId: 1, cardId: "9416-03", badBins: [{ bin: 35, dieCount: 418 }] },
      ],
    };
    assert.equal(
      detectJbReplyMode("N55Z bin35 是集中到哪张卡上的"),
      "bin_card_attribution"
    );
    const md = buildDeterministicJbTables(
      "N55Z bin35 是集中到哪张卡上的",
      payload
    );
    assert.equal(md, null, "mask 级单 lot 应 bail，不出单 lot 卡表");
  });

  it("buildDeterministicJbTables bin_card_attribution keeps lot-scoped single-lot answer (regression)", () => {
    const payload = {
      lot: "DR44436.1W",
      device: "WC13N55Z",
      slotBadBinsCompact: [
        { slot: 1, passId: 1, cardId: "9416-03", badBins: [{ bin: 35, dieCount: 418 }] },
      ],
    };
    const md = buildDeterministicJbTables(
      "DR44436.1W bin35 是集中到哪张卡上的",
      payload
    );
    assert.ok(md?.includes("9416-03"), "句中带具体 lot 时仍正常出卡归属表");
  });

  it("extractYmLotsFromHistory dedupes LOTID from query_yield_triggers", () => {
    const lots = extractYmLotsFromHistory([
      {
        role: "tool",
        name: "query_yield_triggers",
        content: JSON.stringify({
          rows: [
            { LOTID: "NF12576.1X", DEVICE: "WA01P14E", TIME_STAMP: "2026-06-01" },
            { LOTID: "NF12576.1X", DEVICE: "WA01P14E", TIME_STAMP: "2026-05-01" },
            { LOTID: "NF12000.1Y", DEVICE: "WA01P14E", TIME_STAMP: "2026-04-01" },
          ],
        }),
      },
    ]);
    assert.equal(lots.length, 2);
    assert.equal(lots[0]?.lot, "NF12576.1X");
  });

  it("buildDeterministicJbTables equipment includes card and tester", () => {
    const payload = {
      lot: "DR45459.1A",
      cardByPassId: [
        { passId: 1, cardIds: ["8041-05"], hasCardChangeInPass: false },
        { passId: 3, cardIds: ["8041-06"], hasCardChangeInPass: false },
      ],
      testerByLot: [
        {
          lot: "DR45459.1A",
          primaryTesterId: "b3j75062",
          testerIds: ["b3j75062"],
        },
      ],
    };
    const md = buildDeterministicJbTables(
      "DR45459.1A 用几号卡，在哪个机器测试的",
      payload
    );
    assert.ok(md?.includes("cardByPassId") || md?.includes("8041-05"));
    assert.ok(md?.includes("b3j75062"));
  });

  it("resolveJbToolPayload reads history when session cache cleared", () => {
    const rows = [
      {
        LOT: "NF12316.1X",
        SLOT: 1,
        PASSID: 1,
        PASSTYPE: "TEST",
        bins: [{ n: 7, value: 12, isGoodBin: false }],
      },
    ] as Record<string, unknown>[];
    const wrapped = wrapJbQueryResultForAgent(rows, { lotScopedFullRows: true });
    const cacheJson = buildJbSessionCacheJson(wrapped);
    const hist = compactJbCacheForHistory(cacheJson, 12000);
    const sid = "test-resolve-jb-payload";
    clearJbToolRawJson(sid);
    const fromHist = resolveJbToolPayload(sid, hist);
    assert.ok(fromHist);
    assert.ok(Array.isArray(fromHist!._trendRows));
    storeJbToolRawJson(sid, cacheJson);
    const fromCache = resolveJbToolPayload(sid, hist);
    assert.equal(fromCache!._jbSessionCacheVersion, 6);
    clearJbToolRawJson(sid);
  });

  it("resolveJbToolPayload preferredLot ignores stale session cache for other lot", () => {
    const sid = "test-preferred-lot";
    clearJbToolRawJson(sid);
    storeJbToolRawJson(
      sid,
      JSON.stringify({ lot: "DR43370.1W", device: "WA01N39W", count: 4 })
    );
    const nf121 = JSON.stringify({
      lot: "NF12150.1Y",
      device: "WB01P65J",
      count: 22,
    });
    const p = resolveJbToolPayload(sid, nf121, { preferredLot: "NF12150.1Y" });
    assert.equal(p?.["lot"], "NF12150.1Y");
    assert.equal(p?.["device"], "WB01P65J");
    clearJbToolRawJson(sid);
  });

  it("shouldAppendUnderperformingDutYield true for lot 测试情况 even if mode is equipment", () => {
    assert.equal(
      shouldAppendUnderperformingDutYield("NF12150.1Y 的测试情况", "equipment"),
      true
    );
    assert.equal(
      shouldAppendUnderperformingDutYield("6081-03 测试过什么lot", "lot_listing"),
      false
    );
    assert.equal(
      shouldAppendUnderperformingDutYield("WA01N39W 的测试情况", "generic", {
        recentLotsByTestEnd: [{ lot: "DR41803.1Y" }, { lot: "DR41542.1H" }],
      }),
      false
    );
    assert.equal(
      shouldAppendUnderperformingDutYield("WA01N39W 的测试情况", "lot_overview", {
        recentLotsByTestEnd: [{ lot: "DR41803.1Y" }, { lot: "DR41542.1H" }],
        distinctLotCount: 213,
      }),
      false
    );
  });

  it("isProbeCardTesterPerformanceQuestion detects combo ranking, not single-lot card compare", () => {
    assert.equal(
      isProbeCardTesterPerformanceQuestion(
        "WA03P02G 这个 device 下最好的探针卡+机台组合是什么，哪张探针卡表现最差"
      ),
      true
    );
    assert.equal(
      isProbeCardTesterPerformanceQuestion("帮我看一下 WA03P02G 的探针卡表现排名和组合排名"),
      true
    );
    assert.equal(isProbeCardTesterPerformanceQuestion("哪张卡良率最低"), false);
    assert.equal(isProbeCardTesterPerformanceQuestion("探针卡哪个最差"), false);
  });

  it("canRunLotOverviewDirectRoute bails on good bin field ask", async () => {
    const { canRunLotOverviewDirectRoute } = await import(
      "../src/lib/agent/agentJbOverviewRoute.js"
    );
    assert.equal(canRunLotOverviewDirectRoute("DR41803.1Y 中的 good bin 是多少"), false);
    assert.equal(canRunLotOverviewDirectRoute("DR41803.1Y 的测试情况"), true);
  });

  it("isGoodBinValueQuestion detects field ask, excludes confirmation/trend", () => {
    assert.equal(isGoodBinValueQuestion("DR41803.1Y 中的 good bin 是多少"), true);
    assert.equal(isGoodBinValueQuestion("良品 bin 是哪个"), true);
    assert.equal(isGoodBinValueQuestion("BIN55 是 good bin 吗"), false);
    assert.equal(isGoodBinValueQuestion("good bin 数量趋势"), false);
    assert.equal(isGoodBinValueQuestion("DR41803.1Y 的测试情况"), false);
  });

  it("buildGoodBinValueMarkdown aggregates goodBins by pass", () => {
    const md = buildGoodBinValueMarkdown({
      lot: "DR41803.1Y",
      device: "WA01N39W",
      rows: [
        {
          PASSID: 1,
          goodBins: [{ bin: 250, dieCount: 6213, isGoodBin: true }],
        },
      ],
    });
    assert.ok(md);
    assert.match(md!, /BIN250/);
    assert.match(md!, /6213/);
  });

  it("buildGoodBinValueMarkdown reads _trendRows when session cache omits rows", () => {
    const md = buildGoodBinValueMarkdown({
      lot: "DR41803.1Y",
      device: "WA01N39W",
      rowsOmitted: true,
      _trendRows: [{ PASSID: 1, PASSBIN: "250" }],
    });
    assert.ok(md);
    assert.match(md!, /BIN250/);
  });

  it("detectJbReplyMode routes good bin field ask to good_bin_value", () => {
    assert.equal(detectJbReplyMode("DR41803.1Y 中的 good bin 是多少"), "good_bin_value");
  });

  it("buildDeterministicJbTables picks bin trend markdown", () => {
    const rows = [
      {
        LOT: "NF12316.1X",
        SLOT: 1,
        PASSID: 1,
        PASSTYPE: "INTERRUPT",
        bins: [{ n: 7, value: 5, isGoodBin: false }],
      },
      {
        LOT: "NF12316.1X",
        SLOT: 1,
        PASSID: 1,
        PASSNUM: 2,
        PASSTYPE: "TEST",
        bins: [
          { n: 1, value: 4000, isGoodBin: true },
          { n: 7, value: 90, isGoodBin: false },
        ],
      },
      {
        LOT: "NF12316.1X",
        SLOT: 2,
        PASSID: 1,
        PASSTYPE: "TEST",
        bins: [
          { n: 1, value: 4000, isGoodBin: true },
          { n: 7, value: 100, isGoodBin: false },
        ],
      },
    ] as Record<string, unknown>[];
    const wrapped = wrapJbQueryResultForAgent(rows, { lotScopedFullRows: true });
    const json = serializeJbQueryResultForAgent(wrapped, 50000);
    const payload = JSON.parse(json) as Record<string, unknown>;
    const md = buildDeterministicJbTables(
      "NF12316.1X 中 bin7 的趋势",
      payload
    );
    assert.ok(md);
    assert.ok(isBinTrendQuestion("NF12316.1X 中 bin7 的趋势"));
    assert.ok(md!.includes("BIN7"));
    assert.ok(md!.includes("| 1 |"));
    assert.ok(md!.includes("90"));
  });

  it("buildDeterministicJbTables returns tester machine table", () => {
    const rows = [
      {
        LOT: "DR45459.1A",
        SLOT: 1,
        PASSID: 1,
        TESTERID: "b3uflex17",
        TESTEND: "2026-05-29T10:00:00.000Z",
        bins: [],
      },
    ] as Record<string, unknown>[];
    const wrapped = wrapJbQueryResultForAgent(rows, { lotScopedFullRows: true });
    const md = buildDeterministicJbTables(
      "DR45459.1A 在哪个机台测试",
      wrapped
    );
    assert.ok(md);
    assert.ok(md!.includes("b3uflex17"));
    assert.ok(md!.includes("TESTERID"));
  });

  it("buildDeterministicJbTables returns interrupt count table", () => {
    const rows = [
      { LOT: "DR45459.1A", SLOT: 1, PASSID: 1, PASSTYPE: "INTERRUPT", PASSNUM: 1, GROSSDIE: 10, bins: [] },
      { LOT: "DR45459.1A", SLOT: 1, PASSID: 1, PASSTYPE: "INTERRUPT", PASSNUM: 1, GROSSDIE: 10, bins: [] },
      { LOT: "DR45459.1A", SLOT: 1, PASSID: 1, PASSTYPE: "INTERRUPT", PASSNUM: 1, GROSSDIE: 10, bins: [] },
      { LOT: "DR45459.1A", SLOT: 1, PASSID: 1, PASSTYPE: "INTERRUPT", PASSNUM: 1, GROSSDIE: 10, bins: [] },
      { LOT: "DR45459.1A", SLOT: 1, PASSID: 1, PASSTYPE: "TEST", PASSNUM: 2, GROSSDIE: 100, bins: [{ n: 1, value: 90, isGoodBin: true }] },
      { LOT: "DR45459.1A", SLOT: 5, PASSID: 1, PASSTYPE: "TEST", PASSNUM: 1, GROSSDIE: 100, bins: [] },
      { LOT: "DR45459.1A", SLOT: 5, PASSID: 1, PASSTYPE: "TEST", PASSNUM: 3, GROSSDIE: 100, bins: [{ n: 1, value: 90, isGoodBin: true }] },
    ] as Record<string, unknown>[];
    const wrapped = wrapJbQueryResultForAgent(rows, { lotScopedFullRows: true });
    const md = buildDeterministicJbTables(
      "DR45459.1A 第1片和第5片各中断几次",
      wrapped
    );
    assert.ok(md);
    assert.ok(md!.includes("测试中断次数"));
    assert.ok(md!.includes("| 1 |"));
    assert.ok(md!.includes("| 4 |"));
    assert.ok(md!.includes("| 5 |"));
    assert.ok(md!.includes("| 2 |"));
  });

  it("brief commentary prompt requests wafer test probe card dut advice", () => {
    const msg = buildBriefCommentaryUserMessage("NF12316.1X bin7 趋势", "| 1 | 90 |", {
      engineeringContext: "passId: 1,3",
      yieldMonitorNote: "已查 Yield Monitor",
    });
    assert.ok(msg.includes("### 专业建议"));
    assert.ok(msg.includes("Wafer Test"));
    assert.ok(msg.includes("Probe Card"));
    assert.ok(msg.includes("DUT"));
    assert.ok(msg.includes("waferId") || msg.includes("术语"));
    const ctx = buildEngineeringContextFromPayload({
      passIdsPresent: [1, 3],
      cardChangesBySlotPass: [{ slot: 1, passId: 1, hasCardChange: true, hasTestInterrupt: true }],
    });
    assert.ok(ctx.includes("passId"));
    assert.ok(ctx.includes("换卡"));
  });

  it("buildDeterministicJbTables 用 modeOverride 时不再自行 detect", () => {
    const payload = { lot: "NF13322.1J", slotBadBinsCompact: [
      { slot: 1, passId: 1, cardId: "9416-03", badBins: [{ bin: 35, dieCount: 418 }] },
    ] };
    // override 成 bad_bin_ranking,即使问句像 lot_overview
    const md = buildDeterministicJbTables("NF13322.1J 整体测试情况", payload as any, undefined, "bad_bin_ranking");
    assert.ok(md && md.length > 0);
  });
});

describe("JB listing scope (card / device)", () => {
  it("resolveJbListingScope prefers cardId over device from history", async () => {
    const { resolveJbListingScope, jbListingScopeToQueryArgs } = await import(
      "../src/lib/agent/agentQueryScope.js"
    );
    const scope = resolveJbListingScope("列出这个卡最近测试的5个lot 的平均良品率", [
      { role: "user", content: "6081-03 测试过什么lot" },
      { role: "assistant", content: "YM 侧 3 次报警" },
    ]);
    assert.equal(scope?.cardId, "6081-03");
    assert.equal(jbListingScopeToQueryArgs(scope!)["cardId"], "6081-03");
    assert.equal(jbListingScopeToQueryArgs(scope!)["device"], undefined);
  });

  it("detectJbReplyMode routes card lot+yield to lot_listing (not extra mode)", () => {
    assert.equal(
      detectJbReplyMode("列出这个卡最近测试的5个lot 的评价yield"),
      "lot_listing"
    );
  });

  it("buildRecentLotsListingMarkdown with yield presentation", () => {
    const md = buildRecentLotsListingMarkdown(
      {
        lotYieldRankByTestEnd: [
          {
            lot: "DR43370.1W",
            device: "WA01N39W",
            yieldPct: 96.42,
            worstSlot: 2,
            worstPassId: 1,
            testEnd: "2026-07-09",
          },
          {
            lot: "DR44204.1F",
            device: "WA01N39W",
            yieldPct: 96.69,
            worstSlot: 5,
            worstPassId: 1,
            testEnd: "2026-07-08",
          },
        ],
      },
      {
        scopeLabel: "cardId=6081-03",
        presentation: {
          topN: 2,
          includeYield: true,
          includeAverageYield: true,
        },
      }
    );
    assert.ok(md?.includes("cardId=6081-03"));
    assert.ok(md?.includes("DR43370.1W"));
    assert.ok(md?.includes("平均良率"));
  });

  it("canRunLotListingDirectRoute true for card-scoped lot list", async () => {
    const { canRunLotListingDirectRoute } = await import(
      "../src/lib/agent/agentJbLotListingRoute.js"
    );
    assert.ok(
      canRunLotListingDirectRoute("列出这个卡最近测试的5个lot", [
        { role: "user", content: "6081-03 测试过什么lot" },
      ])
    );
  });
});

describe("stampFirstTestNote", () => {
  it("在数据块末尾追加 first-test 脚注", () => {
    const out = stampFirstTestNote("## 实测数据\n\n| a |\n|---|");
    assert.ok(out.endsWith(FIRST_TEST_ONLY_NOTE));
    assert.match(out, /只包含 first test/);
    assert.match(out, /不包含 Auto retest/);
  });
  it("幂等：已含脚注不重复追加", () => {
    const once = stampFirstTestNote("## 实测数据\n\nx");
    const twice = stampFirstTestNote(once);
    assert.equal(twice, once);
    assert.equal((twice.match(/Auto retest/g) ?? []).length, 1);
  });
  it("空串原样返回，不加脚注", () => {
    assert.equal(stampFirstTestNote(""), "");
  });
});

describe("lotOverviewSkipsCommentaryAfterAlerts", () => {
  it("lot_overview + 警示节 → skip LLM commentary", () => {
    assert.equal(
      lotOverviewSkipsCommentaryAfterAlerts(
        "lot_overview",
        "overview\n\n### 🔍 警示 / 规律识别\n\n| BIN |",
        {}
      ),
      true
    );
    assert.equal(
      lotOverviewSkipsCommentaryAfterAlerts("lot_overview", "overview only", {
        clusteredBadBinAlertsMarkdown: "| BIN | pass1 |",
      }),
      true
    );
    assert.equal(
      lotOverviewSkipsCommentaryAfterAlerts("lot_overview", "overview only", {}),
      false
    );
    assert.equal(
      lotOverviewSkipsCommentaryAfterAlerts("equipment", "### 🔍 警示", {}),
      false
    );
  });
});

describe("buildDeterministicLotOverviewCommentary", () => {
  it("emits 数据解读 + 专业建议 from alerts and yieldByPassId", () => {
    const md = buildDeterministicLotOverviewCommentary({
      lot: "NF12675.1K",
      testerByLot: [{ lot: "NF12675.1K", primaryTesterId: "b3j75061", testerIds: ["b3j75061"] }],
      clusteredBadBinAlerts: [
        {
          bin: 5,
          passId: 4,
          sortLabel: "pass4",
          kind: "cluster",
          slotStart: 1,
          slotEnd: 6,
          slots: [1, 2, 3, 4, 5, 6],
          peakDie: 2073,
          detail: "test",
        },
      ],
      yieldByPassId: [
        { passId: 1, sortLabel: "pass1", grossDie: 498425, goodDie: 494228, badDie: 4197, yieldPct: 99.16, slotCount: 25 },
        { passId: 3, sortLabel: "pass3", grossDie: 494977, goodDie: 493973, badDie: 1004, yieldPct: 99.8, slotCount: 25 },
        { passId: 4, sortLabel: "pass4", grossDie: 119324, goodDie: 108680, badDie: 10644, yieldPct: 91.08, slotCount: 6 },
      ],
    });
    assert.ok(md?.includes("### 数据解读"), md ?? "");
    assert.ok(md?.includes("### 专业建议"), md ?? "");
    assert.ok(md?.includes("BIN5"), md ?? "");
    assert.match(md ?? "", /pass4.*91\.08%|91\.08%.*pass4/);
    assert.ok(md?.includes("b3j75061"), md ?? "");
  });
});
