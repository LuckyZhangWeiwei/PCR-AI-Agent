/**
 * Agent answer-quality eval harness — shared types.
 *
 * A scenario is a self-contained, deterministic check against ONE piece of the
 * agent's reasoning (routing / fact-check / summary classification / empty
 * fallback). It calls the real function under test and asserts a property.
 *
 * Scenarios are pure data + a `run()` closure: no LLM, no Oracle. Tool outputs
 * are inlined as fixed JSON so every run is reproducible. Real session logs and
 * known bug commits are the SEED for questions/fixtures — never the ground
 * truth (the logged answer may itself be wrong). We define what "correct" means.
 *
 * The optional live layer (`live: true`) drives the real agent loop against a
 * dummy backend + real LLM and asserts answer *properties*; it runs only when
 * AGENT_EVAL_LIVE=1 and an API key is present (never in CI).
 */

export type EvalCategory =
  | "routing" // intent / pending-query / scope-arg inference
  | "factcheck" // hallucination guard (lot / card / yield / device)
  | "summary" // deterministic reply-mode classification + field completeness
  | "empty"; // empty / zero-result natural-language fallback

export const EVAL_CATEGORY_LABELS: Record<EvalCategory, string> = {
  routing: "路由/scope 推断",
  factcheck: "事实准确(防幻觉)",
  summary: "字段完整/总结分流",
  empty: "空结果 fallback",
};

export type EvalResult = { pass: boolean; detail?: string };

export type EvalScenario = {
  /** Stable kebab-case id, unique across all files. */
  id: string;
  category: EvalCategory;
  /** One-line human description of what correct behavior is. */
  title: string;
  /** Calls the function under test and returns pass/fail (+ why on fail). */
  run: () => EvalResult | Promise<EvalResult>;
  /** Live-LLM scenario — skipped unless AGENT_EVAL_LIVE=1. */
  live?: boolean;
  /**
   * Where this scenario came from (session-log id / bug commit / pain category).
   * Documentation only — keeps the seed traceable.
   */
  seed?: string;
};

// ── tiny assertion helpers (keep scenarios terse) ───────────────────────────

export function ok(): EvalResult {
  return { pass: true };
}

export function fail(detail: string): EvalResult {
  return { pass: false, detail };
}

export function expectEqual(actual: unknown, expected: unknown, label = "value"): EvalResult {
  return actual === expected
    ? ok()
    : fail(`期望 ${label}=${JSON.stringify(expected)}, 实际 ${JSON.stringify(actual)}`);
}

export function expectTrue(actual: boolean, label = "condition"): EvalResult {
  return actual ? ok() : fail(`期望 ${label} 为 true, 实际 false`);
}

export function expectFalse(actual: boolean, label = "condition"): EvalResult {
  return !actual ? ok() : fail(`期望 ${label} 为 false, 实际 true`);
}

/** Assert `actual` contains every substring in `needles`. */
export function expectContainsAll(actual: string, needles: string[]): EvalResult {
  const missing = needles.filter((n) => !actual.includes(n));
  return missing.length === 0
    ? ok()
    : fail(`缺少必含片段: ${missing.map((m) => JSON.stringify(m)).join(", ")}`);
}

/** Assert `actual` contains none of `needles`. */
export function expectExcludesAll(actual: string, needles: string[]): EvalResult {
  const present = needles.filter((n) => actual.includes(n));
  return present.length === 0
    ? ok()
    : fail(`出现了禁止片段: ${present.map((m) => JSON.stringify(m)).join(", ")}`);
}
