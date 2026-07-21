# Task 1 Report: Vero generic-loop flag + calibration constants

## Status: DONE

## Commits Created

- `d2229d9` — feat(agent): add Vero generic-loop flag + 128K calibration constants
  (originally committed as `64d06e0` in a stray isolated worktree the implementer
  subagent created due to a controller dispatch mistake — `isolation: "worktree"`
  was passed even though the controller had already set up a shared worktree via
  EnterWorktree; the commit was cherry-picked cleanly onto the correct worktree
  branch `worktree-vero-generic-agent-loop`, and the stray worktree/branch were
  removed. No code content was affected by this — only the commit's replay location.)

## What Was Implemented

1. `pcr-ai-api/src/lib/vero/veroSimpleAgent.ts` — added `isVeroGenericLoopEnabled()`
   and `isVeroGenericLoopReady()` directly below the existing `isProbeCardVeroPilotReady`,
   mirroring its exact pattern (same `isEnvTruthy` + `getVeroAccessToken` composition).
2. `pcr-ai-api/src/lib/agent/core/veroAgentLoopConfig.ts` (new) — three calibration
   constants: `VERO_SUMMARIZE_THRESHOLD = 60`, `VERO_TOOL_RESULT_MAX_HISTORY_CHARS = 15000`,
   `VERO_PROMPT_CHAR_BUDGET = 180_000`.
3. `pcr-ai-api/test/veroAgentLoopConfig.test.ts` (new) — 2 tests: flag toggling with
   env vars (save/restore in `finally`), and constants sanity-checked against the
   SiliconFlow large-context bucket comparison point.

## Test Results (re-verified by controller after cherry-pick, in the correct worktree)

Command: `npx tsx --test test/veroAgentLoopConfig.test.ts` (from `pcr-ai-api/`)

```
# tests 2
# suites 0
# pass 2
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

Both tests pass:
- `isVeroGenericLoopEnabled / isVeroGenericLoopReady toggle with env`
- `Vero loop calibration constants are sane relative to SiliconFlow large-context bucket`

## Files Changed

- Modified: `pcr-ai-api/src/lib/vero/veroSimpleAgent.ts` (+12 lines)
- Created: `pcr-ai-api/src/lib/agent/core/veroAgentLoopConfig.ts`
- Created: `pcr-ai-api/test/veroAgentLoopConfig.test.ts`

## Self-Review / Concerns

None reported by the implementer. Independently confirmed by the task reviewer
(direct diff read): spec-compliant, default-off semantics correct, no secrets
committed, no scope creep. Reviewer's only finding was the report-file mismatch
documented above (controller-side process issue, now corrected), not a code defect.
