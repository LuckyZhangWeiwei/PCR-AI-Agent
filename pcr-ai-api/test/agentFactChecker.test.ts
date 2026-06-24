import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFactSheetFromHistory,
  factCheckSummaryText,
} from "../src/lib/agent/agentFactChecker.js";
import type { ChatMessage } from "../src/lib/agent/agentHistory.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeJbMsg(lot: string, extras: Record<string, unknown> = {}): ChatMessage {
  return {
    role: "tool",
    name: "query_jb_bins",
    tool_call_id: "t1",
    content: JSON.stringify({
      lot,
      device: "WA88888822N95G",
      totalDistinctLots: 12,
      recentLotsByTestEnd: [
        { lot: "DR45721.1K", testEnd: "2026-06-10" },
        { lot: "DR45722.1A", testEnd: "2026-06-08" },
      ],
      distinctSlots: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25],
      cardByPassId: [
        { passId: 1, cardId: "6045-10" },
        { passId: 3, cardId: "6045-10" },
      ],
      yieldByPassId: [
        { passId: 1, yieldPct: 92.5, slotCount: 25 },
        { passId: 3, yieldPct: 89.3, slotCount: 25 },
      ],
      ...extras,
    }),
  };
}

function makeYmMsg(lots: string[]): ChatMessage {
  return {
    role: "tool",
    name: "query_yield_triggers",
    tool_call_id: "t2",
    content: JSON.stringify({
      rows: lots.map((l) => ({ LOTID: l, TRIGGER_LABEL: "test", PROBECARD: "6045-10" })),
    }),
  };
}

// ── buildFactSheetFromHistory ─────────────────────────────────────────────────

test("extracts all fields from JB tool result", () => {
  const facts = buildFactSheetFromHistory([makeJbMsg("DR45721.1K")]);
  assert.ok(facts.knownLots.has("DR45721.1K"));
  assert.ok(facts.jbLots.has("DR45721.1K"));
  assert.ok(facts.knownCardIds.has("6045-10"));
  assert.ok(facts.knownDevices.has("WA88888822N95G"));
  assert.equal(facts.slotCount, 25);
  assert.equal(facts.totalDistinctLots, 12);
  assert.ok(facts.yieldByPassId.has(1));
  assert.ok(Math.abs((facts.yieldByPassId.get(1) ?? 0) - 92.5) < 0.1);
});

test("separates JB lots from YM lots", () => {
  const history: ChatMessage[] = [
    makeYmMsg(["DR45723.1W"]),
    makeJbMsg("DR45721.1K"),
  ];
  const facts = buildFactSheetFromHistory(history);
  assert.ok(facts.jbLots.has("DR45721.1K"));
  assert.ok(!facts.jbLots.has("DR45723.1W"), "YM lot 不应在 jbLots 中");
  assert.ok(facts.ymLots.has("DR45723.1W"));
  assert.ok(!facts.ymLots.has("DR45721.1K"), "JB lot 不应在 ymLots 中");
  assert.ok(facts.knownLots.has("DR45721.1K"));
  assert.ok(facts.knownLots.has("DR45723.1W"));
});

test("empty history gives empty fact sheet", () => {
  const facts = buildFactSheetFromHistory([]);
  assert.equal(facts.knownLots.size, 0);
  assert.equal(facts.totalDistinctLots, null);
  assert.equal(facts.slotCount, null);
  assert.equal(facts.yieldByPassId.size, 0);
});

test("computes yield from slotYieldSummary when yieldByPassId absent", () => {
  const msg: ChatMessage = {
    role: "tool",
    name: "query_jb_bins",
    tool_call_id: "t1",
    content: JSON.stringify({
      lot: "DR45721.1K",
      device: "WA01P14R",
      slotYieldSummary: [
        { slot: 1, passId: 1, grossDie: 100, goodDie: 90, badDie: 10, yieldPct: 90 },
        { slot: 2, passId: 1, grossDie: 100, goodDie: 95, badDie: 5, yieldPct: 95 },
      ],
    }),
  };
  const facts = buildFactSheetFromHistory([msg]);
  // aggregate: (90+95) / (100+100) * 100 = 92.5
  assert.ok(facts.yieldByPassId.has(1));
  assert.ok(Math.abs((facts.yieldByPassId.get(1) ?? 0) - 92.5) < 0.1);
  assert.equal(facts.slotCount, 2);
});

// ── check 1: lot ID existence ─────────────────────────────────────────────────

test("check 1 passes when all mentioned lots are in tool results", () => {
  const facts = buildFactSheetFromHistory([makeJbMsg("DR45721.1K")]);
  const result = factCheckSummaryText("DR45721.1K 的 pass1 良率为 92.5%。", facts);
  assert.equal(result.ok, true);
});

test("check 1 fails when text mentions a lot not in any tool result (hallucinated lot)", () => {
  const facts = buildFactSheetFromHistory([makeJbMsg("DR45721.1K")]);
  const result = factCheckSummaryText("DR45999.9Z 的 BIN90 坏 die 最高。", facts);
  assert.equal(result.ok, false);
  assert.ok((result as { ok: false; issue: string }).issue.includes("DR45999.9Z"));
});

