/**
 * Pending Query Mechanism
 *
 * When the agent reaches the summary round (last history entry is role:"tool"),
 * it normally blocks all data-fetch tools and forces an LLM conclusion.
 * For two-step queries — where step 2 depends on the device/lot returned by
 * step 1 — this causes the LLM to either promise a query it can't execute or
 * produce an incomplete answer.
 */

import type { ChatMessage } from "./agentHistory.js";
import {
  extractBinFromUserText,
  extractSlotFromUserText,
  isBadBinRankingQuestion,
  isBinCardAttributionQuestion,
  isCardTestOverviewQuestion,
  isLotDetailListingQuestion,
  isLotListingQuestion,
  isLotOverviewQuestion,
  isProbeCardQuestion,
} from "./agentJbDeterministicReply.js";
import {
  buildAggregateJbBinsScopeArgs,
  buildJbScopeArgs,
  buildLotListingQueryArgs,
  buildScopedBadBinAggregateArgs,
  inferMaskFromHistory,
  inferMaskFromText,
  inferRecentMonthsWindow,
} from "./agentQueryScope.js";
import {
  canRunLotListingDirectRoute,
} from "./agentJbLotListingRoute.js";
import {
  canRunScopedBadBinDirectRoute,
} from "./agentJbScopedBadBinRoute.js";

export type PendingQuery = {
  toolName: string;
  args: Record<string, unknown>;
  statusLabel: string;
};

type PendingQueryChecker = {
  name: string;
  check(
    userQuestion: string,
    lastToolName: string,
    payload: Record<string, unknown>,
    history: ChatMessage[]
  ): PendingQuery | null;
};

function needsJbAfterYm(userQuestion: string, lastToolName: string): boolean {
  if (lastToolName !== "query_yield_triggers" && lastToolName !== "aggregate_yield_triggers") {
    return false;
  }
  if (isLotListingQuestion(userQuestion) || isLotDetailListingQuestion(userQuestion)) {
    return true;
  }
  if (/测试情况|测试记录|在该.*台.*测|机台.*测试|共.*测.*lot|几个\s*lot/i.test(userQuestion)) {
    return true;
  }
  return false;
}

