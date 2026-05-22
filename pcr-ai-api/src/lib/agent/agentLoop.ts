// pcr-ai-api/src/lib/agent/agentLoop.ts
import type { AgentConfig } from "./agentConfig.js";
import {
  getHistory,
  appendMessages,
  needsSummarization,
  popOldMessagesForSummarization,
  storeSummary,
  getSummary,
  type ChatMessage,
  type ToolCall,
} from "./agentHistory.js";
import { TOOL_SCHEMAS } from "./agentToolSchemas.js";
import { runTool, type ChartSentinel, type ClarificationSentinel } from "./agentToolHandlers.js";
import { buildSystemPrompt } from "./agentPrompt.js";
import { fetchOrCacheManifest } from "./agentManifest.js";
import { streamSiliconFlow, type CollectedToolCall } from "./agentStream.js";

export type AgentSseEvent =
  | { type: "text"; delta: string }
  | { type: "status"; message: string }
  | { type: "tool_start"; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; name: string; summary: string }
  | { type: "chart"; option: object }
  | { type: "clarification"; question: string }
  | { type: "done" }
  | { type: "error"; message: string };
const TOOL_RESULT_MAX_HISTORY = 3000;

// ─── DeepSeek / reasoning stream filter ─────────────────────────────────────
// DeepSeek V3 via SiliconFlow sometimes puts its native function-call tokens
// directly in the content stream rather than in the structured tool_calls field.
// Reasoning models may also embed , <redacted_reasoning>, or
// <think> … </…> inside content (should use reasoning_content, but not always).
// SiliconFlow / DeepSeek may also emit DSML-style tool markup in content:
//   <｜DSML｜tool_calls> … <｜DSML｜invoke name="…"> … </｜DSML｜tool_calls>
// The tokens use both ASCII | and fullwidth ｜ (U+FF5C) and ▁ (U+2581).
//   <｜tool▁sep｜>     — separates function name from args
//   <｜tool▁call▁end｜> — ends a single call
//   <｜tool▁calls▁end｜> — ends the call block
// This filter intercepts the stream, suppresses these tokens from the UI,
// and recovers CollectedToolCall objects for normal execution.

const DS_START_RE = /(?:function)?<[|｜]tool[_▁]/;
const DSML_START_RE = /<[|｜]DSML[|｜]/;
const DSML_CALLS_END_RE = /<\/[|｜]DSML[|｜]tool_calls>/;
const DSML_INVOKE_RE = /<[|｜]DSML[|｜]invoke\s+name="([^"]+)"/i;
const DSML_PARAM_RE =
  /<[|｜]DSML[|｜]parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/[|｜]DSML[|｜]parameter>/gi;
const DS_SEP_RE = /<[|｜]tool[_▁]sep[|｜]>/;
const DS_CALL_END_RE = /<[|｜]tool[_▁]call[_▁]end[|｜]>/;
const DS_CALLS_END_RE = /<[|｜]tool[_▁]calls[_▁]end[|｜]>/g;
const REASONING_OPEN_RE =
  /<(think|redacted_reasoning|redacted_thinking)\b[^>]*>/i;
const REASONING_CLOSE_RE =
  /<\/(think|redacted_reasoning|redacted_thinking)\s*>/i;
/** Keep tail while inside reasoning so a split closing tag is not lost. */
const REASONING_CLOSE_LOOKAHEAD = 32;
/** Drop a trailing partial reasoning / DSML open at stream end. */
const REASONING_PARTIAL_OPEN_TAIL_RE =
  /<(?:\/)?(?:think|redacted_reasoning|redacted_thinking)\b[^>]*$/i;
const DSML_PARTIAL_OPEN_TAIL_RE = /<[|｜]DSML[|｜][^>]*$/i;

interface FilteredEmitter {
  /** Feed a raw text delta from the LLM stream. */
  push(delta: string): void;
  /** Call after streaming ends — flushes buffered text and returns embedded calls. */
  finalize(): CollectedToolCall[];
  /** Clean text accumulated for history recording (no DeepSeek tokens). */
  cleanText: string;
}

