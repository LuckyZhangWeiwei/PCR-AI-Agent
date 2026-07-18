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
    path: "/api/v1/siliconflow/chat",
    method: "GET",
    purpose:
      "Direct SiliconFlow Chat Completions proxy (legacy, hardcoded API key in src/lib/siliconflowChat.ts). Prefer POST /api/v4/agent/chat for the full ReAct agent.",
    queryParameters: [
      {
        name: "message",
        type: "string",
        optional: false,
        note: "UTF-8 query string; max 100000 chars",
      },
    ],
    responseShape: {
      message: "string — echo of the request message",
      reply: "string — model reply",
      model: "string — model id used",
      reasoningContent:
        "optional string — present only if the model returned reasoning content",
    },
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
