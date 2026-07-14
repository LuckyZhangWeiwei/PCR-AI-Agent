import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  getHistory,
  appendMessages,
  appendSyntheticToolTurn,
  repairToolCallGroupsForLlm,
  clearHistory,
} from "../src/lib/agent/agentHistory.js";

describe("agentHistory", () => {
  beforeEach(() => {
    clearHistory("sess-1");
    clearHistory("sess-2");
    clearHistory("sess-trim");
    clearHistory("sess-synth");
  });

  it("starts empty for a new sessionId", () => {
    const h = getHistory("sess-new-" + Date.now());
    assert.deepEqual(h, []);
  });

  it("appends messages and retrieves them", () => {
    appendMessages("sess-1", { role: "user", content: "hello" });
    appendMessages("sess-1", { role: "assistant", content: "hi" });
    const h = getHistory("sess-1");
    assert.equal(h.length, 2);
    assert.equal(h[0].content, "hello");
    assert.equal(h[1].content, "hi");
  });

  it("sessions are isolated", () => {
    appendMessages("sess-1", { role: "user", content: "a" });
    appendMessages("sess-2", { role: "user", content: "b" });
    assert.equal(getHistory("sess-1").length, 1);
    assert.equal(getHistory("sess-2").length, 1);
    assert.equal(getHistory("sess-1")[0].content, "a");
  });

  it("clearHistory removes the session", () => {
    appendMessages("sess-1", { role: "user", content: "x" });
    clearHistory("sess-1");
    assert.deepEqual(getHistory("sess-1"), []);
  });

  it("trims oldest messages when MAX_MESSAGES exceeded", () => {
    const sid = "sess-trim";
    clearHistory(sid);
    for (let i = 0; i < 85; i++) {
      appendMessages(sid, { role: "user", content: `msg-${i}` });
    }
    const h = getHistory(sid);
    assert.ok(h.length <= 80, `Expected ≤80 messages, got ${h.length}`);
    // Most recent message should be preserved
    assert.equal(h[h.length - 1].content, "msg-84");
  });

  it("appendSyntheticToolTurn pairs assistant tool_calls with tool message", () => {
    const sid = "sess-synth";
    appendMessages(sid, { role: "user", content: "best combo?" });
    const callId = appendSyntheticToolTurn(sid, {
      name: "aggregate_probe_card_tester_performance",
      args: { device: "WA20P98C" },
      content: '{"groups":[]}',
      toolCallId: "probe_card_perf_test",
    });
    assert.equal(callId, "probe_card_perf_test");
    const h = getHistory(sid);
    assert.equal(h.length, 3);
    assert.equal(h[1]!.role, "assistant");
    assert.equal(h[1]!.tool_calls?.[0]?.id, "probe_card_perf_test");
    assert.equal(
      h[1]!.tool_calls?.[0]?.function.name,
      "aggregate_probe_card_tester_performance"
    );
    assert.equal(h[2]!.role, "tool");
    assert.equal(h[2]!.tool_call_id, "probe_card_perf_test");
  });
});

describe("repairToolCallGroupsForLlm", () => {
  it("injects synthetic assistant before orphan tool messages (MiniMax 20015)", () => {
    const repaired = repairToolCallGroupsForLlm([
      { role: "user", content: "WA20P98C 和什么卡什么机台搭配最合适" },
      {
        role: "tool",
        name: "aggregate_probe_card_tester_performance",
        tool_call_id: "orphan_1",
        content: '{"groups":[{"passId":1}]}',
      },
      { role: "assistant", content: "### 实测数据\n..." },
    ]);
    assert.equal(repaired.length, 4);
    assert.equal(repaired[0]!.role, "user");
    assert.equal(repaired[1]!.role, "assistant");
    assert.equal(repaired[1]!.tool_calls?.[0]?.id, "orphan_1");
    assert.equal(
      repaired[1]!.tool_calls?.[0]?.function.name,
      "aggregate_probe_card_tester_performance"
    );
    assert.equal(repaired[2]!.role, "tool");
    assert.equal(repaired[2]!.tool_call_id, "orphan_1");
    assert.equal(repaired[3]!.role, "assistant");
  });

  it("leaves intact assistant(tool_calls)+tool groups", () => {
    const input = [
      { role: "user" as const, content: "q" },
      {
        role: "assistant" as const,
        content: null,
        tool_calls: [
          {
            id: "call_a",
            type: "function" as const,
            function: { name: "query_jb_bins", arguments: "{}" },
          },
        ],
      },
      {
        role: "tool" as const,
        name: "query_jb_bins",
        tool_call_id: "call_a",
        content: "{}",
      },
    ];
    const repaired = repairToolCallGroupsForLlm(input);
    assert.equal(repaired.length, 3);
    assert.equal(repaired[1]!.tool_calls?.[0]?.id, "call_a");
    assert.equal(repaired[2]!.tool_call_id, "call_a");
  });

  it("generates tool_call_id when orphan tool lacks one", () => {
    const repaired = repairToolCallGroupsForLlm([
      { role: "user", content: "q" },
      { role: "tool", name: "query_jb_bins", content: "{}" },
    ]);
    assert.equal(repaired.length, 3);
    assert.equal(repaired[1]!.role, "assistant");
    const id = repaired[1]!.tool_calls?.[0]?.id;
    assert.ok(id && id.length > 0);
    assert.equal(repaired[2]!.tool_call_id, id);
  });
});
