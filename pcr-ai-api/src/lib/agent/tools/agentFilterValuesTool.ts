// pcr-ai-api/src/lib/agent/tools/agentFilterValuesTool.ts
//
// Dispatcher for the agent's get_filter_values tool. Domain-specific implementations
// live under filterValues/:
//   - agentFilterValuesDeviceMask.ts — field="device"+mask resolution (Dummy + Oracle,
//     single-domain and cross-domain "both"); also owns the consts/types shared across
//     all four files (DEFAULT_LIMIT/MAX_LIMIT/DEVICE_MASK_DEFAULT_LIMIT, YIELD_FIELDS/
//     JB_FIELDS, YieldField/JbField, FilterValuesResult, DeviceByMaskEntry). It sits at
//     the base of the filterValues/ dependency chain (deviceMask -> oracle -> search ->
//     dummy) with no imports from its siblings, which is why the shared symbols live
//     there rather than in this dispatcher: this file imports functions FROM all four,
//     so if the shared consts/types lived here instead, the four files would need to
//     import them back from here, creating a circular module dependency.
//   - agentFilterValuesOracle.ts — Oracle path for the generic (non-device) fields.
//   - agentFilterValuesSearch.ts — generic distinct-counting + tester-search fallback,
//     shared by both Dummy and Oracle paths.
//   - agentFilterValuesDummy.ts — Dummy (Excel) path for the generic fields.
import {
  yieldMonitorTriggersUseDummy,
} from "../../yieldMonitor/yieldMonitorTriggerDummy.js";
import {
  infcontrolLayerBinsUseDummy,
} from "../../infcontrol/infcontrolLayerBinDummy.js";
import {
  YIELD_FIELDS,
  JB_FIELDS,
  type YieldField,
  type JbField,
  type FilterValuesResult,
  clampDeviceMaskLimit,
  resolveDeviceMaskArg,
  dummyDeviceByMaskBoth,
  oracleDeviceByMaskBoth,
} from "./filterValues/agentFilterValuesDeviceMask.js";
import {
  clampLimit,
  enrichEmptyTesterSearchResult,
  enrichEmptyCardEnumResult,
  oracleYieldWithSearchFallback,
  oracleJbWithSearchFallback,
} from "./filterValues/agentFilterValuesSearch.js";
import { dummyYield, dummyJb } from "./filterValues/agentFilterValuesDummy.js";

export async function runGetFilterValues(
  args: Record<string, unknown>
): Promise<string> {
  const domain = String(args["domain"] ?? "");
  const field = String(args["field"] ?? "");
  const limit = clampLimit(args["limit"]);

  // Safely coerce filterBy values to strings — LLM may pass numbers or nulls.
  const rawFilterBy = args["filterBy"];
  const filterBy: Record<string, string | undefined> = {};
  if (typeof rawFilterBy === "string" && rawFilterBy.trim() !== "") {
    filterBy["mask"] = rawFilterBy.trim().toUpperCase();
  } else if (rawFilterBy !== null && typeof rawFilterBy === "object") {
    const fb = rawFilterBy as Record<string, unknown>;
    if (fb["device"] != null) filterBy["device"] = String(fb["device"]);
    if (fb["probeCardType"] != null) filterBy["probeCardType"] = String(fb["probeCardType"]);
    if (fb["mask"] != null) filterBy["mask"] = String(fb["mask"]).trim().toUpperCase();
    if (fb["search"] != null) filterBy["search"] = String(fb["search"]).trim();
  }

  if (field === "device") {
    const resolvedMask = resolveDeviceMaskArg(field, args, filterBy);
    if (resolvedMask) {
      filterBy["mask"] = resolvedMask;
      delete filterBy["search"];
    }
  }

  const deviceMaskLimit = field === "device" && filterBy["mask"]
    ? clampDeviceMaskLimit(args["limit"])
    : limit;

  if (domain === "both") {
    if (field !== "device") {
      return `get_filter_values 错误: domain="both" 仅支持 field="device" + mask`;
    }
    const mask = filterBy["mask"] ?? "";
    if (!mask) {
      return JSON.stringify({
        domain: "both",
        field: "device",
        values: [],
        totalDistinct: 0,
        hint: 'field="device" 需要 filterBy.mask（如 "N84R"）或顶层 mask 参数',
      } satisfies FilterValuesResult);
    }
    try {
      const result = yieldMonitorTriggersUseDummy() || infcontrolLayerBinsUseDummy()
        ? dummyDeviceByMaskBoth(mask, deviceMaskLimit)
        : await oracleDeviceByMaskBoth(mask, deviceMaskLimit);
      return JSON.stringify(result);
    } catch (err) {
      return `get_filter_values 错误: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (domain === "yield") {
    if (!(YIELD_FIELDS as readonly string[]).includes(field)) {
      return `get_filter_values 错误: yield domain 不支持 field="${field}"。支持: ${YIELD_FIELDS.join(", ")}`;
    }
    try {
      const result = yieldMonitorTriggersUseDummy()
        ? dummyYield(field as YieldField, filterBy, deviceMaskLimit)
        : await oracleYieldWithSearchFallback(field as YieldField, filterBy, deviceMaskLimit);
      return JSON.stringify(
        enrichEmptyCardEnumResult(
          enrichEmptyTesterSearchResult(result, field, filterBy["search"]),
          field,
          filterBy
        )
      );
    } catch (err) {
      return `get_filter_values 错误: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (domain === "jb") {
    if (!(JB_FIELDS as readonly string[]).includes(field)) {
      return `get_filter_values 错误: jb domain 不支持 field="${field}"。支持: ${JB_FIELDS.join(", ")}`;
    }
    try {
      const result = infcontrolLayerBinsUseDummy()
        ? dummyJb(field as JbField, filterBy, deviceMaskLimit)
        : await oracleJbWithSearchFallback(field as JbField, filterBy, deviceMaskLimit);
      return JSON.stringify(
        enrichEmptyCardEnumResult(
          enrichEmptyTesterSearchResult(result, field, filterBy["search"]),
          field,
          filterBy
        )
      );
    } catch (err) {
      return `get_filter_values 错误: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  return `get_filter_values 错误: domain 必须是 "yield"、"jb" 或 "both"（field=device+mask 推荐 both），收到 "${domain}"`;
}
