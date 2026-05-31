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
import { generateChartArgsHaveData } from "./agentChartTool.js";
import { streamSiliconFlow, type CollectedToolCall } from "./agentStream.js";
import { buildFeedbackInjection } from "./agentFeedback.js";
import { buildJbSessionCacheJson } from "./agentJbBinFormat.js";
import {
  compactJbBinsForHistory,
  formatLotYieldOverviewMarkdown,
  formatSlotYieldMarkdownFromToolJson,
} from "./agentJbHistoryCompact.js";
import {
  BRIEF_COMMENTARY_SYSTEM,
  buildBriefCommentaryUserMessage,
  buildDeterministicJbTables,
  buildEngineeringContextFromPayload,
  DETERMINISTIC_TABLES_HEADER,
  parseJbToolPayload,
} from "./agentJbDeterministicReply.js";
import {
  getJbToolRawJson,
  storeJbToolRawJson,
} from "./agentJbSessionCache.js";

export type AgentSseEvent =
  | { type: "text"; delta: string }
  | { type: "status"; message: string }
  | { type: "tool_start"; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; name: string; summary: string }
  | { type: "chart"; option: object }
  | { type: "clarification"; question: string }
  | { type: "done" }
  | { type: "error"; message: string };
// Max chars stored in session history per tool result — intentionally smaller than
// toolResultMaxChars so accumulated history stays manageable across multi-turn sessions.
// runTool always returns a string, so the cap must be applied explicitly (the JSON.stringify
// branch below was dead code before this fix).

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

// MiniMax 2.5 embeds tool calls as <minimax:tool_call>…</minimax:tool_call>
// in the content stream instead of using structured tool_calls.
const MINIMAX_START_RE = /<minimax:tool_call\b/i;
const MINIMAX_END_RE = /<\/minimax:tool_call>/i;
const MINIMAX_INVOKE_RE = /<invoke\s+name="([^"]+)"/i;
const MINIMAX_PARAM_RE =
  /<parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/parameter>/gi;