function createDeepSeekFilter(
  outerEmit: (event: AgentSseEvent) => void
): FilteredEmitter {
  let pending = "";      // text awaiting token-detection scan
  let inToken = false;   // inside embedded tool / DSML markup
  let tokenKind: "deepseek" | "dsml" = "deepseek";
  let inReasoning = false;
  let tokenBuf = "";     // accumulates token content while inToken
  const calls: CollectedToolCall[] = [];
  let callIdx = 0;
  let cleanText = "";

  const LOOKAHEAD = 32; // ≥ "<｜DSML｜tool_calls>" prefix

  function flushPending(force = false): void {
    if (inToken) return;
    const safeLen = force ? pending.length : Math.max(0, pending.length - LOOKAHEAD);
    if (safeLen > 0) {
      const safe = pending.slice(0, safeLen);
      cleanText += safe;
      outerEmit({ type: "text", delta: safe });
      pending = pending.slice(safeLen);
    }
  }

  function tryExtractFromDsmlBuf(): void {
    const endMatch = DSML_CALLS_END_RE.exec(tokenBuf);
    if (!endMatch) return;

    const block = tokenBuf.slice(0, endMatch.index);
    tokenBuf = tokenBuf.slice(endMatch.index + endMatch[0].length);

    const invokeMatch = DSML_INVOKE_RE.exec(block);
    if (invokeMatch) {
      const fnName = invokeMatch[1];
      const args: Record<string, string> = {};
      let pm: RegExpExecArray | null;
      DSML_PARAM_RE.lastIndex = 0;
      while ((pm = DSML_PARAM_RE.exec(block)) !== null) {
        args[pm[1]] = pm[2].trim();
      }
      calls.push({
        index: callIdx,
        id: `dsml_embedded_${callIdx}`,
        name: fnName,
        args: JSON.stringify(args),
      });
      callIdx++;
    }

    tokenBuf = tokenBuf.trim();
    if (DSML_START_RE.test(tokenBuf.slice(0, 24))) {
      tryExtractFromDsmlBuf();
    } else if (!tokenBuf) {
      inToken = false;
    } else {
      inToken = false;
      pending = tokenBuf;
      tokenBuf = "";
      scanForTokens();
    }
  }

  function tryExtractFromTokenBuf(): void {
    const endMatch = DS_CALL_END_RE.exec(tokenBuf);
    if (!endMatch) return; // token not complete yet

    const callContent = tokenBuf.slice(0, endMatch.index);
    const after = tokenBuf.slice(endMatch.index + endMatch[0].length);

    const sepMatch = DS_SEP_RE.exec(callContent);
    if (sepMatch) {
      const afterSep = callContent.slice(sepMatch.index + sepMatch[0].length);
      const nlIdx = afterSep.indexOf("\n\n");
      if (nlIdx !== -1) {
        const fnName = afterSep.slice(0, nlIdx).trim();
        let args = afterSep.slice(nlIdx + 2).trim();
        // Strip any markdown code fence artifacts
        args = args.replace(/^```[a-z]*\s*/i, "").replace(/\s*```\s*$/m, "").trim();
        if (fnName) {
          calls.push({ index: callIdx, id: `ds_embedded_${callIdx}`, name: fnName, args });
          callIdx++;
        }
      }
    }

    // Strip all-calls-end tokens from remainder
    tokenBuf = after.replace(DS_CALLS_END_RE, "").trim();

    // Check for another call immediately following
    if (DS_START_RE.test(tokenBuf.slice(0, 20))) {
      tryExtractFromTokenBuf();
    } else if (!tokenBuf) {
      inToken = false;
    } else {
      // Unexpected remainder — emit it as text
      inToken = false;
      pending = tokenBuf;
      tokenBuf = "";
      scanForTokens();
    }
  }

  function scanForTokens(): void {
    if (inReasoning) {
      const closeMatch = REASONING_CLOSE_RE.exec(pending);
      if (closeMatch) {
        pending = pending.slice(closeMatch.index + closeMatch[0].length);
        inReasoning = false;
        scanForTokens();
        return;
      }
      if (pending.length > REASONING_CLOSE_LOOKAHEAD) {
        pending = pending.slice(-REASONING_CLOSE_LOOKAHEAD);
      }
      return;
    }

    if (inToken) return;

    const reasoningMatch = REASONING_OPEN_RE.exec(pending);
    const dsmlMatch = DSML_START_RE.exec(pending);
    const dsToolMatch = DS_START_RE.exec(pending);

    let matchIndex = -1;
    let matchKind: "reasoning" | "tool" | null = null;
    if (reasoningMatch) {
      matchIndex = reasoningMatch.index;
      matchKind = "reasoning";
    }
    if (dsmlMatch && (matchKind === null || dsmlMatch.index < matchIndex)) {
      matchIndex = dsmlMatch.index;
      matchKind = "tool";
      tokenKind = "dsml";
    }
    if (
      dsToolMatch &&
      (matchKind === null || dsToolMatch.index < matchIndex)
    ) {
      matchIndex = dsToolMatch.index;
      matchKind = "tool";
      tokenKind = "deepseek";
    }

    if (matchKind === null) {
      flushPending();
      return;
    }

    if (matchIndex > 0) {
      const before = pending.slice(0, matchIndex);
      cleanText += before;
      outerEmit({ type: "text", delta: before });
      pending = pending.slice(matchIndex);
    }

    if (matchKind === "reasoning") {
      const openMatch = REASONING_OPEN_RE.exec(pending);
      if (!openMatch) {
        flushPending();
        return;
      }
      pending = pending.slice(openMatch[0].length);
      inReasoning = true;
      scanForTokens();
      return;
    }

    inToken = true;
    tokenBuf = pending;
    pending = "";
    if (tokenKind === "dsml") tryExtractFromDsmlBuf();
    else tryExtractFromTokenBuf();
  }

  return {
    push(delta: string): void {
      if (inToken) {
        tokenBuf += delta;
        if (tokenKind === "dsml") tryExtractFromDsmlBuf();
        else tryExtractFromTokenBuf();
      } else {
        pending += delta;
        scanForTokens();
      }
    },
    finalize(): CollectedToolCall[] {
      if (inReasoning) {
        pending = "";
        inReasoning = false;
      }
      // Stream ended inside a partial DeepSeek tool token — recover as plain text.
      if (inToken) {
        if (tokenKind === "deepseek" && tokenBuf) {
          pending = tokenBuf;
        }
        tokenBuf = "";
        inToken = false;
        tokenKind = "deepseek";
      }
      pending = pending
        .replace(REASONING_PARTIAL_OPEN_TAIL_RE, "")
        .replace(DSML_PARTIAL_OPEN_TAIL_RE, "");
      flushPending(true);
      return calls;
    },
    get cleanText() { return cleanText; },
  };
}

