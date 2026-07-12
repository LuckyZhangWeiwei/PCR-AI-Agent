// pcr-ai-api/src/lib/agent/agentLoop.ts
import type { AgentConfig } from "./agentConfig.js";
import { getConfig } from "../runtimeConfig.js";
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
import { TOOL_SCHEMAS, INF_TOOL_SCHEMAS } from "./agentToolSchemas.js";
import { runTool, type ChartSentinel, type ClarificationSentinel } from "./agentToolHandlers.js";
import { validateAndFixToolArgs } from "./agentToolValidator.js";
import { buildSystemPrompt, classifyIntent } from "./agentPrompt.js";
import { fetchOrCacheManifest } from "./agentManifest.js";
import { buildChartOption, generateChartArgsHaveData, tryParseJsonish } from "./agentChartTool.js";
import { streamSiliconFlow, type CollectedToolCall } from "./agentStream.js";
import { buildFeedbackInjection } from "./agentFeedback.js";
import { detectPendingQuery } from "./agentPendingQuery.js";
import {
  buildFactSheetFromHistory,
  factCheckSummaryText,
  formatFactCheckNote,
} from "./agentFactChecker.js";
import { storeJbQuerySessionCache, jbWrappedIsEmptyQuery } from "./agentJbBinFormat.js";
import {
  compactJbBinsForHistory,
  compactJbCacheForHistory,
  formatLotYieldOverviewMarkdown,
  formatSlotYieldMarkdownFromToolJson,
} from "./agentJbHistoryCompact.js";
import {
  BRIEF_COMMENTARY_SYSTEM,
  buildBriefCommentaryUserMessage,
  buildDeterministicJbTables,
  buildEngineeringContextFromPayload,
  buildAggregateBinRankingMarkdown,
  buildBinCardAggregateMarkdown,
  buildBinDeviceAggregateMarkdown,
  buildBinFocusedLotRankingMarkdown,
  DETERMINISTIC_DATA_SECTION_TITLE,
  DETERMINISTIC_COMMENTARY_SECTION_TITLE,
  stampFirstTestNote,
  extractBinFromUserText,
  extractSlotFromUserText,
  extractYmLotsFromHistory,
  isLotListingQuestion,
  isSingleWaferDieClusterQuestion,
  isCardTypeLevelOverviewQuestion,
  isLotOverviewQuestion,
  isLotDetailListingQuestion,
  isLotYieldRankingQuestion,
  buildLotListingContext,
  inferLotListingPresentation,
  isPerSlotBadBinRankingQuestion,
  isProbeCardQuestion,
  isBinCardAttributionQuestion,
  isTesterMachineQuestion,
  jbReplySkipsCommentaryLlm,
  parseJbToolPayload,
  payloadCoversMultipleLots,
  resolveJbToolPayload,
  shouldAppendUnderperformingDutYield,
  isGoodBinValueQuestion,
  buildGoodBinValueMarkdown,
  isProbeCardTesterPerformanceQuestion,
} from "./agentJbDeterministicReply.js";
import {
  buildLotOverviewQueryArgs,
  canRunLotOverviewDirectRoute,
  getCachedJbPayloadForLot,
  LOT_OVERVIEW_JB_NUDGE,
  lotOverviewNeedsJbRecovery,
} from "./agentJbOverviewRoute.js";
import {
  canRunLotListingDirectRoute,
  lotListingAggregateArgsFromUser,
  lotListingNeedsJbRecovery,
  lotListingQueryArgsFromUser,
} from "./agentJbLotListingRoute.js";
import {
  canRunScopedBadBinDirectRoute,
  scopedBadBinAggregateArgsFromUser,
  scopedBadBinNeedsAggregateRecovery,
} from "./agentJbScopedBadBinRoute.js";
import {
  binLotRankingAggregateArgsFromUser,
  canRunBinLotRankingDirectRoute,
} from "./agentJbBinLotRankingRoute.js";
import {
  canRunMaskScopeDirectRoute,
  maskScopeFilterValuesArgs,
  maskScopeJbQueryArgs,
} from "./agentJbMaskScopeRoute.js";
import {
  buildUnscopedBinClarifyMessage,
  canRunUnscopedBinClarify,
} from "./agentJbUnscopedBinRoute.js";
import {
  canRunUnderperformingDutDirectRoute,
  underperformingDutArgsFromText,
} from "./agentUnderperformingDutRoute.js";
import {
  buildUnderperformingDutScatterOptions,
  formatAllDutsHighlightMarkdown,
} from "./agentUnderperformingDutView.js";
import type { PassUnderperformingDutsResult } from "../lotUnderperformingDuts.js";
import { runLotUnderperformingDuts, buildGoodBinsByPassFromToolPayload } from "../lotUnderperformingDutsResolve.js";
import { buildScopeLabelFromAggregateArgs, findLastToolCallArgs, inferDeviceFromText, inferDeviceFromHistory, inferLotFromHistory, inferRecentMonthsWindow, jbListingScopeLabel, resolveJbListingScope } from "./agentQueryScope.js";
import { deviceBaseMask } from "../deviceMask.js";
import {
  buildInfDrawArgsAfterJbLookup,
  extractLotFromUserText,
  extractLotsFromUserText,
  findJbLotContext,
  infDrawWaferMapArgsComplete,
} from "./agentInfWaferMapTool.js";
import {
  buildDutBinMapArgsFromSession,
  DUT_BIN_MAP_JB_LOOKUP_NUDGE,
  sessionCanDrawDutBinMap,
  userWantsDutBinRelationMap,
} from "./agentDutBinMapRoute.js";
import {
  getJbToolRawJson,
} from "./agentJbSessionCache.js";
import {
  planWaferMapRoute,
  WAFER_MAP_JB_LOOKUP_NUDGE,
  type WaferMapRoutePlan,
} from "./agentWaferMapRoute.js";
import { resolveJbRoute, resolveJbRouteAsync } from "./jbRouteResolver.js";
import { resolveDispatch } from "./agentSemanticDispatchTable.js";
import type { DispatchResult } from "./agentSemanticDispatchTable.js";

export type AgentSseEvent =
  | { type: "text"; delta: string }
  | { type: "status"; message: string }
  | { type: "tool_start"; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; name: string; summary: string }
  | { type: "chart"; option: object }
  | { type: "clarification"; question: string; options?: string[] }
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
      {
        model: agentConfig.subAgentModel, // 历史压缩：低负荷任务，sub-agent 模型即可
        messages: [{ role: "user", content: prompt }],
        max_tokens: 512,  // 400-char summary ≈ 300 tokens; cap avoids silent truncation
      },
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

/** DUT×BIN 关系图：inf_draw_dut_bin_map（非 inf_draw_wafer_map）。 */
async function tryRunDutBinMapDirectRoute(
  sessionId: string,
  userQuestion: string,
  emit: (event: AgentSseEvent) => void
): Promise<boolean> {
  if (!sessionCanDrawDutBinMap(getHistory(sessionId), userQuestion)) {
    return false;
  }

  const history = getHistory(sessionId);
  const drawArgs = buildDutBinMapArgsFromSession(history, userQuestion);

  const missing: string[] = [];
  if (!String(drawArgs["device"] ?? "").trim()) missing.push("device");
  if (!String(drawArgs["lot"] ?? "").trim()) missing.push("lot");
  if (drawArgs["slot"] == null) missing.push("slot");
  if (drawArgs["bin"] == null) missing.push("bin");
  if (missing.length) {
    emit({
      type: "text",
      delta: `无法画 DUT×BIN 关系图：缺少 ${missing.join("、")}。请先查询该 lot/slot 或说明片号。`,
    });
    appendMessages(sessionId, {
      role: "assistant",
      content: `无法画 DUT×BIN 关系图：缺少 ${missing.join("、")}。`,
    });
    emit({ type: "done" });
    return true;
  }

  emit({ type: "status", message: "正在生成 DUT×BIN 关系晶圆图…" });
  emit({ type: "tool_start", name: "inf_draw_dut_bin_map", args: drawArgs });

  try {
    const raw = await runTool("inf_draw_dut_bin_map", drawArgs, { history });
    const content =
      typeof raw === "string" ? raw : JSON.stringify(raw);
    emit({
      type: "tool_result",
      name: "inf_draw_dut_bin_map",
      summary: content.slice(0, 200),
    });
    appendMessages(sessionId, {
      role: "tool",
      name: "inf_draw_dut_bin_map",
      tool_call_id: `dutbin_${Date.now()}`,
      content,
    });
    emitTextInChunks(content, emit);
    appendMessages(sessionId, { role: "assistant", content });
    emit({ type: "done" });
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    emit({ type: "text", delta: `DUT×BIN 关系图生成失败：${msg.slice(0, 300)}` });
    appendMessages(sessionId, {
      role: "assistant",
      content: `DUT×BIN 关系图生成失败：${msg.slice(0, 300)}`,
    });
    emit({ type: "done" });
    return true;
  }
}

/**
 * Summary 轮：inf_site_stats 已完成，直接生成 DUT 良率柱状图，不走 LLM。
 */
async function tryRunDutYieldChartDirectRoute(
  sessionId: string,
  userQuestion: string,
  history: ChatMessage[],
  emit: (event: AgentSseEvent) => void
): Promise<boolean> {
  if (!userWantsDutYieldChart(userQuestion)) return false;
  const lastTool = lastToolMessage(history);
  if (lastTool?.name !== "inf_site_stats") return false;

  const parsed = tryParseJsonish(String(lastTool.content ?? ""));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const sitesRaw = (parsed as Record<string, unknown>).sites;
  if (!Array.isArray(sitesRaw) || sitesRaw.length === 0) return false;

  const sites = sitesRaw as Array<{ site_id: number; yield: number }>;
  const labels = sites.map((s) => `DUT${s.site_id}`);
  const values = sites.map((s) => +(s.yield * 100).toFixed(2));
  const data = { labels, series: [{ name: "良率%", values }] };

  try {
    emit({ type: "status", message: "正在生成DUT良率柱状图…" });
    const option = buildChartOption("bar", "各DUT良率%", data);
    emit({ type: "chart", option });
    const minY = Math.min(...values);
    const maxY = Math.max(...values);
    const content = `[图表已生成] 各DUT良率% 柱状图（${sites.length}个DUT，良率范围 ${minY.toFixed(1)}%–${maxY.toFixed(1)}%）`;
    emitTextInChunks(content, emit);
    appendMessages(sessionId, { role: "assistant", content });
    emit({ type: "done" });
    return true;
  } catch {
    return false;
  }
}

/** 执行 inf_draw_wafer_map 并结束本轮（不经过 LLM / JB 大表）。 */
async function finishWaferMapDraw(
  sessionId: string,
  drawArgs: Record<string, unknown>,
  history: ChatMessage[],
  emit: (event: AgentSseEvent) => void
): Promise<boolean> {
  emit({ type: "status", message: "正在生成晶圆图…" });
  emit({ type: "tool_start", name: "inf_draw_wafer_map", args: drawArgs });

  try {
    const raw = await runTool("inf_draw_wafer_map", drawArgs, { history });
    const content =
      typeof raw === "string" ? raw : JSON.stringify(raw);
    emit({
      type: "tool_result",
      name: "inf_draw_wafer_map",
      summary: content.slice(0, 200),
    });
    const callId = `wafermap_fast_${Date.now()}`;
    appendMessages(sessionId, {
      role: "tool",
      name: "inf_draw_wafer_map",
      tool_call_id: callId,
      content,
    });
    emitTextInChunks(content, emit);
    appendMessages(sessionId, { role: "assistant", content });
    emit({ type: "done" });
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    emit({ type: "text", delta: `晶圆图生成失败：${msg.slice(0, 300)}` });
    appendMessages(sessionId, {
      role: "assistant",
      content: `晶圆图生成失败：${msg.slice(0, 300)}`,
    });
    emit({ type: "done" });
    return true;
  }
}

/** 按 agentWaferMapRoute 计划执行晶圆图（draw / 失败提示）。 */
async function applyWaferMapRoutePlan(
  sessionId: string,
  plan: WaferMapRoutePlan,
  history: ChatMessage[],
  emit: (event: AgentSseEvent) => void
): Promise<boolean> {
  if (!plan.isWaferMapIntent) return false;
  const { action } = plan;
  if (action.kind === "not_applicable" || action.kind === "need_jb_lookup") {
    return false;
  }
  if (action.kind === "draw_failed") {
    emit({ type: "text", delta: action.message });
    appendMessages(sessionId, { role: "assistant", content: action.message });
    emit({ type: "done" });
    return true;
  }
  return finishWaferMapDraw(sessionId, action.args, history, emit);
}

/**
 * 从 streamSiliconFlow 错误消息提取人类可读摘要。
 * 支持 "HTTP 4xx: {json}" 格式（七牛云、SiliconFlow 等）。
 */
function cleanStreamErrorMessage(raw: string): string {
  try {
    const m = raw.match(/^(HTTP \d+):\s*(\{[\s\S]*)/);
    if (m) {
      const prefix = m[1];
      const jsonStr = m[2]!;
      let msg: string | undefined;
      try {
        const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
        const errObj = parsed["error"] as Record<string, unknown> | undefined;
        msg =
          (typeof errObj?.["message"] === "string" ? errObj["message"] : undefined) ??
          (typeof parsed["message"] === "string" ? parsed["message"] : undefined);
      } catch {
        // 截断 JSON：用正则直接提取 message 值
        const mm = jsonStr.match(/"message"\s*:\s*"([^"]+)/);
        if (mm) msg = mm[1];
      }
      if (msg) {
        return `${prefix}: ${msg.slice(0, 80)}${msg.length > 80 ? "…" : ""}`;
      }
    }
  } catch { /* ignore */ }
  return raw.slice(0, 100);
}

