/**
 * Lot 列表类问题：直连 query_jb_bins + 服务端 lot 表，跳过首轮 LLM。
 * 避免 LLM 在 get_filter_values 空结果后误判「无机台」并结束。
 */

import type { ChatMessage } from "./agentHistory.js";
import {
  isLotListingQuestion,
} from "./agentJbDeterministicReply.js";
import {
  buildAggregateJbBinsScopeArgs,
  buildLotListingQueryArgs,
  inferDeviceFromHistory,
  inferDeviceFromText,
  inferPlatformFromHistory,
  inferPlatformFromText,
  inferTesterFromHistory,
  inferTesterIdFromText,
} from "./agentQueryScope.js";

export function canRunLotListingDirectRoute(
  userText: string,
  history: ChatMessage[] = []
): boolean {
  if (!isLotListingQuestion(userText)) return false;
  const device =
    inferDeviceFromText(userText) || inferDeviceFromHistory(history);
  const testerId =
    inferTesterIdFromText(userText) || inferTesterFromHistory(history);
  const platform =
    inferPlatformFromText(userText) || inferPlatformFromHistory(history);
  return Boolean(device || testerId || platform);
}

/** 总结轮：已调 get_filter_values / YM 但未 query_jb_bins 时恢复。 */
export function lotListingNeedsJbRecovery(
  userText: string,
  lastToolName: string | undefined
): boolean {
  if (!canRunLotListingDirectRoute(userText) || !lastToolName) return false;
  if (lastToolName === "query_jb_bins" || lastToolName === "aggregate_jb_bins") {
    return false;
  }
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
  "【lot 列表路由】用户要枚举 lot/批次列表时：若句中已有 device（如 WA01P14E）和/或机台（如 b3uflex24），" +
  "**直接** query_jb_bins(device, testerId, testEndFrom/To)；get_filter_values 空结果**不能**证明无机台。";
