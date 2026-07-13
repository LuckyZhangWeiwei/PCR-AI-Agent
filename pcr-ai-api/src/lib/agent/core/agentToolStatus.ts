// pcr-ai-api/src/lib/agent/core/agentToolStatus.ts
// Tool-result status helpers + summary-round gating, extracted from agentLoop.ts.
import type { ChatMessage } from "../agentHistory.js";
import { tryParseJsonish } from "../tools/agentChartTool.js";

/**
 * Returns true if the last tool call returned empty / zero-result data.
 * Used to inject a natural-language fallback instruction into the summary nudge
 * so the LLM knows to say "no data found" instead of outputting nothing.
 */
export function isLastToolEmptyResult(lastTool: ChatMessage | undefined): boolean {
  if (!lastTool) return false;
  const c = tryParseJsonish(String(lastTool.content ?? ""));
  if (!c || typeof c !== "object" || Array.isArray(c)) return false;
  const p = c as Record<string, unknown>;
  if (Array.isArray(p["values"]) && (p["values"] as unknown[]).length === 0) return true;
  if (p["count"] === 0) return true;
  if (typeof p["totalRowsMatching"] === "number" && p["totalRowsMatching"] === 0) return true;
  return false;
}

// 面向用户的工具中文标签——状态提示里不暴露内部函数名（query_jb_bins 等）。
const TOOL_STATUS_LABELS: Record<string, string> = {
  query_yield_triggers: "良率监控查询",
  aggregate_yield_triggers: "良率监控统计",
  query_jb_bins: "JB 测试数据查询",
  aggregate_jb_bins: "JB BIN 聚合统计",
  get_filter_values: "可选值查询",
  query_lot_dut_bin_agg: "DUT×BIN 聚合",
  query_lot_underperforming_duts: "Lot 低良率 DUT",
  query_inf_site_bin_by_dut: "DUT 分布查询",
  inf_draw_wafer_map: "绘制晶圆图",
  inf_draw_dut_bin_map: "DUT×BIN 晶圆图",
  generate_chart: "生成图表",
  ask_clarification: "请求澄清",
};

/** 把内部工具名映射为面向用户的中文标签；未知工具回退为通用「数据查询」。 */
export function toolStatusLabel(name: string): string {
  return TOOL_STATUS_LABELS[name] ?? "数据查询";
}

/** True when the last history turn is tool output awaiting a text summary. */
export function historyAwaitingToolSummary(history: ChatMessage[]): boolean {
  if (history.length === 0) return false;
  const last = history[history.length - 1];
  if (last.role !== "tool") return false;
  // If the only data-fetch result so far is a single get_filter_values with
  // empty values, don't force summary yet — let the model query another domain.
  if (last.name === "get_filter_values") {
    const parsed = tryParseJsonish(String(last.content ?? ""));
    const values = parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)["values"]
      : undefined;
    if (Array.isArray(values) && values.length === 0) {
      // Look back past the assistant(tool_calls) turn to find the previous tool message.
      // If it was also an empty get_filter_values, both domains came back empty → force summary.
      let prevToolIdx = -1;
      for (let i = history.length - 2; i >= 0; i--) {
        if (history[i].role === "tool") { prevToolIdx = i; break; }
        if (history[i].role === "user") break;
      }
      if (prevToolIdx < 0) return false; // first empty result → give one more round
      const prevMsg = history[prevToolIdx];
      if (prevMsg.name !== "get_filter_values") return false; // different tool before → keep going
      const prevParsed = tryParseJsonish(String(prevMsg.content ?? ""));
      const prevValues = prevParsed &&
        typeof prevParsed === "object" &&
        !Array.isArray(prevParsed)
        ? (prevParsed as Record<string, unknown>)["values"]
        : undefined;
      if (
        !Array.isArray(prevValues) ||
        prevValues.length > 0
      ) return false; // previous result had data → keep going
      return true; // two consecutive empty get_filter_values → force summary
    }
  }
  return true;
}
