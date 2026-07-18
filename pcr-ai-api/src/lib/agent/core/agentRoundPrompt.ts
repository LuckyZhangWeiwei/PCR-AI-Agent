// pcr-ai-api/src/lib/agent/core/agentRoundPrompt.ts — per-round system prompt assembly extracted from agentLoop.ts (Round 4)
import type { ChatMessage } from "../agentHistory.js";
import { buildSystemPrompt } from "../prompt/agentPrompt.js";
import { classifyIntent } from "../prompt/agentPromptIntent.js";
import type { fetchOrCacheManifest } from "../agentManifest.js";
import {
  DUT_BIN_MAP_JB_LOOKUP_NUDGE,
  sessionCanDrawDutBinMap,
  userWantsDutBinRelationMap,
} from "../agentDutBinMapRoute.js";
import { userWantsDutYieldChart } from "../dispatch/directRoutes/agentWaferMapDirectRoutes.js";
import { isLotOverviewQuestion } from "../jb/agentJbQuestionClassifiers.js";
import { LOT_OVERVIEW_JB_NUDGE } from "../agentJbOverviewRoute.js";
import { planWaferMapRoute, WAFER_MAP_JB_LOOKUP_NUDGE } from "../agentWaferMapRoute.js";

const DUT_YIELD_CHART_NUDGE =
  "用户需要各 DUT 良率柱状图（yield bar chart per DUT/site）。请按以下固定步骤：\n" +
  "1. 调用 `inf_site_stats(device, lot, slot)` 取 per-DUT 良率数据（device/lot/slot 来自历史 query_jb_bins 结果）\n" +
  "2. 收到结果后，调用 `generate_chart(chartType=\"bar\", title=\"各DUT良率%\", data={labels:[\"DUT1\",\"DUT2\",...], series:[{name:\"良率%\",values:[yield%,...]}]})`\n" +
  "   - yield 字段为 0–1 小数，乘以 100 换算为百分比；labels 用 DUT{site_id} 格式\n" +
  "**禁止调用 `inf_draw_wafer_map`**（那是 die 坐标空间图，无法展示每 DUT 良率统计柱状）。";

/**
 * 模型在首轮只承诺"马上查"却没有真正调用任何工具时的纠正提示（一轮内最多用一次）。
 * 与 prompt/agentPrompt.ts:211/261 的硬规则同义，用代码兜底——避免完全依赖模型遵守文字规则。
 */
export const ANNOUNCEMENT_WITHOUT_ACTION_NUDGE =
  "你上一条回复只说明了要查询（如「马上查」「现在查询」之类），但没有真正调用任何工具。" +
  "现在必须**立即调用工具**取数，禁止再输出任何计划性/确认性文字。";

const SUMMARIZE_NUDGE =
  "【指令】工具查询已完成，立即用中文总结，禁止再调工具。\n" +
  "**字数约束**：数据解读 ≤ 150 字（3 句以内）；专业建议 3 条，每条 1 句（≤ 50 字）。\n" +
  "**格式**：数字只引用服务端预计算表中的值；解读/建议用 **### 数据解读**、**### 专业建议** 两节**纯文字段落**。\n" +
  "**【链接规则】** 工具结果中含 [点击...查看](/wafermaps/...) 格式的晶圆图链接时，必须**原样**复制到回复**第一行**，禁止改写或省略；若工具结果中**无**此格式链接，**严禁**自行编写或捏造任何 URL（含 https://example.com 等占位符）。\n" +
  "**禁止（DeepSeek-V4-Pro 常见问题）**：\n" +
  "- 禁止画 `| col |` markdown 表格（含「结论」列）\n" +
  "- 禁止逐行复述数据表里的每个数字（只点明异常值/对比）\n" +
  "- 禁止合并 pass1/3/5 的 die 成「整体良率」——各 pass 独立报告\n" +
  "- **禁止编造机台名称**：专业建议中的 TESTERID（如 b3uflexXX、b3ps16XX）只能来自工具返回的 `testerIdMarkdown`/`testerByLot`/`testerId` 字段；若工具未返回具体机台，写「测试机见上方机台表」，绝不凭空捏造 ID\n" +
  "**聚集性坏 bin**：工具 JSON 含 clusteredBadBinAlerts 或有警示表时，数据解读**首句必须**点明 BIN、waferId 范围与类型，禁止只报 lot 合计。\n" +
  "**良率**：只引用 slotYieldPivotMarkdown / slotYieldInterruptMarkdown / slotYieldSummary[].yieldPct；禁止用坏 die 颗数代替良率%；禁止写常温/高温/低温（用 pass1/3/5）。\n" +
  "**图表**：工具返回数据含 ≥4 个 BIN/DUT/lot 等对比项时，在结论文字**之后**调用 generate_chart 生成 bar 图；逐片趋势（slot 序列）用 line 图；仅此一次，已有图则不重复。";

