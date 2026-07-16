// pcr-ai-api/src/lib/agent/dispatch/directRoutes/agentWaferMapDirectRoutes.ts
// Wafer-map / DUT-bin-map / DUT-yield-chart deterministic direct routes,
// extracted verbatim from core/agentLoop.ts (Round 3 split, Task 5).
import type { AgentConfig } from "../../agentConfig.js";
import {
  getHistory,
  appendMessages,
  type ChatMessage,
} from "../../agentHistory.js";
import { runTool } from "../../tools/agentToolHandlers.js";
import { buildChartOption, tryParseJsonish } from "../../tools/agentChartTool.js";
import {
  emitTextInChunks,
  toolResultForHistory,
  lastToolMessage,
} from "../../core/agentLoopShared.js";
import type { AgentSseEvent } from "../../core/agentLoop.js";
import { storeJbQuerySessionCache } from "../../jb/agentJbBinFormat.js";
import {
  parseJbToolPayload,
  resolveJbToolPayload,
} from "../../jb/agentJbPayloadResolve.js";
import { getCachedJbPayloadForLot } from "../../agentJbOverviewRoute.js";
import {
  buildDutBinMapArgsFromSession,
  sessionCanDrawDutBinMap,
} from "../../agentDutBinMapRoute.js";
import {
  buildInfDrawArgsAfterJbLookup,
  extractLotFromUserText,
  findJbLotContext,
  infDrawWaferMapArgsComplete,
} from "../../tools/agentInfWaferMapTool.js";
import { type WaferMapRoutePlan } from "../../agentWaferMapRoute.js";

/** DUT×BIN 关系图：inf_draw_dut_bin_map（非 inf_draw_wafer_map）。 */
export async function tryRunDutBinMapDirectRoute(
  sessionId: string,
  userQuestion: string,
  emit: (event: AgentSseEvent) => void
): Promise<boolean> {
  if (!sessionCanDrawDutBinMap(getHistory(sessionId), userQuestion)) {
    return false;
  }

  const history = getHistory(sessionId);
  const drawArgs = buildDutBinMapArgsFromSession(history, userQuestion);

  const missing: string[] = [];
  if (!String(drawArgs["device"] ?? "").trim()) missing.push("device");
  if (!String(drawArgs["lot"] ?? "").trim()) missing.push("lot");
  if (drawArgs["slot"] == null) missing.push("slot");
  if (drawArgs["bin"] == null) missing.push("bin");
  if (missing.length) {
    emit({
      type: "text",
      delta: `无法画 DUT×BIN 关系图：缺少 ${missing.join("、")}。请先查询该 lot/slot 或说明片号。`,
    });
    appendMessages(sessionId, {
      role: "assistant",
      content: `无法画 DUT×BIN 关系图：缺少 ${missing.join("、")}。`,
    });
    emit({ type: "done" });
    return true;
  }

  emit({ type: "status", message: "正在生成 DUT×BIN 关系晶圆图…" });
  emit({ type: "tool_start", name: "inf_draw_dut_bin_map", args: drawArgs });

  try {
    const raw = await runTool("inf_draw_dut_bin_map", drawArgs, { history });
    const content =
      typeof raw === "string" ? raw : JSON.stringify(raw);
    emit({
      type: "tool_result",
      name: "inf_draw_dut_bin_map",
      summary: content.slice(0, 200),
    });
    appendMessages(sessionId, {
      role: "tool",
      name: "inf_draw_dut_bin_map",
      tool_call_id: `dutbin_${Date.now()}`,
      content,
    });
    emitTextInChunks(content, emit);
    appendMessages(sessionId, { role: "assistant", content });
    emit({ type: "done" });
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    emit({ type: "text", delta: `DUT×BIN 关系图生成失败：${msg.slice(0, 300)}` });
    appendMessages(sessionId, {
      role: "assistant",
      content: `DUT×BIN 关系图生成失败：${msg.slice(0, 300)}`,
    });
    emit({ type: "done" });
    return true;
  }
}

