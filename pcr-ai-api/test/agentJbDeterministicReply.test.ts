import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildBriefCommentaryUserMessage,
  buildAggregateBinRankingMarkdown,
  buildBinCardAggregateMarkdown,
  buildBinFocusedLotRankingMarkdown,
  buildDeterministicJbTables,
  buildEngineeringContextFromPayload,
  buildRecentLotsListingMarkdown,
  detectJbReplyMode,
  extractBinFromUserText,
  extractYmLotsFromHistory,
  isBinTrendQuestion,
  isInterruptCountQuestion,
  isLotListingQuestion,
  isMultiLotComparisonQuestion,
  isMultiCardComparisonQuestion,
  isProbeCardQuestion,
  isTesterMachineQuestion,
  isSlotPassYieldQuestion,
  isSingleWaferDieClusterQuestion,
  isCardTypeLevelOverviewQuestion,
  resolveJbToolPayload,
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
