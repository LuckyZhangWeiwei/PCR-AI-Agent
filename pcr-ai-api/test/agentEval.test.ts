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

test("黄金集:纯正则打分可用且无崩溃", async () => {
  const { scoreRegexOnGolden } = await import("./eval/routingGoldenScore.js");
  const r = scoreRegexOnGolden();
  assert.ok(r.total >= 80, `黄金集应≥80条,实际 ${r.total}`);
});

test("闸门:纯正则在 baseline 问句上零回退", async () => {
  const { scoreRegexOnGolden, REGEX_BASELINE_PASS_QUESTIONS } = await import("./eval/routingGoldenScore.js");
  const failingNow = new Set(scoreRegexOnGolden().failures.map((f) => f.question));
  const regressed = REGEX_BASELINE_PASS_QUESTIONS.filter((q) => failingNow.has(q));
  assert.deepEqual(regressed, [], `baseline 问句回退: ${regressed.join(" | ")}`);
});

test("闸门[live]:混合路由对黄金集零 mode 回退", { skip: process.env.AGENT_EVAL_LIVE !== "1" }, async () => {
  const { scoreHybridOnGolden } = await import("./eval/routingGoldenScore.js");
  const cfg = { subAgentModel: process.env.AGENT_SUBAGENT_MODEL, apiKey: process.env.AGENT_API_KEY } as any;
  const { regressions } = await scoreHybridOnGolden(cfg);
  assert.deepEqual(regressions, [], `混合路由回退: ${regressions.join(" | ")}`);
});

test("阶段三:派发正确性(纯正则,CI)", async () => {
  const { scoreDispatchOnGolden } = await import("./eval/routingGoldenScore.js");
  const r = scoreDispatchOnGolden();
  // 对高置信入表条目,resolveDispatch 必须产出正确 queryTool;失败清单为空
  assert.deepEqual(r.failures, [], `派发不正确:\n${r.failures.map(f=>f.question+": "+f.reason).join("\n")}`);
  // 调查结论:仅含 device/mask scope 的问句才能产出 plan（n55z / WC13N55Z 各一条），
  // 其余 bin_card_attribution 均因无 scope 返回 null → 正确落回 LLM，dispatched≥2 已非空集。
  assert.ok(r.dispatched >= 2, `dispatched=${r.dispatched} 过低,正则 + scope 解析应覆盖 ≥2 条黄金问句`);
});

test("阶段三[live]:混合路由误分类率 ≤ 2%", { skip: process.env.AGENT_EVAL_LIVE !== "1" }, async () => {
  const { scoreHybridOnGolden, hybridMisclassRate } = await import("./eval/routingGoldenScore.js");
  const cfg = { subAgentModel: process.env.AGENT_SUBAGENT_MODEL, apiKey: process.env.AGENT_API_KEY } as any;
  const report = await scoreHybridOnGolden(cfg);
  const { routingGolden } = await import("./eval/scenarios/routing-golden.js");
  const rate = hybridMisclassRate(report, routingGolden.length);
  assert.ok(rate <= 0.02, `误分类率 ${(rate*100).toFixed(1)}% > 2%:\n${report.regressions.join("\n")}`);
});
