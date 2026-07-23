/**
 * Lot 列表类问题：直连 query_jb_bins + 服务端 lot 表，跳过首轮 LLM。
 * 查询范围统一由 resolveJbListingScope 解析（含 cardId / device / 机台）。
 * 卡/device「怎样」概况与 lot 列表共用此路由；无时间窗时先澄清（数据量过大）。
 */

import type { ChatMessage } from "./agentHistory.js";
import { extractLotFromUserText } from "./tools/agentInfWaferMapTool.js";
import {
  isCardTestOverviewQuestion,
  isDeviceTestOverviewQuestion,
  isLotListingQuestion,
  isTesterTestOverviewQuestion,
  isBinCardAttributionQuestion,
} from "./jb/agentJbQuestionClassifiers.js";
import {
  buildAggregateJbBinsScopeArgs,
  buildLotListingQueryArgs,
  findLastToolCallArgs,
  hasResolvedTimeWindow,
  jbListingScopeMatchesArgs,
  resolveJbListingScope,
} from "./agentQueryScope.js";

/** 跨 lot 列表或卡/device/机台概况（均走 lot 列表呈现）。 */
export function isLotListingOrOverviewQuestion(userText: string): boolean {
  return (
    isLotListingQuestion(userText) ||
    isCardTestOverviewQuestion(userText) ||
    isDeviceTestOverviewQuestion(userText) ||
    isTesterTestOverviewQuestion(userText)
  );
}

export function canRunLotListingDirectRoute(
  userText: string,
  history: ChatMessage[] = []
): boolean {
  if (!isLotListingOrOverviewQuestion(userText)) return false;
  // BIN×卡归因（含「哪个 probe card 多 + 顺带列 lot」）优先走 bin_card_attribution /
  // LLM 多工具，禁止本路由只吐 lot 表而丢掉卡排行。
  if (isBinCardAttributionQuestion(userText)) return false;
  if (!hasResolvedTimeWindow(userText, history)) return false;
  return resolveJbListingScope(userText, history) != null;
}

/**
 * 卡 / device / 跨 lot 列表问法已能解析 scope，但未给时间窗 → 须先澄清。
 * 已点名具体 lot 的不问（单 lot 查询体积可控）。
 */
export function canRunListingTimeClarify(
  userText: string,
  history: ChatMessage[] = []
): boolean {
  if (!isLotListingOrOverviewQuestion(userText)) return false;
  if (extractLotFromUserText(userText)) return false;
  if (hasResolvedTimeWindow(userText, history)) return false;
  return resolveJbListingScope(userText, history) != null;
}

export function buildListingTimeClarifyMessage(
  userText: string,
  history: ChatMessage[] = []
): string {
  const scope = resolveJbListingScope(userText, history);
  const scopeHint = scope?.cardId
    ? `探针卡 ${scope.cardId}`
    : scope?.device
      ? `device ${scope.device}`
      : scope?.testerId
        ? `机台 ${scope.testerId}`
        : "该范围";
  return (
    `查询 ${scopeHint} 的跨 lot 数据量较大，需要先限定时间范围。\n\n` +
    "请补充时间窗口后再问，例如：\n" +
    "- 「最近一个月」/「近 3 个月」\n" +
    "- 「2026-05-01 到 2026-06-01」\n\n" +
    "示例：「6081-03 最近一个月怎样」「WA01N39W 近 3 个月测试了哪些 lot」"
  );
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
  "【lot 列表路由】用户要枚举 lot/批次列表或卡/device 概况时：scope 由 resolveJbListingScope 解析（cardId / device / 机台 / mask）；" +
  "**必须**带时间范围（最近 N 月或起止日期）；get_filter_values 空结果**不能**证明无数据。";
