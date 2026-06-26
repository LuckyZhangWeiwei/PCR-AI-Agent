import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Self-contained dummy mode so this file passes standalone (no Oracle client / no
// reliance on another test file's global env side effects).
process.env["INFCONTROL_LAYER_BINS_DUMMY"] = "true";
process.env["YIELD_MONITOR_TRIGGERS_DUMMY"] = "true";

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