/** 直出 JB 服务端表；可选跳过解读 LLM（lot 概况等）。 */
async function emitDeterministicJbTablesReply(
  sessionId: string,
  userQuestion: string,
  payload: Record<string, unknown>,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void,
  options?: { withCommentaryLlm?: boolean }
): Promise<boolean> {
  // 多卡「测试情况对比」统一守卫（P-C 真因收口）：本函数是所有「单 lot/卡确定性表」的唯一出口
  // —— equipment 直连、summary 轮、lot 概况/列表/逐片排名 直连路由均 `return` 本函数。多卡对比
  // 需要跨卡综述，不能在 LLM 前/总结轮直接吐单 lot 缓存表。
  // 在此一处拦截，返回 false 让各调用方放行给 LLM；新增任何走本函数的直连路由都自动受此保护。
  const lastToolName = lastToolMessage(getHistory(sessionId))?.name;
  const cachedLot = typeof payload["lot"] === "string" ? (payload["lot"] as string) : undefined;
  const decision = await resolveJbRouteAsync(
    userQuestion,
    { lastToolName, cachedLot },
    agentConfig,
    undefined,
    getHistory(sessionId),
    payload
  );
  if (decision.isMultiCardCompare) {
    console.warn(
      `[jbDeterministic/multiCardCompareBail] 多卡对比交回 LLM:「${userQuestion.slice(0, 50)}」`
    );
    return false;
  }
  const history = getHistory(sessionId);
  // 多 lot 守卫（与多卡 bail 同收口）：本轮查了多个 lot（turnLots>1），但单 lot 确定性表只取
  // 最后一个 lot——若用户跨 lot 对比，或本句未点名具体 lot（指代/复数，如「把对应的卡和dut都列
  // 出来」），单 lot 表答非所问（见 B4）→ 交回 LLM 用全部 lot 历史作答。direct route 在工具前
  // 运行时 turnLots 为空、不触发；仅 summary 轮（工具后）实际生效，新增的工具后路由自动受护。
  const turnLots = collectQueryJbBinsLotsThisTurn(history);
  if (turnLots.length > 1) {
    const lotNamedInQuestion = Boolean(extractLotFromUserText(userQuestion));
    const canRenderScopedListing =
      decision.mode === "lot_listing" && payloadCoversMultipleLots(payload);
    // lot_yield_ranking 故意 fan-out 多 lot query_jb_bins 再合并 rank，不能 bail
    if (
      decision.mode !== "lot_yield_ranking" &&
      !canRenderScopedListing &&
      (decision.isMultiLotCompare || !lotNamedInQuestion)
    ) {
      console.warn(
        `[jbDeterministic/multiLotBail] 多 lot 场景（${turnLots.length} 个 lot，本句点名 lot=${lotNamedInQuestion}）` +
          `不出单 lot 概况，交回 LLM 用全部 lot 历史作答:「${userQuestion.slice(0, 40)}」`
      );
      return false;
    }
  }
  // 诊断：用户问某个具体 lot 的「详细/测试情况」，但回复所用 payload 是 mask 限量缓存
  // （multiLotYieldScope 且非 lotQueryFullRows）→ 数据残缺（如 20/25 片），却以「详细」出表。
  const lotInQuestion = /[A-Z]{2}\d{4,}\.\d?[A-Z]?\w*/i.exec(userQuestion)?.[0];
  if (
    payload["multiLotYieldScope"] === true &&
    payload["lotQueryFullRows"] !== true &&
    lotInQuestion
  ) {
    console.warn(
      `[jbDeterministic/staleMaskCache] 用户问 lot=${lotInQuestion} 详细，但 payload 为 mask 限量缓存` +
        `（multiLotYieldScope=true, lotQueryFullRows!=true, count=${payload["count"]}, ` +
        `distinctLotCount=${payload["distinctLotCount"]}, primaryLot=${payload["lot"]}）→ ` +
        `本次出表可能基于残缺片数；应先 query_jb_bins(lot:"${lotInQuestion}", limit:200) 取全量再出详细。`
    );
  }
  const listingCtx = {
    ...buildLotListingContext(payload, history),
    scopeLabel: (() => {
      const scope = resolveJbListingScope(userQuestion, history);
      return scope ? jbListingScopeLabel(scope) : undefined;
    })(),
    presentation: inferLotListingPresentation(userQuestion),
  };
  const tables = buildDeterministicJbTables(
    userQuestion,
    payload,
    listingCtx,
    decision.mode
  );
  if (!tables?.trim()) return false;

  const mode = decision.mode;
  const withCommentary =
    options?.withCommentaryLlm ??
    !jbReplySkipsCommentaryLlm(mode);

  const tablesBlock = stampFirstTestNote(`${DETERMINISTIC_DATA_SECTION_TITLE}\n\n${tables}`);
  emit({ type: "status", message: "正在输出服务端预计算表…" });
  emitTextInChunks(tablesBlock, emit);

  // 主分析 / lot 概况场景：topBadBins ≥3 项时自动生成坏 BIN bar chart
  if (mode === "generic" || mode === "lot_overview") {
    tryEmitTopBinBarChart(payload, emit);
    // 探针卡问题：自动追加 DUT 坏 die 总量对比图（失败静默跳过，不阻断主流程）
    await tryEmitCardDutBadDieChart(userQuestion, payload, agentConfig, emit);
  }

  // B 路 best-effort：lot 概况末尾补「各 DUT 良率」高亮表 + 散点图（失败/无数据静默跳过）
  let dutYieldSection = "";
  if (shouldAppendUnderperformingDutYield(userQuestion, mode, payload)) {
    dutYieldSection = await tryAppendUnderperformingDutSection(
      payload,
      emit,
      userQuestion
    );
  }

  if (!withCommentary) {
    // Include ## 分析结论 separator so splitAgentReplyMarkdown always has a clear split point,
    // keeping ### 🔍 警示 / 规律识别 in dataMarkdown (otherwise detachProseAfterMarkdownTables
    // would move the section to commentaryMarkdown where tables are CSS-hidden).
    const tableOnlyNote =
      `\n\n${DETERMINISTIC_COMMENTARY_SECTION_TITLE}\n\n` +
      `*以上为服务端实测表。如需某 BIN 逐片趋势或晶圆图，请继续提问。*`;
    const full = tablesBlock + dutYieldSection + tableOnlyNote;
    emit({ type: "text", delta: tableOnlyNote });
    appendMessages(sessionId, { role: "assistant", content: full });
    emit({ type: "done" });
    return true;
  }

  emit({ type: "status", message: "正在生成数据解读与专业建议…" });
  // 先推送分段标题，避免解读文字与上方表格落在同一 Markdown 块里被 GFM 当成表尾行
  emit({
    type: "text",
    delta: `\n\n${DETERMINISTIC_COMMENTARY_SECTION_TITLE}\n\n`,
  });

  const commFilter = createDeepSeekFilter(emit);
  let streamError: string | undefined;

  await streamSiliconFlow(
    {
      model: agentConfig.subAgentModel, // 表解读：结构化输入/有界输出，sub-agent 模型即可
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
      // No tool schemas: commentary is text-only (数据解读 + 专业建议 ≈ 300-600 tokens)
      max_tokens: 1024,
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

  // 标题已 SSE 流出；若解读为空则 emit fallback，保持用户所见与 history 一致
  let commentaryOrFallback: string;
  if (commentary) {
    commentaryOrFallback = commentary;
  } else {
    commentaryOrFallback = streamError
      ? `*（解读生成失败：${cleanStreamErrorMessage(streamError)}；以上实测数据表为准。）*`
      : `*（模型未返回解读；以上实测数据表为准。）*`;
    emit({ type: "text", delta: commentaryOrFallback });
  }

  const full =
    tablesBlock +
    dutYieldSection +
    `\n\n${DETERMINISTIC_COMMENTARY_SECTION_TITLE}\n\n` +
    commentaryOrFallback;

  appendMessages(sessionId, { role: "assistant", content: full });
  emit({ type: "done" });
  return true;
}

/**
 * 用户提供 lot + slot 但未提供 device 时，自动 query_jb_bins 取 device，再直接画图。
 * 避免让 LLM 反问用户提供 device（LLM 不可靠地遵循 WAFER_MAP_JB_LOOKUP_NUDGE）。
 */
async function tryRunWaferMapWithAutoDeviceLookup(
  sessionId: string,
  userQuestion: string,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void
): Promise<boolean> {
  // lot 必须可以从用户文本或历史 JB 上下文中提取
  const history = getHistory(sessionId);
  const lot =
    extractLotFromUserText(userQuestion) ?? findJbLotContext(history).lot;
  if (!lot) return false;

  // 复用已有缓存：同一 lot 已查过就直接画
  const cached = getCachedJbPayloadForLot(sessionId, lot);
  if (cached) {
    const drawArgs = buildInfDrawArgsAfterJbLookup(cached, history, userQuestion);
    if (!infDrawWaferMapArgsComplete(drawArgs)) {
      const msg =
        "已有 JB 数据，但画晶圆图还需要**片号（slot/waferId）**，如「第5片」或「slot=14」。";
      emitTextInChunks(msg, emit);
      appendMessages(sessionId, { role: "assistant", content: msg });
      emit({ type: "done" });
      return true;
    }
    return finishWaferMapDraw(sessionId, drawArgs, history, emit);
  }

  // 轻量查询：limit:1 只取 device/lot 字段，不需全量数据
  const queryArgs: Record<string, unknown> = { lot, limit: 1 };
  emit({ type: "status", message: `正在查询 ${lot} 的设备信息…` });
  emit({ type: "tool_start", name: "query_jb_bins", args: queryArgs });

  let jbCacheForHistory: string | undefined;
  let payload: Record<string, unknown> | null = null;

  try {
    const toolResult = await runTool("query_jb_bins", queryArgs, {
      toolResultMaxChars: agentConfig.toolResultMaxChars,
      history: getHistory(sessionId),
      onJbBinsWrapped: (wrapped) => {
        jbCacheForHistory = storeJbQuerySessionCache(sessionId, wrapped);
      },
    });
    const rawContent =
      typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult);
    const historyContent = toolResultForHistory(
      "query_jb_bins",
      rawContent,
      agentConfig.toolResultMaxHistoryChars,
      agentConfig.toolResultMaxChars,
      jbCacheForHistory
    );
    emit({ type: "tool_result", name: "query_jb_bins", summary: historyContent.slice(0, 200) });
    appendMessages(sessionId, {
      role: "tool",
      name: "query_jb_bins",
      tool_call_id: `wafermap_device_${Date.now()}`,
      content: historyContent,
    });
    payload =
      (jbCacheForHistory ? parseJbToolPayload(jbCacheForHistory) : null) ??
      resolveJbToolPayload(sessionId, historyContent);
  } catch (e) {
    // 查询失败 → 回退到 LLM 路由
    return false;
  }

  if (!payload) return false;

  const updatedHistory = getHistory(sessionId);
  const drawArgs = buildInfDrawArgsAfterJbLookup(
    payload as Record<string, unknown>,
    updatedHistory,
    userQuestion
  );

  if (!infDrawWaferMapArgsComplete(drawArgs)) {
    // device/lot 已有，通常是缺 slot
    const msg =
      "已查询到设备信息。画晶圆图还需要**片号（slot/waferId）**，如「第5片」或「slot=14」。";
    emitTextInChunks(msg, emit);
    appendMessages(sessionId, { role: "assistant", content: msg });
    emit({ type: "done" });
    return true;
  }

  return finishWaferMapDraw(sessionId, drawArgs, updatedHistory, emit);
}

/**
 * 「DR44117.1Y 整体测试情况」：服务端 query_jb_bins + 表，不走首轮/解读 LLM。
 */
async function tryRunLotOverviewDirectRoute(
  sessionId: string,
  userQuestion: string,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void
): Promise<boolean> {
  if (!canRunLotOverviewDirectRoute(userQuestion)) return false;

  const lot = extractLotFromUserText(userQuestion)!;
  let payload = getCachedJbPayloadForLot(sessionId, lot);

  if (!payload) {
    const queryArgs = buildLotOverviewQueryArgs(lot);
    emit({ type: "status", message: `正在查询 ${lot} JB STAR 数据…` });
    emit({ type: "tool_start", name: "query_jb_bins", args: queryArgs });

    let jbCacheForHistory: string | undefined;
    try {
      const toolResult = await runTool("query_jb_bins", queryArgs, {
        toolResultMaxChars: agentConfig.toolResultMaxChars,
        history: getHistory(sessionId),
        onJbBinsWrapped: (wrapped) => {
          jbCacheForHistory = storeJbQuerySessionCache(sessionId, wrapped);
        },
      });
      const rawContent =
        typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult);
      const historyContent = toolResultForHistory(
        "query_jb_bins",
        rawContent,
        agentConfig.toolResultMaxHistoryChars,
        agentConfig.toolResultMaxChars,
        jbCacheForHistory
      );
      emit({
        type: "tool_result",
        name: "query_jb_bins",
        summary: historyContent.slice(0, 200),
      });
      const callId = `jb_overview_${Date.now()}`;
      appendMessages(sessionId, {
        role: "tool",
        name: "query_jb_bins",
        tool_call_id: callId,
        content: historyContent,
      });
      payload =
        (jbCacheForHistory ? parseJbToolPayload(jbCacheForHistory) : null) ??
        resolveJbToolPayload(sessionId, historyContent);
    } catch (e) {
      const msg = `JB 查询失败: ${e instanceof Error ? e.message : String(e)}`;
      emit({ type: "text", delta: msg });
      appendMessages(sessionId, { role: "assistant", content: msg });
      emit({ type: "done" });
      return true;
    }
  }

  if (!payload) {
    const err = `已查询 ${lot}，但无法生成概况表。请点「重试」或缩小时间范围。`;
    emit({ type: "text", delta: err });
    appendMessages(sessionId, { role: "assistant", content: err });
    emit({ type: "done" });
    return true;
  }

  return emitDeterministicJbTablesReply(
    sessionId,
    userQuestion,
    payload,
    agentConfig,
    emit
  );
}

/**
 * 「P11C 最近的测试情况」等 mask/device 级概况：get_filter_values + query_jb_bins + 服务端表，
 * 不经过 LLM（Pass C invalid apiKey 降级）。
 */
async function tryRunMaskScopeDirectRoute(
  sessionId: string,
  userQuestion: string,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void
): Promise<boolean> {
  const history = getHistory(sessionId);
  if (!canRunMaskScopeDirectRoute(userQuestion, history)) return false;

  const fvArgs = maskScopeFilterValuesArgs(userQuestion);
  if (fvArgs) {
    emit({ type: "status", message: "正在查询 mask 对应 device…" });
    emit({ type: "tool_start", name: "get_filter_values", args: fvArgs });
    try {
      const fvResult = await runTool("get_filter_values", fvArgs, {
        toolResultMaxChars: agentConfig.toolResultMaxChars,
        history,
      });
      const fvRaw =
        typeof fvResult === "string" ? fvResult : JSON.stringify(fvResult);
      emit({
        type: "tool_result",
        name: "get_filter_values",
        summary: fvRaw.slice(0, 200),
      });
      appendMessages(sessionId, {
        role: "tool",
        name: "get_filter_values",
        tool_call_id: `mask_fv_${Date.now()}`,
        content: fvRaw.slice(0, agentConfig.toolResultMaxChars ?? 12000),
      });
    } catch {
      // filter 失败不阻断 — 继续 query_jb_bins
    }
  }

  const queryArgs = maskScopeJbQueryArgs(userQuestion, history);
  if (!queryArgs) return false;

  emit({ type: "status", message: "正在查询 JB STAR 数据…" });
  emit({ type: "tool_start", name: "query_jb_bins", args: queryArgs });

  let payload: Record<string, unknown> | null = null;
  try {
    let jbCacheForHistory: string | undefined;
    const toolResult = await runTool("query_jb_bins", queryArgs, {
      toolResultMaxChars: agentConfig.toolResultMaxChars,
      history,
      onJbBinsWrapped: (wrapped) => {
        jbCacheForHistory = storeJbQuerySessionCache(sessionId, wrapped);
      },
    });
    const rawContent =
      typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult);
    const historyContent = toolResultForHistory(
      "query_jb_bins",
      rawContent,
      agentConfig.toolResultMaxHistoryChars,
      agentConfig.toolResultMaxChars,
      jbCacheForHistory
    );
    emit({
      type: "tool_result",
      name: "query_jb_bins",
      summary: historyContent.slice(0, 200),
    });
    appendMessages(sessionId, {
      role: "tool",
      name: "query_jb_bins",
      tool_call_id: `mask_scope_${Date.now()}`,
      content: historyContent,
    });
    payload =
      (jbCacheForHistory ? parseJbToolPayload(jbCacheForHistory) : null) ??
      resolveJbToolPayload(sessionId, historyContent);
  } catch {
    return false;
  }

  if (!payload || jbWrappedIsEmptyQuery(payload)) return false;

  return emitDeterministicJbTablesReply(
    sessionId,
    userQuestion,
    payload,
    agentConfig,
    emit,
    { withCommentaryLlm: false }
  );
}

/**
 * 「WA01P14E 在 b3uflex24 近 3 个月所有 lot 列出来」：直连 query_jb_bins + lot 表，
 * 不经过首轮 LLM（避免 get_filter_values 空结果后误判无机台）。
 */
async function tryRunLotListingDirectRoute(
  sessionId: string,
  userQuestion: string,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void
): Promise<boolean> {
  if (!canRunLotListingDirectRoute(userQuestion, getHistory(sessionId))) return false;

  const queryArgs = lotListingQueryArgsFromUser(userQuestion, getHistory(sessionId));
  if (!queryArgs) return false;

  emit({ type: "status", message: "正在查询 JB STAR lot 列表…" });
  emit({ type: "tool_start", name: "query_jb_bins", args: queryArgs });

  let jbCacheForHistory: string | undefined;
  let payload: Record<string, unknown> | null = null;
  try {
    const toolResult = await runTool("query_jb_bins", queryArgs, {
      toolResultMaxChars: agentConfig.toolResultMaxChars,
      history: getHistory(sessionId),
      onJbBinsWrapped: (wrapped) => {
        jbCacheForHistory = storeJbQuerySessionCache(sessionId, wrapped);
      },
    });
    const rawContent =
      typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult);
    const historyContent = toolResultForHistory(
      "query_jb_bins",
      rawContent,
      agentConfig.toolResultMaxHistoryChars,
      agentConfig.toolResultMaxChars,
      jbCacheForHistory
    );
    emit({
      type: "tool_result",
      name: "query_jb_bins",
      summary: historyContent.slice(0, 200),
    });
    appendMessages(sessionId, {
      role: "tool",
      name: "query_jb_bins",
      tool_call_id: `jb_lot_list_${Date.now()}`,
      content: historyContent,
    });
    payload =
      (jbCacheForHistory ? parseJbToolPayload(jbCacheForHistory) : null) ??
      resolveJbToolPayload(sessionId, historyContent);
  } catch (e) {
    const msg = `JB lot 列表查询失败: ${e instanceof Error ? e.message : String(e)}`;
    emit({ type: "text", delta: msg });
    appendMessages(sessionId, { role: "assistant", content: msg });
    emit({ type: "done" });
    return true;
  }

  if (!payload || jbWrappedIsEmptyQuery(payload)) {
    const err = "JB STAR 未查到匹配 lot；请确认 device / 机台 / 时间范围。";
    emit({ type: "text", delta: err });
    appendMessages(sessionId, { role: "assistant", content: err });
    emit({ type: "done" });
    return true;
  }

  if (isLotDetailListingQuestion(userQuestion)) {
    const aggArgs = lotListingAggregateArgsFromUser(
      userQuestion,
      getHistory(sessionId),
      payload
    );
    if (aggArgs) {
      emit({ type: "status", message: "正在按 lot 聚合 JB 坏 BIN…" });
      emit({ type: "tool_start", name: "aggregate_jb_bins", args: aggArgs });
      try {
        const aggResult = await runTool("aggregate_jb_bins", aggArgs, {
          toolResultMaxChars: agentConfig.toolResultMaxChars,
          history: getHistory(sessionId),
        });
        const aggRaw =
          typeof aggResult === "string" ? aggResult : JSON.stringify(aggResult);
        emit({
          type: "tool_result",
          name: "aggregate_jb_bins",
          summary: aggRaw.slice(0, 200),
        });
        appendMessages(sessionId, {
          role: "tool",
          name: "aggregate_jb_bins",
          tool_call_id: `jb_lot_agg_${Date.now()}`,
          content: aggRaw.slice(0, agentConfig.toolResultMaxChars),
        });
      } catch {
        // 列表仍可输出，仅缺 per-lot fail bin 列
      }
    }
  }

  return emitDeterministicJbTablesReply(
    sessionId,
    userQuestion,
    payload,
    agentConfig,
    emit,
    { withCommentaryLlm: false }
  );
}

