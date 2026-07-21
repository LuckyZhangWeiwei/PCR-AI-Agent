// pcr-ai-api/src/lib/agent/core/veroAgentLoopConfig.ts
// Calibration constants for the Vero-driven generic agent loop (128K context).
// See docs/superpowers/specs/2026-07-21-vero-generic-agent-loop-design.md §4.
// Values are initial estimates — flagged in the spec (§8) as needing real-Vero
// tuning once Cursor observes actual output quality/size against these numbers.

/**
 * Message-count threshold before cross-turn history summarization kicks in
 * (passed to agentHistory.ts's needsSummarization). Lower than the
 * SiliconFlow large-context bucket's 80 (calibrated for MiniMax-M2.5's 192K)
 * because Claude 4.6 via Vero is 128K.
 */
export const VERO_SUMMARIZE_THRESHOLD = 60;

/** Max chars kept per tool result when appended to session history (agentLoopShared.ts's toolResultForHistory). */
export const VERO_TOOL_RESULT_MAX_HISTORY_CHARS = 15000;

/**
 * Conservative character-budget ceiling for a single prompt string sent to
 * Vero (system + summary + history + latest tool result). Vero has no
 * messages[] array — the whole round is one prompt string — so this guards
 * against a single turn's rounds piling up tool results past what 128K
 * tokens can safely hold (leaving room for the model's own output).
 */
export const VERO_PROMPT_CHAR_BUDGET = 180_000;
