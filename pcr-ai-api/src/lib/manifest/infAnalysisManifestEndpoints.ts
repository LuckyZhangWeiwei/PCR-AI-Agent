export const infAnalysisManifestEndpoints = [
  {
    path: "/api/v1/inf-analysis/lot-underperforming-duts",
    method: "GET",
    purpose:
      "Filter probe DUTs within a lot whose yield is below lotOverall * thresholdRatio (default 0.75). Backed by JB STAR (INFCONTROL/INFLAYERBINLIST); read-only, does not modify INF files. See docs/HANDOFF_LOT_UNDERPERFORMING_DUTS_API.md.",
    queryParameters: [
      { name: "lot", type: "string", optional: false, note: "required" },
      {
        name: "device",
        type: "string",
        optional: true,
        note: "if omitted, resolved from JB STAR by lot",
      },
      { name: "probeCardType", type: "string", optional: true },
      {
        name: "passId",
        type: "number",
        optional: true,
        note: "comma-separated allowed; default [1,3,5]",
      },
      { name: "thresholdRatio", type: "number", optional: true, note: "default 0.75" },
      { name: "testEndFrom", type: "datetime", optional: true },
      { name: "testEndTo", type: "datetime", optional: true },
    ],
    responseShape: {
      meta: "object with apiVersion, requestId",
      note:
        "per-DUT yield vs lotOverall*thresholdRatio and an underperforming flag; see docs/HANDOFF_LOT_UNDERPERFORMING_DUTS_API.md for the full field list",
    },
  },
  {
    path: "/api/v1/inf-analysis/site-bin-bylot",
    method: "GET",
    purpose:
      "Per wafer test pass, which probe-card DUT produced each bin. Three modes: single wafer (infPath+passId), lot directory scan (device+lot+passId, optional probeCardType), device aggregate across the most recent lots (device+passId, no lot; default topN=10, max 50).",
    queryParameters: [
      {
        name: "infPath",
        type: "string",
        optional: true,
        note: "single-wafer mode; mutually exclusive with device",
      },
      { name: "device", type: "string", optional: true, note: "aggregate mode trigger" },
      { name: "lot", type: "string", optional: true },
      { name: "probeCardType", type: "string", optional: true },
      { name: "passId", type: "number", optional: true, note: "comma-separated allowed" },
      { name: "keynumber", type: "number", optional: true, note: "single-wafer mode only" },
      { name: "passNum", type: "number", optional: true, note: "single-wafer mode only" },
      { name: "testEnd", type: "datetime", optional: true, note: "single-wafer mode only" },
      {
        name: "topN",
        type: "number",
        optional: true,
        note: "device mode only; default 10, max 50",
      },
    ],
    responseShape: {
      meta: "object with apiVersion, requestId, summary",
      note:
        "shape varies by mode; see docs/SITE_BIN_BY_LOT_API.md and docs/HANDOFF_SITE_BIN_BY_LOT_AGG.md",
    },
  },
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
