/**
 * Summary-round fact checker.
 *
 * After the LLM produces its conclusion text, verify that:
 *   1. Any lot IDs mentioned in the text actually came from tool results
 *      (prevents cross-tool lot-label confusion and hallucinated lot IDs)
 *   2. Lot count claims ("共 N 个 lot") match the authoritative totalDistinctLots
 *      from query_jb_bins (prevents lot-count hallucination)
 *
 * On a mismatch, a visible correction note is appended to the response so the
 * user can see it immediately without waiting for a retry.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * DESIGN NOTES
 *
 * We do NOT retry on fact-check failure because:
 *   • The text is already streaming to the client — we cannot unsend it.
 *   • A correction note is less disruptive than an abrupt stream cut + restart.
 *   • One retry without a stronger model tends to produce the same mistake.
 *
 * False-positive risk mitigation:
 *   • Lot count check allows ±1 tolerance (off-by-one in "≥N 个 lot" phrasing).
 *   • Lot ID check only fires when knownLots is non-empty; an empty fact sheet
 *     (e.g. only non-JSON tool results) never flags anything.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import type { ChatMessage } from "./agentHistory.js";
import { tryParseJsonish } from "./agentChartTool.js";

export type FactSheet = {
  /** All lot IDs seen in any tool result (authoritative ground truth). */
  knownLots: Set<string>;
  /** totalDistinctLots from query_jb_bins, if present. */
  totalDistinctLots: number | null;
};

export type FactCheckResult =
  | { ok: true }
  | { ok: false; issue: string };

/** Build a fact sheet from the tool-result messages in the session history. */
export function buildFactSheetFromHistory(history: ChatMessage[]): FactSheet {
  const knownLots = new Set<string>();
  let totalDistinctLots: number | null = null;

  for (const msg of history) {
    if (msg.role !== "tool") continue;
    const content = typeof msg.content === "string" ? msg.content : "";
    if (!content.trim().startsWith("{")) continue;

    const parsed = tryParseJsonish(content) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object") continue;

    // Primary lot from query_jb_bins
    const lot = String(parsed["lot"] ?? "").trim();
    if (lot) knownLots.add(lot);

    // recentLotsByTestEnd (array of {lot, ...})
    const recent = parsed["recentLotsByTestEnd"];
    if (Array.isArray(recent)) {
      for (const r of recent as Array<Record<string, unknown>>) {
        const l = String(r["lot"] ?? "").trim();
        if (l) knownLots.add(l);
      }
    }

    // Yield monitor rows — LOTID field
    const rows = parsed["rows"];
    if (Array.isArray(rows)) {
      for (const row of rows as Array<Record<string, unknown>>) {
        const l = String(row["LOTID"] ?? "").trim();
        if (l) knownLots.add(l);
      }
    }

    // lotYieldRankByTestEnd
    const rank = parsed["lotYieldRankByTestEnd"];
    if (Array.isArray(rank)) {
      for (const r of rank as Array<Record<string, unknown>>) {
        const l = String(r["lot"] ?? "").trim();
        if (l) knownLots.add(l);
      }
    }

    // totalDistinctLots — authoritative JB lot count (takes the first seen value)
    if (totalDistinctLots === null) {
      const tdk = parsed["totalDistinctLots"] ?? parsed["distinctLotCount"];
      if (typeof tdk === "number") totalDistinctLots = tdk;
    }
  }

  return { knownLots, totalDistinctLots };
}

/** Lot ID pattern: two uppercase letters + 5 digits + dot + digit + letter */
const LOT_PATTERN = /\b([A-Z]{2}\d{5}\.\d[A-Z])\b/g;

/** "共 N 个 lot" / "N 个批次" / "N 批次" patterns */
const LOT_COUNT_PATTERNS = [
  /共\s*(\d+)\s*个?\s*lot/,
  /共\s*(\d+)\s*个?批次/,
  /共\s*(\d+)\s*批次/,
  /共\s*(\d+)\s*个?\s*批/,
  /测试了?\s*(\d+)\s*个?\s*lot/,
];

/**
 * Check the LLM's summary text against the fact sheet.
 * Returns ok:false with an issue description if a verifiable claim is wrong.
 */
export function factCheckSummaryText(text: string, facts: FactSheet): FactCheckResult {
  // ── Check 1: lot IDs in text must exist in tool results ─────────────────
  if (facts.knownLots.size > 0) {
    const mentionedLots = [...text.matchAll(LOT_PATTERN)].map((m) => m[1]!);
    for (const lot of mentionedLots) {
      if (!facts.knownLots.has(lot)) {
        const known = [...facts.knownLots].slice(0, 5).join("、");
        return {
          ok: false,
          issue:
            `结论中出现了 lot **${lot}**，但该 lot 未出现在任何工具返回数据中` +
            `（工具数据中的 lot：${known}${facts.knownLots.size > 5 ? " 等" : ""}）。` +
            `如需引用 lot，请仅使用工具数据中实际存在的批次号。`,
        };
      }
    }
  }

  // ── Check 2: lot count claims vs totalDistinctLots ──────────────────────
  if (facts.totalDistinctLots !== null) {
    for (const pat of LOT_COUNT_PATTERNS) {
      const m = text.match(pat);
      if (m) {
        const claimed = parseInt(m[1]!);
        // Allow ±1 tolerance for phrasing like "超过 N 个 lot" rounding
        if (Math.abs(claimed - facts.totalDistinctLots) > 1) {
          return {
            ok: false,
            issue:
              `结论称"共 ${claimed} 个 lot"，但工具数据 totalDistinctLots = **${facts.totalDistinctLots}**。` +
              `lot 总数必须来自工具返回的 totalDistinctLots 字段，不得自行估算。`,
          };
        }
        break; // Only need to catch one count claim per message
      }
    }
  }

  return { ok: true };
}

/** Format the correction note appended after the LLM text. */
export function formatFactCheckNote(issue: string): string {
  return `\n\n> ⚠️ **数据核实提示**：${issue}`;
}
