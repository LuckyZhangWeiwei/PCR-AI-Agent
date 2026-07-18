export const adminManifestEndpoints = [
  {
    path: "/api/v4/admin/config",
    method: "GET",
    purpose:
      "Return the full server-shared runtime config (RuntimeConfig, see src/lib/runtimeConfig.ts). No authentication — every field, including agentApiKey, is returned in plaintext. Deploy behind a trusted network boundary.",
    responseShape: {
      agentEnabled: "boolean",
      agentApiBase: "string",
      agentModel: "string",
      agentSubModel: "string",
      agentApiKey: "string — plaintext, no masking",
      jbDeterministicDispatch: "boolean",
      jbLlmIntentClassifier: "boolean",
      dataMaskingEnabled: "boolean",
      maxRounds: "number",
      streamTimeoutSec: "number",
      clientTimeoutSec: "number",
      toolResultMaxChars: "number",
      toolResultMaxHistoryChars: "number",
      listDefaultLimit: "number",
      listMaxLimit: "number",
    },
  },
  {
    path: "/api/v4/admin/config",
    method: "PATCH",
    purpose:
      "Merge-patch the server-shared runtime config; every field is optional, only supplied keys are overwritten and persisted to runtime-config.json. Takes effect for all clients immediately, no restart. No authentication.",
    requestBody: {
      note: "Partial<RuntimeConfig> — any subset of the fields listed in the GET .../config responseShape",
    },
    responseShape: {
      note: "Full RuntimeConfig after the patch is applied (same shape as GET .../config)",
    },
  },
  {
    path: "/api/v4/admin/agent-enabled",
    method: "POST",
    purpose:
      "Deprecated backward-compat shortcut for PATCH /api/v4/admin/config { agentEnabled }. Prefer PATCH /api/v4/admin/config.",
    deprecated: true,
    requestBody: {
      agentEnabled: "boolean, required",
    },
    responseShape: {
      ok: "boolean",
      agentEnabled: "boolean — the value after the update",
    },
  },
];
