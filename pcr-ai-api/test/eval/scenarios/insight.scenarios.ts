import { buildDutConcentrationInsights, formatDutConcentrationMarkdown } from "../../../src/lib/agent/agentDutConcentration.js";
import { shouldRunDutAnalysis } from "../../../src/lib/agent/agentDutInsightTrigger.js";
import { expectEqual, expectTrue, expectExcludesAll, type EvalScenario } from "../evalTypes.js";

const p = (bin: string, duts: Array<[number, number]>) => ({
  passId: 1, bins: [{ bin, duts: duts.map(([dut, dieCount]) => ({ dut, dieCount })) }],
});

export const insightScenarios: EvalScenario[] = [
  {
    id: "dut-concentrated-probe-card",
    category: "insight",
    title: "坏 die 集中在少数 DUT → 判探针卡",
    seed: "用户需求:卡/DUT/坏die 关系",
    run: () => {
      const [i] = buildDutConcentrationInsights([p("bin11", [[3, 45], [7, 40], [1, 5], [2, 5], [4, 5]])], []);
      return expectEqual(i?.verdict, "probe_card", "verdict");
    },
  },
  {
    id: "dut-spread-process",
    category: "insight",
    title: "坏 die 分散在多数 DUT → 判工艺",
    run: () => {
      const duts = Array.from({ length: 10 }, (_, k) => [k + 1, 10] as [number, number]);
      const [i] = buildDutConcentrationInsights([p("bin11", duts)], []);
      return expectEqual(i?.verdict, "process", "verdict");
    },
  },
  {
    id: "dut-trigger-card-vs-process",
    category: "insight",
    title: "「是卡还是工艺」问题触发 DUT 分析",
    run: () => expectTrue(shouldRunDutAnalysis("BIN11 是卡还是工艺问题", {}), "shouldRunDutAnalysis"),
  },
  {
    id: "dut-markdown-no-internal-id",
    category: "insight",
    title: "集中度 markdown 不暴露内部标识符",
    run: () => {
      const md = formatDutConcentrationMarkdown(
        buildDutConcentrationInsights([p("bin11", [[3, 90], [1, 10]])], [{ passId: 1, cardIds: ["7804-02"], hasCardChange: false }])
      );
      return expectExcludesAll(md, ["cardByPassId", "query_lot_dut_bin_agg", "Markdown", "topShare"]);
    },
  },
];
