// pcr-ai-api/src/lib/agent/agentJbYieldCore.ts
/** query_jb_bins 总结轮必读字段；serialize/compact 时优先保留。 */

export function jbYieldCoreFields(
  wrapped: Record<string, unknown>
): Record<string, unknown> {
  const core: Record<string, unknown> = {};
  const multiLot =
    Boolean(wrapped["multiLotYieldScope"]) ||
    (typeof wrapped["totalDistinctLots"] === "number" &&
      wrapped["totalDistinctLots"] > 1) ||
    (typeof wrapped["distinctLotCount"] === "number" &&
      wrapped["distinctLotCount"] > 1);
  for (const k of [
    "lot",
    "device",
    "passIdsPresent",
    "yieldByPassId",
    "yieldByPassIdMarkdown",
    "cardByPassIdMarkdown",
    "lotQueryFullRows",
    "topBadBins",
    "clusteredBadBinAlerts",
    "clusteredBadBinAlertsMarkdown",
    "_clusteredBadBinAlertsGuide",
    "testerId",
    "testerByLot",
    "testInterruptCountMarkdown",
    "slotYieldInterruptMarkdown",
    "_testInterruptCountGuide",
    "distinctLotSlotCount",
    ...(multiLot
      ? ([
          "distinctLotCount",
          "totalDistinctLots",
          "recentLotsByTestEnd",
          "multiLotYieldScope",
          "multiLotDistinctCount",
          "_recentLotsGuide",
        ] as const)
      : ([] as const)),
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

const SERIALIZE_CLUSTER_ALERTS_CAP = 8;

function slimClusterAlertForSerialize(a: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    bin: a.bin,
    passId: a.passId,
    sortLabel: a.sortLabel,
    kind: a.kind,
    slotStart: a.slotStart,
    slotEnd: a.slotEnd,
    peakDie: a.peakDie,
    detail: a.detail,
  };
  const slots = a.slots;
  if (Array.isArray(slots) && slots.length > 0 && slots.length <= 8) {
    out.slots = slots;
  }
  return out;
}

/** toolResult 超限时用：保留警示数组、省略长 markdown / digest，避免挤掉 slotYieldSummary。 */
export function jbYieldCoreFieldsForSerialize(
  wrapped: Record<string, unknown>
): Record<string, unknown> {
  const core = jbYieldCoreFields(wrapped);
  delete core.agentTablesDigest;
  delete core._clusteredBadBinAlertsGuide;
  delete core.clusteredBadBinAlertsMarkdown;
  delete core.topBadBins;
  delete core.slotsByPassId;
  delete core.badBinSlotTrends;
  const alerts = core.clusteredBadBinAlerts as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(alerts) && alerts.length > 0) {
    const capped = alerts.slice(0, SERIALIZE_CLUSTER_ALERTS_CAP).map(slimClusterAlertForSerialize);
    core.clusteredBadBinAlerts = capped;
    if (alerts.length > SERIALIZE_CLUSTER_ALERTS_CAP) {
      core._clusteredBadBinAlertsTruncated = alerts.length;
    }
  }
  return core;
}
