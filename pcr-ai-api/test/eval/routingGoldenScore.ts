import { routingGolden } from "./scenarios/routing-golden.js";
import { resolveJbRoute, classifyJbIntent } from "../../src/lib/agent/jbRouteResolver.js";
import type { AgentConfig } from "../../src/lib/agent/agentConfig.js";

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

/** 锁定:这些问句纯正则当前已正确命中,任何后续改动不得使其回退。 */
export const REGEX_BASELINE_PASS_QUESTIONS: string[] = [
  "n55z 哪个卡测出bin35 多",
  "BIN35 集中在哪张卡",
  "BIN7 主要是哪块卡打出来的",
  "BIN66 属于哪些探针卡",
  "bin10 和哪些探针有关",
  "DR44436.1W 用几号卡测试的",
  "DR44435.1C 用的什么卡",
  "这个lot哪张探针卡",
  "都测试了什么lot",
  "9416-04 最近两个月测试的lot 列出来",
  "有哪些批次",
  "全部lot列出来",
  "这个device所有lot都列出",
  "每片坏die情况",
  "各片坏bin排列",
  "逐片坏die汇总",
  "这几个lot分别用什么卡",
  "前5个lot各自的良率",
  "如果两张卡都偏低下一步怎么排查",
  "假如BIN35是卡的问题该怎么处理",
  "DR44435.1C 各片良率",
  "DR44435.1C 每片良率是多少",
  "这个lot逐片良率",
  "DR44435.1C 这批用的什么机台",
  "这个lot在哪台机台跑的",
  "DR44436.1W TESTERID是多少",
  "DR44435.1C BIN7 按片趋势",
  "DR44435.1C BIN35 各片多少颗",
  "BIN66 逐片分布",
  "DR44435.1C 测试中断了几次",
  "这批lot中断了多少次",
  "DR44435.1C 概况",
  "DR44436.1W 整体测试情况怎么样",
  "DR44435.1C 批次情况",
  "DR44435.1C 第3片wafer坏bin",
  "这lot第5片情况",
  "slot 12 的测试结果",
  "lot良率排名 bottom3",
  "哪张卡良率最低",
  "哪张卡良率更差",
  "探针卡哪个最差",
  "主要坏bin有哪些",
  "常见fail bin是什么",
  "坏die排行榜",
  "9416-04 这张卡的测试情况",
  "8041-08 使用情况怎么样",
  "8041-05 哪个site有问题",
];

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

/** live:对 baseline 已过的问句,断言混合路由(开 flag)mode 仍命中,产出回退清单。 */
export async function scoreHybridOnGolden(agentConfig: AgentConfig): Promise<{ regressions: string[] }> {
  process.env.JB_LLM_INTENT_CLASSIFIER = "true";
  const regressions: string[] = [];
  try {
    for (const c of routingGolden) {
      const d = await classifyJbIntent(c.question, {}, agentConfig);
      if (d.mode !== c.expected.mode) regressions.push(`${c.question} → ${d.mode}≠${c.expected.mode}`);
    }
  } finally {
    delete process.env.JB_LLM_INTENT_CLASSIFIER;
  }
  return { regressions };
}
