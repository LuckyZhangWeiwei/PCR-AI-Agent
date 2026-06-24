import assert from "node:assert/strict";
import test from "node:test";
import { validateAndFixToolArgs } from "../src/lib/agent/agentToolValidator.js";

// ── cardId auto-injection ────────────────────────────────────────────────────

test("injects cardId when user asks about specific probe card and model omits it", () => {
  const { args, notes } = validateAndFixToolArgs(
    "query_jb_bins",
    { device: "WA88888822N95G", limit: 200 },
    "6045-10 最近一个月的测试情况"
  );
  assert.equal(args["cardId"], "6045-10", "cardId 应被自动注入");
  assert.ok(notes.length > 0, "应有修正记录");
});

test("does NOT inject cardId when lot is already present (lot-specific query)", () => {
  const { args, notes } = validateAndFixToolArgs(
    "query_jb_bins",
    { lot: "DR45721.1K", device: "WA88888822N95G" },
    "6045-10 最近一个月的测试情况"
  );
  assert.equal(args["cardId"], undefined, "有 lot 时不应注入 cardId");
  assert.equal(notes.length, 0);
});

test("does NOT inject cardId when cardId already present", () => {
  const { args, notes } = validateAndFixToolArgs(
    "query_jb_bins",
    { cardId: "6045-10", limit: 200 },
    "6045-10 最近情况"
  );
  assert.equal(args["cardId"], "6045-10");
  assert.equal(notes.length, 0, "已有正确 cardId 时不应产生修正");
});

test("does NOT inject cardId when question has no card pattern", () => {
  const { args, notes } = validateAndFixToolArgs(
    "query_jb_bins",
    { device: "WA01P14R", limit: 200 },
    "WA01P14R 最近的测试情况"
  );
  assert.equal(args["cardId"], undefined);
  assert.equal(notes.length, 0);
});

// ── limit clamp ──────────────────────────────────────────────────────────────

test("clamps query_jb_bins limit from 1000 to 200", () => {
  const { args, notes } = validateAndFixToolArgs(
    "query_jb_bins",
    { cardId: "7747-01", limit: 1000 },
    "7747-01 最近情况"
  );
  assert.equal(args["limit"], 200);
  assert.ok(notes.some(n => n.includes("200")));
});

test("clamps query_yield_triggers limit", () => {
  const { args } = validateAndFixToolArgs(
    "query_yield_triggers",
    { probeCard: "7747-01", limit: 500 },
    "7747-01 报警情况"
  );
  assert.equal(args["limit"], 200);
});

test("does NOT clamp limit when already ≤200", () => {
  const { args, notes } = validateAndFixToolArgs(
    "query_jb_bins",
    { cardId: "7747-01", limit: 200 },
    "7747-01 情况"
  );
  assert.equal(args["limit"], 200);
  assert.equal(notes.length, 0);
});

test("clamps aggregate_jb_bins groupTop from 100 to 50", () => {
  const { args, notes } = validateAndFixToolArgs(
    "aggregate_jb_bins",
    { mask: "P14R", groupBy: "lot", groupTop: 100 },
    "P14R 最近 lot 汇总"
  );
  assert.equal(args["groupTop"], 50);
  assert.ok(notes.length > 0);
});

// ── passthrough for correct calls ────────────────────────────────────────────

test("correct args pass through unchanged with no notes", () => {
  const original = { cardId: "6045-10", limit: 200, testEndFrom: "2026-05-01", testEndTo: "2026-06-01" };
  const { args, notes } = validateAndFixToolArgs(
    "query_jb_bins",
    original,
    "6045-10 最近一个月"
  );
  assert.deepEqual(args, original);
  assert.equal(notes.length, 0);
});

test("does not modify unrecognised tool names", () => {
  const original = { foo: "bar", limit: 9999 };
  const { args, notes } = validateAndFixToolArgs("some_other_tool", original, "whatever");
  assert.deepEqual(args, original, "未知工具不应被修改");
  assert.equal(notes.length, 0);
});
