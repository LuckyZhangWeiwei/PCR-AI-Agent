import { parseInfWaferCoordsFromPath } from "../buildInfPath.js";
import {
  fetchSiteBinByLotFromOracle,
  infPathReadable,
  OracleMapFallbackNotFoundError,
  oracleMapFallbackEnabled,
  type RunSiteBinWaferResult,
  type SiteBinWaferSource,
} from "../infOracleMapFallback.js";
import {
  siteBinByLotUseDummy,
  tryResolveSiteBinByLotDummy,
} from "../outputSiteBinByLotDummy.js";
import type { SiteBinWaferRef } from "../siteBinByLotWaferResolve.js";
import { runOutputSiteBinByLot, parseSiteBinByLotJson } from "./perlRunner.js";
import {
  InfSiteBinUnavailableError,
  type RunSiteBinForWaferOpts,
  type SiteBinByLotData,
  type SiteBinDutEntry,
  type SiteBinEntry,
  type SiteBinPass,
} from "./types.js";

function dutSortKey(dut: number | "single"): string {
  if (dut === "single") return "z:single";
  return `n:${String(dut).padStart(12, "0")}`;
}

/** 将多片 wafer 的 passes 按 passId×bin×dut 累加 dieCount。 */
export function mergeSiteBinByLotData(chunks: SiteBinByLotData[]): SiteBinByLotData {
  const passMap = new Map<
    number,
    Map<string, Map<number | "single", number>>
  >();

  for (const chunk of chunks) {
    for (const pass of chunk.passes) {
      let binMap = passMap.get(pass.passId);
      if (!binMap) {
        binMap = new Map();
        passMap.set(pass.passId, binMap);
      }
      for (const binEntry of pass.bins) {
        let dutMap = binMap.get(binEntry.bin);
        if (!dutMap) {
          dutMap = new Map();
          binMap.set(binEntry.bin, dutMap);
        }
        for (const { dut, dieCount } of binEntry.duts) {
          dutMap.set(dut, (dutMap.get(dut) ?? 0) + dieCount);
        }
      }
    }
  }

  const passes: SiteBinPass[] = [];
  for (const passId of [...passMap.keys()].sort((a, b) => a - b)) {
    const binMap = passMap.get(passId)!;
    const bins: SiteBinEntry[] = [];
    for (const bin of [...binMap.keys()].sort((a, b) => {
      const na = Number(a.replace(/^bin/i, ""));
      const nb = Number(b.replace(/^bin/i, ""));
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      return a.localeCompare(b);
    })) {
      const dutMap = binMap.get(bin)!;
      const duts: SiteBinDutEntry[] = [];
      for (const dut of [...dutMap.keys()].sort((a, b) =>
        dutSortKey(a).localeCompare(dutSortKey(b))
      )) {
        duts.push({ dut, dieCount: dutMap.get(dut)! });
      }
      bins.push({ bin, duts });
    }
    passes.push({ passId, bins });
  }
  return { passes };
}

/**
 * Layer-scoped branch: `testEnd`（明细行一层）指定时，跳过 INF 整片合并图，
 * Oracle 按 KEYNUMBER+PASSNUM+TESTEND 取该层 map。
 */
async function runSiteBinForWaferLayerScoped(
  device: string,
  wafer: SiteBinWaferRef,
  passIds: number[],
  keynumber: number | undefined,
  passNum: number | undefined,
  testEnd: string | undefined,
  testEndDate: Date | undefined
): Promise<RunSiteBinWaferResult> {
  const notices: string[] = [
    `Layer-scoped map for TESTEND=${testEnd}` +
      (keynumber !== undefined ? ` KEYNUMBER=${keynumber}` : "") +
      (passNum !== undefined ? ` PASSNUM=${passNum}` : ""),
  ];
  if (!oracleMapFallbackEnabled()) {
    throw new InfSiteBinUnavailableError(
      wafer.infPath,
      "Layer-scoped site-bin requires Oracle map fallback (SITE_BIN_ORACLE_FALLBACK) when INF dummy is off"
    );
  }
  const dev =
    device.trim() || parseInfWaferCoordsFromPath(wafer.infPath)?.device || "";
  if (!dev) {
    throw new InfSiteBinUnavailableError(
      wafer.infPath,
      "Cannot resolve device for layer-scoped Oracle map (pass device= or use standard infPath layout)"
    );
  }
  const data = await fetchSiteBinByLotFromOracle({
    device: dev,
    lot: wafer.lot,
    slot: wafer.slot,
    passIds,
    keynumber,
    passNum,
    testEnd: testEndDate,
  });
  return { data, source: "oracle", notices };
}

