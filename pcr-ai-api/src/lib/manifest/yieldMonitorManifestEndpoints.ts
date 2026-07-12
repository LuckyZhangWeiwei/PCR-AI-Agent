import { getYieldMonitorDummyExampleQuery } from "../yieldMonitorTriggerDummy.js";

export const yieldMonitorManifestEndpoints = [
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
    example: `/api/v1/yield-monitor-triggers?${getYieldMonitorDummyExampleQuery()}`,
  },
  {
    path: "/api/v1/yield-monitor-triggers/v3",
    method: "GET",
    purpose:
      "SELECT * FROM YMWEB_YIELDMONITORTRIGGER with fixed WHERE UPPER(TRIM(TYPE)) = 'DELTA_DIFF' (bind :v3_type_scope; echoed as filters.typeScope) AND optional AND filters (case-insensitive TRIM on string columns: HOSTNAME, DEVICE, LOTID, WAFER, PROBECARD; exact PASS; TIME_STAMP window). If the client sends none of timeStampBegin/timeStampEnd/timeStampFrom/timeStampTo, the server AND-filters TIME_STAMP to [UTC now minus one calendar year, UTC now] (same default as v3 aggregate). Then ORDER BY TIME_STAMP DESC NULLS LAST FETCH FIRST :lim ROWS ONLY. Query parameter type is not supported on v3 (cannot override TYPE scope; rows still include TYPE in each object). Each row also includes dutNumber (from TRIGGER_LABEL) and PROBECARDTYPE (leading segment of PROBECARD before first hyphen). When YIELD_MONITOR_TRIGGERS_DUMMY is true and not dist/production, serves matching rows from docs/delta-diff.xlsx in memory; else probeweb Oracle. Query keys are case-insensitive (including limit).",
    queryParameters: [
      {
        name: "limit",
        type: "number",
        optional: true,
        note: "Top-N rows; default 200; max 500",
      },
      { name: "hostname", type: "string", optional: true },
      { name: "device", type: "string", optional: true },
      { name: "lotId", type: "string", optional: true },
      { name: "pass", type: "number", optional: true },
      { name: "wafer", type: "string", optional: true },
      { name: "probeCard", type: "string", optional: true },
      {
        name: "timeStampBegin",
        type: "datetime",
        optional: true,
        note: "ISO 8601; TIME_STAMP >= value (alias: timeStampFrom)",
      },
      {
        name: "timeStampEnd",
        type: "datetime",
        optional: true,
        note: "ISO 8601; TIME_STAMP <= value (alias: timeStampTo)",
      },
      {
        name: "timeStampFrom",
        type: "datetime",
        optional: true,
        note: "Alias for timeStampBegin when begin not set",
      },
      {
        name: "timeStampTo",
        type: "datetime",
        optional: true,
        note: "Alias for timeStampEnd when end not set",
      },
    ],
    responseShape: {
      meta: "{ apiVersion: '3', requestId }",
      limit: "number",
      limitMax: "number (500)",
      orderBy: "string",
      filters:
        "object (echo of applied filters plus limit; always includes typeScope: 'delta_diff' — server-fixed TYPE filter)",
      count: "number",
      rows:
        "array of row objects (all DB columns plus dutNumber: number | null — DUT id parsed from TRIGGER_LABEL when it contains “on dut# …”, else null; plus PROBECARDTYPE: string | null — leading segment of PROBECARD before first hyphen)",
    },
    example:
      "/api/v1/yield-monitor-triggers/v3?device=WA03P02G&timeStampBegin=2026-05-13T00:00:00.000Z&timeStampEnd=2026-05-13T23:59:59.999Z&limit=200",
  },
  {
    path: "/api/v1/yield-monitor-triggers/v3/aggregate",
    method: "GET",
    purpose:
      "v3 yield aggregate: same WHERE as GET /yield-monitor-triggers/v3 (fixed TYPE=delta_diff via UPPER(TRIM(TYPE)); UPPER(TRIM) on other string columns; TIME_STAMP window including default one-calendar-year bounds when no timeStamp* keys; etc.). Over ALL matching rows (not limited to FETCH FIRST list cap), COUNT(*) GROUP BY requested dimensions in Oracle, order by count DESC, return top groupTop groups (default 25, max 100). Required query parameter dimensions: comma-separated from device, hostname, lotId, wafer, probeCard, probeCardType, pass, triggerLabel, timeDay, timeHour (max 5 dims; timeDay and timeHour mutually exclusive; probeCardType is leading segment of PROBECARD before first hyphen, same as v3 list PROBECARDTYPE). Query parameter type is not supported on v3 yield endpoints. When YIELD_MONITOR_TRIGGERS_DUMMY is true and not dist/production, uses delta-diff.xlsx in-memory rows with Node aggregation; else probeweb Oracle GROUP BY SQL. JSON documentation field explains difference vs v3 list.",
    queryParameters: [
      {
        name: "dimensions",
        type: "string",
        optional: false,
        note:
          "Required. Comma-separated: device, hostname, lotId, wafer, probeCard, probeCardType, pass, triggerLabel, timeDay, timeHour (max 5). probeCardType = leading segment of PROBECARD before first hyphen (same as v3 list PROBECARDTYPE). Cannot combine timeDay+timeHour. Parameter type is not supported on v3.",
      },
      {
        name: "groupTop",
        type: "number",
        optional: true,
        note: "max groups returned; default 25, max 100",
      },
      { name: "hostname", type: "string", optional: true },
      { name: "device", type: "string", optional: true },
      { name: "lotId", type: "string", optional: true },
      { name: "pass", type: "number", optional: true },
      { name: "wafer", type: "string", optional: true },
      { name: "probeCard", type: "string", optional: true },
      {
        name: "timeStampBegin",
        type: "datetime",
        optional: true,
        note: "ISO 8601; TIME_STAMP >= (alias timeStampFrom)",
      },
      {
        name: "timeStampEnd",
        type: "datetime",
        optional: true,
        note: "ISO 8601; TIME_STAMP <= (alias timeStampTo)",
      },
      {
        name: "timeStampFrom",
        type: "datetime",
        optional: true,
        note: "Alias for timeStampBegin",
      },
      {
        name: "timeStampTo",
        type: "datetime",
        optional: true,
        note: "Alias for timeStampEnd",
      },
    ],
    responseShape: {
      meta: "{ apiVersion: '3', requestId, aggregatePath }",
      documentation: "string (fixed Chinese explanation)",
      dimensions: "string[] (normalized)",
      groupTop: "number",
      orderBy: "string",
      filters:
        "object (includes typeScope: 'delta_diff' plus dimensions, groupTop, and list filters)",
      totalRowsMatching: "number",
      groups: "array of { key, count (row count per group), parts }",
    },
    example:
      "/api/v1/yield-monitor-triggers/v3/aggregate?dimensions=device,hostname&timeStampBegin=2026-05-13T00:00:00.000Z&timeStampEnd=2026-05-13T23:59:59.999Z&groupTop=20",
  },
  {
    path: "/api/v1/yield-monitor-triggers/v4",
    method: "GET",
    purpose:
      "Same as GET /api/v1/yield-monitor-triggers/v3 except meta.apiVersion is 4 and path is v4.",
    queryParameters: [
      {
        name: "limit, hostname, device, lotId, pass, wafer, probeCard, timeStamp*",
        type: "mixed",
        optional: true,
        note: "Identical to yield-monitor-triggers/v3",
      },
    ],
    responseShape: {
      meta: "{ apiVersion: '4', requestId }",
      limit: "number",
      limitMax: "number (500)",
      orderBy: "string",
      filters: "object",
      count: "number",
      rows: "same as yield-monitor-triggers/v3 list",
    },
    example:
      "/api/v1/yield-monitor-triggers/v4?device=WA03P02G&timeStampBegin=2026-05-13T00:00:00.000Z&timeStampEnd=2026-05-13T23:59:59.999Z&limit=200",
  },
  {
    path: "/api/v1/yield-monitor-triggers/v4/aggregate",
    method: "GET",
    purpose:
      "v4 yield aggregate: same dimensions/groupTop and WHERE as GET /yield-monitor-triggers/v3/aggregate. Oracle/Dummy: loads all matching rows, attaches PROBECARDTYPE, COUNT per group in Node (same as v3 dummy); v3 Oracle uses GROUP BY SQL. Oracle path: COUNT first, 422 if over MEMORY_AGG_ORACLE_MAX_ROWS; else in-memory COUNT.",
    queryParameters: [
      {
        name: "dimensions, groupTop, hostname, device, …",
        type: "mixed",
        optional: true,
        note: "Same as yield-monitor-triggers/v3/aggregate",
      },
    ],
    responseShape: {
      meta: "{ apiVersion: '4', requestId, aggregatePath }",
      documentation: "string (v4 Chinese note)",
      dimensions: "string[]",
      groupTop: "number",
      orderBy: "string",
      filters: "object",
      totalRowsMatching: "number",
      groups: "array of { key, count, parts }",
    },
    example:
      "/api/v1/yield-monitor-triggers/v4/aggregate?dimensions=device,hostname&timeStampBegin=2026-05-13T00:00:00.000Z&timeStampEnd=2026-05-13T23:59:59.999Z&groupTop=20",
  },
];
