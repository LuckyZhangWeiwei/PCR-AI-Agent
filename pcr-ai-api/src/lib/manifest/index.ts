import { getInfcontrolDummyExampleQuery } from "../infcontrol/infcontrolLayerBinDummy.js";
import { getYieldMonitorDummyExampleQuery } from "../yieldMonitor/yieldMonitorTriggerDummy.js";
import { infcontrolManifestEndpoints } from "./infcontrolManifestEndpoints.js";
import { yieldMonitorManifestEndpoints } from "./yieldMonitorManifestEndpoints.js";
import { agentManifestEndpoints } from "./agentManifestEndpoints.js";
import { adminManifestEndpoints } from "./adminManifestEndpoints.js";
import {
  miscManifestEndpoints,
  deprecatedManifestEndpoints,
} from "./miscManifestEndpoints.js";

/**
 * 供 AI agent / OpenAPI 生成器使用的机器可读 API 说明（只读 GET）。
 */
export const apiManifest = {
  apiVersion: "1",
  title: "pcr-ai-api",
  description:
    "Read-only Oracle-backed HTTP API for PCR workflows. All query keys are case-insensitive. The same Express router is mounted at /api/v1 (full catalog in GET /api/v1/manifest), /api/v3 (GET /api/v3/manifest returns v3-only paths), and /api/v4 (GET /api/v4/manifest returns v4-only paths). v4 duplicates v3 list surfaces for layer bins and yield triggers; v4 aggregates load the full matching row set (same WHERE as the v4 list without FETCH FIRST) and compute groups in Node—no separate v3-style aggregate SQL. v3 routes use fixed SQL; when dummy env flags are set and the process is not dist/production (see listDummyRuntime.ts), v3/v4 list and aggregates use in-memory Excel samples like v1/v2; otherwise they hit Oracle. deprecatedEndpoints lists routes removed from the router (yield-monitor-triggers/aggregate only). agent/admin endpoints are only mounted under /api/v4 (not /api/v1 or /api/v3) — see GET /openapi.json for the full real-path catalog including those.",
  mediaType: "application/json",
  endpoints: [
    ...miscManifestEndpoints,
    ...infcontrolManifestEndpoints,
    ...yieldMonitorManifestEndpoints,
    ...agentManifestEndpoints,
    ...adminManifestEndpoints,
  ],
  deprecatedEndpoints: [...deprecatedManifestEndpoints],
  errorShape: {
    error: "human-readable message",
    code: "machine-stable code (e.g. VALIDATION_ERROR, ORACLE_QUERY_FAILED)",
    detail: "optional extra context",
  },
  tracing: {
    requestHeader: "X-Request-Id",
    responseHeader: "X-Request-Id",
    note: "Echo client id or server-generated UUID for log correlation.",
  },
} as const;
