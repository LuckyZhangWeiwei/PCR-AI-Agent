import { routingGolden } from "./scenarios/routing-golden.js";
import { resolveJbRoute } from "../../src/lib/agent/jbRouteResolver.js";

function regexDecisionMatches(q: string, want: (typeof routingGolden)[number]["expected"]) {
  const d = resolveJbRoute(q);
  const got = {
    mode: d.mode,
    isMultiCardCompare: d.isMultiCardCompare,
    isMultiLotCompare: d.isMultiLotCompare,
    isDutLevel: d.isDutLevel,
  };
  const okMode = got.mode === want.mode;
  const okFlags =
    got.isMultiCardCompare === want.isMultiCardCompare &&
    got.isMultiLotCompare === want.isMultiLotCompare &&
    got.isDutLevel === want.isDutLevel;
  return { pass: okMode && okFlags, got };
}

export function scoreRegexOnGolden(): {
  total: number;
  passed: number;
  failures: { question: string; got: string; want: string }[];
} {
  const failures: { question: string; got: string; want: string }[] = [];
  let passed = 0;
  for (const c of routingGolden) {
    const r = regexDecisionMatches(c.question, c.expected);
    if (r.pass) passed++;
    else failures.push({ question: c.question, got: JSON.stringify(r.got), want: JSON.stringify(c.expected) });
  }
  return { total: routingGolden.length, passed, failures };
}
