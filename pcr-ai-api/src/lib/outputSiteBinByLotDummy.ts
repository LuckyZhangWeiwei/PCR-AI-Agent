import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { listApisForceOracleNoDummy } from "./listDummyRuntime.js";
import {
  buildInfDeviceDir,
  buildInfLotDir,
  parseInfWaferSlotFromPath,
} from "./buildInfPath.js";
import { mergeSiteBinByLotData } from "./outputSiteBinByLot/singleWafer.js";
import {
  type SiteBinByLotData,
  type SiteBinPass,
} from "./outputSiteBinByLot/types.js";
import {
  distinctProbeCardTypesFromDummy,
  recentLotsForDeviceFromDummy,
  resolveSiteBinWafersFromDummy,
} from "./siteBinByLotWaferResolve.js";
import type { SiteBinTestEndWindow } from "./siteBinByLotTestEndWindow.js";
import { OutputSiteBinByLotValidationError } from "./outputSiteBinByLot/types.js";

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

function scaleSiteBinPassDieCount(
  pass: SiteBinPass,
  waferSlot: number
): SiteBinPass {
  if (waferSlot <= 1) return pass;
  return {
    passId: pass.passId,
    bins: pass.bins.map((b) => ({
      bin: b.bin,
      duts: b.duts.map((d) => ({
        dut: d.dut,
        dieCount: d.dieCount * waferSlot,
      })),
    })),
  };
}

/**
 * 按请求的 passId 过滤样本；样本中不存在的 pass 不放入 `passes`（与生产 Perl 行为一致）。
 * @param waferSlot Dummy 单片：按 slot 缩放 dieCount，便于多片 `infPath` 联调时与 Oracle「每片独立 map」区分（lot 目录聚合仍用 scale=1）。
 */
/** Dummy 层缩放：同 slot 不同 KEYNUMBER 返回不同 dieCount。 */
export function dummyDieCountScaleForKeynumber(keynumber: number): number {
  return (Math.abs(Math.trunc(keynumber)) % 7) + 1;
}

