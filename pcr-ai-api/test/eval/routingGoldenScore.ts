import { routingGolden } from "./scenarios/routing-golden.js";
import { resolveJbRoute, classifyJbIntent } from "../../src/lib/agent/jbRouteResolver.js";
import { resolveDispatch } from "../../src/lib/agent/agentSemanticDispatchTable.js";
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
  "N55Z device 各 lot 良率 top5",
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

const DISPATCH_MODES = new Set(["bin_card_attribution", "lot_yield_ranking", "card_yield_compare"]);

/**
 * CI 派发正确性:对黄金集中三个跨实体 mode 的条目,
 * 纯正则已命中正确 mode 时,验证 resolveDispatch 产出的 plan 正确。
 * null plan = resolveDispatch 无法解析 scope → 正确落回 LLM,非失败。
 */
export function scoreDispatchOnGolden(): {
  total: number;
  dispatched: number;
  failures: { question: string; reason: string }[];
} {
  const failures: { question: string; reason: string }[] = [];
  let dispatched = 0;
  let total = 0;
  for (const c of routingGolden) {
    if (!DISPATCH_MODES.has(c.expected.mode)) continue;
    total++;
    const d = resolveJbRoute(c.question); // 纯正则;source="regex" 视为 high
    if (d.mode !== c.expected.mode) continue; // 正则未命中=已知发散,留 LLM,不测派发
    const plan = resolveDispatch(d, c.question, []);
    if (!plan) continue; // 无可解析 scope → 正确落回 LLM,非失败
    // plan 存在 → 验证派发正确
    if (c.expected.mode === "bin_card_attribution") {
      if (plan.queryTool !== "aggregate_jb_bins" || plan.args["groupBy"] !== "bin,cardId") {
        failures.push({
          question: c.question,
          reason: `bin_card 派发错: tool=${plan.queryTool} groupBy=${plan.args["groupBy"]}`,
        });
        continue;
      }
    } else {
      // lot_yield_ranking / card_yield_compare
      if (plan.queryTool !== "query_jb_bins") {
        failures.push({
          question: c.question,
          reason: `${c.expected.mode} 应 query_jb_bins, 实际 ${plan.queryTool}`,
        });
        continue;
      }
    }
    dispatched++;
  }
  return { total, dispatched, failures };
}

/** 误分类率 = regressions.length / total（total=0 时返回 0）。 */
export function hybridMisclassRate(report: { regressions: string[] }, total: number): number {
  return total === 0 ? 0 : report.regressions.length / total;
}
