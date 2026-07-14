// pcr-ai-api/src/lib/agent/tools/filterValues/agentFilterValuesDummy.ts
//
// In-memory (Excel-backed) Dummy-mode implementation of get_filter_values for the
// yield and jb domains — mirrors agentFilterValuesOracle.ts field-for-field per the
// dummy-parity rule (see pcr-ai-api/CLAUDE.md hard rule #1).
import {
  getYieldMonitorTriggerDummyRows,
} from "../../../yieldMonitor/yieldMonitorTriggerDummy.js";
import {
  getInfcontrolLayerBinDummyRows,
} from "../../../infcontrol/infcontrolLayerBinDummy.js";
import { infcontrolLayerBinV3PasstypeMatches } from "../../../infcontrolLayerBinPasstypeScope.js";
import { probeCardTypeLeadingSegment } from "../../../probeCardTypeLeadingSegment.js";
import {
  type FilterValuesResult,
  type YieldField,
  type JbField,
  dummyDeviceByMask,
} from "./agentFilterValuesDeviceMask.js";
import { countDistinct, countDistinctWithSearchFallback } from "./agentFilterValuesSearch.js";

export function dummyYield(
  field: YieldField,
  filterBy: Record<string, string | undefined>,
  limit: number
): FilterValuesResult {
  if (field === "device") {
    if (!filterBy["mask"]) {
      return {
        domain: "yield",
        field: "device",
        values: [],
        totalDistinct: 0,
        hint: 'field="device" 需要 filterBy.mask（如 "P02G"）或顶层 mask 参数',
      };
    }
    return dummyDeviceByMask("yield", getYieldMonitorTriggerDummyRows().map((r) => ({
      device: String(r.DEVICE ?? "").trim(),
      testEnd: String(r.TIME_STAMP ?? "").trim(),
    })), filterBy["mask"], limit);
  }

  const rows = getYieldMonitorTriggerDummyRows().filter((r) => {
    if (filterBy["device"] && String(r.DEVICE).trim() !== filterBy["device"]) return false;
    if (filterBy["probeCardType"]) {
      if (probeCardTypeLeadingSegment(r.PROBECARD) !== filterBy["probeCardType"]) return false;
    }
    return true;
  });

  const raw: string[] = rows.map((r) => {
    switch (field) {
      case "probeCard":     return String(r.PROBECARD).trim();
      case "probeCardType": return probeCardTypeLeadingSegment(r.PROBECARD) ?? "";
      case "hostname":      return String(r.HOSTNAME).trim();
      case "lotId":         return String(r.LOTID).trim();
    }
  });

  const useSearchFallback = field === "hostname";
  const { values, totalDistinct } = useSearchFallback
    ? countDistinctWithSearchFallback(raw, limit, filterBy["search"])
    : countDistinct(raw, limit, filterBy["search"]);
  return { domain: "yield", field, values, totalDistinct };
}

export function dummyJb(
  field: JbField,
  filterBy: Record<string, string | undefined>,
  limit: number
): FilterValuesResult {
  if (field === "device") {
    if (!filterBy["mask"]) {
      return {
        domain: "jb",
        field: "device",
        values: [],
        totalDistinct: 0,
        hint: 'field="device" 需要 filterBy.mask（如 "P02G"）或顶层 mask 参数',
      };
    }
    const jbRows = getInfcontrolLayerBinDummyRows();
    return dummyDeviceByMask("jb", jbRows.map((r) => ({
      device: String(r.DEVICE ?? "").trim(),
      testEnd: String(r.TESTEND ?? "").trim(),
    })), filterBy["mask"], limit);
  }

  const rows = getInfcontrolLayerBinDummyRows().filter((r) => {
    if (!infcontrolLayerBinV3PasstypeMatches(r.PASSTYPE)) return false;
    if (String(r.LAYERNAME ?? "").trim().toUpperCase() === "ABANDONED") return false;
    if (filterBy["device"] && String(r.DEVICE).trim() !== filterBy["device"]) return false;
    if (filterBy["probeCardType"]) {
      if (probeCardTypeLeadingSegment(r.CARDID) !== filterBy["probeCardType"]) return false;
    }
    return true;
  });

  const raw: string[] = rows.map((r) => {
    switch (field) {
      case "cardId":        return String(r.CARDID).trim();
      case "probeCardType": return probeCardTypeLeadingSegment(r.CARDID) ?? "";
      case "testerId":      return String(r.TESTERID).trim();
      case "lot":           return String(r.LOT).trim();
    }
  });

  const useSearchFallback = field === "testerId";
  const { values, totalDistinct } = useSearchFallback
    ? countDistinctWithSearchFallback(raw, limit, filterBy["search"])
    : countDistinct(raw, limit, filterBy["search"]);
  return { domain: "jb", field, values, totalDistinct };
}
