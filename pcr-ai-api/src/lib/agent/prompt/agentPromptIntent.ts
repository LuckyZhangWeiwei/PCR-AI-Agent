// pcr-ai-api/src/lib/agent/prompt/agentPromptIntent.ts
//
// Intent classification for the system prompt builder — infers which
// PromptIntent bucket a user question falls into so buildSystemPrompt()
// (agentPrompt.ts) can inject only the relevant sections.
// Extracted from the original agentPrompt.ts (Task 10 split) — pure move,
// no behavior change.

// ─── intent classification ──────────────────────────────────────────────────

/**
 * Intent inferred from the user message. Controls which prompt sections are
 * injected this turn — sections irrelevant to the intent are omitted to keep
 * the prompt lean and improve model compliance on the sections that remain.
 *
 * - lot_bin        : analyzing a specific lot's bin / yield / slot data
 * - dut_analysis   : which DUT has the most BIN X / DUT distribution focus
 * - mask_query     : device discovery by 4-char mask token (e.g. "N84R")
 * - card_probe     : probe-card health / Yield Monitor trigger queries
 * - wafer_map      : wafer map / cluster / die-distribution view
 * - platform_query : tester platform (PS16/J750/FLEX/UFLEX…) overview query
 * - general        : fallback — core sections only (lean prompt for ambiguous queries)
 */
export type PromptIntent =
  | "lot_bin"
  | "dut_analysis"
  | "mask_query"
  | "card_probe"
  | "wafer_map"
  | "platform_query"
  | "general";

/**
 * Classify the user's intent from the current message (and optional first
 * session message for follow-up context). Returns "general" when uncertain.
 */
export function classifyIntent(userQuestion: string, historyFirst?: string): PromptIntent {
  const raw = userQuestion.trim();
  const q = raw.toLowerCase();

  // Short follow-ups ("1", "好的", "继续", "是" — ≤6 chars) inherit the intent
  // from the original question that started this session.
  if (raw.length <= 6 && historyFirst && historyFirst !== raw) {
    return classifyIntent(historyFirst);
  }

  // Wafer map / cluster / die distribution (highest priority)
  if (/晶圆图|wafer\s*map|cluster|聚集|die\s*(坐标|分布)|inf_draw/.test(q)) return "wafer_map";

  // Platform query: PS16 / J750 / FLEX / UFLEX family + test/yield keyword (no lot ID)
  if (
    !/\b[A-Z]{2}\d{5}\.\d[A-Z]\b/.test(raw) &&
    /\b(?:ps16|ps1600|ps\s*16|j750|uflex|flex|mst|93k)\b/i.test(q) &&
    /测试|情况|platform|平台|die|良率|yield|lot|device|坏\s*bin/i.test(q)
  ) return "platform_query";

  // Probe-card health / Yield Monitor trigger queries / combo ranking / degradation trend / bad-bin frequency
  if (/探针卡|probe\s*card|哪张卡|卡号|最差.*(?:卡|card)|报警最多|yield\s*monitor|触发次数|ym触发|dut.*不均|组合排名|探针卡排名|最佳组合|最佳搭配|表现排名|接触不良|卡.*(?:退化|变差|趋势|稳定性)|(?:退化|变差|趋势|稳定性).*卡/.test(q)) return "card_probe";

  // DUT-level analysis: "哪个DUT的BIN8最多", "BIN8集中在哪些DUT", "各DUT分布"
  // Must have both a DUT/site keyword AND a BIN/fail keyword
  if (
    /(?:dut|触点|site)\d*\s*.*(?:bin\d+|fail|坏)|(?:bin\d+|fail|坏).*(?:dut|触点|site)|各\s*dut|dut\s*分布|哪个\s*dut|哪些\s*dut/i.test(q)
  ) {
    // Require either a lot ID or a bin number — otherwise too ambiguous
    if (/\b[A-Z]{2}\d{5}\.\d[A-Z]\b/.test(raw) || /\bbin\s*\d+/i.test(q)) {
      return "dut_analysis";
    }
  }

  // Lot ID present (XX12345.1X) → lot + bin analysis
  if (/\b[A-Z]{2}\d{5}\.\d[A-Z]\b/.test(raw)) return "lot_bin";

  // Standalone 4-char mask token (N84R, P02G…) without a lot ID
  // Exclude BINxx names and tokens embedded in longer identifiers
  if (/(?<!\w)(?!BIN\d)[A-Z][A-Z0-9]{3}(?!\w)/.test(raw)) return "mask_query";

  // Generic lot/bin keywords without a specific lot ID
  if (/\blot\b|批次|bin\d+|坏.?bin|良率分析|yield.*分析/.test(q)) return "lot_bin";

  // Device code (WA-prefix, 8+ chars: WA88888822N95G) — same sections as mask_query.
  // Without this, device-only questions fall to "general" and get the full prompt for no reason.
  if (/\bWA[A-Z0-9]{6,}\b/.test(raw)) return "mask_query";

  return "general";
}