/**
 * Summary 轮：inf_site_stats 已完成，直接生成 DUT 良率柱状图，不走 LLM。
 */
export async function tryRunDutYieldChartDirectRoute(
  sessionId: string,
  userQuestion: string,
  history: ChatMessage[],
  emit: (event: AgentSseEvent) => void
): Promise<boolean> {
  if (!userWantsDutYieldChart(userQuestion)) return false;
  const lastTool = lastToolMessage(history);
  if (lastTool?.name !== "inf_site_stats") return false;

  const parsed = tryParseJsonish(String(lastTool.content ?? ""));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const sitesRaw = (parsed as Record<string, unknown>).sites;
  if (!Array.isArray(sitesRaw) || sitesRaw.length === 0) return false;

  const sites = sitesRaw as Array<{ site_id: number; yield: number }>;
  const labels = sites.map((s) => `DUT${s.site_id}`);
  const values = sites.map((s) => +(s.yield * 100).toFixed(2));
  const data = { labels, series: [{ name: "良率%", values }] };

  try {
    emit({ type: "status", message: "正在生成DUT良率柱状图…" });
    const option = buildChartOption("bar", "各DUT良率%", data);
    emit({ type: "chart", option });
    const minY = Math.min(...values);
    const maxY = Math.max(...values);
    const content = `[图表已生成] 各DUT良率% 柱状图（${sites.length}个DUT，良率范围 ${minY.toFixed(1)}%–${maxY.toFixed(1)}%）`;
    emitTextInChunks(content, emit);
    appendMessages(sessionId, { role: "assistant", content });
    emit({ type: "done" });
    return true;
  } catch {
    return false;
  }
}

/** 执行 inf_draw_wafer_map 并结束本轮（不经过 LLM / JB 大表）。 */
export async function finishWaferMapDraw(
  sessionId: string,
  drawArgs: Record<string, unknown>,
  history: ChatMessage[],
  emit: (event: AgentSseEvent) => void
): Promise<boolean> {
  emit({ type: "status", message: "正在生成晶圆图…" });
  emit({ type: "tool_start", name: "inf_draw_wafer_map", args: drawArgs });

  try {
    const raw = await runTool("inf_draw_wafer_map", drawArgs, { history });
    const content =
      typeof raw === "string" ? raw : JSON.stringify(raw);
    emit({
      type: "tool_result",
      name: "inf_draw_wafer_map",
      summary: content.slice(0, 200),
    });
    const callId = `wafermap_fast_${Date.now()}`;
    appendMessages(sessionId, {
      role: "tool",
      name: "inf_draw_wafer_map",
      tool_call_id: callId,
      content,
    });
    emitTextInChunks(content, emit);
    appendMessages(sessionId, { role: "assistant", content });
    emit({ type: "done" });
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    emit({ type: "text", delta: `晶圆图生成失败：${msg.slice(0, 300)}` });
    appendMessages(sessionId, {
      role: "assistant",
      content: `晶圆图生成失败：${msg.slice(0, 300)}`,
    });
    emit({ type: "done" });
    return true;
  }
}

/** 按 agentWaferMapRoute 计划执行晶圆图（draw / 失败提示）。 */
export async function applyWaferMapRoutePlan(
  sessionId: string,
  plan: WaferMapRoutePlan,
  history: ChatMessage[],
  emit: (event: AgentSseEvent) => void
): Promise<boolean> {
  if (!plan.isWaferMapIntent) return false;
  const { action } = plan;
  if (action.kind === "not_applicable" || action.kind === "need_jb_lookup") {
    return false;
  }
  if (action.kind === "draw_failed") {
    emit({ type: "text", delta: action.message });
    appendMessages(sessionId, { role: "assistant", content: action.message });
    emit({ type: "done" });
    return true;
  }
  return finishWaferMapDraw(sessionId, action.args, history, emit);
}

