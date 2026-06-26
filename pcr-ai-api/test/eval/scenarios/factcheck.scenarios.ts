/**
 * Fact-check scenarios.
 *
 * Pain category: "数字/事实不准". Each fixes tool results, then feeds the summary
 * text through the fact checker and asserts whether a hallucination is caught.
 */

import {
  buildFactSheetFromHistory,
  factCheckSummaryText,
} from "../../../src/lib/agent/agentFactChecker.js";
import type { ChatMessage } from "../../../src/lib/agent/agentHistory.js";
import { type EvalScenario, type EvalResult } from "../evalTypes.js";

function toolMsg(name: string, payload: Record<string, unknown>): ChatMessage {
  return { role: "tool", name, content: JSON.stringify(payload) } as ChatMessage;
}

// A single JB lot with one card and one pass yield.
const jbResult = toolMsg("query_jb_bins", {
  lot: "DR43782.1A",
  device: "WA10P29E",
  cardByPassId: [{ passId: 1, cardId: "7804-02" }],
  yieldByPassId: [{ passId: 1, yieldPct: 91.33 }],
});

const ymResult = toolMsg("query_yield_triggers", { rows: [{ LOTID: "DR45723.1W" }] });

function check(history: ChatMessage[], answer: string, shouldFlag: boolean, flagContains?: string): EvalResult {
  const facts = buildFactSheetFromHistory(history);
  const res = factCheckSummaryText(answer, facts);
  const flagged = !res.ok;
  if (flagged !== shouldFlag) {
    return {
      pass: false,
      detail: shouldFlag
        ? `应被标记为可疑但未标记(answer 含编造数据)`
        : `不应被标记却被标记: ${res.ok ? "" : res.issue}`,
    };
  }
  if (shouldFlag && flagContains && !res.ok && !res.issue.includes(flagContains)) {
    return { pass: false, detail: `标记信息未提及 ${JSON.stringify(flagContains)}` };
  }
  return { pass: true };
}

export const factcheckScenarios: EvalScenario[] = [
  {
    id: "fact-hallucinated-lot-flagged",
    category: "factcheck",
    title: "结论引用工具数据里不存在的 lot → 必须标记",
    run: () => check([jbResult], "批次 ZZ99999.9Z pass1 良率 91.33%，表现正常。", true, "ZZ99999.9Z"),
  },
  {
    id: "fact-clean-lot-not-flagged",
    category: "factcheck",
    title: "结论只引用真实 lot → 不应标记",
    run: () => check([jbResult], "批次 DR43782.1A pass1 良率约 91.3%，单片无可对比项。", false),
  },
  {
    id: "fact-hallucinated-card-flagged",
    category: "factcheck",
    title: "结论引用 cardByPassId 之外的卡号 → 必须标记",
    run: () =>
      check([jbResult], "DR43782.1A 使用探针卡 6045-10，pass1 良率 91.33%。", true, "6045-10"),
  },
  {
    id: "fact-card-not-confused-by-date",
    category: "factcheck",
    title: "结论里的日期串 2026-06 不应被误判为探针卡卡号",
    seed: "bug commit a4923ad",
    run: () => check([jbResult], "DR43782.1A 于 2026-06 测试，卡 7804-02，良率 91.33%。", false),
  },
  {
    id: "fact-cross-tool-lot-attribution",
    category: "factcheck",
    title: "JB 语境(BIN/slot/良率)却把 YM-only 的 lot 当主体 → 必须标记",
    seed: "fact checker session-3 bug",
    run: () =>
      check(
        [jbResult, ymResult],
        "lot DR45723.1W 的 slot 数据显示 BIN11 坏 die 偏多，pass1 良率 91.33%。",
        true,
        "DR45723.1W"
      ),
  },
  {
    id: "fact-yield-off-by-large-margin",
    category: "factcheck",
    title: "pass1 良率声称 70% 但工具数据 91.33%(差 >8pp)→ 必须标记",
    run: () => check([jbResult], "DR43782.1A pass1 良率仅 70.0%，明显偏低。", true),
  },
];