test("check 1 skips when knownLots is empty (no tool results yet)", () => {
  const facts = buildFactSheetFromHistory([]);
  const result = factCheckSummaryText("DR45999.9Z 良率正常。", facts);
  assert.equal(result.ok, true, "空 fact sheet 不应误报");
});

// ── check 2: cross-tool lot attribution ──────────────────────────────────────

test("check 2 catches Session-3 bug: JB BIN text uses YM-only lot", () => {
  // Session 3 bug scenario:
  // YM returned LOTID=DR45723.1W; JB returned lot=DR45721.1K
  // LLM labeled the BIN table as "lot DR45723.1W"
  const history: ChatMessage[] = [
    makeYmMsg(["DR45723.1W"]),
    makeJbMsg("DR45721.1K"),
  ];
  const facts = buildFactSheetFromHistory(history);
  const result = factCheckSummaryText(
    "以下是 DR45723.1W 的 BIN 分布，BIN90 共 5 颗，为主要失效 BIN。",
    facts
  );
  assert.equal(result.ok, false);
  const issue = (result as { ok: false; issue: string }).issue;
  assert.ok(issue.includes("DR45723.1W"), "应指出混用的 YM lot");
  assert.ok(issue.includes("DR45721.1K"), "应提示正确的 JB lot");
});

test("check 2 passes when JB-context text uses a JB lot (correct attribution)", () => {
  const history: ChatMessage[] = [
    makeYmMsg(["DR45723.1W"]),
    makeJbMsg("DR45721.1K"),
  ];
  const facts = buildFactSheetFromHistory(history);
  const result = factCheckSummaryText(
    "以下是 DR45721.1K 的 BIN 分布，BIN90 共 5 颗。",
    facts
  );
  assert.equal(result.ok, true, "使用 JB 自己的 lot 不应报错");
});

test("check 2 skips when only one tool domain ran (no cross-tool confusion possible)", () => {
  const history: ChatMessage[] = [makeJbMsg("DR45721.1K")];
  const facts = buildFactSheetFromHistory(history);
  // ymLots is empty, so check 2 cannot fire
  const result = factCheckSummaryText(
    "DR45721.1K 的 BIN 分布如下。",
    facts
  );
  assert.equal(result.ok, true);
});

// ── check 3: lot count ────────────────────────────────────────────────────────

test("check 3 passes when lot count matches totalDistinctLots", () => {
  const facts = buildFactSheetFromHistory([makeJbMsg("DR45721.1K")]); // totalDistinctLots = 12
  const result = factCheckSummaryText("该探针卡共 12 个 lot 的测试记录。", facts);
  assert.equal(result.ok, true);
});

test("check 3 fails when LLM claims wrong lot count (Session-2 bug)", () => {
  // Session 2 bug: LLM said "共 50 个 lot" without calling JB, only had YM data
  const facts = buildFactSheetFromHistory([makeJbMsg("DR45721.1K")]); // totalDistinctLots = 12
  const result = factCheckSummaryText("该 device 共 50 个 lot 需要关注。", facts);
  assert.equal(result.ok, false);
  const issue = (result as { ok: false; issue: string }).issue;
  assert.ok(issue.includes("50"));
  assert.ok(issue.includes("12"));
});

test("check 3 allows ±1 tolerance", () => {
  const facts = buildFactSheetFromHistory([makeJbMsg("DR45721.1K")]); // totalDistinctLots = 12
  assert.equal(factCheckSummaryText("共 11 个 lot。", facts).ok, true);
  assert.equal(factCheckSummaryText("共 13 个 lot。", facts).ok, true);
  assert.equal(factCheckSummaryText("共 15 个 lot。", facts).ok, false);
});

// ── check 4: card ID ──────────────────────────────────────────────────────────

test("check 4 passes when card ID matches cardByPassId", () => {
  const facts = buildFactSheetFromHistory([makeJbMsg("DR45721.1K")]); // cardId = 6045-10
  const result = factCheckSummaryText("本批次使用探针卡 6045-10 进行测试。", facts);
  assert.equal(result.ok, true);
});

test("check 4 fails when LLM mentions a card ID not in tool data", () => {
  const facts = buildFactSheetFromHistory([makeJbMsg("DR45721.1K")]); // only 6045-10
  const result = factCheckSummaryText("本批次使用探针卡 9999-99 进行测试。", facts);
  assert.equal(result.ok, false);
  const issue = (result as { ok: false; issue: string }).issue;
  assert.ok(issue.includes("9999-99"), "应指出错误卡号");
  assert.ok(issue.includes("6045-10"), "应提示正确卡号");
});

test("check 4 does NOT flag date strings as card IDs (false-positive guard)", () => {
  // "2026-06" looks like dddd-dd but is a date — must not trigger card ID check
  const facts = buildFactSheetFromHistory([makeJbMsg("DR45721.1K")]); // cardId = 6045-10
  const result = factCheckSummaryText(
    "截至 2026-06 月的测试数据显示，探针卡 6045-10 性能稳定。",
    facts
  );
  assert.equal(result.ok, true, "日期字符串 2026-06 不应被识别为探针卡 ID");
});

