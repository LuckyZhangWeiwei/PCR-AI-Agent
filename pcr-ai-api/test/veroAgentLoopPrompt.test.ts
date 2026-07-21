import assert from "node:assert/strict";
import test from "node:test";

import {
  buildVeroRoundSystemPrompt,
  serializeHistoryForVeroPrompt,
  isVeroPromptOverBudget,
} from "../src/lib/agent/core/veroAgentLoopPrompt.js";
import { VERO_PROMPT_CHAR_BUDGET } from "../src/lib/agent/core/veroAgentLoopConfig.js";
import type { ChatMessage } from "../src/lib/agent/agentHistory.js";

test("buildVeroRoundSystemPrompt includes tool list and protocol instructions", () => {
  const prompt = buildVeroRoundSystemPrompt({
    manifest: undefined,
    feedbackInjection: "",
    isLastRound: false,
  });
  assert.ok(prompt.includes("query_jb_bins"));
  assert.ok(prompt.includes('"action":"tool"'));
  assert.ok(!prompt.includes("【最后一轮】"));
});

test("buildVeroRoundSystemPrompt appends last-round instruction", () => {
  const prompt = buildVeroRoundSystemPrompt({
    manifest: undefined,
    feedbackInjection: "",
    isLastRound: true,
  });
  assert.ok(prompt.includes("【最后一轮】"));
});

test("buildVeroRoundSystemPrompt folds in feedback injection text", () => {
  const prompt = buildVeroRoundSystemPrompt({
    manifest: undefined,
    feedbackInjection: "【历史反馈】上次分析遗漏了 pass3。",
    isLastRound: false,
  });
  assert.ok(prompt.includes("上次分析遗漏了 pass3"));
});

test("serializeHistoryForVeroPrompt renders user/assistant/tool turns and summary", () => {
  const history: ChatMessage[] = [
    { role: "user", content: "WA03P02G 良率如何" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "c1", type: "function", function: { name: "query_jb_bins", arguments: '{"device":"WA03P02G"}' } },
      ],
    },
    { role: "tool", name: "query_jb_bins", tool_call_id: "c1", content: '{"rows":[]}' },
  ];
  const text = serializeHistoryForVeroPrompt(history, "此前摘要文本");
  assert.ok(text.includes("【历史对话摘要】"));
  assert.ok(text.includes("此前摘要文本"));
  assert.ok(text.includes("用户: WA03P02G 良率如何"));
  assert.ok(text.includes("AI 调用工具: query_jb_bins"));
  assert.ok(text.includes("工具[query_jb_bins]结果"));
});

test("serializeHistoryForVeroPrompt omits summary section when undefined", () => {
  const text = serializeHistoryForVeroPrompt([{ role: "user", content: "hi" }], undefined);
  assert.ok(!text.includes("【历史对话摘要】"));
});

test("isVeroPromptOverBudget flags text past the char budget", () => {
  assert.equal(isVeroPromptOverBudget("short"), false);
  assert.equal(isVeroPromptOverBudget("x".repeat(VERO_PROMPT_CHAR_BUDGET + 1)), true);
});
