// pcr-ai-api/src/lib/agent/agentJbMultiLotListing.ts
/** Fields that must survive JB history compression for multi-lot listing queries. */

export function isMultiLotListing(o: Record<string, unknown>): boolean {
  const n = o["totalDistinctLots"] ?? o["distinctLotCount"] ?? o["multiLotDistinctCount"];
  return typeof n === "number" && n > 1;
}

export function multiLotListingFields(
  o: Record<string, unknown>
): Record<string, unknown> {
  if (!isMultiLotListing(o)) return {};
  const recent = o["recentLotsByTestEnd"] as
    | Array<Record<string, unknown>>
    | undefined;
  return {
    totalDistinctLots: o["totalDistinctLots"] ?? o["distinctLotCount"],
    distinctLotCount: o["distinctLotCount"],
    multiLotYieldScope: o["multiLotYieldScope"],
    multiLotDistinctCount: o["multiLotDistinctCount"],
    _recentLotsGuide: o["_recentLotsGuide"],
    _multiLotYieldScopeGuide: o["_multiLotYieldScopeGuide"],
    recentLotsByTestEnd: recent?.map((e) => ({
      lot: e["lot"],
      device: e["device"],
      testEnd: e["testEnd"],
      slotCount: e["slotCount"],
    })),
  };
}
