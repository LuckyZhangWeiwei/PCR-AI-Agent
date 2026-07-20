// pcr-ai-api/src/lib/agent/tools/agentToolHandlers.ts
import { runInfTool } from "../../infTools/index.js";
import { probeCardTypeLeadingSegment } from "../../probeCardTypeLeadingSegment.js";
import { deviceBaseMask } from "../../deviceMask.js";
import { addDutNumberToYieldMonitorV3Row } from "../../yieldTriggerLabelDut.js";
import { enrichInfcontrolLayerBinRowV2 } from "../../passBinSemantics.js";
import {
  buildChartOption,
  inferGenerateChartArgsFromHistory,
  normalizeGenerateChartArgs,
  resolveGenerateChartData,
  type ChartSentinel,
  type ClarificationSentinel,
} from "./agentChartTool.js";
import { normalizeInfDrawWaferMapArgs } from "./agentInfWaferMapTool.js";
import type { ChatMessage } from "../agentHistory.js";
import { runGetFilterValues } from "./agentFilterValuesTool.js";
import type { CardByPassIdEntry } from "../jb/agentJbBinFormat.js";
import {
  clampToolResultMaxChars,
  DEFAULT_TOOL_RESULT_MAX_CHARS,
} from "../agentConfig.js";
import { runOutputSiteBinByLotForLotByDirectory } from "../../outputSiteBinByLot/aggregate.js";
import type { SiteBinPass } from "../../outputSiteBinByLot/types.js";
import { tryResolveSiteBinByLotDummyForLotByDirectory } from "../../outputSiteBinByLotDummy.js";
import {
  buildDutConcentrationInsights,
  formatDutConcentrationMarkdown,
} from "../agentDutConcentration.js";
import { shouldRunDutAnalysis } from "../agentDutInsightTrigger.js";

import { toolQueryYieldTriggers, toolAggregateYieldTriggers } from "./agentToolYieldTriggers.js";
import { toolQueryJbBins, toolAggregateJbBins } from "./agentToolJbBins.js";
import { toolAggregateProbeCardTesterPerformance } from "./agentToolProbeCardPerf.js";
import { toolQueryLotDutBinAgg } from "./agentToolDutBinAgg.js";
import { toolQueryLotUnderperformingDuts } from "./agentToolUnderperformingDuts.js";
import { toolQueryInfSiteBinByDut } from "./agentToolInfSiteBin.js";

export type { ChartSentinel, ClarificationSentinel };

export type RunToolOptions = {
  toolResultMaxChars?: number;
  /** Recent session turns — used to infer generate_chart data when model omits args. */
  history?: ChatMessage[];
  /** query_jb_bins：serialize 前写入完整 markdown 缓存（总结轮直出表）。 */
  onJbBinsWrapped?: (wrapped: Record<string, unknown>) => void;
  /** 用户原始问题文本，供 DUT 集中度触发判断使用。 */
  userText?: string;
  /** query_lot_underperforming_duts：算出 passes 后回传，供直连出散点图。 */
  onUnderperformingDuts?: (passes: import("../../lotUnderperformingDuts.js").PassUnderperformingDutsResult[]) => void;
};

export function resolveToolResultMaxChars(options?: RunToolOptions): number {
  return clampToolResultMaxChars(
    options?.toolResultMaxChars ?? DEFAULT_TOOL_RESULT_MAX_CHARS
  );
}

export {
  AGENT_TOOL_LIST_LIMIT_DEFAULT,
  AGENT_TOOL_LIST_LIMIT_MAX,
} from "./agentToolListLimits.js";

export function clampLimit(raw: unknown, defaultVal: number, max: number): number {
  const n = typeof raw === "number" ? raw : defaultVal;
  return Math.min(Math.max(1, Math.round(n)), max);
}

export function truncateResult(obj: unknown, maxChars: number): string {
  try {
    const s = JSON.stringify(obj);
    if (s.length <= maxChars) return s;
    const omitted = s.length - maxChars;
    return (
      s.slice(0, maxChars) +
      `…[数据已截断：省略了末尾 ${omitted} 字符（共 ${s.length} 字符），以上为不完整数据，请基于可见部分作答，勿假设省略部分的内容]`
    );
  } catch {
    return "(结果序列化失败)";
  }
}

export function enrichYieldRow(row: Record<string, unknown>): Record<string, unknown> {
  const base = addDutNumberToYieldMonitorV3Row(row);
  return {
    ...base,
    PROBECARDTYPE: probeCardTypeLeadingSegment(
      base["PROBECARD"] ?? base["probecard"]
    ),
    MASK: deviceBaseMask(base["DEVICE"] ?? base["device"]),
  };
}

export function enrichJbRow(row: Record<string, unknown>): Record<string, unknown> {
  const e = enrichInfcontrolLayerBinRowV2(row);
  return {
    ...e,
    PROBECARDTYPE: probeCardTypeLeadingSegment(e["CARDID"] ?? e["cardid"]),
    MASK: deviceBaseMask(e["DEVICE"] ?? e["device"]),
  };
}

