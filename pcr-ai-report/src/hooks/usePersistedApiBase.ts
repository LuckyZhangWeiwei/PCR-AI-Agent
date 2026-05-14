import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_API_BASE,
  defaultApiBase,
  normalizeApiBase,
} from "../api/client";

const STORAGE_KEY = "pcr-ai-report.apiBase.v5";

function migrateDevProxyStaleGateway(normalized: string): boolean {
  return (
    import.meta.env.DEV &&
    String(import.meta.env.VITE_DEV_API_VIA_PROXY ?? "").toLowerCase() ===
      "true" &&
    normalized === DEFAULT_API_BASE
  );
}

export function usePersistedApiBase(): readonly [
  string,
  (next: string) => void,
  () => void,
] {
  const [base, setBaseState] = useState(() => {
    try {
      const s = localStorage.getItem(STORAGE_KEY);
      if (s) {
        const normalized = normalizeApiBase(s);
        /** 曾缓存默认网关直连地址时，在开发代理模式下改回「同页」避免 Chrome PNA 拦截 */
        if (migrateDevProxyStaleGateway(normalized)) {
          try {
            localStorage.removeItem(STORAGE_KEY);
          } catch {
            /* ignore */
          }
          return defaultApiBase();
        }
        return normalized;
      }
    } catch {
      /* ignore */
    }
    return defaultApiBase();
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, base);
    } catch {
      /* ignore */
    }
  }, [base]);

  const setBase = useCallback((next: string) => {
    setBaseState(normalizeApiBase(next));
  }, []);

  const reset = useCallback(() => {
    setBaseState(defaultApiBase());
  }, []);

  return [base, setBase, reset] as const;
}
