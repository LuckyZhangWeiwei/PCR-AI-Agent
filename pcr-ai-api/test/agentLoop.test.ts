import assert from "node:assert/strict";
import test from "node:test";
import { historyAwaitingToolSummary } from "../src/lib/agent/agentLoop.js";
import type { ChatMessage } from "../src/lib/agent/agentHistory.js";

test("historyAwaitingToolSummary is true when last turn is tool output", () => {
  const history: ChatMessage[] = [
    { role: "user", content: "8037 probecard 测试情况" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "aggregate_yield_triggers", arguments: "{}" },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: '{"totalRowsMatching":24}' },
  ];
  assert.equal(historyAwaitingToolSummary(history), true);
});

test("historyAwaitingToolSummary is false for fresh user turn", () => {
  assert.equal(
    historyAwaitingToolSummary([{ role: "user", content: "hi" }]),
    false
  );
});

test("historyAwaitingToolSummary is false after assistant text reply", () => {
  const history: ChatMessage[] = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "结论如下" },
  ];
  assert.equal(historyAwaitingToolSummary(history), false);
});
