import test from "node:test";
import assert from "node:assert/strict";

process.env["INFCONTROL_LAYER_BINS_DUMMY"] = "true";
process.env["NODE_ENV"] = "test";

import { runTool } from "../src/lib/agent/tools/agentToolHandlers.js";

test("query_lot_underperforming_duts with lot only returns markdown and JSON", async () => {
  const out = await runTool("query_lot_underperforming_duts", { lot: "DR43782.1A", passId: 1 });
  assert.equal(typeof out, "string");
  assert.ok(!(out as string).startsWith("query_lot_underperforming_duts 参数错误"));
  assert.ok((out as string).includes("低良率 DUT") || (out as string).includes("lotOverall"));
  assert.ok((out as string).includes('"baselineMethod":"lotOverall"') || (out as string).includes("lotOverall"));
});
