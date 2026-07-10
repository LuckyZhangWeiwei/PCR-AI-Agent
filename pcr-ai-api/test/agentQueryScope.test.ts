import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildBinLotRankingAggregateArgs,
  buildJbScopeArgs,
  buildLotListingQueryArgs,
  buildScopedBadBinAggregateArgs,
  inferDeviceFromText,
  inferMaskFromText,
  inferPlatformFromText,
  inferRecentMonthsWindow,
  inferTesterIdFromText,
} from "../src/lib/agent/agentQueryScope.js";
import { detectPendingQuery } from "../src/lib/agent/agentPendingQuery.js";
import { canRunLotListingDirectRoute } from "../src/lib/agent/agentJbLotListingRoute.js";
import { canRunScopedBadBinDirectRoute } from "../src/lib/agent/agentJbScopedBadBinRoute.js";
import { isBadBinRankingQuestion } from "../src/lib/agent/agentJbDeterministicReply.js";

describe("agentQueryScope", () => {
  it("inferTesterIdFromText maps UFLEX 24 to b3uflex24", () => {
    assert.equal(inferTesterIdFromText("WA01P14E 在UFLEX 24 台的测试情况"), "b3uflex24");
    assert.equal(inferTesterIdFromText("就是 b3uflex24"), "b3uflex24");
    assert.equal(
      inferTesterIdFromText("WA01P14E 在 b3uflex24 台近 3 个月 测试的所有lot 都列出来"),
      "b3uflex24"
    );
  });

  it("buildLotListingQueryArgs from user sentence without prior tools", () => {
    const args = buildLotListingQueryArgs(
      "WA01P14E 在 b3uflex24 台近 3 个月 测试的所有lot 都列出来"
    );
    assert.equal(args?.["device"], "WA01P14E");
    assert.equal(args?.["testerId"], "b3uflex24");
    assert.ok(args?.["testEndFrom"]);
    assert.ok(args?.["testEndTo"]);
  });

  it("buildJbScopeArgs reads YM tool call device and hostname", () => {
    const args = buildJbScopeArgs(
      "近3个月所有 lot 列出来",
      [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "1",
              type: "function",
              function: {
                name: "query_yield_triggers",
                arguments: JSON.stringify({
                  device: "WA01P14E",
                  hostname: "b3uflex24",
                  timeFrom: "2026-03-23",
                  timeTo: "2026-06-23",
                }),
              },
            },
          ],
        },
      ],
      "query_yield_triggers"
    );
    assert.equal(args?.["device"], "WA01P14E");
    assert.equal(args?.["testerId"], "b3uflex24");
    assert.equal(args?.["testEndFrom"], "2026-03-23");
  });

  it("detectPendingQuery schedules query_jb_bins after YM lot listing", () => {
    const pending = detectPendingQuery(
      "WA01P14E 在 b3uflex24 台近 3 个月 测试的所有lot 都列出来",
      "query_yield_triggers",
      {},
      [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "1",
              type: "function",
              function: {
                name: "query_yield_triggers",
                arguments: JSON.stringify({
                  device: "WA01P14E",
                  hostname: "b3uflex24",
                }),
              },
            },
          ],
        },
      ]
    );
    assert.equal(pending?.toolName, "query_jb_bins");
    assert.equal(pending?.args["device"], "WA01P14E");
    assert.equal(pending?.args["testerId"], "b3uflex24");
  });

  it("canRunLotListingDirectRoute for device+tester lot list question", () => {
    const q =
      "WA01P14E 在 b3uflex24 台近 3 个月 测试的所有lot 都列出来";
    assert.ok(canRunLotListingDirectRoute(q));
  });

  it("detectPendingQuery after empty get_filter_values", () => {
    const pending = detectPendingQuery(
      "WA01P14E 在 b3uflex24 台近 3 个月 测试的所有lot 都列出来",
      "get_filter_values",
      {},
      []
    );
    assert.equal(pending?.toolName, "query_jb_bins");
    assert.equal(pending?.args["device"], "WA01P14E");
  });

  it("inferRecentMonthsWindow matches 这3个月", () => {
    const w = inferRecentMonthsWindow("这3个月中这个device在 b3uflex24 主要的 failed bin");
    assert.ok(w.testEndFrom);
    assert.ok(w.testEndTo);
  });

  it("inferRecentMonthsWindow matches 最近三天", () => {
    const w = inferRecentMonthsWindow("uflex 最近三天");
    assert.ok(w.testEndFrom);
    assert.ok(w.testEndTo);
  });

  it("canRunLotListingDirectRoute with platform+window from history (P-B)", () => {
    const history = [{ role: "user", content: "uflex 最近三天" }];
    assert.ok(canRunLotListingDirectRoute("都测试了什么lot", history));
    const args = buildLotListingQueryArgs("都测试了什么lot", history);
    assert.equal(args?.["tstype"], "UFLEX");
    assert.ok(args?.["testEndFrom"]);
  });

  it("buildBinLotRankingAggregateArgs for bin+lot ranking (P-D)", () => {
    const history = [{ role: "user", content: "uflex 最近三天的测试情况" }];
    const args = buildBinLotRankingAggregateArgs("哪个lot bin40最多", history);
    assert.equal(args?.["groupBy"], "bin,lot");
    assert.equal(args?.["tstype"], "UFLEX");
    assert.ok(args?.["testEndFrom"]);
  });

  it("isBadBinRankingQuestion matches failed bin", () => {
    assert.ok(
      isBadBinRankingQuestion(
        "这3个月中这个device在 b3uflex24 主要的测试出的failed bin"
      )
    );
  });

  it("canRunScopedBadBinDirectRoute with device from history", () => {
    const history = [
      { role: "user", content: "WA01P14E 在 b3uflex24 台近 3 个月 测试的所有lot 都列出来" },
    ];
    const q = "这3个月中这个device在 b3uflex24 主要的测试出的failed bin";
    assert.ok(canRunScopedBadBinDirectRoute(q, history));
    const args = buildScopedBadBinAggregateArgs(q, history);
    assert.equal(args?.["device"], "WA01P14E");
    assert.equal(args?.["testerId"], "b3uflex24");
    assert.equal(args?.["groupBy"], "bin");
  });

  it("detectPendingQuery schedules aggregate after query_jb_bins for scoped fail bin", () => {
    const history = [
      { role: "user", content: "WA01P14E 在 b3uflex24 近3个月 lot 列表" },
    ];
    const q = "这3个月中这个device在 b3uflex24 主要的 failed bin";
    const pending = detectPendingQuery(q, "query_jb_bins", { device: "WA01P14E" }, history);
    assert.equal(pending?.toolName, "aggregate_jb_bins");
    assert.equal(pending?.args["groupBy"], "bin");
  });

  // ── mask / platform scope (2026-06-25) ──────────────────────────────────────

  it("inferMaskFromText: standalone token and full device", () => {
    assert.equal(inferMaskFromText("N55Z 最近一个月哪个坏die最多"), "N55Z");
    assert.equal(inferMaskFromText("WC13N55Z 测试情况"), "N55Z");
    // platform tokens must NOT be treated as masks
    assert.equal(inferMaskFromText("ps16 最近一周哪个lot最差"), undefined);
    assert.equal(inferMaskFromText("j750 平台坏die"), undefined);
  });

  it("inferPlatformFromText maps aliases (flex/uflex separate from j750)", () => {
    assert.equal(inferPlatformFromText("ps16 最近一周"), "PS16");
    assert.equal(inferPlatformFromText("ps1600 测试情况"), "PS16");
    assert.equal(inferPlatformFromText("j750 平台"), "J750");
    assert.equal(inferPlatformFromText("uflex 平台坏die"), "UFLEX");
    assert.equal(inferPlatformFromText("flex 平台坏die"), "FLEX");
    assert.equal(inferPlatformFromText("N55Z 哪个坏die最多"), undefined);
  });

  it("inferRecentMonthsWindow handles week / month / year", () => {
    assert.ok(inferRecentMonthsWindow("最近一周哪个lot最差").testEndFrom);
    assert.ok(inferRecentMonthsWindow("N55Z 最近一个月哪个坏die最多").testEndFrom);
    assert.ok(inferRecentMonthsWindow("近一年的情况").testEndFrom);
    assert.equal(inferRecentMonthsWindow("没有时间词").testEndFrom, undefined);
  });

  it("isBadBinRankingQuestion matches 哪个坏die最多", () => {
    assert.ok(isBadBinRankingQuestion("N55Z 最近一个月测试中 哪个坏die 最多"));
    assert.ok(isBadBinRankingQuestion("坏die最多的是哪个"));
  });

  it("Problem 2: mask + 哪个坏die最多 routes to aggregate_jb_bins(mask, bin)", () => {
    const q = "N55Z 最近一个月测试中 哪个坏die 最多";
    assert.ok(canRunScopedBadBinDirectRoute(q, []));
    const args = buildScopedBadBinAggregateArgs(q, []);
    assert.equal(args?.["mask"], "N55Z");
    assert.equal(args?.["groupBy"], "bin");
    assert.ok(args?.["testEndFrom"]);
  });

  it("Problem 1: empty get_filter_values + mask card question → query_jb_bins(mask)", () => {
    const pending = detectPendingQuery(
      "N55Z bin35 集中在哪张卡上",
      "get_filter_values",
      { values: [], totalDistinct: 0 },
      []
    );
    assert.equal(pending?.toolName, "query_jb_bins");
    assert.equal(pending?.args["mask"], "N55Z");
  });

  it("platform + time bad-die ranking is routable (Problem 3 family)", () => {
    const q = "ps16 最近一周 主要坏bin有哪些";
    assert.ok(canRunScopedBadBinDirectRoute(q, []));
    const args = buildScopedBadBinAggregateArgs(q, []);
    assert.equal(args?.["tstype"], "PS16");
    assert.ok(args?.["testEndFrom"]);
  });

  it("inferDeviceFromText matches WC/WB full device codes (A1-4)", () => {
    assert.equal(inferDeviceFromText("WC13N55Z 各 lot 良率 top5"), "WC13N55Z");
    assert.equal(inferDeviceFromText("WA03P02G 测试情况"), "WA03P02G");
    assert.equal(inferMaskFromText("WC13N55Z 各 lot 良率 top5"), "N55Z");
  });

  it("buildJbScopeArgs resolves WC13N55Z device for lot listing", () => {
    const args = buildJbScopeArgs("WC13N55Z 各 lot 良率 top5", [], "query_jb_bins");
    assert.equal(args?.["device"], "WC13N55Z");
  });

  it("buildLotListingQueryArgs uses cardId when user refers to 这个卡", () => {
    const args = buildLotListingQueryArgs(
      "列出这个卡最近5个lot的平均良品率",
      [{ role: "user", content: "6081-03 测试过什么lot" }]
    );
    assert.equal(args?.["cardId"], "6081-03");
    assert.equal(args?.["device"], undefined);
  });

  it("buildLotListingQueryArgs inherits cardId for 最新N个lot follow-up without pronoun", () => {
    const history = [
      { role: "user", content: "6081-03 测试过什么lot，效果怎样" },
      { role: "assistant", content: "…" },
    ];
    const args = buildLotListingQueryArgs(
      "列出最新的5个lot，并给出平均yield",
      history
    );
    assert.equal(args?.["cardId"], "6081-03");
    assert.equal(args?.["device"], undefined);
  });
});