const MINIMAX_PARTIAL_OPEN_TAIL_RE = /<(?:\/)?minimax:[^>]*$/i;
const INVOKE_STANDALONE_RE = /<invoke\s+name="/i;
const INVOKE_END_RE = /<\/invoke>/i;
/** MiniMax 偶发：仅有 invoke 尾 + 关闭标签，无开头 `<minimax:tool_call>` */
const ORPHAN_INVOKE_ARG_TAIL_RE =
  /(?:^|[\s\S]*?)(?:<invoke[\s\S]*)?(?:[A-Za-z_]\w*\s*:\s*(?:"[^"]*"|\d+)\s*,?\s*)+\}?\s*<\/invoke>\s*<\/minimax:tool_call>\s*$/i;

// GLM 5.x (e.g. zai-org/GLM-5.1 via SiliconFlow) embeds tool calls as:
//   <tool_call>generate_chart<arg_key>chartType</arg_key><arg_value>pie</arg_value>…</tool_call>
// Require a letter/underscore immediately after the tag so that literal `<tool_call>` in
// model prose (code examples, error messages) is not mistaken for an actual tool invocation.
const GLM_TOOL_CALL_START_RE = /<tool_call>[a-zA-Z_]/;
const GLM_TOOL_CALL_END_RE = /<\/tool_call>/i;
const GLM_ARG_KEY_RE = /<arg_key>([\s\S]*?)<\/arg_key>/gi;
const GLM_ARG_VALUE_RE = /<arg_value>([\s\S]*?)<\/arg_value>/gi;
const GLM_PARTIAL_OPEN_TAIL_RE = /<(?:\/)?(?:tool_call|arg_key|arg_value)[^>]*$/i;
const ORPHAN_GLM_TOOL_CALL_TAIL_RE =
  /<tool_call>[\s\S]*?<\/tool_call>\s*$/i;

/** Parse GLM `<tool_call>name<arg_key>…</arg_key><arg_value>…</arg_value>…</tool_call>`. */
export function parseGlmToolCallBody(block: string): {
  name: string;
  args: Record<string, unknown>;
} {
  const inner = block
    .replace(/^<tool_call>/i, "")
    .replace(/<\/tool_call>\s*$/i, "")
    .trim();
  const firstArgKey = inner.search(/<arg_key>/i);
  const name = (
    firstArgKey >= 0 ? inner.slice(0, firstArgKey) : inner.replace(/<[\s\S]*$/, "")
  ).trim();

  // Match each <arg_key>…</arg_key> paired with the <arg_value>…</arg_value> that follows it,
  // avoiding the positional-zip misalignment that occurs when value content contains XML-like tags.
  const args: Record<string, unknown> = {};
  const pairRe = /<arg_key>([\s\S]*?)<\/arg_key>[\s\S]*?<arg_value>([\s\S]*?)<\/arg_value>/gi;
  let km: RegExpExecArray | null;
  while ((km = pairRe.exec(inner)) !== null) {
    const key = km[1].trim();
    if (!key) continue;
    const raw = km[2].trim();
    if (raw.startsWith("{") || raw.startsWith("[")) {
      try {
        args[key] = JSON.parse(raw) as unknown;
        continue;
      } catch {
        /* keep string */
      }
    }
    args[key] = raw;
  }
  return { name, args };
}

function stripOrphanGlmToolMarkupTail(text: string): string {
  if (ORPHAN_GLM_TOOL_CALL_TAIL_RE.test(text)) {
    return text.replace(ORPHAN_GLM_TOOL_CALL_TAIL_RE, "").trimEnd();
  }
  const openIdx = text.lastIndexOf("<tool_call>");
  if (openIdx >= 0 && !GLM_TOOL_CALL_END_RE.test(text.slice(openIdx))) {
    return text.slice(0, openIdx).trimEnd();
  }
  return text;
}

function pushGlmToolCall(
  calls: CollectedToolCall[],
  block: string,
  idx: number
): number {
  const { name, args } = parseGlmToolCallBody(block);
  if (!name) return idx;
  calls.push({
    index: idx,
    id: `glm_embedded_${idx}`,
    name,
    args: JSON.stringify(args),
  });
  return idx + 1;
}

/** Parse `<parameter>` tags or JSON / loose key:value body inside `<invoke>`. */
export function parseMinimaxInvokeBody(block: string): Record<string, string> {
  const args: Record<string, string> = {};
  let pm: RegExpExecArray | null;
  MINIMAX_PARAM_RE.lastIndex = 0;
  while ((pm = MINIMAX_PARAM_RE.exec(block)) !== null) {
    args[pm[1]] = pm[2].trim();
  }
  if (Object.keys(args).length > 0) return args;

  const body = block
    .replace(/^[\s\S]*?<invoke[^>]*>/i, "")
    .replace(/<\/invoke>[\s\S]*$/i, "")
    .trim();
  if (!body) return args;

  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    for (const [k, v] of Object.entries(parsed)) {
      if (v == null) continue;
      args[k] = typeof v === "string" ? v : String(v);
    }
    return args;
  } catch {
    const looseRe = /([A-Za-z_]\w*)\s*:\s*("([^"]*)"|(\d+(?:\.\d+)?))/g;
    let m: RegExpExecArray | null;
    while ((m = looseRe.exec(body)) !== null) {
      args[m[1]] = m[3] ?? m[4] ?? "";
    }
  }
  return args;
}