/**
 * 用户提供 lot + slot 但未提供 device 时，自动 query_jb_bins 取 device，再直接画图。
 * 避免让 LLM 反问用户提供 device（LLM 不可靠地遵循 WAFER_MAP_JB_LOOKUP_NUDGE）。
 */
export async function tryRunWaferMapWithAutoDeviceLookup(
  sessionId: string,
  userQuestion: string,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void
): Promise<boolean> {
  // lot 必须可以从用户文本或历史 JB 上下文中提取
  const history = getHistory(sessionId);
  const lot =
    extractLotFromUserText(userQuestion) ?? findJbLotContext(history).lot;
  if (!lot) return false;

  // 复用已有缓存：同一 lot 已查过就直接画
  const cached = getCachedJbPayloadForLot(sessionId, lot);
  if (cached) {
    const drawArgs = buildInfDrawArgsAfterJbLookup(cached, history, userQuestion);
    if (!infDrawWaferMapArgsComplete(drawArgs)) {
      const msg =
        "已有 JB 数据，但画晶圆图还需要**片号（slot/waferId）**，如「第5片」或「slot=14」。";
      emitTextInChunks(msg, emit);
      appendMessages(sessionId, { role: "assistant", content: msg });
      emit({ type: "done" });
      return true;
    }
    return finishWaferMapDraw(sessionId, drawArgs, history, emit);
  }

  // 轻量查询：limit:1 只取 device/lot 字段，不需全量数据
  const queryArgs: Record<string, unknown> = { lot, limit: 1 };
  emit({ type: "status", message: `正在查询 ${lot} 的设备信息…` });
  emit({ type: "tool_start", name: "query_jb_bins", args: queryArgs });

  let jbCacheForHistory: string | undefined;
  let payload: Record<string, unknown> | null = null;

  try {
    const toolResult = await runTool("query_jb_bins", queryArgs, {
      toolResultMaxChars: agentConfig.toolResultMaxChars,
      history: getHistory(sessionId),
      onJbBinsWrapped: (wrapped) => {
        jbCacheForHistory = storeJbQuerySessionCache(sessionId, wrapped);
      },
    });
    const rawContent =
      typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult);
    const historyContent = toolResultForHistory(
      "query_jb_bins",
      rawContent,
      agentConfig.toolResultMaxHistoryChars,
      agentConfig.toolResultMaxChars,
      jbCacheForHistory
    );
    emit({ type: "tool_result", name: "query_jb_bins", summary: historyContent.slice(0, 200) });
    appendMessages(sessionId, {
      role: "tool",
      name: "query_jb_bins",
      tool_call_id: `wafermap_device_${Date.now()}`,
      content: historyContent,
    });
    payload =
      (jbCacheForHistory ? parseJbToolPayload(jbCacheForHistory) : null) ??
      resolveJbToolPayload(sessionId, historyContent);
  } catch (e) {
    // 查询失败 → 回退到 LLM 路由
    return false;
  }

  if (!payload) return false;

  const updatedHistory = getHistory(sessionId);
  const drawArgs = buildInfDrawArgsAfterJbLookup(
    payload as Record<string, unknown>,
    updatedHistory,
    userQuestion
  );

  if (!infDrawWaferMapArgsComplete(drawArgs)) {
    // device/lot 已有，通常是缺 slot
    const msg =
      "已查询到设备信息。画晶圆图还需要**片号（slot/waferId）**，如「第5片」或「slot=14」。";
    emitTextInChunks(msg, emit);
    appendMessages(sessionId, { role: "assistant", content: msg });
    emit({ type: "done" });
    return true;
  }

  return finishWaferMapDraw(sessionId, drawArgs, updatedHistory, emit);
}

/** 用户是否在请求 DUT 良率柱状图/分布图（需 inf_site_stats + generate_chart bar）。 */
export function userWantsDutYieldChart(text: string): boolean {
  if (!/(dut|site)/i.test(text)) return false;
  if (!/(yield|良率)/i.test(text)) return false;
  return /(柱|图|chart|bar|分布)/i.test(text);
}
