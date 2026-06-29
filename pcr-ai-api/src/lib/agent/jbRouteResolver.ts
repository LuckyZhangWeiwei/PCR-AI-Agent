import {
  type JbReplyMode,
  detectJbReplyMode,
  extractBinFromUserText,
  extractSlotFromUserText,
  extractJbIntentFlags,
} from "./agentJbDeterministicReply.js";
import { extractLotFromUserText } from "./agentInfWaferMapTool.js";
import { callJbIntentClassifier, type ChatFn } from "./jbIntentClassifier.js";
import type { AgentConfig } from "./agentConfig.js";

export interface JbRouteParams {
  focusBin?: number;
  slot?: number;
  lot?: string;
  cardId?: string;
  passId?: number;
}

export interface JbRouteDecision {
  mode: JbReplyMode;
  source: "regex" | "llm" | "default";
  confidence: "high" | "low";
  params: JbRouteParams;
  reason: string;
  isMultiCardCompare: boolean;
  isMultiLotCompare: boolean;
  isDutLevel: boolean;
}

const CARD_ID_RE = /\b(\d{4}-\d{2,3})\b/;

export function extractJbRouteParams(q: string): JbRouteParams {
  const params: JbRouteParams = {};
  const bin = extractBinFromUserText(q);
  if (bin != null) params.focusBin = bin;
  const slot = extractSlotFromUserText(q);
  if (slot != null) params.slot = slot;
  const lot = extractLotFromUserText(q);
  if (lot) params.lot = lot;
  const card = CARD_ID_RE.exec(q)?.[1];
  if (card) params.cardId = card;
  if (/常温|sort\s*1|pass\s*1/i.test(q)) params.passId = 1;
  else if (/高温|sort\s*2|pass\s*3/i.test(q)) params.passId = 3;
  else if (/低温|sort\s*3|pass\s*5/i.test(q)) params.passId = 5;
  return params;
}

export function resolveJbRoute(
  q: string,
  _history?: unknown,
  _payload?: Record<string, unknown>
): JbRouteDecision {
  const mode = detectJbReplyMode(q);
  return {
    mode,
    source: "regex",
    confidence: "high",
    params: extractJbRouteParams(q),
    reason: `detectJbReplyMode → ${mode}`,
    ...extractJbIntentFlags(q),
  };
}

function isAmbiguous(q: string): boolean {
  // 无 lot 锚点 → 模糊,才进 LLM 兜底;有明确 lot 号的同步已足够。
  // 复用 extractLotFromUserText(与 params 抽取同源),避免再写一份 lot 正则导致长期漂移。
  return !extractLotFromUserText(q);
}

export async function classifyJbIntent(
  q: string,
  ctx: { lastToolName?: string; cachedLot?: string },
  agentConfig: AgentConfig,
  deps?: { chat?: ChatFn },
  history?: unknown,
  payload?: Record<string, unknown>
): Promise<JbRouteDecision> {
  const base = resolveJbRoute(q, history, payload);
  if (process.env.JB_LLM_INTENT_CLASSIFIER !== "true") return base;
  if (base.mode !== "generic" || !isAmbiguous(q)) return base; // 高置信快路
  const r = await callJbIntentClassifier(q, ctx, agentConfig, deps);
  if (!r) {
    return { ...base, source: "default", confidence: "low", reason: "LLM 分类失败,降级 generic" };
  }
  return {
    ...base,
    mode: r.mode,
    source: "llm",
    confidence: r.confidence,
    params: { ...base.params, ...r.params },
    reason: `LLM 分类 → ${r.mode}`,
    // LLM 返回 flag 则采用,否则继承正则 base
    isMultiCardCompare: r.flags?.isMultiCardCompare ?? base.isMultiCardCompare,
    isMultiLotCompare: r.flags?.isMultiLotCompare ?? base.isMultiLotCompare,
    isDutLevel: r.flags?.isDutLevel ?? base.isDutLevel,
  };
}

/** @deprecated 旧名,等价 classifyJbIntent。 */
export const resolveJbRouteAsync = classifyJbIntent;
