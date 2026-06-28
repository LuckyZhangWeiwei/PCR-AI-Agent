import {
  type JbReplyMode,
  detectJbReplyMode,
  extractBinFromUserText,
  extractSlotFromUserText,
} from "./agentJbDeterministicReply.js";
import { extractLotFromUserText } from "./agentInfWaferMapTool.js";

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
  };
}
