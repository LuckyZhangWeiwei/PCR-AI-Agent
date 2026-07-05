// pcr-ai-report/src/hooks/usePersistedAgentConfig.ts
// All settings including apiKey are now stored server-side (useServerConfig).

/** Shape sent in every POST /api/v4/agent/chat request body */
export interface AgentConfig {
  apiKey: string;
  apiBase: string;
  model: string;
  /** 子任务模型（历史压缩 + 表解读）。等于 model 时无差异。 */
  subAgentModel: string;
  maxRounds: number;
  streamTimeoutSec: number;
  clientTimeoutSec: number;
  toolResultMaxChars: number;
  toolResultMaxHistoryChars: number;
}

const LEGACY_API_KEY_STORAGE_KEY = "pcr-ai-report.agent.apikey.v1";

/**
 * One-time migration helper: reads the pre-server-config API key (if any)
 * left over from before apiKey moved to shared server config, and removes
 * it from localStorage so it is only ever consumed once.
 */
export function takeLegacyApiKey(): string {
  try {
    const v = localStorage.getItem(LEGACY_API_KEY_STORAGE_KEY) ?? "";
    if (v) localStorage.removeItem(LEGACY_API_KEY_STORAGE_KEY);
    return v;
  } catch {
    return "";
  }
}
