import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildJbScopeArgs,
  buildLotListingQueryArgs,
  buildScopedBadBinAggregateArgs,
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
});
