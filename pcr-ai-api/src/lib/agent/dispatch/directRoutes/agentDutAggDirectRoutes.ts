// pcr-ai-api/src/lib/agent/dispatch/directRoutes/agentDutAggDirectRoutes.ts
// DUT×BIN aggregate + underperforming-DUT direct routes, extracted verbatim from
// core/agentLoop.ts (Round 3 split, Task 8).
import type { AgentConfig } from "../../agentConfig.js";
import { getHistory, appendMessages } from "../../agentHistory.js";
import { runTool } from "../../tools/agentToolHandlers.js";
import {
  emitTextInChunks,
  lastToolMessage,
  cleanStreamErrorMessage,
} from "../../core/agentLoopShared.js";
import type { AgentSseEvent } from "../../core/agentLoop.js";
import { streamSiliconFlow } from "../../core/agentStream.js";
import { createDeepSeekFilter } from "../../core/agentEmbeddedToolParsing.js";
import {
  tryEmitDutBinBarChart,
  buildDutBinAggMarkdown,
} from "../../render/agentChartEmitters.js";
import {
  tryEmitUnderperformingDutScatter,
} from "../../tools/agentToolUnderperformingDutsRender.js";
import { isDutBinConcentrationQuestion } from "../agentQuestionHeuristics.js";
import { extractBinFromUserText } from "../../jb/agentJbQuestionClassifiers.js";
import { extractLotFromUserText } from "../../tools/agentInfWaferMapTool.js";
import { inferLotFromHistory, findLastToolCallArgs } from "../../agentQueryScope.js";
import { getCachedJbPayloadForLot } from "../../agentJbOverviewRoute.js";
import { resolveJbToolPayload } from "../../jb/agentJbPayloadResolve.js";
import {
  BRIEF_COMMENTARY_SYSTEM,
  buildBriefCommentaryUserMessage,
  buildEngineeringContextFromPayload,
  DETERMINISTIC_DATA_SECTION_TITLE,
  DETERMINISTIC_COMMENTARY_SECTION_TITLE,
  stampFirstTestNote,
} from "../../jb/agentJbOverviewMarkdown.js";
import {
  canRunUnderperformingDutDirectRoute,
  underperformingDutArgsFromText,
} from "../../agentUnderperformingDutRoute.js";
import {
  formatAllDutsHighlightMarkdown,
} from "../../agentUnderperformingDutView.js";
import {
  runLotUnderperformingDuts,
} from "../../../lotUnderperformingDutsResolve.js";

/**
 * 「哪个卡/哪个 DUT 测出 BIN79 最多」：首轮直连 query_lot_dut_bin_agg（P-F）。
 */
export async function tryRunDutBinAggDirectRoute(
  sessionId: string,
  userQuestion: string,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void
): Promise<boolean> {
  if (!isDutBinConcentrationQuestion(userQuestion)) return false;

  const focusBin = extractBinFromUserText(userQuestion)!;
  const history = getHistory(sessionId);
  const lot =
    extractLotFromUserText(userQuestion) || inferLotFromHistory(history);
  if (!lot) return false;

  let device = "";
  const cached = getCachedJbPayloadForLot(sessionId, lot);
  if (cached) {
    device = String(cached["device"] ?? "").trim();
  }
  if (!device) {
    const jbArgs = findLastToolCallArgs(history, "query_jb_bins");
    device = String(jbArgs?.["device"] ?? "").trim();
  }
  if (!device) return false;

  const queryArgs: Record<string, unknown> = { device, lot, passId: 1, focusBin };
  emit({ type: "status", message: `正在查询 ${lot} DUT×BIN${focusBin} 聚合…` });
  emit({ type: "tool_start", name: "query_lot_dut_bin_agg", args: queryArgs });

  let rawContent: string;
  try {
    const toolResult = await runTool("query_lot_dut_bin_agg", queryArgs, {
      toolResultMaxChars: agentConfig.toolResultMaxChars,
      history,
    });
    rawContent = typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult);
  } catch {
    return false;
  }

  emit({ type: "tool_result", name: "query_lot_dut_bin_agg", summary: rawContent.slice(0, 200) });
  appendMessages(sessionId, {
    role: "tool",
    name: "query_lot_dut_bin_agg",
    tool_call_id: `dut_bin_direct_${Date.now()}`,
    content: rawContent.slice(0, agentConfig.toolResultMaxChars),
  });

  if (!/坏 die 的 DUT 集中度/.test(rawContent)) return false;

  const tablesBlock = stampFirstTestNote(`${DETERMINISTIC_DATA_SECTION_TITLE}\n\n${rawContent}`);
  emitTextInChunks(tablesBlock, emit);
  tryEmitDutBinBarChart(rawContent, focusBin, emit);
  appendMessages(sessionId, { role: "assistant", content: tablesBlock });
  emit({ type: "done" });
  return true;
}

/**
 * A 路：用户问「lot 内哪些 DUT 良率偏低」→ 直接 runLotUnderperformingDuts，
 * 确定性出全 DUT 高亮表 + 每 pass 散点图，跳过 LLM。失败落回 LLM（return false）。
 */
