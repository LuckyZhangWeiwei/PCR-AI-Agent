// pcr-ai-api/src/lib/agent/core/agentEmbeddedToolParsing.ts
// Embedded tool-call parsing + reasoning/DSML stream filter, extracted from agentLoop.ts.
import type { CollectedToolCall } from "./agentStream.js";
import type { AgentSseEvent } from "./agentLoop.js";

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

export interface FilteredEmitter {
  /** Feed a raw text delta from the LLM stream. */
  push(delta: string): void;
  /** Call after streaming ends — flushes buffered text and returns embedded calls. */
  finalize(): CollectedToolCall[];
  /** Clean text accumulated for history recording (no DeepSeek tokens). */
  cleanText: string;
}

export function createDeepSeekFilter(
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