test("check 4 skips when no cardByPassId in tool data", () => {
  const msg: ChatMessage = {
    role: "tool",
    name: "query_jb_bins",
    tool_call_id: "t1",
    content: JSON.stringify({ lot: "DR45721.1K", device: "WA01P14R" }), // no cardByPassId
  };
  const facts = buildFactSheetFromHistory([msg]);
  const result = factCheckSummaryText("使用探针卡 6045-99 测试。", facts);
  assert.equal(result.ok, true, "无卡号数据时不应误报");
});

// ── check 5: device code ──────────────────────────────────────────────────────

test("check 5 passes when device matches tool data", () => {
  const facts = buildFactSheetFromHistory([makeJbMsg("DR45721.1K")]); // device = WA88888822N95G
  const result = factCheckSummaryText("device WA88888822N95G 的良率稳定。", facts);
  assert.equal(result.ok, true);
});

test("check 5 fails when LLM mentions a device not in tool data", () => {
  const facts = buildFactSheetFromHistory([makeJbMsg("DR45721.1K")]); // device = WA88888822N95G
  const result = factCheckSummaryText("device WA99999999ZZZZ 的良率异常。", facts);
  assert.equal(result.ok, false);
  const issue = (result as { ok: false; issue: string }).issue;
  assert.ok(issue.includes("WA99999999ZZZZ"));
});

// ── check 6: slot count ───────────────────────────────────────────────────────

test("check 6 passes when slot count matches distinctSlots", () => {
  const facts = buildFactSheetFromHistory([makeJbMsg("DR45721.1K")]); // slotCount = 25
  const result = factCheckSummaryText("本批次共 25 片，pass1 良率均正常。", facts);
  assert.equal(result.ok, true);
});

test("check 6 fails when LLM claims wrong slot count", () => {
  const facts = buildFactSheetFromHistory([makeJbMsg("DR45721.1K")]); // slotCount = 25
  const result = factCheckSummaryText("本批次共 10 片，存在 BIN90 异常。", facts);
  assert.equal(result.ok, false);
  const issue = (result as { ok: false; issue: string }).issue;
  assert.ok(issue.includes("10"));
  assert.ok(issue.includes("25"));
});

test("check 6 allows ±2 tolerance", () => {
  const facts = buildFactSheetFromHistory([makeJbMsg("DR45721.1K")]); // slotCount = 25
  assert.equal(factCheckSummaryText("共 24 片。", facts).ok, true);
  assert.equal(factCheckSummaryText("共 27 片。", facts).ok, true);
  assert.equal(factCheckSummaryText("共 30 片。", facts).ok, false);
});

// ── check 7: yield percentage ─────────────────────────────────────────────────

test("check 7 passes when yield matches tool data within tolerance", () => {
  const facts = buildFactSheetFromHistory([makeJbMsg("DR45721.1K")]); // pass1=92.5%, pass3=89.3%
  const result = factCheckSummaryText(
    "pass1 良率 92.5%，pass3 良率 89.3%，整体表现稳定。",
    facts
  );
  assert.equal(result.ok, true);
});

test("check 7 passes when yield is within ±8pp tolerance", () => {
  const facts = buildFactSheetFromHistory([makeJbMsg("DR45721.1K")]); // pass1=92.5%
  // 88% is within ±8pp of 92.5% → should pass
  const result = factCheckSummaryText("pass1 良率 88%，略低于标准线。", facts);
  assert.equal(result.ok, true);
});

test("check 7 fails when yield differs by >8pp from tool data", () => {
  const facts = buildFactSheetFromHistory([makeJbMsg("DR45721.1K")]); // pass1=92.5%
  // 75% is far from 92.5% → should fail
  const result = factCheckSummaryText("sort1 良率 75%，明显偏低。", facts);
  assert.equal(result.ok, false);
  const issue = (result as { ok: false; issue: string }).issue;
  assert.ok(issue.includes("75.0%"));
  assert.ok(issue.includes("92.5%"));
});

test("check 7 skips when text has no yield claims with pass context", () => {
  const facts = buildFactSheetFromHistory([makeJbMsg("DR45721.1K")]);
  // "良率正常" — no specific number or pass context → skip
  const result = factCheckSummaryText("整体良率正常，无明显异常。", facts);
  assert.equal(result.ok, true);
});

// ── priority: returns first mismatch ──────────────────────────────────────────

test("returns first failing check when multiple checks would fail", () => {
  const history: ChatMessage[] = [
    makeYmMsg(["DR45723.1W"]),
    makeJbMsg("DR45721.1K"),
  ];
  const facts = buildFactSheetFromHistory(history);
  // Both check 1 (unknown lot) and check 2 (cross-tool) would apply.
  // Check 1 fires first: DR45999.9Z is unknown.
  const result = factCheckSummaryText(
    "以下是 DR45999.9Z 的 BIN 分布，共 slot 5 颗。",
    facts
  );
  assert.equal(result.ok, false);
  // Check 1 should fire (unknown lot), not check 2 (cross-tool)
  assert.ok((result as { ok: false; issue: string }).issue.includes("DR45999.9Z"));
});
