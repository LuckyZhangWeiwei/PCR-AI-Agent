// pcr-ai-api/src/lib/agent/core/agentToolSchemaSelect.ts — tool schema selector extracted from agentLoop.ts (Round 4)
import type { ChatMessage } from "../agentHistory.js";
import { TOOL_SCHEMAS, INF_TOOL_SCHEMAS } from "./agentToolSchemas.js";

/**
 * INF wafer-map keywords (Chinese + English).
 * When any of these appear in the recent conversation, append INF tool schemas
 * to TOOL_SCHEMAS. Otherwise, keep the list lean (JB/Yield Monitor only).
 */
// Keywords that trigger injection of INF drawing tools (inf_draw_wafer_map / inf_draw_dut_bin_map).
// Only wafer-map drawing tools remain; all analysis tools have been removed from agent schemas.
const INF_KEYWORDS = [
  // Wafer map / visual output（含口语 wafer图 / wafer 图）
  "晶圆图", "wafermap", "wafer map", "wafer图", "wafer 图", "画晶圆", "画wafer",
  // DUT×BIN relationship map (inf_draw_dut_bin_map)
  "dut和bin", "dut与bin", "dut×bin", "bin和dut",
  "dut_bin_map", "dutbin",
  // DUT yield chart (inf_site_stats + generate_chart)
  "dut良率", "dut yield", "各dut", "每个dut", "良率柱状", "yield柱状", "yield分布图", "yield图",
  // Touchdown / touch count analysis (inf_touch_analysis)
  "touchdown", "接触次数", "探针接触", "touch count",
  // Tool name prefix (model explicitly naming tools)
  "inf_draw",
  // INF file reference
  "inf_", "inf文件", "INF文件",
  // Interrupt pass specification used in wafer map requests
  "中断段",
];

export function selectToolSchemas(messages: ChatMessage[]): unknown[] {
  // Only inspect user-role messages, not tool results or assistant turns.
  // Tool results often contain strings like "晶圆图已生成" which would perpetually
  // keep INF tools injected after the first wafer-map request, bloating the tool
  // list for every subsequent unrelated query.
  const recentUserMessages = messages
    .filter((m) => m.role === "user")
    .slice(-3);
  const combined = recentUserMessages
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join(" ")
    .toLowerCase();

  const needsInf = INF_KEYWORDS.some((kw) => combined.includes(kw.toLowerCase()));
  return needsInf
    ? ([...TOOL_SCHEMAS, ...INF_TOOL_SCHEMAS] as unknown as unknown[])
    : ([...TOOL_SCHEMAS] as unknown as unknown[]);
}
