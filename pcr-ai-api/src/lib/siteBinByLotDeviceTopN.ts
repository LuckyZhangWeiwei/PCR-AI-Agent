import { OutputSiteBinByLotValidationError } from "./outputSiteBinByLot/types.js";

/** device 聚合默认纳入 TESTEND 最新的 lot 数 */
export const SITE_BIN_DEVICE_TOP_LOTS_DEFAULT = 10;

/** `topN` 查询参数上限 */
export const SITE_BIN_DEVICE_TOP_LOTS_MAX = 50;

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

/**
 * Device 聚合：`topN` / `topn`，默认 10，最大 50。
 */
export function parseSiteBinDeviceTopN(raw: unknown): number {
  const s = firstString(raw);
  if (s === undefined) return SITE_BIN_DEVICE_TOP_LOTS_DEFAULT;
  const n = Number(s);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw new OutputSiteBinByLotValidationError(
      `Invalid topN: must be integer 1..${SITE_BIN_DEVICE_TOP_LOTS_MAX}`
    );
  }
  if (n > SITE_BIN_DEVICE_TOP_LOTS_MAX) {
    throw new OutputSiteBinByLotValidationError(
      `topN ${n} exceeds maximum ${SITE_BIN_DEVICE_TOP_LOTS_MAX}`
    );
  }
  return n;
}
