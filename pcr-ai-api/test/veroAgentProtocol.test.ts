import assert from "node:assert/strict";
import test from "node:test";

import {
  renderToolSchemasAsText,
  parseVeroRoundDecision,
} from "../src/lib/agent/core/veroAgentProtocol.js";

test("renderToolSchemasAsText renders name/description/params with required marker", () => {
  const schemas = [
    {
      type: "function",
      function: {
        name: "query_jb_bins",
        description: "查询 JB STAR bin 数据",
        parameters: {
          type: "object",
          properties: {
            device: { type: "string", description: "产品代码" },
            limit: { type: "number", description: "返回行数" },
          },
          required: ["device"],
        },
      },
    },
  ];
  const text = renderToolSchemasAsText(schemas);
  assert.ok(text.includes("### query_jb_bins"));
  assert.ok(text.includes("查询 JB STAR bin 数据"));
  assert.ok(text.includes("device (string，必填): 产品代码"));
  assert.ok(text.includes("limit (number): 返回行数"));
});

test("renderToolSchemasAsText handles a tool with no parameters", () => {
  const schemas = [
    {
      type: "function",
      function: { name: "noop", description: "d", parameters: { type: "object", properties: {}, required: [] } },
    },
  ];
  const text = renderToolSchemasAsText(schemas);
  assert.ok(text.includes("### noop"));
  assert.ok(text.includes("(无参数)"));
});

test("parseVeroRoundDecision parses a tool decision", () => {
  const d = parseVeroRoundDecision(
    '{"action":"tool","tool":"query_jb_bins","args":{"device":"WA03P02G"}}'
  );
  assert.deepEqual(d, { action: "tool", tool: "query_jb_bins", args: { device: "WA03P02G" } });
});

test("parseVeroRoundDecision defaults args to {} when omitted", () => {
  const d = parseVeroRoundDecision('{"action":"tool","tool":"get_filter_values"}');
  assert.deepEqual(d, { action: "tool", tool: "get_filter_values", args: {} });
});

test("parseVeroRoundDecision parses final/chat decisions", () => {
  assert.deepEqual(parseVeroRoundDecision('{"action":"final","reply":"结论：良率 95%"}'), {
    action: "final",
    reply: "结论：良率 95%",
  });
  assert.deepEqual(parseVeroRoundDecision('{"action":"chat","reply":"你好"}'), {
    action: "chat",
    reply: "你好",
  });
});

test("parseVeroRoundDecision accepts fenced JSON (via parseJsonLoose)", () => {
  const d = parseVeroRoundDecision('```json\n{"action":"chat","reply":"hi"}\n```');
  assert.deepEqual(d, { action: "chat", reply: "hi" });
});

test("parseVeroRoundDecision throws on missing tool name", () => {
  assert.throws(() => parseVeroRoundDecision('{"action":"tool","args":{}}'), /missing "tool" name/);
});

test("parseVeroRoundDecision throws on missing reply text", () => {
  assert.throws(() => parseVeroRoundDecision('{"action":"final"}'), /missing "reply" text/);
});

test("parseVeroRoundDecision throws on unknown action", () => {
  assert.throws(() => parseVeroRoundDecision('{"action":"nope"}'), /unknown action/);
});

test("parseVeroRoundDecision normalizes a top-level ask_clarification action into a tool decision (real model deviation observed via Cursor's real-network verification, 2026-07-23)", () => {
  // Vero returned this exact payload for an ambiguous question instead of
  // the instructed {"action":"tool","tool":"ask_clarification",...} shape —
  // see scratchpad/realdb-vero-q2-partial-2026-07-23.json (Q2-4-ambiguous).
  const d = parseVeroRoundDecision(
    '{"action":"ask_clarification","args":{"question":"请提供要查询的批次号（lot ID）或产品代码（device）"}}'
  );
  assert.deepEqual(d, {
    action: "tool",
    tool: "ask_clarification",
    args: { question: "请提供要查询的批次号（lot ID）或产品代码（device）" },
  });
});

test("parseVeroRoundDecision normalizes ask_clarification even when question/options are flat (no nested args)", () => {
  const d = parseVeroRoundDecision(
    '{"action":"ask_clarification","question":"是哪个 device？","options":["WA03P02G","WA00P32P"]}'
  );
  assert.deepEqual(d, {
    action: "tool",
    tool: "ask_clarification",
    args: { question: "是哪个 device？", options: ["WA03P02G", "WA00P32P"] },
  });
});

test("parseVeroRoundDecision throws on non-object JSON", () => {
  assert.throws(() => parseVeroRoundDecision("[1,2,3]"), /not a JSON object/);
});
