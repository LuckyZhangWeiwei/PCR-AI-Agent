import assert from "node:assert/strict";
import test from "node:test";
import {
  filterAgentStreamTextForUi,
  parseGlmToolCallBody,
  parseMinimaxInvokeBody,
} from "../src/lib/agent/core/agentEmbeddedToolParsing.js";
import { historyAwaitingToolSummary } from "../src/lib/agent/core/agentToolStatus.js";
import {
  cachedJbScopeMismatchReason,
  equipmentRouteCrossLotBail,
  isDutBinConcentrationQuestion,
  questionHasIdentifiableToolScope,
} from "../src/lib/agent/dispatch/agentQuestionHeuristics.js";
import { equipmentRouteDutLevelBail } from "../src/lib/agent/jb/agentJbQuestionClassifiers.js";
import { renderAggregateJbBinsResult } from "../src/lib/agent/render/agentAggregateBinsRender.js";
import { tryRunSemanticDispatchDirectRoute } from "../src/lib/agent/dispatch/agentSemanticDispatch.js";
import {
  tryEmitUnderperformingDutScatter,
  tryAppendUnderperformingDutSection,
} from "../src/lib/agent/tools/agentToolUnderperformingDutsRender.js";
import {
  buildDutShareChartData,
  inferGenerateChartArgsFromHistory,
  normalizeGenerateChartArgs,
  resolveGenerateChartData,
  tryParseJsonish,
} from "../src/lib/agent/tools/agentChartTool.js";
import { runTool } from "../src/lib/agent/tools/agentToolHandlers.js";
import type { ChatMessage } from "../src/lib/agent/agentHistory.js";
import { resolveJbRoute } from "../src/lib/agent/jbRouteResolver.js";
import { isVeroGenericLoopReady } from "../src/lib/vero/veroSimpleAgent.js";

const THINK_OPEN = "<" + "think>";
const THINK_CLOSE = "</" + "think>";
const REASONING_OPEN = "<redacted_reasoning>";
const REASONING_CLOSE = "</redacted_reasoning>";

test("filterAgentStreamTextForUi strips think blocks from content stream", () => {
  const out = filterAgentStreamTextForUi([
    "结论：",
    THINK_OPEN,
    "内部推理不应显示",
    THINK_CLOSE,
    "良率正常。",
  ]);
  assert.equal(out, "结论：良率正常。");
});

test("filterAgentStreamTextForUi strips split think tags across chunks", () => {
  const out = filterAgentStreamTextForUi([
    "开始",
    "<thi",
    "nk>secret",
    THINK_CLOSE,
    "结束",
  ]);
  assert.equal(out, "开始结束");
});

const THINKING_OPEN = "<think>";
const THINKING_CLOSE = "</think>";
/** Fullwidth vertical line as in SiliconFlow DSML markup */
const FW_PIPE = "\uFF5C";
function dsmlMarkup(inner: string): string {
  return inner.replace(/\|/g, FW_PIPE);
}

test("filterAgentStreamTextForUi strips redacted_thinking blocks", () => {
  const out = filterAgentStreamTextForUi([
    "前言",
    THINKING_OPEN,
    "不应显示",
    THINKING_CLOSE,
    "后语",
  ]);
  assert.equal(out, "前言后语");
});

test("filterAgentStreamTextForUi strips DSML tool_calls markup", () => {
  const block = dsmlMarkup(
    `<|DSML|tool_calls>
<|DSML|invoke name="query_inf_site_bin_by_dut">
<|DSML|parameter name="device" string="true">WA11P07K</|DSML|parameter>
<|DSML|parameter name="lot" string="true">DR39404.1C</|DSML|parameter>
</|DSML|invoke>
</|DSML|tool_calls>`
  );
  const out = filterAgentStreamTextForUi([
    "好的，",
    block,
    "请看结论。",
  ]);
  assert.equal(out, "好的，请看结论。");
});

test("filterAgentStreamTextForUi strips redacted_reasoning blocks", () => {
  const out = filterAgentStreamTextForUi([
    "OK",
    REASONING_OPEN,
    "hidden",
    REASONING_CLOSE,
    "。",
  ]);
  assert.equal(out, "OK。");
});