/**
 * 「WA01P14E @ b3uflex24 近3个月主要 failed bin」：直连 aggregate_jb_bins(groupBy:bin)，
 * 禁止回退 session 单 lot 概况。
 */
async function tryRunScopedBadBinDirectRoute(
  sessionId: string,
  userQuestion: string,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void
): Promise<boolean> {
  const history = getHistory(sessionId);
  if (!canRunScopedBadBinDirectRoute(userQuestion, history)) return false;

  const aggArgs = scopedBadBinAggregateArgsFromUser(userQuestion, history);
  if (!aggArgs) return false;

  emit({ type: "status", message: "正在聚合 JB 坏 BIN 排行…" });
  emit({ type: "tool_start", name: "aggregate_jb_bins", args: aggArgs });

  let aggRaw = "";
  try {
    const aggResult = await runTool("aggregate_jb_bins", aggArgs, {
      toolResultMaxChars: agentConfig.toolResultMaxChars,
      history,
    });
    aggRaw = typeof aggResult === "string" ? aggResult : JSON.stringify(aggResult);
    emit({
      type: "tool_result",
      name: "aggregate_jb_bins",
      summary: aggRaw.slice(0, 200),
    });
    appendMessages(sessionId, {
      role: "tool",
      name: "aggregate_jb_bins",
      tool_call_id: `jb_scoped_bin_${Date.now()}`,
      content: aggRaw.slice(0, agentConfig.toolResultMaxChars),
    });
  } catch (e) {
    const msg = `JB 坏 BIN 聚合失败: ${e instanceof Error ? e.message : String(e)}`;
    emit({ type: "text", delta: msg });
    appendMessages(sessionId, { role: "assistant", content: msg });
    emit({ type: "done" });
    return true;
  }

  const scopeLabel = buildScopeLabelFromAggregateArgs(aggArgs);
  const table = buildAggregateBinRankingMarkdown(aggRaw, scopeLabel);
  if (!table?.trim()) {
    const err = `JB STAR 在 ${scopeLabel} 未聚合到坏 BIN 数据；请确认 device / 机台 / 时间范围。`;
    emit({ type: "text", delta: err });
    appendMessages(sessionId, { role: "assistant", content: err });
    emit({ type: "done" });
    return true;
  }

  const msg = stampFirstTestNote(
    `${DETERMINISTIC_DATA_SECTION_TITLE}\n\n${table}\n\n` +
      `${DETERMINISTIC_COMMENTARY_SECTION_TITLE}\n\n` +
      `*以上为 ${scopeLabel} 范围内坏 BIN 按 dieCount 降序汇总。如需某 lot 逐片趋势，请指定批次号。*`
  );
  emit({ type: "status", message: "正在输出坏 BIN 排行表…" });
  emitTextInChunks(msg, emit);
  appendMessages(sessionId, { role: "assistant", content: msg });
  emit({ type: "done" });
  return true;
}

/**
 * 「哪个 lot BIN40 最多」：直连 aggregate_jb_bins(groupBy:"bin,lot") + 指定 BIN 的 lot 排行（P-D）。
 */
async function tryRunBinLotRankingDirectRoute(
  sessionId: string,
  userQuestion: string,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void
): Promise<boolean> {
  const history = getHistory(sessionId);
  if (!canRunBinLotRankingDirectRoute(userQuestion, history)) return false;

  const aggArgs = binLotRankingAggregateArgsFromUser(userQuestion, history);
  if (!aggArgs) return false;

  emit({ type: "status", message: "正在聚合 BIN×lot 排行…" });
  emit({ type: "tool_start", name: "aggregate_jb_bins", args: aggArgs });

  let aggRaw = "";
  try {
    const aggResult = await runTool("aggregate_jb_bins", aggArgs, {
      toolResultMaxChars: agentConfig.toolResultMaxChars,
      history,
    });
    aggRaw = typeof aggResult === "string" ? aggResult : JSON.stringify(aggResult);
    emit({
      type: "tool_result",
      name: "aggregate_jb_bins",
      summary: aggRaw.slice(0, 200),
    });
    appendMessages(sessionId, {
      role: "tool",
      name: "aggregate_jb_bins",
      tool_call_id: `jb_bin_lot_${Date.now()}`,
      content: aggRaw.slice(0, agentConfig.toolResultMaxChars),
    });
  } catch (e) {
    const msg = `BIN×lot 聚合失败: ${e instanceof Error ? e.message : String(e)}`;
    emit({ type: "text", delta: msg });
    appendMessages(sessionId, { role: "assistant", content: msg });
    emit({ type: "done" });
    return true;
  }

  const scopeLabel = buildScopeLabelFromAggregateArgs(aggArgs);
  const rendered = renderAggregateJbBinsResult(aggRaw, userQuestion, scopeLabel);
  if (!rendered?.table?.trim()) return false;

  const block = stampFirstTestNote(
    `${DETERMINISTIC_DATA_SECTION_TITLE}\n\n${rendered.table}\n\n` +
      `${DETERMINISTIC_COMMENTARY_SECTION_TITLE}\n\n${rendered.commentaryNote}`
  );
  emit({ type: "status", message: rendered.statusMessage || "正在输出 BIN×lot 排行…" });
  emitTextInChunks(block, emit);
  appendMessages(sessionId, { role: "assistant", content: block });
  emit({ type: "done" });
  return true;
}

/**
 * 用户是否在问 lot 级 DUT×BIN 集中度（DUT/触点/探针 级，非卡级归因）。
 * - DUT 级意图（dut/触点/探针）→ P-F（query_lot_dut_bin_agg 单 lot DUT 集中度），
 *   即便同时问"哪张卡"也以 DUT 集中度作答（如 P-F 的
 *   "哪个卡 哪个dut 测试出的 bin79 最多"）。
 * - 纯卡级归因（"BINnn 集中在哪张卡"，无 dut）→ 让给 bin_card_attribution 语义派发
 *   （aggregate_jb_bins groupBy:bin,cardId），勿被 P-F 用 history primary lot 抢成
 *   单 lot DUT 集中度（A1-2 误路由根因）。
 */
export function isDutBinConcentrationQuestion(text: string): boolean {
  const focusBin = extractBinFromUserText(text);
  if (focusBin == null) return false;
  if (/(dut|触点|探针)/i.test(text)) return true;
  if (/(卡|card)/i.test(text)) return !isBinCardAttributionQuestion(text);
  return false;
}

/**
 * 「哪个卡/哪个 DUT 测出 BIN79 最多」：首轮直连 query_lot_dut_bin_agg（P-F）。
 */
async function tryRunDutBinAggDirectRoute(
  sessionId: string,
  userQuestion: string,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void
): Promise<boolean> {
  if (!isDutBinConcentrationQuestion(userQuestion)) return false;

  const focusBin = extractBinFromUserText(userQuestion)!;
  const history = getHistory(sessionId);
  const lot =
    extractLotFromUserText(userQuestion) || inferLotFromHistory(history);
  if (!lot) return false;

  let device = "";
  const cached = getCachedJbPayloadForLot(sessionId, lot);
  if (cached) {
    device = String(cached["device"] ?? "").trim();
  }
  if (!device) {
    const jbArgs = findLastToolCallArgs(history, "query_jb_bins");
    device = String(jbArgs?.["device"] ?? "").trim();
  }
  if (!device) return false;

  const queryArgs: Record<string, unknown> = { device, lot, passId: 1, focusBin };
  emit({ type: "status", message: `正在查询 ${lot} DUT×BIN${focusBin} 聚合…` });
  emit({ type: "tool_start", name: "query_lot_dut_bin_agg", args: queryArgs });

  let rawContent: string;
  try {
    const toolResult = await runTool("query_lot_dut_bin_agg", queryArgs, {
      toolResultMaxChars: agentConfig.toolResultMaxChars,
      history,
    });
    rawContent = typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult);
  } catch {
    return false;
  }

  emit({ type: "tool_result", name: "query_lot_dut_bin_agg", summary: rawContent.slice(0, 200) });
  appendMessages(sessionId, {
    role: "tool",
    name: "query_lot_dut_bin_agg",
    tool_call_id: `dut_bin_direct_${Date.now()}`,
    content: rawContent.slice(0, agentConfig.toolResultMaxChars),
  });

  if (!/坏 die 的 DUT 集中度/.test(rawContent)) return false;

  const tablesBlock = stampFirstTestNote(`${DETERMINISTIC_DATA_SECTION_TITLE}\n\n${rawContent}`);
  emitTextInChunks(tablesBlock, emit);
  tryEmitDutBinBarChart(rawContent, focusBin, emit);
  appendMessages(sessionId, { role: "assistant", content: tablesBlock });
  emit({ type: "done" });
  return true;
}

/** 用户是否在请求 DUT 良率柱状图/分布图（需 inf_site_stats + generate_chart bar）。 */
function userWantsDutYieldChart(text: string): boolean {
  if (!/(dut|site)/i.test(text)) return false;
  if (!/(yield|良率)/i.test(text)) return false;
  return /(柱|图|chart|bar|分布)/i.test(text);
}

/** 用户是否在问 touchdown（探针接触次数）。 */
function isTouchdownQuestion(text: string): boolean {
  return /touchdown|接触次数|探针接触|touch\s*count/i.test(text);
}

const DUT_YIELD_CHART_NUDGE =
  "用户需要各 DUT 良率柱状图（yield bar chart per DUT/site）。请按以下固定步骤：\n" +
  "1. 调用 `inf_site_stats(device, lot, slot)` 取 per-DUT 良率数据（device/lot/slot 来自历史 query_jb_bins 结果）\n" +
  "2. 收到结果后，调用 `generate_chart(chartType=\"bar\", title=\"各DUT良率%\", data={labels:[\"DUT1\",\"DUT2\",...], series:[{name:\"良率%\",values:[yield%,...]}]})`\n" +
  "   - yield 字段为 0–1 小数，乘以 100 换算为百分比；labels 用 DUT{site_id} 格式\n" +
  "**禁止调用 `inf_draw_wafer_map`**（那是 die 坐标空间图，无法展示每 DUT 良率统计柱状）。";

/**
 * 首轮（非 awaitingSummary）用户问题里能否识别出 device / lot / cardId 之一。
 * 用于事后检测「模型只说了要查、却没真正调用工具」——若问题里有明确实体，
 * 正常应该立即触发工具调用（见 agentPrompt.ts 硬规则），没调用大概率是模型违反了该规则。
 */
export function questionHasIdentifiableToolScope(userQuestion: string): boolean {
  return (
    Boolean(extractLotFromUserText(userQuestion)) ||
    Boolean(inferDeviceFromText(userQuestion)) ||
    isCardProbeTestQuestion(userQuestion)
  );
}

/**
 * 模型在首轮只承诺"马上查"却没有真正调用任何工具时的纠正提示（一轮内最多用一次）。
 * 与 agentPrompt.ts:208/259 的硬规则同义，用代码兜底——避免完全依赖模型遵守文字规则。
 */
const ANNOUNCEMENT_WITHOUT_ACTION_NUDGE =
  "你上一条回复只说明了要查询（如「马上查」「现在查询」之类），但没有真正调用任何工具。" +
  "现在必须**立即调用工具**取数，禁止再输出任何计划性/确认性文字。";

/**
 * 判断用户是否在询问 BIN 对应的测试项（BIN→test item 映射）。
 * 该信息存储在测试程序（test program）中，不在 JB STAR / Yield Monitor 数据库里。
 * 必须同时满足：提到 BIN 编号 AND 问的是测试项/测试内容。
 */
function isTestItemMappingQuestion(text: string): boolean {
  if (!/\bbin\s*\d{1,3}\b/i.test(text)) return false;
  return /测试项|test\s*item|什么测试|哪个测试项|哪种测试|测试内容|测试名称|失效.*测试|测试.*失效|bin.*是什么测试/i.test(text);
}

/**
 * 判断用户是否在请求跨批次/多 lot/时间范围的新数据查询。
 * 此类问题不能用 session 缓存（单批次数据）直接作答。
 */
export function requiresNewDataQuery(text: string): boolean {
  // 跨 tester / 机台 比较
  if (/不同.*(tester|机台|测试机)/i.test(text)) return true;
  // 多批次列表
  if (/(各批次|所有批次|多批次|批次.*列表|列表.*批次)/i.test(text)) return true;
  // 时间范围 + 批次
  if (/(三周|一个月|两个月|三个月|过去\s*\d+\s*(天|周|月)|最近\s*\d+\s*(天|周|月)).*(批次|lot)/i.test(text)) return true;
  // 消息中含 2 个以上明确的 lot ID（如 DR45487.1K、DR45246.1N...）
  const lots = text.match(/\b[A-Z]{2}\d{5}\.\d[A-Z]\b/g) ?? [];
  if (lots.length >= 2) return true;
  return false;
}

const QUESTION_MASK_TOKEN_RE = /\b([A-Z]\d{2}[A-Z])\b/g;
const QUESTION_LOT_TOKEN_RE = /\b[A-Z]{2}\d{4,5}\.\d[A-Z]?\w*/g;

/**
 * 缓存 JB payload 的产品/批次是否与当前问题不一致——一致才允许直接吐缓存 equipment 表。
 * 返回不一致原因（用于日志），一致返回 null。
 * 防止「N55Z bin35 哪张卡」被上一题 P11C 的 TR21697.1K 缓存张冠李戴回答。
 */
export function cachedJbScopeMismatchReason(
  payload: Record<string, unknown>,
  userQuestion: string
): string | null {
  const q = userQuestion.toUpperCase();
  const device = String(payload["device"] ?? "").trim();
  const payloadMask = deviceBaseMask(device); // 缓存产品 mask（device base 末 4 位）

  // 问题里出现的 mask token 与缓存产品 mask 不一致
  if (payloadMask) {
    for (const m of q.matchAll(QUESTION_MASK_TOKEN_RE)) {
      if (m[1] && m[1] !== payloadMask) {
        return `问题含 mask=${m[1]}，与缓存产品 mask=${payloadMask}（device=${device}）不一致`;
      }
    }
  }

  // 问题里出现的 lot 与缓存 lot（primary + recentLotsByTestEnd）都不匹配
  const cachedLots = new Set<string>();
  const primaryLot = String(payload["lot"] ?? "").trim().toUpperCase();
  if (primaryLot) cachedLots.add(primaryLot);
  const recent = payload["recentLotsByTestEnd"];
  if (Array.isArray(recent)) {
    for (const r of recent) {
      const l = String((r as Record<string, unknown>)?.["lot"] ?? "").trim().toUpperCase();
      if (l) cachedLots.add(l);
    }
  }
  const lotsInQ = [...q.matchAll(QUESTION_LOT_TOKEN_RE)].map((m) => m[0]);
  if (lotsInQ.length > 0 && cachedLots.size > 0 && !lotsInQ.some((l) => cachedLots.has(l))) {
    return `问题含 lot=${lotsInQ.join(",")}，与缓存 lot=${[...cachedLots].join(",")} 不一致`;
  }
  return null;
}

/** 跨多 lot 的「哪个/分析」类问题：缓存只含单批，不能代表整组，禁用 equipment 直连。 */
export function equipmentRouteCrossLotBail(text: string): boolean {
  if (/\d+\s*个\s*(lot|批次)/i.test(text)) return true;
  if (/(请分析|分析).*(哪个|哪些|哪几)/i.test(text)) return true;
  if (/(哪个|哪些).*(lot|批次).*(有关|相关|问题|可能|异常)/i.test(text)) return true;
  return false;
}

export { equipmentRouteDutLevelBail } from "./agentJbDeterministicReply.js";

/**
 * 探针卡 / 机台 直连路由：用户追问 "probecard是什么" 等时，直接从 session 缓存输出
 * equipment 表，不走 LLM，避免 LLM 用历史上下文把上一轮的 lot 总览表重复输出一次。
 * 注意：跨批次/时间范围/多 lot 查询不适用，此时 session 缓存仅含单批次数据。
 */