/** Dummy 层缩放：同 slot 不同层（testEnd / keynumber）返回不同 dieCount。 */
export function dummyDieCountScaleForLayer(
  keynumber?: number,
  testEnd?: string,
  waferSlot = 1
): number {
  if (testEnd?.trim()) {
    let h = 0;
    for (const ch of testEnd.trim()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return (h % 7) + 1;
  }
  if (keynumber !== undefined && Number.isFinite(keynumber)) {
    return dummyDieCountScaleForKeynumber(keynumber);
  }
  return waferSlot > 0 ? waferSlot : 1;
}

export function buildSiteBinByLotDummyData(
  passIds: number[],
  dieCountScale = 1
): SiteBinByLotData {
  const scale = dieCountScale > 0 ? dieCountScale : 1;
  const byPass = new Map(loadDummyPasses().map((p) => [p.passId, p]));
  const passes: SiteBinPass[] = [];
  for (const id of passIds) {
    const row = byPass.get(id);
    if (row) passes.push(scaleSiteBinPassDieCount(row, scale));
  }
  return { passes };
}

export function tryResolveSiteBinByLotDummy(
  infPath: string,
  passIds: number[],
  keynumber?: number,
  testEnd?: string
): SiteBinByLotData | null {
  if (!siteBinByLotUseDummy()) return null;
  if (!siteBinByLotDummyPathAllowed(infPath)) return null;
  const slot = parseInfWaferSlotFromPath(infPath);
  const scale = dummyDieCountScaleForLayer(keynumber, testEnd, slot ?? 1);
  return buildSiteBinByLotDummyData(passIds, scale);
}

export type SiteBinByLotDummyAggResult = SiteBinByLotData & {
  probeCardType?: string;
  waferCount: number;
  waferSlots: number[];
  waferLots?: string[];
  selectedLots?: string[];
  topN?: number;
  lotDir?: string;
  deviceDir?: string;
  skippedInfPaths: string[];
};

/** 兼容：lot 目录扫描 Dummy（固定 3 片，无 probeCardType）。 */
const SITE_BIN_BY_LOT_DUMMY_LOT_DIR_WAFER_SLOTS = [1, 2, 3] as const;

export function tryResolveSiteBinByLotDummyForLotByDirectory(
  device: string,
  lot: string,
  passIds: number[]
): SiteBinByLotDummyAggResult | null {
  if (!siteBinByLotUseDummy()) return null;
  const lotDir = buildInfLotDir(device, lot);
  if (!siteBinByLotDummyPathAllowed(lotDir)) return null;

  const single = buildSiteBinByLotDummyData(passIds);
  const chunks = SITE_BIN_BY_LOT_DUMMY_LOT_DIR_WAFER_SLOTS.map(() => single);
  return {
    ...mergeSiteBinByLotData(chunks),
    lotDir,
    waferCount: SITE_BIN_BY_LOT_DUMMY_LOT_DIR_WAFER_SLOTS.length,
    waferSlots: [...SITE_BIN_BY_LOT_DUMMY_LOT_DIR_WAFER_SLOTS],
    skippedInfPaths: [],
  };
}

function tryResolveSiteBinByLotDummyAggregate(params: {
  device: string;
  lot?: string;
  probeCardType: string;
  passIds: number[];
  testEndWindow: SiteBinTestEndWindow;
  aggregateScope: "lot" | "device";
  topN?: number;
}): SiteBinByLotDummyAggResult | null {
  if (!siteBinByLotUseDummy()) return null;

  const checkPath =
    params.aggregateScope === "lot"
      ? buildInfLotDir(params.device, params.lot!)
      : buildInfDeviceDir(params.device);
  if (!siteBinByLotDummyPathAllowed(checkPath)) return null;

  let selectedLots: string[] | undefined;
  let lotsIn: string[] | undefined;
  if (params.aggregateScope === "device" && params.topN !== undefined) {
    selectedLots = recentLotsForDeviceFromDummy({
      device: params.device,
      probeCardType: params.probeCardType,
      passIds: params.passIds,
      testEndWindow: params.testEndWindow,
      topN: params.topN,
    });
    if (selectedLots.length === 0) return null;
    lotsIn = selectedLots;
  }

  const wafers = resolveSiteBinWafersFromDummy({
    device: params.device,
    lot: params.lot,
    probeCardType: params.probeCardType,
    passIds: params.passIds,
    testEndWindow: params.testEndWindow,
    lotsIn,
  });
  if (wafers.length === 0) return null;

  const single = buildSiteBinByLotDummyData(params.passIds);
  const chunks = wafers.map(() => single);
  const lotSet = new Set(wafers.map((w) => w.lot));

  return {
    ...mergeSiteBinByLotData(chunks),
    probeCardType: params.probeCardType,
    waferCount: wafers.length,
    waferSlots: wafers.map((w) => w.slot),
    waferLots: params.aggregateScope === "device" ? [...lotSet].sort() : undefined,
    selectedLots,
    topN: params.topN,
    lotDir:
      params.aggregateScope === "lot"
        ? buildInfLotDir(params.device, params.lot!)
        : undefined,
    deviceDir:
      params.aggregateScope === "device"
        ? buildInfDeviceDir(params.device)
        : undefined,
    skippedInfPaths: [],
  };
}

export function tryResolveSiteBinByLotDummyForLot(
  device: string,
  lot: string,
  probeCardType: string,
  passIds: number[],
  testEndWindow: SiteBinTestEndWindow
): SiteBinByLotDummyAggResult | null {
  return tryResolveSiteBinByLotDummyAggregate({
    device,
    lot,
    probeCardType,
    passIds,
    testEndWindow,
    aggregateScope: "lot",
  });
}

function resolveDummyDeviceProbeCardType(
  device: string,
  passIds: number[],
  testEndWindow: SiteBinTestEndWindow,
  probeCardType?: string
): string | null {
  const explicit = probeCardType?.trim();
  if (explicit) return explicit;
  const types = distinctProbeCardTypesFromDummy({
    device,
    passIds,
    testEndWindow,
  });
  if (types.length === 0) return null;
  if (types.length > 1) {
    throw new OutputSiteBinByLotValidationError(
      `Multiple probe card types for device+passId: ${types.join(", ")}. Pass probeCardType to select one.`
    );
  }
  return types[0]!;
}

export function tryResolveSiteBinByLotDummyForDevice(
  device: string,
  passIds: number[],
  testEndWindow: SiteBinTestEndWindow,
  topN: number,
  probeCardType?: string
): SiteBinByLotDummyAggResult | null {
  if (!siteBinByLotUseDummy()) return null;
  if (!siteBinByLotDummyPathAllowed(buildInfDeviceDir(device))) return null;

  const resolved = resolveDummyDeviceProbeCardType(
    device,
    passIds,
    testEndWindow,
    probeCardType
  );
  if (!resolved) return null;
  const pct = resolved;

  return tryResolveSiteBinByLotDummyAggregate({
    device,
    probeCardType: pct,
    passIds,
    testEndWindow,
    aggregateScope: "device",
    topN,
  });
}