// ─── 双源 / 通用结构化总结追加提示词 ──────────────────────────────────────────

/** YM + JB 双源总结轮：强制按域分节，避免两源数据混排。 */
const DUAL_SOURCE_SYNTHESIS_NUDGE =
  "\n\n【双源联查分节】本轮同时查了 Yield Monitor（YM）与 JB STAR（JB），" +
  "**必须**分三节输出（不加前言）：\n" +
  "**### YM 侧（Yield Monitor 报警）**：引用 query/aggregate_yield_triggers 结果；要点列表；≤ 3 条\n" +
  "**### JB 侧（JB STAR 测试）**：引用 query/aggregate_jb_bins 结果；要点列表；≤ 3 条\n" +
  "**### 综合结论**：1–2 句整合两源 + 1 条最优先可执行建议\n" +
  "禁止跨节混用两源数据；禁止引用本次工具之外的 lot/卡号。";

/** 非 JB 预计算路径的通用结构化输出要求（aggregate/YM/其他工具均走此分支）。 */
const GENERIC_STRUCTURED_SYNTHESIS_NUDGE =
  "\n\n【结构化输出要求】无预计算表，请按以下三节严格输出（不加前言）：\n" +
  "**### 数据摘要**：要点列表（`-` 开头），只引用工具数据；≤ 5 条\n" +
  "**### 主要发现**：3 条，每条引用具体数字；禁止编造\n" +
  "**### 建议**：3 条；每条 ≤ 50 字；禁止引用本次问题以外的 lot/卡号/device。";

/** 获取总结轮中刚执行完的工具名列表（history 末尾连续 tool 消息）。 */
function getRecentSummaryToolNames(history: ChatMessage[]): string[] {
  const names: string[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "tool") {
      const n = history[i].name;
      if (n) names.push(n);
    } else {
      break;
    }
  }
  return names;
}

export type SummaryContext = "jb" | "dual_source" | "generic";

/**
 * 根据本轮工具类型推断总结策略：
 * - dual_source：YM + JB 均有结果 → 按域分节
 * - generic：无 query_jb_bins → 通用结构化
 * - jb：只有 query_jb_bins（通常已被确定性表处理；LLM 兜底时用 JB 专用格式）
 */
export function getSummaryContext(history: ChatMessage[]): SummaryContext {
  const names = getRecentSummaryToolNames(history);
  const hasYm = names.some(
    (n) => n === "query_yield_triggers" || n === "aggregate_yield_triggers"
  );
  const hasJb = names.some(
    (n) => n === "query_jb_bins" || n === "aggregate_jb_bins"
  );
  if (hasYm && hasJb) return "dual_source";
  if (!names.some((n) => n === "query_jb_bins") && names.length > 0) return "generic";
  return "jb";
}

/**
 * Assembles the per-round system prompt: base manifest prompt + feedback
 * injection, plus mode-specific nudges (wafer/JB lookup, DUT×BIN map, DUT
 * yield chart, lot overview, announcement-without-action, summary-round
 * synthesis suffix). Pure computation, no side effects.
 * Behavior-identical to the code inlined at this point in the loop before
 * this split.
 */
