import assert from "node:assert/strict";
import test from "node:test";
import {
  filterAgentStreamTextForUi,
  historyAwaitingToolSummary,
  parseMinimaxInvokeBody,
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

test("filterAgentStreamTextForUi strips MiniMax tool_call markup", () => {
  const block = `<minimax:tool_call>
<invoke name="aggregate_jb_bins">
<parameter name="groupBy">lot</parameter>
<parameter name="cardId">6095-01</parameter>
<parameter name="groupTop">100</parameter>
</invoke>
</minimax:tool_call>`;
  const out = filterAgentStreamTextForUi([
    "该卡测试过大量 lot。让我重新查询，按 lot 维度统计：",
    block,
    "请稍候。",
  ]);
  assert.equal(out, "该卡测试过大量 lot。让我重新查询，按 lot 维度统计：请稍候。");
});

test("filterAgentStreamTextForUi strips split MiniMax tag across chunks", () => {
  const out = filterAgentStreamTextForUi([
    "查询中",
    "<minimax:tool_c",
    'all>\n<invoke name="aggregate_jb_bins">\n<parameter name="groupBy">lot</parameter>\n</invoke>\n</minimax:tool_call>',
    "完成",
  ]);
  assert.equal(out, "查询中完成");
});

test("filterAgentStreamTextForUi strips MiniMax JSON invoke orphan tail", () => {
  const out = filterAgentStreamTextForUi([
    'cardId: "7747-01",\nlimit: 1000\n}\n</invoke>\n</minimax:tool_call>',
  ]);
  assert.equal(out, "");
});

test("filterAgentStreamTextForUi strips MiniMax invoke with JSON body", () => {
  const block = `<minimax:tool_call>
<invoke name="query_jb_bins">
{
  "cardId": "7747-01",
  "limit": 200
}
</invoke>
</minimax:tool_call>`;
  const out = filterAgentStreamTextForUi(["正在查询…", block]);
  assert.equal(out, "正在查询…");
});

test("parseMinimaxInvokeBody reads JSON and loose key:value in invoke", () => {
  assert.deepEqual(
    parseMinimaxInvokeBody(
      `<invoke name="query_jb_bins">{"cardId":"7747-01","limit":200}</invoke>`
    ),
    { cardId: "7747-01", limit: "200" }
  );
  assert.deepEqual(
    parseMinimaxInvokeBody(
      `<invoke name="query_jb_bins">cardId: "7747-01", limit: 1000 }</invoke>`
    ),
    { cardId: "7747-01", limit: "1000" }
  );
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
