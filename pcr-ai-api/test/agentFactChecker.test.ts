import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFactSheetFromHistory,
  factCheckSummaryText,
} from "../src/lib/agent/agentFactChecker.js";
import type { ChatMessage } from "../src/lib/agent/agentHistory.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeToolMsg(content: string): ChatMessage {
  return { role: "tool", name: "query_jb_bins", tool_call_id: "t1", content };
}

function makeYmToolMsg(rows: Array<{ LOTID: string }>): ChatMessage {
  return {
    role: "tool",
    name: "query_yield_triggers",
    tool_call_id: "t2",
    content: JSON.stringify({ rows }),
  };
}

function makeJbToolMsg(lot: string, extras: Record<string, unknown> = {}): ChatMessage {
  return makeToolMsg(
    JSON.stringify({
      lot,
      device: "WA88888822N95G",
      totalDistinctLots: 12,
      recentLotsByTestEnd: [
        { lot: "DR45721.1K", testEnd: "2026-06-10" },
        { lot: "DR45722.1A", testEnd: "2026-06-08" },
      ],
      ...extras,
    })
  );
}

// ── buildFactSheetFromHistory ─────────────────────────────────────────────────

test("extracts primary lot from query_jb_bins result", () => {
  const history: ChatMessage[] = [makeJbToolMsg("DR45721.1K")];
  const facts = buildFactSheetFromHistory(history);
  assert.ok(facts.knownLots.has("DR45721.1K"), "应含主 lot");
  assert.ok(facts.knownLots.has("DR45722.1A"), "应含 recentLotsByTestEnd 中的 lot");
  assert.equal(facts.totalDistinctLots, 12);
});

test("extracts LOTID from YM rows", () => {
  const history: ChatMessage[] = [
    makeYmToolMsg([{ LOTID: "DR45723.1W" }, { LOTID: "DR45724.1B" }]),
  ];
  const facts = buildFactSheetFromHistory(history);
  assert.ok(facts.knownLots.has("DR45723.1W"));
  assert.ok(facts.knownLots.has("DR45724.1B"));
  assert.equal(facts.totalDistinctLots, null, "YM 结果无 totalDistinctLots");
});

test("combines lots from multiple tool messages", () => {
  const history: ChatMessage[] = [
    makeYmToolMsg([{ LOTID: "DR45723.1W" }]),
    makeJbToolMsg("DR45721.1K"),
  ];
  const facts = buildFactSheetFromHistory(history);
  assert.ok(facts.knownLots.has("DR45723.1W"), "来自 YM");
  assert.ok(facts.knownLots.has("DR45721.1K"), "来自 JB");
  assert.equal(facts.totalDistinctLots, 12);
});

test("ignores non-tool messages and non-JSON content", () => {
  const history: ChatMessage[] = [
    { role: "user", content: "DR45999.1X 的情况" },
    { role: "assistant", content: "好的，正在查询" },
    makeToolMsg("plain text result"),
  ];
  const facts = buildFactSheetFromHistory(history);
  assert.equal(facts.knownLots.size, 0);
  assert.equal(facts.totalDistinctLots, null);
});

test("empty history gives empty fact sheet", () => {
  const facts = buildFactSheetFromHistory([]);
  assert.equal(facts.knownLots.size, 0);
  assert.equal(facts.totalDistinctLots, null);
});

// ── factCheckSummaryText — lot ID checks ──────────────────────────────────────

test("passes when all mentioned lots are in tool results", () => {
  const history: ChatMessage[] = [makeJbToolMsg("DR45721.1K")];
  const facts = buildFactSheetFromHistory(history);
  const result = factCheckSummaryText(
    "DR45721.1K 的 pass1 良率为 92.5%，BIN90 异常。",
    facts
  );
  assert.equal(result.ok, true);
});

test("fails when LLM mentions a lot ID not in any tool result (Session 3 bug: cross-tool label mix)", () => {
  // Session 3 bug: YM returned DR45723.1W; JB tool returned lot DR45721.1K
  // LLM wrote the BIN table labeled as "lot DR45723.1W" — hallucination
  const history: ChatMessage[] = [
    makeYmToolMsg([{ LOTID: "DR45723.1W" }]),
    makeJbToolMsg("DR45721.1K"),
  ];
  const facts = buildFactSheetFromHistory(history);

  // Both lots ARE known, so no error here — the bug was labeling JB data as YM lot
  // This checks that a completely fabricated lot triggers the alert
  const resultFabricated = factCheckSummaryText(
    "DR45999.9Z 的 BIN90 坏 die 最高，达到 15 die。",
    facts
  );
  assert.equal(resultFabricated.ok, false);
  assert.ok(
    (resultFabricated as { ok: false; issue: string }).issue.includes("DR45999.9Z"),
    "错误信息应包含幻觉 lot"
  );
});

test("passes when knownLots is empty (no tool results yet)", () => {
  // No tool results → fact sheet is empty → lot check is skipped (avoid false positives)
  const facts = buildFactSheetFromHistory([]);
  const result = factCheckSummaryText(
    "DR45721.1K 良率正常。",
    facts
  );
  assert.equal(result.ok, true, "空 fact sheet 时不应误报");
});

// ── factCheckSummaryText — lot count checks ───────────────────────────────────

test("passes when lot count matches totalDistinctLots", () => {
  const history: ChatMessage[] = [makeJbToolMsg("DR45721.1K")];
  const facts = buildFactSheetFromHistory(history);
  const result = factCheckSummaryText(
    "该探针卡共 12 个 lot 的测试记录。",
    facts
  );
  assert.equal(result.ok, true);
});

test("fails when LLM claims wrong lot count (Session 2 bug: lot-count hallucination)", () => {
  // Session 2 bug: YM had 2 LOTID rows, LLM said "共 50 个 lot" without calling JB
  // Simulating: JB data says totalDistinctLots=12, LLM says 50
  const history: ChatMessage[] = [makeJbToolMsg("DR45721.1K")];
  const facts = buildFactSheetFromHistory(history);
  const result = factCheckSummaryText(
    "该 device 共 50 个 lot 需要关注。",
    facts
  );
  assert.equal(result.ok, false);
  const issue = (result as { ok: false; issue: string }).issue;
  assert.ok(issue.includes("50"), "应提及错误声明的数字");
  assert.ok(issue.includes("12"), "应提及正确的 totalDistinctLots");
});

test("allows ±1 tolerance on lot count (phrasing variation)", () => {
  const history: ChatMessage[] = [makeJbToolMsg("DR45721.1K")]; // totalDistinctLots = 12
  const facts = buildFactSheetFromHistory(history);

  // 11 and 13 should pass (off-by-one from 12)
  const r11 = factCheckSummaryText("共 11 个 lot 的数据。", facts);
  assert.equal(r11.ok, true, "11 ≈ 12，允许 ±1");
  const r13 = factCheckSummaryText("共 13 个 lot 的数据。", facts);
  assert.equal(r13.ok, true, "13 ≈ 12，允许 ±1");
  const r15 = factCheckSummaryText("共 15 个 lot 的数据。", facts);
  assert.equal(r15.ok, false, "15 与 12 差距 > 1，应报错");
});

test("passes when no lot count claim in text", () => {
  const history: ChatMessage[] = [makeJbToolMsg("DR45721.1K")];
  const facts = buildFactSheetFromHistory(history);
  const result = factCheckSummaryText("BIN90 失效率偏高，建议更换探针卡。", facts);
  assert.equal(result.ok, true);
});