async function tryRunEquipmentDirectRoute(
  sessionId: string,
  userQuestion: string,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void
): Promise<boolean> {
  if (!isProbeCardQuestion(userQuestion) && !isTesterMachineQuestion(userQuestion)) {
    return false;
  }
  if (requiresNewDataQuery(userQuestion)) return false;
  // lot 良率排行需跨 lot 聚合，session 单批 equipment 缓存不能代答（A1-4）。
  if (isLotYieldRankingQuestion(userQuestion)) return false;
  // "包含机台/增加机台" 是对综合列表的补充修饰词，不是独立的机台查询——
  // 此时用户想要的是 bin fail 全量列表 + 机台号，不能只输出设备表，否则会反复输出同一段短表。
  if (/(增加|加上|包含|含).*机台|机台.*列表|列表.*机台/.test(userQuestion)) return false;
  // 「BIN X 集中在哪张卡」需跨卡聚合（aggregate_jb_bins groupBy:bin,cardId），不能吐缓存 equipment 表
  if (isBinCardAttributionQuestion(userQuestion)) {
    console.warn(
      `[equipmentRoute/skip:binOnCard] BIN-on-card 归因需 aggregate_jb_bins(groupBy:"bin,cardId")，` +
        `不吐缓存 equipment 表：「${userQuestion.slice(0, 50)}」`
    );
    return false;
  }
  // 问到 DUT 级归属（如「把对应的卡和 dut 都列出来」）：equipment 缓存表只有卡号 + 机台，
  // **没有 DUT 数据**（DUT 归属需 query_lot_dut_bin_agg）→ 用缓存只能出残缺答案（见 B4）。
  // bail 交回 LLM，由其调 query_lot_dut_bin_agg 补全 DUT。
  if (resolveJbRoute(userQuestion).isDutLevel) {
    console.warn(
      `[equipmentRoute/skip:dutLevel] DUT 级归属 equipment 缓存无此数据，交回 LLM：「${userQuestion.slice(0, 50)}」`
    );
    return false;
  }
  // 多卡「测试情况对比」的 bail 已收口到 emitDeterministicJbTablesReply 入口（统一守卫），
  // 此处不再单独拦截——本路由末尾 `return emitDeterministicJbTablesReply(...)` 会被该守卫放行。
  // 跨多 lot 的分析/选择问题：缓存仅单批，无法回答「哪个 lot 和卡/DUT 有关」
  if (equipmentRouteCrossLotBail(userQuestion)) {
    console.warn(
      `[equipmentRoute/skip:crossLot] 跨多 lot 分析问题不能用单批缓存作答：「${userQuestion.slice(0, 50)}」`
    );
    return false;
  }
  const payload = resolveJbToolPayload(sessionId);
  if (!payload) return false;
  // 缓存产品/批次与问题不一致 → 拒绝吐陈旧缓存（避免 N55Z 问题被 P11C 缓存张冠李戴）
  const mismatch = cachedJbScopeMismatchReason(payload, userQuestion);
  if (mismatch) {
    console.warn(
      `[equipmentRoute/skip:staleCacheScopeMismatch] 拒绝用缓存作答：${mismatch}；` +
        `问题=「${userQuestion.slice(0, 50)}」→ 应重新查询/澄清`
    );
    return false;
  }
  return emitDeterministicJbTablesReply(sessionId, userQuestion, payload, agentConfig, emit);
}

/**
 * 逐片坏 bin 排名直连路由：session 缓存已有 slotBadBinsCompact 时直接出表，
 * 不经 LLM 工具调用（避免模型误选 aggregate_jb_bins 导致死循环）。
 */
async function tryRunPerSlotBinRankingDirectRoute(
  sessionId: string,
  userQuestion: string,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void
): Promise<boolean> {
  if (!isPerSlotBadBinRankingQuestion(userQuestion)) return false;
  const lot = extractLotFromUserText(userQuestion);
  const payload = lot
    ? getCachedJbPayloadForLot(sessionId, lot)
    : resolveJbToolPayload(sessionId);
  if (!payload) return false;
  const compact = payload["slotBadBinsCompact"];
  if (!Array.isArray(compact) || compact.length === 0) return false;
  return emitDeterministicJbTablesReply(sessionId, userQuestion, payload, agentConfig, emit);
}

type LotYieldRankEntry = {
  lot: string;
  device: string;
  yieldPct: number | null;
  worstSlot: number | null;
  worstPassId: number | null;
  testEnd: string | null;
};

function lotYieldRankingTopN(userQuestion: string): number {
  const nMatch = userQuestion.match(/top\s*(\d+)|(\d+)\s*个/i);
  return nMatch
    ? Math.min(Math.max(1, Number(nMatch[1] ?? nMatch[2])), 50)
    : 5;
}

/** 合并多 lot query_jb_bins 的 lotYieldRankByTestEnd（A1-4 多 lot 良率排行）。 */
function mergeLotYieldRankingPayloads(
  payloads: Record<string, unknown>[]
): Record<string, unknown> {
  const base = { ...payloads[0]! };
  const byLot = new Map<string, LotYieldRankEntry>();
  for (const p of payloads) {
    const rank = p["lotYieldRankByTestEnd"] as LotYieldRankEntry[] | undefined;
    for (const e of rank ?? []) {
      if (!e.lot || e.yieldPct == null) continue;
      const prev = byLot.get(e.lot);
      if (!prev || (e.testEnd ?? "") >= (prev.testEnd ?? "")) {
        byLot.set(e.lot, e);
      }
    }
  }
  base["lotYieldRankByTestEnd"] = [...byLot.values()].sort((a, b) =>
    (b.testEnd ?? "").localeCompare(a.testEnd ?? "")
  );
  return base;
}

async function enrichLotYieldRankingPayload(
  sessionId: string,
  userQuestion: string,
  basePayload: Record<string, unknown>,
  scopeArgs: Record<string, unknown>,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void
): Promise<Record<string, unknown>> {
  const wantN = lotYieldRankingTopN(userQuestion);
  const rank = basePayload["lotYieldRankByTestEnd"] as LotYieldRankEntry[] | undefined;
  const recent = basePayload["recentLotsByTestEnd"] as Array<{ lot?: string }> | undefined;
  const validRank = (rank ?? []).filter((e) => e.yieldPct != null);

  if (!recent || recent.length <= 1) return basePayload;
  if (validRank.length >= wantN && validRank.length >= 2) return basePayload;

  const lotsToFetch = recent
    .slice(0, Math.max(wantN + 2, 8))
    .map((e) => String(e.lot ?? "").trim())
    .filter(Boolean);
  const primaryLot = String(basePayload["lot"] ?? "").trim();
  const mergedPayloads: Record<string, unknown>[] = [basePayload];

  for (const lot of lotsToFetch) {
    if (lot === primaryLot && validRank.some((r) => r.lot === lot)) continue;
    const lotArgs: Record<string, unknown> = {
      lot,
      limit: 200,
      testEndFrom: scopeArgs["testEndFrom"] ?? "2020-01-01",
    };
    emit({ type: "status", message: `正在查询 ${lot} 良率…` });
    emit({ type: "tool_start", name: "query_jb_bins", args: lotArgs });
    try {
      let lotCache: string | undefined;
      const result = await runTool("query_jb_bins", lotArgs, {
        toolResultMaxChars: agentConfig.toolResultMaxChars,
        history: getHistory(sessionId),
        onJbBinsWrapped: (wrapped) => {
          lotCache = storeJbQuerySessionCache(sessionId, wrapped);
        },
      });
      const raw = typeof result === "string" ? result : JSON.stringify(result);
      const historyContent = toolResultForHistory(
        "query_jb_bins",
        raw,
        agentConfig.toolResultMaxHistoryChars,
        agentConfig.toolResultMaxChars,
        lotCache
      );
      emit({
        type: "tool_result",
        name: "query_jb_bins",
        summary: historyContent.slice(0, 200),
      });
      appendMessages(sessionId, {
        role: "tool",
        name: "query_jb_bins",
        tool_call_id: `yield_rank_${lot}_${Date.now()}`,
        content: historyContent,
      });
      const p =
        (lotCache ? parseJbToolPayload(lotCache) : null) ??
        parseJbToolPayload(historyContent);
      if (p) mergedPayloads.push(p);
    } catch {
      /* skip lot */
    }
  }

  if (mergedPayloads.length <= 1) return basePayload;
  return mergeLotYieldRankingPayloads(mergedPayloads);
}

/**
 * 阶段三：决策驱动确定性派发（dark-launch，flag `JB_DETERMINISTIC_DISPATCH=true` 才生效）。
 * 对 `resolveDispatch` 返回高置信 plan 的跨实体 mode 在 LLM 前服务端直发查询与渲染。
 * 查询失败 / 渲染为空 → return false 交回 LLM，绝不 dead-end。
 */
export async function tryRunSemanticDispatchDirectRoute(
  sessionId: string,
  userQuestion: string,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void
): Promise<boolean> {
  if (!getConfig().jbDeterministicDispatch) return false; // dark-launch

  const history = getHistory(sessionId);
  const lastToolName = lastToolMessage(history)?.name;
  const decision = await resolveJbRouteAsync(
    userQuestion, { lastToolName }, agentConfig, undefined, history
  );
  const plan: DispatchResult | null = resolveDispatch(decision, userQuestion, history);
  if (!plan) return false; // 低置信 / 不在派发表 → 交 LLM

  emit({ type: "status", message: "正在按意图直发查询…" });
  emit({ type: "tool_start", name: plan.queryTool, args: plan.args });
  let raw = "";
  let jbCache: string | undefined;
  try {
    const result = await runTool(plan.queryTool, plan.args, {
      toolResultMaxChars: agentConfig.toolResultMaxChars,
      history,
      onJbBinsWrapped: (wrapped) => { jbCache = storeJbQuerySessionCache(sessionId, wrapped); },
    });
    raw = typeof result === "string" ? result : JSON.stringify(result);
    emit({ type: "tool_result", name: plan.queryTool, summary: raw.slice(0, 200) });
    appendMessages(sessionId, {
      role: "tool", name: plan.queryTool,
      tool_call_id: `jb_dispatch_${Date.now()}`,
      content: raw.slice(0, agentConfig.toolResultMaxChars ?? 12000),
    });
  } catch {
    return false; // 查询失败 → 落回 LLM（不 dead-end）
  }

  if (plan.renderKind === "aggregate") {
    const scopeLabel = buildScopeLabelFromAggregateArgs(plan.args);
    const rendered = renderAggregateJbBinsResult(raw, userQuestion, scopeLabel);
    if (!rendered?.table?.trim()) return false; // 渲染空 → 落回 LLM
    const block = stampFirstTestNote(
      (rendered.withDataTitle ? `${DETERMINISTIC_DATA_SECTION_TITLE}\n\n` : "") +
        rendered.table +
        (rendered.commentaryNote
          ? `\n\n${DETERMINISTIC_COMMENTARY_SECTION_TITLE}\n\n${rendered.commentaryNote}`
          : "")
    );
    emitTextInChunks(block, emit);
    appendMessages(sessionId, { role: "assistant", content: block });
    emit({ type: "done" });
    return true;
  }

  // renderKind === "emitTables": 解析 payload → emitDeterministicJbTablesReply
  let payload =
    (jbCache ? parseJbToolPayload(jbCache) : null) ??
    resolveJbToolPayload(sessionId, raw);
  if (!payload) return false;

  if (decision.mode === "lot_yield_ranking") {
    payload = await enrichLotYieldRankingPayload(
      sessionId,
      userQuestion,
      payload,
      plan.args,
      agentConfig,
      emit
    );
  }

  return emitDeterministicJbTablesReply(sessionId, userQuestion, payload, agentConfig, emit);
}

/**
 * A2-4 兜底：bin 归因/排行类问句带无法识别的疑似 scope token（如 ZZZZZ），
 * 且无任何可解析 scope 时，直接澄清而非交 LLM 空转（250s idle 超时）。
 * 置于 PRE_LLM 直连链末端——前面所有能解析 scope 的路由都没接住时才兜底。
 */
async function tryRunUnscopedBinClarifyDirectRoute(
  sessionId: string,
  userQuestion: string,
  _agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void
): Promise<boolean> {
  const history = getHistory(sessionId);
  if (!canRunUnscopedBinClarify(userQuestion, history)) return false;

  const msg = buildUnscopedBinClarifyMessage(userQuestion);
  emit({ type: "status", message: "未识别数据范围，正在请求澄清…" });
  emitTextInChunks(msg, emit);
  appendMessages(sessionId, { role: "assistant", content: msg });
  emit({ type: "done" });
  return true;
}

/** 每个有 baseline 的 pass emit 一张 DUT 良率散点图（供直连路由与 LLM 工具路径复用）。 */
export function tryEmitUnderperformingDutScatter(
  passes: PassUnderperformingDutsResult[],
  emit: (event: AgentSseEvent) => void
): void {
  for (const s of buildUnderperformingDutScatterOptions(passes)) {
    emit({ type: "chart", option: s.option });
  }
}

/**
 * A 路：用户问「lot 内哪些 DUT 良率偏低」→ 直接 runLotUnderperformingDuts，
 * 确定性出全 DUT 高亮表 + 每 pass 散点图，跳过 LLM。失败落回 LLM（return false）。
 */
async function tryRunUnderperformingDutDirectRoute(
  sessionId: string,
  userQuestion: string,
  _agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void
): Promise<boolean> {
  const history = getHistory(sessionId);
  if (!canRunUnderperformingDutDirectRoute(userQuestion, history)) return false;
  const args = underperformingDutArgsFromText(userQuestion, history);
  if (!args) return false;

  emit({ type: "status", message: "正在分析各 DUT 良率（含 INF 取数，稍慢）…" });
  emit({ type: "tool_start", name: "query_lot_underperforming_duts", args });

  let resp;
  let md: string;
  try {
    resp = await runLotUnderperformingDuts({ lot: args.lot, device: args.device });
    md = formatAllDutsHighlightMarkdown(resp.passes ?? [], resp.lot, resp.device);
  } catch {
    return false; // INF 取数或格式化失败 → 落回 LLM，不 dead-end
  }
  if (!md.trim()) return false;
  const passes = resp.passes ?? [];

  emit({ type: "tool_result", name: "query_lot_underperforming_duts", summary: md.slice(0, 200) });
  const block = stampFirstTestNote(`${DETERMINISTIC_DATA_SECTION_TITLE}\n\n${md}`);
  emitTextInChunks(block, emit);
  tryEmitUnderperformingDutScatter(passes, emit);
  appendMessages(sessionId, { role: "assistant", content: block });
  emit({ type: "done" });
  return true;
}

/**
 * 「DR41803.1Y 中的 good bin 是多少」：从 JB payload 直出良品 bin，不走 lot 概况表。
 */
async function tryRunGoodBinValueDirectRoute(
  sessionId: string,
  userQuestion: string,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void
): Promise<boolean> {
  if (!isGoodBinValueQuestion(userQuestion)) return false;
  const lot = extractLotFromUserText(userQuestion);
  if (!lot) return false;

  let payload = getCachedJbPayloadForLot(sessionId, lot);
  if (!payload) {
    const queryArgs = buildLotOverviewQueryArgs(lot);
    emit({ type: "status", message: `正在查询 ${lot} JB STAR 良品 bin…` });
    emit({ type: "tool_start", name: "query_jb_bins", args: queryArgs });
    let jbCacheForHistory: string | undefined;
    try {
      const toolResult = await runTool("query_jb_bins", queryArgs, {
        toolResultMaxChars: agentConfig.toolResultMaxChars,
        history: getHistory(sessionId),
        onJbBinsWrapped: (wrapped) => {
          jbCacheForHistory = storeJbQuerySessionCache(sessionId, wrapped);
        },
      });
      const rawContent =
        typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult);
      const historyContent = toolResultForHistory(
        "query_jb_bins",
        rawContent,
        agentConfig.toolResultMaxHistoryChars,
        agentConfig.toolResultMaxChars,
        jbCacheForHistory
      );
      emit({
        type: "tool_result",
        name: "query_jb_bins",
        summary: historyContent.slice(0, 200),
      });
      const callId = `jb_goodbin_${Date.now()}`;
      appendMessages(sessionId, {
        role: "tool",
        name: "query_jb_bins",
        tool_call_id: callId,
        content: historyContent,
      });
      payload =
        (jbCacheForHistory ? parseJbToolPayload(jbCacheForHistory) : null) ??
        resolveJbToolPayload(sessionId, historyContent);
    } catch {
      return false;
    }
  }

  const md = payload ? buildGoodBinValueMarkdown(payload) : null;
  if (!md?.trim()) return false;

  const block = stampFirstTestNote(`${DETERMINISTIC_DATA_SECTION_TITLE}\n\n${md}`);
  emit({ type: "status", message: "正在输出良品 bin…" });
  emitTextInChunks(block, emit);
  appendMessages(sessionId, { role: "assistant", content: block });
  emit({ type: "done" });
  return true;
}

