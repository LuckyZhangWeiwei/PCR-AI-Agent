/**
 * 晶圆图专用路由（一次性收敛「只画图 / 换 BIN / 多轮跟画」逻辑）。
 *
 * Agent 循环只应通过本模块决策：
 * - 是否跳过 JB 确定性大表（skipJbDeterministicSummary）
 * - 是否在本轮直接 inf_draw_wafer_map（action: draw）
 * - 是否仅需 query_jb_bins 取 device（action: need_jb_lookup）
 *
 * 参数补全、passes 策略（composite / pass1 / final）见 agentInfWaferMapTool.ts。
 */

import type { ChatMessage } from "./agentHistory.js";
import {
  buildInfDrawArgsAfterJbLookup,
  buildInfDrawArgsFromSession,
  infDrawWaferMapArgsComplete,
  sessionCanDrawWaferMapWithoutJb,
  userWantsWaferMapOnly,
} from "./tools/agentInfWaferMapTool.js";
import {
  parseJbToolPayload,
  resolveJbToolPayload,
} from "./agentJbDeterministicReply.js";

export type WaferMapRoutePhase = "user_turn" | "after_jb_bins";

export type WaferMapRouteAction =
  | { kind: "draw"; args: Record<string, unknown> }
  | { kind: "draw_failed"; message: string }
  | { kind: "need_jb_lookup" }
  | { kind: "not_applicable" };

export type WaferMapRoutePlan = {
  isWaferMapIntent: boolean;
  /** 为 true 时禁止 tryRunDeterministicJbSummary / jbBinsYieldFallback */
  skipJbDeterministicSummary: boolean;
  action: WaferMapRouteAction;
};

function missingArgMessage(args: Record<string, unknown>): string {
  const missing: string[] = [];
  if (!String(args["device"] ?? "").trim()) missing.push("device");
  if (!String(args["lot"] ?? "").trim()) missing.push("lot");
  if (args["slot"] == null) missing.push("slot（waferId）");
  return (
    `已查到 JB 数据，但无法自动画图：缺少 ${missing.join("、")}。` +
    `请确认 lot 与片号（如「第14片」）后重试。`
  );
}

/**
 * 规划本轮晶圆图处理（agentLoop 在 user_turn / after_jb_bins 两处调用）。
 */
export function planWaferMapRoute(
  sessionId: string,
  history: ChatMessage[],
  userText: string,
  phase: WaferMapRoutePhase,
  lastToolName?: string,
  lastToolContent?: string
): WaferMapRoutePlan {
  const notApplicable: WaferMapRoutePlan = {
    isWaferMapIntent: false,
    skipJbDeterministicSummary: false,
    action: { kind: "not_applicable" },
  };

  if (!userWantsWaferMapOnly(userText)) return notApplicable;

  const base = {
    isWaferMapIntent: true,
    skipJbDeterministicSummary: true,
  } as const;

  if (phase === "after_jb_bins") {
    if (lastToolName !== "query_jb_bins") {
      // 上一个工具不是 query_jb_bins，无法画图且不应阻断 JB 确定性表
      return notApplicable;
    }
    // 优先本轮 query_jb_bins 工具结果，避免会话里旧 lot 的缓存覆盖
    const payload =
      (lastToolContent?.trim()
        ? parseJbToolPayload(lastToolContent)
        : null) ?? resolveJbToolPayload(sessionId, lastToolContent);
    if (!payload) {
      return {
        ...base,
        action: {
          kind: "draw_failed",
          message:
            "已执行 query_jb_bins，但无法解析 device/lot，无法自动画晶圆图。请点「重试」。",
        },
      };
    }
    const args = buildInfDrawArgsAfterJbLookup(
      payload as Record<string, unknown>,
      history,
      userText
    );
    if (!infDrawWaferMapArgsComplete(args)) {
      return {
        ...base,
        action: { kind: "draw_failed", message: missingArgMessage(args) },
      };
    }
    return { ...base, action: { kind: "draw", args } };
  }

  // user_turn：会话里已有 device/lot/slot → 直接画图，禁止再走 LLM+query_jb_bins
  if (sessionCanDrawWaferMapWithoutJb(history, userText)) {
    const args = buildInfDrawArgsFromSession(history, userText);
    return { ...base, action: { kind: "draw", args } };
  }

  // 缺 device：允许 LLM 仅调 query_jb_bins；画图在 after_jb_bins 相完成
  return { ...base, action: { kind: "need_jb_lookup" } };
}

/** 注入 system，约束模型「只查 device、勿展开 JB 表」 */
export const WAFER_MAP_JB_LOOKUP_NUDGE =
  "【晶圆图路由】用户只要交互式 wafer map HTML。若缺 device：仅可调用 query_jb_bins(lot) 取 device；" +
  "禁止输出聚集/良率/机台等 JB 表或长段解读；query_jb_bins 完成后由服务端自动 inf_draw_wafer_map。";
