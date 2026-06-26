/**
 * CLI entry for `npm run agent:eval`.
 *
 * Runs every deterministic scenario (and live scenarios when AGENT_EVAL_LIVE=1),
 * prints the category scorecard, and exits non-zero if any non-skipped scenario
 * fails — so it doubles as a guard if wired into CI.
 *
 * Dummy backends are forced on: scenarios are pure/deterministic and must never
 * touch a real Oracle client.
 */

process.env["INFCONTROL_LAYER_BINS_DUMMY"] = "true";
process.env["YIELD_MONITOR_TRIGGERS_DUMMY"] = "true";

import { allScenarios } from "./allScenarios.js";
import { runScenarios, formatScorecard } from "./evalRunner.js";

async function main(): Promise<void> {
  const live = process.env["AGENT_EVAL_LIVE"] === "1";
  const report = await runScenarios(allScenarios, { live });
  // eslint-disable-next-line no-console
  console.log(formatScorecard(report));
  const failures = report.grandTotal - report.passTotal;
  process.exit(failures > 0 ? 1 : 0);
}

void main();
