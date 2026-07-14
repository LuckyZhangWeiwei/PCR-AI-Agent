import fs from "node:fs";
import path from "node:path";

import { buildInfDeviceDir, buildInfLotDir } from "../buildInfPath.js";
import { OracleMapFallbackNotFoundError } from "../infOracleMapFallback.js";
import {
  resolveSiteBinWafersWithSkips,
  type SiteBinWaferRef,
} from "../siteBinByLotWaferResolve.js";
import type { SiteBinTestEndWindow } from "../siteBinByLotTestEndWindow.js";
import { getSiteBinByLotMaxWafers, getSiteBinByLotMaxWafersDevice, validateInfPath } from "./params.js";
import { mergeSiteBinByLotData, runSiteBinForWafer } from "./singleWafer.js";
import {
  InfSiteBinUnavailableError,
  OutputSiteBinByLotNotFoundError,
  OutputSiteBinByLotValidationError,
  type RunOutputSiteBinByLotAggregateResult,
  type SiteBinByLotData,
} from "./types.js";

const WAFER_INF_BASENAME_RE = /^r_1-(\d+)$/;

/** 列出 lot 目录下所有 wafer INF（文件名 `r_1-{slot}`，无扩展名）。 */
export async function listWaferInfPathsInLotDir(
  lotDir: string
): Promise<{ slot: number; infPath: string }[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(lotDir, { withFileTypes: true });
  } catch (e: unknown) {
    const code =
      e && typeof e === "object" && "code" in e
        ? (e as { code?: string }).code
        : undefined;
    if (code === "ENOENT") {
      throw new OutputSiteBinByLotNotFoundError(
        `Lot INF directory not found: ${lotDir}`
      );
    }
    throw e;
  }

  const wafers: { slot: number; infPath: string }[] = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const m = WAFER_INF_BASENAME_RE.exec(ent.name);
    if (!m) continue;
    const slot = Number(m[1]);
    if (!Number.isInteger(slot) || slot < 1) continue;
    wafers.push({ slot, infPath: path.join(lotDir, ent.name) });
  }
  wafers.sort((a, b) => a.slot - b.slot);
  return wafers;
}

function assertWaferCountWithinLimit(
  count: number,
  max: number,
  envName: string,
  scopeLabel: string,
  opts?: { jbTimeFiltered?: boolean }
): void {
  if (count > max) {
    const hints: string[] = [];
    if (opts?.jbTimeFiltered) {
      hints.push(
        "reduce topN (default 10 lots) or narrow testEndFrom/testEndTo"
      );
    }
    hints.push(`raise ${envName} on server (cap 500)`);
    throw new OutputSiteBinByLotValidationError(
      `${scopeLabel} has ${count} wafer(s); maximum allowed is ${max} (${envName}). ${hints.join("; ")}.`
    );
  }
}

async function runPerlForWafers(
  device: string,
  wafers: SiteBinWaferRef[],
  passIds: number[]
): Promise<{
  data: SiteBinByLotData;
  stderrParts: string[];
  oracleFallbackPaths: string[];
  skippedInfPaths: string[];
}> {
  const chunks: SiteBinByLotData[] = [];
  const stderrParts: string[] = [];
  const oracleFallbackPaths: string[] = [];
  const skippedInfPaths: string[] = [];

  for (const wafer of wafers) {
    try {
      const { data, source, notices } = await runSiteBinForWafer(device, wafer, passIds);
      chunks.push(data);
      for (const n of notices) stderrParts.push(n);
      if (source === "oracle") oracleFallbackPaths.push(wafer.infPath);
    } catch (e) {
      if (e instanceof InfSiteBinUnavailableError || e instanceof OracleMapFallbackNotFoundError) {
        skippedInfPaths.push(wafer.infPath);
        stderrParts.push(
          `${wafer.infPath}: ${e instanceof Error ? e.message : String(e)}`
        );
        continue;
      }
      throw e;
    }
  }

  if (chunks.length === 0) {
    throw new OutputSiteBinByLotNotFoundError(
      `No wafer data from INF or Oracle for ${wafers.length} wafer(s)`
    );
  }

  return {
    data: mergeSiteBinByLotData(chunks),
    stderrParts,
    oracleFallbackPaths,
    skippedInfPaths,
  };
}

function appendOracleFallbackStderr(
  stderrParts: string[],
  oracleFallbackPaths: string[]
): void {
  if (oracleFallbackPaths.length > 0) {
    stderrParts.push(
      `Oracle map fallback for ${oracleFallbackPaths.length} wafer(s) (INF missing/unreadable):\n${oracleFallbackPaths.join("\n")}`
    );
  }
}

/**
 * Lot 聚合（原有逻辑）：扫描 lot 目录下全部 `r_1-{slot}`，不按卡类型过滤。
 */
