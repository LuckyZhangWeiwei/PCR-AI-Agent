/**
 * 跨 lot / device+机台+时间窗 的 fail bin 排行：直连 aggregate_jb_bins(groupBy:bin)，
 * 避免 session 单 lot 缓存误出 NF13256.1R 概况表。
 */

import type { ChatMessage } from "./agentHistory.js";
import { extractLotFromUserText } from "./agentInfWaferMapTool.js";
import { isBadBinRankingQuestion } from "./agentJbDeterministicReply.js";
import {
  buildScopedBadBinAggregateArgs,
  inferDeviceFromHistory,
  inferDeviceFromText,
  inferMaskFromHistory,
  inferMaskFromText,
  inferPlatformFromText,
  inferRecentMonthsWindow,
  inferTesterFromHistory,
  inferTesterIdFromText,
} from "./agentQueryScope.js";

export function canRunScopedBadBinDirectRoute(
  userText: string,
  history: ChatMessage[] = []
): boolean {
  if (!isBadBinRankingQuestion(userText)) return false;
  if (extractLotFromUserText(userText)) return false;

  const device = inferDeviceFromText(userText) || inferDeviceFromHistory(history);
  // Device alone is sufficient: "WK12N22J 总的坏die" / "N55Z 总的坏die" → aggregate.
  if (device) return true;

  // mask alone is sufficient too ("N55Z 哪个坏die最多" → aggregate across the family).
  const mask = inferMaskFromText(userText) || inferMaskFromHistory(history);
  if (mask) return true;

  const tester = inferTesterIdFromText(userText) || inferTesterFromHistory(history);
  if (tester) return true;

  const window = inferRecentMonthsWindow(userText);
  if (window.testEndFrom) return true;

  // Platform (PS16/J750/…) is broad — only route directly when a time window scopes it.
  const platform = inferPlatformFromText(userText);
  return Boolean(platform && window.testEndFrom);
}

export function scopedBadBinNeedsAggregateRecovery(
  userText: string,
  lastToolName: string | undefined,
  history: ChatMessage[] = []
): boolean {
  if (!canRunScopedBadBinDirectRoute(userText, history)) return false;
  if (lastToolName === "aggregate_jb_bins") return false;
  return true;
}

export function scopedBadBinAggregateArgsFromUser(
  userText: string,
  history: ChatMessage[] = []
): Record<string, unknown> | null {
  return buildScopedBadBinAggregateArgs(userText, history);
}

export const SCOPED_BAD_BIN_DIRECT_ROUTE_HINT =
  "【跨 lot fail bin 路由】用户问 device+机台+时间范围内的主要 fail bin 时：" +
  "**直接** aggregate_jb_bins(device, testerId, testEndFrom/To, groupBy:\"bin\")；" +
  "禁止用 session 内单 lot 的 topBadBins / lot 概况代替。";