/**
 * B 路：JB lot 概况末尾 best-effort 补「各 DUT 良率」高亮表 + 散点图。
 * payload 缺 lot/device 或 INF 失败 → 返回 "" 静默跳过（不阻塞主概况）。
 * 返回追加的 markdown（供调用方并入持久化的 assistant 内容）。
 */
export async function tryAppendUnderperformingDutSection(
  payload: Record<string, unknown>,
  emit: (event: AgentSseEvent) => void,
  userQuestion?: string
): Promise<string> {
  const lotInQ = userQuestion ? extractLotFromUserText(userQuestion) : undefined;
  let lot = String(payload["lot"] ?? "").trim();
  let device = String(payload["device"] ?? "").trim();

  if (lotInQ) {
    const qLot = lotInQ.trim();
    if (!lot || lot.toUpperCase() !== qLot.toUpperCase()) {
      lot = qLot;
      const recent = payload["recentLotsByTestEnd"] as
        | Array<{ lot?: string; device?: string }>
        | undefined;
      const hit = recent?.find(
        (e) => String(e.lot ?? "").trim().toUpperCase() === qLot.toUpperCase()
      );
      if (hit?.device) device = String(hit.device).trim();
    }
  }
  // device 可能是确定性层的占位符 "—"（见 agentJbDeterministicReply）→ 视为无 device，
  // 避免拿占位符去跑一次注定失败的慢 INF 取数。
  if (!lot || !device || device === "—") return "";

  emit({ type: "status", message: "正在补充各 DUT 良率分析（较慢）…" });
  // best-effort 整节：取数 + 格式化 + emit 全包在 try 内，任何异常都静默跳过、返回 ""，
  // 绝不打断已流出的主概况（本函数在 emitDeterministicJbTablesReply 主表之后调用）。
  try {
    const goodBinsByPassId = buildGoodBinsByPassFromToolPayload(payload);
    const resp = await runLotUnderperformingDuts({
      lot,
      device,
      ...(goodBinsByPassId ? { goodBinsByPassId } : {}),
    });
    const passes = resp.passes ?? [];
    const md = formatAllDutsHighlightMarkdown(passes, resp.lot, resp.device);
    if (!md.trim()) return "";

    const section = `\n\n### 🔬 各 DUT 良率（低于阈值 🔴）\n\n${md}`;
    emit({ type: "text", delta: section });
    tryEmitUnderperformingDutScatter(passes, emit);
    return section;
  } catch {
    return ""; // best-effort：失败静默跳过
  }
}

/** 从 query_lot_dut_bin_agg 结果中提取 DUT 分布，直接 emit bar chart。 */
function tryEmitDutBinBarChart(
  rawContent: string,
  focusBin: number,
  emit: (event: AgentSseEvent) => void
): boolean {
  const parsed = tryParseJsonish(rawContent) as Record<string, unknown> | null;
  if (!parsed) return false;
  type DutEntry = { dut: number; dieCount: number };
  type DutGroup = { passId: number; duts: DutEntry[]; totalDieCount: number };
  const dutGroups = parsed["focusBinDuts"] as DutGroup[] | undefined;
  if (!dutGroups?.length) return false;
  const group = dutGroups.find((g) => g.passId === 1) ?? dutGroups[0];
  if (!group?.duts?.length || group.duts.length < 3) return false;
  const labels = group.duts.map((d) => `DUT${d.dut}`);
  const values = group.duts.map((d) => d.dieCount);
  try {
    const option = buildChartOption("bar", `BIN${focusBin} 各DUT颗数分布（pass${group.passId}）`, {
      labels,
      series: [{ name: `BIN${focusBin} 颗数`, values }],
    });
    emit({ type: "chart", option });
  } catch { return false; }
  return true;
}

/** 从 JB payload 的 topBadBins 提取前 10 BIN，直接 emit bar chart。 */
function tryEmitTopBinBarChart(
  payload: Record<string, unknown>,
  emit: (event: AgentSseEvent) => void
): boolean {
  type TopBinEntry = { bin: number; dieCount: number };
  const topBins = payload["topBadBins"] as TopBinEntry[] | undefined;
  if (!topBins || topBins.length < 3) return false;
  const slice = topBins.slice(0, 10);
  const labels = slice.map((b) => `BIN${b.bin}`);
  const values = slice.map((b) => b.dieCount);
  const lot = String(payload["lot"] ?? "").trim();
  const title = `坏 BIN 分布${lot ? `（${lot}）` : ""}`;
  try {
    const option = buildChartOption("bar", title, {
      labels,
      series: [{ name: "坏 die 颗数", values }],
    });
    emit({ type: "chart", option });
  } catch { return false; }
  return true;
}

/** 检测用户是否在询问特定探针卡（格式如 6045-10）的测试情况。 */
function isCardProbeTestQuestion(userText: string): boolean {
  return /\b\d{4}-\d{2}\b/.test(userText);
}

/**
 * 从 query_lot_dut_bin_agg passes 结果中计算各 DUT 的坏 die 总量（跨所有坏 BIN 求和）。
 * 返回按 DUT 编号升序排列（空间直观），仅含 totalBadDie > 0 的 DUT。
 */
function computeDutTotalBadDieFromPasses(
  rawContent: string,
  targetPassId = 1
): Array<{ dut: number; totalBadDie: number }> | null {
  const parsed = tryParseJsonish(rawContent) as Record<string, unknown> | null;
  if (!parsed) return null;

  type DutEntry = { dut: number; dieCount: number };
  type BinEntry = { isGoodBin?: boolean; duts?: DutEntry[]; dutBreakdownOmitted?: boolean };
  type PassEntry = { passId: number; bins: BinEntry[] };

  const passes = parsed["passes"] as PassEntry[] | undefined;
  if (!passes?.length) return null;

  const targetPass = passes.find((p) => p.passId === targetPassId) ?? passes[0];
  if (!targetPass?.bins?.length) return null;

  const dutTotals = new Map<number, number>();
  for (const bin of targetPass.bins) {
    if (bin.isGoodBin || bin.dutBreakdownOmitted || !bin.duts?.length) continue;
    for (const { dut, dieCount } of bin.duts) {
      dutTotals.set(dut, (dutTotals.get(dut) ?? 0) + dieCount);
    }
  }

  const result = [...dutTotals.entries()]
    .filter(([, total]) => total > 0)
    .sort((a, b) => a[0] - b[0])
    .map(([dut, totalBadDie]) => ({ dut, totalBadDie }));

  return result.length >= 2 ? result : null;
}

/** 片间（wafer-to-wafer）坏 die 总量对比图，来自 slotBadBinsCompact，无需额外查询。 */
function tryEmitWaferTotalBadDieChart(
  payload: Record<string, unknown>,
  passId: number,
  emit: (event: AgentSseEvent) => void
): void {
  type CompactEntry = {
    slot: number; passId: number; cardId: string;
    badBins: Array<{ bin: number; dieCount: number }>;
  };
  const compact = payload["slotBadBinsCompact"] as CompactEntry[] | undefined;
  if (!compact?.length) return;

  const filtered = compact.filter((e) => e.passId === passId);
  if (filtered.length < 2) return;

  const bySlot = new Map<number, number>();
  for (const { slot, badBins } of filtered) {
    bySlot.set(slot, (bySlot.get(slot) ?? 0) + badBins.reduce((s, b) => s + b.dieCount, 0));
  }
  const sorted = [...bySlot.entries()].sort((a, b) => a[0] - b[0]);
  if (sorted.length < 2) return;

  const lot = String(payload["lot"] ?? "").trim();
  try {
    const option = buildChartOption(
      "bar",
      `片间坏 die 总量（${lot ? lot + " " : ""}pass${passId}）`,
      {
        labels: sorted.map(([slot]) => `W${slot}`),
        series: [{ name: "坏 die 颗数", values: sorted.map(([, v]) => v) }],
      }
    );
    emit({ type: "chart", option });
  } catch { /* skip */ }
}

/** Lot 良率趋势折线图，来自 lotYieldRankByTestEnd，无需额外查询。 */
function tryEmitLotYieldTrendChart(
  payload: Record<string, unknown>,
  emit: (event: AgentSseEvent) => void
): void {
  type RankEntry = { lot: string; yieldPct: number; testEnd: string | null };
  const rank = payload["lotYieldRankByTestEnd"] as RankEntry[] | undefined;
  if (!rank || rank.length < 2) return;

  const sorted = [...rank]
    .filter((e) => e.testEnd)
    .sort((a, b) => (a.testEnd ?? "").localeCompare(b.testEnd ?? ""));
  if (sorted.length < 2) return;

  try {
    const option = buildChartOption(
      "line",
      "各 lot 良率趋势（按测试时间）",
      {
        labels: sorted.map((e) => e.lot),
        series: [{ name: "良率%", values: sorted.map((e) => parseFloat(e.yieldPct.toFixed(1))) }],
      }
    );
    emit({ type: "chart", option });
  } catch { /* skip */ }
}

/**
 * DUT 坏 die 跨 lot 对比表（最近两 lot），以 Markdown 文本 emit。
 * 用于判断哪个 DUT 位置持续偏高（探针磨损定位）。
 */
async function tryEmitDutCrossLotComparisonTable(
  payload: Record<string, unknown>,
  lot1RawContent: string,
  probeCardType: string,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void
): Promise<void> {
  const lot1 = String(payload["lot"] ?? "").trim();
  type RecentLot = { lot: string; device: string };
  const recentLots = payload["recentLotsByTestEnd"] as RecentLot[] | undefined;
  if (!recentLots || recentLots.length < 2) return;

  const lot2Entry = recentLots.find((e) => String(e.lot).trim() !== lot1);
  if (!lot2Entry) return;

  const lot2 = String(lot2Entry.lot).trim();
  const device2 = String(lot2Entry.device ?? payload["device"] ?? "").trim();
  if (!lot2 || !device2) return;

  emit({ type: "status", message: `正在获取 ${lot2} DUT 数据用于跨 lot 对比…` });

  let raw2: string;
  try {
    const result = await runTool("query_lot_dut_bin_agg", {
      device: device2, lot: lot2, passId: 1,
      ...(probeCardType ? { probeCardType } : {}),
    }, { toolResultMaxChars: agentConfig.toolResultMaxChars, history: [] });
    raw2 = typeof result === "string" ? result : JSON.stringify(result);
  } catch {
    return;
  }

  const duts1 = computeDutTotalBadDieFromPasses(lot1RawContent, 1);
  const duts2 = computeDutTotalBadDieFromPasses(raw2, 1);
  if (!duts1?.length || !duts2?.length) return;

  const map1 = new Map(duts1.map((d) => [d.dut, d.totalBadDie]));
  const map2 = new Map(duts2.map((d) => [d.dut, d.totalBadDie]));
  const allDuts = new Set([...map1.keys(), ...map2.keys()]);

  const tableRows = [...allDuts]
    .sort((a, b) => a - b)
    .filter((dut) => (map1.get(dut) ?? 0) > 0 || (map2.get(dut) ?? 0) > 0)
    .map((dut) => {
      const v2 = map2.get(dut) ?? 0;
      const v1 = map1.get(dut) ?? 0;
      const delta = v1 - v2;
      const trend = delta > 5 ? `▲${delta}` : delta < -5 ? `▼${Math.abs(delta)}` : "≈";
      return `| DUT${dut} | ${v2} | ${v1} | ${trend} |`;
    });
  if (tableRows.length === 0) return;

  const cardLabel = probeCardType || "同型号卡";
  const md = [
    `\n\n**DUT 坏 die 跨 lot 对比（pass1 / ${cardLabel}）**`,
    "",
    `| DUT | ${lot2}（次近） | ${lot1}（最近） | 趋势 |`,
    "|---|---|---|---|",
    ...tableRows,
    "",
    `> 趋势列：▲ = 坏 die 增加，▼ = 改善，≈ = 持平（阈值 ±5 颗）。DUT 持续偏高提示该触点位置磨损，建议针对性检查针尖状态。`,
  ].join("\n");

  emit({ type: "text", delta: md });
}

/**
 * 探针卡概况问题的全套对比分析（调用位置：emitDeterministicJbTablesReply 末尾）：
 * ① 片间坏 die 柱状图  ② lot 良率趋势折线图
 * ③ 当前 lot DUT 坏 die 柱状图  ④ DUT 跨 lot 对比表
 * 任何步骤失败均静默跳过，不阻断主流程。
 */
async function tryEmitCardDutBadDieChart(
  userQuestion: string,
  payload: Record<string, unknown>,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void
): Promise<void> {
  if (!isCardProbeTestQuestion(userQuestion)) return;

  const device = String(payload["device"] ?? "").trim();
  const lot = String(payload["lot"] ?? "").trim();
  if (!device || !lot) return;

  type CardByPassEntry = { passId: number; cardId: string };
  const cardByPassId = payload["cardByPassId"] as CardByPassEntry[] | undefined;
  const firstCardId = cardByPassId?.[0]?.cardId ?? "";
  const probeCardType = firstCardId.match(/^(\d+)-/)?.[1] ?? "";

  // ① 片间坏 die 对比（无需额外查询）
  tryEmitWaferTotalBadDieChart(payload, 1, emit);

  // ② lot 良率趋势（无需额外查询）
  tryEmitLotYieldTrendChart(payload, emit);

  // ③ 当前 lot DUT 坏 die 总量（需 query_lot_dut_bin_agg）
  emit({ type: "status", message: `正在分析 ${lot} DUT 坏 die 分布…` });

  let lotAggRaw: string;
  try {
    const result = await runTool("query_lot_dut_bin_agg", {
      device, lot, passId: 1,
      ...(probeCardType ? { probeCardType } : {}),
    }, { toolResultMaxChars: agentConfig.toolResultMaxChars, history: [] });
    lotAggRaw = typeof result === "string" ? result : JSON.stringify(result);
  } catch {
    return;
  }

  const dutTotals = computeDutTotalBadDieFromPasses(lotAggRaw, 1);
  if (dutTotals?.length) {
    try {
      const option = buildChartOption(
        "bar",
        `DUT 坏 die 总量（${lot} pass1）`,
        {
          labels: dutTotals.map((d) => `DUT${d.dut}`),
          series: [{ name: "坏 die 颗数", values: dutTotals.map((d) => d.totalBadDie) }],
        }
      );
      emit({ type: "chart", option });
    } catch { /* skip */ }

    // ④ DUT 跨 lot 对比表（需再查一次次近 lot）
    await tryEmitDutCrossLotComparisonTable(payload, lotAggRaw, probeCardType, agentConfig, emit);
  }
}

/** 把 query_lot_dut_bin_agg 结果格式化为 Markdown 表格 + 一句结论。 */
function buildDutBinAggMarkdown(
  rawContent: string,
  focusBin: number,
  lot: string,
  device: string
): string {
  const parsed = tryParseJsonish(rawContent) as Record<string, unknown> | null;
  if (!parsed) return "";

  const focusBinStr = `BIN${focusBin}`;
  type DutEntry = { dut: number; dieCount: number };
  type DutGroup = { passId: number; bin: string; dutCount: number; totalDieCount: number; avgPerDut: number; duts: DutEntry[] };
  const dutGroups = parsed["focusBinDuts"] as DutGroup[] | undefined;
  if (!dutGroups?.length) return "";

  const lotTag = lot ? `（lot ${lot}${device ? ` ${device}` : ""}）` : "";
  const parts: string[] = [];
  for (const group of dutGroups) {
    const passLabel = `pass${group.passId}`;
    const rows: string[] = [
      `**${focusBinStr} 各 DUT 分布${lotTag}（${passLabel}）**`,
      "",
      `| DUT | 颗数 | 占 ${focusBinStr} 总量% |`,
      "|---:|---:|---:|",
    ];
    for (const d of group.duts) {
      const pct = group.totalDieCount > 0
        ? ((d.dieCount / group.totalDieCount) * 100).toFixed(1)
        : "0.0";
      rows.push(`| DUT${d.dut} | ${d.dieCount} | ${pct}% |`);
    }
    rows.push("");
    rows.push(
      `整批 ${focusBinStr} 合计 **${group.totalDieCount}** 颗，涉及 ${group.dutCount} 个 DUT，平均每 DUT ${group.avgPerDut} 颗。`
    );
    const top = group.duts[0];
    if (top) {
      const topPct = group.totalDieCount > 0
        ? ((top.dieCount / group.totalDieCount) * 100).toFixed(1)
        : "0";
      rows.push(`${focusBinStr} **最多的 DUT 为 DUT${top.dut}**（${top.dieCount} 颗，${topPct}%）。`);
    }
    parts.push(rows.join("\n"));
  }
  return parts.join("\n\n");
}

