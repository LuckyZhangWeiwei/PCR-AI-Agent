import type { JbRouteDecision } from "./jbRouteResolver.js";
import type { ChatMessage } from "./agentHistory.js";
import { buildJbScopeArgs, inferMaskFromText } from "./agentQueryScope.js";
import { scopedBadBinAggregateArgsFromUser } from "./agentJbScopedBadBinRoute.js";

export type DispatchRenderKind = "aggregate" | "emitTables";

export interface DispatchResult {
  queryTool: "aggregate_jb_bins" | "query_jb_bins";
  args: Record<string, unknown>;
  renderKind: DispatchRenderKind;
}

/** 只对这三个跨实体 mode 做确定性派发(阶段三第一期 spec §4)。 */
function planFor(
  decision: JbRouteDecision,
  userQuestion: string,
  history: ChatMessage[]
): DispatchResult | null {
  switch (decision.mode) {
    case "bin_card_attribution": {
      // 复用 scopedBadBin 的 scope 解析(device/mask/tester/时间窗),再换成 bin,cardId 维度
      const base = scopedBadBinAggregateArgsFromUser(userQuestion, history);
      if (!base) return null;
      const args = { ...base, groupBy: "bin,cardId" };
      return { queryTool: "aggregate_jb_bins", args, renderKind: "aggregate" };
    }
    case "lot_yield_ranking":
    case "card_yield_compare": {
      const args = buildJbScopeArgs(userQuestion, history, "query_jb_bins");
      const deviceStr = args ? String(args["device"] ?? "").trim() : "";
      if (args && deviceStr) {
        return { queryTool: "query_jb_bins", args, renderKind: "emitTables" };
      }
      // mask fallback: 裸 mask（如 N55Z）或 WC 前缀设备在 buildJbScopeArgs 无法解析 device 时
      const mask = inferMaskFromText(userQuestion);
      if (!mask) return null;
      const fallbackArgs = { ...(args ?? {}), mask };
      return { queryTool: "query_jb_bins", args: fallbackArgs, renderKind: "emitTables" };
    }
    default:
      return null;
  }
}

export function resolveDispatch(
  decision: JbRouteDecision,
  userQuestion: string,
  history: ChatMessage[]
): DispatchResult | null {
  if (decision.confidence !== "high") return null; // 红线:不确定不抢
  return planFor(decision, userQuestion, history);
}