test("filterAgentStreamTextForUi strips MiniMax tool_call markup", () => {
  const block = `<minimax:tool_call>
<invoke name="aggregate_jb_bins">
<parameter name="groupBy">lot</parameter>
<parameter name="cardId">6095-01</parameter>
<parameter name="groupTop">100</parameter>
</invoke>
</minimax:tool_call>`;
  const out = filterAgentStreamTextForUi([
    "该卡测试过大量 lot。让我重新查询，按 lot 维度统计：",
    block,
    "请稍候。",
  ]);
  assert.equal(out, "该卡测试过大量 lot。让我重新查询，按 lot 维度统计：请稍候。");
});

test("filterAgentStreamTextForUi strips split MiniMax tag across chunks", () => {
  const out = filterAgentStreamTextForUi([
    "查询中",
    "<minimax:tool_c",
    'all>\n<invoke name="aggregate_jb_bins">\n<parameter name="groupBy">lot</parameter>\n</invoke>\n</minimax:tool_call>',
    "完成",
  ]);
  assert.equal(out, "查询中完成");
});

test("filterAgentStreamTextForUi strips MiniMax JSON invoke orphan tail", () => {
  const out = filterAgentStreamTextForUi([
    'cardId: "7747-01",\nlimit: 1000\n}\n</invoke>\n</minimax:tool_call>',
  ]);
  assert.equal(out, "");
});

test("filterAgentStreamTextForUi strips MiniMax invoke with JSON body", () => {
  const block = `<minimax:tool_call>
<invoke name="query_jb_bins">
{
  "cardId": "7747-01",
  "limit": 200
}
</invoke>
</minimax:tool_call>`;
  const out = filterAgentStreamTextForUi(["正在查询…", block]);
  assert.equal(out, "正在查询…");
});

test("filterAgentStreamTextForUi strips GLM tool_call markup", () => {
  const block =
    '<tool_call>generate_chart<arg_key>chartType</arg_key><arg_value>pie</arg_value>' +
    '<arg_key>labels</arg_key><arg_value>["DUT2 (395颗)", "其他DUT (45颗)"]</arg_value>' +
    '<arg_key>values</arg_key><arg_value>[395, 45]</arg_value>' +
    '<arg_key>title</arg_key><arg_value>Slot 7-9 BIN7 DUT分布</arg_value></tool_call>';
  const out = filterAgentStreamTextForUi(["正在生成图表…", block, "完成"]);
  assert.equal(out, "正在生成图表…完成");
});

test("filterAgentStreamTextForUi strips split GLM tool_call across chunks", () => {
  const out = filterAgentStreamTextForUi([
    "请稍候",
    "<tool_call>generate_chart<arg_key>chartType</arg_key><arg_val",
    'ue>pie</arg_value></tool_call>',
    "。",
  ]);
  assert.equal(out, "请稍候。");
});

test("parseGlmToolCallBody reads arg_key and arg_value pairs", () => {
  const block =
    '<tool_call>generate_chart<arg_key>chartType</arg_key><arg_value>pie</arg_value>' +
    '<arg_key>labels</arg_key><arg_value>["A","B"]</arg_value>' +
    '<arg_key>values</arg_key><arg_value>[1, 2]</arg_value></tool_call>';
  assert.deepEqual(parseGlmToolCallBody(block), {
    name: "generate_chart",
    args: {
      chartType: "pie",
      labels: ["A", "B"],
      values: [1, 2],
    },
  });
});

test("normalizeGenerateChartArgs maps flat labels and values to data.series", () => {
  assert.deepEqual(
    normalizeGenerateChartArgs({
      chartType: "pie",
      title: "t",
      labels: ["A", "B"],
      values: [10, 20],
    }),
    {
      chartType: "pie",
      title: "t",
      data: {
        labels: ["A", "B"],
        series: [{ name: "占比", values: [10, 20] }],
      },
    }
  );
});

test("normalizeGenerateChartArgs defaults chartType to pie for flat labels+values", () => {
  const out = normalizeGenerateChartArgs({
    title: "DUT2占比",
    labels: ["DUT2", "其他"],
    values: [395, 45],
  });
  assert.equal(out.chartType, "pie");
  const data = resolveGenerateChartData(out);
  assert.ok(data);
  assert.deepEqual(data.labels, ["DUT2", "其他"]);
  assert.deepEqual(data.series[0]?.values, [395, 45]);
});