/**
 * Summary 轮专用：query_jb_bins 已完成、用户问"哪个 DUT 的 BIN X 最多"时，
 * 自动调 query_lot_dut_bin_agg，直出 DUT 分布表 + LLM 解读，避免模型承诺查询却无法执行。
 */
async function tryRunDutBinAggAutoRoute(
  sessionId: string,
  userQuestion: string,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void
): Promise<boolean> {
  const focusBin = extractBinFromUserText(userQuestion);
  if (focusBin == null) return false;
  if (!/(dut|触点)/i.test(userQuestion)) return false;

  const history = getHistory(sessionId);
  const lastTool = lastToolMessage(history);
  if (lastTool?.name !== "query_jb_bins") return false;

  const payload = resolveJbToolPayload(sessionId, String(lastTool.content ?? ""));
  if (!payload) return false;

  const device = String(payload["device"] ?? "").trim();
  const lot = String(payload["lot"] ?? "").trim();
  if (!device || !lot) return false;

  const queryArgs: Record<string, unknown> = { device, lot, passId: 1, focusBin };
  emit({ type: "status", message: `正在查询 ${lot} DUT×BIN${focusBin} 聚合…` });
  emit({ type: "tool_start", name: "query_lot_dut_bin_agg", args: queryArgs });

  let rawContent: string;
  try {
    const toolResult = await runTool("query_lot_dut_bin_agg", queryArgs, {
      toolResultMaxChars: agentConfig.toolResultMaxChars,
      history: getHistory(sessionId),
    });
    rawContent = typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult);
  } catch {
    return false; // 失败回退到 LLM 路由
  }

  emit({ type: "tool_result", name: "query_lot_dut_bin_agg", summary: rawContent.slice(0, 200) });
  appendMessages(sessionId, {
    role: "tool",
    name: "query_lot_dut_bin_agg",
    tool_call_id: `dut_bin_auto_${Date.now()}`,
    content: rawContent.slice(0, agentConfig.toolResultMaxChars),
  });

  const tableMd = buildDutBinAggMarkdown(rawContent, focusBin, lot, device);
  if (!tableMd.trim()) return false;

  const tablesBlock = stampFirstTestNote(`${DETERMINISTIC_DATA_SECTION_TITLE}\n\n${tableMd}`);
  emitTextInChunks(tablesBlock, emit);
  // DUT 分布数据点 ≥3 时自动生成 bar chart，直观展示哪个 DUT 集中出 BIN
  tryEmitDutBinBarChart(rawContent, focusBin, emit);
  emit({ type: "status", message: "正在生成数据解读…" });
  emit({ type: "text", delta: `\n\n${DETERMINISTIC_COMMENTARY_SECTION_TITLE}\n\n` });

  const commFilter = createDeepSeekFilter(emit);
  let streamError: string | undefined;
  await streamSiliconFlow(
    {
      model: agentConfig.subAgentModel,
      messages: [
        { role: "system", content: BRIEF_COMMENTARY_SYSTEM },
        {
          role: "user",
          content: buildBriefCommentaryUserMessage(userQuestion, tableMd, {
            engineeringContext: buildEngineeringContextFromPayload(payload),
          }),
        },
      ],
      max_tokens: 1024,
    },
    agentConfig,
    (chunk) => {
      if (chunk.type === "delta") commFilter.push(chunk.text);
      if (chunk.type === "error") streamError = chunk.message;
    }
  );
  commFilter.finalize();
  const commentary = commFilter.cleanText.trim();

  let commentaryOrFallback: string;
  if (commentary) {
    commentaryOrFallback = commentary;
  } else {
    commentaryOrFallback = streamError
      ? `*（解读生成失败：${cleanStreamErrorMessage(streamError)}；以上实测数据表为准。）*`
      : `*（模型未返回解读；以上实测数据表为准。）*`;
    emit({ type: "text", delta: commentaryOrFallback });
  }

  const full =
    tablesBlock +
    `\n\n${DETERMINISTIC_COMMENTARY_SECTION_TITLE}\n\n` +
    commentaryOrFallback;
  appendMessages(sessionId, { role: "assistant", content: full });
  emit({ type: "done" });
  return true;
}

/**
 * 总结轮：先 SSE 直出服务端表，再让 LLM 只写 3–8 句解读（不改表中数字）。
 * @returns true 表示已完整结束本轮（调用方应 return）。
 */
/** 多批次聚合结果（aggregate_jb_bins groupBy:"lot"）→ 服务端直出跨批次 BIN 对比表。 */
function findLastAggregateJbBinsArgs(
  history: ChatMessage[]
): Record<string, unknown> | null {
  return findLastToolCallArgs(history, "aggregate_jb_bins");
}

function buildMultiLotBinTable(content: string): string | null {
  let agg: Record<string, unknown>;
  try { agg = JSON.parse(content) as Record<string, unknown>; } catch { return null; }
  const groups = agg["groups"] as Array<Record<string, unknown>> | undefined;
  if (!groups?.length) return null;

  // Detect cross-lot: groups contain 'lot' with multiple distinct values
  const lotOrder: string[] = [];
  const lotBins = new Map<string, Array<{ bin: string; count: number }>>();
  for (const g of groups) {
    const lot = String(g["lot"] ?? "").trim();
    if (!lot) continue;
    const binRaw = g["bin"] ?? g["BIN"];
    const bin = `BIN${String(binRaw ?? "").trim()}`;
    const count = Number(g["count"] ?? g["COUNT"] ?? 0);
    if (!lotBins.has(lot)) { lotBins.set(lot, []); lotOrder.push(lot); }
    if (binRaw && count > 0) lotBins.get(lot)!.push({ bin, count });
  }
  if (lotBins.size <= 1) return null; // single-lot: let normal path handle

  // Sort lots by total bad die DESC
  const lotTotals = new Map<string, number>();
  for (const [lot, bins] of lotBins) lotTotals.set(lot, bins.reduce((s, b) => s + b.count, 0));
  const sortedLots = [...lotOrder].sort((a, b) => (lotTotals.get(b) ?? 0) - (lotTotals.get(a) ?? 0));

  const lines = [
    `**各批次主要坏 BIN（共 ${lotBins.size} 个批次，按坏 die 总量排列）**`,
    "",
    "| Lot | TOP 1 BIN（颗数）| TOP 2 BIN（颗数）| TOP 3 BIN（颗数）| 坏 die 合计 |",
    "|---|---|---|---|---:|",
  ];
  for (const lot of sortedLots) {
    const bins = (lotBins.get(lot) ?? []).slice(0, 3);
    while (bins.length < 3) bins.push({ bin: "—", count: 0 });
    const cells = bins.map(b => b.count > 0 ? `${b.bin}（${b.count}）` : "—");
    lines.push(`| ${lot} | ${cells.join(" | ")} | ${lotTotals.get(lot) ?? 0} |`);
  }
  // 诊断：暴露排序基准（绝对坏 die 总量），供真库核对「测试最差」口径是否应改用良率%。
  console.warn(
    `[multiLotBinTable] 按坏die总量降序 ${sortedLots.length} lot：` +
      sortedLots.map((l) => `${l}=${lotTotals.get(l) ?? 0}`).join(", ")
  );
  // 口径脚注：坏 die 多 ≠ 良率低（大片/大批自然坏 die 多），避免把绝对量当「最差」。
  lines.push(
    "",
    "*注：本表按各 lot「坏 die 总量」降序（良品 bin 已在聚合中扣除）；坏 die 绝对量受片数/总 die 影响，" +
      "并不等价于良率最低。判定「测试最差」请以各 lot 良率% 复核（对目标 lot 调 query_jb_bins(lot) 看 yieldByPassId）。*"
  );
  return lines.join("\n");
}

/**
 * aggregate_jb_bins 结果 → 选出唯一应直出的渲染表（单一真相源）。
 *
 * 此前这条「binLot → multiLot → binCard → binDevice → binRank」选择链被**复制**在
 * tryRunDeterministicJbSummary（emit SSE）与 jbBinsYieldFallbackMessage（返字符串）两处，
 * 任何新增/修复都要改两遍（B1/B3 即如此）——典型「打地鼠」。这里收敛为一处，两个站点
 * 各自按返回值做自己的输出（SSE / 字符串），新增渲染分支只改这一个函数。
 *
 * 返回 null 表示无可直出表（交回上层）。`withDataTitle=false` 用于 multiLot 表
 * （自带表头，不加「## 实测数据」标题）；`statusMessage` 为空时调用方不发 status。
 */
export interface AggregateJbBinsRender {
  table: string;
  commentaryNote: string;
  statusMessage: string;
  withDataTitle: boolean;
}

export function renderAggregateJbBinsResult(
  aggContent: string,
  userQuestion: string,
  scopeLabel: string | undefined
): AggregateJbBinsRender | null {
  const focusBin = extractBinFromUserText(userQuestion);
  const namedLots = extractLotsFromUserText(userQuestion);

  // 用户问「哪个 lot BINnn 最多」: 按指定 bin 在各 lot 的颗数排序（含卡），须在 multiLotBinTable
  // 之前判断——后者按「坏die总量」排序会把该 bin 少但总坏die多的 lot 误排第一。
  // 点名多个 lot（B3）时仅保留这些 lot 并对缺失者补 0 行。
  const binLotTable = buildBinFocusedLotRankingMarkdown(
    aggContent,
    focusBin,
    scopeLabel,
    namedLots
  );
  if (binLotTable?.trim()) {
    return {
      table: binLotTable,
      commentaryNote:
        `*以上按 BIN${focusBin} 在各 lot 的坏 die 颗数降序（非坏die总量口径）。` +
        `如需某 lot 逐片分布，请追问「<lot> 哪片 BIN${focusBin} 最多」。*`,
      statusMessage: "正在输出指定 BIN 的各 lot 排行…",
      withDataTitle: true,
    };
  }

  const multiLot = buildMultiLotBinTable(aggContent);
  if (multiLot?.trim()) {
    return {
      table: multiLot,
      commentaryNote: "如需深入分析某批次，请告知批次号（如上表第1行）。",
      statusMessage: "", // multiLot 表自带表头与口径脚注，summary 站原本不发 status
      withDataTitle: false,
    };
  }

  // groupBy:"bin,cardId" → 卡归属表（用户问「集中在哪张卡」）。须在 bin-only 排行前判断，
  // 否则 buildAggregateBinRankingMarkdown 会丢掉 cardId 列、渲染成重复 BIN 行。
  const binCardTable = buildBinCardAggregateMarkdown(
    aggContent,
    scopeLabel,
    focusBin
  );
  if (binCardTable?.trim()) {
    return {
      table: binCardTable,
      commentaryNote:
        `*以上为范围内 BIN×探针卡 坏 die 汇总（良品 bin 已扣除）。卡级已定位；DUT 级归属需 INF DUT map，` +
        `可继续追问「lot <号> wafer <片号> BIN<n> 的 DUT 分布」。*`,
      statusMessage: "正在输出 BIN×探针卡 归属表…",
      withDataTitle: true,
    };
  }

  // groupBy:"device,bin" → BIN×device 表（用户「把 device 也要列出来」）。须在 bin-only 排行前判断，
  // 否则 buildAggregateBinRankingMarkdown 会丢掉 device 列、跨 device 求和（见 B1）。
  const binDeviceTable = buildBinDeviceAggregateMarkdown(
    aggContent,
    scopeLabel,
    focusBin
  );
  if (binDeviceTable?.trim()) {
    return {
      table: binDeviceTable,
      commentaryNote:
        `*以上为范围内 BIN×device 坏 die 汇总（良品 bin 已扣除）。如需定位到具体批次，` +
        `请问「哪个 lot 的 BIN<n> 最多」（按 bin+lot 排行）。*`,
      statusMessage: "正在输出 BIN×device 汇总表…",
      withDataTitle: true,
    };
  }

  const binRank = buildAggregateBinRankingMarkdown(aggContent, scopeLabel);
  if (binRank?.trim()) {
    return {
      table: binRank,
      commentaryNote: "*以上为范围内坏 BIN 按 dieCount 降序汇总。*",
      statusMessage: "正在输出坏 BIN 排行表…",
      withDataTitle: true,
    };
  }

  return null;
}

/**
 * 从 aggregate_probe_card_tester_performance JSON 直出四表 + 解读 LLM（与总结轮共用）。
 */
