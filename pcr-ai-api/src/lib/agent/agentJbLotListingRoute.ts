/**
 * Lot 列表类问题：直连 query_jb_bins + 服务端 lot 表，跳过首轮 LLM。
 * 查询范围统一由 resolveJbListingScope 解析（含 cardId / device / 机台）。
 */

import type { ChatMessage } from "./agentHistory.js";
import { isLotListingQuestion } from "./jb/agentJbQuestionClassifiers.js";
import {
  buildAggregateJbBinsScopeArgs,
  buildLotListingQueryArgs,
  findLastToolCallArgs,
  jbListingScopeMatchesArgs,
  resolveJbListingScope,
} from "./agentQueryScope.js";

export function canRunLotListingDirectRoute(
  userText: string,
  history: ChatMessage[] = []
): boolean {
  if (!isLotListingQuestion(userText)) return false;
  return resolveJbListingScope(userText, history) != null;
}

/** 总结轮：已调 YM/filter 但 query_jb_bins 范围与解析 scope 不一致时恢复。 */
export function lotListingNeedsJbRecovery(
  userText: string,
  lastToolName: string | undefined,
  history: ChatMessage[] = []
): boolean {
  if (!canRunLotListingDirectRoute(userText, history) || !lastToolName) return false;
  if (lastToolName === "query_jb_bins") {
    const scope = resolveJbListingScope(userText, history);
    if (!scope) return false;
    const args = findLastToolCallArgs(history, "query_jb_bins");
    return !jbListingScopeMatchesArgs(scope, args);
  }
  if (lastToolName === "aggregate_jb_bins") return false;
  return true;
}

export function lotListingQueryArgsFromUser(
  userText: string,
  history: ChatMessage[] = []
): Record<string, unknown> | null {
  return buildLotListingQueryArgs(userText, history);
}

export function lotListingAggregateArgsFromUser(
  userText: string,
  history: ChatMessage[],
  jbPayload: Record<string, unknown>
): Record<string, unknown> | null {
  return buildAggregateJbBinsScopeArgs(userText, history, jbPayload);
}

export const LOT_LISTING_DIRECT_ROUTE_HINT =
  "【lot 列表路由】用户要枚举 lot/批次列表时：scope 由 resolveJbListingScope 解析（cardId / device / 机台 / mask）；" +
  "get_filter_values 空结果**不能**证明无数据。";
