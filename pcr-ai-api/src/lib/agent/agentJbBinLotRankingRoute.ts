/**
 * 「哪个 lot BINnn 最多」：直连 aggregate_jb_bins(groupBy:"bin,lot")，
 * 用 buildBinFocusedLotRankingMarkdown 按指定 bin 排 lot（P-D）。
 */

import type { ChatMessage } from "./agentHistory.js";
import { extractLotFromUserText } from "./agentInfWaferMapTool.js";
import {
  extractBinFromUserText,
  isBinLotRankingQuestion,
} from "./agentJbDeterministicReply.js";
import {
  buildBinLotRankingAggregateArgs,
  inferDeviceFromHistory,
  inferDeviceFromText,
  inferMaskFromHistory,
  inferMaskFromText,
  inferPlatformFromHistory,
  inferPlatformFromText,
  inferRecentMonthsWindow,
  inferRecentMonthsWindowFromHistory,
  resolveRecentTimeWindow,
  inferTesterFromHistory,
  inferTesterIdFromText,
} from "./agentQueryScope.js";

export function canRunBinLotRankingDirectRoute(
  userText: string,
  history: ChatMessage[] = []
): boolean {
  if (!isBinLotRankingQuestion(userText)) return false;
  if (extractLotFromUserText(userText)) return false;
  if (extractBinFromUserText(userText) == null) return false;

  const device = inferDeviceFromText(userText) || inferDeviceFromHistory(history);
  if (device) return true;
  const mask = inferMaskFromText(userText) || inferMaskFromHistory(history);
  if (mask) return true;
  const tester = inferTesterIdFromText(userText) || inferTesterFromHistory(history);
  if (tester) return true;
  const platform =
    inferPlatformFromText(userText) || inferPlatformFromHistory(history);
  const window = resolveRecentTimeWindow(userText, history);
  return Boolean(device || mask || tester || window.testEndFrom || platform);
}

export function binLotRankingAggregateArgsFromUser(
  userText: string,
  history: ChatMessage[] = []
): Record<string, unknown> | null {
  return buildBinLotRankingAggregateArgs(userText, history);
}

export const BIN_LOT_RANKING_DIRECT_ROUTE_HINT =
  "【BIN×lot 排行路由】用户问「哪个 lot BINnn 最多」时：" +
  "**直接** aggregate_jb_bins(..., groupBy:\"bin,lot\")，再按指定 BIN 在各 lot 的颗数排序；" +
  "禁止用 groupBy:\"bin\" 的纯 BIN 总量排行代替 lot 定位。";
