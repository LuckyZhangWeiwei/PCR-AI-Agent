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

// String filter fields that are meaningless when empty.
// Models sometimes fill every schema field with "", which clutters logs and can confuse handlers.
const STRING_FILTER_KEYS = new Set([
  "cardId", "device", "lot", "mask", "probeCardType", "testerId", "meslot",
  "testEndFrom", "testEndTo", "timeFrom", "timeTo", "lotId", "hostname", "wafer", "probeCard",
  "tstype",
]);

// Platform (tstype) alias → canonical TSTYPE value.
// Users say "ps/ps16/ps1600", "flex/uflex/750/j750" etc.; normalize before sending to API.
const TSTYPE_ALIASES: Record<string, string> = {
  ps: "PS16", ps16: "PS16", ps1600: "PS16",
  "750": "J750", j750: "J750",
  flex: "FLEX",
  uflex: "UFLEX",
  mst: "MST",
  "93k": "93K", "93000": "93K",
};

// Numeric filter fields where 0 means "no filter" — omit to avoid unintended scope.
const NUMERIC_ZERO_FILTER_KEYS = new Set(["passId", "slot", "pass"]);

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

  // Strip empty-string and zero-valued filter params that models fill from schema defaults.
  const stripped: string[] = [];
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string" && v === "" && STRING_FILTER_KEYS.has(k)) {
      stripped.push(k);
    } else if (typeof v === "number" && v === 0 && NUMERIC_ZERO_FILTER_KEYS.has(k)) {
      stripped.push(k);
    } else {
      cleaned[k] = v;
    }
  }
  if (stripped.length > 0) {
    notes.push(`已移除空参数: ${stripped.join(", ")}`);
  }

  const a = { ...cleaned };

  // ── tstype alias normalization (both query_jb_bins and aggregate_jb_bins) ─
  if (typeof a["tstype"] === "string") {
    const raw = (a["tstype"] as string).trim().toLowerCase();
    const canonical = TSTYPE_ALIASES[raw] ?? raw.toUpperCase();
    if (canonical !== a["tstype"]) {
      notes.push(`tstype "${a["tstype"]}" → "${canonical}"`);
      a["tstype"] = canonical;
    }
  }

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
