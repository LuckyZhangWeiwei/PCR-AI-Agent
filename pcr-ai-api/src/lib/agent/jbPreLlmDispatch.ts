/**
 * jbPreLlmDispatch.ts — 纯谓词复刻当前 pre-LLM 直连路由 if 链（阶段1b）
 *
 * pickPreLlmRouteOld(q, history) 按与 agentLoop.ts:2706-2745 完全相同的顺序，
 * 仅凭文本层面判断哪条直连路由会触发，返回路由 ID 或 null（交回 LLM）。
 *
 * 注意：运行时的 session 缓存检查（resolveJbToolPayload / cachedJbScopeMismatch）
 * 不在此处——此函数是纯文本谓词，不依赖任何全局/会话状态。
 */

import type { ChatMessage } from "./agentHistory.js";
import { canRunLotListingDirectRoute } from "./agentJbLotListingRoute.js";
import { canRunScopedBadBinDirectRoute } from "./agentJbScopedBadBinRoute.js";
import { canRunLotOverviewDirectRoute } from "./agentJbOverviewRoute.js";
import {
  isProbeCardQuestion,
  isTesterMachineQuestion,
  isPerSlotBadBinRankingQuestion,
  isMultiCardComparisonQuestion,
  isBinCardAttributionQuestion,
} from "./agentJbDeterministicReply.js";
import {
  requiresNewDataQuery,
  equipmentRouteCrossLotBail,
} from "./agentLoop.js";

export type PreLlmRouteId =
  | "lot_listing"
  | "scoped_bad_bin"
  | "lot_overview"
  | "equipment"
  | "per_slot"
  | null;

/**
 * 复刻 tryRunEquipmentDirectRoute 的文本层检查（agentLoop.ts:1506-1529）。
 *
 * 真实 runner 顺序（以 runner 为准）：
 *   1. !isProbeCardQuestion(q) && !isTesterMachineQuestion(q)  → false  (line 1506)
 *   2. requiresNewDataQuery(q)                                 → false  (line 1509)
 *   3. /(增加|加上|包含|含).*机台|机台.*列表|列表.*机台/        → false  (line 1512)
 *   4. isBinCardAttributionQuestion(q)                        → false  (line 1514)
 *   5. equipmentRouteCrossLotBail(q)                          → false  (line 1524)
 *
 * isMultiCardComparisonQuestion：runner 注释(line 1521)说该 bail 已挪到
 * emitDeterministicJbTablesReply 入口，不在 runner 文本层。但此处作为"纯文本
 * 表征函数"仍纳入，使 pickPreLlmRouteOld 对多卡对比返回 null（交回 LLM），
 * 与任务用例一致；在报告中注明偏差。
 */
function equipmentTextGate(q: string): boolean {
  if (!isProbeCardQuestion(q) && !isTesterMachineQuestion(q)) return false;
  if (requiresNewDataQuery(q)) return false;
  if (/(增加|加上|包含|含).*机台|机台.*列表|列表.*机台/.test(q)) return false;
  if (isBinCardAttributionQuestion(q)) return false;
  if (equipmentRouteCrossLotBail(q)) return false;
  // 多卡对比：runner 已将此 bail 收口到 emitDeterministicJbTablesReply，
  // 此处保留以使纯文本谓词对多卡对比返回 null（见报告 §偏差说明）。
  if (isMultiCardComparisonQuestion(q)) return false;
  return true;
}

/**
 * 按 agentLoop.ts:2706-2745 的 if 链顺序，返回第一个文本门槛通过的路由 ID。
 * 顺序：lot_listing → scoped_bad_bin → lot_overview → equipment → per_slot → null
 *
 * 仅检查纯文本谓词；运行时 session 缓存检查留在各 runner 内。
 */
export function pickPreLlmRouteOld(
  q: string,
  history: ChatMessage[]
): PreLlmRouteId {
  if (canRunLotListingDirectRoute(q)) return "lot_listing";
  if (canRunScopedBadBinDirectRoute(q, history)) return "scoped_bad_bin";
  if (canRunLotOverviewDirectRoute(q)) return "lot_overview";
  if (equipmentTextGate(q)) return "equipment";
  if (isPerSlotBadBinRankingQuestion(q)) return "per_slot";
  return null;
}
