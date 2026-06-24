/**
 * Pre-execution tool argument validator.
 *
 * Catches and auto-corrects high-frequency argument errors BEFORE runTool().
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * ARCHITECTURAL NOTE — prefer adding rules HERE over adding rules in agentPrompt.ts.
 *
 * The prompt is a human-readable instruction document; it cannot enforce invariants.
 * Every new prohibition in the prompt is a debt item: the LLM may ignore it, and
 * future engineers must know to check there. A validator rule here:
 *   • executes unconditionally (not subject to model compliance)
 *   • is unit-testable
 *   • is colocated with the error class it prevents
 *   • does not grow the system prompt
 *
 * Validator rules must be:
 *   - Additive: only fire on clearly-wrong inputs; never block correct calls
 *   - Silent: fix transparently; no user-visible change for correct calls
 *   - Synchronous: no I/O, no async, no side-effects
 * ──────────────────────────────────────────────────────────────────────────────
 */

export type ValidatorResult = {
  args: Record<string, unknown>;
  /** Non-empty when at least one arg was auto-corrected. For logging only. */
  notes: string[];
};

/**
 * Validates and auto-corrects tool arguments before execution.
 * Returns corrected args (identical to input when no issues found).
 */
export function validateAndFixToolArgs(
  toolName: string,
  args: Record<string, unknown>,
  userQuestion: string
): ValidatorResult {
  const notes: string[] = [];
  const a = { ...args };

  // ── query_jb_bins ─────────────────────────────────────────────────────────

  if (toolName === "query_jb_bins") {
    // Rule 1: limit clamp — API max is 200; model sometimes uses 1000+
    const lim = Number(a["limit"]);
    if (Number.isFinite(lim) && lim > 200) {
      a["limit"] = 200;
      notes.push(`limit ${lim} → 200（API max）`);
    }

    // Rule 2: cardId injection
    // When the user asks about a specific probe card (dddd-dd, e.g. "6045-10") but the model
    // called query_jb_bins without cardId — most common cause: model copied device from a YM
    // result and omitted cardId, returning ALL lots for that device instead of card-specific ones.
    // Only inject when the call has no lot-level scope (lot-specific queries don't need cardId).
    const hasCardId = Boolean(String(a["cardId"] ?? "").trim());
    const hasLot    = Boolean(String(a["lot"]    ?? "").trim());
    if (!hasCardId && !hasLot) {
      const m = userQuestion.match(/\b(\d{4}-\d{2})\b/);
      if (m) {
        a["cardId"] = m[1];
        notes.push(`cardId:"${m[1]}" 自动注入（问题含探针卡编号，model 未传 cardId）`);
      }
    }
  }

  // ── query_yield_triggers ──────────────────────────────────────────────────

  if (toolName === "query_yield_triggers") {
    const lim = Number(a["limit"]);
    if (Number.isFinite(lim) && lim > 200) {
      a["limit"] = 200;
      notes.push(`limit ${lim} → 200（API max）`);
    }
  }

  // ── aggregate_jb_bins ─────────────────────────────────────────────────────

  if (toolName === "aggregate_jb_bins") {
    const gTop = Number(a["groupTop"]);
    if (Number.isFinite(gTop) && gTop > 50) {
      a["groupTop"] = 50;
      notes.push(`groupTop ${gTop} → 50（API max）`);
    }
  }

  return { args: a, notes };
}