test("normalizeGenerateChartArgs parses data JSON string with flat labels+values", () => {
  const out = normalizeGenerateChartArgs({
    chartType: "pie",
    title: "DUT2",
    data: '{"labels":["DUT2","其他"],"values":[395,45]}',
  });
  const data = resolveGenerateChartData(out);
  assert.ok(data);
  assert.deepEqual(data.labels, ["DUT2", "其他"]);
});

test("normalizeGenerateChartArgs parses string labels and values from GLM", () => {
  const out = normalizeGenerateChartArgs({
    chartType: "pie",
    labels: '["DUT2 (395颗)", "其他DUT (45颗)"]',
    values: "[395, 45]",
  });
  const data = resolveGenerateChartData(out);
  assert.ok(data);
  assert.equal(data.labels[0], "DUT2 (395颗)");
  assert.deepEqual(data.series[0]?.values, [395, 45]);
});

test("tryParseJsonish leaves plain strings unchanged", () => {
  assert.equal(tryParseJsonish("pie"), "pie");
});

test("buildDutShareChartData sums dut vs other for one bin", () => {
  const data = buildDutShareChartData(
    [
      {
        passId: 1,
        bins: [
          {
            bin: "bin7",
            duts: [
              { dut: 2, dieCount: 395 },
              { dut: 4, dieCount: 45 },
            ],
          },
        ],
      },
    ],
    2,
    "bin7"
  );
  assert.ok(data);
  assert.deepEqual(data.series[0]?.values, [395, 45]);
});

test("inferGenerateChartArgsFromHistory builds pie from query_inf_site_bin_by_dut", () => {
  const infPayload = {
    device: "X",
    lot: "L",
    slot: 1,
    passes: [
      {
        passId: 1,
        bins: [
          {
            bin: "bin7",
            duts: [
              { dut: 2, dieCount: 80 },
              { dut: 3, dieCount: 20 },
            ],
          },
        ],
      },
    ],
  };
  const history: ChatMessage[] = [
    { role: "user", content: "生成 dut2 占比的比例图" },
    {
      role: "tool",
      name: "query_inf_site_bin_by_dut",
      content: JSON.stringify(infPayload),
      tool_call_id: "t1",
    },
  ];
  const inferred = inferGenerateChartArgsFromHistory(history, {
    chartType: "pie",
    title: "DUT2 占比",
  });
  assert.ok(inferred);
  const data = resolveGenerateChartData(inferred);
  assert.ok(data);
  assert.deepEqual(data.series[0]?.values, [80, 20]);
});

test("runTool generate_chart infers from history when args empty", async () => {
  const history: ChatMessage[] = [
    { role: "user", content: "dut2 占比图" },
    {
      role: "tool",
      name: "query_inf_site_bin_by_dut",
      content: JSON.stringify({
        passes: [
          {
            passId: 1,
            bins: [{ bin: "bin7", duts: [{ dut: 2, dieCount: 3 }, { dut: 5, dieCount: 7 }] }],
          },
        ],
      }),
      tool_call_id: "t1",
    },
  ];
  const result = await runTool("generate_chart", {}, { history });
  assert.ok(
    typeof result === "object" && result !== null && "__chartOption" in result
  );
});

test("parseMinimaxInvokeBody reads JSON and loose key:value in invoke", () => {
  assert.deepEqual(
    parseMinimaxInvokeBody(
      `<invoke name="query_jb_bins">{"cardId":"7747-01","limit":200}</invoke>`
    ),
    { cardId: "7747-01", limit: "200" }
  );
  assert.deepEqual(
    parseMinimaxInvokeBody(
      `<invoke name="query_jb_bins">cardId: "7747-01", limit: 1000 }</invoke>`
    ),
    { cardId: "7747-01", limit: "1000" }
  );
});

test("historyAwaitingToolSummary is true when last turn is tool output", () => {
  const history: ChatMessage[] = [
    { role: "user", content: "8037 probecard 测试情况" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "aggregate_yield_triggers", arguments: "{}" },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: '{"totalRowsMatching":24}' },
  ];
  assert.equal(historyAwaitingToolSummary(history), true);
});

