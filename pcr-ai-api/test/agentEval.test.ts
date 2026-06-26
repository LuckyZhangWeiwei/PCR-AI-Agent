// Regression wrapper: the deterministic eval scenarios also run under `npm test`
// so a quality regression fails CI, not just the standalone scorecard.
import test from "node:test";
import assert from "node:assert/strict";

process.env["INFCONTROL_LAYER_BINS_DUMMY"] = "true";
process.env["YIELD_MONITOR_TRIGGERS_DUMMY"] = "true";

import { allScenarios } from "./eval/allScenarios.js";
import { runScenarios } from "./eval/evalRunner.js";

test("agent quality eval — all deterministic scenarios pass", async () => {
  const report = await runScenarios(allScenarios, { live: false });
  const failures = report.outcomes.filter((o) => o.status === "fail");
  const msg = failures.map((f) => `[${f.scenario.category}] ${f.scenario.id}: ${f.detail}`).join("\n");
  assert.equal(failures.length, 0, `\n${failures.length} 个质量场景失败:\n${msg}`);
});