const CHECKERS: PendingQueryChecker[] = [
  {
    name: "query_jb_bins:after_filter_values",
    check(userQuestion, lastToolName, _payload, history) {
      if (lastToolName !== "get_filter_values") return null;
      if (!canRunLotListingDirectRoute(userQuestion, history)) return null;
      const args = buildLotListingQueryArgs(userQuestion, history);
      if (!args) return null;
      return {
        toolName: "query_jb_bins",
        args,
        statusLabel: "filter 未命中索引，正在直接查询 JB STAR lot 列表…",
      };
    },
  },

  {
    name: "query_jb_bins:after_ym_scope",
    check(userQuestion, lastToolName, _payload, history) {
      if (!needsJbAfterYm(userQuestion, lastToolName)) return null;
      const args =
        buildLotListingQueryArgs(userQuestion, history) ??
        buildJbScopeArgs(userQuestion, history, lastToolName);
      if (!args) return null;
      return {
        toolName: "query_jb_bins",
        args,
        statusLabel: "正在查询 JB STAR 各 lot 实测数据…",
      };
    },
  },

  {
    // get_filter_values returned no device for a mask, but the user asked a JB-scoped
    // question (which card / bin attribution / test overview). Don't give up — query JB
    // directly by mask so the deterministic reply can answer.
    name: "query_jb_bins:after_filter_values_mask",
    check(userQuestion, lastToolName, _payload, history) {
      if (lastToolName !== "get_filter_values") return null;
      if (isLotListingQuestion(userQuestion) || isLotDetailListingQuestion(userQuestion)) {
        return null; // handled by the lot-listing checker above
      }
      const mask = inferMaskFromText(userQuestion) || inferMaskFromHistory(history);
      if (!mask) return null;
      const isJbScoped =
        isBinCardAttributionQuestion(userQuestion) ||
        isProbeCardQuestion(userQuestion) ||
        isLotOverviewQuestion(userQuestion) ||
        isCardTestOverviewQuestion(userQuestion) ||
        isBadBinRankingQuestion(userQuestion) ||
        extractBinFromUserText(userQuestion) != null ||
        /测试情况|哪.*die|坏\s*die|哪.*bin/i.test(userQuestion);
      if (!isJbScoped) return null;
      const args: Record<string, unknown> = { mask, limit: 200 };
      const window = inferRecentMonthsWindow(userQuestion);
      if (window.testEndFrom) args["testEndFrom"] = window.testEndFrom;
      if (window.testEndTo) args["testEndTo"] = window.testEndTo;
      return {
        toolName: "query_jb_bins",
        args,
        statusLabel: `filter 未命中 device，正在直接查询 mask ${mask} 的 JB 数据…`,
      };
    },
  },

  {
    name: "aggregate_jb_bins:scoped_fail_bin",
    check(userQuestion, lastToolName, payload, history) {
      if (lastToolName !== "query_jb_bins") return null;
      if (!canRunScopedBadBinDirectRoute(userQuestion, history)) return null;
      const args = buildScopedBadBinAggregateArgs(userQuestion, history, payload);
      if (!args) return null;
      return {
        toolName: "aggregate_jb_bins",
        args,
        statusLabel: "正在聚合范围内主要坏 BIN…",
      };
    },
  },

  {
    name: "aggregate_jb_bins:lot_fail_bin_listing",
    check(userQuestion, lastToolName, payload, history) {
      if (lastToolName !== "query_jb_bins") return null;
      if (!isLotDetailListingQuestion(userQuestion)) return null;
      const total =
        Number(payload["totalDistinctLots"] ?? payload["distinctLotCount"] ?? 0) || 0;
      if (total <= 1 && !/(fail|坏\s*bin|失效)/i.test(userQuestion)) return null;
      const args = buildAggregateJbBinsScopeArgs(userQuestion, history, payload);
      if (!args) return null;
      return {
        toolName: "aggregate_jb_bins",
        args,
        statusLabel: "正在按 lot 聚合 JB 坏 BIN…",
      };
    },
  },

  {
    name: "inf_site_bin_by_dut:after_jb_bins",
    check(userQuestion, lastToolName, payload) {
      if (lastToolName !== "query_jb_bins") return null;
      const slot = extractSlotFromUserText(userQuestion);
      if (!slot) return null;
      if (!/(dut|site|触点|分布)/i.test(userQuestion)) return null;
      const device = String(payload["device"] ?? "").trim();
      const lot = String(payload["lot"] ?? "").trim();
      if (!device || !lot) return null;
      return {
        toolName: "query_inf_site_bin_by_dut",
        args: { device, lot, slot },
        statusLabel: `正在查询 ${lot} slot ${slot} DUT×BIN 分布…`,
      };
    },
  },

  {
    name: "query_lot_dut_bin_agg:non_default_pass",
    check(userQuestion, lastToolName, payload) {
      if (lastToolName !== "query_jb_bins") return null;
      const focusBin = extractBinFromUserText(userQuestion);
      if (focusBin == null) return null;
      if (!/(dut|触点)/i.test(userQuestion)) return null;
      const passMatch = userQuestion.match(/pass\s*([135])|sort\s*([123])|高温|低温/i);
      if (!passMatch) return null;
      const passId = passMatch[1]
        ? parseInt(passMatch[1])
        : passMatch[2]
          ? [1, 3, 5][parseInt(passMatch[2]) - 1] ?? 1
          : /高温/.test(userQuestion)
            ? 3
            : /低温/.test(userQuestion)
              ? 5
              : 1;
      if (passId === 1) return null;
      const device = String(payload["device"] ?? "").trim();
      const lot = String(payload["lot"] ?? "").trim();
      if (!device || !lot) return null;
      return {
        toolName: "query_lot_dut_bin_agg",
        args: { device, lot, passId, focusBin },
        statusLabel: `正在查询 ${lot} DUT×BIN${focusBin}（pass${passId}）聚合…`,
      };
    },
  },
];

export function detectPendingQuery(
  userQuestion: string,
  lastToolName: string,
  payload: Record<string, unknown>,
  history: ChatMessage[] = []
): PendingQuery | null {
  for (const checker of CHECKERS) {
    const result = checker.check(userQuestion, lastToolName, payload, history);
    if (result) return result;
  }
  return null;
}
