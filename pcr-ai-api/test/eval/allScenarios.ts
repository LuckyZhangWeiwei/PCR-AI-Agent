/** Aggregates every eval scenario into one ordered list. */
import type { EvalScenario } from "./evalTypes.js";
import { routingScenarios } from "./scenarios/routing.scenarios.js";
import { factcheckScenarios } from "./scenarios/factcheck.scenarios.js";
import { summaryScenarios } from "./scenarios/summary.scenarios.js";
import { emptyResultScenarios } from "./scenarios/emptyResult.scenarios.js";
import { insightScenarios } from "./scenarios/insight.scenarios.js";

export const allScenarios: EvalScenario[] = [
  ...routingScenarios,
  ...factcheckScenarios,
  ...summaryScenarios,
  ...emptyResultScenarios,
  ...insightScenarios,
];
