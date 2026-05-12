import { useCallback, useEffect, useState } from "react";
import { defaultApiBase, normalizeApiBase } from "../api/client";

/** bump：曾缓存 localhost 的用户会改用新的 defaultApiBase（正式网关） */
const STORAGE_KEY = "pcr-ai-report.apiBase.v4";

export function usePersistedApiBase(): readonly [
  string,
  (next: string) => void,
  () => void,
] {
  const [base, setBaseState] = useState(() => {
    try {
      const s = localStorage.getItem(STORAGE_KEY);
      if (s) return normalizeApiBase(s);
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
