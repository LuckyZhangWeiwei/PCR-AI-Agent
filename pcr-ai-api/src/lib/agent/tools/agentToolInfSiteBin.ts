// pcr-ai-api/src/lib/agent/tools/agentToolInfSiteBin.ts
import {
  runSiteBinForWafer,
} from "../../outputSiteBinByLot/singleWafer.js";
import { tryResolveSiteBinByLotDummy } from "../../outputSiteBinByLotDummy.js";
import { buildInfPath } from "../../buildInfPath.js";
import { truncateResult } from "./agentToolHandlers.js";
import { compactSiteBinPasses, extractFocusBinDuts } from "./agentToolDutBinAgg.js";
import { extractFocusDutBins } from "../agentDutFocusBins.js";
import type { SiteBinPass } from "../../outputSiteBinByLot/types.js";

function parseFocusDut(args: Record<string, unknown>): number | undefined {
  const raw = args["focusDut"];
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.round(raw);
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) return Number(raw.trim());
  return undefined;
}

function parseFocusBinKey(args: Record<string, unknown>): string | undefined {
  const focusBinRaw = args["focusBin"];
  const focusBinNum = typeof focusBinRaw === "number" ? Math.round(focusBinRaw) : NaN;
  return Number.isFinite(focusBinNum) ? `bin${focusBinNum}` : undefined;
}

function buildInfSiteBinResult(opts: {
  cardId?: string;
  device: string;
  lot: string;
  slot: number;
  infPath: string;
  rawPasses: SiteBinPass[];
  focusDut?: number;
  focusBinKey?: string;
  mapSource?: string;
  notices?: string[];
  maxChars: number;
}): string {
  const {
    cardId,
    device,
    lot,
    slot,
    infPath,
    rawPasses,
    focusDut,
    focusBinKey,
    mapSource,
    notices,
    maxChars,
  } = opts;

  const passes = compactSiteBinPasses(rawPasses, { focusDut });
  const focusBinDuts = focusBinKey
    ? extractFocusBinDuts(passes, focusBinKey)
    : undefined;
  const focusDutBins =
    focusDut != null ? extractFocusDutBins(rawPasses, focusDut) : undefined;

  return truncateResult(
    {
      ...(focusDut != null ? { focusDut, focusDutBins } : {}),
      ...(focusBinDuts?.length ? { focusBin: focusBinKey, focusBinDuts } : {}),
      cardId,
      device,
      lot,
      slot,
      infPath,
      ...(mapSource ? { mapSource } : {}),
      ...(notices && notices.length > 0 ? { notices } : {}),
      passes,
    },
    maxChars
  );
}

export async function toolQueryInfSiteBinByDut(
  args: Record<string, unknown>,
  maxChars: number
): Promise<string> {
  const device = typeof args["device"] === "string" ? args["device"].trim() : "";
  const lot    = typeof args["lot"]    === "string" ? args["lot"].trim()    : "";
  const slotRaw = args["slot"];
  const slot = typeof slotRaw === "number" ? Math.round(slotRaw) : NaN;
  const cardId = typeof args["cardId"] === "string" ? args["cardId"].trim() : undefined;
  const focusDut = parseFocusDut(args);
  const focusBinKey = parseFocusBinKey(args);

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
    return buildInfSiteBinResult({
      cardId,
      device,
      lot,
      slot,
      infPath,
      rawPasses: dummy.passes,
      focusDut,
      focusBinKey,
      maxChars,
    });
  }

  try {
    const { data, source, notices } = await runSiteBinForWafer(
      device,
      { lot, slot, infPath },
      passIds
    );
    return buildInfSiteBinResult({
      cardId,
      device,
      lot,
      slot,
      infPath,
      rawPasses: data.passes,
      focusDut,
      focusBinKey,
      mapSource: source,
      notices,
      maxChars,
    });
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
