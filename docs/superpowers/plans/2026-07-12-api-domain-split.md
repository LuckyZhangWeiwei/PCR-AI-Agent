# pcr-ai-api Domain Split Refactor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the oversized files in `pcr-ai-api/src` (several 900–4400 line files) into domain-oriented directories/files with no behavior change, verified by the existing test suite at every step.

**Architecture:** Move code by exported symbol into new files grouped by business domain (Yield Monitor / infcontrol-JB / INF wafer map / probe card / Agent core-dispatch-jb-tools-prompt-render), following `docs/superpowers/specs/2026-07-12-api-domain-split-design.md`. Each task is independently committed and independently verified with `npm run typecheck && npm test`.

**Tech Stack:** Node.js + TypeScript (ESM, `.js` extensions in relative imports), `tsx --test` test runner, no path aliases (all imports are relative).

## Global Constraints

- **Pure move-only.** No behavior, HTTP path, response field, or error code changes anywhere in this plan (spec §2.2, §8).
- **No barrel/re-export compatibility layer.** Every import site is updated to point directly at the new file (spec §2.5).
- **Domain-oriented directories, not technical layers** (spec §2.3, §3).
- **Soft file-size budget ~400–500 lines** (spec §2.1). Some core files (`agentLoop.ts` core) may stay larger after splitting; that's acceptable.
- **Extract-function principle (spec §2.6):** while splitting a domain, if a function is > ~80–100 lines or deeply nested, extract clearly-named sub-functions in the same pass. This must be a behavior-preserving extraction — verified by the same test run, no logic changes.
- **Every task ends with:** `npm run typecheck` (from `pcr-ai-api/`) then `npm test` (from `pcr-ai-api/`), both green, before commit.
- **Branch:** all work happens on `refactor/api-domain-split`, created once in Task 0.
- **Docs:** update `pcr-ai-api/CLAUDE.md` §6 ("源码速查") and §2 ("必读文档") table rows whenever a task moves a file referenced there. Do **not** touch the dated, numbered historical entries in §11 ("近期变更纪要") — those are timestamped changelog entries describing file locations *at the time of that change*, the same reasoning that already applies to `docs/HANDOFF_*.md` being left as historical snapshots (spec §4, §8). `docs/HANDOFF_*.md` files are not touched at all.
- All commands below assume the working directory is `d:\AI\PCR-AI-Agent\pcr-ai-api` unless stated otherwise.

---

### Task 0: Create the refactor branch

**Files:** none.

- [ ] **Step 1: Confirm working tree is clean**

Run: `git -C d:/AI/PCR-AI-Agent status`
Expected: `nothing to commit, working tree clean` (on `main`).

- [ ] **Step 2: Create and switch to the refactor branch**

Run: `git -C d:/AI/PCR-AI-Agent checkout -b refactor/api-domain-split`
Expected: `Switched to a new branch 'refactor/api-domain-split'`.

---

### Task 1: Split `lib/apiManifest.ts` by domain

**Files:**
- Create: `pcr-ai-api/src/lib/manifest/yieldMonitorManifestEndpoints.ts`
- Create: `pcr-ai-api/src/lib/manifest/infcontrolManifestEndpoints.ts`
- Create: `pcr-ai-api/src/lib/manifest/miscManifestEndpoints.ts`
- Create: `pcr-ai-api/src/lib/manifest/index.ts` (re-assembles `apiManifest`)
- Modify: `pcr-ai-api/src/lib/rebaseApiManifest.ts` (import path only)
- Delete: `pcr-ai-api/src/lib/apiManifest.ts`
- Test: existing `pcr-ai-api/test/agentManifest.test.ts`, `pcr-ai-api/test/rest-api-v3-dummy.test.ts` (no new tests needed — pure move)

**Interfaces:**
- Consumes: nothing new.
- Produces: `pcr-ai-api/src/lib/manifest/index.ts` exports `apiManifest` — same object shape (`apiVersion`, `title`, `description`, `mediaType`, `endpoints: [...]`, `deprecatedEndpoints: [...]`) as the current `lib/apiManifest.ts`. Every other file imports `apiManifest` from `./manifest/index.js` (or `../manifest/index.js` from `lib/agent/`) instead of `./apiManifest.js`.

Current `lib/apiManifest.ts` is one 923-line file: a single `endpoints` array (18 entries) plus one `deprecatedEndpoints` entry. The entries split by `path` prefix as follows (line numbers from the current file, confirmed by `grep -n '      path: "' src/lib/apiManifest.ts`):

