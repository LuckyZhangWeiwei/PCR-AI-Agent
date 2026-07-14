// pcr-ai-api/src/lib/agent/tools/agentToolInfSiteBin.ts
import {
  runSiteBinForWafer,
} from "../../outputSiteBinByLot/singleWafer.js";
import { tryResolveSiteBinByLotDummy } from "../../outputSiteBinByLotDummy.js";
import { buildInfPath } from "../../buildInfPath.js";
import { truncateResult } from "./agentToolHandlers.js";
import { compactSiteBinPasses } from "./agentToolDutBinAgg.js";

export async function toolQueryInfSiteBinByDut(
  args: Record<string, unknown>,
  maxChars: number
): Promise<string> {
  const device = typeof args["device"] === "string" ? args["device"].trim() : "";
  const lot    = typeof args["lot"]    === "string" ? args["lot"].trim()    : "";
  const slotRaw = args["slot"];
  const slot = typeof slotRaw === "number" ? Math.round(slotRaw) : NaN;
  const cardId = typeof args["cardId"] === "string" ? args["cardId"].trim() : undefined;

  if (!device) return "query_inf_site_bin_by_dut 参数错误: device 不能为空";
  if (!lot)    return "query_inf_site_bin_by_dut 参数错误: lot 不能为空";
  if (!Number.isFinite(slot)) return "query_inf_site_bin_by_dut 参数错误: slot 必须是整数";

  const passIds: number[] = [];
  if (typeof args["passId"] === "number") passIds.push(Math.round(args["passId"]));
  if (Array.isArray(args["passIds"])) {
    for (const p of args["passIds"]) {
      if (typeof p === "number") passIds.push(Math.round(p));
    }
  }
  if (passIds.length === 0) passIds.push(1, 3, 5);

  const infPath = buildInfPath(device, lot, slot);

  const dummy = tryResolveSiteBinByLotDummy(infPath, passIds);
  if (dummy) {
    const result = { cardId, device, lot, slot, infPath, passes: compactSiteBinPasses(dummy.passes) };
    return truncateResult(result, maxChars);
  }

  try {
    const { data, source, notices } = await runSiteBinForWafer(
      device,
      { lot, slot, infPath },
      passIds
    );
    const compacted = {
      cardId,
      device,
      lot,
      slot,
      infPath,
      mapSource: source,
      ...(notices.length > 0 ? { notices } : {}),
      passes: compactSiteBinPasses(data.passes),
    };
    return truncateResult(compacted, maxChars);
  } catch (e) {
    return truncateResult(
      {
        error: "INF/Oracle map 失败",
        detail: e instanceof Error ? e.message : String(e),
        hint: "检查 INF_STORAGE_ROOT 或 JB Oracle INFLAYERMAP/INFLAYERBINLIST",
      },
      maxChars
    );
  }
}