/**
 * Calls the LLM to produce a compact Chinese summary of the given older
 * conversation turns.  On failure returns an empty string (best-effort).
 */
async function summarizeHistory(
  oldMessages: ChatMessage[],
  agentConfig: AgentConfig
): Promise<string> {
  // Build a text representation — skip raw tool JSON to keep it readable.
  const lines: string[] = [];
  for (const m of oldMessages) {
    if (!m.content || m.role === "tool") continue;
    const label = m.role === "user" ? "用户" : "AI";
    lines.push(`[${label}]: ${String(m.content).slice(0, 600)}`);
  }
  if (lines.length === 0) return "";

  const prompt =
    "请将以下探针卡良率分析系统的历史对话压缩为简洁的中文摘要（不超过300字）。" +
    "重点保留：用户查询的产品/时间/卡号等条件、关键数字结论、已确认的异常发现、当前分析方向。" +
    "禁止使用 Markdown 图片语法。\n\n对话历史：\n" +
    lines.join("\n");

  let summary = "";
  try {
    await streamSiliconFlow(
      { model: agentConfig.model, messages: [{ role: "user", content: prompt }] },
      agentConfig,
      (chunk) => {
        if (chunk.type === "delta") summary += chunk.text;
      }
    );
  } catch {
    // Summarization is best-effort; failure is non-fatal.
  }
  return summary.trim();
}

/** Test helper: run stream deltas through the same UI filter as runAgentLoop. */
export function filterAgentStreamTextForUi(deltas: string[]): string {
  const parts: string[] = [];
  const filter = createDeepSeekFilter((event) => {
    if (event.type === "text") parts.push(event.delta);
  });
  for (const delta of deltas) filter.push(delta);
  filter.finalize();
  return parts.join("");
}

/** True when the last history turn is tool output awaiting a text summary. */
export function historyAwaitingToolSummary(history: ChatMessage[]): boolean {
  return history.length > 0 && history[history.length - 1].role === "tool";
}

const SUMMARIZE_NUDGE =
  "【指令】工具查询已完成，结果已在上方 tool 消息中。请立即用中文给出分析结论与关键数字，禁止再调用任何工具。";

