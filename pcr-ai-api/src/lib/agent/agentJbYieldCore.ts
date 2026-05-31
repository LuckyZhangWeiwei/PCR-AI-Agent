// pcr-ai-api/src/lib/agent/agentJbYieldCore.ts
/** query_jb_bins 总结轮必读字段；serialize/compact 时优先保留。 */

export function jbYieldCoreFields(
  wrapped: Record<string, unknown>
): Record<string, unknown> {
  const core: Record<string, unknown> = {};
  for (const k of [
    "lot",
    "device",
    "passIdsPresent",
    "yieldByPassId",
    "yieldByPassIdMarkdown",
    "cardByPassIdMarkdown",
    "lotYieldOverviewMarkdown",
    "lotQueryFullRows",
    "topBadBins",
    "slotYieldInterruptMarkdown",
    "slotYieldPivotMarkdown",
    "distinctLotSlotCount",
    "distinctSlots",
    "slotsByPassId",
    "badBinSlotTrends",
    "agentTablesDigest",
    "_passIdsPresentGuide",
    "_slotsByPassGuide",
    "_badBinSlotTrendsGuide",
    "_lotQueryGuide",
    "_yieldByPassGuide",
  ] as const) {
    if (wrapped[k] !== undefined) core[k] = wrapped[k];
  }
  return core;
}
