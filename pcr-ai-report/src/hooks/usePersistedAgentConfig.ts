// pcr-ai-report/src/hooks/usePersistedAgentConfig.ts
// All settings except apiKey are now stored server-side (useServerConfig).

import { useState, useEffect } from "react";

/** Shape sent in every POST /api/v4/agent/chat request body */
export interface AgentConfig {
  apiKey: string;
  apiBase: string;
  model: string;
  maxRounds: number;
  streamTimeoutSec: number;
  clientTimeoutSec: number;
  toolResultMaxChars: number;
  toolResultMaxHistoryChars: number;
}

const STORAGE_KEY = "pcr-ai-report.agent.apikey.v1";

export function usePersistedApiKey(): [string, (key: string) => void] {
  const [apiKey, setApiKeyState] = useState<string>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) ?? "";
    } catch {
      return "";
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, apiKey);
    } catch {
      /* ignore */
    }
  }, [apiKey]);

  return [apiKey, setApiKeyState];
}
