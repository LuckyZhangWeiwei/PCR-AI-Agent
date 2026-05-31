import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runTool } from "../src/lib/agent/agentToolHandlers.js";

describe("aggregate_jb_bins scope guard", () => {
  it("rejects aggregate without lot/device/cardId filter", async () => {
    const result = await runTool("aggregate_jb_bins", { groupBy: "bin", groupTop: 10 });
    assert.equal(typeof result, "string");
    assert.ok((result as string).includes("未传 lot"));
    assert.ok((result as string).includes("query_jb_bins"));
  });

  it("allows aggregate when lot is provided", async () => {
    const result = await runTool("aggregate_jb_bins", {
      groupBy: "bin",
      lot: "NF12827.1R",
      groupTop: 5,
    });
    assert.equal(typeof result, "string");
    assert.ok(!(result as string).startsWith("aggregate_jb_bins 错误"));
  });
});
