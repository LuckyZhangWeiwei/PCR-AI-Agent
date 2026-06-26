/**
 * Eval runner: executes scenarios, tallies by category, formats a scorecard.
 *
 * Deterministic scenarios always run. Live (`live: true`) scenarios run only
 * when AGENT_EVAL_LIVE=1 — otherwise they are reported as skipped.
 */

import {
  EVAL_CATEGORY_LABELS,
  type EvalCategory,
  type EvalScenario,
  type EvalResult,
} from "./evalTypes.js";

export type ScenarioOutcome = {
  scenario: EvalScenario;
  status: "pass" | "fail" | "skip";
  detail?: string;
};

export type CategoryTally = {
  category: EvalCategory;
  pass: number;
  total: number; // pass + fail (skipped not counted toward total)
  skipped: number;
};

export type EvalReport = {
  outcomes: ScenarioOutcome[];
  tallies: CategoryTally[];
  passTotal: number;
  grandTotal: number;
  skippedTotal: number;
};

const CATEGORY_ORDER: EvalCategory[] = ["routing", "factcheck", "summary", "empty"];

export async function runScenarios(
  scenarios: EvalScenario[],
  opts: { live: boolean }
): Promise<EvalReport> {
  const outcomes: ScenarioOutcome[] = [];

  for (const scenario of scenarios) {
    if (scenario.live && !opts.live) {
      outcomes.push({ scenario, status: "skip", detail: "live (AGENT_EVAL_LIVE 未开)" });
      continue;
    }
    let result: EvalResult;
    try {
      result = await scenario.run();
    } catch (err) {
      result = { pass: false, detail: `运行抛错: ${(err as Error).message}` };
    }
    outcomes.push({
      scenario,
      status: result.pass ? "pass" : "fail",
      detail: result.detail,
    });
  }

  const tallies: CategoryTally[] = CATEGORY_ORDER.map((category) => {
    const inCat = outcomes.filter((o) => o.scenario.category === category);
    return {
      category,
      pass: inCat.filter((o) => o.status === "pass").length,
      total: inCat.filter((o) => o.status !== "skip").length,
      skipped: inCat.filter((o) => o.status === "skip").length,
    };
  });

  const passTotal = outcomes.filter((o) => o.status === "pass").length;
  const grandTotal = outcomes.filter((o) => o.status !== "skip").length;
  const skippedTotal = outcomes.filter((o) => o.status === "skip").length;

  return { outcomes, tallies, passTotal, grandTotal, skippedTotal };
}

function pct(pass: number, total: number): string {
  if (total === 0) return "  —  ";
  return `${Math.round((pass / total) * 100)}%`.padStart(5);
}

function pad(s: string, width: number): string {
  // Pad accounting for CJK double-width chars.
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 0x2e7f ? 2 : 1;
  return s + " ".repeat(Math.max(0, width - w));
}

export function formatScorecard(report: EvalReport): string {
  const lines: string[] = [];
  lines.push("Agent 质量评分表(确定性)");
  lines.push("─".repeat(46));
  for (const t of report.tallies) {
    if (t.total === 0 && t.skipped === 0) continue;
    const label = pad(EVAL_CATEGORY_LABELS[t.category], 22);
    const score = `${t.pass}/${t.total}`.padStart(7);
    const skip = t.skipped > 0 ? `  (skip ${t.skipped})` : "";
    lines.push(`${label}${score}   ${pct(t.pass, t.total)}${skip}`);
  }
  lines.push("─".repeat(46));
  lines.push(
    `${pad("总计", 22)}${`${report.passTotal}/${report.grandTotal}`.padStart(7)}   ${pct(
      report.passTotal,
      report.grandTotal
    )}`
  );

  const failures = report.outcomes.filter((o) => o.status === "fail");
  if (failures.length > 0) {
    lines.push("");
    lines.push("失败明细:");
    for (const f of failures) {
      lines.push(`  [${f.scenario.category}] ${f.scenario.id}: ${f.detail ?? "(无详情)"}`);
    }
  }
  if (report.skippedTotal > 0) {
    lines.push("");
    lines.push(`(${report.skippedTotal} 个 live 场景已跳过；AGENT_EVAL_LIVE=1 启用)`);
  }
  return lines.join("\n");
}