export function buildRoundSystemPrompt(
  sessionId: string,
  history: ChatMessage[],
  userQuestion: string,
  manifest: Awaited<ReturnType<typeof fetchOrCacheManifest>> | undefined,
  feedbackInjection: string,
  awaitingSummary: boolean,
  waferPlan: ReturnType<typeof planWaferMapRoute>,
  summaryCtx: SummaryContext,
  announcementNudgeUsed: boolean
): string {
  // Inject nudge into the system prompt for the summary round — avoid a
  // trailing system message after tool turns, which is non-standard and can
  // cause empty responses on some providers (SiliconFlow/DeepSeek).
  const firstUserMsg = history.find((m) => m.role === "user")?.content ?? undefined;
  const intent = classifyIntent(userQuestion, firstUserMsg);
  const basePrompt = buildSystemPrompt(manifest, intent) + feedbackInjection;
  const waferJbNudge =
    !awaitingSummary && waferPlan.action.kind === "need_jb_lookup"
      ? `\n\n${WAFER_MAP_JB_LOOKUP_NUDGE}`
      : "";
  const dutBinNudge =
    !awaitingSummary &&
    userWantsDutBinRelationMap(userQuestion) &&
    !sessionCanDrawDutBinMap(sessionId, history, userQuestion)
      ? `\n\n${DUT_BIN_MAP_JB_LOOKUP_NUDGE}`
      : "";
  const dutYieldChartNudge =
    !awaitingSummary &&
    userWantsDutYieldChart(userQuestion) &&
    !history.some((m) => m.role === "tool" && m.name === "inf_site_stats")
      ? `\n\n${DUT_YIELD_CHART_NUDGE}`
      : "";
  const lotOverviewNudge =
    !awaitingSummary && isLotOverviewQuestion(userQuestion)
      ? `\n\n${LOT_OVERVIEW_JB_NUDGE}`
      : "";
  const summarySuffix =
    summaryCtx === "dual_source" ? DUAL_SOURCE_SYNTHESIS_NUDGE
    : summaryCtx === "generic" ? GENERIC_STRUCTURED_SYNTHESIS_NUDGE
    : "";
  const announcementNudge =
    !awaitingSummary && announcementNudgeUsed
      ? `\n\n${ANNOUNCEMENT_WITHOUT_ACTION_NUDGE}`
      : "";
  return awaitingSummary
    ? `${basePrompt}\n\n${SUMMARIZE_NUDGE}${summarySuffix}`
    : `${basePrompt}${waferJbNudge}${dutBinNudge}${dutYieldChartNudge}${lotOverviewNudge}${announcementNudge}`;
}

/**
 * Summary-round final user-turn nudge, keyed by {@link SummaryContext}.
 * `emptyResultHint` is appended verbatim (empty string when tools returned data).
 * Behavior-identical to the inline object literal it replaces.
 */
export function buildSummaryUserNudge(
  summaryCtx: SummaryContext,
  emptyResultHint: string
): ChatMessage {
  return {
    role: "user",
    content:
      summaryCtx === "dual_source"
        ? "请立即用中文给出分析结论。\n" +
          "要求：\n" +
          "1. 不要调用工具；不要画 markdown 表格\n" +
          "2. 分「### YM 侧（Yield Monitor 报警）」「### JB 侧（JB STAR 测试）」「### 综合结论」三节，每节 ≤ 3 句\n" +
          "3. 各节只引用本节工具数据；禁止跨节混用\n" +
          "4. 【链接必须保留】若工具返回了晶圆图/热力图链接（[点击...查看](...) 格式），必须原样复制到回复第一行，不得省略" +
          emptyResultHint
        : summaryCtx === "generic"
        ? "请立即用中文给出分析结论，分「### 数据摘要」「### 主要发现」「### 建议」三节输出。\n" +
          "要求：\n" +
          "1. 不要调用工具；不要 markdown 表格\n" +
          "2. 每节 ≤ 3 条，只引用工具返回的数据，禁止编造\n" +
          "3. 禁止引用本次问题以外的 lot/卡号/device 数据\n" +
          "4. 【链接必须保留】若工具返回了晶圆图/热力图链接（[点击...查看](...) 格式），必须原样复制到回复第一行，不得省略" +
          emptyResultHint
        : "请立即用中文给出分析结论。\n" +
          "要求：\n" +
          "1. 不要调用工具\n" +
          "2. 不要画 markdown 表格（`| col |`）\n" +
          "3. 不要逐行复述数据表——只点明异常/对比，引导用户看表\n" +
          "4. 数据解读 3 句以内；专业建议恰好 3 条，每条 1 句\n" +
          "5. 各 pass 良率独立报告，禁止合并为「整体良率」\n" +
          "6. 【链接必须保留】若工具返回了晶圆图/热力图链接（[点击...查看](...) 格式），必须原样复制到回复第一行，不得省略" +
          emptyResultHint,
  };
}
