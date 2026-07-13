/**
 * Deterministic-summary routing scenarios.
 *
 * Pain category: "分析不到位 / 字段不全". Before the LLM narrates, the agent picks
 * a deterministic reply mode (tester table / card table / lot listing / …). If
 * that classification is wrong, the wrong precomputed table is emitted. These
 * lock the question→mode mapping.
 */

import {
  isTesterMachineQuestion,
  isProbeCardQuestion,
  isBinCardAttributionQuestion,
  isCardYieldCompareQuestion,
  isLotListingQuestion,
  isLotDetailListingQuestion,
} from "../../../src/lib/agent/jb/agentJbQuestionClassifiers.js";
import { formatCardByPassIdMarkdown } from "../../../src/lib/agent/jb/agentJbHistoryCompact.js";
import { toolStatusLabel } from "../../../src/lib/agent/agentLoop.js";
import {
  expectTrue,
  expectFalse,
  expectContainsAll,
  expectExcludesAll,
  type EvalScenario,
} from "../evalTypes.js";

// Internal identifiers that must never appear in user-facing deterministic output.
const INTERNAL_IDENTIFIERS = [
  "cardByPassId",
  "yieldByPassId",
  "slotBadBinsCompact",
  "binBySlot",
  "query_jb_bins",
  "aggregate_jb_bins",
  "get_filter_values",
  "Markdown",
];

export const summaryScenarios: EvalScenario[] = [
  {
    id: "mode-tester-question",
    category: "summary",
    title: "「用的哪台机台」→ 机台问题",
    run: () => expectTrue(isTesterMachineQuestion("DR43782.1A 用的哪台机台测的"), "isTesterMachineQuestion"),
  },
  {
    id: "mode-tester-not-fired-by-yield",
    category: "summary",
    title: "纯良率问题不应判为机台问题",
    run: () => expectFalse(isTesterMachineQuestion("DR43782.1A 良率多少"), "isTesterMachineQuestion"),
  },
  {
    id: "mode-probe-card-question",
    category: "summary",
    title: "「这批用的几号卡」→ 探针卡问题",
    run: () => expectTrue(isProbeCardQuestion("这批用的几号卡"), "isProbeCardQuestion"),
  },
  {
    id: "mode-bin-card-attribution",
    category: "summary",
    title: "「BIN11 是哪张卡测出来的」→ BIN 逐卡归因",
    run: () => expectTrue(isBinCardAttributionQuestion("BIN11 是哪张卡测出来的"), "isBinCardAttributionQuestion"),
  },
  {
    id: "mode-card-yield-compare",
    category: "summary",
    title: "「哪张卡良率最差」→ 卡间良率对比(非逐卡归因)",
    run: () => {
      const compare = isCardYieldCompareQuestion("这几张卡哪张良率最差");
      const attribution = isBinCardAttributionQuestion("这几张卡哪张良率最差");
      if (!compare) return { pass: false, detail: "未判为卡间良率对比" };
      if (attribution) return { pass: false, detail: "被误判为 BIN 逐卡归因" };
      return { pass: true };
    },
  },
  {
    id: "mode-lot-listing",
    category: "summary",
    title: "「近3个月所有 lot 都列出来」→ lot 列表",
    run: () => expectTrue(isLotListingQuestion("近3个月测试的所有lot都列出来"), "isLotListingQuestion"),
  },
  {
    id: "mode-lot-listing-not-wafer-enum",
    category: "summary",
    title: "「列出所有 wafer」(lot 内逐片)不应判为跨 lot 列表",
    run: () => expectFalse(isLotListingQuestion("DR43782.1A 列出所有 wafer"), "isLotListingQuestion"),
  },
  {
    id: "mode-lot-detail-listing",
    category: "summary",
    title: "「所有 lot 的 fail bin 列出来」→ lot 明细列表",
    run: () => expectTrue(isLotDetailListingQuestion("所有lot的fail bin都列出来"), "isLotDetailListingQuestion"),
  },
  {
    id: "leak-cardByPassId-header-clean",
    category: "summary",
    title: "探针卡确定性表头不得暴露内部字段名 cardByPassId",
    seed: "用户报告:回答里出现内部函数/字段名",
    run: () => {
      const md = formatCardByPassIdMarkdown([
        { passId: 1, cardIds: ["7804-02"], hasCardChange: false },
      ]);
      const r1 = expectContainsAll(md, ["各测试层探针卡"]);
      if (!r1.pass) return r1;
      return expectExcludesAll(md, INTERNAL_IDENTIFIERS);
    },
  },
  {
    id: "leak-tool-status-label-localized",
    category: "summary",
    title: "工具状态提示用中文标签,不暴露内部工具名",
    seed: "用户报告:回答里出现内部函数/字段名",
    run: () => {
      const label = toolStatusLabel("query_jb_bins");
      const r1 = expectExcludesAll(label, ["query_jb_bins", "_"]);
      if (!r1.pass) return r1;
      return toolStatusLabel("query_jb_bins") === "JB 测试数据查询"
        ? { pass: true }
        : { pass: false, detail: `映射不符: ${label}` };
    },
  },
];
