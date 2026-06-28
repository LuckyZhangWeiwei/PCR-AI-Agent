/**
 * Routing / scope-inference scenarios.
 *
 * Pain category: "没查对数据 / 问错工具". These assert the deterministic routing
 * brain picks the right intent / pending tool / scope args BEFORE the LLM runs.
 */

import { classifyIntent } from "../../../src/lib/agent/agentPrompt.js";
import { buildJbScopeArgs } from "../../../src/lib/agent/agentQueryScope.js";
import { detectPendingQuery } from "../../../src/lib/agent/agentPendingQuery.js";
import { canRunLotListingDirectRoute } from "../../../src/lib/agent/agentJbLotListingRoute.js";
import { resolveJbRoute } from "../../../src/lib/agent/jbRouteResolver.js";
import type { ChatMessage } from "../../../src/lib/agent/agentHistory.js";
import {
  expectEqual,
  expectTrue,
  type EvalScenario,
} from "../evalTypes.js";

function ymToolCall(args: Record<string, unknown>): ChatMessage {
  return {
    role: "assistant",
    tool_calls: [
      {
        id: "1",
        type: "function",
        function: { name: "query_yield_triggers", arguments: JSON.stringify(args) },
      },
    ],
  } as ChatMessage;
}

export const routingScenarios: EvalScenario[] = [
  {
    id: "intent-platform-query",
    category: "routing",
    title: "「UFLEX 平台测试情况」(无 lot 号) → platform_query",
    seed: "pain: platform questions",
    run: () => expectEqual(classifyIntent("UFLEX 平台最近测试情况怎么样"), "platform_query", "intent"),
  },
  {
    id: "intent-wafer-map",
    category: "routing",
    title: "「第三片 wafermap 画出来」→ wafer_map",
    seed: "log 9bd4986a turn3",
    run: () => expectEqual(classifyIntent("DR43782.1A 第三片wafermap 请画出"), "wafer_map", "intent"),
  },
  {
    id: "intent-card-probe",
    category: "routing",
    title: "「哪张卡报警最多」→ card_probe",
    run: () => expectEqual(classifyIntent("最近哪张探针卡报警最多"), "card_probe", "intent"),
  },
  {
    id: "intent-platform-not-misfired-by-lot",
    category: "routing",
    title: "含 lot 号的 FLEX 问题不应被误判为 platform_query",
    run: () => {
      const intent = classifyIntent("DR43782.1A 在 flex 上的测试情况");
      return intent === "platform_query"
        ? { pass: false, detail: `含 lot 号却判成 platform_query(应回退到其它意图)` }
        : { pass: true };
    },
  },
  {
    id: "scope-jb-inherits-ym-timewindow",
    category: "routing",
    title: "JB 查询继承上一次 YM 调用的 timeFrom/timeTo(不按今天重算)",
    seed: "bug fix a2a2eae (regression lock)",
    run: () => {
      const args = buildJbScopeArgs(
        "近3个月所有 lot 列出来",
        [ymToolCall({ device: "WA01P14E", hostname: "b3uflex24", timeFrom: "2026-03-23", timeTo: "2026-06-23" })],
        "query_yield_triggers"
      );
      const r1 = expectEqual(args?.["device"], "WA01P14E", "device");
      if (!r1.pass) return r1;
      const r2 = expectEqual(args?.["testerId"], "b3uflex24", "testerId");
      if (!r2.pass) return r2;
      return expectEqual(args?.["testEndFrom"], "2026-03-23", "testEndFrom");
    },
  },
  {
    id: "pending-ym-then-jb",
    category: "routing",
    title: "YM lot 列表查询后 → 自动排队 query_jb_bins",
    run: () => {
      const pending = detectPendingQuery(
        "WA01P14E 在 b3uflex24 台近 3 个月 测试的所有lot 都列出来",
        "query_yield_triggers",
        {},
        [ymToolCall({ device: "WA01P14E", hostname: "b3uflex24" })]
      );
      return pending
        ? expectEqual(pending.toolName, "query_jb_bins", "pending.toolName")
        : { pass: false, detail: "detectPendingQuery 返回 null(应排队 query_jb_bins)" };
    },
  },
  {
    id: "route-lot-listing-device-tester",
    category: "routing",
    title: "「device 在某机台测过的所有 lot 列出来」→ 走 lot 列表直出路由",
    run: () =>
      expectTrue(
        canRunLotListingDirectRoute("WA01P14E 在 b3uflex24 台近3个月测试的所有lot都列出来"),
        "canRunLotListingDirectRoute"
      ),
  },
  {
    id: "route-multi-card-compare-generic",
    category: "routing",
    title: "多卡对比 → generic(交回 LLM,不出单 lot 卡表)",
    seed: "P-C 真因",
    run: () => expectEqual(resolveJbRoute("把这4张probecard的测试情况做对比").mode, "generic", "mode"),
  },
  {
    id: "route-equipment-single-lot",
    category: "routing",
    title: "单 lot 用卡问 → equipment",
    run: () => expectEqual(resolveJbRoute("DR44436.1W 用几号卡测试的").mode, "equipment", "mode"),
  },
  {
    id: "route-lot-listing-colloquial",
    category: "routing",
    title: "「都测试了什么lot」→ lot_listing",
    seed: "P-B",
    run: () => expectEqual(resolveJbRoute("都测试了什么lot").mode, "lot_listing", "mode"),
  },
  {
    id: "route-per-slot-bin",
    category: "routing",
    title: "「每片坏die情况」→ per_slot_bin_ranking",
    run: () => expectEqual(resolveJbRoute("每片坏die情况").mode, "per_slot_bin_ranking", "mode"),
  },
  {
    id: "route-llm-fallback-colloquial",
    category: "routing",
    title: "[live] 口语模糊「这几张卡最近咋样」→ 非单 lot 误答",
    live: true,
    run: async () => {
      process.env.JB_LLM_INTENT_CLASSIFIER = "true";
      const { resolveJbRouteAsync } = await import("../../../src/lib/agent/jbRouteResolver.js");
      const d = await resolveJbRouteAsync("这几张卡最近咋样", {}, { subAgentModel: process.env.AGENT_SUBAGENT_MODEL } as any);
      return d.mode === "lot_overview"
        ? { pass: false, detail: "模糊多卡问被判 lot_overview(应 generic/card_test_overview)" }
        : { pass: true };
    },
  },
];