export async function runOutputSiteBinByLotForLotByDirectory(
  device: string,
  lot: string,
  passIds: number[]
): Promise<RunOutputSiteBinByLotAggregateResult> {
  const lotDir = validateInfPath(buildInfLotDir(device, lot));
  const listed = await listWaferInfPathsInLotDir(lotDir);
  if (listed.length === 0) {
    throw new OutputSiteBinByLotNotFoundError(
      `No wafer INF files (r_1-{slot}) under ${lotDir}`
    );
  }
  assertWaferCountWithinLimit(
    listed.length,
    getSiteBinByLotMaxWafers(),
    "SITE_BIN_BY_LOT_MAX_WAFERS",
    "Lot"
  );

  const wafers: SiteBinWaferRef[] = listed.map(({ slot, infPath }) => ({
    lot,
    slot,
    infPath,
  }));
  const { data, stderrParts, oracleFallbackPaths, skippedInfPaths: runSkipped } =
    await runPerlForWafers(device, wafers, passIds);
  appendOracleFallbackStderr(stderrParts, oracleFallbackPaths);

  return {
    aggregateScope: "lot",
    lotDir,
    waferCount: wafers.length,
    waferSlots: wafers.map((w) => w.slot),
    skippedInfPaths: runSkipped,
    ...(oracleFallbackPaths.length > 0 ? { oracleFallbackPaths } : {}),
    data,
    stderrParts,
  };
}

/**
 * Lot 聚合（可选）：JB 锁定 probeCardType + passId，仅聚合磁盘可读的 wafer INF。
 */
export async function runOutputSiteBinByLotForLot(
  device: string,
  lot: string,
  probeCardType: string,
  passIds: number[],
  testEndWindow: SiteBinTestEndWindow
): Promise<RunOutputSiteBinByLotAggregateResult> {
  const { wafers, skippedInfPaths: resolveSkipped, probeCardType: pct } =
    await resolveSiteBinWafersWithSkips({
    device,
    lot,
    probeCardType,
    passIds,
    testEndWindow,
  });
  assertWaferCountWithinLimit(
    wafers.length,
    getSiteBinByLotMaxWafers(),
    "SITE_BIN_BY_LOT_MAX_WAFERS",
    "Lot",
    { jbTimeFiltered: true }
  );

  const { data, stderrParts, oracleFallbackPaths, skippedInfPaths: runSkipped } =
    await runPerlForWafers(device, wafers, passIds);
  appendOracleFallbackStderr(stderrParts, oracleFallbackPaths);
  const skippedInfPaths = [...new Set([...resolveSkipped, ...runSkipped])];
  if (skippedInfPaths.length > 0) {
    stderrParts.push(
      `Skipped ${skippedInfPaths.length} wafer(s) (INF and Oracle map fallback unavailable):\n${skippedInfPaths.join("\n")}`
    );
  }

  return {
    aggregateScope: "lot",
    lotDir: validateInfPath(buildInfLotDir(device, lot)),
    probeCardType: pct,
    testEndWindow,
    waferCount: wafers.length,
    waferSlots: wafers.map((w) => w.slot),
    skippedInfPaths,
    ...(oracleFallbackPaths.length > 0 ? { oracleFallbackPaths } : {}),
    data,
    stderrParts,
  };
}

/**
 * Device 聚合：仅需 device + passId；未传 probeCardType 时由 JB 推断唯一卡型（多种则 400）。
 */
export async function runOutputSiteBinByLotForDevice(
  device: string,
  passIds: number[],
  testEndWindow: SiteBinTestEndWindow,
  topN: number,
  probeCardType?: string
): Promise<RunOutputSiteBinByLotAggregateResult> {
  const { wafers, skippedInfPaths: resolveSkipped, probeCardType: pct, selectedLots } =
    await resolveSiteBinWafersWithSkips({
    device,
    probeCardType,
    passIds,
    testEndWindow,
    deviceTopLots: topN,
  });
  assertWaferCountWithinLimit(
    wafers.length,
    getSiteBinByLotMaxWafersDevice(),
    "SITE_BIN_BY_LOT_MAX_WAFERS_DEVICE",
    "Device",
    { jbTimeFiltered: true }
  );

  const { data, stderrParts, oracleFallbackPaths, skippedInfPaths: runSkipped } =
    await runPerlForWafers(device, wafers, passIds);
  appendOracleFallbackStderr(stderrParts, oracleFallbackPaths);
  const skippedInfPaths = [...new Set([...resolveSkipped, ...runSkipped])];
  if (skippedInfPaths.length > 0) {
    stderrParts.push(
      `Skipped ${skippedInfPaths.length} wafer(s) (INF and Oracle map fallback unavailable):\n${skippedInfPaths.join("\n")}`
    );
  }

  const lotSet = new Set(wafers.map((w) => w.lot));
  return {
    aggregateScope: "device",
    deviceDir: validateInfPath(buildInfDeviceDir(device)),
    probeCardType: pct,
    testEndWindow,
    topN,
    selectedLots,
    waferCount: wafers.length,
    waferSlots: wafers.map((w) => w.slot),
    waferLots: [...lotSet].sort((a, b) => a.localeCompare(b)),
    skippedInfPaths,
    ...(oracleFallbackPaths.length > 0 ? { oracleFallbackPaths } : {}),
    data,
    stderrParts,
  };
}