export async function tryRunUnderperformingDutDirectRoute(
  sessionId: string,
  userQuestion: string,
  _agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void
): Promise<boolean> {
  const history = getHistory(sessionId);
  if (!canRunUnderperformingDutDirectRoute(userQuestion, history)) return false;
  const args = underperformingDutArgsFromText(userQuestion, history);
  if (!args) return false;

  emit({ type: "status", message: "正在分析各 DUT 良率（含 INF 取数，稍慢）…" });
  emit({ type: "tool_start", name: "query_lot_underperforming_duts", args });

  let resp;
  let md: string;
  try {
    resp = await runLotUnderperformingDuts({ lot: args.lot, device: args.device });
    md = formatAllDutsHighlightMarkdown(resp.passes ?? [], resp.lot, resp.device);
  } catch {
    return false; // INF 取数或格式化失败 → 落回 LLM，不 dead-end
  }
  if (!md.trim()) return false;
  const passes = resp.passes ?? [];

  emit({ type: "tool_result", name: "query_lot_underperforming_duts", summary: md.slice(0, 200) });
  const block = stampFirstTestNote(`${DETERMINISTIC_DATA_SECTION_TITLE}\n\n${md}`);
  emitTextInChunks(block, emit);
  tryEmitUnderperformingDutScatter(passes, emit);
  appendMessages(sessionId, { role: "assistant", content: block });
  emit({ type: "done" });
  return true;
}

/**
 * Summary 轮专用：query_jb_bins 已完成、用户问"哪个 DUT 的 BIN X 最多"时，
 * 自动调 query_lot_dut_bin_agg，直出 DUT 分布表 + LLM 解读，避免模型承诺查询却无法执行。
 */
export async function tryRunDutBinAggAutoRoute(
  sessionId: string,
  userQuestion: string,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void
): Promise<boolean> {
  const focusBin = extractBinFromUserText(userQuestion);
  if (focusBin == null) return false;
  if (!/(dut|触点)/i.test(userQuestion)) return false;

  const history = getHistory(sessionId);
  const lastTool = lastToolMessage(history);
  if (lastTool?.name !== "query_jb_bins") return false;

  const payload = resolveJbToolPayload(sessionId, String(lastTool.content ?? ""));
  if (!payload) return false;

  const device = String(payload["device"] ?? "").trim();
  const lot = String(payload["lot"] ?? "").trim();
  if (!device || !lot) return false;

  const queryArgs: Record<string, unknown> = { device, lot, passId: 1, focusBin };
  emit({ type: "status", message: `正在查询 ${lot} DUT×BIN${focusBin} 聚合…` });
  emit({ type: "tool_start", name: "query_lot_dut_bin_agg", args: queryArgs });

  let rawContent: string;
  try {
    const toolResult = await runTool("query_lot_dut_bin_agg", queryArgs, {
      toolResultMaxChars: agentConfig.toolResultMaxChars,
      history: getHistory(sessionId),
    });
    rawContent = typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult);
  } catch {
    return false; // 失败回退到 LLM 路由
  }

  emit({ type: "tool_result", name: "query_lot_dut_bin_agg", summary: rawContent.slice(0, 200) });
  appendMessages(sessionId, {
    role: "tool",
    name: "query_lot_dut_bin_agg",
    tool_call_id: `dut_bin_auto_${Date.now()}`,
    content: rawContent.slice(0, agentConfig.toolResultMaxChars),
  });

  const tableMd = buildDutBinAggMarkdown(rawContent, focusBin, lot, device);
  if (!tableMd.trim()) return false;

  const tablesBlock = stampFirstTestNote(`${DETERMINISTIC_DATA_SECTION_TITLE}\n\n${tableMd}`);
  emitTextInChunks(tablesBlock, emit);
  // DUT 分布数据点 ≥3 时自动生成 bar chart，直观展示哪个 DUT 集中出 BIN
  tryEmitDutBinBarChart(rawContent, focusBin, emit);
  emit({ type: "status", message: "正在生成数据解读…" });
  emit({ type: "text", delta: `\n\n${DETERMINISTIC_COMMENTARY_SECTION_TITLE}\n\n` });

  const commFilter = createDeepSeekFilter(emit);
  let streamError: string | undefined;
  await streamSiliconFlow(
    {
      model: agentConfig.subAgentModel,
      messages: [
        { role: "system", content: BRIEF_COMMENTARY_SYSTEM },
        {
          role: "user",
          content: buildBriefCommentaryUserMessage(userQuestion, tableMd, {
            engineeringContext: buildEngineeringContextFromPayload(payload),
          }),
        },
      ],
      max_tokens: 1024,
    },
    agentConfig,
    (chunk) => {
      if (chunk.type === "delta") commFilter.push(chunk.text);
      if (chunk.type === "error") streamError = chunk.message;
    }
  );
  commFilter.finalize();
  const commentary = commFilter.cleanText.trim();

  let commentaryOrFallback: string;
  if (commentary) {
    commentaryOrFallback = commentary;
  } else {
    commentaryOrFallback = streamError
      ? `*（解读生成失败：${cleanStreamErrorMessage(streamError)}；以上实测数据表为准。）*`
      : `*（模型未返回解读；以上实测数据表为准。）*`;
    emit({ type: "text", delta: commentaryOrFallback });
  }

  const full =
    tablesBlock +
    `\n\n${DETERMINISTIC_COMMENTARY_SECTION_TITLE}\n\n` +
    commentaryOrFallback;
  appendMessages(sessionId, { role: "assistant", content: full });
  emit({ type: "done" });
  return true;
}
