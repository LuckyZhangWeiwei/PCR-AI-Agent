/**
 * Lot 整体/概况类问题：直连 query_jb_bins + 服务端表，跳过首轮 LLM 与解读 LLM。
 */

import type { ChatMessage } from "./agentHistory.js";
import { extractLotFromUserText, userWantsWaferMapOnly } from "./tools/agentInfWaferMapTool.js";
import { buildJbSessionCacheJson } from "./jb/agentJbBinFormat.js";
import {
  isGoodBinValueQuestion,
  isLotOverviewQuestion,
  parseJbToolPayload,
} from "./agentJbDeterministicReply.js";
import { getJbToolRawJson, storeJbToolRawJson } from "./agentJbSessionCache.js";

export function canRunLotOverviewDirectRoute(userText: string): boolean {
  if (isGoodBinValueQuestion(userText)) return false;
  if (!isLotOverviewQuestion(userText) || userWantsWaferMapOnly(userText)) {
    return false;
  }
  return extractLotFromUserText(userText) != null;
}

export function jbPayloadMatchesLot(
  payload: Record<string, unknown>,
  lot: string
): boolean {
  const pLot = String(payload["lot"] ?? payload["LOT"] ?? "").trim();
  return pLot.length > 0 && pLot.toUpperCase() === lot.trim().toUpperCase();
}

/** 会话缓存中是否已有该 lot 的 query_jb_bins 结果。 */
export function getCachedJbPayloadForLot(
  sessionId: string,
  lot: string
): Record<string, unknown> | null {
  const cached = getJbToolRawJson(sessionId);
  if (!cached) return null;
  const p = parseJbToolPayload(cached);
  if (!p || !jbPayloadMatchesLot(p, lot)) return null;
  return p;
}

export function buildLotOverviewQueryArgs(lot: string): Record<string, unknown> {
  return { lot, limit: 200, testEndFrom: "2020-01-01" };
}

/** 注入 system：概况类问题必须先 JB，禁止只查 Yield Monitor。 */
export const LOT_OVERVIEW_JB_NUDGE =
  "【lot 概况路由】用户问批次整体/测试情况/概况时：**必须先** query_jb_bins(lot)（limit:200），读服务端预计算表；" +
  "禁止仅调用 query_yield_triggers 就结束；YM 报警可在 JB 表输出后再简要提及。";

export function lotOverviewNeedsJbRecovery(
  userText: string,
  lastToolName: string | undefined
): boolean {
  return (
    canRunLotOverviewDirectRoute(userText) &&
    lastToolName != null &&
    lastToolName !== "query_jb_bins"
  );
}
