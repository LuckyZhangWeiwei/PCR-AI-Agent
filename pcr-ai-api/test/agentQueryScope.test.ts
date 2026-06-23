import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildJbScopeArgs,
  inferTesterIdFromText,
} from "../src/lib/agent/agentQueryScope.js";
import { detectPendingQuery } from "../src/lib/agent/agentPendingQuery.js";

describe("agentQueryScope", () => {
  it("inferTesterIdFromText maps UFLEX 24 to b3uflex24", () => {
    assert.equal(inferTesterIdFromText("WA01P14E 在UFLEX 24 台的测试情况"), "b3uflex24");
    assert.equal(inferTesterIdFromText("就是 b3uflex24"), "b3uflex24");
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
});