/**
 * Normal branch: Perl/INF first; on missing/unreadable/Perl failure → Oracle map fallback.
 */
async function runSiteBinForWaferInfThenOracle(
  device: string,
  wafer: SiteBinWaferRef,
  passIds: number[]
): Promise<RunSiteBinWaferResult> {
  const notices: string[] = [];
  const readable = await infPathReadable(wafer.infPath);

  if (readable) {
    const result = await runOutputSiteBinByLot(wafer.infPath, passIds);
    if (result.exitCode === 0) {
      try {
        return {
          data: parseSiteBinByLotJson(result.stdout),
          source: "inf",
          notices,
        };
      } catch {
        notices.push(
          `${wafer.infPath}: Perl JSON parse failed; trying Oracle fallback`
        );
      }
    } else {
      const detail = [result.stderr.trim(), result.stdout.trim()]
        .filter(Boolean)
        .join(" ");
      notices.push(
        `${wafer.infPath}: Perl failed (exit ${result.exitCode})${detail ? `: ${detail.slice(0, 200)}` : ""}; trying Oracle fallback`
      );
    }
  } else {
    notices.push(`${wafer.infPath}: INF not readable; trying Oracle fallback`);
  }

  if (!oracleMapFallbackEnabled()) {
    throw new InfSiteBinUnavailableError(
      wafer.infPath,
      "INF unavailable and Oracle map fallback is disabled (SITE_BIN_ORACLE_FALLBACK=false or site-bin dummy mode)"
    );
  }

  const dev = device.trim() || parseInfWaferCoordsFromPath(wafer.infPath)?.device || "";
  if (!dev) {
    throw new InfSiteBinUnavailableError(
      wafer.infPath,
      "Cannot resolve device for Oracle map fallback (pass device= or use standard infPath layout)"
    );
  }

  try {
    const data = await fetchSiteBinByLotFromOracle({
      device: dev,
      lot: wafer.lot,
      slot: wafer.slot,
      passIds,
    });
    return { data, source: "oracle" as SiteBinWaferSource, notices };
  } catch (e) {
    if (e instanceof OracleMapFallbackNotFoundError) {
      throw new InfSiteBinUnavailableError(wafer.infPath, e.message);
    }
    throw e;
  }
}

/**
 * Single wafer: Perl/INF first; on missing/unreadable/Perl failure → Oracle map fallback.
 * With `testEnd`（明细行一层）：跳过 INF 整片合并图，Oracle 按 KEYNUMBER+PASSNUM+TESTEND 取该层 map。
 */
export async function runSiteBinForWafer(
  device: string,
  wafer: SiteBinWaferRef,
  passIds: number[],
  opts?: RunSiteBinForWaferOpts
): Promise<RunSiteBinWaferResult> {
  const keynumber = opts?.keynumber;
  const passNum = opts?.passNum;
  const testEnd = opts?.testEnd?.trim();
  const testEndDate = testEnd ? new Date(testEnd) : undefined;
  const layerScoped =
    Boolean(testEnd) &&
    testEndDate !== undefined &&
    !Number.isNaN(testEndDate.getTime());

  if (siteBinByLotUseDummy()) {
    const dummyData = tryResolveSiteBinByLotDummy(
      wafer.infPath,
      passIds,
      keynumber,
      testEnd
    );
    if (dummyData !== null) {
      return { data: dummyData, source: "inf", notices: [] };
    }
  }

  if (layerScoped) {
    return runSiteBinForWaferLayerScoped(
      device,
      wafer,
      passIds,
      keynumber,
      passNum,
      testEnd,
      testEndDate
    );
  }

  return runSiteBinForWaferInfThenOracle(device, wafer, passIds);
}