async function emitDeterministicProbeCardPerfReply(
  sessionId: string,
  userQuestion: string,
  payload: Record<string, unknown>,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void
): Promise<boolean> {
  const groups = Array.isArray(payload["groups"])
    ? (payload["groups"] as Array<Record<string, unknown>>)
    : [];
  if (groups.length === 0) return false;

  const tableParts: string[] = [];
  for (const g of groups) {
    for (const key of [
      "comboRankingMarkdown",
      "cardRankingMarkdown",
      "cardTrendMarkdown",
      "cardBadBinMarkdown",
    ] as const) {
      const md = g[key];
      if (typeof md === "string" && md.trim()) tableParts.push(md.trim());
    }
  }
  if (tableParts.length === 0) return false;
  const tables = tableParts.join("\n\n");

  const tablesBlock = `${DETERMINISTIC_DATA_SECTION_TITLE}\n\n${tables}`;
  emit({ type: "status", message: "正在输出服务端探针卡/机台组合排名表…" });
  emitTextInChunks(tablesBlock, emit);

  emit({ type: "status", message: "正在生成数据解读与专业建议…" });
  emit({
    type: "text",
    delta: `\n\n${DETERMINISTIC_COMMENTARY_SECTION_TITLE}\n\n`,
  });

  const commFilter = createDeepSeekFilter(emit);
  let streamError: string | undefined;

  await streamSiliconFlow(
    {
      model: agentConfig.subAgentModel,
      messages: [
        { role: "system", content: BRIEF_COMMENTARY_SYSTEM },
        {
          role: "user",
          content: buildBriefCommentaryUserMessage(userQuestion, tables),
        },
      ],
      max_tokens: 1024,
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

  let commentaryOrFallback: string;
  if (commentary) {
    commentaryOrFallback = commentary;
  } else {
    commentaryOrFallback = streamError
      ? `*（解读生成失败：${cleanStreamErrorMessage(streamError)}；以上实测数据表为准。）*`
      : `*（模型未返回解读；以上实测数据表为准。）*`;
    emit({ type: "text", delta: commentaryOrFallback });
  }

  const full =
    tablesBlock +
    `\n\n${DETERMINISTIC_COMMENTARY_SECTION_TITLE}\n\n` +
    commentaryOrFallback;

  appendMessages(sessionId, { role: "assistant", content: full });
  emit({ type: "done" });
  return true;
}

/**
 * 「WA03P02G …最好的探针卡+机台组合…」：PRE_LLM 直调 aggregate_probe_card_tester_performance，
 * 不依赖 LLM 选工具（真库 DeepSeek 仍常误选 query_jb_bins 单 lot 表）。
 */
async function tryRunProbeCardPerfDirectRoute(
  sessionId: string,
  userQuestion: string,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void
): Promise<boolean> {
  if (!isProbeCardTesterPerformanceQuestion(userQuestion)) return false;

  const history = getHistory(sessionId);
  const device =
    inferDeviceFromText(userQuestion) || inferDeviceFromHistory(history);
  if (!device) return false;

  const args: Record<string, unknown> = { device };
  const window = inferRecentMonthsWindow(userQuestion);
  if (window.testEndFrom) args["testEndFrom"] = window.testEndFrom;
  if (window.testEndTo) args["testEndTo"] = window.testEndTo;
  const passIdMatch = userQuestion.match(/\bpass\s*Id\s*[=:]?\s*([135])\b|\bpass\s*([135])\b/i);
  if (passIdMatch) {
    args["passId"] = Number(passIdMatch[1] ?? passIdMatch[2]);
  } else if (/sort\s*1|常温/i.test(userQuestion)) {
    args["passId"] = 1;
  } else if (/sort\s*2|高温/i.test(userQuestion)) {
    args["passId"] = 3;
  } else if (/sort\s*3|低温/i.test(userQuestion)) {
    args["passId"] = 5;
  }

  emit({ type: "status", message: `正在聚合 ${device} 探针卡+机台组合表现…` });
  emit({ type: "tool_start", name: "aggregate_probe_card_tester_performance", args });

  let raw = "";
  try {
    const result = await runTool("aggregate_probe_card_tester_performance", args, {
      toolResultMaxChars: agentConfig.toolResultMaxChars,
      history,
    });
    raw = typeof result === "string" ? result : JSON.stringify(result);
    if (raw.startsWith("aggregate_probe_card_tester_performance")) return false;
    emit({
      type: "tool_result",
      name: "aggregate_probe_card_tester_performance",
      summary: raw.slice(0, 200),
    });
    appendMessages(sessionId, {
      role: "tool",
      name: "aggregate_probe_card_tester_performance",
      tool_call_id: `probe_card_perf_${Date.now()}`,
      content: raw.slice(0, agentConfig.toolResultMaxChars ?? 12000),
    });
  } catch {
    return false;
  }

  let payload: Record<string, unknown> | null = null;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return false;
  }
  return emitDeterministicProbeCardPerfReply(
    sessionId,
    userQuestion,
    payload,
    agentConfig,
    emit
  );
}

/**
 * 直出 aggregate_probe_card_tester_performance 服务端表 + 单独一轮"仅写解读/建议"的
 * LLM 调用，复用既有 BRIEF_COMMENTARY_SYSTEM 架构。
 *
 * 2026-07-11 真实 MiniMax-M2.5 联调发现：仅在 agentPrompt.ts 里用文字硬规则要求"必须原样
 * 贴表、禁止改写"，模型仍会把 comboRankingMarkdown / cardRankingMarkdown 转述成自己的大白话
 * 总结（且转述时出现过 pass2/pass3 张冠李戴）。与 query_jb_bins 走 `tryRunDeterministicJbSummary`
 * 服务端直出表的理由完全一致：数字必须由服务端保证，不能寄望于 prompt 约束模型的转述行为。
 */
async function tryRunDeterministicProbeCardPerfSummary(
  sessionId: string,
  userQuestion: string,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void
): Promise<boolean> {
  const history = getHistory(sessionId);
  const lastTool = lastToolMessage(history);
  if (lastTool?.name !== "aggregate_probe_card_tester_performance") return false;

  let payload: Record<string, unknown> | null = null;
  try {
    payload = JSON.parse(String(lastTool.content ?? "")) as Record<string, unknown>;
  } catch {
    return false;
  }
  return emitDeterministicProbeCardPerfReply(
    sessionId,
    userQuestion,
    payload,
    agentConfig,
    emit
  );
}

async function tryRunDeterministicJbSummary(
  sessionId: string,
  userQuestion: string,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void
): Promise<boolean> {
  const history = getHistory(sessionId);
  const lastTool = lastToolMessage(history);
  const lotListing = isLotListingQuestion(userQuestion);
  if (
    lastTool?.name !== "query_jb_bins" &&
    lastTool?.name !== "aggregate_jb_bins" &&
    !(lotListing && lastTool?.name === "query_yield_triggers") &&
    !(lotListing && lastTool?.name === "aggregate_yield_triggers")
  ) {
    return false;
  }

  if (
    lotListing &&
    (lastTool?.name === "query_yield_triggers" ||
      lastTool?.name === "aggregate_yield_triggers")
  ) {
    return emitDeterministicJbTablesReply(
      sessionId,
      userQuestion,
      {},
      agentConfig,
      emit
    );
  }

  // Cross-lot aggregate_jb_bins: emit server-generated per-lot BIN table directly.
  // Do NOT use the single-lot session cache — it would show the wrong lot.
  if (lastTool.name === "aggregate_jb_bins") {
    const aggContent = String(lastTool.content ?? "");
    const aggArgs =
      findLastAggregateJbBinsArgs(history) ??
      scopedBadBinAggregateArgsFromUser(userQuestion, history);
    const scopeLabel = aggArgs
      ? buildScopeLabelFromAggregateArgs(aggArgs)
      : undefined;
    const rendered = renderAggregateJbBinsResult(aggContent, userQuestion, scopeLabel);
    if (rendered) {
      const dataBlock = rendered.withDataTitle
        ? `${DETERMINISTIC_DATA_SECTION_TITLE}\n\n${rendered.table}`
        : rendered.table;
      const msg = stampFirstTestNote(
        !rendered.commentaryNote
          ? dataBlock
          : rendered.withDataTitle
            ? `${dataBlock}\n\n${DETERMINISTIC_COMMENTARY_SECTION_TITLE}\n\n${rendered.commentaryNote}`
            : `${dataBlock}\n\n${rendered.commentaryNote}`
      );
      if (rendered.statusMessage) {
        emit({ type: "status", message: rendered.statusMessage });
      }
      emitTextInChunks(msg, emit);
      appendMessages(sessionId, { role: "assistant", content: msg });
      emit({ type: "done" });
      return true;
    }
    // Single-lot aggregate or mis-scoped: do not fall through to session cache for scoped fail-bin questions
    if (canRunScopedBadBinDirectRoute(userQuestion, history)) {
      return false;
    }
  }

  // 单片坏 die 空间聚集问题（「这片 wafer 是否有坏 die 聚集」）：JB lot 数据无 die 坐标，
  // 整 lot 确定性 BIN 趋势表答不了 → bail 交回 LLM（可下一轮 inf_draw_wafer_map 看空间分布），
  // 避免重复输出整 lot 警示表的「套话」。
  if (
    lastTool.name === "query_jb_bins" &&
    isSingleWaferDieClusterQuestion(userQuestion)
  ) {
    console.warn(
      `[jbDeterministic/singleWaferClusterBail] 单片空间聚集问题不出整 lot 表，交回 LLM；问「${userQuestion.slice(0, 40)}」。`
    );
    return false;
  }

  const payload = resolveJbToolPayload(
    sessionId,
    String(lastTool.content ?? ""),
    extractLotFromUserText(userQuestion)
      ? { preferredLot: extractLotFromUserText(userQuestion)! }
      : undefined
  );
  if (!payload) return false;

  // 多卡 / 多 lot 「单 lot 表答非所问」的 bail 已收口到 emitDeterministicJbTablesReply 入口
  // （统一守卫），summary 轮的单 lot 概况出口即下方 `return emitDeterministicJbTablesReply(...)`，
  // 会被守卫放行。
  return emitDeterministicJbTablesReply(
    sessionId,
    userQuestion,
    payload,
    agentConfig,
    emit
  );
}

/** 本轮（最后一条 user 之后）所有 query_jb_bins 工具结果命中的 distinct lot。 */
function collectQueryJbBinsLotsThisTurn(history: ChatMessage[]): string[] {
  const lots: string[] = [];
  const seen = new Set<string>();
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (m.role === "user") break;
    if (m.role !== "tool" || m.name !== "query_jb_bins") continue;
    try {
      const lot = String(
        (JSON.parse(String(m.content ?? "")) as Record<string, unknown>)["lot"] ?? ""
      ).trim();
      if (lot && !seen.has(lot)) { seen.add(lot); lots.push(lot); }
    } catch { /* non-JSON tool content (compacted) — skip */ }
  }
  return lots.reverse();
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
  toolResultMaxChars?: number,
  jbCacheJson?: string
): string {
  if (toolName === "query_jb_bins") {
    const cap = Math.min(maxHistoryChars, toolResultMaxChars ?? maxHistoryChars);
    if (jbCacheJson?.trim()) {
      return compactJbCacheForHistory(jbCacheJson, cap);
    }
    return compactJbBinsForHistory(rawContent, cap);
  }
  return rawContent.slice(0, maxHistoryChars);
}

function jbBinsYieldFallbackMessage(
  toolMsg: ChatMessage,
  userQuestion: string,
  sessionId: string
): string | null {
  if (
    planWaferMapRoute(sessionId, getHistory(sessionId), userQuestion, "user_turn")
      .skipJbDeterministicSummary
  ) {
    return null;
  }
  if (toolMsg.name === "aggregate_jb_bins") {
    const content = String(toolMsg.content ?? "");
    // 与 tryRunDeterministicJbSummary 共用同一渲染选择链（单一真相源），此处仅取字符串。
    const rendered = renderAggregateJbBinsResult(content, userQuestion, undefined);
    if (!rendered) return null;
    return rendered.withDataTitle
      ? `${DETERMINISTIC_DATA_SECTION_TITLE}\n\n${rendered.table}`
      : rendered.table;
  }
  if (toolMsg.name !== "query_jb_bins") return null;
  // 单片坏 die 空间聚集问题：交回 LLM，勿用整 lot 表兜底（见 tryRunDeterministicJbSummary 同名 bail）。
  if (isSingleWaferDieClusterQuestion(userQuestion)) return null;
  // 卡型级问题：单 lot 概况代表不了整卡型，勿兜底单 lot 表（误导）。
  if (isCardTypeLevelOverviewQuestion(userQuestion)) return null;
  const payload = resolveJbToolPayload(
    sessionId,
    String(toolMsg.content ?? "")
  );
  if (payload && jbWrappedIsEmptyQuery(payload)) return null;
  if (payload) {
    const listingCtx = buildLotListingContext(payload, getHistory(sessionId));
    const tables = buildDeterministicJbTables(userQuestion, payload, listingCtx);
    if (tables?.trim()) {
      return `${DETERMINISTIC_DATA_SECTION_TITLE}\n\n${tables}`;
    }
    const overview = formatLotYieldOverviewMarkdown(payload);
    if (overview) {
      return `${DETERMINISTIC_DATA_SECTION_TITLE}\n\n${overview}`;
    }
  }
  return formatSlotYieldMarkdownFromToolJson(String(toolMsg.content ?? ""));
}

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

