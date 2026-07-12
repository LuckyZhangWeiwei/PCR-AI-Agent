export const miscManifestEndpoints = [
  {
    path: "/api/v1/manifest",
    method: "GET",
    purpose:
      "Return this catalog for tool discovery (endpoints, deprecatedEndpoints, error/tracing shapes).",
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
];

export const deprecatedManifestEndpoints = [
  {
    path: "/api/v1/yield-monitor-triggers/aggregate",
    method: "GET",
    status: "removed",
    note: "Disabled in src/routes/api.ts; libraries yieldMonitorTriggerAggregate.ts, dummy aggregate kept for future redesign.",
  },
];