| Destination file | Endpoint `path` values (in original order) | Line ranges in current file |
|---|---|---|
| `infcontrolManifestEndpoints.ts` | `/api/v1/infcontrol-layer-bins`, `/v2`, `/v2/top-bad-bins`, `/aggregate`, `/v3`, `/v3/aggregate`, `/v4`, `/v4/aggregate`, `/api/v1/inf-analysis/site-bin-bylot`, `/api/v1/inf-analysis/lot-underperforming-duts` | 23–97, 97–157, 157–222, 222–306, 356–450, 450–539, 660–691, 691–717, 768–831, 831–885 |
| `yieldMonitorManifestEndpoints.ts` | `/api/v1/yield-monitor-triggers`, `/v3`, `/v3/aggregate`, `/v4`, `/v4/aggregate` | 306–356, 539–596, 596–660, 717–742, 742–768 |
| `miscManifestEndpoints.ts` | `/api/v1/manifest`, `/api/v1/db/ping`, `/api/v1/table-rows`, `/health` | 17–23, 885–890, 890–899, 899–905 |
| (goes in `index.ts`'s `deprecatedEndpoints` array) | `/api/v1/yield-monitor-triggers/aggregate` (deprecated) | 905–922 |

- [ ] **Step 1: Read the current file to copy exact endpoint object literals**

Run: `sed -n '1,922p' src/lib/apiManifest.ts > /tmp/apiManifest-full.txt` (or open the file directly) — use this as the source of truth for copying each endpoint object verbatim into its destination array. Do not retype descriptions/queryParameters by hand; copy-paste to avoid transcription errors.

- [ ] **Step 2: Create `src/lib/manifest/infcontrolManifestEndpoints.ts`**

```typescript
export const infcontrolManifestEndpoints = [
  // paste the 10 endpoint objects listed in the table above, in original order,
  // exactly as they appear in the current src/lib/apiManifest.ts (lines 23-97, 97-157,
  // 157-222, 222-306, 356-450, 450-539, 660-691, 691-717, 768-831, 831-885)
];
```

- [ ] **Step 3: Create `src/lib/manifest/yieldMonitorManifestEndpoints.ts`**

```typescript
export const yieldMonitorManifestEndpoints = [
  // paste the 5 endpoint objects (lines 306-356, 539-596, 596-660, 717-742, 742-768)
];
```

- [ ] **Step 4: Create `src/lib/manifest/miscManifestEndpoints.ts`**

```typescript
export const miscManifestEndpoints = [
  // paste the 4 endpoint objects (lines 17-23 is just "manifest" header metadata --
  // only paste the endpoint object itself, lines that follow "path: \"/api/v1/manifest\"";
  // plus db/ping 885-890, table-rows 890-899, health 899-905)
];

export const deprecatedManifestEndpoints = [
  // paste the 1 deprecated endpoint object (lines 905-922)
];
```

- [ ] **Step 5: Create `src/lib/manifest/index.ts`**

```typescript
import { getInfcontrolDummyExampleQuery } from "../infcontrolLayerBinDummy.js";
import { getYieldMonitorDummyExampleQuery } from "../yieldMonitorTriggerDummy.js";
import { infcontrolManifestEndpoints } from "./infcontrolManifestEndpoints.js";
import { yieldMonitorManifestEndpoints } from "./yieldMonitorManifestEndpoints.js";
import {
  miscManifestEndpoints,
  deprecatedManifestEndpoints,
} from "./miscManifestEndpoints.js";

/**
 * 供 AI agent / OpenAPI 生成器使用的机器可读 API 说明（只读 GET）。
 */
export const apiManifest = {
  apiVersion: "1",
  title: "pcr-ai-api",
  description:
    "Read-only Oracle-backed HTTP API for PCR workflows. All query keys are case-insensitive. The same Express router is mounted at /api/v1 (full catalog in GET /api/v1/manifest), /api/v3 (GET /api/v3/manifest returns v3-only paths), and /api/v4 (GET /api/v4/manifest returns v4-only paths). v4 duplicates v3 list surfaces for layer bins and yield triggers; v4 aggregates load the full matching row set (same WHERE as the v4 list without FETCH FIRST) and compute groups in Node—no separate v3-style aggregate SQL. v3 routes use fixed SQL; when dummy env flags are set and the process is not dist/production (see listDummyRuntime.ts), v3/v4 list and aggregates use in-memory Excel samples like v1/v2; otherwise they hit Oracle. deprecatedEndpoints lists routes removed from the router (yield-monitor-triggers/aggregate only).",
  mediaType: "application/json",
  endpoints: [
    ...miscManifestEndpoints,
    ...infcontrolManifestEndpoints,
    ...yieldMonitorManifestEndpoints,
  ],
  deprecatedEndpoints: [...deprecatedManifestEndpoints],
};
```

Note: `getInfcontrolDummyExampleQuery` / `getYieldMonitorDummyExampleQuery` are referenced inside the pasted endpoint object literals (used for the `example` fields) — check the original file for exactly which endpoint objects call them and keep those calls working after the paste (the import above already covers both).

- [ ] **Step 6: Delete the old file**

Run: `rm src/lib/apiManifest.ts`

- [ ] **Step 7: Find and fix every importer**

Run: `grep -rln "from \"\.\./apiManifest\.js\"\|from \"\./apiManifest\.js\"\|from \"\.\./\.\./lib/apiManifest\.js\"" src test`

For each file found (expect `src/lib/rebaseApiManifest.ts` per the earlier import scan — re-run the grep since new files may reference it), change the import to point at `manifest/index.js` with the correct relative depth, e.g. in `src/lib/rebaseApiManifest.ts`:

```typescript
import { apiManifest } from "./manifest/index.js";
```

- [ ] **Step 8: Typecheck and fix any remaining broken imports**

Run: `npm run typecheck`
Expected: initially may report `Cannot find module './apiManifest.js'` in any file the grep in Step 7 missed. Fix each reported path the same way (point at `./manifest/index.js` or `../manifest/index.js` depending on depth) and re-run until clean.

- [ ] **Step 9: Run tests**

Run: `npm test`
Expected: all tests pass (in particular `test/agentManifest.test.ts`, `test/rest-api-v3-dummy.test.ts`).

- [ ] **Step 10: Update CLAUDE.md reference**

In `pcr-ai-api/CLAUDE.md` §6 table, change the row `manifest 静态定义 | \`src/lib/apiManifest.ts\`; ...` to `src/lib/manifest/index.ts`.

- [ ] **Step 11: Commit**

```bash
git add pcr-ai-api/src/lib/manifest pcr-ai-api/src/lib/rebaseApiManifest.ts pcr-ai-api/CLAUDE.md
git rm pcr-ai-api/src/lib/apiManifest.ts
git commit -m "refactor(api): split apiManifest.ts into domain-grouped endpoint files"
```

---

### Task 2: Move single-domain files into domain directories (pure move, no content split)

**Files:**
- Move: `src/lib/infcontrolLayerBinFilters.ts` → `src/lib/infcontrol/infcontrolLayerBinFilters.ts`
- Move: `src/lib/infcontrolLayerBinV2Filters.ts` → `src/lib/infcontrol/infcontrolLayerBinV2Filters.ts`
- Move: `src/lib/infcontrolLayerBinV3Aggregate.ts` → `src/lib/infcontrol/infcontrolLayerBinV3Aggregate.ts`
- Move: `src/lib/infcontrolLayerBinAggregate.ts` → `src/lib/infcontrol/infcontrolLayerBinAggregate.ts`
- Move: `src/lib/infcontrolLayerBinDummy.ts` → `src/lib/infcontrol/infcontrolLayerBinDummy.ts`
- Move: `src/lib/jbYieldCalc.ts` → `src/lib/infcontrol/jbYieldCalc.ts`
- Move: `src/lib/yieldMonitorTriggerFilters.ts` → `src/lib/yieldMonitor/yieldMonitorTriggerFilters.ts`
- Move: `src/lib/yieldMonitorTriggerV3Aggregate.ts` → `src/lib/yieldMonitor/yieldMonitorTriggerV3Aggregate.ts`
- Move: `src/lib/yieldMonitorTriggerAggregate.ts` → `src/lib/yieldMonitor/yieldMonitorTriggerAggregate.ts`
- Move: `src/lib/yieldMonitorTriggerDummy.ts` → `src/lib/yieldMonitor/yieldMonitorTriggerDummy.ts`
- Move: `src/lib/probeCardTesterPerformance.ts` → `src/lib/probeCard/probeCardTesterPerformance.ts`
- Test: no new tests — run full suite.

**Interfaces:**
- Consumes: nothing new.
- Produces: same exported symbol names as before, at the new paths. No symbol is renamed.

This task is 11 independent file moves. Do all 11 in one task (they don't semantically depend on each other) but verify once at the end — if `npm test` fails, the compiler/test errors will point at exactly which import was missed.

- [ ] **Step 1: Create the three new directories**

Run: `mkdir -p src/lib/infcontrol src/lib/yieldMonitor src/lib/probeCard`

- [ ] **Step 2: Move each file with `git mv` (preserves history)**

```bash
git mv src/lib/infcontrolLayerBinFilters.ts src/lib/infcontrol/infcontrolLayerBinFilters.ts
git mv src/lib/infcontrolLayerBinV2Filters.ts src/lib/infcontrol/infcontrolLayerBinV2Filters.ts
git mv src/lib/infcontrolLayerBinV3Aggregate.ts src/lib/infcontrol/infcontrolLayerBinV3Aggregate.ts
git mv src/lib/infcontrolLayerBinAggregate.ts src/lib/infcontrol/infcontrolLayerBinAggregate.ts
git mv src/lib/infcontrolLayerBinDummy.ts src/lib/infcontrol/infcontrolLayerBinDummy.ts
git mv src/lib/jbYieldCalc.ts src/lib/infcontrol/jbYieldCalc.ts
git mv src/lib/yieldMonitorTriggerFilters.ts src/lib/yieldMonitor/yieldMonitorTriggerFilters.ts
git mv src/lib/yieldMonitorTriggerV3Aggregate.ts src/lib/yieldMonitor/yieldMonitorTriggerV3Aggregate.ts
git mv src/lib/yieldMonitorTriggerAggregate.ts src/lib/yieldMonitor/yieldMonitorTriggerAggregate.ts
git mv src/lib/yieldMonitorTriggerDummy.ts src/lib/yieldMonitor/yieldMonitorTriggerDummy.ts
git mv src/lib/probeCardTesterPerformance.ts src/lib/probeCard/probeCardTesterPerformance.ts
```

- [ ] **Step 3: Fix relative imports inside each moved file**

Each moved file now sits one directory deeper, so any of its own `from "./xxx.js"` or `from "../yyy.js"` imports need one more `../`. Check each moved file's import block and adjust. For example, if `jbYieldCalc.ts` previously had no relative imports to other `lib/` siblings, no change is needed there; if `infcontrolLayerBinDummy.ts` imports `from "./dummyRowsFromExcel.js"`, it becomes `from "../dummyRowsFromExcel.js"`.

Run this to list remaining relative imports in each moved file so you can check them one by one:

```bash
for f in src/lib/infcontrol/*.ts src/lib/yieldMonitor/*.ts src/lib/probeCard/*.ts; do
  echo "== $f =="; grep -n '^import .* from "\.' "$f"
done
```

For every `from "./X.js"` where `X.ts` still lives directly in `src/lib/` (not moved), change to `from "../X.js"`. For every `from "../X.js"` that referred to something one level above `src/lib/` (e.g. `oracle.ts`), change to `from "../../X.js"`.

- [ ] **Step 4: Fix every external importer of the 11 moved files**

For each moved file, find its importers and rewrite the specifier. Example for `jbYieldCalc.ts` (moved from `src/lib/jbYieldCalc.ts` to `src/lib/infcontrol/jbYieldCalc.ts`):

```bash
grep -rln 'jbYieldCalc\.js"' src test
```

For files under `src/lib/agent/` (one level deeper than `src/lib/`), the old specifier `../jbYieldCalc.js` becomes `../infcontrol/jbYieldCalc.js`. For files directly under `src/lib/` (e.g. `lotUnderperformingDutsResolve.ts`), `./jbYieldCalc.js` becomes `./infcontrol/jbYieldCalc.js`. For `test/*.test.ts` files, the old specifier `../src/lib/jbYieldCalc.js` becomes `../src/lib/infcontrol/jbYieldCalc.js`.

Repeat the same `grep -rln '<name>\.js"' src test` search for each of: `infcontrolLayerBinFilters`, `infcontrolLayerBinV2Filters`, `infcontrolLayerBinV3Aggregate`, `infcontrolLayerBinAggregate`, `infcontrolLayerBinDummy`, `yieldMonitorTriggerFilters`, `yieldMonitorTriggerV3Aggregate`, `yieldMonitorTriggerAggregate`, `yieldMonitorTriggerDummy`, `probeCardTesterPerformance`, and fix every reported specifier the same way.

- [ ] **Step 5: Typecheck and iterate**

Run: `npm run typecheck`
Expected: any import left unfixed shows as `error TS2307: Cannot find module './xxx.js'` with the exact file:line. Fix each one and re-run until the command exits clean.

- [ ] **Step 6: Run tests**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 7: Update CLAUDE.md references**

In `pcr-ai-api/CLAUDE.md` §6 table, update the rows for: `产量 Dummy 加载与筛选`, `层控 v3`, `v3 产量筛选`, `v3 产量聚合解析`, `v3 层控 BIN 聚合` to their new `src/lib/infcontrol/...` / `src/lib/yieldMonitor/...` paths.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(api): move infcontrol/yieldMonitor/jbYieldCalc/probeCard libs into domain directories"
```

---

### Task 3: Split `lib/yieldMonitorPeriodAlarmTrend.ts` into types/sql/parse/aggregate

**Files:**
- Create: `src/lib/yieldMonitor/periodAlarmTrend/periodAlarmTrendTypes.ts`
- Create: `src/lib/yieldMonitor/periodAlarmTrend/periodAlarmTrendSql.ts`
- Create: `src/lib/yieldMonitor/periodAlarmTrend/periodAlarmTrendParse.ts`
- Create: `src/lib/yieldMonitor/periodAlarmTrend/periodAlarmTrendAggregate.ts`
- Delete: `src/lib/yieldMonitorPeriodAlarmTrend.ts`
- Test: `test/yieldMonitorPeriodAlarmTrend.test.ts` (existing, run as-is)

**Interfaces:**
- Consumes: nothing new.
- Produces (grouped by destination file, all symbol names unchanged from the original file):

| File | Exports |
|---|---|
| `periodAlarmTrendTypes.ts` | `PeriodKey`, `PeriodAlarmBucket`, `PeriodAlarmTopTester`, `PeriodAlarmTopDevice`, `PeriodAlarmTopProbeCard`, `PeriodAlarmTrendPoint`, `PERIOD_ALARM_TOP_N_LIMIT`, `PERIOD_ALARM_TREND_BUCKET_COUNT`, `PERIOD_ALARM_MAX_WEEK_BUCKETS`, `PERIOD_ALARM_MAX_MONTH_BUCKETS`, `PeriodBucketsInRangeResult`, `ParsePeriodAlarmTrendOk`, `ParsePeriodAlarmTrendFail` |
| `periodAlarmTrendParse.ts` | `recentPeriodBuckets`, `resolvePeriodAlarmTimeRange`, `periodBucketsInRange`, `parsePeriodAlarmTrendQuery` |
| `periodAlarmTrendSql.ts` | `buildPeriodAlarmTrendSql`, `buildPeriodAlarmJbSlotTuplesSql`, `buildPeriodAlarmTrendTopTestersSql`, `buildPeriodAlarmTrendTopDevicesSql`, `buildPeriodAlarmTrendTopProbeCardsSql`, `periodAlarmTrendJbSlotBinds`, `periodAlarmTrendMainBinds`, `periodAlarmTrendTopBinds`, `periodAlarmTrendBinds` |
| `periodAlarmTrendAggregate.ts` | `topTestersFromAlarmRows`, `topDevicesFromAlarmRows`, `topProbeCardsFromAlarmRows`, `aggregatePeriodAlarmTrendDummy` |

- [ ] **Step 1: Create the subdirectory**

Run: `mkdir -p src/lib/yieldMonitor/periodAlarmTrend`

- [ ] **Step 2: Read the current file in full to identify exact function bodies and internal call graph**

Read `src/lib/yieldMonitorPeriodAlarmTrend.ts` end to end (948 lines) before cutting, so you can see which functions in `periodAlarmTrendSql.ts` call helpers that must come from `periodAlarmTrendTypes.ts` or `periodAlarmTrendParse.ts`, and add the corresponding imports.

- [ ] **Step 3: Create `periodAlarmTrendTypes.ts`**

Cut the type/const declarations listed in the table above (in their original order) into this new file. These have no internal dependencies on the other three files.

- [ ] **Step 4: Create `periodAlarmTrendParse.ts`**

Cut `recentPeriodBuckets`, `resolvePeriodAlarmTimeRange`, `periodBucketsInRange`, `parsePeriodAlarmTrendQuery` into this file. Add:

```typescript
import type {
  PeriodKey,
  PeriodBucketsInRangeResult,
  ParsePeriodAlarmTrendOk,
  ParsePeriodAlarmTrendFail,
} from "./periodAlarmTrendTypes.js";
import {
  PERIOD_ALARM_TREND_BUCKET_COUNT,
  PERIOD_ALARM_MAX_WEEK_BUCKETS,
  PERIOD_ALARM_MAX_MONTH_BUCKETS,
} from "./periodAlarmTrendTypes.js";
```

(Adjust the exact type/const names actually consumed once you've read the original function bodies in Step 2 — only import what's used.)

- [ ] **Step 5: Create `periodAlarmTrendSql.ts`**

Cut `buildPeriodAlarmTrendSql`, `buildPeriodAlarmJbSlotTuplesSql`, `buildPeriodAlarmTrendTopTestersSql`, `buildPeriodAlarmTrendTopDevicesSql`, `buildPeriodAlarmTrendTopProbeCardsSql`, `periodAlarmTrendJbSlotBinds`, `periodAlarmTrendMainBinds`, `periodAlarmTrendTopBinds`, `periodAlarmTrendBinds` into this file, importing needed types from `./periodAlarmTrendTypes.js` and `PERIOD_ALARM_TOP_N_LIMIT` etc. as needed.

- [ ] **Step 6: Create `periodAlarmTrendAggregate.ts`**

Cut `topTestersFromAlarmRows`, `topDevicesFromAlarmRows`, `topProbeCardsFromAlarmRows`, `aggregatePeriodAlarmTrendDummy` into this file, importing needed types from `./periodAlarmTrendTypes.js`.

- [ ] **Step 7: Delete the old file**

Run: `rm src/lib/yieldMonitorPeriodAlarmTrend.ts`

- [ ] **Step 8: Find and fix every importer**

```bash
grep -rln 'yieldMonitorPeriodAlarmTrend\.js"' src test
```

Expected hits: `src/routes/yieldMonitorRoutes.ts`, `test/yieldMonitorPeriodAlarmTrend.test.ts`. Update each to import the specific symbols it needs from the four new files under `src/lib/yieldMonitor/periodAlarmTrend/` (adjust relative depth: `src/routes/` → `../lib/yieldMonitor/periodAlarmTrend/xxx.js`; `test/` → `../src/lib/yieldMonitor/periodAlarmTrend/xxx.js`).

- [ ] **Step 9: Typecheck and iterate**

Run: `npm run typecheck` — fix any reported missing-module or missing-export errors until clean.

- [ ] **Step 10: Run tests**

Run: `npm test` — expect all green, especially `test/yieldMonitorPeriodAlarmTrend.test.ts`.

- [ ] **Step 11: Extract-function pass (spec principle 6)**

While the file was open in Steps 2–6, note whether `parsePeriodAlarmTrendQuery` (was ~73 lines) or `buildPeriodAlarmTrendSql` exceed ~80–100 lines or nest more than 3 levels deep. If so, extract clearly-named helper functions within the same destination file (not a new file) — e.g. splitting validation branches out of `parsePeriodAlarmTrendQuery` into a private `validatePeriodAlarmTrendParams` helper. Re-run `npm test` after any such extraction to confirm behavior is unchanged.

- [ ] **Step 12: Update CLAUDE.md and commit**

Update `pcr-ai-api/CLAUDE.md` §6 if it references `yieldMonitorPeriodAlarmTrend.ts` directly (search first: `grep -n "yieldMonitorPeriodAlarmTrend" pcr-ai-api/CLAUDE.md`).

```bash
git add -A
git commit -m "refactor(api): split yieldMonitorPeriodAlarmTrend.ts into types/parse/sql/aggregate"
```

---

### Task 4: Split `lib/infWaferMap.ts` and move `lib/infTools/`

**Files:**
- Create: `src/lib/infWaferMap/infWaferMapGeometry.ts` (die/layer parsing helpers)
- Create: `src/lib/infWaferMap/infWaferMapPassSpecs.ts` (pass-spec resolution)
- Create: `src/lib/infWaferMap/infWaferMapCalculate.ts` (`calculateWafer`, `computeSiteStats`, and their direct helpers)
- Move: `src/lib/infWaferMapHtml.ts` → `src/lib/infWaferMap/infWaferMapHtml.ts`
- Move: `src/lib/infTools/*` → unchanged location (`src/lib/infTools/` already its own directory — confirm during Step 1 whether it should nest under `infWaferMap/` or stay top-level; see Step 1 decision note)
- Delete: `src/lib/infWaferMap.ts`
- Test: `test/infWaferMapPassSpecs.test.ts` and any other test importing `infWaferMap.js` (find via grep in Step 1)

**Interfaces:**
- Consumes: nothing new.
- Produces (symbol → destination file, based on the export list gathered from `src/lib/infWaferMap.ts`):

| File | Exports |
|---|---|
| `infWaferMapGeometry.ts` | `DieEntry`, `PassResult`, `WaferResult`, `findLayer`, `findLastLayer`, `decodePsbn`, `findPsbn`, `buildDieMap`, `resolvePerPassLayerNames`, `buildDieMapForSmWaferPass`, `buildDieMapForFinalFlow`, `countPossibleDie`, `readPossibleDieCoords`, `countDiesFromLayer`, `infNotchAngleToSvg`, `readDieGeometry` |
| `infWaferMapPassSpecs.ts` | `SmWaferPassInfo`, `findAllSmWaferPasses`, `findSmWaferPassesForId`, `getDiesForPassId`, `WaferMapPassSpec`, `getDiesForWaferMapSpec`, `describePassLayer`, `buildStandardWaferMapPassSpecs`, `findSegmentedPassLayers`, `buildPassIdWaferMapSpecs`, `buildWaferMapPassSpecs` |
| `infWaferMapCalculate.ts` | `calculateWafer`, `SiteStatRow`, `computeSiteStats` |

- [ ] **Step 1: Grep all current importers of `infWaferMap.js` and `infTools`**

```bash
grep -rln 'infWaferMap\.js"' src test
grep -rln 'lib/infTools/' src test
```

Read the results. If `infTools/*.ts` files import `infWaferMap.js` (they likely do, since they call `calculateWafer`/`buildDieMap` etc.), keep `infTools/` where it is (`src/lib/infTools/`) for this task — do not also relocate it under `infWaferMap/` to avoid compounding two risky moves in one task. Only fix its imports to the new `infWaferMap/` subfiles in Step 5.

- [ ] **Step 2: Create the subdirectory and geometry file**

```bash
mkdir -p src/lib/infWaferMap
```

Cut `DieEntry`, `PassResult`, `WaferResult`, `findLayer`, `findLastLayer`, `decodePsbn`, `findPsbn`, `buildDieMap`, `resolvePerPassLayerNames`, `buildDieMapForSmWaferPass`, `buildDieMapForFinalFlow`, `countPossibleDie`, `readPossibleDieCoords`, `countDiesFromLayer`, `infNotchAngleToSvg`, `readDieGeometry` (in original order, lines 10–96, 97–414 minus the pass-spec section, 676–729 for the two angle/geometry functions) from `src/lib/infWaferMap.ts` into `src/lib/infWaferMap/infWaferMapGeometry.ts`. Keep the `InfBlock` type import (check the top of the original file for where `InfBlock` comes from and preserve that import, adjusting relative depth by one `../`).

- [ ] **Step 3: Create the pass-specs file**

Cut `SmWaferPassInfo`, `findAllSmWaferPasses`, `findSmWaferPassesForId`, `getDiesForPassId`, `WaferMapPassSpec`, `getDiesForWaferMapSpec`, `describePassLayer`, `buildStandardWaferMapPassSpecs`, `findSegmentedPassLayers`, `buildPassIdWaferMapSpecs`, `buildWaferMapPassSpecs` (lines 414–676) into `src/lib/infWaferMap/infWaferMapPassSpecs.ts`. Import `InfBlock` and anything from `infWaferMapGeometry.ts` it needs (e.g. `findLayer`, `buildDieMap`) via `import { findLayer, buildDieMap } from "./infWaferMapGeometry.js";`.

- [ ] **Step 4: Create the calculate file**

Cut `calculateWafer` (lines 729–870) and `SiteStatRow`/`computeSiteStats` (lines 870–978) into `src/lib/infWaferMap/infWaferMapCalculate.ts`. Import whatever it needs from `./infWaferMapGeometry.js` and `./infWaferMapPassSpecs.js`.

- [ ] **Step 5: Move `infWaferMapHtml.ts`**

```bash
git mv src/lib/infWaferMapHtml.ts src/lib/infWaferMap/infWaferMapHtml.ts
```
Fix its internal relative imports (one level deeper) and update its own imports of `infWaferMap.js` symbols to the new split files.

- [ ] **Step 6: Delete the old file**

```bash
rm src/lib/infWaferMap.ts
```

- [ ] **Step 7: Fix every importer found in Step 1**

For each file (including everything under `src/lib/infTools/`, `src/routes/infAnalysisRoutes.ts`, and any test file), replace `from ".../infWaferMap.js"` with imports from the specific new file(s) that hold the symbols it actually uses (`infWaferMapGeometry.js`, `infWaferMapPassSpecs.js`, or `infWaferMapCalculate.js`), adjusting relative path depth for the new `infWaferMap/` subdirectory.

- [ ] **Step 8: Typecheck and iterate**

Run: `npm run typecheck` until clean.

- [ ] **Step 9: Run tests**

Run: `npm test` — expect all green, in particular `test/infWaferMapPassSpecs.test.ts`.

- [ ] **Step 10: Extract-function pass**

`calculateWafer` was ~140 lines in the original file — while it's open for the move in Step 4, check whether it can be split into named sub-steps (e.g. `resolveGoodBinSet`, `computeDieYieldSummary`) if it mixes multiple concerns. Only do this if it's genuinely tangled; re-run `npm test` after.

- [ ] **Step 11: Update CLAUDE.md and commit**

```bash
git add -A
git commit -m "refactor(api): split infWaferMap.ts into geometry/passSpecs/calculate files"
```

---

### Task 5: Extract handler logic out of `routes/infcontrolRoutes.ts`

**Files:**
- Create: `src/lib/infcontrol/handlers/infcontrolLayerBinsHandlers.ts`
- Modify: `src/routes/infcontrolRoutes.ts` (route registrations only, delegating to the new handler functions)
- Test: no new tests — run full suite; this route file is exercised by `test/rest-api-v3-dummy.test.ts`, `test/infcontrolBinColumnFilters.test.ts`, `test/infcontrolLayerBinPasstypeScope.test.ts`.

**Interfaces:**
- Consumes: everything `infcontrolRoutes.ts` currently imports (Oracle helpers, `infcontrolLayerBinFilters.js` etc. from Task 2's new location).
- Produces: one exported async handler function per endpoint, named `handle<Thing>` (e.g. `handleInfcontrolLayerBinsV3`), each with signature `(req: Request, res: Response) => Promise<void>` (match whatever Express types the file already uses — check the top of `infcontrolRoutes.ts` for the exact `Request`/`Response` import).

`infcontrolRoutes.ts` has 9 endpoints, each currently defined as an inline arrow function passed straight to `infcontrolRouter.get(path, async (req, res) => { ... })`, at line ranges (from `grep -n 'infcontrolRouter\.get'`): 78–158, 158–244, 244–324, 324–439, 439–515, 515–624, 624–703, 703–826, 826–end.

- [ ] **Step 1: Read the full file to capture each handler body verbatim**

Read `src/routes/infcontrolRoutes.ts` in full before editing.

- [ ] **Step 2: Create the handlers file with all 9 handlers extracted**

For each of the 9 `infcontrolRouter.get(path, async (req, res) => { ... })` blocks, cut the arrow function body into a named exported async function in `src/lib/infcontrol/handlers/infcontrolLayerBinsHandlers.ts`, e.g.:

```typescript
import type { Request, Response } from "express";
// ... plus every import the original route file had, adjusted for the new file's location (one directory deeper under src/lib/infcontrol/handlers/ instead of src/routes/)

export async function handleInfcontrolLayerBins(req: Request, res: Response): Promise<void> {
  // body cut verbatim from the "/infcontrol-layer-bins" handler (lines 78-158)
}

export async function handleInfcontrolLayerBinsV2(req: Request, res: Response): Promise<void> {
  // body cut verbatim from the "/infcontrol-layer-bins/v2" handler (lines 158-244)
}

// ... one function per remaining endpoint, named after its path:
// handleInfcontrolLayerBinsV3, handleInfcontrolLayerBinsV3Aggregate,
// handleInfcontrolLayerBinsV2TopBadBins, handleInfcontrolLayerBinsAggregate,
// handleInfcontrolLayerBinsV4, handleInfcontrolLayerBinsV4Aggregate,
// handleInfcontrolLayerBinsV4Combined
```

- [ ] **Step 3: Rewrite `infcontrolRoutes.ts` to just register routes**

```typescript
import { Router } from "express";
import {
  handleInfcontrolLayerBins,
  handleInfcontrolLayerBinsV2,
  handleInfcontrolLayerBinsV3,
  handleInfcontrolLayerBinsV3Aggregate,
  handleInfcontrolLayerBinsV2TopBadBins,
  handleInfcontrolLayerBinsAggregate,
  handleInfcontrolLayerBinsV4,
  handleInfcontrolLayerBinsV4Aggregate,
  handleInfcontrolLayerBinsV4Combined,
} from "../lib/infcontrol/handlers/infcontrolLayerBinsHandlers.js";

export const infcontrolRouter = Router();

infcontrolRouter.get("/infcontrol-layer-bins", handleInfcontrolLayerBins);
infcontrolRouter.get("/infcontrol-layer-bins/v2", handleInfcontrolLayerBinsV2);
infcontrolRouter.get("/infcontrol-layer-bins/v3", handleInfcontrolLayerBinsV3);
infcontrolRouter.get("/infcontrol-layer-bins/v3/aggregate", handleInfcontrolLayerBinsV3Aggregate);
infcontrolRouter.get("/infcontrol-layer-bins/v2/top-bad-bins", handleInfcontrolLayerBinsV2TopBadBins);
infcontrolRouter.get("/infcontrol-layer-bins/aggregate", handleInfcontrolLayerBinsAggregate);
infcontrolRouter.get("/infcontrol-layer-bins/v4", handleInfcontrolLayerBinsV4);
infcontrolRouter.get("/infcontrol-layer-bins/v4/aggregate", handleInfcontrolLayerBinsV4Aggregate);
infcontrolRouter.get("/infcontrol-layer-bins/v4/combined", handleInfcontrolLayerBinsV4Combined);
```

(Match the exact path strings from the original file — verify with `grep -n 'infcontrolRouter\.get' src/routes/infcontrolRoutes.ts` before this rewrite, don't retype from memory.)

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck` and fix any import path issues (the handlers file is one directory deeper than `routes/`, so anything the handlers imported relatively from `routes/` needs its relative path adjusted — e.g. `../lib/oracle.js` from `routes/` becomes `../../oracle.js` from `lib/infcontrol/handlers/`).

- [ ] **Step 5: Run tests**

Run: `npm test` — expect all green.

- [ ] **Step 6: Extract-function pass**

Each handler averages ~100 lines. For any handler exceeding ~100 lines with distinct phases (parse query → run SQL/Dummy → shape response), extract a private helper per phase within `infcontrolLayerBinsHandlers.ts` (not exported) with a clear name (e.g. `shapeLayerBinV3Response`). Re-run `npm test` after.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(api): extract infcontrolRoutes handlers into lib/infcontrol/handlers"
```

---

### Task 6: Extract handler logic out of `routes/yieldMonitorRoutes.ts`

**Files:**
- Create: `src/lib/yieldMonitor/handlers/yieldMonitorTriggersHandlers.ts`
- Modify: `src/routes/yieldMonitorRoutes.ts` (route registrations only)
- Test: no new tests — run full suite; exercised by `test/rest-api-v3-dummy.test.ts`, `test/yieldMonitorPeriodAlarmTrend.test.ts`, `test/yieldMonitorTriggerV3Aggregate.test.ts`.

**Interfaces:**
- Consumes: same as Task 5's pattern, plus the four `periodAlarmTrend/*.ts` files from Task 3.
- Produces: `handleYieldMonitorTriggers`, `handleYieldMonitorTriggersV3`, `handleYieldMonitorTriggersV3Aggregate`, `handleYieldMonitorTriggersV3Combined`, `handleYieldMonitorTriggersV3PeriodAlarmTrend`, `handleYieldMonitorTriggersV4`, `handleYieldMonitorTriggersV4Aggregate` — same `(req, res) => Promise<void>` signature as Task 5.

7 endpoints at line ranges (from `grep -n 'yieldMonitorRouter\.get'`): 88–234, 234–312, 312–400, 400–566, 566–698, 698–776, 776–end.

- [ ] **Step 1: Read the full file to capture each handler body verbatim**

Read `src/routes/yieldMonitorRoutes.ts` in full before editing.

- [ ] **Step 2: Create the handlers file with all 7 handlers extracted**

Same mechanical pattern as Task 5 Step 2 — cut each `yieldMonitorRouter.get(path, async (req, res) => {...})` body into a named exported function in `src/lib/yieldMonitor/handlers/yieldMonitorTriggersHandlers.ts`, naming each after its path (`handleYieldMonitorTriggers`, `handleYieldMonitorTriggersV3`, `handleYieldMonitorTriggersV3Aggregate`, `handleYieldMonitorTriggersV3Combined`, `handleYieldMonitorTriggersV3PeriodAlarmTrend`, `handleYieldMonitorTriggersV4`, `handleYieldMonitorTriggersV4Aggregate`).

- [ ] **Step 3: Rewrite `yieldMonitorRoutes.ts` to just register routes**

Same pattern as Task 5 Step 3, importing the 7 handlers and calling `yieldMonitorRouter.get(path, handlerFn)` for each, with exact path strings re-verified via `grep -n 'yieldMonitorRouter\.get' src/routes/yieldMonitorRoutes.ts` before the rewrite.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`, fix relative import depth issues.

- [ ] **Step 5: Run tests**

Run: `npm test` — expect all green.

- [ ] **Step 6: Extract-function pass**

`handleYieldMonitorTriggersV3PeriodAlarmTrend` (originally ~130 lines) is the largest — check whether it mixes query parsing, Oracle/Dummy branching, and response shaping; extract private helpers if so. Re-run `npm test` after.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(api): extract yieldMonitorRoutes handlers into lib/yieldMonitor/handlers"
```

---

### Task 7: Split `lib/agent/agentToolHandlers.ts` by tool domain

**Files:**
- Create: `src/lib/agent/tools/agentToolYieldTriggers.ts`
- Create: `src/lib/agent/tools/agentToolJbBins.ts`
- Create: `src/lib/agent/tools/agentToolProbeCardPerf.ts`
- Create: `src/lib/agent/tools/agentToolDutBinAgg.ts`
- Create: `src/lib/agent/tools/agentToolUnderperformingDuts.ts`
- Create: `src/lib/agent/tools/agentToolInfSiteBin.ts`
- Move: `src/lib/agent/agentToolHandlers.ts` → `src/lib/agent/tools/agentToolHandlers.ts` (slimmed to dispatcher + shared helpers)
- Move: `src/lib/agent/agentFilterValuesTool.ts` → `src/lib/agent/tools/agentFilterValuesTool.ts`
- Move: `src/lib/agent/agentChartTool.ts` → `src/lib/agent/tools/agentChartTool.ts`
- Move: `src/lib/agent/agentInfWaferMapTool.ts` → `src/lib/agent/tools/agentInfWaferMapTool.ts`
- Test: no new tests — exercised by `test/agentTools.chart.test.ts`, `test/agentFilterValues.test.ts`, `test/agentInfWaferMapTool.test.ts`, `test/agentAggregateProbeCardTesterPerformance.test.ts`, `test/agentLotUnderperformingDuts.test.ts`, `test/agentInfSiteBin.test.ts`, `test/agentDutBinAggInsight.test.ts`.

**Interfaces:**
- Consumes: `RunToolOptions` type (stays exported from `agentToolHandlers.ts`), shared helpers below.
- Produces:

| File | Exports |
|---|---|
| `agentToolHandlers.ts` (slimmed) | `RunToolOptions`, `runTool`, `attachDutConcentrationToJbPayload`, plus private (unexported) shared helpers `resolveToolResultMaxChars`, `clampLimit`, `truncateResult`, `enrichYieldRow`, `enrichJbRow` |
| `agentToolYieldTriggers.ts` | `toolQueryYieldTriggers`, `toolAggregateYieldTriggers`, `fetchYmRowsForCard` (private helpers `isJbLotScopedAgentQuery`... only if used here) |
| `agentToolJbBins.ts` | `toolQueryJbBins`, `toolAggregateJbBins`, plus their private helpers `isJbLotScopedAgentQuery`, `jbQueryHasTimeFilter`, `aggregateJbBinsHasScopeFilter` |
| `agentToolProbeCardPerf.ts` | `toolAggregateProbeCardTesterPerformance`, private helper `probeCardPerfRowLimitExceededMessage` |
| `agentToolDutBinAgg.ts` | `toolQueryLotDutBinAgg`, private helpers `extractFocusBinDuts`, `lotDutConcentrationOpts`, `compactSiteBinPasses` |
| `agentToolUnderperformingDuts.ts` | `toolQueryLotUnderperformingDuts` |
| `agentToolInfSiteBin.ts` | `toolQueryInfSiteBinByDut` |

The private helper functions (`resolveToolResultMaxChars`, `clampLimit`, `truncateResult`, `enrichYieldRow`, `enrichJbRow`) are used across multiple tool files — export them from the slimmed `agentToolHandlers.ts` (even though they weren't exported before) so the tool files can import them, since duplicating them would violate the move-only + dedup-allowed principle.

- [ ] **Step 1: Read the full file to capture each function body and confirm which shared helpers each tool function calls**

Read `src/lib/agent/agentToolHandlers.ts` in full (1083 lines) before cutting.

- [ ] **Step 2: Create the `tools/` subdirectory and move the three sibling tool files**

```bash
mkdir -p src/lib/agent/tools
git mv src/lib/agent/agentFilterValuesTool.ts src/lib/agent/tools/agentFilterValuesTool.ts
git mv src/lib/agent/agentChartTool.ts src/lib/agent/tools/agentChartTool.ts
git mv src/lib/agent/agentInfWaferMapTool.ts src/lib/agent/tools/agentInfWaferMapTool.ts
```
Fix each moved file's internal relative imports (one directory deeper).

- [ ] **Step 3: Create `agentToolYieldTriggers.ts`**

Cut `toolQueryYieldTriggers` (lines 168–198), `toolAggregateYieldTriggers` (198–268), `fetchYmRowsForCard` (268–293) into `src/lib/agent/tools/agentToolYieldTriggers.ts`. Import `resolveToolResultMaxChars`, `truncateResult`, `enrichYieldRow`, `clampLimit` from `./agentToolHandlers.js` as needed (check each function body for which it actually calls).

- [ ] **Step 4: Create `agentToolJbBins.ts`**

Cut `isJbLotScopedAgentQuery` (293–297), `jbQueryHasTimeFilter` (297–314), `toolQueryJbBins` (314–412), `aggregateJbBinsHasScopeFilter` (412–431), `toolAggregateJbBins` (431–523) into `src/lib/agent/tools/agentToolJbBins.ts`. Import shared helpers from `./agentToolHandlers.js` as needed.

- [ ] **Step 5: Create `agentToolProbeCardPerf.ts`**

Cut `probeCardPerfRowLimitExceededMessage` (523–527), `toolAggregateProbeCardTesterPerformance` (527–618) into `src/lib/agent/tools/agentToolProbeCardPerf.ts`.

- [ ] **Step 6: Create `agentToolDutBinAgg.ts`**

Cut `extractFocusBinDuts` (618–638), `lotDutConcentrationOpts` (638–655), `compactSiteBinPasses` (655–705), `toolQueryLotDutBinAgg` (705–840) into `src/lib/agent/tools/agentToolDutBinAgg.ts`.

- [ ] **Step 7: Create `agentToolUnderperformingDuts.ts`**

Cut `toolQueryLotUnderperformingDuts` (840–891) into `src/lib/agent/tools/agentToolUnderperformingDuts.ts`.

- [ ] **Step 8: Create `agentToolInfSiteBin.ts`**

Cut `toolQueryInfSiteBinByDut` (891–939) into `src/lib/agent/tools/agentToolInfSiteBin.ts`.

- [ ] **Step 9: Move and slim `agentToolHandlers.ts`**

```bash
git mv src/lib/agent/agentToolHandlers.ts src/lib/agent/tools/agentToolHandlers.ts
```

In the moved file, remove everything cut in Steps 3–8, keep `RunToolOptions`, `resolveToolResultMaxChars`, `clampLimit`, `truncateResult`, `enrichYieldRow`, `enrichJbRow` (export the five helpers that were private before, so the new files can import them), `runTool`, `attachDutConcentrationToJbPayload`. Update `runTool`'s dispatch body to import and call the moved tool functions from their new files, e.g.:

```typescript
import { toolQueryYieldTriggers, toolAggregateYieldTriggers } from "./agentToolYieldTriggers.js";
import { toolQueryJbBins, toolAggregateJbBins } from "./agentToolJbBins.js";
import { toolAggregateProbeCardTesterPerformance } from "./agentToolProbeCardPerf.js";
import { toolQueryLotDutBinAgg } from "./agentToolDutBinAgg.js";
import { toolQueryLotUnderperformingDuts } from "./agentToolUnderperformingDuts.js";
import { toolQueryInfSiteBinByDut } from "./agentToolInfSiteBin.js";
```

- [ ] **Step 10: Fix every external importer of the moved/split files**

```bash
grep -rln 'agentToolHandlers\.js"\|agentFilterValuesTool\.js"\|agentChartTool\.js"\|agentInfWaferMapTool\.js"' src test
```

Update each hit to the new `tools/` path (adjust relative depth — files in `src/lib/agent/` become `./tools/xxx.js`; files elsewhere adjust accordingly; test files similarly).

- [ ] **Step 11: Typecheck and iterate**

Run: `npm run typecheck` until clean.

- [ ] **Step 12: Run tests**

Run: `npm test` — expect all green, especially the tool-specific test files listed above.

- [ ] **Step 13: Update CLAUDE.md**

Search `grep -n "agentToolHandlers\|agentFilterValuesTool\|agentChartTool\|agentInfWaferMapTool" pcr-ai-api/CLAUDE.md` and update any §6/§11-non-historical rows found (leave dated §11 entries alone per Global Constraints).

- [ ] **Step 14: Commit**

```bash
git add -A
git commit -m "refactor(api): split agentToolHandlers.ts into per-domain tool files under agent/tools/"
```

---

### Task 8: Move remaining JB-domain agent files into `agent/jb/`

**Files:**
- Move: `src/lib/agent/agentJbBinFormat.ts` → `src/lib/agent/jb/agentJbBinFormat.ts`
- Move: `src/lib/agent/agentJbHistoryCompact.ts` → `src/lib/agent/jb/agentJbHistoryCompact.ts`
- Move: `src/lib/agent/agentJbBadBinCluster.ts` → `src/lib/agent/jb/agentJbBadBinCluster.ts`
- Move: `src/lib/agent/agentJbBinTrend.ts` → `src/lib/agent/jb/agentJbBinTrend.ts`
- Test: no new tests — exercised by `test/agentJbBinFormat.test.ts`, `test/agentJbHistoryCompact.test.ts`, `test/agentJbBadBinCluster.test.ts`, `test/agentJbBinTrend.test.ts`, `test/agentJbBinTrendOnDemand.test.ts`.

**Interfaces:** unchanged symbol names, only path changes.

- [ ] **Step 1: Create the directory and move the four files**

```bash
mkdir -p src/lib/agent/jb
git mv src/lib/agent/agentJbBinFormat.ts src/lib/agent/jb/agentJbBinFormat.ts
git mv src/lib/agent/agentJbHistoryCompact.ts src/lib/agent/jb/agentJbHistoryCompact.ts
git mv src/lib/agent/agentJbBadBinCluster.ts src/lib/agent/jb/agentJbBadBinCluster.ts
git mv src/lib/agent/agentJbBinTrend.ts src/lib/agent/jb/agentJbBinTrend.ts
```

- [ ] **Step 2: Fix each moved file's own relative imports**

Each is now one directory deeper. In particular `agentJbBinFormat.ts` and others import `jbYieldCalc.js` — after Task 2 that lives at `src/lib/infcontrol/jbYieldCalc.ts`, and after this move the importer is at `src/lib/agent/jb/`, so the specifier becomes `../../infcontrol/jbYieldCalc.js`. Check each moved file's full import block and adjust every specifier for the extra directory level (and the Task 2 relocation, if not already fixed for these specific files).

- [ ] **Step 3: Fix every external importer of the four moved files**

```bash
grep -rln 'agentJbBinFormat\.js"\|agentJbHistoryCompact\.js"\|agentJbBadBinCluster\.js"\|agentJbBinTrend\.js"' src test
```

Update each hit's specifier to point at `./jb/agentJbXxx.js` (from `src/lib/agent/`) or the correspondingly adjusted relative path (from other directories / `test/`).

- [ ] **Step 4: Typecheck and iterate**

Run: `npm run typecheck` until clean.

- [ ] **Step 5: Run tests**

Run: `npm test` — expect all green.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(api): move agentJbBinFormat/HistoryCompact/BadBinCluster/BinTrend into agent/jb/"
```

---

### Task 9: Split `lib/agent/agentJbDeterministicReply.ts`

**Files:**
- Create: `src/lib/agent/jb/agentJbQuestionClassifiers.ts`
- Create: `src/lib/agent/jb/agentJbListingMarkdown.ts`
- Create: `src/lib/agent/jb/agentJbRankingMarkdown.ts`
- Create: `src/lib/agent/jb/agentJbOverviewMarkdown.ts`
- Create: `src/lib/agent/jb/agentJbPayloadResolve.ts`
- Delete: `src/lib/agent/agentJbDeterministicReply.ts`
- Test: `test/agentJbDeterministicReply.test.ts` (existing — this is the primary safety net for this task; also `test/jbIntentClassifier.test.ts`, `test/jbAgentLotQuery.test.ts`, `test/agentSemanticDispatchTable.test.ts`, `test/agentJbMultiLotListing.test.ts`, `test/agentJbUnscopedBinRoute.test.ts`, `test/agentJbMaskScopeRoute.test.ts`, `test/agentJbOverviewRoute.test.ts`, `test/agentJbDistinctLots.test.ts`)

**Interfaces:**
- Consumes: `jbYieldCalc.js` (now at `src/lib/infcontrol/jbYieldCalc.js`), `agentJbBinFormat.js` / `agentJbHistoryCompact.js` (now at `src/lib/agent/jb/`), `ChatMessage` type (check original file's top imports for its source).
- Produces (symbol → destination file):

| File | Exports |
|---|---|
| `agentJbQuestionClassifiers.ts` | `isGoodBinValueQuestion`, `isTesterMachineQuestion`, `isProbeCardQuestion`, `isBinCardAttributionQuestion`, `isProbeCardComboRankingQuestion`, `isCardYieldCompareQuestion`, `isProbeCardTesterPerformanceQuestion`, `isLotListingQuestion`, `isLotDetailListingQuestion`, `isLotYieldRankingQuestion`, `isBinLotRankingQuestion`, `isPerSlotBadBinRankingQuestion`, `isCardDutQuestion`, `isCardTestOverviewQuestion`, `isInterruptCountQuestion`, `isSingleSlotQuestion`, `isSingleWaferDieClusterQuestion`, `isLotOverviewQuestion`, `isBadBinRankingQuestion`, `isCrossLotQuestionMisalignedWithPayload`, `payloadCoversMultipleLots`, `isMaskLevelQuestionOnMultiLotPayload`, `isCardTypeLevelOverviewQuestion`, `isMultiCardComparisonQuestion`, `isMultiLotComparisonQuestion`, `equipmentRouteDutLevelBail`, `extractJbIntentFlags`, `isBinTrendQuestion`, `isSlotPassYieldQuestion`, `lotOverviewSkipsCommentaryAfterAlerts`, `jbReplySkipsCommentaryLlm`, `detectJbReplyMode`, `extractBinFromUserText`, `extractSlotFromUserText`, `JbReplyMode` (type) |
| `agentJbListingMarkdown.ts` | `YmLotListingEntry`, `extractYmAlarmCountByLot`, `extractYmSuspectDutsByLot`, `extractTopFailBinByLot`, `LotListingContext`, `LotListingPresentation`, `inferLotListingPresentation`, `buildLotListingContext`, `extractYmLotsFromHistory`, `buildRecentLotsListingMarkdown` |
| `agentJbRankingMarkdown.ts` | `buildAggregateBinRankingMarkdown`, `buildBinCardAggregateMarkdown`, `buildBinDeviceAggregateMarkdown`, `buildBinFocusedLotRankingMarkdown` |
| `agentJbOverviewMarkdown.ts` | `BinTrendDigest`, `AgentTablesDigest`, `buildLotOverviewTablesMarkdown`, `buildDeterministicJbTables`, `buildDeterministicLotOverviewCommentary`, `detectAndFormatDataPatterns`, `DETERMINISTIC_TABLES_HEADER` |
| `agentJbPayloadResolve.ts` | `LotYieldOverviewMarkdown` helpers, `parseJbToolPayload`, `resolveJbToolPayload`, `shouldAppendUnderperformingDutYield` |
| `agentJbDeterministicReply.ts` (deleted; if any glue logic remains after sorting all exports above, put it in `agentJbPayloadResolve.ts` as the "main" file) | — |

- [ ] **Step 1: Read the full file end to end**

Read `src/lib/agent/agentJbDeterministicReply.ts` in full (2830 lines) before cutting anything. This is the largest split in the plan — confirm the actual call graph between the ~57 exports (which classifier functions are called by which markdown builders) so imports between the 5 new files are correct.

- [ ] **Step 2: Create `agentJbQuestionClassifiers.ts`**

Cut all the `isXxxQuestion` / `detectJbReplyMode` / `extractJbIntentFlags` / `jbReplySkipsCommentaryLlm` functions and the `JbReplyMode` type (listed in the table above, lines 44–64, 71–85 is `buildGoodBinValueMarkdown` which goes elsewhere, 151–235, 235–305 is data-extraction which goes to listing file, 529–636, 655–746, 746–936 minus markdown builders — re-derive exact line boundaries from the Step 1 read, since some ranges interleave with markdown-building functions that belong in other files). Add imports for any shared types (`ChatMessage`) from wherever the original file imported them (adjust relative depth by one, since this stays in `agent/jb/` at the same depth as before — no depth change if `agentJbDeterministicReply.ts` was already directly in `agent/`; confirm actual original location before assuming depth).

- [ ] **Step 3: Create `agentJbListingMarkdown.ts`**

Cut `YmLotListingEntry` (64–71), `extractYmAlarmCountByLot` (305–337), `extractYmSuspectDutsByLot` (337–373), `extractTopFailBinByLot` (373–419), `LotListingContext`/`LotListingPresentation` (419–452), `inferLotListingPresentation` (452–471), `buildLotListingContext` (471–486), `extractYmLotsFromHistory` (486–529), `buildRecentLotsListingMarkdown` (1288–1616). Import classifier functions it needs from `./agentJbQuestionClassifiers.js`.

- [ ] **Step 4: Create `agentJbRankingMarkdown.ts`**

Cut `buildAggregateBinRankingMarkdown` (1998–2060), `buildBinCardAggregateMarkdown` (2060–2137), `buildBinDeviceAggregateMarkdown` (2137–2213), `buildBinFocusedLotRankingMarkdown` (2213–2540).

- [ ] **Step 5: Create `agentJbOverviewMarkdown.ts`**

Cut `BinTrendDigest`/`AgentTablesDigest` (32–44), `buildLotOverviewTablesMarkdown` (953–961), `buildDeterministicJbTables` (1616–1998), `buildDeterministicLotOverviewCommentary` (2540–2626), `detectAndFormatDataPatterns` (2626–2682), `DETERMINISTIC_TABLES_HEADER` (2682–end). Import from `agentJbListingMarkdown.js` / `agentJbRankingMarkdown.js` as needed (this file assembles the full deterministic reply table set).

- [ ] **Step 6: Create `agentJbPayloadResolve.ts`**

Cut everything not yet placed: `isGoodBinValueQuestion` (71–85) and `buildGoodBinValueMarkdown` (85–151) together (these two are tightly coupled — keep in this file since `buildGoodBinValueMarkdown` isn't a pure classifier), `parseJbToolPayload` (990–1002), `resolveJbToolPayload` (1002–1042), `shouldAppendUnderperformingDutYield` (1042–1288).

- [ ] **Step 7: Delete the old file**

```bash
rm src/lib/agent/agentJbDeterministicReply.ts
```

- [ ] **Step 8: Fix every external importer**

```bash
grep -rln 'agentJbDeterministicReply\.js"' src test
```

This will hit many files under `src/lib/agent/` (at minimum `agentLoop.ts`, `agentToolHandlers.ts` / its split successors from Task 7, `agentQueryScope.ts`) plus ~10 test files. For each, replace the single import with imports from whichever of the 5 new files actually holds the symbols used (check each importer's usage list against the export table above).

- [ ] **Step 9: Typecheck and iterate**

Run: `npm run typecheck` — expect many "Cannot find module" and "has no exported member" errors on the first pass given the scale of this split; work through them file by file until clean. This is the expected, self-correcting mechanism for this task — don't try to pre-enumerate every importer by hand.

- [ ] **Step 10: Run tests**

Run: `npm test` — expect all green, especially `test/agentJbDeterministicReply.test.ts` and the other JB-domain test files listed above.

- [ ] **Step 11: Extract-function pass**

`buildRecentLotsListingMarkdown` (~328 lines) and `buildDeterministicJbTables` (~380 lines) are the two largest functions moved in this task. While each is open in Steps 3 and 5, look for natural sub-sections (e.g. per-lot row formatting vs. summary-header formatting) and extract private named helpers within the same destination file. Re-run `npm test` after each extraction.

- [ ] **Step 12: Update CLAUDE.md**

`pcr-ai-api/CLAUDE.md` §6 does not currently list `agentJbDeterministicReply.ts` directly by name in a forward-looking row (confirm with `grep -n "agentJbDeterministicReply" pcr-ai-api/CLAUDE.md` — if a non-historical row exists, update it to point at `agent/jb/agentJbOverviewMarkdown.ts` as the closest successor).

- [ ] **Step 13: Commit**

```bash
git add -A
git commit -m "refactor(api): split agentJbDeterministicReply.ts into classifiers/listing/ranking/overview/payload files"
```

---

### Task 10: Split `lib/agent/agentPrompt.ts`

**Files:**
- Create: `src/lib/agent/prompt/agentPromptIntent.ts`
- Create: `src/lib/agent/prompt/agentPrompt.ts` (assembly only)
- Delete: `src/lib/agent/agentPrompt.ts`
- Test: `test/agentPrompt.test.ts` (existing)

**Interfaces:**
- Consumes: `DataManifest` type (check original file's import source).
- Produces: `agentPromptIntent.ts` exports `PromptIntent` (type) and `classifyIntent`. `prompt/agentPrompt.ts` exports `buildSystemPrompt`.

- [ ] **Step 1: Read the full file end to end**

Read `src/lib/agent/agentPrompt.ts` in full (1531 lines). Confirm: lines 1–1420 are string-template content assembled inside `buildSystemPrompt` (per the earlier `grep -n '^export'` scan, the only exports are `PromptIntent` at 1421, `classifyIntent` at 1434, `buildSystemPrompt` at 1487). Identify the natural section breaks inside `buildSystemPrompt`'s template (it's built from concatenated string constants/sections per topic — e.g. a section on "坏 Bin 编号与数量", one on "按 slot 分析某一 BIN", etc., per the dated CLAUDE.md history in §11).

- [ ] **Step 2: Create the `prompt/` subdirectory**

```bash
mkdir -p src/lib/agent/prompt
```

- [ ] **Step 3: Create `agentPromptIntent.ts`**

Cut `PromptIntent` (1421–1434) and `classifyIntent` (1434–1487) into `src/lib/agent/prompt/agentPromptIntent.ts`, with whatever imports `classifyIntent` needs (check its body from the Step 1 read — it likely takes plain strings and has no heavy dependencies).

- [ ] **Step 4: Create `prompt/agentPrompt.ts`**

Move the remaining content (lines 1–1420 template sections + `buildSystemPrompt` itself, 1487–end) into `src/lib/agent/prompt/agentPrompt.ts`, importing `PromptIntent`/`classifyIntent` back from `./agentPromptIntent.js` wherever `buildSystemPrompt` uses them (it takes `intent: PromptIntent = "general"` as a parameter per the signature at line 1487). Keep the internal string sections as local `const` blocks inside this same file for now — do not further fragment them into separate files in this task; the primary goal here is separating the (small, logic-bearing) intent classifier from the (large, static-text) prompt assembly. If any individual `const` string section exceeds ~150 lines and has a clear standalone topic, it MAY be extracted to its own file under `src/lib/agent/prompt/sections/` with a descriptive name (e.g. `badBinSection.ts` exporting a single string constant) — do this only if it clearly improves readability, and re-run `npm test` after each such extraction.

- [ ] **Step 5: Delete the old file**

```bash
rm src/lib/agent/agentPrompt.ts
```

- [ ] **Step 6: Fix every external importer**

```bash
grep -rln 'agentPrompt\.js"' src test
```

Update each hit to `./prompt/agentPrompt.js` (and `./prompt/agentPromptIntent.js` if it separately imports `classifyIntent`/`PromptIntent`), adjusting relative depth.

- [ ] **Step 7: Typecheck and iterate**

Run: `npm run typecheck` until clean.

- [ ] **Step 8: Run tests**

Run: `npm test` — expect all green, especially `test/agentPrompt.test.ts`.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor(api): split agentPrompt.ts into intent classifier and prompt assembly"
```

---

### Task 11: Split `lib/agent/agentLoop.ts`

**Files:**
- Create: `src/lib/agent/core/agentEmbeddedToolParsing.ts`
- Create: `src/lib/agent/core/agentToolStatus.ts`
- Create: `src/lib/agent/dispatch/agentQuestionHeuristics.ts`
- Create: `src/lib/agent/dispatch/agentSemanticDispatch.ts`
- Create: `src/lib/agent/tools/agentToolUnderperformingDutsRender.ts` (the two `tryEmit`/`tryAppend` underperforming-dut functions, which belong with Task 7's tool split but were still in `agentLoop.ts`)
- Create: `src/lib/agent/render/agentAggregateBinsRender.ts`
- Move: `src/lib/agent/agentLoop.ts` → `src/lib/agent/core/agentLoop.ts` (slimmed to `runAgentLoop` + the SSE type + `filterAgentStreamTextForUi`/`createDeepSeekFilter`, whichever of these stays as the loop's own concern — see Step 2 note)
- Move: `src/lib/agent/agentStream.ts` → `src/lib/agent/core/agentStream.ts`
- Move: `src/lib/agent/agentToolSchemas.ts` → `src/lib/agent/core/agentToolSchemas.ts`
- Test: `test/agentLoop.test.ts` (existing, the primary safety net — it directly tests `parseGlmToolCallBody`, `parseMinimaxInvokeBody`, `filterAgentStreamTextForUi`, `historyAwaitingToolSummary`, and others named in the export list; each assertion tells you exactly which new file that symbol must be re-exported from). Also run every other `test/agent*.test.ts` file since this is the most widely-depended-on module in the package.

**Interfaces:**
- Consumes: everything the original file imported (check its own top-of-file import block first).
- Produces (symbol → destination file, derived from the export scan of the original file):

| File | Exports |
|---|---|
| `core/agentEmbeddedToolParsing.ts` | `parseGlmToolCallBody`, `parseMinimaxInvokeBody`, `filterAgentStreamTextForUi` (this is `createDeepSeekFilter`'s public entry point per CLAUDE.md §11 item 14 — keep the name `filterAgentStreamTextForUi` as the export, since that's what tests and `agentStream.ts` currently import) |
| `core/agentToolStatus.ts` | `isLastToolEmptyResult`, `toolStatusLabel`, `historyAwaitingToolSummary` |
| `dispatch/agentQuestionHeuristics.ts` | `isDutBinConcentrationQuestion`, `questionHasIdentifiableToolScope`, `requiresNewDataQuery`, `cachedJbScopeMismatchReason`, `equipmentRouteCrossLotBail` |
| `dispatch/agentSemanticDispatch.ts` | `tryRunSemanticDispatchDirectRoute` |
| `tools/agentToolUnderperformingDutsRender.ts` | `tryEmitUnderperformingDutScatter`, `tryAppendUnderperformingDutSection` |
| `render/agentAggregateBinsRender.ts` | `AggregateJbBinsRender` (type), `renderAggregateJbBinsResult` |
| `core/agentLoop.ts` (slimmed) | `AgentSseEvent` (type), `runAgentLoop` — plus re-exports (not re-implementations) of `filterAgentStreamTextForUi` etc. only if existing external importers need them from this exact path; prefer updating those importers instead (no re-export layer per Global Constraints) |

- [ ] **Step 1: Read the full file end to end**

Read `src/lib/agent/agentLoop.ts` in full (4384 lines) before cutting. This is the highest-risk file in the plan — confirm the actual call graph: `runAgentLoop` almost certainly calls `tryRunSemanticDispatchDirectRoute`, `renderAggregateJbBinsResult`, `tryEmitUnderperformingDutScatter`/`tryAppendUnderperformingDutSection`, the heuristics, and the embedded-tool-parsing functions, so `core/agentLoop.ts` will need to import from all the other new files created in this task.

- [ ] **Step 2: Create `core/` and move `agentStream.ts` + `agentToolSchemas.ts`**

```bash
mkdir -p src/lib/agent/core
git mv src/lib/agent/agentStream.ts src/lib/agent/core/agentStream.ts
git mv src/lib/agent/agentToolSchemas.ts src/lib/agent/core/agentToolSchemas.ts
```
Fix their internal relative imports (one directory deeper), including `agentStream.ts`'s import of `filterAgentStreamTextForUi` (per CLAUDE.md §11 item 14, `agentStream.ts` only forwards `delta.content` — check whether it actually imports the filter or whether that's applied downstream in `agentLoop.ts`; read both files' current imports in Step 1 to confirm before assuming).

- [ ] **Step 3: Create `core/agentEmbeddedToolParsing.ts`**

Cut `parseGlmToolCallBody` (225–288), `parseMinimaxInvokeBody` (288–712 minus unrelated content in between — re-check exact boundary against the Step 1 read since line 712 is where `filterAgentStreamTextForUi` starts, so `parseMinimaxInvokeBody`'s real end is wherever its function body closes, likely well before 712), `filterAgentStreamTextForUi` (712–1672, the `createDeepSeekFilter` machinery) into this file.

- [ ] **Step 4: Create `core/agentToolStatus.ts`**

Cut `isLastToolEmptyResult` (3339–3367), `toolStatusLabel` (3367–3440), `historyAwaitingToolSummary` (3440–3619) into this file.

- [ ] **Step 5: Create `dispatch/` and its two files**

```bash
mkdir -p src/lib/agent/dispatch
```

Cut `isDutBinConcentrationQuestion` (1672–1765), `questionHasIdentifiableToolScope` (1765–1795), `requiresNewDataQuery` (1795–1816), `cachedJbScopeMismatchReason` (1816–1852), `equipmentRouteCrossLotBail` (1852–2058) into `dispatch/agentQuestionHeuristics.ts`.

Cut `tryRunSemanticDispatchDirectRoute` (2058–2155) into `dispatch/agentSemanticDispatch.ts`, importing the heuristics it calls from `./agentQuestionHeuristics.js`.

- [ ] **Step 6: Create `tools/agentToolUnderperformingDutsRender.ts`**

Cut `tryEmitUnderperformingDutScatter` (2155–2274), `tryAppendUnderperformingDutSection` (2274–2835) into `src/lib/agent/tools/agentToolUnderperformingDutsRender.ts` (this directory already exists from Task 7 — add to it, don't recreate).

- [ ] **Step 7: Create `render/` and its file**

```bash
mkdir -p src/lib/agent/render
```

Cut `AggregateJbBinsRender` (2835–2842) and `renderAggregateJbBinsResult` (2842–3339) into `render/agentAggregateBinsRender.ts`.

- [ ] **Step 8: Move and slim `agentLoop.ts` itself**

```bash
git mv src/lib/agent/agentLoop.ts src/lib/agent/core/agentLoop.ts
```

Remove everything cut in Steps 3–7. Keep `AgentSseEvent` (150–225) and `runAgentLoop` (3619–end). Add imports for everything `runAgentLoop` calls from the new files:

```typescript
import { parseGlmToolCallBody, parseMinimaxInvokeBody, filterAgentStreamTextForUi } from "./agentEmbeddedToolParsing.js";
import { isLastToolEmptyResult, toolStatusLabel, historyAwaitingToolSummary } from "./agentToolStatus.js";
import { isDutBinConcentrationQuestion, questionHasIdentifiableToolScope, requiresNewDataQuery, cachedJbScopeMismatchReason, equipmentRouteCrossLotBail } from "../dispatch/agentQuestionHeuristics.js";
import { tryRunSemanticDispatchDirectRoute } from "../dispatch/agentSemanticDispatch.js";
import { tryEmitUnderperformingDutScatter, tryAppendUnderperformingDutSection } from "../tools/agentToolUnderperformingDutsRender.js";
import { renderAggregateJbBinsResult } from "../render/agentAggregateBinsRender.js";
```

(Trim this import list to only what `runAgentLoop`'s body — confirmed from the Step 1 read — actually calls; some of these functions may only be called from each other and not directly from `runAgentLoop`, in which case the import belongs in a different new file instead.)

- [ ] **Step 9: Delete nothing further — the old path is already gone via `git mv`**

Confirm: `ls src/lib/agent/agentLoop.ts` should report "No such file or directory".

- [ ] **Step 10: Fix every external importer**

```bash
grep -rln 'agentLoop\.js"\|agentStream\.js"\|agentToolSchemas\.js"' src test
```

This is the widest fan-out in the whole plan — expect hits across most of `src/lib/agent/`, `src/routes/agent.ts`, and 15+ test files. For each hit, determine which specific symbols it imports (re-check each importer's import statement) and point it at the correct new file per the export table above. Do this systematically file-by-file rather than trying to batch it with a single sed pass, since different importers need different destination files for the same old specifier.

- [ ] **Step 11: Typecheck and iterate**

Run: `npm run typecheck`. Given the scale of this task, expect this to take several iterations — treat each compiler error as a to-do item (wrong import path, or a symbol that needs to also be imported from a second new file). Keep iterating until the command exits clean.

- [ ] **Step 12: Run the full test suite**

Run: `npm test` — this is the most important verification in the entire plan, since `agentLoop.ts` is the ReAct loop core. Expect all tests green, with particular attention to `test/agentLoop.test.ts`, `test/agentRoute.test.ts`, `test/agentStream.test.ts`, `test/agentEval.test.ts`, and the `test/eval/` scenario suite.

- [ ] **Step 13: Extract-function pass**

`runAgentLoop` itself (the remaining core function) was originally part of a ~765-line block (3619–4384). Now that it's isolated in its own file with the heuristics/dispatch/render logic moved out, re-read it: if it still exceeds ~100 lines with distinct phases (e.g. "build request" / "stream response" / "handle tool_calls" / "loop control"), extract private named helper functions for each phase within `core/agentLoop.ts`. Re-run `npm test` after each extraction — do this incrementally (one phase at a time), not as one big rewrite, given this is the highest-risk file in the plan.

- [ ] **Step 14: Update CLAUDE.md**

`pcr-ai-api/CLAUDE.md` references `agentLoop.ts` in many places (§2, §6, §9, §12, and the dated §11 entries). Update only the forward-looking, non-dated references: §6 table row "AI Agent（报表聊天页）" (`src/routes/agent.ts` ... 核心 loop `agentLoop.ts`... → `agent/core/agentLoop.ts`), and any similar forward-looking mention in §9/§12. Leave every numbered, dated §11 entry unchanged (Global Constraints).

- [ ] **Step 15: Commit**

```bash
git add -A
git commit -m "refactor(api): split agentLoop.ts into core/dispatch/tools/render modules"
```

---

### Task 12: Final verification and merge readiness

**Files:** none (verification only).

- [ ] **Step 1: Full clean install and build**

```bash
cd pcr-ai-api
rm -rf node_modules dist
npm ci
npm run build
```
Expected: build succeeds, including the `verify-dist-no-undici` check (no `undici` in `dist/lib/siliconflowChat.js`).

- [ ] **Step 2: Typecheck and full test suite one more time**

```bash
npm run typecheck
npm test
```
Expected: both clean/green.

- [ ] **Step 3: Confirm no file in `src/` still exceeds ~500 lines outside the accepted exceptions**

```bash
find src -name "*.ts" | xargs wc -l | sort -n | tail -20
```
Expected: only `core/agentLoop.ts` (and possibly `agentJbBinFormat.ts`, `agentQueryScope.ts`, `agentJbHistoryCompact.ts`, which the spec explicitly left un-split — see spec §3 notes "先保留观察") may still exceed 500 lines. Any other file over ~500 lines that wasn't explicitly called out as an accepted exception in this plan should be flagged to the user before merging, not silently split further.

- [ ] **Step 4: Grep CLAUDE.md for any remaining stale forward-looking file references**

```bash
grep -n "apiManifest\.ts\|agentJbDeterministicReply\.ts\|agentPrompt\.ts\|agentToolHandlers\.ts\|jbYieldCalc\.ts\|infWaferMap\.ts\|yieldMonitorPeriodAlarmTrend\.ts" pcr-ai-api/CLAUDE.md
```
For every hit that is NOT inside a numbered §11 entry (check the surrounding context), confirm it was updated in the relevant task above; fix any missed ones now.

- [ ] **Step 5: Report to user for merge decision**

Do not merge `refactor/api-domain-split` into `main` automatically. Summarize the final directory structure and line-count table to the user and ask whether to merge (and whether to squash or keep the per-task commit history), per the Global Constraints/spec §7.
