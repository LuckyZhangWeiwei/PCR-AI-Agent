// pcr-ai-api/src/lib/agent/core/agentPreLlmDirectRoutes.ts
// Shared declarative direct-route dispatch table used by both the
// SiliconFlow loop (agentLoop.ts) and the Vero-driven loop
// (veroAgentLoop.ts). Runners self-gate; order is priority — see the
// comment at each usage site for the gating rule (PRE_LLM_DIRECT_ROUTES
// only runs before any tool has executed this turn).
//
// Previously duplicated verbatim in both files, which risked the two
// loops' "what gets handled deterministically" sets silently diverging if
// a new direct route was added to one array and not the other (flagged in
// code review of the Vero generic loop). Add new pre-LLM direct routes
// here once; both loops pick it up automatically.
import { tryRunSemanticDispatchDirectRoute } from "../dispatch/agentSemanticDispatch.js";
import {
  tryRunLotOverviewDirectRoute,
  tryRunMaskScopeDirectRoute,
  tryRunListingTimeClarifyDirectRoute,
  tryRunLotListingDirectRoute,
  tryRunEquipmentDirectRoute,
  tryRunPerSlotBinRankingDirectRoute,
} from "../dispatch/directRoutes/agentJbLotDirectRoutes.js";
import {
  tryRunScopedBadBinDirectRoute,
  tryRunBinLotRankingDirectRoute,
  tryRunGoodBinValueDirectRoute,
  tryRunUnscopedBinClarifyDirectRoute,
} from "../dispatch/directRoutes/agentJbBinDirectRoutes.js";
import {
  tryRunDutBinAggDirectRoute,
  tryRunDutFocusBinsDirectRoute,
  tryRunUnderperformingDutDirectRoute,
} from "../dispatch/directRoutes/agentDutAggDirectRoutes.js";
import { tryRunProbeCardPerfDirectRoute } from "../dispatch/directRoutes/agentProbeCardDirectRoutes.js";

export const PRE_LLM_DIRECT_ROUTES: Array<typeof tryRunLotListingDirectRoute> = [
  tryRunUnderperformingDutDirectRoute,
  tryRunGoodBinValueDirectRoute,
  tryRunProbeCardPerfDirectRoute,
  tryRunDutFocusBinsDirectRoute,
  tryRunDutBinAggDirectRoute,
  tryRunBinLotRankingDirectRoute,
  tryRunListingTimeClarifyDirectRoute,
  tryRunLotListingDirectRoute,
  tryRunScopedBadBinDirectRoute,
  tryRunMaskScopeDirectRoute,
  tryRunLotOverviewDirectRoute,
  tryRunEquipmentDirectRoute,
  tryRunPerSlotBinRankingDirectRoute,
  tryRunSemanticDispatchDirectRoute,
  tryRunUnscopedBinClarifyDirectRoute,
];
