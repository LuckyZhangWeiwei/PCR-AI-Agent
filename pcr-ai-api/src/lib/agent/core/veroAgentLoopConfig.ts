// pcr-ai-api/src/lib/agent/core/veroAgentLoopConfig.ts
// Calibration constants for the Vero-driven generic agent loop.
// See docs/superpowers/specs/2026-07-21-vero-generic-agent-loop-design.md §4.
//
// Originally estimated off an unverified "Claude 4.6, 128K" assumption from a
// 2026-07-21 chat aside. Corrected 2026-07-22 once the platform's real
// context window was measured (GET /api/usage/current-session ->
// context_window_max=200000) and documented in
// docs/HANDOFF_CURSOR_WCHAT_MIGRATION_OPTIMAL_2026-07-22.md §2.1 — WChat caps
// what it feeds the model at 200K regardless of the underlying Bedrock
// model's own (much larger) capacity. 200K is close enough to the existing
// SiliconFlow large-context bucket's 192K (MiniMax-M2.5) that these now
// track that bucket's constants directly instead of a fraction of them.
// Cursor's live test (docs/HANDOFF_CURSOR_VERO_GENERIC_LOOP_TEST_RESULTS.md
// §4) saw real single-round prompts of ~72K-84K chars against the old 180K
// budget — comfortably under either the old or the corrected ceiling, so
// this is not yet cross-checked against a real prompt that actually
// approaches 200K tokens.

/**
 * Message-count threshold before cross-turn history summarization kicks in
 * (passed to agentHistory.ts's needsSummarization). Matches the SiliconFlow
 * large-context bucket's 80 (agentLoopSetup.ts, calibrated for
 * MiniMax-M2.5's 192K) now that Vero's real 200K is in the same ballpark.
 */
export const VERO_SUMMARIZE_THRESHOLD = 80;

/** Max chars kept per tool result when appended to session history (agentLoopShared.ts's toolResultForHistory). Matches LARGE_CTX_TOOL_RESULT_MAX_HISTORY_CHARS (agentConfig.ts). */
export const VERO_TOOL_RESULT_MAX_HISTORY_CHARS = 20000;

/**
 * Conservative character-budget ceiling for a single prompt string sent to
 * Vero (system + summary + history + latest tool result). Vero has no
 * messages[] array — the whole round is one prompt string — so this guards
 * against a single turn's rounds piling up tool results past what 200K
 * tokens can safely hold (leaving room for the model's own output).
 */
export const VERO_PROMPT_CHAR_BUDGET = 280_000;
