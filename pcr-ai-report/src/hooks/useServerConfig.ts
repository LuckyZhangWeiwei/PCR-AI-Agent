import { useState, useEffect, useCallback } from "react";

export interface ServerConfig {
  agentEnabled: boolean;
  agentApiBase: string;
  agentModel: string;
  /** 子任务模型（历史压缩 + 表解读）。默认 DeepSeek-V4-Flash。 */
  agentSubModel: string;
  maxRounds: number;
  streamTimeoutSec: number;
  clientTimeoutSec: number;
  toolResultMaxChars: number;
  toolResultMaxHistoryChars: number;
  listDefaultLimit: number;
  listMaxLimit: number;
}

export const SERVER_CONFIG_DEFAULTS: ServerConfig = {
  agentEnabled: true,
  agentApiBase: "https://api.siliconflow.cn/v1",
  agentModel: "deepseek-ai/DeepSeek-V4-Pro",
  agentSubModel: "deepseek-ai/DeepSeek-V4-Flash",
  maxRounds: 8,
  streamTimeoutSec: 150,
  clientTimeoutSec: 240,
  toolResultMaxChars: 20000,
  toolResultMaxHistoryChars: 8000,
  listDefaultLimit: 300,
  listMaxLimit: 1000,
};

function resolveBase(apiBase: string): string {
  return apiBase.replace(/\/$/, "") || window.location.origin;
}

export function useServerConfig(apiBase: string): [
  ServerConfig,
  (patch: Partial<ServerConfig>) => Promise<void>,
  () => Promise<void>,
] {
  const [config, setConfig] = useState<ServerConfig>(SERVER_CONFIG_DEFAULTS);

  const fetchConfig = useCallback(async () => {
    try {
      const res = await fetch(`${resolveBase(apiBase)}/api/v4/admin/config`, {
        cache: "no-store",
      });
      if (res.ok) {
        const data = (await res.json()) as Partial<ServerConfig>;
        setConfig((prev) => ({ ...prev, ...data }));
      }
    } catch {
      // keep current state
    }
  }, [apiBase]);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  const updateConfig = useCallback(
    async (patch: Partial<ServerConfig>) => {
      setConfig((prev) => ({ ...prev, ...patch })); // optimistic
      try {
        const res = await fetch(
          `${resolveBase(apiBase)}/api/v4/admin/config`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch),
          }
        );
        if (res.ok) {
          const updated = (await res.json()) as Partial<ServerConfig>;
          setConfig((prev) => ({ ...prev, ...updated }));
        } else {
          await fetchConfig(); // revert
        }
      } catch {
        await fetchConfig(); // revert
      }
    },
    [apiBase, fetchConfig]
  );

  return [config, updateConfig, fetchConfig];
}
