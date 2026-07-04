/**
 * 会话导出为 Markdown（问答流水）。
 *
 * 只保留**用户提问**与 **Agent 回答文本**，排除工具调用 / 图表 / 错误 / 澄清等内部信息；
 * 跳过流式未完成与空文本，跳过首次用户提问前的欢迎语。结构与 AiAgentReport 的
 * ChatMessage 解耦——只依赖 { kind, text?, streaming? } 这几个字段。
 */

export type ExportableMessage = {
  kind: string;
  text?: string;
  streaming?: boolean;
  /** chart 消息渲染后的 PNG data URI（由调用方从 ECharts 实例取，视图层解耦）。 */
  imageDataUrl?: string;
};

/** 会话是否有可导出的问答（至少一问一答，答为已完成的非空 Agent 回答或图表）。 */
export function sessionHasExportableContent(messages: ExportableMessage[]): boolean {
  let sawUser = false;
  for (const m of messages) {
    if (m.kind === "user" && (m.text ?? "").trim()) {
      sawUser = true;
    } else if (
      m.kind === "ai" &&
      !m.streaming &&
      (m.text ?? "").trim() &&
      sawUser
    ) {
      return true;
    } else if (m.kind === "chart" && (m.imageDataUrl ?? "").trim() && sawUser) {
      return true;
    }
  }
  return false;
}

/** 生成会话 Markdown：`## 问：…` / `**答：**\n…`，仅问答、无内部信息。 */
export function buildSessionMarkdown(
  messages: ExportableMessage[],
  title = "AI Agent 会话"
): string {
  const lines: string[] = [`# ${title}`, ""];
  let sawUser = false;
  for (const m of messages) {
    if (m.kind === "user") {
      const q = (m.text ?? "").trim();
      if (!q) continue;
      sawUser = true;
      lines.push(`## 问：${q}`, "");
    } else if (m.kind === "ai" && !m.streaming) {
      const a = (m.text ?? "").trim();
      // 跳过欢迎语（首次提问前的 Agent 消息）与空/流式回答
      if (!a || !sawUser) continue;
      lines.push("**答：**", "", a, "");
    } else if (m.kind === "chart") {
      const src = (m.imageDataUrl ?? "").trim();
      // 图表紧随其所属回答之后；无实例 PNG（未渲染/取图失败）则跳过
      if (!src || !sawUser) continue;
      lines.push("**图表：**", "", `![图表](${src})`, "");
    }
  }
  return lines.join("\n").trimEnd() + "\n";
}