export async function runAgentLoop(
  message: string,
  sessionId: string,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void,
  options?: { resume?: boolean }
): Promise<void> {
  if (!options?.resume) {
    appendMessages(sessionId, { role: "user", content: message });
  }

  // If the history is getting long, compress older turns into a rolling summary.
  if (needsSummarization(sessionId)) {
    const old = popOldMessagesForSummarization(sessionId);
    if (old.length > 0) {
      emit({ type: "status", message: "正在压缩历史对话…" });
      const existing = getSummary(sessionId);
      // Prepend any prior summary text so it is folded in cumulatively.
      const toSummarize: ChatMessage[] = existing
        ? [{ role: "assistant", content: `【已有摘要】\n${existing}` }, ...old]
        : old;
      const newSummary = await summarizeHistory(toSummarize, agentConfig);
      if (newSummary) storeSummary(sessionId, newSummary);
    }
  }

  emit({ type: "status", message: "正在准备系统信息…" });
  // Fetch manifest with a 5-second cap so a slow/unavailable Oracle DB
  // never blocks the agent loop (returns undefined → prompt uses fallback text).
  const manifest = await Promise.race([
    fetchOrCacheManifest(),
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 5000)),
  ]).catch(() => undefined);

  const maxRounds = agentConfig.maxRounds;
  for (let round = 0; round < maxRounds; round++) {
    const history = getHistory(sessionId);
    const summary = getSummary(sessionId);
    const awaitingSummary = historyAwaitingToolSummary(history);

    // Inject nudge into the system prompt for the summary round — avoid a
    // trailing system message after tool turns, which is non-standard and can
    // cause empty responses on some providers (SiliconFlow/DeepSeek).
    const systemContent = awaitingSummary
      ? `${buildSystemPrompt(manifest)}\n\n${SUMMARIZE_NUDGE}`
      : buildSystemPrompt(manifest);

    const messages: ChatMessage[] = [
      { role: "system", content: systemContent },
      ...(summary
        ? [{ role: "system" as const, content: `【历史对话摘要】\n${summary}` }]
        : []),
      ...history,
    ];

    const dsFilter = createDeepSeekFilter(emit);
    const toolCalls: CollectedToolCall[] = [];
    let finishReason = "stop";
    let streamError: string | undefined;

    if (awaitingSummary) {
      emit({ type: "status", message: "正在生成分析结论…" });
    }

    await streamSiliconFlow(
      awaitingSummary
        ? {
            // No tools in summary round — model cannot call them, no tool_choice needed.
            model: agentConfig.model,
            messages,
          }
        : {
            model: agentConfig.model,
            messages,
            tools: TOOL_SCHEMAS as unknown as unknown[],
            tool_choice: "auto",
          },
      agentConfig,
      (chunk) => {
        switch (chunk.type) {
          case "delta":
            // Route through DeepSeek token filter; it handles emit internally.
            dsFilter.push(chunk.text);
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

    // Flush any buffered text and collect any embedded DeepSeek tool calls.
    const embeddedCalls = dsFilter.finalize();
    const textBuffer = dsFilter.cleanText; // clean text (no tokens) for history

    if (embeddedCalls.length > 0 && toolCalls.length === 0) {
      // SiliconFlow returned function calls as text content instead of tool_calls.
      // Recover them so execution continues normally.
      toolCalls.push(...embeddedCalls);
      finishReason = "tool_calls";
    }

    if (streamError) {
      if (textBuffer) {
        appendMessages(sessionId, { role: "assistant", content: textBuffer });
      }
      emit({ type: "error", message: streamError });
      return;
    }

    if (finishReason !== "tool_calls" || toolCalls.length === 0) {
      if (awaitingSummary && !textBuffer.trim()) {
        emit({
          type: "error",
          message:
            "模型未返回分析结论（工具数据已在上方）。请点「重试」，或缩小查询范围后重新提问。",
        });
        return;
      }
      appendMessages(sessionId, { role: "assistant", content: textBuffer });
      emit({ type: "done" });
      return;
    }

    if (awaitingSummary) {
      emit({
        type: "error",
        message:
          "模型在总结阶段仍尝试调用工具。请点「重试」，或拆成更单一的问题（例如只查 Yield 或只查 JB）。",
      });
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
      content: textBuffer || null,
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
      emit({ type: "status", message: `正在执行工具 ${tc.name}…` });

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
        name: tc.name,
        content: historyContent,
      });
    }
    // If agent asked for clarification, stop this round and wait for user reply
    const askedClarification = toolCalls.some((tc) => tc.name === "ask_clarification");
    if (askedClarification) {
      emit({ type: "done" });
      return;
    }
    // Continue to next round — let user know LLM is processing tool results
    emit({ type: "status", message: "正在分析工具结果…" });
  }

  emit({
    type: "error",
    message: `已达到最大推理轮数（${maxRounds}轮），请精简问题后重试，或在设置中提高「最大推理轮数」`,
  });
}
