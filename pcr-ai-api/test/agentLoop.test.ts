import assert from "node:assert/strict";
import test from "node:test";
import {
  filterAgentStreamTextForUi,
  historyAwaitingToolSummary,
} from "../src/lib/agent/agentLoop.js";
import type { ChatMessage } from "../src/lib/agent/agentHistory.js";

const THINK_OPEN = "<" + "think>";
const THINK_CLOSE = "</" + "think>";
const REASONING_OPEN = "<redacted_reasoning>";
const REASONING_CLOSE = "</redacted_reasoning>";

test("filterAgentStreamTextForUi strips think blocks from content stream", () => {
  const out = filterAgentStreamTextForUi([
    "结论：",
    THINK_OPEN,
    "内部推理不应显示",
    THINK_CLOSE,
    "良率正常。",
  ]);
  assert.equal(out, "结论：良率正常。");
});

test("filterAgentStreamTextForUi strips split think tags across chunks", () => {
  const out = filterAgentStreamTextForUi([
    "开始",
    "<thi",
    "nk>secret",
    THINK_CLOSE,
    "结束",
  ]);
  assert.equal(out, "开始结束");
});

const THINKING_OPEN = "<think>";
const THINKING_CLOSE = "</think>";
/** Fullwidth vertical line as in SiliconFlow DSML markup */
const FW_PIPE = "\uFF5C";
function dsmlMarkup(inner: string): string {
  return inner.replace(/\|/g, FW_PIPE);
}

test("filterAgentStreamTextForUi strips redacted_thinking blocks", () => {
  const out = filterAgentStreamTextForUi([
    "前言",
    THINKING_OPEN,
    "不应显示",
    THINKING_CLOSE,
    "后语",
  ]);
  assert.equal(out, "前言后语");
});

test("filterAgentStreamTextForUi strips DSML tool_calls markup", () => {
  const block = dsmlMarkup(
    `<|DSML|tool_calls>
<|DSML|invoke name="query_inf_site_bin_by_dut">
<|DSML|parameter name="device" string="true">WA11P07K</|DSML|parameter>
<|DSML|parameter name="lot" string="true">DR39404.1C</|DSML|parameter>
</|DSML|invoke>
</|DSML|tool_calls>`
  );
  const out = filterAgentStreamTextForUi([
    "好的，",
    block,
    "请看结论。",
  ]);
  assert.equal(out, "好的，请看结论。");
});

test("filterAgentStreamTextForUi strips redacted_reasoning blocks", () => {
  const out = filterAgentStreamTextForUi([
    "OK",
    REASONING_OPEN,
    "hidden",
    REASONING_CLOSE,
    "。",
  ]);
  assert.equal(out, "OK。");
});

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
