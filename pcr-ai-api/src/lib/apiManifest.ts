import { INFCONTROL_DUMMY_EXAMPLE_QUERY } from "./infcontrolLayerBinDummy.js";
import { YIELD_MONITOR_DUMMY_EXAMPLE_QUERY } from "./yieldMonitorTriggerDummy.js";

/**
 * 供 AI agent / OpenAPI 生成器使用的机器可读 API 说明（只读 GET）。
 */
export const apiManifest = {
  apiVersion: "1",
  title: "pcr-ai-api",
  description:
    "Read-only Oracle-backed HTTP API for PCR workflows. All query keys are case-insensitive. deprecatedEndpoints lists routes removed from the router (yield-monitor-triggers/aggregate only).",
  mediaType: "application/json",
  endpoints: [
    {
      path: "/api/v1/manifest",
      method: "GET",
      purpose:
        "Return this catalog for tool discovery (endpoints, deprecatedEndpoints, error/tracing shapes).",
    },
    {
      path: "/api/v1/infcontrol-layer-bins",
      method: "GET",
      purpose:
        "Join INFCONTROL and INFLAYERBINLIST on KEYNUMBER; max 200 rows; ORDER BY TESTEND DESC NULLS LAST, KEYNUMBER DESC NULLS LAST.",
      queryParameters: [
        { name: "keynumber", type: "number", optional: true },
        { name: "device", type: "string", optional: true },
        { name: "lot", type: "string", optional: true },
        { name: "slot", type: "number", optional: true },
        { name: "pdpw", type: "number", optional: true },
        { name: "meslot", type: "string", optional: true },
        { name: "testerId", type: "string", optional: true },
        { name: "tstype", type: "string", optional: true },
        { name: "cardId", type: "string", optional: true },
        { name: "pibId", type: "string", optional: true },
        { name: "probe", type: "string", optional: true },
        { name: "grossDie", type: "number", optional: true },
        { name: "passId", type: "number", optional: true },
        { name: "sessionNumber", type: "number", optional: true },
        { name: "passNum", type: "number", optional: true },
        { name: "layerName", type: "string", optional: true },
        { name: "passResume", type: "string", optional: true },
        { name: "passResult", type: "string", optional: true },
        { name: "passType", type: "string", optional: true },
        { name: "passBin", type: "string", optional: true },
        {
          name: "testStartFrom",
          type: "datetime",
          optional: true,
          note: "ISO 8601; filters lb.TESTSTART >= value",
        },
        {
          name: "testStartTo",
          type: "datetime",
          optional: true,
          note: "ISO 8601; filters lb.TESTSTART <= value",
        },
        {
          name: "testEndFrom",
          type: "datetime",
          optional: true,
          note: "ISO 8601; filters lb.TESTEND >= value",
        },
        {
          name: "testEndTo",
          type: "datetime",
          optional: true,
          note: "ISO 8601; filters lb.TESTEND <= value",
        },
        {
          name: "bin0 … bin255",
          type: "string",
          optional: true,
          note: 'Comma-separated integers → IN list, e.g. bin5=1,3,5',
        },
      ],
      responseShape: {
        limit: "number (fixed 200)",
        orderBy: "string",
        filters: "object (echo of applied query params)",
        count: "number",
        rows:
          "array of row objects (Oracle columns uppercased except BINs packaged below); each row adds passBinPair [N,M]|null (from PASSBIN like 1-55) and bins { [binIndex: string]: { value: number, isGood: boolean } } (only BIN cells with non-null non-zero value); isGood true for bin index 1 (hard good) or PASSBIN N-M endpoints",
      },
      example: `/api/v1/infcontrol-layer-bins?${INFCONTROL_DUMMY_EXAMPLE_QUERY}`,
    },
    {
      path: "/api/v1/infcontrol-layer-bins/v2",
      method: "GET",
      purpose:
        "Same join as infcontrol-layer-bins (v2 row shape): INFCONTROL device/lot/slot/notch/meslot plus INFLAYERBINLIST testerId, tstype, cardId, pibId, probe, passId, TESTSTART, TESTEND; BIN0–BIN255 only appear inside bins[] (non-empty cells). PASSBIN is hyphen-separated good bin indices (e.g. 1-2-55-250); not filterable. Server always AND-filters INFLAYERBINLIST rows to PASSTYPE=TEST (trim); echoed as filters.passtypeScope. Composite AND filters; testStartFrom/To and testEndFrom/To for windows; no bin* query keys; ORDER BY TESTEND DESC NULLS LAST, KEYNUMBER DESC NULLS LAST; limit default 200, max 500.",
      queryParameters: [
        {
          name: "limit",
          type: "number",
          optional: true,
          note: "Top-N rows after sort; default 200, max 500",
        },
        { name: "keynumber", type: "number", optional: true },
        { name: "device", type: "string", optional: true },
        { name: "lot", type: "string", optional: true },
        { name: "slot", type: "number", optional: true },
        { name: "notch", type: "string", optional: true },
        { name: "meslot", type: "string", optional: true },
        { name: "testerId", type: "string", optional: true },
        { name: "tstype", type: "string", optional: true },
        { name: "cardId", type: "string", optional: true },
        { name: "pibId", type: "string", optional: true },
        { name: "probe", type: "string", optional: true },
        { name: "passId", type: "number", optional: true },
        {
          name: "testStartFrom",
          type: "datetime",
          optional: true,
          note: "ISO 8601; lb.TESTSTART >= value",
        },
        {
          name: "testStartTo",
          type: "datetime",
          optional: true,
          note: "ISO 8601; lb.TESTSTART <= value",
        },
        {
          name: "testEndFrom",
          type: "datetime",
          optional: true,
          note: "ISO 8601; lb.TESTEND >= value",
        },
        {
          name: "testEndTo",
          type: "datetime",
          optional: true,
          note: "ISO 8601; lb.TESTEND <= value",
        },
      ],
      responseShape: {
        limit: "number (requested top-N, capped)",
        limitMax: "number (500)",
        orderBy: "string",
        filters: "object (echo of applied query params including limit)",
        count: "number",
        rows:
          "array: Oracle columns for listed fields plus PASSBIN; bins array of { value: number, n: number (BIN index), isGoodBin: boolean } for each non-null non-zero BIN column",
      },
      example: `/api/v1/infcontrol-layer-bins/v2?${INFCONTROL_DUMMY_EXAMPLE_QUERY}&limit=200`,
    },
    {
      path: "/api/v1/infcontrol-layer-bins/v2/top-bad-bins",
      method: "GET",
      purpose:
        "Same WHERE as infcontrol-layer-bins/v2 including fixed PASSTYPE=TEST on INFLAYERBINLIST (no row limit): over all matching rows, sum BIN column values that are bad per row (PASSBIN hyphen-separated good indices use REGEXP_LIKE token match in Oracle). Return the top rankTop BIN indices by total bad die count (rankTop clamped 5–10, default 10). Sort bins by badTotal DESC then n ASC.",
      queryParameters: [
        {
          name: "rankTop",
          type: "number",
          optional: true,
          note: "How many BIN indices to return after ranking; default 10; clamped between 5 and 10",
        },
        {
          name: "badBinTop",
          type: "number",
          optional: true,
          note: "Alias for rankTop",
        },
        { name: "keynumber", type: "number", optional: true },
        { name: "device", type: "string", optional: true },
        { name: "lot", type: "string", optional: true },
        { name: "slot", type: "number", optional: true },
        { name: "notch", type: "string", optional: true },
        { name: "meslot", type: "string", optional: true },
        { name: "testerId", type: "string", optional: true },
        { name: "tstype", type: "string", optional: true },
        { name: "cardId", type: "string", optional: true },
        { name: "pibId", type: "string", optional: true },
        { name: "probe", type: "string", optional: true },
        { name: "passId", type: "number", optional: true },
        {
          name: "testStartFrom",
          type: "datetime",
          optional: true,
          note: "ISO 8601; lb.TESTSTART >= value",
        },
        {
          name: "testStartTo",
          type: "datetime",
          optional: true,
          note: "ISO 8601; lb.TESTSTART <= value",
        },
        {
          name: "testEndFrom",
          type: "datetime",
          optional: true,
          note: "ISO 8601; lb.TESTEND >= value",
        },
        {
          name: "testEndTo",
          type: "datetime",
          optional: true,
          note: "ISO 8601; lb.TESTEND <= value",
        },
      ],
      responseShape: {
        rankTop: "number (requested, after clamp)",
        rankTopMin: "number (5)",
        rankTopMax: "number (10)",
        orderBy: "string",
        filters: "object",
        bins: "array of { n: number, badTotal: number }",
      },
      example: `/api/v1/infcontrol-layer-bins/v2/top-bad-bins?${INFCONTROL_DUMMY_EXAMPLE_QUERY}&rankTop=10`,
    },
    {
      path: "/api/v1/infcontrol-layer-bins/aggregate",
      method: "GET",
      purpose:
        "Same list filters as infcontrol-layer-bins (AND). After WHERE, UNPIVOT BIN0…BIN255 and SUM per group; BIN1 (hard good) contributes 0; when PASSBIN matches N-M, BIN N and BIN M contribute 0; return top groupTop groups by SUM (default 10, max 50). Omit groupBy to default to bin-only ranking; or include bin once with optional device, lot, slot, tstype, cardId, …",
      queryParameters: [
        {
          name: "groupBy",
          type: "string",
          optional: true,
          note:
            'Default bin if omitted. Otherwise comma-separated; must include "bin" once (max 8 dims). Example: bin | device,bin | testerId,cardId,lot,bin',
        },
        {
          name: "groupTop",
          type: "number",
          optional: true,
          note: "default 10, max 50",
        },
        { name: "keynumber", type: "number", optional: true },
        { name: "device", type: "string", optional: true },
        { name: "lot", type: "string", optional: true },
        { name: "slot", type: "number", optional: true },
        { name: "pdpw", type: "number", optional: true },
        { name: "meslot", type: "string", optional: true },
        { name: "testerId", type: "string", optional: true },
        { name: "tstype", type: "string", optional: true },
        { name: "cardId", type: "string", optional: true },
        { name: "pibId", type: "string", optional: true },
        { name: "probe", type: "string", optional: true },
        { name: "grossDie", type: "number", optional: true },
        { name: "passId", type: "number", optional: true },
        { name: "sessionNumber", type: "number", optional: true },
        { name: "passNum", type: "number", optional: true },
        { name: "layerName", type: "string", optional: true },
        { name: "passResume", type: "string", optional: true },
        { name: "passResult", type: "string", optional: true },
        { name: "passType", type: "string", optional: true },
        { name: "passBin", type: "string", optional: true },
        {
          name: "testStartFrom",
          type: "datetime",
          optional: true,
          note: "ISO 8601; filters lb.TESTSTART >= value",
        },
        {
          name: "testStartTo",
          type: "datetime",
          optional: true,
          note: "ISO 8601; filters lb.TESTSTART <= value",
        },
        {
          name: "testEndFrom",
          type: "datetime",
          optional: true,
          note: "ISO 8601; filters lb.TESTEND >= value (test end time window)",
        },
        {
          name: "testEndTo",
          type: "datetime",
          optional: true,
          note: "ISO 8601; filters lb.TESTEND <= value",
        },
        {
          name: "bin0 … bin255",
          type: "string",
          optional: true,
          note: 'Comma-separated integers → IN list, e.g. bin5=1,3,5',
        },
      ],
      responseShape: {
        groupBy:
          "string[] (normalized dimensions; parts.bin is BIN index 0…255 when grouping by bin)",
        groupTop: "number",
        orderBy:
          "string (SUM of unpivoted BIN cells DESC NULLS LAST within grouped dims)",
        filters:
          "object (includes groupBy as string[], groupTop, and list filters)",
        totalRowsMatching: "number (detail rows matching WHERE before agg cap)",
        groups:
          "array of { key: string, count: number (SUM of BIN cells), parts: Record<string,string> }",
      },
      example: `/api/v1/infcontrol-layer-bins/aggregate?${INFCONTROL_DUMMY_EXAMPLE_QUERY}&groupTop=10`,
    },
    {
      path: "/api/v1/yield-monitor-triggers",
      method: "GET",
      purpose:
        "Query YMWEB_YIELDMONITORTRIGGER; max 200 rows; ORDER BY TIME_STAMP DESC NULLS LAST; optional PROBECARD and HOSTNAME counts over all matching rows (see probeCardSummary, hostnameSummary).",
      queryParameters: [
        { name: "hostname", type: "string", optional: true },
        { name: "device", type: "string", optional: true },
        { name: "lotId", type: "string", optional: true },
        { name: "wafer", type: "string", optional: true },
        { name: "type", type: "string", optional: true },
        { name: "triggerLabel", type: "string", optional: true },
        { name: "probeCard", type: "string", optional: true },
        { name: "pass", type: "number", optional: true },
        { name: "id", type: "number", optional: true },
        {
          name: "timeStampFrom",
          type: "datetime",
          optional: true,
          note: "ISO 8601; TIME_STAMP >= value",
        },
        {
          name: "timeStampTo",
          type: "datetime",
          optional: true,
          note: "ISO 8601; TIME_STAMP <= value",
        },
        {
          name: "includeProbeCardSummary",
          type: "boolean",
          optional: true,
          note:
            "default true; false skips extra GROUP BY PROBECARD and GROUP BY HOSTNAME queries",
        },
      ],
      responseShape: {
        limit: "number (fixed 200)",
        orderBy: "string",
        filters: "object",
        count: "number",
        rows: "array",
        probeCardSummary:
          "optional array of { probeCard: string, count: number }; all rows matching filters, ORDER BY COUNT(*) DESC NULLS LAST",
        probeCardSummaryOrderBy: "optional string when probeCardSummary present",
        hostnameSummary:
          "optional array of { hostname: string, count: number }; same WHERE as rows; ORDER BY COUNT(*) DESC NULLS LAST",
        hostnameSummaryOrderBy: "optional string when hostnameSummary present",
      },
      example: `/api/v1/yield-monitor-triggers?${YIELD_MONITOR_DUMMY_EXAMPLE_QUERY}`,
    },
    {
      path: "/api/v1/db/ping",
      method: "GET",
      purpose: "Health check against Oracle via SELECT 1 FROM DUAL (main pool).",
    },
    {
      path: "/api/v1/table-rows",
      method: "GET",
      purpose: "Development helper: first N rows from a table (ROWNUM).",
      queryParameters: [
        { name: "table", type: "string", optional: true },
        { name: "limit", type: "number", optional: true, note: "default 50, max 500" },
      ],
    },
    {
      path: "/health",
      method: "GET",
      purpose: "Process liveness (no database).",
    },
  ],
  /** yield-monitor 聚合已从路由移除；infcontrol 聚合已恢复 */
  deprecatedEndpoints: [
    {
      path: "/api/v1/yield-monitor-triggers/aggregate",
      method: "GET",
      status: "removed",
      note: "Disabled in src/routes/api.ts; libraries yieldMonitorTriggerAggregate.ts, dummy aggregate kept for future redesign.",
    },
  ],
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
