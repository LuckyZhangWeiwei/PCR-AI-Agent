// pcr-ai-report/src/hooks/usePersistedAgentConfig.ts
import { useState, useEffect } from "react";

export interface AgentConfig {
  apiKey: string;
  apiBase: string;
  model: string;
  maxRounds: number;
  /** 后端 LLM 流式 idle 超时（秒）；随 agentConfig 下发 */
  streamTimeoutSec: number;
  /** 浏览器整次聊天请求超时（秒）；仅前端使用，应略大于 streamTimeoutSec */
  clientTimeoutSec: number;
}

const STORAGE_KEY = "pcr-ai-report.agent.v1";

export const AGENT_MAX_ROUNDS_DEFAULT = 5;
export const AGENT_MAX_ROUNDS_MIN = 1;
export const AGENT_MAX_ROUNDS_MAX = 20;

export const AGENT_STREAM_TIMEOUT_SEC_DEFAULT = 150;
export const AGENT_STREAM_TIMEOUT_SEC_MIN = 30;
export const AGENT_STREAM_TIMEOUT_SEC_MAX = 600;

export const AGENT_CLIENT_TIMEOUT_SEC_DEFAULT = 180;
export const AGENT_CLIENT_TIMEOUT_SEC_MIN = 60;
export const AGENT_CLIENT_TIMEOUT_SEC_MAX = 900;

/** 客户端超时至少比流式 idle 超时多这么多秒 */
export const AGENT_CLIENT_TIMEOUT_BUFFER_SEC = 30;

const DEFAULTS: AgentConfig = {
  apiKey: "",
  apiBase: "https://api.siliconflow.cn/v1",
  model: "deepseek-ai/DeepSeek-V3",
  maxRounds: AGENT_MAX_ROUNDS_DEFAULT,
  streamTimeoutSec: AGENT_STREAM_TIMEOUT_SEC_DEFAULT,
  clientTimeoutSec: AGENT_CLIENT_TIMEOUT_SEC_DEFAULT,
};

function clampMaxRounds(n: unknown): number {
  const parsed = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(parsed)) return AGENT_MAX_ROUNDS_DEFAULT;
  return Math.min(
    Math.max(Math.round(parsed), AGENT_MAX_ROUNDS_MIN),
    AGENT_MAX_ROUNDS_MAX
  );
}

export function clampStreamTimeoutSec(n: unknown): number {
  const parsed = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(parsed)) return AGENT_STREAM_TIMEOUT_SEC_DEFAULT;
  return Math.min(
    Math.max(Math.round(parsed), AGENT_STREAM_TIMEOUT_SEC_MIN),
    AGENT_STREAM_TIMEOUT_SEC_MAX
  );
}

export function clampClientTimeoutSec(
  n: unknown,
  streamTimeoutSec: number
): number {
  const parsed = typeof n === "number" ? n : Number(n);
  const floor = Math.max(
    AGENT_CLIENT_TIMEOUT_SEC_MIN,
    streamTimeoutSec + AGENT_CLIENT_TIMEOUT_BUFFER_SEC
  );
  if (!Number.isFinite(parsed)) return Math.max(floor, AGENT_CLIENT_TIMEOUT_SEC_DEFAULT);
  return Math.min(
    Math.max(Math.round(parsed), floor),
    AGENT_CLIENT_TIMEOUT_SEC_MAX
  );
}

function normalizeAgentConfig(partial: Partial<AgentConfig>): AgentConfig {
  const streamTimeoutSec = clampStreamTimeoutSec(partial.streamTimeoutSec);
  return {
    apiKey:
      typeof partial.apiKey === "string" ? partial.apiKey : DEFAULTS.apiKey,
    apiBase:
      typeof partial.apiBase === "string" && partial.apiBase
        ? partial.apiBase
        : DEFAULTS.apiBase,
    model:
      typeof partial.model === "string" && partial.model
        ? partial.model
        : DEFAULTS.model,
    maxRounds: clampMaxRounds(partial.maxRounds),
    streamTimeoutSec,
    clientTimeoutSec: clampClientTimeoutSec(
      partial.clientTimeoutSec,
      streamTimeoutSec
    ),
  };
}

function load(): AgentConfig {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    if (!s) return { ...DEFAULTS };
    const p = JSON.parse(s) as Partial<AgentConfig>;
    return normalizeAgentConfig(p);
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
    setConfig((prev) => normalizeAgentConfig({ ...prev, ...patch }));

  const reset = () => setConfig({ ...DEFAULTS });

  return [config, update, reset];
}
