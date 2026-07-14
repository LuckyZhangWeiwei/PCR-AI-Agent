import { parseInfWaferCoordsFromPath } from "../buildInfPath.js";
import type { SiteBinWaferRef } from "../siteBinByLotWaferResolve.js";
import { parseOptionalKeynumber, parseOptionalPassNum, parsePassIdsFromQuery, validateInfPath } from "./params.js";
import { mergeSiteBinByLotData, runSiteBinForWafer } from "./singleWafer.js";
import {
  OutputSiteBinByLotValidationError,
  SITE_BIN_LAYERS_BATCH_MAX,
  type RunSiteBinLayersBatchResult,
  type SiteBinByLotData,
  type SiteBinLayerRequest,
  type SiteBinLayerResult,
} from "./types.js";

function parseSiteBinLayerPassIds(raw: unknown): number[] {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return [Math.trunc(raw)];
  }
  if (typeof raw === "string" && raw.trim()) {
    return parsePassIdsFromQuery(raw);
  }
  if (Array.isArray(raw)) {
    const out: number[] = [];
    for (const v of raw) {
      if (typeof v === "number" && Number.isFinite(v)) out.push(Math.trunc(v));
    }
    if (out.length > 0) return [...new Set(out)].sort((a, b) => a - b);
  }
  throw new OutputSiteBinByLotValidationError(
    "Each layer requires passIds (number or comma-separated string)"
  );
}

export function parseSiteBinLayersBody(body: unknown): SiteBinLayerRequest[] {
  if (!body || typeof body !== "object" || !("layers" in body)) {
    throw new OutputSiteBinByLotValidationError(
      "Request body must be { layers: [...] }"
    );
  }
  const rawLayers = (body as { layers: unknown }).layers;
  if (!Array.isArray(rawLayers) || rawLayers.length === 0) {
    throw new OutputSiteBinByLotValidationError("layers must be a non-empty array");
  }
  if (rawLayers.length > SITE_BIN_LAYERS_BATCH_MAX) {
    throw new OutputSiteBinByLotValidationError(
      `layers exceeds maximum ${SITE_BIN_LAYERS_BATCH_MAX}`
    );
  }

  const layers: SiteBinLayerRequest[] = [];
  for (let i = 0; i < rawLayers.length; i++) {
    const item = rawLayers[i];
    if (!item || typeof item !== "object") {
      throw new OutputSiteBinByLotValidationError(`layers[${i}] must be an object`);
    }
    const row = item as Record<string, unknown>;
    const infPath = validateInfPath(
      typeof row.infPath === "string" ? row.infPath : ""
    );
    const deviceRaw =
      typeof row.device === "string" ? row.device.trim() : "";
    const coords = parseInfWaferCoordsFromPath(infPath);
    const device = deviceRaw || coords?.device || "";
    if (!device) {
      throw new OutputSiteBinByLotValidationError(
        `layers[${i}]: device required (or inferrable from infPath)`
      );
    }
    const passIds = parseSiteBinLayerPassIds(row.passIds ?? row.passId);
    const keynumber =
      row.keynumber !== undefined
        ? parseOptionalKeynumber(row.keynumber)
        : undefined;
    const passNum =
      row.passNum !== undefined ? parseOptionalPassNum(row.passNum) : undefined;
    const testEndRaw =
      typeof row.testEnd === "string"
        ? row.testEnd.trim()
        : typeof row.test_end === "string"
        ? row.test_end.trim()
        : "";
    const testEnd = testEndRaw || undefined;
    layers.push({
      infPath,
      device,
      passIds,
      ...(keynumber !== undefined ? { keynumber } : {}),
      ...(passNum !== undefined ? { passNum } : {}),
      ...(testEnd ? { testEnd } : {}),
    });
  }
  return layers;
}

/** 多层 site-bin：串行取数后 merge（单次 HTTP，避免 N 次往返）。 */
export async function runSiteBinForWaferLayers(
  layers: SiteBinLayerRequest[]
): Promise<RunSiteBinLayersBatchResult> {
  if (layers.length === 0) {
    throw new OutputSiteBinByLotValidationError("layers must be a non-empty array");
  }

  const results: SiteBinLayerResult[] = [];
  const notices: string[] = [];
  const chunks: SiteBinByLotData[] = [];

  for (const layer of layers) {
    const coords = parseInfWaferCoordsFromPath(layer.infPath);
    if (!coords) {
      throw new OutputSiteBinByLotValidationError(
        `infPath must match .../{DEVICE}/{LOT}/r_1-{slot}: ${layer.infPath}`
      );
    }
    const wafer: SiteBinWaferRef = {
      lot: coords.lot,
      slot: coords.slot,
      infPath: layer.infPath,
    };
    const { data, source, notices: layerNotices } = await runSiteBinForWafer(
      layer.device,
      wafer,
      layer.passIds,
      {
        keynumber: layer.keynumber,
        passNum: layer.passNum,
        testEnd: layer.testEnd,
      }
    );
    chunks.push(data);
    for (const n of layerNotices) notices.push(n);
    results.push({
      infPath: layer.infPath,
      passIds: layer.passIds,
      mapSource: source,
      passes: data.passes,
      notices: layerNotices,
      ...(layer.keynumber !== undefined ? { keynumber: layer.keynumber } : {}),
      ...(layer.passNum !== undefined ? { passNum: layer.passNum } : {}),
      ...(layer.testEnd ? { testEnd: layer.testEnd } : {}),
    });
  }

  return {
    layerCount: results.length,
    layers: results,
    data: mergeSiteBinByLotData(chunks),
    notices,
  };
}