test("historyAwaitingToolSummary is false for fresh user turn", () => {
  assert.equal(
    historyAwaitingToolSummary([{ role: "user", content: "hi" }]),
    false
  );
});

test("historyAwaitingToolSummary is false after assistant text reply", () => {
  const history: ChatMessage[] = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "结论如下" },
  ];
  assert.equal(historyAwaitingToolSummary(history), false);
});

// ── Summary-round guard regression tests ────────────────────────────────────
// These tests document the invariants enforced by the guard added to runAgentLoop:
//
// Bug A: embedded calls (GLM/MiniMax) in summary round — model produced
//   "让我换一种聚合方式：" text + embedded tool markup. Previously the
//   incomplete text was emitted as `done`. Fix: emit error instead.
//
// Bug B: structured tool_calls from the streaming API in summary round —
//   model emits tool_calls despite no tool schema. Previously they executed,
//   consuming rounds until maxRounds with no conclusion. Fix: discard them.
//
// The guard condition is: historyAwaitingToolSummary(history) === true
// (last message is role "tool"), which is the entry condition for the summary
// round. We verify historyAwaitingToolSummary correctly identifies all cases.

test("historyAwaitingToolSummary is true after two consecutive tool results (multi-tool round)", () => {
  // Simulates a round where the model called two tools; both results are in
  // history. The summary round guard must fire to prevent further tool calls.
  const history: ChatMessage[] = [
    { role: "user", content: "最近一周测试最差的卡" },
    {
      role: "assistant",
      content: "正在查询…",
      tool_calls: [
        { id: "c1", type: "function", function: { name: "aggregate_yield_triggers", arguments: '{"dimensions":"probeCard"}' } },
        { id: "c2", type: "function", function: { name: "aggregate_jb_bins", arguments: '{"groupBy":"bin,cardId"}' } },
      ],
    },
    { role: "tool", tool_call_id: "c1", name: "aggregate_yield_triggers", content: '{"groups":[]}' },
    { role: "tool", tool_call_id: "c2", name: "aggregate_jb_bins", content: '{"groups":[]}' },
  ];
  assert.equal(historyAwaitingToolSummary(history), true);
});

test("historyAwaitingToolSummary is false when assistant already replied after tool", () => {
  // After the summary round produces text, history ends with assistant —
  // next user turn starts fresh (no summary guard).
  const history: ChatMessage[] = [
    { role: "user", content: "最近一周测试最差的卡" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "aggregate_yield_triggers", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "c1", name: "aggregate_yield_triggers", content: '{"groups":[{"probeCard":"7772-A1","count":12}]}' },
    { role: "assistant", content: "7772-A1 报警最多（12 次），建议检查该卡。" },
  ];
  assert.equal(historyAwaitingToolSummary(history), false);
});

// ─── equipment 直连路由：缓存 scope 校验（防止跨产品/跨 lot 张冠李戴）──────────
const P11C_CACHE = {
  device: "WB01P11C",
  lot: "TR21697.1K",
  recentLotsByTestEnd: [{ lot: "TR21697.1K" }, { lot: "TR23824.1Y" }],
} as Record<string, unknown>;

test("cachedJbScopeMismatchReason: N55Z 问题命中 P11C 缓存 → 报不一致（跨产品张冠李戴）", () => {
  const reason = cachedJbScopeMismatchReason(P11C_CACHE, "mask=N55Z的lot 中 bin35，集中在哪张卡上");
  assert.ok(reason && /N55Z/.test(reason) && /P11C/.test(reason), reason ?? "expected mismatch");
});

test("cachedJbScopeMismatchReason: 同产品/无新 scope 的卡问题 → null（允许用缓存）", () => {
  assert.equal(cachedJbScopeMismatchReason(P11C_CACHE, "这批用的什么卡"), null);
  assert.equal(cachedJbScopeMismatchReason(P11C_CACHE, "TR21697.1K 是哪台机台测的"), null);
});

test("cachedJbScopeMismatchReason: 问题含缓存外的 lot → 报不一致", () => {
  const reason = cachedJbScopeMismatchReason(P11C_CACHE, "DR44436.1W 用的什么卡");
  assert.ok(reason && /DR44436\.1W/.test(reason), reason ?? "expected mismatch");
});