/** 总结轮 LLM 空输出时：直出服务端表（无解读），避免「模型未返回分析结论」。 */
function finishWithJbServerTablesFallback(
  sessionId: string,
  userQuestion: string,
  emit: (event: AgentSseEvent) => void
): boolean {
  const lastTool = lastToolMessage(getHistory(sessionId));
  const rawFallback = lastTool
    ? jbBinsYieldFallbackMessage(lastTool, userQuestion, sessionId)
    : null;
  if (!rawFallback?.trim()) return false;
  const fallback = stampFirstTestNote(rawFallback);
  emit({ type: "status", message: "模型未生成文字，正在输出服务端预计算表…" });
  emitTextInChunks(fallback, emit);
  appendMessages(sessionId, { role: "assistant", content: fallback });
  emit({ type: "done" });
  return true;
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

// ── Tool schema selector ───────────────────────────────────────────────────

/**
 * INF wafer-map keywords (Chinese + English).
 * When any of these appear in the recent conversation, append INF tool schemas
 * to TOOL_SCHEMAS. Otherwise, keep the list lean (JB/Yield Monitor only).
 */
// Keywords that trigger injection of INF drawing tools (inf_draw_wafer_map / inf_draw_dut_bin_map).
// Only wafer-map drawing tools remain; all analysis tools have been removed from agent schemas.
const INF_KEYWORDS = [
  // Wafer map / visual output
  "晶圆图", "wafermap", "wafer map", "wafer图", "画晶圆",
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

function selectToolSchemas(messages: ChatMessage[]): unknown[] {
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

// ── Tool resource group for parallel execution ─────────────────────────────
// Tools in the same group share a connection pool and must run sequentially.
// Tools in different groups have independent I/O and can run concurrently.
// "probeweb" and "main" are separate Oracle pools — safe to run in parallel.
// "perl" tools invoke Perl scripts and have no Oracle dependency.
// "pure" tools (generate_chart, ask_clarification) do only in-process work.
type ToolResourceGroup = "probeweb" | "main" | "perl" | "pure";

function getToolResourceGroup(name: string): ToolResourceGroup {
  if (name === "query_yield_triggers" || name === "aggregate_yield_triggers") {
    return "probeweb";
  }
  if (
    name === "query_jb_bins" ||
    name === "aggregate_jb_bins" ||
    name === "get_filter_values"
  ) {
    return "main";
  }
  if (name === "generate_chart" || name === "ask_clarification") {
    return "pure";
  }
  // query_lot_dut_bin_agg, query_inf_site_bin_by_dut, inf_* — Perl / file I/O
  return "perl";
}

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

type SummaryContext = "jb" | "dual_source" | "generic";

/**
 * 根据本轮工具类型推断总结策略：
 * - dual_source：YM + JB 均有结果 → 按域分节
 * - generic：无 query_jb_bins → 通用结构化
 * - jb：只有 query_jb_bins（通常已被确定性表处理；LLM 兜底时用 JB 专用格式）
 */
function getSummaryContext(history: ChatMessage[]): SummaryContext {
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
  // Large-context models (≥200K) can hold ~80 messages before needing compression.
  const summarizeThreshold = agentConfig.largeContext ? 80 : undefined;
  if (needsSummarization(sessionId, summarizeThreshold)) {
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

  // 声明式有序直连调度表(范围 B / spec §4.2):取代原 5 条顺序 if。各 runner 内部 self-gate,
  // 顺序即优先级,与旧 if 链按构造等价(同序、同 runner、同门槛)。新增 pre-LLM 直连只需加进此数组。
  // 注:不按 detectJbReplyMode 的 mode 建表——mode 与 canRunXxx 门槛非 1:1(mode 更宽),
  // 按 mode 路由会把门槛不满足的问句误路由;有序 runner 列表才是真正等价的声明式形式。
  const PRE_LLM_DIRECT_ROUTES: Array<typeof tryRunLotListingDirectRoute> = [
    tryRunUnderperformingDutDirectRoute,
    tryRunGoodBinValueDirectRoute,
    tryRunProbeCardPerfDirectRoute,
    tryRunDutBinAggDirectRoute,
    tryRunBinLotRankingDirectRoute,
    tryRunLotListingDirectRoute,
    tryRunScopedBadBinDirectRoute,
    tryRunMaskScopeDirectRoute,
    tryRunLotOverviewDirectRoute,
    tryRunEquipmentDirectRoute,
    tryRunPerSlotBinRankingDirectRoute,
    tryRunSemanticDispatchDirectRoute,
    tryRunUnscopedBinClarifyDirectRoute,
  ];

  const maxRounds = agentConfig.maxRounds;
  // 首轮"只承诺查询、未真正调用工具"时的一次性纠正重试标记(跨 round 迭代持久)。
  let announcementNudgeUsed = false;
  for (let round = 0; round < maxRounds; round++) {
    const history = getHistory(sessionId);
    const summary = getSummary(sessionId);
    const awaitingSummary = historyAwaitingToolSummary(history);
    const summaryCtx: SummaryContext = awaitingSummary ? getSummaryContext(history) : "jb";
    const userQuestion = lastUserMessageText(history, message);

    const lastTool = lastToolMessage(history);
    const waferPlan = planWaferMapRoute(
      sessionId,
      history,
      userQuestion,
      awaitingSummary ? "after_jb_bins" : "user_turn",
      lastTool?.name,
      lastTool ? String(lastTool.content ?? "") : undefined
    );

    if (awaitingSummary && lotListingNeedsJbRecovery(userQuestion, lastTool?.name, history)) {
      const listingRecovered = await tryRunLotListingDirectRoute(
        sessionId,
        userQuestion,
        agentConfig,
        emit
      );
      if (listingRecovered) return;
    }

    if (awaitingSummary && scopedBadBinNeedsAggregateRecovery(userQuestion, lastTool?.name, history)) {
      const binRecovered = await tryRunScopedBadBinDirectRoute(
        sessionId,
        userQuestion,
        agentConfig,
        emit
      );
      if (binRecovered) return;
    }

    if (awaitingSummary && lotOverviewNeedsJbRecovery(userQuestion, lastTool?.name)) {
      const recovered = await tryRunLotOverviewDirectRoute(
        sessionId,
        userQuestion,
        agentConfig,
        emit
      );
      if (recovered) return;
    }

    if (isTestItemMappingQuestion(userQuestion)) {
      const msg =
        "BIN 编号与测试项的对应关系存储在测试程序（test program）中，JB STAR / Yield Monitor 数据库不包含该映射，系统无法告知 BIN 对应的具体测试项名称。\n\n" +
        "如需了解，请在 Uflex / J750 测试机上查阅 Pattern/Flow 定义，或联系测试工程师获取对应产品的测试程序文档。";
      emitTextInChunks(msg, emit);
      appendMessages(sessionId, { role: "assistant", content: msg });
      emit({ type: "done" });
      return;
    }

    if (!awaitingSummary) {
      // 有序直连调度:依次调用,首个返回 true 即结束;各 runner 内部 self-gate。
      // 等价于原 5 条顺序 if(同序、同 runner、同门槛)。范围 B / spec §4.2。
      for (const runDirectRoute of PRE_LLM_DIRECT_ROUTES) {
        if (await runDirectRoute(sessionId, userQuestion, agentConfig, emit)) return;
      }

      const dutBinDone = await tryRunDutBinMapDirectRoute(
        sessionId,
        userQuestion,
        emit
      );
      if (dutBinDone) return;

      // lot+slot 已知但 device 未知 → 自动 query_jb_bins 取 device，不经 LLM
      if (waferPlan.isWaferMapIntent && waferPlan.action.kind === "need_jb_lookup") {
        const autoDrawn = await tryRunWaferMapWithAutoDeviceLookup(
          sessionId,
          userQuestion,
          agentConfig,
          emit
        );
        if (autoDrawn) return;
      }

      const drawn = await applyWaferMapRoutePlan(
        sessionId,
        waferPlan,
        history,
        emit
      );
      if (drawn) return;
    } else if (waferPlan.isWaferMapIntent) {
      const drawn = await applyWaferMapRoutePlan(
        sessionId,
        waferPlan,
        history,
        emit
      );
      if (drawn) return;
    } else if (awaitingSummary && userWantsDutBinRelationMap(userQuestion) && lastTool?.name === "query_jb_bins") {
      // Summary 轮：query_jb_bins 已完成，尝试直接画 DUT×BIN 关系图
      const dutBinDone = await tryRunDutBinMapDirectRoute(sessionId, userQuestion, emit);
      if (dutBinDone) return;
      // 无法画图（通常缺少片号）— 给出明确提示而非输出 JB 表
      const msg = "已查询 JB 数据。画 DUT×BIN 关系图还需要**片号（slot/waferId）**，如「第5片」或「slot=14」，以及 BIN 编号。请补充后重试。";
      emitTextInChunks(msg, emit);
      appendMessages(sessionId, { role: "assistant", content: msg });
      emit({ type: "done" });
      return;
    } else if (awaitingSummary && userWantsDutYieldChart(userQuestion) && lastTool?.name === "inf_site_stats") {
      // Summary 轮：inf_site_stats 已完成，直接生成 DUT 良率柱状图
      const chartDone = await tryRunDutYieldChartDirectRoute(sessionId, userQuestion, history, emit);
      if (chartDone) return;
    } else if (
      awaitingSummary &&
      isTouchdownQuestion(userQuestion) &&
      (lastTool?.name === "query_jb_bins" || lastTool?.name === "aggregate_jb_bins")
    ) {
      // Touchdown 问题：JB 数据已拿到 device/lot，但 touch 数据在 INF 文件中，需逐片调用
      const jbPayload = resolveJbToolPayload(sessionId, String(lastTool.content ?? ""));
      const lot = jbPayload ? String(jbPayload["lot"] ?? "") : "";
      const device = jbPayload ? String(jbPayload["device"] ?? "") : "";
      const slotSet = new Set<number>();
      if (jbPayload) {
        const summary = (jbPayload["slotYieldSummary"] as Array<{ slot: number }> | undefined) ?? [];
        summary.forEach((r) => slotSet.add(r.slot));
      }
      const slots = [...slotSet].sort((a, b) => a - b);

      // 用户问题中已包含 slot 编号时，直接调 inf_touch_analysis，跳过引导轮
      const specifiedSlot = extractSlotFromUserText(userQuestion);
      if (specifiedSlot != null && device && lot) {
        emit({ type: "status", message: `正在查询 slot ${specifiedSlot} 的 touchdown 数据…` });
        try {
          const touchRaw = await runTool("inf_touch_analysis", { device, lot, slot: specifiedSlot });
          if (typeof touchRaw === "string") {
            const td = tryParseJsonish(touchRaw) as Record<string, unknown> | null;
            if (td && !td["note"]) {
              const totalDies = Number(td["total_dies"] ?? 0);
              const withData = Number(td["dies_with_touch_data"] ?? 0);
              const maxTouch = Number(td["max_touch"] ?? 0);
              const avgTouch = Number(td["avg_touch"] ?? 0);
              const highTouchCount = Number(td["high_touch_count"] ?? 0);
              const minTh = Number(td["min_touch_threshold"] ?? 2);
              const siteStats = (td["site_stats"] as Array<{ site: number; die_count: number; avg_touch: number; max_touch: number }> | undefined) ?? [];
              const byTouch = (td["by_touch_count"] as Array<{ touch_count: number; die_count: number; good_count: number; bad_count: number; yield: number }> | undefined) ?? [];
              const highPct = totalDies > 0 ? ((highTouchCount / totalDies) * 100).toFixed(1) : "0.0";

              const lines: string[] = [
                `**lot ${lot}**（${device}）**slot ${specifiedSlot} Touchdown（探针接触次数）分析**`,
                "",
                `- 总 die 数：${totalDies}，有接触数据：${withData}`,
                `- 平均接触次数：**${avgTouch.toFixed(2)}**，最大接触次数：**${maxTouch}**`,
                `- 高接触（≥${minTh}次）die 数：**${highTouchCount}**（占 ${highPct}%）`,
              ];

              if (byTouch.length > 0) {
                lines.push("", "**接触次数分布**", "");
                lines.push("| 接触次数 | die数 | 良品 | 坏品 | 良率% |");
                lines.push("|---:|---:|---:|---:|---:|");
                for (const r of byTouch) {
                  lines.push(`| ${r.touch_count} | ${r.die_count} | ${r.good_count} | ${r.bad_count} | ${(r.yield * 100).toFixed(1)}% |`);
                }
              }

              if (siteStats.length > 0) {
                lines.push("", "**各 DUT（site）接触次数**（按平均次数降序）", "");
                lines.push("| DUT | die数 | 平均接触次数 | 最大接触次数 |");
                lines.push("|---:|---:|---:|---:|");
                for (const s of siteStats) {
                  lines.push(`| DUT${s.site} | ${s.die_count} | ${s.avg_touch.toFixed(2)} | ${s.max_touch} |`);
                }
              }

              const highDuts = siteStats.filter((s) => s.avg_touch >= minTh);
              if (highDuts.length > 0) {
                lines.push("", `> ⚠ 高接触 DUT：${highDuts.map((s) => `DUT${s.site}（平均 ${s.avg_touch.toFixed(1)} 次）`).join("、")}，建议优先检查这些位号针尖状态。`);
              }

              const msg = lines.join("\n");
              emitTextInChunks(msg, emit);
              appendMessages(sessionId, { role: "assistant", content: msg });
              emit({ type: "done" });
              return;
            }
            // td["note"] 表示无数据，fall through to guidance
          }
        } catch {
          // inf_touch_analysis 调用失败，fall through to guidance
        }
      }

      const slotHint = slots.length > 0
        ? `，共 ${slots.length} 片（slot ${slots[0]}–${slots[slots.length - 1]}）`
        : "";
      const deviceHint = device ? `（${device}）` : "";
      const msg = [
        `已查询到 lot **${lot}**${deviceHint}${slotHint}。`,
        "",
        "**Touchdown（探针接触次数）** 记录在各片 wafer 的 INF 文件中，需逐片调用 `inf_touch_analysis` 查询，无法一次性返回全部片数据。",
        "",
        "请告知需要查哪几片（如「第1片」「slot 3、5、12」），我将逐片列出各 DUT 的平均接触次数统计。",
      ].join("\n");
      emitTextInChunks(msg, emit);
      appendMessages(sessionId, { role: "assistant", content: msg });
      emit({ type: "done" });
      return;
    }

    if (awaitingSummary && !waferPlan.skipJbDeterministicSummary) {
      // ── General pending query mechanism ──────────────────────────────────
      // When a two-step query reaches the summary round without its second tool
      // call having been executed (because the summary round blocks tool calls),
      // the registry detects the gap and executes the follow-up tool here.
      // We then `continue` so the next iteration has complete data for a proper
      // LLM summary — rather than an incomplete "I'll query later" response.
      const lastTool = lastToolMessage(getHistory(sessionId));
      if (lastTool) {
        const jbPayload = resolveJbToolPayload(sessionId, String(lastTool.content ?? ""));
        const pending = detectPendingQuery(
          userQuestion,
          lastTool.name ?? "",
          jbPayload ?? {},
          getHistory(sessionId)
        );
        if (pending) {
          emit({ type: "status", message: pending.statusLabel });
          emit({ type: "tool_start", name: pending.toolName, args: pending.args });
          try {
            const toolResult = await runTool(pending.toolName, pending.args, {
              toolResultMaxChars: agentConfig.toolResultMaxChars,
              history: getHistory(sessionId),
            });
            const rawContent =
              typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult);
            emit({
              type: "tool_result",
              name: pending.toolName,
              summary: rawContent.slice(0, 200),
            });
            appendMessages(sessionId, {
              role: "tool",
              name: pending.toolName,
              tool_call_id: `pending_${Date.now()}`,
              content: rawContent.slice(0, agentConfig.toolResultMaxChars),
            });
            // History now has complete data; loop back so the next round
            // (still a summary round) has everything needed for a full answer.
            continue;
          } catch {
            // Pending query failed — fall through to deterministic routes / LLM summary
          }
        }
      }

      // ── Specialised deterministic routes (formatted output + LLM commentary) ──
      // DUT×BIN 自动聚合路由：用户问"哪个 DUT 的 BIN X 最多"，query_jb_bins 已得到
      // device/lot，自动调 query_lot_dut_bin_agg，避免 LLM 在总结轮承诺查询却无法执行。
      const dutBinHandled = await tryRunDutBinAggAutoRoute(
        sessionId,
        userQuestion,
        agentConfig,
        emit
      );
      if (dutBinHandled) return;

      const probeCardPerfHandled = await tryRunDeterministicProbeCardPerfSummary(
        sessionId,
        userQuestion,
        agentConfig,
        emit
      );
      if (probeCardPerfHandled) return;

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
      !sessionCanDrawDutBinMap(history, userQuestion)
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
    const systemContent = awaitingSummary
      ? `${basePrompt}\n\n${SUMMARIZE_NUDGE}${summarySuffix}`
      : `${basePrompt}${waferJbNudge}${dutBinNudge}${dutYieldChartNudge}${lotOverviewNudge}${announcementNudge}`;

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

    // Summary round: do NOT send tool schemas. Sending schemas with tool_choice:"none"
    // causes some models (e.g. DeepSeek-V4-Pro) to still emit structured tool_calls,
    // which get blocked by the guard below and leave textBuffer empty → error.
    // Without schemas the model is forced to produce text.
    // Explicit format instruction as the final user-turn — DeepSeek-V4-Pro
    // responds more reliably to a user-role reminder than to system nudge alone.
    // Content varies by summaryCtx so the model knows the exact expected structure.

    // When tools returned empty/zero results, inject a natural-language fallback hint so
    // the LLM produces its own "no data found" explanation instead of returning nothing
    // and triggering a hardcoded server-side message.
    const emptyResultHint = isLastToolEmptyResult(lastTool)
      ? "\n\n【工具返回空结果】上述工具未查到任何记录。请直接用自然语言告知用户未找到数据，" +
        "分析可能原因（如筛选条件过窄、时间范围不含数据），并给出 1–2 条排查建议。" +
        "不要强制使用固定分节结构，不要编造数据。"
      : "";

    const summaryUserNudge: ChatMessage = {
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
    await streamSiliconFlow(
      awaitingSummary
        ? {
            model: agentConfig.model,
            messages: [...messages, summaryUserNudge],
            // Summary round is text-only. Large-context models (128K max output) can
            // produce much longer analyses; 16384 gives room for multi-lot tables.
            // Smaller-context models get 4096 (≈3000 Chinese words), which is ample.
            max_tokens: agentConfig.largeContext ? 16384 : 4096,
          }
        : {
            model: agentConfig.model,
            messages,
            tools: selectToolSchemas(messages) as unknown as unknown[],
            tool_choice: "auto",
            // 8192 for tool rounds: model may emit long tool arguments or interleave
            // analysis text with tool calls.
            max_tokens: 8192,
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
            if (
              finishWithJbServerTablesFallback(sessionId, userQuestion, emit)
            ) {
              return;
            }
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
      // 首轮模型只承诺"马上查"却未真正调用工具(见 agentPrompt.ts 硬规则)——
      // 代码兜底重试一次:不落盘这条未完成的文字,加强系统提示后重新请求,而不是把
      // "确认性文字"当成最终答案直接结束整轮对话。
      if (
        !awaitingSummary &&
        !announcementNudgeUsed &&
        round < maxRounds - 1 &&
        questionHasIdentifiableToolScope(userQuestion)
      ) {
        announcementNudgeUsed = true;
        emit({ type: "status", message: "检测到尚未真正查询，正在重新调用工具…" });
        continue;
      }
      if (awaitingSummary && !textBuffer.trim()) {
        const lastTool = lastToolMessage(getHistory(sessionId));
        if (lastTool?.name === "generate_chart") {
          const note = chartToolFallbackMessage(lastTool);
          appendMessages(sessionId, { role: "assistant", content: note });
          emit({ type: "text", delta: note });
          emit({ type: "done" });
          return;
        }
        if (finishWithJbServerTablesFallback(sessionId, userQuestion, emit)) {
          return;
        }
        emit({
          type: "error",
          message:
            "模型未返回分析结论（工具数据已在上方）。请点「重试」，或缩小查询范围后重新提问。",
        });
        return;
      }
      // Fact check: verify the LLM's conclusion against tool-result data (summary round only).
      // Log mismatches server-side only — the text is already streamed to the client, and
      // appending a visible correction note confuses users (they see contradictory text).
      if (awaitingSummary && textBuffer.trim()) {
        const facts = buildFactSheetFromHistory(getHistory(sessionId));
        const checkResult = factCheckSummaryText(textBuffer, facts);
        if (!checkResult.ok) {
          console.warn(`[factchecker/${sessionId}] ${checkResult.issue}`);
        }
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

    // Execute tools — same-pool tools sequential, cross-pool tools concurrent.
    // SSE events (tool_start / tool_result / chart / clarification) are emitted
    // as each tool completes. Tool messages are appended to history in the
    // original tool_calls order after all tools finish so the next LLM round
    // sees a consistent sequence regardless of execution order.
    //
    // Parallelism is safe because:
    //   • "probeweb" (withProbeWebConnection) and "main" (withConnection) are
    //     independent Oracle pools — concurrent use does not exceed per-pool limits.
    //   • "perl" tools invoke Perl scripts with no Oracle dependency.
    //   • "pure" tools (generate_chart, ask_clarification) are in-process only.
    //   Tools within the same group always run sequentially (pool constraint).
    type ToolRunResult = { historyContent: string; callId: string; toolName: string };
    const toolRunResults: ToolRunResult[] = new Array(toolCalls.length);

    type ToolSlot = {
      tc: CollectedToolCall;
      tcIdx: number;
      parsedArgs: Record<string, unknown>;
      callId: string;
    };
    const resourceGroups = new Map<ToolResourceGroup, ToolSlot[]>();
    for (let tcIdx = 0; tcIdx < toolCalls.length; tcIdx++) {
      const tc = toolCalls[tcIdx];
      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = JSON.parse(tc.args || "{}") as Record<string, unknown>;
      } catch {
        parsedArgs = {};
      }
      const callId = assistantToolCalls[tcIdx]?.id ?? `call_${round}_${tc.index}`;
      const group = getToolResourceGroup(tc.name);
      if (!resourceGroups.has(group)) resourceGroups.set(group, []);
      resourceGroups.get(group)!.push({ tc, tcIdx, parsedArgs, callId });
    }

    await Promise.all(
      Array.from(resourceGroups.values()).map(async (slots) => {
        for (const { tc, tcIdx, parsedArgs, callId } of slots) {
          // Auto-correct known arg mistakes before execution (prefer rules here
          // over prompt rules — see agentToolValidator.ts for the rationale).
          const { args: fixedArgs, notes: validatorNotes } = validateAndFixToolArgs(
            tc.name, parsedArgs, userQuestion
          );
          if (validatorNotes.length > 0) {
            // Transparently log what was fixed; parsedArgs in tool_start shows the FIXED args
            // so the LLM history reflects what was actually executed.
            console.log(`[validator] ${tc.name}: ${validatorNotes.join("; ")}`);
          }

          emit({ type: "tool_start", name: tc.name, args: fixedArgs });
          emit({ type: "status", message: `正在${toolStatusLabel(tc.name)}…` });

          let historyContent: string;
          let jbCacheForHistory: string | undefined;
          try {
            const toolResult = await runTool(tc.name, fixedArgs, {
              toolResultMaxChars: agentConfig.toolResultMaxChars,
              history: getHistory(sessionId),
              onJbBinsWrapped: (wrapped) => {
                jbCacheForHistory = storeJbQuerySessionCache(sessionId, wrapped);
              },
              onUnderperformingDuts: (passes) => {
                tryEmitUnderperformingDutScatter(passes, emit);
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
              const clarOptions = (toolResult as ClarificationSentinel).__clarification_options;
              emit({ type: "clarification", question, ...(clarOptions ? { options: clarOptions } : {}) });
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
                agentConfig.toolResultMaxChars,
                jbCacheForHistory
              );
            }
          } catch (err) {
            historyContent = `工具执行失败: ${err instanceof Error ? err.message : String(err)}`;
          }

          emit({ type: "tool_result", name: tc.name, summary: historyContent.slice(0, 200) });
          toolRunResults[tcIdx] = { historyContent, callId, toolName: tc.name };
        }
      })
    );

    // Append tool messages in original order (tool_call_id must align with
    // the assistant's tool_calls sequence for all LLM providers)
    for (const result of toolRunResults) {
      appendMessages(sessionId, {
        role: "tool",
        tool_call_id: result.callId,
        name: result.toolName,
        content: result.historyContent,
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
