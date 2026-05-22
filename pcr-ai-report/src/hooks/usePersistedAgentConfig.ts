// pcr-ai-report/src/hooks/usePersistedAgentConfig.ts
import { useState, useEffect } from "react";

export interface AgentConfig {
  apiKey: string;
  apiBase: string;
  model: string;
  maxRounds: number;
}

const STORAGE_KEY = "pcr-ai-report.agent.v1";

export const AGENT_MAX_ROUNDS_DEFAULT = 5;
export const AGENT_MAX_ROUNDS_MIN = 1;
export const AGENT_MAX_ROUNDS_MAX = 20;

const DEFAULTS: AgentConfig = {
  apiKey: "",
  apiBase: "https://api.siliconflow.cn/v1",
  model: "deepseek-ai/DeepSeek-V3",
  maxRounds: AGENT_MAX_ROUNDS_DEFAULT,
};

function clampMaxRounds(n: unknown): number {
  const parsed = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(parsed)) return AGENT_MAX_ROUNDS_DEFAULT;
  return Math.min(
    Math.max(Math.round(parsed), AGENT_MAX_ROUNDS_MIN),
    AGENT_MAX_ROUNDS_MAX
  );
}

function load(): AgentConfig {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    if (!s) return { ...DEFAULTS };
    const p = JSON.parse(s) as Partial<AgentConfig>;
    return {
      apiKey: typeof p.apiKey === "string" ? p.apiKey : DEFAULTS.apiKey,
      apiBase:
        typeof p.apiBase === "string" && p.apiBase
          ? p.apiBase
          : DEFAULTS.apiBase,
      model:
        typeof p.model === "string" && p.model ? p.model : DEFAULTS.model,
      maxRounds: clampMaxRounds(p.maxRounds),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function usePersistedAgentConfig(): [
  AgentConfig,
  (update: Partial<AgentConfig>) => void,
  () => void,
] {
  const [config, setConfig] = useState<AgentConfig>(load);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  }, [config]);

  const update = (patch: Partial<AgentConfig>) =>
    setConfig((prev) => ({ ...prev, ...patch }));

  const reset = () => setConfig({ ...DEFAULTS });

  return [config, update, reset];
}
