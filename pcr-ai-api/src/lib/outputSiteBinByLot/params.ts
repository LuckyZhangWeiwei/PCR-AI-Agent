import path from "node:path";

import { OutputSiteBinByLotValidationError } from "./types.js";

/** Optional `passNum` / `pass_num` for layer-scoped DUT×BIN. */
export function parseOptionalPassNum(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || !Number.isInteger(raw) || raw <= 0) {
      throw new OutputSiteBinByLotValidationError(
        "Invalid query parameter: passNum (must be a positive integer)"
      );
    }
    return raw;
  }
  const s =
    typeof raw === "string"
      ? raw
      : Array.isArray(raw) && typeof raw[0] === "string"
      ? raw[0]
      : "";
  const t = s.trim();
  if (!t) return undefined;
  const n = Number(t);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new OutputSiteBinByLotValidationError(
      "Invalid query parameter: passNum (must be a positive integer)"
    );
  }
  return n;
}

/** Optional `testEnd` / `test_end` — exact JB layer TESTEND (ISO). */
export function parseOptionalLayerTestEnd(raw: unknown): Date | undefined {
  const s =
    typeof raw === "string"
      ? raw
      : Array.isArray(raw) && typeof raw[0] === "string"
      ? raw[0]
      : "";
  const t = s.trim();
  if (!t) return undefined;
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) {
    throw new OutputSiteBinByLotValidationError(
      "Invalid query parameter: testEnd (must be ISO date-time)"
    );
  }
  return d;
}

/** Optional `keynumber` / `key_number` for single-wafer layer-scoped DUT×BIN. */
export function parseOptionalKeynumber(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || !Number.isInteger(raw) || raw <= 0) {
      throw new OutputSiteBinByLotValidationError(
        "Invalid query parameter: keynumber (must be a positive integer)"
      );
    }
    return raw;
  }
  const s =
    typeof raw === "string"
      ? raw
      : Array.isArray(raw) && typeof raw[0] === "string"
      ? raw[0]
      : "";
  const t = s.trim();
  if (!t) return undefined;
  const n = Number(t);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new OutputSiteBinByLotValidationError(
      "Invalid query parameter: keynumber (must be a positive integer)"
    );
  }
  return n;
}

export function getPerlBin(): string {
  const fromEnv = process.env.PERL_BIN?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : "perl";
}

export function getPerlScriptTimeoutMs(): number {
  const raw = process.env.PERL_SCRIPT_TIMEOUT_MS?.trim();
  if (!raw) return 120_000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1_000 || n > 3_600_000) {
    return 120_000;
  }
  return Math.floor(n);
}

/** 与 Perl `untaint` 一致：整条路径须匹配 /^(.+)$/（无换行等控制字符）。 */
export function validateInfPath(raw: string): string {
  const infPath = raw.trim();
  if (!infPath) {
    throw new OutputSiteBinByLotValidationError("Missing or empty query parameter: infPath");
  }
  if (/[\0\r\n]/.test(infPath)) {
    throw new OutputSiteBinByLotValidationError("infPath contains invalid characters");
  }
  if (!/^(.+)$/.test(infPath)) {
    throw new OutputSiteBinByLotValidationError("infPath failed path validation");
  }
  const allowedRoot = process.env.INF_PATH_ALLOWED_ROOT?.trim();
  if (allowedRoot) {
    const resolvedRoot = path.resolve(allowedRoot);
    const resolvedInf = path.resolve(infPath);
    const prefix = resolvedRoot.endsWith(path.sep)
      ? resolvedRoot
      : resolvedRoot + path.sep;
    if (resolvedInf !== resolvedRoot && !resolvedInf.startsWith(prefix)) {
      throw new OutputSiteBinByLotValidationError(
        `infPath must be under INF_PATH_ALLOWED_ROOT (${resolvedRoot})`
      );
    }
  }
  return infPath;
}

function readMaxWafersEnv(
  envKey: string,
  defaultVal: number,
  maxCap: number
): number {
  const raw = process.env[envKey]?.trim();
  if (!raw) return defaultVal;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1 || n > maxCap) return defaultVal;
  return Math.floor(n);
}

export function getSiteBinByLotMaxWafers(): number {
  return readMaxWafersEnv("SITE_BIN_BY_LOT_MAX_WAFERS", 25, 100);
}

export function getSiteBinByLotMaxWafersDevice(): number {
  return readMaxWafersEnv("SITE_BIN_BY_LOT_MAX_WAFERS_DEVICE", 100, 500);
}

export function validateDeviceLot(deviceRaw: string, lotRaw: string): { device: string; lot: string } {
  const device = deviceRaw.trim();
  const lot = lotRaw.trim();
  if (!device) {
    throw new OutputSiteBinByLotValidationError("Missing or empty query parameter: device");
  }
  if (!lot) {
    throw new OutputSiteBinByLotValidationError("Missing or empty query parameter: lot");
  }
  return { device, lot };
}

export function parsePassIdsFromQuery(raw: unknown): number[] {
  const parts: string[] = [];
  if (typeof raw === "string") parts.push(raw);
  else if (Array.isArray(raw)) {
    for (const x of raw) {
      if (typeof x === "string") parts.push(x);
    }
  }
  if (parts.length === 0) {
    throw new OutputSiteBinByLotValidationError(
      "Missing query parameter: passId (one or more, comma-separated allowed)"
    );
  }

  const ids: number[] = [];
  for (const s of parts) {
    for (const seg of s.split(",")) {
      const t = seg.trim();
      if (t === "") continue;
      const n = Number(t);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        throw new OutputSiteBinByLotValidationError(`Invalid passId: ${t}`);
      }
      ids.push(n);
    }
  }
  if (ids.length === 0) {
    throw new OutputSiteBinByLotValidationError(
      "passId must contain at least one integer"
    );
  }
  return ids;
}
