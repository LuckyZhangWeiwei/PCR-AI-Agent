// pcr-ai-api/src/lib/agent/render/agentJbTablesReply.ts
// Deterministic JB server-side tables reply, extracted verbatim from agentLoop.ts.
import type { AgentConfig } from "../agentConfig.js";
import type { AgentSseEvent } from "../core/agentLoop.js";
import { getHistory, appendMessages, type ChatMessage } from "../agentHistory.js";
import {
  lastToolMessage,
  emitTextInChunks,
  cleanStreamErrorMessage,
} from "../core/agentLoopShared.js";
import {
  tryEmitTopBinBarChart,
  tryEmitCardDutBadDieChart,
} from "./agentChartEmitters.js";
import { resolveJbRouteAsync } from "../jbRouteResolver.js";
import { extractLotFromUserText } from "../tools/agentInfWaferMapTool.js";
import {
  jbReplySkipsCommentaryLlm,
  lotOverviewSkipsCommentaryAfterAlerts,
  payloadCoversMultipleLots,
} from "../jb/agentJbQuestionClassifiers.js";
import {
  buildLotListingContext,
  inferLotListingPresentation,
} from "../jb/agentJbListingMarkdown.js";
import {
  BRIEF_COMMENTARY_SYSTEM,
  buildBriefCommentaryUserMessage,
  buildDeterministicJbTables,
  buildEngineeringContextFromPayload,
  DETERMINISTIC_DATA_SECTION_TITLE,
  DETERMINISTIC_COMMENTARY_SECTION_TITLE,
  stampFirstTestNote,
  buildDeterministicLotOverviewCommentary,
} from "../jb/agentJbOverviewMarkdown.js";
import {
  shouldAppendUnderperformingDutYield,
} from "../jb/agentJbPayloadResolve.js";
import { jbListingScopeLabel, resolveJbListingScope } from "../agentQueryScope.js";
import { tryAppendUnderperformingDutSection } from "../tools/agentToolUnderperformingDutsRender.js";
import { createDeepSeekFilter } from "../core/agentEmbeddedToolParsing.js";
import { streamSiliconFlow } from "../core/agentStream.js";

/** 同轮若已查 Yield Monitor，摘一句供专业建议引用。 */
function yieldMonitorNoteFromHistory(history: ChatMessage[]): string | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== "tool" || m.name !== "query_yield_triggers") continue;
    const c = String(m.content ?? "");
    if (c.includes("count") || c.includes("触发")) {
      return "本会话已查询 Yield Monitor（delta_diff 探针卡 DUT 不均衡报警）；解读时可结合报警与 JB 坏 bin。";
    }
    return "本会话已查询 Yield Monitor；请结合报警条数/DUT 与 JB 表综合建议。";
  }
  return undefined;
}

/** 本轮（最后一条 user 之后）所有 query_jb_bins 工具结果命中的 distinct lot。 */
function collectQueryJbBinsLotsThisTurn(history: ChatMessage[]): string[] {
  const lots: string[] = [];
  const seen = new Set<string>();
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (m.role === "user") break;
    if (m.role !== "tool" || m.name !== "query_jb_bins") continue;
    try {
      const lot = String(
        (JSON.parse(String(m.content ?? "")) as Record<string, unknown>)["lot"] ?? ""
      ).trim();
      if (lot && !seen.has(lot)) { seen.add(lot); lots.push(lot); }
    } catch { /* non-JSON tool content (compacted) — skip */ }
  }
  return lots.reverse();
}

