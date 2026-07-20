/** Agent list tools (`query_jb_bins` / `query_yield_triggers`) default when `limit` omitted. */
export const AGENT_TOOL_LIST_LIMIT_DEFAULT = 50;

/**
 * Agent list tools max `limit` (JB + YM). Raised 200→500 (2026-07-20).
 * REST v3/v4 list max remains higher (`API_V3_LIST_LIMIT_MAX`). Lot-scoped JB
 * and small multi-lot listing (≤20 distinct lots) still fetch full matching rows.
 *
 * Kept in a tiny module so validator / tools can import without circular deps
 * through `agentToolHandlers.ts`.
 */
export const AGENT_TOOL_LIST_LIMIT_MAX = 500;
