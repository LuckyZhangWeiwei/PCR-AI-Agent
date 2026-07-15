# pcr-ai-api Domain Split Refactor — Round 2 (Task 13–18)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This plan continues the numbering and Global Constraints of `docs/superpowers/plans/2026-07-12-api-domain-split.md` (Tasks 0–12, already complete) — it is a follow-up round targeting files that were either out of that plan's scope entirely, or grew past the soft budget via the 2026-07-14 merge from `main`.

**Goal:** Split six more oversized files (615–1040 lines) into domain-oriented directories/files, no behavior change, verified by the existing test suite at every step. Continues the same ledger at `.superpowers/sdd/progress.md`.

**Scope for this round (user-selected 2026-07-14):** Task 13 (`outputSiteBinByLot.ts`, the file that grew the most from today's `main` merge) and Task 14–18 (the five "pure move only, never content-split" files inherited unchanged from Round 1). Deferred: `infAnalysisRoutes.ts` (517 lines, only just over budget) and `core/agentLoop.ts` (explicitly a permanent exception, do not touch).

## Global Constraints

Identical to Round 1's Global Constraints (`docs/superpowers/plans/2026-07-12-api-domain-split.md`) — repeated here for a self-contained brief:

- **Pure move-only.** No behavior, HTTP path, response field, or error code changes anywhere in this plan.
- **No barrel/re-export compatibility layer.** Every import site is updated to point directly at the new file.
- **Domain-oriented directories, not technical layers.**
- **Soft file-size budget ~400–500 lines.**
- **Extract-function principle:** while splitting a domain, if a function is > ~80–100 lines or deeply nested, extract clearly-named sub-functions in the same pass. Must be behavior-preserving, verified by the same test run.
- **Every task ends with:** `npm run typecheck` (from `pcr-ai-api/`) then `npm test` (from `pcr-ai-api/`), both green, before commit. Known pre-existing unrelated failures (do not try to fix): `test/jbRouteResolver.test.ts` 2 tests (checked-in `runtime-config.json` hardcodes `jbLlmIntentClassifier: true`); `test/agentRoute.test.ts` 1 SSE timing flake under full-suite load (passes in isolation).
- **Branch:** continues on `refactor/api-domain-split` (already exists, already has Tasks 0–12 + a merge-with-main commit).
- **Docs:** update `pcr-ai-api/CLAUDE.md` §6 ("源码速查") and §2 ("必读文档") table rows whenever a task moves a file referenced there. Do not touch dated §11 entries or `docs/HANDOFF_*.md`.
- All commands assume working directory `d:\AI\PCR-AI-Agent\pcr-ai-api` unless stated; git commands run from `d:\AI\PCR-AI-Agent` (repo root, monorepo).

---

### Task 13: Split `lib/outputSiteBinByLot.ts` (1040 lines)

**Files:**
- Create: `src/lib/outputSiteBinByLot/types.ts`
- Create: `src/lib/outputSiteBinByLot/params.ts`
- Create: `src/lib/outputSiteBinByLot/perlRunner.ts`
- Create: `src/lib/outputSiteBinByLot/singleWafer.ts`
- Create: `src/lib/outputSiteBinByLot/layersBatch.ts`
- Create: `src/lib/outputSiteBinByLot/aggregate.ts`
- Delete: `src/lib/outputSiteBinByLot.ts`
- Test: `test/outputSiteBinByLot.test.ts`, `test/infDutSelection.test.ts`, `test/lotUnderperformingDuts.test.ts`, `test/siteBinMultiWaferHttpDummy.test.ts`, `test/agentDutConcentration.test.ts`

**19 known importers** (grep confirmed 2026-07-14, re-verify before starting since this changes fast): `src/lib/agent/agentDutConcentration.ts`, `src/lib/agent/tools/agentChartTool.ts`, `src/lib/agent/tools/agentToolDutBinAgg.ts`, `src/lib/agent/tools/agentToolHandlers.ts`, `src/lib/agent/tools/agentToolInfSiteBin.ts`, `src/lib/infOracleMapFallback.ts`, `src/lib/infTools/infToolCore.ts`, `src/lib/lotUnderperformingDuts.ts`, `src/lib/lotUnderperformingDutsResolve.ts`, `src/lib/outputSiteBinByLotDummy.ts`, `src/lib/siteBinByLotDeviceTopN.ts`, `src/lib/siteBinByLotTestEndWindow.ts`, `src/lib/siteBinByLotWaferResolve.ts`, `src/routes/infAnalysisRoutes.ts`, `test/agentDutConcentration.test.ts`, `test/infDutSelection.test.ts`, `test/lotUnderperformingDuts.test.ts`, `test/outputSiteBinByLot.test.ts`, `test/siteBinMultiWaferHttpDummy.test.ts`.

**Interfaces (symbol → destination file, verified against the current 1040-line file 2026-07-14):**

| File | Exports |
|---|---|
| `types.ts` | `SiteBinDutEntry`, `SiteBinEntry`, `SiteBinPass`, `SiteBinByLotData`, `RunOutputSiteBinByLotResult`, `RunSiteBinForWaferOpts`, `RunOutputSiteBinByLotAggregateResult`, `SiteBinLayerRequest`, `SiteBinLayerResult`, `RunSiteBinLayersBatchResult`, `OutputSiteBinByLotValidationError`, `OutputSiteBinByLotNotFoundError`, `InfSiteBinUnavailableError`, `SITE_BIN_BY_LOT_SUMMARY`, `SITE_BIN_LAYERS_BATCH_SUMMARY`, `SITE_BIN_BY_LOT_LOT_DIR_AGG_SUMMARY`, `SITE_BIN_BY_LOT_LOT_AGG_SUMMARY`, `SITE_BIN_BY_LOT_DEVICE_AGG_SUMMARY`, `SITE_BIN_LAYERS_BATCH_MAX` |
| `params.ts` | `parseOptionalPassNum`, `parseOptionalLayerTestEnd`, `parseOptionalKeynumber`, `validateInfPath`, `validateDeviceLot`, `parsePassIdsFromQuery`, `getPerlBin`, `getPerlScriptTimeoutMs`, `getSiteBinByLotMaxWafers`, `getSiteBinByLotMaxWafersDevice`; private `readMaxWafersEnv` |
| `perlRunner.ts` | `runOutputSiteBinByLot`, `parseSiteBinByLotJson`; private `resolvePerlScriptPath` |
| `singleWafer.ts` | `runSiteBinForWafer`, `mergeSiteBinByLotData`; private `dutSortKey` |
| `layersBatch.ts` | `runSiteBinForWaferLayers`, `parseSiteBinLayersBody`; private `parseSiteBinLayerPassIds` |
| `aggregate.ts` | `runOutputSiteBinByLotForLotByDirectory`, `runOutputSiteBinByLotForLot`, `runOutputSiteBinByLotForDevice`, `listWaferInfPathsInLotDir`; private `runPerlForWafers`, `assertWaferCountWithinLimit`, `appendOracleFallbackStderr`, `WAFER_INF_BASENAME_RE` |

**Call graph notes for the implementer:**
- `aggregate.ts` imports `runSiteBinForWafer`/`mergeSiteBinByLotData` from `./singleWafer.js`, `runOutputSiteBinByLot`... wait, `aggregate.ts` calls `runPerlForWafers` (its own private helper) which calls `runSiteBinForWafer` from `singleWafer.ts` — not `runOutputSiteBinByLot`/`perlRunner.ts` directly.
- `singleWafer.ts`'s `runSiteBinForWafer` calls `runOutputSiteBinByLot` + `parseSiteBinByLotJson` from `./perlRunner.js`, plus `siteBinByLotUseDummy`/`tryResolveSiteBinByLotDummy` from `../outputSiteBinByLotDummy.js` (one directory up from the new `outputSiteBinByLot/` subdir), plus `fetchSiteBinByLotFromOracle`/`infPathReadable`/`OracleMapFallbackNotFoundError`/`oracleMapFallbackEnabled`/types from `../infOracleMapFallback.js`.
- `layersBatch.ts`'s `runSiteBinForWaferLayers` calls `runSiteBinForWafer`/`mergeSiteBinByLotData` from `./singleWafer.js`, and `parsePassIdsFromQuery`/`validateInfPath` from `./params.js` (via its own `parseSiteBinLayerPassIds` helper), plus `parseInfWaferCoordsFromPath` from `../buildInfPath.js`.
- `aggregate.ts` also needs `buildInfDeviceDir`/`buildInfLotDir` from `../buildInfPath.js`, `resolveSiteBinWafersWithSkips`/`SiteBinWaferRef` from `../siteBinByLotWaferResolve.js`, `SiteBinTestEndWindow` from `../siteBinByLotTestEndWindow.js`.
- All 6 new files import shared types/errors from `./types.js`.

- [ ] **Step 1:** Read `src/lib/outputSiteBinByLot.ts` in full (already done by the planner in this session — re-confirm current line numbers haven't drifted before cutting, since other same-day work may have touched it).
- [ ] **Step 2:** Create `outputSiteBinByLot/` subdirectory and the 6 files per the table above, cutting code verbatim (no logic changes).
- [ ] **Step 3:** Delete the old file.
- [ ] **Step 4:** Fix all 19 known importers (re-grep first: `grep -rln 'outputSiteBinByLot\.js"' src test scripts` — the old flat-file specifier `./outputSiteBinByLot.js` / `../outputSiteBinByLot.js` must be replaced with the correct new subpath, e.g. `./outputSiteBinByLot/types.js` for type-only imports, `./outputSiteBinByLot/aggregate.js` for the three aggregate functions, etc. — check each importer's actual used symbols against the table above).
- [ ] **Step 5:** `npm run typecheck`, iterate until clean.
- [ ] **Step 6:** `npm test`, expect all green except the 2 documented pre-existing failures.
- [ ] **Step 7:** Update `pcr-ai-api/CLAUDE.md` §6 row(s) referencing `outputSiteBinByLot.ts` (search first: `grep -n "outputSiteBinByLot" pcr-ai-api/CLAUDE.md`; only edit non-dated hits).
- [ ] **Step 8:** Commit: `git commit -m "refactor(api): split outputSiteBinByLot.ts into types/params/perlRunner/singleWafer/layersBatch/aggregate"`.

---

### Task 14: Split `lib/infcontrol/jbYieldCalc.ts` (841 lines)

**Files:**
- Create: `src/lib/infcontrol/jbYield/jbYieldRowHelpers.ts`
- Create: `src/lib/infcontrol/jbYield/jbYieldHalves.ts`
- Create: `src/lib/infcontrol/jbYield/jbYieldMetrics.ts`
- Create: `src/lib/infcontrol/jbYield/jbYieldRank.ts`
- Create: `src/lib/infcontrol/jbYield/jbYieldByPass.ts`
- Delete: `src/lib/infcontrol/jbYieldCalc.ts`
- Test: `test/jbYieldCalc.test.ts`, `test/agentJbBinFormat.test.ts`, `test/agentJbHistoryCompact.test.ts`, `test/jbAgentLotQuery.test.ts`

**14 known importers** (grep confirmed 2026-07-14): `src/lib/agent/agentCrossdomainInsights.ts`, `src/lib/agent/agentDutConcentration.ts`, `src/lib/agent/jb/agentJbBadBinCluster.ts`, `src/lib/agent/jb/agentJbBinFormat.ts`, `src/lib/agent/jb/agentJbBinTrend.ts`, `src/lib/agent/jb/agentJbHistoryCompact.ts`, `src/lib/agent/jb/agentJbOverviewMarkdown.ts`, `src/lib/agent/jb/agentJbPayloadResolve.ts`, `src/lib/lotUnderperformingDuts.ts`, `src/lib/lotUnderperformingDutsResolve.ts`, `src/lib/probeCard/probeCardTesterPerformance.ts`, `test/agentJbBinFormat.test.ts`, `test/agentJbHistoryCompact.test.ts`, `test/jbAgentLotQuery.test.ts`, `test/jbYieldCalc.test.ts`.

**Interfaces (symbol → destination file):**

| File | Exports |
|---|---|
| `jbYieldRowHelpers.ts` | `JB_HARD_GOOD_BIN`, `goodBinIndicesForJbRow`, `badDieFromJbRow`, `isInterruptPasstype`, `isRetestBinPasstype`, `passIdFromJbRow`, `passNumFromJbRow`, `lotFromJbRow`, `sumBadBinDieOnRows` |
| `jbYieldHalves.ts` | `BinDieByHalves` (type), `binDieByHalvesForGroup`, `countTestInterruptEvents`, `splitPassGroupIntoHalves`, `splitSlotIntoHalves` |
| `jbYieldMetrics.ts` | `JbYieldMetrics` (type), `segmentMetrics`, `computeJbYieldMetrics`, `YieldInterruptSegment` (type), `SlotYieldSummaryEntry` (type), `buildYieldInterruptSegments`, `computeJbYieldBreakdown`, `yieldSummaryEligibleRow`, `buildSlotYieldSummary` |
| `jbYieldRank.ts` | `LotYieldRankEntry` (type), `buildLotYieldRank`, `slotYieldSummaryFieldGuide`, `testInterruptCountFieldGuide`, `lotYieldRankFieldGuide`, `passIdSortLabel` |
| `jbYieldByPass.ts` | `YieldByPassEntry` (type), `buildYieldByPassId`, `SlotYieldPivotCell` (type), `SlotYieldPivot` (type), `buildSlotYieldPivot`, `yieldByPassFieldGuide`, `slotYieldPivotFieldGuide`, `slotPivotDisplayMetrics`, `slotYieldInterruptFieldGuide`, `SlotYieldInterruptRow` (type), `buildSlotYieldInterruptRows` |

**Call graph notes:** read the file first to confirm cross-file calls before cutting — at minimum expect `jbYieldMetrics.ts` to import from `jbYieldRowHelpers.ts` and `jbYieldHalves.ts` (segment/breakdown building uses row helpers + halves splitting); `jbYieldRank.ts` and `jbYieldByPass.ts` likely import from `jbYieldMetrics.ts` and `jbYieldRowHelpers.ts`. Verify actual imports needed by reading each function body — do not guess from names alone.

- [ ] **Step 1:** Read `src/lib/infcontrol/jbYieldCalc.ts` in full; confirm the actual call graph between the 5 groups above (which functions in `jbYieldRank.ts`/`jbYieldByPass.ts` call helpers from the other 3 files).
- [ ] **Step 2:** Create `jbYield/` subdirectory and the 5 files, cutting verbatim.
- [ ] **Step 3:** Delete the old file.
- [ ] **Step 4:** Fix all 14 known importers (re-grep first: `grep -rln 'jbYieldCalc\.js"' src test`).
- [ ] **Step 5:** `npm run typecheck`, iterate until clean.
- [ ] **Step 6:** `npm test`, expect all green except the 2 documented pre-existing failures.
- [ ] **Step 7:** Update `pcr-ai-api/CLAUDE.md` §6 if it references `jbYieldCalc.ts` in a non-dated row.
- [ ] **Step 8:** Commit: `git commit -m "refactor(api): split jbYieldCalc.ts into jbYield/{rowHelpers,halves,metrics,rank,byPass}"`.

---

### Task 15: Split `lib/agent/tools/agentFilterValuesTool.ts` (888 lines)

**Files:**
- Create: `src/lib/agent/tools/filterValues/agentFilterValuesDeviceMask.ts`
- Create: `src/lib/agent/tools/filterValues/agentFilterValuesSearch.ts`
- Create: `src/lib/agent/tools/filterValues/agentFilterValuesDummy.ts`
- Create: `src/lib/agent/tools/filterValues/agentFilterValuesOracle.ts`
- Modify: `src/lib/agent/tools/agentFilterValuesTool.ts` (slimmed to `runGetFilterValues` dispatcher + shared consts/types)
- Test: `test/agentFilterValues.test.ts`

**3 known importers:** `src/lib/agent/tools/agentToolHandlers.ts`, `test/agentFilterValues.test.ts`, `scripts/simulate-agent-p11c-mask.mjs` (only `runGetFilterValues` is imported externally — confirm via grep before starting; if so, only the slimmed `agentFilterValuesTool.ts`'s own path needs zero external updates since it stays in place, only its internal imports change).

**Interfaces (symbol → destination file, verified against the current 888-line file 2026-07-14):**

| File | Exports (all currently private/unexported — keep unexported unless cross-file use requires `export`) |
|---|---|
| `agentFilterValuesDeviceMask.ts` | `clampDeviceMaskLimit`, `dateKey`, `maxDateKey`, `formatDeviceByMaskValue`, `buildMultiDeviceNote`, `mergeDeviceByMaskMaps`, `collectDeviceByMaskMaps`, `dummyDeviceByMaskBoth`, `oracleDeviceByMaskBoth`, `resolveDeviceMaskArg`, `dummyDeviceByMask`, `oracleYieldDeviceByMaskMap`, `oracleJbDeviceByMaskMap`, `oracleYieldDeviceByMask`, `oracleJbDeviceByMask`; type `DeviceByMaskEntry` |
| `agentFilterValuesSearch.ts` | `clampLimit`, `countDistinct`, `expandTesterSearchTerms`, `countDistinctWithSearchFallback`, `enrichEmptyTesterSearchResult`, `enrichEmptyCardEnumResult`, `oracleYieldWithSearchFallback`, `oracleJbWithSearchFallback` |
| `agentFilterValuesDummy.ts` | `dummyYield`, `dummyJb` |
| `agentFilterValuesOracle.ts` | `formatOracleLastTest`, `oracleYield`, `oracleJb` |
| `agentFilterValuesTool.ts` (slimmed) | `runGetFilterValues` (public entry point, unchanged export), `DEFAULT_LIMIT`, `MAX_LIMIT`, `DEVICE_MASK_DEFAULT_LIMIT`, `YIELD_FIELDS`, `JB_FIELDS`, `YieldField`/`JbField` types, `FilterValuesResult` interface — decide during implementation whether these need `export` for cross-file use vs staying local to the dispatcher; several of the split-out functions in the 4 new files reference `YIELD_FIELDS`/`JB_FIELDS`/`YieldField`/`JbField`/`FilterValuesResult`, so those almost certainly need to move to whichever file is imported earliest in the dependency chain (likely `agentFilterValuesSearch.ts` or a shared spot — read the actual usage before deciding; do not create a 6th file just for 5 shared consts unless genuinely necessary) |
| — | private helper `enrichEmptyCardEnumResult`/`enrichEmptyTesterSearchResult` also referenced from the dispatcher — keep exported from `agentFilterValuesSearch.ts` |

- [ ] **Step 1:** Read `src/lib/agent/tools/agentFilterValuesTool.ts` in full (888 lines); resolve the shared-consts placement question above by tracing actual call sites before cutting.
- [ ] **Step 2:** Create `filterValues/` subdirectory and the 4 new files, cutting verbatim; export what's needed cross-file, keep the rest module-private.
- [ ] **Step 3:** Slim `agentFilterValuesTool.ts` itself to the dispatcher, importing from the 4 new files.
- [ ] **Step 4:** Fix external importers (re-grep first: `grep -rln 'agentFilterValuesTool\.js"' src test scripts` — likely only need updates if they imported something OTHER than `runGetFilterValues`, e.g. types; confirm with grep before assuming zero changes needed).
- [ ] **Step 5:** `npm run typecheck`, iterate until clean.
- [ ] **Step 6:** `npm test`, expect all green except the 2 documented pre-existing failures, especially `test/agentFilterValues.test.ts`.
- [ ] **Step 7:** Update `pcr-ai-api/CLAUDE.md` §6 if it references `agentFilterValuesTool.ts` in a non-dated row.
- [ ] **Step 8:** Commit: `git commit -m "refactor(api): split agentFilterValuesTool.ts into filterValues/{deviceMask,search,dummy,oracle}"`.

---

### Task 16: Split `lib/infWaferMap/infWaferMapHtml.ts` (729 lines)

**Files:**
- Create: `src/lib/infWaferMap/html/waferMapHtml.ts`
- Create: `src/lib/infWaferMap/html/lotHeatmapHtml.ts`
- Create: `src/lib/infWaferMap/html/slotTrendHtml.ts`
- Create: `src/lib/infWaferMap/html/dutBinMapHtml.ts`
- Delete: `src/lib/infWaferMap/infWaferMapHtml.ts`
- Test: no dedicated test file found for this — run full suite; exercised indirectly via `infTools` tests if any exist (check `test/` for `infTools` or `waferMap` coverage before starting).

**2 known importers:** `src/lib/infTools/infToolsLot.ts`, `src/lib/infTools/infToolsSingleWafer.ts` (this second one is ALSO a Round-2 target, Task 18 below — sequence matters: do Task 16 before Task 18, or handle both files' cross-references in whichever order but re-grep after each).

**Interfaces (symbol → destination file, one generator function per file — these are independent HTML report renderers with minimal/no shared logic; verify during Step 1 whether any shared formatting helpers exist between them and extract those into a 5th `html/waferMapHtmlShared.ts` only if genuinely duplicated, not preemptively):**

| File | Exports |
|---|---|
| `waferMapHtml.ts` | `WaferMapPass` (type), `generateWaferMapHtml` |
| `lotHeatmapHtml.ts` | `LotHeatmapPass` (type), `generateLotHeatmapHtml` |
| `slotTrendHtml.ts` | `generateSlotTrendHtml` |
| `dutBinMapHtml.ts` | `DutBinDieEntry` (type), `generateDutBinMapHtml` |

- [ ] **Step 1:** Read `src/lib/infWaferMap/infWaferMapHtml.ts` in full (729 lines); check for shared private helpers/constants used across more than one of the 4 generator functions (e.g. shared SVG/color palette helpers) — if found, decide the least-duplicative placement (a small shared file, or duplicate if trivial per YAGNI) and note the decision in the commit message.
- [ ] **Step 2:** Create `html/` subdirectory and the 4 (or 5) files, cutting verbatim.
- [ ] **Step 3:** Delete the old file.
- [ ] **Step 4:** Fix the 2 known importers (re-grep first: `grep -rln 'infWaferMapHtml\.js"' src test`).
- [ ] **Step 5:** `npm run typecheck`, iterate until clean.
- [ ] **Step 6:** `npm test`, expect all green except the 2 documented pre-existing failures.
- [ ] **Step 7:** Update `pcr-ai-api/CLAUDE.md` §6 if it references `infWaferMapHtml.ts` in a non-dated row.
- [ ] **Step 8:** Commit: `git commit -m "refactor(api): split infWaferMapHtml.ts into html/{waferMap,lotHeatmap,slotTrend,dutBinMap}"`.

---

### Task 17: Split `lib/infcontrol/infcontrolLayerBinDummy.ts` (615 lines)

**Files:**
- Create: `src/lib/infcontrol/infcontrolLayerBinDummyV3.ts`
- Modify: `src/lib/infcontrol/infcontrolLayerBinDummy.ts` (slimmed to rows-loader + v1/v2)
- Test: `test/infcontrolBinColumnFilters.test.ts`, `test/infDutSelection.test.ts`, `test/outputSiteBinByLot.test.ts`, `test/rest-api-v3-dummy.test.ts`, `test/siteBinMultiWaferHttpDummy.test.ts`

**19 known importers** — since this is a 2-way split with the ORIGINAL filename kept (not deleted), most importers need ZERO changes (only importers of the NEW v3-specific symbols need updating). Re-grep for which importers actually use the 4 v3-specific symbols before assuming broad impact: `grep -rln 'filterInfcontrolLayerBinV3DummyRowsMatching\|filterInfcontrolLayerBinV3DummyRows\|aggregateInfcontrolLayerBinV3FromRows\|aggregateInfcontrolLayerBinV3DummyRows' src test`.

**Interfaces (symbol → destination file):**

| File | Exports |
|---|---|
| `infcontrolLayerBinDummy.ts` (slimmed, path unchanged) | `InfcontrolLayerBinDummyRow` (interface), `getInfcontrolLayerBinDummyRows`, `getInfcontrolDummyExampleQuery`, `infcontrolLayerBinsUseDummy`, `filterInfcontrolLayerDummyRowsMatching`, `filterInfcontrolLayerDummyRows`, `filterInfcontrolLayerBinV2DummyRows`, `aggregateInfcontrolLayerBinV2BadBinsDummy`, `InfcontrolLayerBinDummyAggregateGroup` (type), `aggregateInfcontrolLayerBinDummyRows` |
| `infcontrolLayerBinDummyV3.ts` | `filterInfcontrolLayerBinV3DummyRowsMatching`, `filterInfcontrolLayerBinV3DummyRows`, `aggregateInfcontrolLayerBinV3FromRows`, `aggregateInfcontrolLayerBinV3DummyRows` — importing `InfcontrolLayerBinDummyRow`, `getInfcontrolLayerBinDummyRows` etc. back from `./infcontrolLayerBinDummy.js` as needed |

**Note:** this task keeps the original filename/path for the v1/v2 half specifically because 15+ of the 19 importers only use v1/v2 or the rows-loader — minimizing needless import-path churn per the "no barrel/re-export" spirit while still following "domain-oriented, not everything-in-one-file." Confirm during Step 1 whether this asymmetric split (keep original name for the bigger/more-imported half, new file only for the v3-specific 4 functions) is still right once you've re-read the file — if the v1/v2 half is itself still >500 lines after removing v3, that's fine per the soft-budget language ("soft"), but flag it in your report if it's not a clean win.

- [ ] **Step 1:** Read `src/lib/infcontrol/infcontrolLayerBinDummy.ts` in full (615 lines); confirm the v1/v2 vs v3 split boundary and call graph.
- [ ] **Step 2:** Create `infcontrolLayerBinDummyV3.ts`, cutting the 4 v3 functions verbatim.
- [ ] **Step 3:** Slim the original file, removing the 4 cut functions.
- [ ] **Step 4:** Fix importers of the 4 moved symbols only (re-grep per above).
- [ ] **Step 5:** `npm run typecheck`, iterate until clean.
- [ ] **Step 6:** `npm test`, expect all green except the 2 documented pre-existing failures.
- [ ] **Step 7:** Update `pcr-ai-api/CLAUDE.md` §6 if needed (likely no change since the primary file path is unchanged).
- [ ] **Step 8:** Commit: `git commit -m "refactor(api): split v3 dummy aggregation out of infcontrolLayerBinDummy.ts"`.

---

### Task 18: Split `lib/infTools/infToolsSingleWafer.ts` (961 lines)

**Files:**
- Create: `src/lib/infTools/singleWafer/infToolsBasics.ts`
- Create: `src/lib/infTools/singleWafer/infToolsSpatialAnalysis.ts`
- Create: `src/lib/infTools/singleWafer/infToolsProbeQuality.ts`
- Create: `src/lib/infTools/singleWafer/infToolsVisualization.ts`
- Delete: `src/lib/infTools/infToolsSingleWafer.ts`
- Test: no dedicated test file found — check `test/` for `infTools`-related coverage before starting; run full suite regardless.

**1 known importer:** `src/lib/infTools/index.ts` (likely a barrel that re-exports everything — if so, this is the ONE place allowed to re-export within `infTools/`'s own existing pattern; check `index.ts`'s current style before assuming Global Constraints' "no barrel" rule applies here the same way it did for cross-domain moves — if `infTools/index.ts` already re-exports symbols from sibling files as its established pattern prior to this task, follow that existing convention rather than introducing a new one; if it doesn't already do this, don't start).

**Interfaces (symbol → destination file, grouped by capability):**

| File | Exports |
|---|---|
| `infToolsBasics.ts` | `runParseWafer`, `runGetDieMap`, `runSiteStats`, `runAnalyzeWafer`, `runListPasses`, `runComparePasses` |
| `infToolsSpatialAnalysis.ts` | `runBinMigration`, `runUnstableDies`, `runEdgeAnalysis`, `runBinSpatial`, `runTemperatureCompare`, `runClusterDetect`, `runClusterShape` |
| `infToolsProbeQuality.ts` | `runTouchAnalysis`, `runYieldLossBreakdown`, `runPartialProbe` |
| `infToolsVisualization.ts` | `runDrawWaferMap`, `runDrawDutBinMap` |

**Call graph note:** this file already imports from `infWaferMapHtml.ts` (Task 16's target) for `runDrawWaferMap`/`runDrawDutBinMap` — if Task 16 is done first, `infToolsVisualization.ts` should import from the new `html/waferMapHtml.js` / `html/dutBinMapHtml.js` paths directly, not the deleted flat file. Sequence Task 16 before Task 18, or if done out of order, re-grep and fix.

- [ ] **Step 1:** Read `src/lib/infTools/infToolsSingleWafer.ts` in full (961 lines); confirm each of the 18 functions' actual grouping matches the 4-way split above (re-derive from real shared-helper usage, not just function-name pattern-matching) and check whether functions within a group call each other or share private helpers (if so, keep those helpers in the same destination file).
- [ ] **Step 2:** Create `singleWafer/` subdirectory and the 4 files, cutting verbatim.
- [ ] **Step 3:** Delete the old file.
- [ ] **Step 4:** Fix the 1 known importer (`infTools/index.ts`) plus re-grep for any others: `grep -rln 'infToolsSingleWafer\.js"' src test`.
- [ ] **Step 5:** `npm run typecheck`, iterate until clean.
- [ ] **Step 6:** `npm test`, expect all green except the 2 documented pre-existing failures.
- [ ] **Step 7:** Update `pcr-ai-api/CLAUDE.md` §6 if it references `infToolsSingleWafer.ts` in a non-dated row.
- [ ] **Step 8:** Commit: `git commit -m "refactor(api): split infToolsSingleWafer.ts into singleWafer/{basics,spatialAnalysis,probeQuality,visualization}"`.

---

### Task 19: Final verification for this round

**Files:** none (verification only).

- [ ] **Step 1:** `npm run typecheck` && `npm test` (from `pcr-ai-api/`), both clean.
- [ ] **Step 2:** `npm run build` (incl. `verify-dist-no-undici`), clean.
- [ ] **Step 3:** `find src -name "*.ts" | xargs wc -l | sort -n | tail -20` — confirm none of the 6 split targets remain over ~500 lines except where a task's own notes explicitly accepted an exception (e.g. Task 17's v1/v2 half if flagged).
- [ ] **Step 4:** Report to user with final directory structure and line-count table; do not merge into `main` automatically (branch already carries an explicit "keep separate, don't merge" instruction from the user).