/** 直出 JB 服务端表；可选跳过解读 LLM（lot 概况等）。 */
export async function emitDeterministicJbTablesReply(
  sessionId: string,
  userQuestion: string,
  payload: Record<string, unknown>,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void,
  options?: { withCommentaryLlm?: boolean }
): Promise<boolean> {
  // 多卡「测试情况对比」统一守卫（P-C 真因收口）：本函数是所有「单 lot/卡确定性表」的唯一出口
  // —— equipment 直连、summary 轮、lot 概况/列表/逐片排名 直连路由均 `return` 本函数。多卡对比
  // 需要跨卡综述，不能在 LLM 前/总结轮直接吐单 lot 缓存表。
  // 在此一处拦截，返回 false 让各调用方放行给 LLM；新增任何走本函数的直连路由都自动受此保护。
  const lastToolName = lastToolMessage(getHistory(sessionId))?.name;
  const cachedLot = typeof payload["lot"] === "string" ? (payload["lot"] as string) : undefined;
  const decision = await resolveJbRouteAsync(
    userQuestion,
    { lastToolName, cachedLot },
    agentConfig,
    undefined,
    getHistory(sessionId),
    payload
  );
  if (decision.isMultiCardCompare) {
    console.warn(
      `[jbDeterministic/multiCardCompareBail] 多卡对比交回 LLM:「${userQuestion.slice(0, 50)}」`
    );
    return false;
  }
  const history = getHistory(sessionId);
  // 多 lot 守卫（与多卡 bail 同收口）：本轮查了多个 lot（turnLots>1），但单 lot 确定性表只取
  // 最后一个 lot——若用户跨 lot 对比，或本句未点名具体 lot（指代/复数，如「把对应的卡和dut都列
  // 出来」），单 lot 表答非所问（见 B4）→ 交回 LLM 用全部 lot 历史作答。direct route 在工具前
  // 运行时 turnLots 为空、不触发；仅 summary 轮（工具后）实际生效，新增的工具后路由自动受护。
  const turnLots = collectQueryJbBinsLotsThisTurn(history);
  if (turnLots.length > 1) {
    const lotNamedInQuestion = Boolean(extractLotFromUserText(userQuestion));
    const canRenderScopedListing =
      decision.mode === "lot_listing" && payloadCoversMultipleLots(payload);
    // lot_yield_ranking 故意 fan-out 多 lot query_jb_bins 再合并 rank，不能 bail
    if (
      decision.mode !== "lot_yield_ranking" &&
      !canRenderScopedListing &&
      (decision.isMultiLotCompare || !lotNamedInQuestion)
    ) {
      console.warn(
        `[jbDeterministic/multiLotBail] 多 lot 场景（${turnLots.length} 个 lot，本句点名 lot=${lotNamedInQuestion}）` +
          `不出单 lot 概况，交回 LLM 用全部 lot 历史作答:「${userQuestion.slice(0, 40)}」`
      );
      return false;
    }
  }
  // 诊断：用户问某个具体 lot 的「详细/测试情况」，但回复所用 payload 是 mask 限量缓存
  // （multiLotYieldScope 且非 lotQueryFullRows）→ 数据残缺（如 20/25 片），却以「详细」出表。
  const lotInQuestion = /[A-Z]{2}\d{4,}\.\d?[A-Z]?\w*/i.exec(userQuestion)?.[0];
  if (
    payload["multiLotYieldScope"] === true &&
    payload["lotQueryFullRows"] !== true &&
    lotInQuestion
  ) {
    console.warn(
      `[jbDeterministic/staleMaskCache] 用户问 lot=${lotInQuestion} 详细，但 payload 为 mask 限量缓存` +
        `（multiLotYieldScope=true, lotQueryFullRows!=true, count=${payload["count"]}, ` +
        `distinctLotCount=${payload["distinctLotCount"]}, primaryLot=${payload["lot"]}）→ ` +
        `本次出表可能基于残缺片数；应先 query_jb_bins(lot:"${lotInQuestion}", limit:200) 取全量再出详细。`
    );
  }
  const listingCtx = {
    ...buildLotListingContext(payload, history),
    scopeLabel: (() => {
      const scope = resolveJbListingScope(userQuestion, history);
      return scope ? jbListingScopeLabel(scope) : undefined;
    })(),
    presentation: inferLotListingPresentation(userQuestion),
  };
  const tables = buildDeterministicJbTables(
    userQuestion,
    payload,
    listingCtx,
    decision.mode
  );
  if (!tables?.trim()) return false;

  const mode = decision.mode;
  const skipCommentaryForAlerts = lotOverviewSkipsCommentaryAfterAlerts(
    mode,
    tables,
    payload
  );
  const withCommentary =
    options?.withCommentaryLlm ??
    (!jbReplySkipsCommentaryLlm(mode, userQuestion) &&
      !skipCommentaryForAlerts);

  const tablesBlock = stampFirstTestNote(`${DETERMINISTIC_DATA_SECTION_TITLE}\n\n${tables}`);
  emit({ type: "status", message: "正在输出服务端预计算表…" });
  emitTextInChunks(tablesBlock, emit);

  // 主分析 / lot 概况场景：topBadBins ≥3 项时自动生成坏 BIN bar chart
  if (mode === "generic" || mode === "lot_overview") {
    tryEmitTopBinBarChart(payload, emit);
    // 探针卡问题：自动追加 DUT 坏 die 总量对比图（失败静默跳过，不阻断主流程）
    await tryEmitCardDutBadDieChart(userQuestion, payload, agentConfig, emit);
  }

  // B 路 best-effort：lot 概况末尾补「各 DUT 良率」高亮表 + 散点图（失败/无数据静默跳过）
  let dutYieldSection = "";
  if (shouldAppendUnderperformingDutYield(userQuestion, mode, payload)) {
    dutYieldSection = await tryAppendUnderperformingDutSection(
      payload,
      emit,
      userQuestion
    );
  }

  if (!withCommentary) {
    // Include ## 分析结论 separator so splitAgentReplyMarkdown always has a clear split point,
    // keeping ### 🔍 警示 / 规律识别 in dataMarkdown (otherwise detachProseAfterMarkdownTables
    // would move the section to commentaryMarkdown where tables are CSS-hidden).
    const deterministicCommentary = skipCommentaryForAlerts
      ? buildDeterministicLotOverviewCommentary(payload)
      : null;
    const commentaryBody =
      deterministicCommentary ??
      (skipCommentaryForAlerts
        ? `*以上含服务端警示与规律识别，以及各 DUT 良率（如有）。如需某 BIN 逐片趋势或晶圆图，请继续提问。*`
        : `*以上为服务端实测表。如需某 BIN 逐片趋势或晶圆图，请继续提问。*`);
    const tableOnlyNote =
      `\n\n${DETERMINISTIC_COMMENTARY_SECTION_TITLE}\n\n` + commentaryBody;
    const full = tablesBlock + dutYieldSection + tableOnlyNote;
    emit({ type: "text", delta: tableOnlyNote });
    appendMessages(sessionId, { role: "assistant", content: full });
    emit({ type: "done" });
    return true;
  }

  emit({ type: "status", message: "正在生成数据解读与专业建议…" });
  // 先推送分段标题，避免解读文字与上方表格落在同一 Markdown 块里被 GFM 当成表尾行
  emit({
    type: "text",
    delta: `\n\n${DETERMINISTIC_COMMENTARY_SECTION_TITLE}\n\n`,
  });

  const commFilter = createDeepSeekFilter(emit);
  let streamError: string | undefined;

  await streamSiliconFlow(
    {
      model: agentConfig.subAgentModel, // 表解读：结构化输入/有界输出，sub-agent 模型即可
      messages: [
        { role: "system", content: BRIEF_COMMENTARY_SYSTEM },
        {
          role: "user",
          content: buildBriefCommentaryUserMessage(userQuestion, tables, {
            engineeringContext: buildEngineeringContextFromPayload(payload),
            yieldMonitorNote: yieldMonitorNoteFromHistory(history),
          }),
        },
      ],
      // No tool schemas: commentary is text-only (数据解读 + 专业建议 ≈ 300-600 tokens)
      max_tokens: 1024,
    },
    agentConfig,
    (chunk) => {
      switch (chunk.type) {
        case "delta":
          commFilter.push(chunk.text);
          break;
        case "error":
          streamError = chunk.message;
          break;
        default:
          break;
      }
    }
  );

  commFilter.finalize();
  const commentary = commFilter.cleanText.trim();

  // 标题已 SSE 流出；若解读为空则 emit fallback，保持用户所见与 history 一致
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
    dutYieldSection +
    `\n\n${DETERMINISTIC_COMMENTARY_SECTION_TITLE}\n\n` +
    commentaryOrFallback;

  appendMessages(sessionId, { role: "assistant", content: full });
  emit({ type: "done" });
  return true;
}