test("equipmentRouteCrossLotBail: 跨多 lot 分析问题应禁用 equipment 直连", () => {
  assert.equal(equipmentRouteCrossLotBail("上面这 16 个lot 中 请分析 哪个可能和probecard dut 等有关系"), true);
  assert.equal(equipmentRouteCrossLotBail("这批用的什么卡"), false);
});

test("多卡对比 → mode generic(收口守卫等价)", () => {
  assert.equal(resolveJbRoute("把这4张probecard的测试情况做对比").mode, "generic");
});

// B4（S4-T5 真库回归）：问到 DUT 级归属时 equipment 直连不能用缓存（缓存只有卡+机台，无 DUT）。
test("equipmentRouteDutLevelBail: DUT 级归属问题应禁用 equipment 直连", () => {
  assert.equal(equipmentRouteDutLevelBail("ok 把对应用的卡 和 dut lot 都列出来"), true);
  assert.equal(equipmentRouteDutLevelBail("哪些 die 是嫌疑"), true);
  // 纯卡/机台问题不受影响
  assert.equal(equipmentRouteDutLevelBail("这批用的什么卡"), false);
  assert.equal(equipmentRouteDutLevelBail("DR43338.1R 在哪个机台测的"), false);
});

// B-core：aggregate_jb_bins 渲染选择链单一真相源（summary 站与 fallback 站共用此函数）。
// 各 groupBy 形状选对渲染器 + withDataTitle 正确，避免「改一处漏另一处」的打地鼠。
test("renderAggregateJbBinsResult: 各 groupBy 形状选对渲染器", () => {
  // groupBy:"device,bin" → BIN×device（B1）
  const dev = renderAggregateJbBinsResult(
    JSON.stringify({ groups: [{ device: "WB01P11C", bin: "2", count: 100 }] }),
    "把device也要列出来",
    undefined
  );
  assert.ok(dev?.table.includes("Device"));
  assert.equal(dev?.withDataTitle, true);

  // groupBy:"bin,cardId" → BIN×探针卡
  const card = renderAggregateJbBinsResult(
    JSON.stringify({ groups: [{ cardId: "9416-04", bin: "35", count: 100 }] }),
    "bin35 集中在哪张卡",
    undefined
  );
  assert.ok(card?.table.includes("9416-04"));

  // groupBy:"bin,lot" 多 lot → multiLotBinTable（自带表头，无「## 实测数据」标题）
  const multi = renderAggregateJbBinsResult(
    JSON.stringify({
      groups: [
        { lot: "A1.1A", bin: "2", count: 100 },
        { lot: "B2.1B", bin: "3", count: 80 },
      ],
    }),
    "这些批次坏bin对比",
    undefined
  );
  assert.equal(multi?.withDataTitle, false);

  // 纯 groupBy:"bin" → 坏 BIN 排行
  const rank = renderAggregateJbBinsResult(
    JSON.stringify({ groups: [{ bin: "61", count: 900 }] }),
    "主要坏bin排行",
    undefined
  );
  assert.ok(rank?.table.includes("BIN61"));
  assert.equal(rank?.withDataTitle, true);

  // 空 groups → null（交回上层）
  assert.equal(
    renderAggregateJbBinsResult(JSON.stringify({ groups: [] }), "x", undefined),
    null
  );
});

test("tryRunSemanticDispatchDirectRoute: flag 未开时整体短路 return false", async () => {
  delete process.env.JB_DETERMINISTIC_DISPATCH;
  const sid = "t-flag-off-" + Date.now();
  const handled = await tryRunSemanticDispatchDirectRoute(
    sid, "n55z 哪个卡测出bin35 多", {} as any, () => {});
  assert.equal(handled, false);
});

