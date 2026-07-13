/**
 * Empty / zero-result fallback scenarios.
 *
 * Pain category: "空结果直接放弃 / 乱答". The loop must recognize a zero-result
 * tool response (so it injects the natural-language "no data found" hint) and
 * must not prematurely force a summary after a single empty get_filter_values.
 */

import {
  isLastToolEmptyResult,
  historyAwaitingToolSummary,
} from "../../../src/lib/agent/core/agentToolStatus.js";
import type { ChatMessage } from "../../../src/lib/agent/agentHistory.js";
import { expectTrue, expectFalse, type EvalScenario } from "../evalTypes.js";

function toolMsg(name: string, payload: Record<string, unknown>): ChatMessage {
  return { role: "tool", name, content: JSON.stringify(payload) } as ChatMessage;
}

const emptyFilter = toolMsg("get_filter_values", { domain: "jb", field: "cardId", values: [] });

export const emptyResultScenarios: EvalScenario[] = [
  {
    id: "empty-values-detected",
    category: "empty",
    title: "values:[] → 识别为空结果",
    run: () => expectTrue(isLastToolEmptyResult(emptyFilter), "isLastToolEmptyResult"),
  },
  {
    id: "empty-count-zero-detected",
    category: "empty",
    title: "count:0 → 识别为空结果",
    run: () => expectTrue(isLastToolEmptyResult(toolMsg("aggregate_jb_bins", { count: 0 })), "isLastToolEmptyResult"),
  },
  {
    id: "empty-total-rows-zero-detected",
    category: "empty",
    title: "totalRowsMatching:0 → 识别为空结果",
    run: () =>
      expectTrue(isLastToolEmptyResult(toolMsg("query_jb_bins", { totalRowsMatching: 0 })), "isLastToolEmptyResult"),
  },
  {
    id: "nonempty-not-flagged",
    category: "empty",
    title: "有数据的结果不应被判为空",
    run: () =>
      expectFalse(
        isLastToolEmptyResult(toolMsg("query_jb_bins", { lot: "DR43782.1A", totalRowsMatching: 25 })),
        "isLastToolEmptyResult"
      ),
  },
  {
    id: "summary-forced-after-two-empty-filters",
    category: "empty",
    title: "连续两次空 get_filter_values → 强制进入总结(说找不到)",
    run: () =>
      expectTrue(
        historyAwaitingToolSummary([
          emptyFilter,
          { role: "assistant", tool_calls: [{ id: "1", type: "function", function: { name: "get_filter_values", arguments: "{}" } }] } as ChatMessage,
          emptyFilter,
        ]),
        "historyAwaitingToolSummary"
      ),
  },
  {
    id: "summary-not-forced-after-one-empty-filter",
    category: "empty",
    title: "仅一次空 get_filter_values → 不强制总结(再给一轮查另一域)",
    run: () => expectFalse(historyAwaitingToolSummary([emptyFilter]), "historyAwaitingToolSummary"),
  },
];
