# Task 1 Report: `buildGoodBinsByPassFromJbRows` 移除信号门槛 + 导出 `fetchJbTestRowsForLot`

## Status: DONE

## Commit
`c625466` — fix(api): 单lot良品bin判定不再要求PASSBIN额外信号，导出fetchJbTestRowsForLot

(Base commit before this task: `c14ac9c`, branch `worktree-jb-goodbin-fix`.)

## Files changed

1. `pcr-ai-api/src/lib/lotUnderperformingDutsResolve.ts`
   - Removed the now-unused import `jbRowHasExtraGoodBinSignal` from `./jbYieldCalc.js` (kept `goodBinIndicesForJbRow`).
   - `buildGoodBinsByPassFromJbRows`: removed the `hasSignalByPass` gating logic that deleted a `passId` entry from the result map unless at least one row had an "extra" (beyond BIN1) good-bin signal. The function now unconditionally keeps every `passId` encountered in the input rows, merging `goodBinIndicesForJbRow(row)` output (which always includes BIN1) into the map for that passId. Updated the JSDoc comment to document the intentional tradeoff verbatim per the brief (2026-07-05 dated rationale referencing NF12595.1A history and the WA01N39W/DR41803.1Y single-lot small-die-count bug being fixed).
   - `fetchJbTestRowsForLot`: added `export` keyword (no other change) so Task 3 can reuse it.

2. `pcr-ai-api/test/lotUnderperformingDuts.test.ts`
   - Rewrote the test formerly named `"passId with no PASSBIN signal on any row is omitted (caller falls back to INF heuristic)"` → renamed to `"passId is always included once it has JB rows, even with no signal beyond BIN1"`. Same input rows (`PASSID 1` with `PASSBIN: null` and `PASSBIN: ""`, `PASSID 3` with `PASSBIN: "1-55"`), but now asserts `map.get(1)` deep-equals `[1]` instead of asserting `map.has(1) === false`. Comment above rewritten to explain the intentional tradeoff verbatim per the brief.
   - Added new regression test `"single-lot small-die-count scenario: PASSBIN gives only BIN1, goodBins is {1} not empty"` reproducing the WA01N39W/DR41803.1Y bug scenario: rows with only `PASSBIN: "1"` (no extra signal) must still produce `map.get(1)` = `[1]` rather than being omitted (which previously forced a fallback to the INF heuristic that returns an empty set under low die counts, yielding 0% yield).

## Test command and output

```
cd pcr-ai-api && npx tsx --test test/lotUnderperformingDuts.test.ts
```

**Before the fix** (verified by temporarily `git stash`-ing only the source file change and re-running, per TDD instructions): 12 pass, 1 fail — the rewritten test `"passId is always included once it has JB rows, even with no signal beyond BIN1"` failed with `map.get is not a function or its return value is not iterable` (i.e. `map.get(1)` was `undefined` under old gating logic, exactly as expected).

**After the fix** (source restored via `git stash pop`):

```
# tests 13
# suites 6
# pass 13
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 739.924
```

All 13 tests pass, including the 3 tests in the `buildGoodBinsByPassFromJbRows` suite (1 pre-existing unchanged + 2 from this task) and all other pre-existing tests in the file (compute, parse, resolveDeviceForLot, resolveProbeCardTypeForLot, and the REST route tests).

Also ran `npx tsc --noEmit` (project-wide typecheck) — no errors.

## Diff scope verification

`git diff --stat` before commit confirmed only the two intended files were modified:
```
 pcr-ai-api/src/lib/lotUnderperformingDutsResolve.ts | 28 +++++++++++-----------
 pcr-ai-api/test/lotUnderperformingDuts.test.ts       | 26 ++++++++++++++++----
```

No other files were touched. A pre-existing unrelated change to `.claude/settings.local.json` (present before this task started) was left untouched and unstaged.

## Concerns

None beyond the tradeoff already negotiated with the user and documented verbatim in both the source comment and the test comment: if `PASSBIN` is empty/null AND the true good bin for a lot is not BIN1, this will still misclassify yield as 0% (the NF12595.1A-class failure mode). This is an accepted, explicit risk per the brief — not something introduced by this change beyond what was already scoped and approved. No other risk identified; `jbRowHasExtraGoodBinSignal` in `jbYieldCalc.ts` itself was left untouched (still exported, may be used elsewhere) — only its import/usage in this one file was removed, per the brief's exact scope.
