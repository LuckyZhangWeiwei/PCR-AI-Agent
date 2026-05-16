// pcr-ai-api/src/lib/agent/agentLoop.ts
import type { AgentConfig } from "./agentConfig.js";
import {
  getHistory,
  appendMessages,
  type ChatMessage,
  type ToolCall,
} from "./agentHistory.js";
import { TOOL_SCHEMAS, runTool, type ChartSentinel, type ClarificationSentinel } from "./agentTools.js";
import { streamSiliconFlow, type CollectedToolCall } from "./agentStream.js";

export type AgentSseEvent =
  | { type: "text"; delta: string }
  | { type: "tool_start"; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; name: string; summary: string }
  | { type: "chart"; option: object }
  | { type: "clarification"; question: string }
  | { type: "done" }
  | { type: "error"; message: string };

const SYSTEM_PROMPT = `你是 NXP ATTJ WaferTest 数据分析助手。

可用工具：query_yield_triggers, aggregate_yield_triggers, query_jb_bins, aggregate_jb_bins, generate_chart, ask_clarification。

## 决策优先级

面对用户请求时，按以下顺序判断：

1. **澄清优先** — 请求缺少关键信息（设备代码不明、时间范围模糊、批次号未提供等）
   → 调用 ask_clarification 工具，问清楚后再查询
   → 缺少多项信息时，合并为一次 ask_clarification，编号列出所有问题
   → 不要在信息不足时直接查询或猜测参数

2. **规划其次** — 请求明确，但需要 3 步及以上的连续操作
   → 先输出 [PLAN]\\n1. 步骤一\\n2. 步骤二\\n[/PLAN]，等用户确认（"好的"/"确认"/"yes"/"ok"）后再执行
   → 确认前不调用任何数据工具

3. **反思兜底** — 工具执行失败，且换策略有可能成功
   → 在回复中嵌入 [REFLECT]需要换策略：<原因和新策略>[/REFLECT]，最多重试 2 次
   → 超过 2 次直接告知用户失败原因

4. **直接执行** — 请求明确，步骤简单（1~2 步）
   → 直接调用工具完成，无需规划

## 数据规则

- 查到数据后，主动调用 generate_chart 生成合适的图表（bar 适合计数对比，line 适合时序趋势，pie 适合占比）
- 用中文回答，数字结论要具体（给出具体数字）
- 时间范围未指定时，API 默认查最近 1 年数据，无需额外说明
- Yield Monitor 数据来自 YMWEB_YIELDMONITORTRIGGER 表（delta_diff 类型），使用 query_yield_triggers / aggregate_yield_triggers
- JB STAR 数据来自 INFCONTROL ⋈ INFLAYERBINLIST（PASSTYPE=TEST），使用 query_jb_bins / aggregate_jb_bins`;

const MAX_ROUNDS = 5;
const TOOL_RESULT_MAX_HISTORY = 3000;

export async function runAgentLoop(
  message: string,
  sessionId: string,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void
): Promise<void> {
  appendMessages(sessionId, { role: "user", content: message });

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const history = getHistory(sessionId);
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history,
    ];

    let textBuffer = "";
    const toolCalls: CollectedToolCall[] = [];
    let finishReason = "stop";
    let streamError: string | undefined;

    await streamSiliconFlow(
      { model: agentConfig.model, messages, tools: TOOL_SCHEMAS as unknown as unknown[], tool_choice: "auto" },
      agentConfig,
      (chunk) => {
        switch (chunk.type) {
          case "delta":
            textBuffer += chunk.text;
            emit({ type: "text", delta: chunk.text });
            break;
          case "tool_calls":
            toolCalls.push(...chunk.calls);
            break;
          case "finish":
            finishReason = chunk.reason;
            break;
          case "error":
            streamError = chunk.message;
            break;
        }
      }
    );

    if (streamError) {
      if (textBuffer) {
        appendMessages(sessionId, { role: "assistant", content: textBuffer });
      }
      emit({ type: "error", message: streamError });
      return;
    }

    if (finishReason !== "tool_calls" || toolCalls.length === 0) {
      appendMessages(sessionId, { role: "assistant", content: textBuffer });
      emit({ type: "done" });
      return;
    }

    // Record assistant turn with tool_calls
    const assistantToolCalls: ToolCall[] = toolCalls.map((tc) => ({
      id: tc.id || `call_${round}_${tc.index}`,
      type: "function",
      function: { name: tc.name, arguments: tc.args },
    }));
    appendMessages(sessionId, {
      role: "assistant",
      content: null,
      tool_calls: assistantToolCalls,
    });

    // Execute tools sequentially (Oracle pool constraint)
    for (let tcIdx = 0; tcIdx < toolCalls.length; tcIdx++) {
      const tc = toolCalls[tcIdx];
      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = JSON.parse(tc.args || "{}") as Record<string, unknown>;
      } catch {
        parsedArgs = {};
      }

      emit({ type: "tool_start", name: tc.name, args: parsedArgs });

      let historyContent: string;
      try {
        const toolResult = await runTool(tc.name, parsedArgs);
        if (
          typeof toolResult === "object" &&
          toolResult !== null &&
          "__chartOption" in toolResult
        ) {
          emit({ type: "chart", option: (toolResult as ChartSentinel).__chartOption });
          historyContent = "[图表已生成]";
        } else if (
          typeof toolResult === "object" &&
          toolResult !== null &&
          "__clarification" in toolResult
        ) {
          const question = (toolResult as ClarificationSentinel).__clarification;
          emit({ type: "clarification", question });
          historyContent = `[已向用户提问：${question}]`;
        } else {
          historyContent =
            typeof toolResult === "string"
              ? toolResult
              : JSON.stringify(toolResult).slice(0, TOOL_RESULT_MAX_HISTORY);
        }
      } catch (err) {
        historyContent = `工具执行失败: ${err instanceof Error ? err.message : String(err)}`;
      }

      const summary = historyContent.slice(0, 200);
      emit({ type: "tool_result", name: tc.name, summary });

      const callId = assistantToolCalls[tcIdx]?.id ?? `call_${round}_${tc.index}`;
      appendMessages(sessionId, {
        role: "tool",
        tool_call_id: callId,
        content: historyContent,
      });
    }
    // If agent asked for clarification, stop this round and wait for user reply
    const askedClarification = toolCalls.some((tc) => tc.name === "ask_clarification");
    if (askedClarification) {
      emit({ type: "done" });
      return;
    }
    // Continue to next round with tool results in history
  }

  emit({ type: "error", message: `已达到最大推理轮数（${MAX_ROUNDS}轮），请精简问题后重试` });
}
