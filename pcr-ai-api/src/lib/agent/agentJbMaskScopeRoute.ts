/**
 * Mask/device 级「测试情况 / 概况」（无 lot ID）：get_filter_values + query_jb_bins，
 * 不经首轮 LLM（Pass C invalid apiKey 降级、P11C 快路）。
 */

import type { ChatMessage } from "./agentHistory.js";
import { extractLotFromUserText, userWantsWaferMapOnly } from "./tools/agentInfWaferMapTool.js";
import { isLotOverviewQuestion } from "./jb/agentJbQuestionClassifiers.js";
import {
  inferDeviceFromText,
  inferMaskFromText,
  resolveRecentTimeWindow,
} from "./agentQueryScope.js";

export function canRunMaskScopeDirectRoute(
  userText: string,
  history: ChatMessage[] = []
): boolean {
  if (!isLotOverviewQuestion(userText) || userWantsWaferMapOnly(userText)) {
    return false;
  }
  if (extractLotFromUserText(userText)) return false;
  return Boolean(inferMaskFromText(userText) || inferDeviceFromText(userText));
}

export function maskScopeFilterValuesArgs(
  userText: string
): Record<string, unknown> | null {
  const mask = inferMaskFromText(userText);
  if (!mask) return null;
  return { domain: "both", field: "device", mask, limit: 10 };
}

export function maskScopeJbQueryArgs(
  userText: string,
  history: ChatMessage[] = []
): Record<string, unknown> | null {
  const device = inferDeviceFromText(userText);
  const mask = inferMaskFromText(userText);
  if (!device && !mask) return null;

  const window = resolveRecentTimeWindow(userText, history);
  const args: Record<string, unknown> = { limit: 500 };
  if (device) args["device"] = device;
  else if (mask) args["mask"] = mask;
  if (window.testEndFrom) args["testEndFrom"] = window.testEndFrom;
  if (window.testEndTo) args["testEndTo"] = window.testEndTo;
  return args;
}

export const MASK_SCOPE_DIRECT_ROUTE_HINT =
  "【mask 概况路由】用户问 mask/device 级测试情况（无 lot ID）时：" +
  "先 get_filter_values(domain:both, mask)，再 query_jb_bins(mask|device)；" +
  "出多 lot 列表或 recentLots，禁止只吐 primary lot 概况。";
