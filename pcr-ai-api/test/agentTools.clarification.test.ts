// pcr-ai-api/test/agentTools.clarification.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runTool } from "../src/lib/agent/tools/agentToolHandlers.js";

describe("ask_clarification tool", () => {
  it("no options: returns sentinel with only __clarification", async () => {
    const result = await runTool("ask_clarification", { question: "请问您查哪个 device？" });
    assert.ok(typeof result === "object" && result !== null && "__clarification" in result);
    const r = result as Record<string, unknown>;
    assert.strictEqual(r["__clarification"], "请问您查哪个 device？");
    assert.strictEqual(r["__clarification_options"], undefined);
  });

  it("with options: returns sentinel with __clarification_options array", async () => {
    const result = await runTool("ask_clarification", {
      question: "请选择要查询的完整 device 代码",
      options: ["WC13N06Z", "WC07N06Z"],
    });
    assert.ok(typeof result === "object" && result !== null && "__clarification" in result);
    const r = result as Record<string, unknown>;
    assert.strictEqual(r["__clarification"], "请选择要查询的完整 device 代码");
    assert.deepStrictEqual(r["__clarification_options"], ["WC13N06Z", "WC07N06Z"]);
  });

  it("filters empty strings from options", async () => {
    const result = await runTool("ask_clarification", {
      question: "选择",
      options: ["WC13N06Z", "", "WC07N06Z"],
    });
    const r = result as Record<string, unknown>;
    assert.deepStrictEqual(r["__clarification_options"], ["WC13N06Z", "WC07N06Z"]);
  });

  it("empty options array → __clarification_options is undefined", async () => {
    const result = await runTool("ask_clarification", {
      question: "选择",
      options: [],
    });
    const r = result as Record<string, unknown>;
    assert.strictEqual(r["__clarification_options"], undefined);
  });

  it("empty question → returns error string", async () => {
    const result = await runTool("ask_clarification", { question: "" });
    assert.strictEqual(typeof result, "string");
    assert.ok((result as string).includes("question 不能为空"));
  });
});
