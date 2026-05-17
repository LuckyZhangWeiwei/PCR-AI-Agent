// pcr-ai-api/src/lib/agent/agentLoop.ts
import type { AgentConfig } from "./agentConfig.js";
import {
  getHistory,
  appendMessages,
  type ChatMessage,
  type ToolCall,
} from "./agentHistory.js";
import { TOOL_SCHEMAS } from "./agentToolSchemas.js";
import { runTool, type ChartSentinel, type ClarificationSentinel } from "./agentToolHandlers.js";
import { buildSystemPrompt } from "./agentPrompt.js";
import { streamSiliconFlow, type CollectedToolCall } from "./agentStream.js";

export type AgentSseEvent =
  | { type: "text"; delta: string }
  | { type: "tool_start"; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; name: string; summary: string }
  | { type: "chart"; option: object }
  | { type: "clarification"; question: string }
  | { type: "done" }
  | { type: "error"; message: string };
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
      { role: "system", content: buildSystemPrompt() },
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