// A1-2 修复：区分 DUT 级集中度（P-F）vs 卡级归因（bin_card_attribution 语义派发）。
test("isDutBinConcentrationQuestion: 卡级归因让给 bin_card_attribution，DUT 级仍归 P-F", () => {
  // 纯卡级归因（无 dut）→ 不走 P-F（交语义派发出 bin×card 表，A1-2 根因）。
  assert.equal(isDutBinConcentrationQuestion("BIN35 集中在哪张卡"), false);
  assert.equal(isDutBinConcentrationQuestion("bin99 是哪张卡测出来的"), false);
  assert.equal(isDutBinConcentrationQuestion("n55z 哪个卡测出bin35 多"), false);
  // DUT 级意图（含 dut/触点/探针）→ 仍走 P-F（即便同时问"哪个卡"，如 P-F 问句）。
  assert.equal(isDutBinConcentrationQuestion("哪个卡 哪个dut 测试出的 bin79 最多"), true);
  assert.equal(isDutBinConcentrationQuestion("bin79 哪个dut最多"), true);
  assert.equal(isDutBinConcentrationQuestion("bin35 哪个触点集中"), true);
  // 无 bin 编号 → false。
  assert.equal(isDutBinConcentrationQuestion("哪张卡良率最低"), false);
});

// 「模型只承诺查询、未真正调用工具」的代码兜底重试——用于判断问题是否含明确实体
// （device/lot/cardId），若含且未调工具，视为违反 agentPrompt.ts 硬规则，应重试。
test("questionHasIdentifiableToolScope: 探针卡/lot/device 均可识别，寒暄类问题不识别", () => {
  assert.equal(questionHasIdentifiableToolScope("7772-01 的测试情况"), true); // cardId
  assert.equal(questionHasIdentifiableToolScope("DR43782.1A 概况"), true); // lot
  assert.equal(questionHasIdentifiableToolScope("WA03P02G 最近的测试情况"), true); // 完整 device 代码
  assert.equal(questionHasIdentifiableToolScope("hello"), false);
  assert.equal(questionHasIdentifiableToolScope("你好"), false);
});

test("tryEmitUnderperformingDutScatter: 每个有 baseline 的 pass emit 一个 chart 事件", () => {
  const events: any[] = [];
  const passes: any[] = [
    {
      passId: 1, sortLabel: "常温 sort1", dutCount: 1, lotGoodDie: 1, lotTotalDie: 1,
      baseline: { method: "lotOverall", yieldPct: 90, thresholdPct: 67.5, thresholdRatio: 0.75 },
      allDuts: [{ dut: 1, goodDie: 5, totalDie: 10, yieldPct: 50 }],
      underperformingDuts: [{ dut: 1, goodDie: 5, totalDie: 10, yieldPct: 50, gapToThresholdPct: -17.5 }],
    },
    {
      passId: 3, sortLabel: "高温 sort3", dutCount: 0, lotGoodDie: 0, lotTotalDie: 0,
      baseline: null, allDuts: [], underperformingDuts: [],
    },
  ];
  tryEmitUnderperformingDutScatter(passes, (e) => events.push(e));
  const charts = events.filter((e) => e.type === "chart");
  assert.equal(charts.length, 1); // pass3 baseline=null 跳过
});

test("tryAppendUnderperformingDutSection: payload 缺 lot/device 时返回空串、不 emit", async () => {
  const events: any[] = [];
  const out = await tryAppendUnderperformingDutSection({}, (e) => events.push(e));
  assert.equal(out, "");
  assert.equal(events.length, 0);
});

test("runAgentLoop: Vero generic loop stays off when AGENT_VERO_GENERIC_LOOP is unset", () => {
  const prevFlag = process.env.AGENT_VERO_GENERIC_LOOP;
  const prevToken = process.env.WCHAT_ACCESS_TOKEN;
  try {
    delete process.env.AGENT_VERO_GENERIC_LOOP;
    delete process.env.WCHAT_ACCESS_TOKEN;
    // Calls the real gate condition agentLoop.ts's runAgentLoop uses
    // (`if (isVeroGenericLoopReady()) return runVeroAgentLoop(...)`), so this test
    // actually fails if that condition or its underlying flag logic regresses.
    assert.equal(isVeroGenericLoopReady(), false);
  } finally {
    if (prevFlag === undefined) delete process.env.AGENT_VERO_GENERIC_LOOP;
    else process.env.AGENT_VERO_GENERIC_LOOP = prevFlag;
    if (prevToken === undefined) delete process.env.WCHAT_ACCESS_TOKEN;
    else process.env.WCHAT_ACCESS_TOKEN = prevToken;
  }
});
