import { useCallback, useEffect, useState } from "react";

/** v3/v4 list `limit` hard ceiling enforced by pcr-ai-api */
export const API_LIST_LIMIT_CEILING = 500;

export type ReportListLimits = {
  defaultLimit: number;
  maxLimit: number;
};

export const REPORT_LIST_LIMITS_DEFAULT: ReportListLimits = {
  defaultLimit: 300,
  maxLimit: 500,
};

const STORAGE_KEY = "pcr-ai-report.listLimits.v1";

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function normalizeReportListLimits(
  raw: Partial<ReportListLimits> | null | undefined,
): ReportListLimits {
  const maxLimit = clampInt(
    raw?.maxLimit ?? REPORT_LIST_LIMITS_DEFAULT.maxLimit,
    1,
    API_LIST_LIMIT_CEILING,
  );
  const defaultLimit = clampInt(
    raw?.defaultLimit ?? REPORT_LIST_LIMITS_DEFAULT.defaultLimit,
    1,
    maxLimit,
  );
  return { defaultLimit, maxLimit };
}

function readStoredLimits(): ReportListLimits {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return REPORT_LIST_LIMITS_DEFAULT;
    return normalizeReportListLimits(JSON.parse(raw) as Partial<ReportListLimits>);
  } catch {
    return REPORT_LIST_LIMITS_DEFAULT;
  }
}

export function resolveListLimit(
  limits: ReportListLimits,
  explicit?: number,
): number {
  if (explicit != null && Number.isFinite(explicit)) {
    return clampInt(explicit, 1, limits.maxLimit);
  }
  return limits.defaultLimit;
}

export function usePersistedReportLimits(): readonly [
  ReportListLimits,
  (patch: Partial<ReportListLimits>) => void,
  () => void,
] {
  const [limits, setLimitsState] = useState<ReportListLimits>(readStoredLimits);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(limits));
    } catch {
      /* ignore quota */
    }
  }, [limits]);

  const setLimits = useCallback((patch: Partial<ReportListLimits>) => {
    setLimitsState((prev) => normalizeReportListLimits({ ...prev, ...patch }));
  }, []);

  const reset = useCallback(() => {
    setLimitsState(REPORT_LIST_LIMITS_DEFAULT);
  }, []);

  return [limits, setLimits, reset] as const;
}