export async function runTool(
  name: string,
  args: Record<string, unknown>,
  options?: RunToolOptions
): Promise<string | ChartSentinel | ClarificationSentinel> {
  const maxChars = resolveToolResultMaxChars(options);
  switch (name) {
    case "query_yield_triggers":
      return toolQueryYieldTriggers(args, maxChars);
    case "aggregate_yield_triggers":
      return toolAggregateYieldTriggers(args, maxChars);
    case "query_jb_bins":
      return toolQueryJbBins(args, maxChars, options);
    case "aggregate_jb_bins":
      return toolAggregateJbBins(args, maxChars);
    case "aggregate_probe_card_tester_performance":
      return toolAggregateProbeCardTesterPerformance(args, maxChars);
    case "generate_chart": {
      try {
        const fromHistory =
          options?.history && options.history.length > 0
            ? inferGenerateChartArgsFromHistory(options.history, args)
            : null;
        const normalized = fromHistory ?? normalizeGenerateChartArgs(args);
        const chartType = (normalized["chartType"] ?? "pie") as
          | "bar"
          | "line"
          | "pie"
          | "scatter";
        const title = String(normalized["title"] ?? "");
        const data = resolveGenerateChartData(normalized);
        if (!data) {
          const keys = Object.keys(args).join(", ") || "(空)";
          const hint = options?.history?.some(
            (m) => m.role === "tool" && m.name === "query_inf_site_bin_by_dut"
          )
            ? " 若刚查询过 INF DUT 分布，请确保 title 或用户问题中含 DUT 编号（如 DUT2），或显式传入 labels+values。"
            : "";
          return (
            `生成图表失败: 缺少有效的 labels/values 或 data 结构。` +
            `请传入 data: { labels, series } 或顶层 labels + values 数组。收到参数键: ${keys}` +
            hint
          );
        }
        const option = buildChartOption(chartType, title, data);
        return { __chartOption: option };
      } catch (err) {
        return `生成图表失败: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    case "ask_clarification": {
      const question = String(args["question"] ?? "").trim();
      if (!question) return "ask_clarification 参数错误: question 不能为空";
      const rawOpts = args["options"];
      const options: string[] | undefined =
        Array.isArray(rawOpts) && rawOpts.length > 0
          ? rawOpts.map(String).filter(Boolean)
          : undefined;
      return { __clarification: question, ...(options ? { __clarification_options: options } : {}) };
    }
    case "get_filter_values":
      return runGetFilterValues(args);
    case "query_lot_dut_bin_agg":
      return toolQueryLotDutBinAgg(args, maxChars);
    case "query_lot_underperforming_duts":
      return toolQueryLotUnderperformingDuts(args, maxChars, options);
    case "query_inf_site_bin_by_dut":
      return toolQueryInfSiteBinByDut(args, maxChars);
    default: {
      // Delegate inf_* tools
      if (name.startsWith("inf_")) {
        const infArgs =
          name === "inf_draw_wafer_map" && options?.history?.length
            ? normalizeInfDrawWaferMapArgs(args, options.history)
            : args;
        const result = await runInfTool(name, infArgs);
        if (result !== null) return result;
      }
      return `未知工具: ${name}`;
    }
  }
}

/**
 * 当 JB lot payload 检出可疑坏 bin（clusteredBadBinAlerts 非空）或用户问题涉及 DUT/卡 vs 工艺时，
 * 自动拉 INF site-bin-bylot 数据，计算 DUT 集中度判别，并将结果 markdown 写入
 * payload["dutConcentrationMarkdown"]。INF 失败时静默跳过，不抛、不阻断主流程。
 */
export async function attachDutConcentrationToJbPayload(
  payload: Record<string, unknown>,
  userText: string
): Promise<void> {
  if (!shouldRunDutAnalysis(userText, payload)) return;

  const device = typeof payload["device"] === "string" ? payload["device"].trim() : "";
  const lot = typeof payload["lot"] === "string" ? payload["lot"].trim() : "";
  if (!device || !lot) return;

  // focusBins 取自 clusteredBadBinAlerts[].bin（数字数组；空则不限）
  const alertsRaw = payload["clusteredBadBinAlerts"];
  const focusBins: number[] = [];
  if (Array.isArray(alertsRaw)) {
    for (const alert of alertsRaw) {
      if (
        alert &&
        typeof alert === "object" &&
        typeof (alert as Record<string, unknown>)["bin"] === "number"
      ) {
        focusBins.push((alert as Record<string, unknown>)["bin"] as number);
      }
    }
  }

  try {
    const passIds = [1, 3, 5];

    // 复用 Task 4 的取数方式（byDirectory，不限 probeCardType）
    const dummy = tryResolveSiteBinByLotDummyForLotByDirectory(device, lot, passIds);
    let rawPasses: SiteBinPass[];
    if (dummy !== null) {
      rawPasses = dummy.passes;
    } else {
      const res = await runOutputSiteBinByLotForLotByDirectory(device, lot, passIds);
      rawPasses = res.data.passes;
    }

    if (!rawPasses || rawPasses.length === 0) return;

    // focusBins 非空 = 仅分析可疑 bin；若这些 bin 在本次 INF 无数据，则不出表
    // （展示其它无关 bin 会误导卡 vs 工艺判断）。focusBins 为空时不限 bin、分析全部。
    // cardByPassId 来自 JB payload，使结论落到「卡 X 的 DUT a/b/c」。
    const cardByPassId =
      (payload["cardByPassId"] as CardByPassIdEntry[] | undefined) ?? [];
    const insights = buildDutConcentrationInsights(rawPasses, cardByPassId, {
      focusBins: focusBins.length ? focusBins : undefined,
    });
    if (insights.length === 0) return;
    const md = formatDutConcentrationMarkdown(insights);
    if (md && md.trim()) {
      payload["dutConcentrationMarkdown"] = md;
    }
  } catch {
    // INF 失败静默跳过，不阻断主流程
  }
}