function stripOrphanToolMarkupTail(text: string): string {
  text = stripOrphanGlmToolMarkupTail(text);
  if (ORPHAN_INVOKE_ARG_TAIL_RE.test(text)) {
    return text.replace(ORPHAN_INVOKE_ARG_TAIL_RE, "").trimEnd();
  }
  const closeIdx = text.lastIndexOf("</minimax:tool_call>");
  if (closeIdx < 0) return text;
  const minimaxOpen = text.lastIndexOf("<minimax:tool_call", closeIdx);
  const invokeOpen = text.lastIndexOf("<invoke", closeIdx);
  const start =
    minimaxOpen >= 0
      ? minimaxOpen
      : invokeOpen >= 0 && invokeOpen < closeIdx
        ? invokeOpen
        : -1;
  if (start >= 0) return text.slice(0, start).trimEnd();
  return text.slice(0, closeIdx).replace(/<\/invoke>\s*$/i, "").trimEnd();
}

function pushMinimaxInvokeCall(
  calls: CollectedToolCall[],
  block: string,
  idx: number
): number {
  const invokeMatch = MINIMAX_INVOKE_RE.exec(block);
  if (!invokeMatch) return idx;
  const args = parseMinimaxInvokeBody(block);
  calls.push({
    index: idx,
    id: `minimax_embedded_${idx}`,
    name: invokeMatch[1],
    args: JSON.stringify(args),
  });
  return idx + 1;
}

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
  let tokenKind: "deepseek" | "dsml" | "minimax" | "glm" = "deepseek";
  let inReasoning = false;
  let tokenBuf = "";     // accumulates token content while inToken
  const calls: CollectedToolCall[] = [];
  let callIdx = 0;
  let cleanText = "";

  const LOOKAHEAD = 32; // ≥ "<｜DSML｜tool_calls>" prefix

  function flushPending(force = false): void {
    if (inToken) return;
    pending = stripOrphanToolMarkupTail(pending);
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

  function tryExtractFromGlmBuf(): void {
    const endMatch = GLM_TOOL_CALL_END_RE.exec(tokenBuf);
    if (!endMatch) return;

    const block = tokenBuf.slice(0, endMatch.index + endMatch[0].length);
    tokenBuf = tokenBuf.slice(endMatch.index + endMatch[0].length).trim();

    callIdx = pushGlmToolCall(calls, block, callIdx);

    if (!tokenBuf) {
      inToken = false;
    } else if (GLM_TOOL_CALL_START_RE.test(tokenBuf.slice(0, 16))) {
      tryExtractFromGlmBuf();
    } else {
      inToken = false;
      pending = tokenBuf;
      tokenBuf = "";
      scanForTokens();
    }
  }

  function tryExtractFromMinimaxBuf(): void {
    const endMatch = MINIMAX_END_RE.exec(tokenBuf);
    if (!endMatch) {
      // MiniMax 有时无外层 minimax:tool_call，仅 </invoke> 闭合
      const invokeEnd = INVOKE_END_RE.exec(tokenBuf);
      if (invokeEnd && INVOKE_STANDALONE_RE.test(tokenBuf)) {
        const block = tokenBuf.slice(0, invokeEnd.index + invokeEnd[0].length);
        tokenBuf = tokenBuf.slice(invokeEnd.index + invokeEnd[0].length).trim();
        callIdx = pushMinimaxInvokeCall(calls, block, callIdx);
        if (!tokenBuf) {
          inToken = false;
        } else {
          scanForTokens();
        }
      }
      return;
    }

    const block = tokenBuf.slice(0, endMatch.index);
    tokenBuf = tokenBuf.slice(endMatch.index + endMatch[0].length).trim();

    callIdx = pushMinimaxInvokeCall(calls, block, callIdx);

    if (!tokenBuf) {
      inToken = false;
    } else if (MINIMAX_START_RE.test(tokenBuf.slice(0, 24))) {
      tryExtractFromMinimaxBuf();
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
    const minimaxMatch = MINIMAX_START_RE.exec(pending);
    const glmMatch = GLM_TOOL_CALL_START_RE.exec(pending);
    const invokeStandaloneMatch = INVOKE_STANDALONE_RE.exec(pending);

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
    if (minimaxMatch && (matchKind === null || minimaxMatch.index < matchIndex)) {
      matchIndex = minimaxMatch.index;
      matchKind = "tool";
      tokenKind = "minimax";
    }
    if (glmMatch && (matchKind === null || glmMatch.index < matchIndex)) {
      matchIndex = glmMatch.index;
      matchKind = "tool";
      tokenKind = "glm";
    }
    if (
      invokeStandaloneMatch &&
      (matchKind === null || invokeStandaloneMatch.index < matchIndex)
    ) {
      matchIndex = invokeStandaloneMatch.index;
      matchKind = "tool";
      tokenKind = "minimax";
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
    else if (tokenKind === "minimax") tryExtractFromMinimaxBuf();
    else if (tokenKind === "glm") tryExtractFromGlmBuf();
    else tryExtractFromTokenBuf();
  }

  return {
    push(delta: string): void {
      if (inToken) {
        tokenBuf += delta;
        if (tokenKind === "dsml") tryExtractFromDsmlBuf();
        else if (tokenKind === "minimax") tryExtractFromMinimaxBuf();
        else if (tokenKind === "glm") tryExtractFromGlmBuf();
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
      // Stream ended mid-token: recover invoke from partial MiniMax buffer when possible.
      if (inToken) {
        if (tokenKind === "minimax" && tokenBuf && INVOKE_STANDALONE_RE.test(tokenBuf)) {
          callIdx = pushMinimaxInvokeCall(calls, tokenBuf, callIdx);
        } else if (tokenKind === "glm" && tokenBuf && GLM_TOOL_CALL_START_RE.test(tokenBuf)) {
          callIdx = pushGlmToolCall(calls, tokenBuf, callIdx);
        } else if (tokenKind === "deepseek" && tokenBuf) {
          pending = tokenBuf;
        }
        tokenBuf = "";
        inToken = false;
        tokenKind = "deepseek";
      }
      pending = pending
        .replace(REASONING_PARTIAL_OPEN_TAIL_RE, "")
        .replace(DSML_PARTIAL_OPEN_TAIL_RE, "")
        .replace(MINIMAX_PARTIAL_OPEN_TAIL_RE, "")
        .replace(GLM_PARTIAL_OPEN_TAIL_RE, "");
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
    "请将以下探针卡良率分析系统的历史对话压缩为简洁的中文摘要（不超过400字）。\n" +
    "【必须保留，不可省略】：\n" +
    "  - 所有出现过的 device 产品代码（如 WA03P02G）\n" +
    "  - 所有出现过的 lot ID（含完整后缀，如 NF12592.1Y）\n" +
    "  - 所有出现过的 slot / wafer 槽位号\n" +
    "  - 所有出现过的探针卡号（如 7747-03）\n" +
    "  - 关键数字结论、已确认的异常发现、当前分析方向\n" +
    "【格式】先列出「查询上下文：device=X, lot=X, slot=X」，再写分析摘要。\n" +
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

function lastToolMessage(history: ChatMessage[]): ChatMessage | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "tool") return history[i];
  }
  return undefined;
}

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

function lastUserMessageText(
  history: ChatMessage[],
  fallback: string
): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === "user" && m.content?.trim()) {
      return String(m.content).trim();
    }
  }
  return fallback.trim();
}

