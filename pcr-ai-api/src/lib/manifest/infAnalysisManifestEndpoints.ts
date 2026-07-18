// GET /api/v1/inf-analysis/lot-underperforming-duts and GET /api/v1/inf-analysis/site-bin-bylot
// are already registered in infcontrolManifestEndpoints.ts (pre-existing, more detailed than a
// first draft here would be) — do not re-add them, buildOpenApiDocument() dedupes by path+method
// and a duplicate here would silently shadow the better entry (last spread in manifest/index.ts wins).
export const infAnalysisManifestEndpoints = [
  {
    path: "/api/v1/inf-analysis/site-bin-bylot/layers",
    method: "POST",
    purpose:
      "Batch variant of GET .../site-bin-bylot: fetch and merge multiple single-wafer layers in one request.",
    requestBody: {
      layers:
        "array of { infPath: string, device: string, passIds: number[], testEnd?: string, keynumber?: number, passNum?: number }, required, at least one entry",
    },
    responseShape: {
      meta: "object with apiVersion, requestId, summary",
      layerCount: "number",
      mapSources: "array of string",
      layers:
        "array of per-layer results: { infPath, passIds, mapSource, passes, keynumber?, passNum?, testEnd? }",
    },
  },
];
