import { OutputSiteBinByLotValidationError } from "./outputSiteBinByLot.js";
import { v3DefaultThroughNowMinusOneUtcYear } from "./v3DefaultOneYearWindow.js";

export type SiteBinTestEndWindow = {
  lo: Date;
  hi: Date;
  /** ISO strings echoed in API meta when JB time filter applied */
  applied: Record<string, string>;
  /** true when server injected default one-year TESTEND window */
  defaultOneYear: boolean;
};

const TIME_QUERY_KEYS = [
  "testStartBegin",
  "testStartFrom",
  "testStartEnd",
  "testStartTo",
  "testEndBegin",
  "testEndFrom",
  "testEndEnd",
  "testEndTo",
] as const;

function firstQueryValue(q: Record<string, unknown>, key: string): unknown {
  const lower = key.toLowerCase();
  for (const k of Object.keys(q)) {
    if (k.toLowerCase() === lower) return q[k];
  }
  return undefined;
}

function firstString(raw: unknown): string | undefined {
  if (raw == null) return undefined;
  if (Array.isArray(raw)) {
    const a = raw[0];
    if (a == null) return undefined;
    return String(a).trim();
  }
  const s = String(raw).trim();
  return s === "" ? undefined : s;
}

function parseOptionalDate(raw: unknown, label: string): Date | undefined {
  const s = firstString(raw);
  if (s === undefined) return undefined;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    throw new OutputSiteBinByLotValidationError(`Invalid date for ${label}`);
  }
  return d;
}

/**
 * JB 锁定 wafer 时用的 TESTEND 窗：与层控 v3 一致——未传任何 testStart、testEnd 时间参数时默认 UTC 最近一年。
 */
export function parseSiteBinByLotTestEndWindow(
  q: Record<string, unknown>
): SiteBinTestEndWindow {
  const testEndLo =
    parseOptionalDate(firstQueryValue(q, "testEndBegin"), "testEndBegin") ??
    parseOptionalDate(firstQueryValue(q, "testEndFrom"), "testEndFrom");
  const testEndHi =
    parseOptionalDate(firstQueryValue(q, "testEndEnd"), "testEndEnd") ??
    parseOptionalDate(firstQueryValue(q, "testEndTo"), "testEndTo");

  if (
    testEndLo !== undefined &&
    testEndHi !== undefined &&
    testEndLo > testEndHi
  ) {
    throw new OutputSiteBinByLotValidationError(
      "TESTEND window: lower bound must be <= upper bound (testEndBegin/testEndEnd or testEndFrom/testEndTo)"
    );
  }

  const userTouchedTime = TIME_QUERY_KEYS.some(
    (k) => firstQueryValue(q, k) !== undefined
  );

  if (
    !userTouchedTime &&
    testEndLo === undefined &&
    testEndHi === undefined
  ) {
    const { lo, hi } = v3DefaultThroughNowMinusOneUtcYear();
    return {
      lo,
      hi,
      applied: {
        testEndBegin: lo.toISOString(),
        testEndEnd: hi.toISOString(),
      },
      defaultOneYear: true,
    };
  }

  if (testEndLo === undefined || testEndHi === undefined) {
    throw new OutputSiteBinByLotValidationError(
      "JB wafer resolution requires both TESTEND bounds when any time query param is set (testEndFrom+testEndTo or testEndBegin+testEndEnd), or omit all time params for default one-year window"
    );
  }

  const applied: Record<string, string> = {};
  if (firstQueryValue(q, "testEndBegin") != null) {
    applied.testEndBegin = testEndLo.toISOString();
  } else {
    applied.testEndFrom = testEndLo.toISOString();
  }
  if (firstQueryValue(q, "testEndEnd") != null) {
    applied.testEndEnd = testEndHi.toISOString();
  } else {
    applied.testEndTo = testEndHi.toISOString();
  }

  return { lo: testEndLo, hi: testEndHi, applied, defaultOneYear: false };
}

export function rowTestEndInWindow(
  testEndRaw: unknown,
  window: SiteBinTestEndWindow
): boolean {
  const t = new Date(String(testEndRaw ?? "")).getTime();
  if (Number.isNaN(t)) return false;
  return t >= window.lo.getTime() && t <= window.hi.getTime();
}