function emitTextInChunks(text: string, emit: (event: AgentSseEvent) => void): void {
  const size = 500;
  for (let i = 0; i < text.length; i += size) {
    emit({ type: "text", delta: text.slice(i, i + size) });
  }
}

/**
 * 总结轮：先 SSE 直出服务端表，再让 LLM 只写 3–8 句解读（不改表中数字）。
 * @returns true 表示已完整结束本轮（调用方应 return）。
 */
async function tryRunDeterministicJbSummary(
  sessionId: string,
  userQuestion: string,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void
): Promise<boolean> {
  const history = getHistory(sessionId);
  const lastTool = lastToolMessage(history);
  if (lastTool?.name !== "query_jb_bins") return false;

  const raw = getJbToolRawJson(sessionId) ?? String(lastTool.content ?? "");
  const payload = parseJbToolPayload(raw);
  if (!payload) return false;

  const tables = buildDeterministicJbTables(userQuestion, payload);
  if (!tables?.trim()) return false;

  const tablesBlock = `${DETERMINISTIC_TABLES_HEADER}\n\n${tables}`;
  emit({ type: "status", message: "正在输出服务端预计算表…" });
  emitTextInChunks(tablesBlock, emit);

  emit({ type: "status", message: "正在生成数据解读与专业建议…" });

  const commFilter = createDeepSeekFilter(emit);
  let streamError: string | undefined;

  await streamSiliconFlow(
    {
      model: agentConfig.model,
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
      tools: TOOL_SCHEMAS as unknown as unknown[],
      tool_choice: "none",
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

  let full = tablesBlock;
  if (commentary && !streamError) {
    full += `\n\n---\n\n${commentary}`;
  } else if (streamError && !commentary) {
    full += `\n\n---\n\n*（解读与专业建议生成失败：${streamError.slice(0, 120)}；请以表格为准。）*`;
  }

  appendMessages(sessionId, { role: "assistant", content: full });
  emit({ type: "done" });
  return true;
}

function chartToolFallbackMessage(toolMsg: ChatMessage): string {
  const c = String(toolMsg.content ?? "");
  if (c.startsWith("[图表已生成]")) {
    return "图表已生成，请查看上方。";
  }
  if (c.startsWith("生成图表失败") || c.startsWith("工具执行失败")) {
    return c;
  }
  return `图表生成未完成：${c.slice(0, 200)}`;
}

function toolResultForHistory(
  toolName: string,
  rawContent: string,
  maxHistoryChars: number,
  toolResultMaxChars?: number
): string {
  if (toolName === "query_jb_bins") {
    const cap = Math.max(maxHistoryChars, toolResultMaxChars ?? 0);
    return compactJbBinsForHistory(rawContent, cap);
  }
  return rawContent.slice(0, maxHistoryChars);
}

function jbBinsYieldFallbackMessage(
  toolMsg: ChatMessage,
  userQuestion: string,
  sessionId: string
): string | null {
  if (toolMsg.name !== "query_jb_bins") return null;
  const raw = getJbToolRawJson(sessionId) ?? String(toolMsg.content ?? "");
  const payload = parseJbToolPayload(raw);
  if (payload) {
    const tables = buildDeterministicJbTables(userQuestion, payload);
    if (tables?.trim()) {
      return `${DETERMINISTIC_TABLES_HEADER}\n\n${tables}`;
    }
    const overview = formatLotYieldOverviewMarkdown(payload);
    if (overview) return `${DETERMINISTIC_TABLES_HEADER}\n\n${overview}`;
  }
  return formatSlotYieldMarkdownFromToolJson(raw);
}

function parseToolCallArgs(tc: CollectedToolCall): Record<string, unknown> {
  const raw = (tc.args || "").trim();
  if (!raw) return {};
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    return o && typeof o === "object" && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}

function toolCallArgsUsable(tc: CollectedToolCall): boolean {
  const o = parseToolCallArgs(tc);
  if (Object.keys(o).length === 0) return false;
  if (tc.name === "generate_chart") return generateChartArgsHaveData(o);
  return true;
}

/** Prefer embedded args when structured streaming left {} or invalid JSON. */
function mergeStructuredWithEmbedded(
  structured: CollectedToolCall[],
  embedded: CollectedToolCall[]
): CollectedToolCall[] {
  if (embedded.length === 0) return structured;
  if (structured.length === 0) return embedded;

  const usedEmbedded = new Set<number>();
  return structured.map((tc, i) => {
    if (toolCallArgsUsable(tc)) return tc;
    let embIdx = embedded.findIndex(
      (e, j) => !usedEmbedded.has(j) && e.name === tc.name && toolCallArgsUsable(e)
    );
    if (embIdx < 0) {
      embIdx = embedded.findIndex(
        (e, j) => !usedEmbedded.has(j) && j === i && toolCallArgsUsable(e)
      );
    }
    if (embIdx < 0) return tc;
    usedEmbedded.add(embIdx);
    const emb = embedded[embIdx];
    return {
      ...tc,
      id: tc.id || emb.id,
      name: tc.name || emb.name,
      args: emb.args,
    };
  });
}

/** True when the last history turn is tool output awaiting a text summary. */
export function historyAwaitingToolSummary(history: ChatMessage[]): boolean {
  return history.length > 0 && history[history.length - 1].role === "tool";
}

const SUMMARIZE_NUDGE =
  "【指令】工具查询已完成。请立即用中文总结，禁止再调工具。须含数据解读与 Wafer Test/Probe Card/DUT 维护专业建议（简短、极度专业）。";

export async function runAgentLoop(
  message: string,
  sessionId: string,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void,
  options?: { resume?: boolean }
): Promise<void> {
  // Fetch relevant feedback examples once per session start (non-blocking on failure).
  const feedbackInjection = await buildFeedbackInjection(message).catch(() => "");

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
    const userQuestion = lastUserMessageText(history, message);

    if (awaitingSummary) {
      const handled = await tryRunDeterministicJbSummary(
        sessionId,
        userQuestion,
        agentConfig,
        emit
      );
      if (handled) return;
    }

    // Inject nudge into the system prompt for the summary round — avoid a
    // trailing system message after tool turns, which is non-standard and can
    // cause empty responses on some providers (SiliconFlow/DeepSeek).
    const basePrompt = buildSystemPrompt(manifest) + feedbackInjection;
    const systemContent = awaitingSummary
      ? `${basePrompt}\n\n${SUMMARIZE_NUDGE}`
      : basePrompt;

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

    // In the summary round, send tool schema with tool_choice:"none" so models
    // that need schema context (MiniMax, GLM…) still understand which tools
    // exist, but the API-level constraint prevents any tool call.
    // Also append an explicit user-role instruction because some models
    // (especially MiniMax via SiliconFlow) under-weight system-only nudges.
    const summaryUserNudge: ChatMessage = {
      role: "user",
      content: "请立即用中文给出上述查询数据的分析结论与关键数字，不要调用任何工具。",
    };
    await streamSiliconFlow(
      awaitingSummary
        ? {
            model: agentConfig.model,
            messages: [...messages, summaryUserNudge],
            tools: TOOL_SCHEMAS as unknown as unknown[],
            tool_choice: "none",
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

    if (embeddedCalls.length > 0 && !awaitingSummary) {
      // SiliconFlow / GLM / MiniMax may put calls in content; structured tool_calls
      // are often {} or truncated JSON — merge usable args from embedded markup.
      if (toolCalls.length === 0) {
        toolCalls.push(...embeddedCalls);
      } else {
        const merged = mergeStructuredWithEmbedded(toolCalls, embeddedCalls);
        toolCalls.length = 0;
        toolCalls.push(...merged);
      }
      finishReason = "tool_calls";
    }

    // ── Summary-round guard ──────────────────────────────────────────────────
    // After data tools run, the model must produce text OR call a conclusion
    // tool (generate_chart / ask_clarification). Data-fetch tools are blocked
    // to prevent infinite loops; conclusion tools are explicitly allowed.
    //
    // Bug A — embedded data-fetch calls: model produced "让我再查一下…" text
    //   + an embedded tool call. Silently emitting that as `done` misleads user.
    // Bug B — structured data-fetch tool_calls: providers sometimes emit these
    //   even without a tool schema, consuming rounds until maxRounds is reached.
    if (awaitingSummary) {
      // generate_chart and ask_clarification are legitimate conclusion steps.
      const isConclusionTool = (name: string) =>
        name === "generate_chart" || name === "ask_clarification";

      // Structured tool_calls: keep only conclusion tools, discard data tools.
      if (toolCalls.length > 0) {
        const kept = toolCalls.filter((tc) => isConclusionTool(tc.name));
        toolCalls.splice(0, toolCalls.length, ...kept);
        if (toolCalls.length > 0) finishReason = "tool_calls";
      }

      // Embedded calls: conclusion tools → merge; data tools → handle below.
      if (embeddedCalls.length > 0) {
        const allowedEmb = embeddedCalls.filter((ec) => isConclusionTool(ec.name));
        const blockedEmb = embeddedCalls.filter((ec) => !isConclusionTool(ec.name));

        if (allowedEmb.length > 0 && toolCalls.length === 0) {
          // generate_chart / ask_clarification embedded → merge and execute.
          toolCalls.push(...allowedEmb);
          finishReason = "tool_calls";
        } else if (blockedEmb.length > 0 && allowedEmb.length === 0) {
          // Data-fetch embedded call in summary round.
          if (!textBuffer.trim()) {
            // No usable text at all → error (model produced nothing).
            emit({
              type: "error",
              message:
                "模型未返回分析结论（工具数据已在上方）。请点「重试」，或缩小查询范围后重新提问。",
            });
            return;
          }
          // Has partial text (e.g. "JB 数据为空，让我换个方式：") → emit it as
          // the answer rather than erroring; the blocked call is discarded.
          // Fall through to the normal text-output path below.
        }
      }
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
        const lastTool = lastToolMessage(getHistory(sessionId));
        if (lastTool?.name === "generate_chart") {
          const note = chartToolFallbackMessage(lastTool);
          appendMessages(sessionId, { role: "assistant", content: note });
          emit({ type: "text", delta: note });
          emit({ type: "done" });
          return;
        }
        const jbFallback =
          lastTool != null
            ? jbBinsYieldFallbackMessage(
                lastTool,
                lastUserMessageText(getHistory(sessionId), message),
                sessionId
              )
            : null;
        if (jbFallback) {
          appendMessages(sessionId, { role: "assistant", content: jbFallback });
          emit({ type: "text", delta: jbFallback });
          emit({ type: "done" });
          return;
        }
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
        const toolResult = await runTool(tc.name, parsedArgs, {
          toolResultMaxChars: agentConfig.toolResultMaxChars,
          history: getHistory(sessionId),
          onJbBinsWrapped: (wrapped) => {
            storeJbToolRawJson(sessionId, buildJbSessionCacheJson(wrapped));
          },
        });
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
          const rawContent =
            typeof toolResult === "string"
              ? toolResult
              : JSON.stringify(toolResult);
          historyContent = toolResultForHistory(
            tc.name,
            rawContent,
            agentConfig.toolResultMaxHistoryChars,
            agentConfig.toolResultMaxChars
          );
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

    // generate_chart: chart is already shown via SSE — GLM often returns empty on the
    // follow-up summary round; skip that round and close with a short confirmation.
    const onlyGenerateChart =
      toolCalls.length > 0 && toolCalls.every((tc) => tc.name === "generate_chart");
    if (onlyGenerateChart) {
      const lastTool = lastToolMessage(getHistory(sessionId));
      if (lastTool?.name === "generate_chart") {
        const note = chartToolFallbackMessage(lastTool);
        appendMessages(sessionId, { role: "assistant", content: note });
        emit({ type: "text", delta: note });
        emit({ type: "done" });
        return;
      }
    }

    // Continue to next round — let user know LLM is processing tool results
    emit({ type: "status", message: "正在分析工具结果…" });
  }

  emit({
    type: "error",
    message: `已达到最大推理轮数（${maxRounds}轮），请精简问题后重试，或在设置中提高「最大推理轮数」`,
  });
}
