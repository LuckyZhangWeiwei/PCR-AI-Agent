import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { listApisForceOracleNoDummy } from "./listDummyRuntime.js";
import type { SiteBinByLotData, SiteBinPass } from "./outputSiteBinByLot.js";

/** Dummy 联调固定 INF 路径（与 `docs/site-bin-bylot-dummy-r_1-1.passes.json` 样本一致）。 */
export const SITE_BIN_BY_LOT_DUMMY_CANONICAL_INF_PATH =
  "/data/probe_logs/ps16_SMTPID/teststuffs/infanylist/r_1-1";

function dummyEnvTrue(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * 是否对 site-bin-bylot 使用内存样本（不调 Perl）。
 * dist / production 恒 false；`NODE_ENV=test` 恒 true。
 * 本地：`SITE_BIN_BY_LOT_DUMMY` 或（与 JB 联调一致）`INFCONTROL_LAYER_BINS_DUMMY`。
 */
export function siteBinByLotUseDummy(): boolean {
  if (listApisForceOracleNoDummy()) return false;
  if (process.env.NODE_ENV === "test") return true;
  return (
    dummyEnvTrue(process.env.SITE_BIN_BY_LOT_DUMMY) ||
    dummyEnvTrue(process.env.INFCONTROL_LAYER_BINS_DUMMY)
  );
}

function normalizeInfPathForCompare(infPath: string): string {
  return infPath.replace(/\\/g, "/").trim();
}

export function infPathMatchesSiteBinByLotDummy(infPath: string): boolean {
  return (
    normalizeInfPathForCompare(infPath) ===
    normalizeInfPathForCompare(SITE_BIN_BY_LOT_DUMMY_CANONICAL_INF_PATH)
  );
}

/**
 * Dummy 是否接受该 infPath。
 * - 测试 / canonical 路径：始终接受。
 * - `INFCONTROL_LAYER_BINS_DUMMY`（本地 JB 联调）：接受任意路径，因报表 `buildInfPath` 与 curl 样例路径不同。
 * - 仅 `SITE_BIN_BY_LOT_DUMMY`：仍要求 canonical（用于单独测 Perl 路径）。
 */
export function siteBinByLotDummyPathAllowed(infPath: string): boolean {
  if (process.env.NODE_ENV === "test") return true;
  if (infPathMatchesSiteBinByLotDummy(infPath)) return true;
  if (dummyEnvTrue(process.env.INFCONTROL_LAYER_BINS_DUMMY)) return true;
  if (dummyEnvTrue(process.env.SITE_BIN_BY_LOT_DUMMY_RELAX_PATH)) return true;
  return false;
}

let _passesCache: readonly SiteBinPass[] | undefined;

function loadDummyPasses(): readonly SiteBinPass[] {
  if (_passesCache !== undefined) return _passesCache;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "..", "..", "docs", "site-bin-bylot-dummy-r_1-1.passes.json"),
    path.join(here, "..", "..", "..", "docs", "site-bin-bylot-dummy-r_1-1.passes.json"),
  ];
  let raw: string | undefined;
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      raw = fs.readFileSync(p, "utf8");
      break;
    }
  }
  if (!raw) {
    throw new Error(
      "site-bin-bylot dummy fixture missing (docs/site-bin-bylot-dummy-r_1-1.passes.json)"
    );
  }
  const parsed = JSON.parse(raw) as { passes?: SiteBinPass[] };
  if (!Array.isArray(parsed.passes)) {
    throw new Error("site-bin-bylot dummy fixture must contain a passes array");
  }
  _passesCache = Object.freeze(parsed.passes);
  return _passesCache;
}

/**
 * 按请求的 passId 过滤样本；样本中不存在的 pass 不放入 `passes`（与生产 Perl 行为一致）。
 */
export function buildSiteBinByLotDummyData(passIds: number[]): SiteBinByLotData {
  const byPass = new Map(loadDummyPasses().map((p) => [p.passId, p]));
  const passes: SiteBinPass[] = [];
  for (const id of passIds) {
    const row = byPass.get(id);
    if (row) passes.push(row);
  }
  return { passes };
}

export function tryResolveSiteBinByLotDummy(
  infPath: string,
  passIds: number[]
): SiteBinByLotData | null {
  if (!siteBinByLotUseDummy()) return null;
  if (!siteBinByLotDummyPathAllowed(infPath)) return null;
  return buildSiteBinByLotDummyData(passIds);
}
