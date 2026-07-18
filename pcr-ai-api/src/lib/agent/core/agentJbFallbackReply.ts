// pcr-ai-api/src/lib/agent/core/agentJbFallbackReply.ts — summary-round JB fallback replies extracted from agentLoop.ts (Round 4)
import { getHistory, appendMessages, type ChatMessage } from "../agentHistory.js";
import { jbWrappedIsEmptyQuery } from "../jb/agentJbBinFormat.js";
import {
  formatLotYieldOverviewMarkdown,
  formatSlotYieldMarkdownFromToolJson,
} from "../jb/agentJbHistoryCompact.js";
import {
  isSingleWaferDieClusterQuestion,
  isCardTypeLevelOverviewQuestion,
} from "../jb/agentJbQuestionClassifiers.js";
import { buildLotListingContext } from "../jb/agentJbListingMarkdown.js";
import {
  buildDeterministicJbTables,
  DETERMINISTIC_DATA_SECTION_TITLE,
  stampFirstTestNote,
} from "../jb/agentJbOverviewMarkdown.js";
import { resolveJbToolPayload } from "../jb/agentJbPayloadResolve.js";
import { planWaferMapRoute } from "../agentWaferMapRoute.js";
import { renderAggregateJbBinsResult } from "../render/agentAggregateBinsRender.js";
import { lastToolMessage, emitTextInChunks } from "./agentLoopShared.js";
import type { AgentSseEvent } from "./agentLoop.js";

export function chartToolFallbackMessage(toolMsg: ChatMessage): string {
  const c = String(toolMsg.content ?? "");
  if (c.startsWith("[图表已生成]")) {
    return "图表已生成，请查看上方。";
  }
  if (c.startsWith("生成图表失败") || c.startsWith("工具执行失败")) {
    return c;
  }
  return `图表生成未完成：${c.slice(0, 200)}`;
}

function jbBinsYieldFallbackMessage(
  toolMsg: ChatMessage,
  userQuestion: string,
  sessionId: string
): string | null {
  if (
    planWaferMapRoute(sessionId, getHistory(sessionId), userQuestion, "user_turn")
      .skipJbDeterministicSummary
  ) {
    return null;
  }
  if (toolMsg.name === "aggregate_jb_bins") {
    const content = String(toolMsg.content ?? "");
    // 与 tryRunDeterministicJbSummary 共用同一渲染选择链（单一真相源），此处仅取字符串。
    const rendered = renderAggregateJbBinsResult(content, userQuestion, undefined);
    if (!rendered) return null;
    return rendered.withDataTitle
      ? `${DETERMINISTIC_DATA_SECTION_TITLE}\n\n${rendered.table}`
      : rendered.table;
  }
  if (toolMsg.name !== "query_jb_bins") return null;
  // 单片坏 die 空间聚集问题：交回 LLM，勿用整 lot 表兜底（见 tryRunDeterministicJbSummary 同名 bail）。
  if (isSingleWaferDieClusterQuestion(userQuestion)) return null;
  // 卡型级问题：单 lot 概况代表不了整卡型，勿兜底单 lot 表（误导）。
  if (isCardTypeLevelOverviewQuestion(userQuestion)) return null;
  const payload = resolveJbToolPayload(
    sessionId,
    String(toolMsg.content ?? "")
  );
  if (payload && jbWrappedIsEmptyQuery(payload)) return null;
  if (payload) {
    const listingCtx = buildLotListingContext(payload, getHistory(sessionId));
    const tables = buildDeterministicJbTables(userQuestion, payload, listingCtx);
    if (tables?.trim()) {
      return `${DETERMINISTIC_DATA_SECTION_TITLE}\n\n${tables}`;
    }
    const overview = formatLotYieldOverviewMarkdown(payload);
    if (overview) {
      return `${DETERMINISTIC_DATA_SECTION_TITLE}\n\n${overview}`;
    }
  }
  return formatSlotYieldMarkdownFromToolJson(String(toolMsg.content ?? ""));
}

/** 总结轮 LLM 空输出时：直出服务端表（无解读），避免「模型未返回分析结论」。 */
export function finishWithJbServerTablesFallback(
  sessionId: string,
  userQuestion: string,
  emit: (event: AgentSseEvent) => void
): boolean {
  const lastTool = lastToolMessage(getHistory(sessionId));
  const rawFallback = lastTool
    ? jbBinsYieldFallbackMessage(lastTool, userQuestion, sessionId)
    : null;
  if (!rawFallback?.trim()) return false;
  const fallback = stampFirstTestNote(rawFallback);
  emit({ type: "status", message: "模型未生成文字，正在输出服务端预计算表…" });
  emitTextInChunks(fallback, emit);
  appendMessages(sessionId, { role: "assistant", content: fallback });
  emit({ type: "done" });
  return true;
}
