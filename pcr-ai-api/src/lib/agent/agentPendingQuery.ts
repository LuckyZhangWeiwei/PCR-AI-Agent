/**
 * Pending Query Mechanism
 *
 * When the agent reaches the summary round (last history entry is role:"tool"),
 * it normally blocks all data-fetch tools and forces an LLM conclusion.
 * For two-step queries — where step 2 depends on the device/lot returned by
 * step 1 — this causes the LLM to either promise a query it can't execute or
 * produce an incomplete answer.
 *
 * This module provides a registry of "pending query checkers". Each checker
 * looks at the current state (user question + last tool name + JB payload) and
 * returns a follow-up tool call to execute before the summary round LLM call.
 * The caller executes the tool, appends the result to history, and loops back
 * to the top of the round loop — the next iteration then has complete data for
 * a proper summary.
 *
 * Checkers should be targeted and conservative: only fire when the follow-up
 * query is unambiguously required. False positives waste a round and a tool
 * call; false negatives are no worse than the current behavior.
 */

import {
  extractBinFromUserText,
  extractSlotFromUserText,
} from "./agentJbDeterministicReply.js";

export type PendingQuery = {
  /** Tool to call. */
  toolName: string;
  /** Arguments to pass to the tool. */
  args: Record<string, unknown>;
  /** Short human-readable label for the SSE status message. */
  statusLabel: string;
};

type PendingQueryChecker = {
  name: string;
  check(
    userQuestion: string,
    lastToolName: string,
    payload: Record<string, unknown>
  ): PendingQuery | null;
};

// ─── checker registry ────────────────────────────────────────────────────────

const CHECKERS: PendingQueryChecker[] = [
  /**
   * After query_jb_bins: user asks about a specific wafer's DUT×BIN distribution.
   * Example: "waferId 18 的 DUT 分布怎样" / "第5片各DUT的失效情况"
   * The LLM knows to call query_inf_site_bin_by_dut but can't in summary round.
   */
  {
    name: "inf_site_bin_by_dut:after_jb_bins",
    check(userQuestion, lastToolName, payload) {
      if (lastToolName !== "query_jb_bins") return null;
      // Must reference a specific slot — not a whole-lot DUT query
      const slot = extractSlotFromUserText(userQuestion);
      if (!slot) return null;
      // Must have a DUT / site / 触点 intent
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

  /**
   * After query_jb_bins: user asks about multiple passes' DUT×BIN agg when
   * extractBinFromUserText finds a BIN but tryRunDutBinAggAutoRoute didn't fire
   * (e.g. the user said "DUT" in a language variant not covered by the existing
   * regex, or asked about pass3/5 instead of pass1).
   *
   * This checker is intentionally narrow: only fires when the user mentions a
   * specific passId that differs from the default pass1 used by the direct route.
   */
  {
    name: "query_lot_dut_bin_agg:non_default_pass",
    check(userQuestion, lastToolName, payload) {
      if (lastToolName !== "query_jb_bins") return null;
      const focusBin = extractBinFromUserText(userQuestion);
      if (focusBin == null) return null;
      if (!/(dut|触点)/i.test(userQuestion)) return null;
      // Only fire for non-pass1 requests (pass1 is handled by tryRunDutBinAggAutoRoute)
      const passMatch = userQuestion.match(/pass\s*([135])|sort\s*([123])|高温|低温/i);
      if (!passMatch) return null; // default pass1 case handled elsewhere
      const passId = passMatch[1]
        ? parseInt(passMatch[1])
        : passMatch[2]
        ? [1, 3, 5][parseInt(passMatch[2]) - 1] ?? 1
        : /高温/.test(userQuestion) ? 3
        : /低温/.test(userQuestion) ? 5
        : 1;
      if (passId === 1) return null; // pass1 handled by tryRunDutBinAggAutoRoute
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

// ─── public API ─────────────────────────────────────────────────────────────

/**
 * Scan the registry for a pending follow-up query.
 * Returns the first matching PendingQuery, or null if none apply.
 */
export function detectPendingQuery(
  userQuestion: string,
  lastToolName: string,
  payload: Record<string, unknown>
): PendingQuery | null {
  for (const checker of CHECKERS) {
    const result = checker.check(userQuestion, lastToolName, payload);
    if (result) return result;
  }
  return null;
}
