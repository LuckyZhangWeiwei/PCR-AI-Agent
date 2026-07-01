import oracledb from "oracledb";

import {
  computeUnderperformingDutsForPasses,
  formatUnderperformingDutsMarkdown,
  LOT_UNDERPERFORMING_DUTS_SUMMARY,
  parseUnderperformingThresholdRatio,
  type PassUnderperformingDutsResult,
} from "./lotUnderperformingDuts.js";
import {
  getInfcontrolLayerBinDummyRows,
  infcontrolLayerBinsUseDummy,
} from "./infcontrolLayerBinDummy.js";
import {
  OutputSiteBinByLotNotFoundError,
  OutputSiteBinByLotValidationError,
  parsePassIdsFromQuery,
  runOutputSiteBinByLotForLot,
  validateDeviceLot,
  type SiteBinPass,
} from "./outputSiteBinByLot.js";
import { tryResolveSiteBinByLotDummyForLot } from "./outputSiteBinByLotDummy.js";
import { parseSiteBinByLotTestEndWindow } from "./siteBinByLotTestEndWindow.js";
import {
  probeCardTypeFromCardId,
  validateProbeCardType,
} from "./siteBinByLotWaferResolve.js";
import { withConnection } from "../oracle.js";
import type { SiteBinTestEndWindow } from "./siteBinByLotTestEndWindow.js";

export type LotSiteBinFetchResult = {
  device: string;
  lot: string;
  passIds: number[];
  probeCardType: string;
  probeCardTypeResolvedFromJb: boolean;
  waferCount: number;
  waferSlots: number[];
  skippedInfPaths: string[];
  passes: SiteBinPass[];
};

export type LotUnderperformingDutsResponse = {
  meta: {
    apiVersion: "4";
    summary: string;
    aggregateScope: "lot";
  };
  device: string;
  lot: string;
  passIds: number[];
  probeCardType: string;
  deviceResolvedFromJb?: true;
  probeCardTypeResolvedFromJb?: true;
  waferCount: number;
  waferSlots: number[];
  skippedInfPaths?: string[];
  filters: {
    thresholdRatio: number;
    baselineMethod: "lotOverall";
  };
  passes: PassUnderperformingDutsResult[];
  underperformingDutsMarkdown?: string;
};

export function parsePassIdsFromQueryOrDefault(
  raw: unknown,
  defaultPassIds: number[] = [1, 3, 5]
): number[] {
  if (raw === undefined || raw === null || raw === "") {
    return [...defaultPassIds];
  }
  return parsePassIdsFromQuery(raw);
}

function jbTestRowsForLot(device: string, lot: string, passIds: number[]) {
  const lotUpper = lot.trim().toUpperCase();
  const deviceTrim = device.trim();
  const passSet = new Set(passIds);
  return getInfcontrolLayerBinDummyRows().filter((row) => {
    if (String(row.LOT ?? "").trim().toUpperCase() !== lotUpper) return false;
    if (String(row.DEVICE ?? "").trim() !== deviceTrim) return false;
    if (String(row.PASSTYPE ?? "").trim().toUpperCase() !== "TEST") return false;
    const passId = Number(row.PASSID);
    if (!Number.isInteger(passId) || !passSet.has(passId)) return false;
    return true;
  });
}

function pickDominantProbeCardType(counts: Map<string, number>): string {
  let best: string | null = null;
  let bestN = 0;
  for (const [pct, n] of counts.entries()) {
    if (n > bestN) {
      best = pct;
      bestN = n;
    }
  }
  if (!best) {
    throw new OutputSiteBinByLotNotFoundError(
      "No probe card type found in JB STAR for this lot and passId(s)"
    );
  }
  return best;
}

export async function resolveDeviceForLot(lotRaw: string): Promise<string> {
  const lot = lotRaw.trim();
  if (!lot) {
    throw new OutputSiteBinByLotValidationError("Missing or empty query parameter: lot");
  }

  if (infcontrolLayerBinsUseDummy()) {
    const devices = new Set<string>();
    const lotUpper = lot.toUpperCase();
    for (const row of getInfcontrolLayerBinDummyRows()) {
      if (String(row.LOT ?? "").trim().toUpperCase() !== lotUpper) continue;
      const device = String(row.DEVICE ?? "").trim();
      if (device) devices.add(device);
    }
    if (devices.size === 0) {
      throw new OutputSiteBinByLotNotFoundError(`No JB STAR row found for lot: ${lot}`);
    }
    if (devices.size > 1) {
      throw new OutputSiteBinByLotValidationError(
        `Lot ${lot} maps to multiple devices (${[...devices].sort().join(", ")}); pass query parameter device`
      );
    }
    return [...devices][0]!;
  }

  return withConnection(async (conn) => {
    const result = await conn.execute<{ DEVICE: string }>(
      `SELECT DISTINCT t1.DEVICE AS DEVICE
       FROM INFCONTROL t1
       INNER JOIN INFLAYERBINLIST t2 ON t1.KEYNUMBER = t2.KEYNUMBER
       WHERE UPPER(TRIM(t1.LOT)) = UPPER(TRIM(:lot))
         AND NOT REGEXP_LIKE(t1.LOT, '^(kk|gg|c)', 'i')
         AND UPPER(TRIM(t2.PASSTYPE)) = 'TEST'`,
      { lot },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const rows = result.rows ?? [];
    const devices = [
      ...new Set(
        rows
          .map((r) => String(r.DEVICE ?? "").trim())
          .filter((d) => d.length > 0)
      ),
    ];
    if (devices.length === 0) {
      throw new OutputSiteBinByLotNotFoundError(`No JB STAR row found for lot: ${lot}`);
    }
    if (devices.length > 1) {
      throw new OutputSiteBinByLotValidationError(
        `Lot ${lot} maps to multiple devices (${devices.sort().join(", ")}); pass query parameter device`
      );
    }
    return devices[0]!;
  });
}

export async function resolveProbeCardTypeForLot(
  device: string,
  lot: string,
  passIds: number[]
): Promise<string> {
  if (infcontrolLayerBinsUseDummy()) {
    const counts = new Map<string, number>();
    for (const row of jbTestRowsForLot(device, lot, passIds)) {
      const pct = probeCardTypeFromCardId(row.CARDID);
      if (!pct) continue;
      counts.set(pct, (counts.get(pct) ?? 0) + 1);
    }
    return pickDominantProbeCardType(counts);
  }

  return withConnection(async (conn) => {
    const passBinds: Record<string, number> = {};
    const passPlaceholders = passIds.map((id, i) => {
      const key = `p${i}`;
      passBinds[key] = id;
      return `:${key}`;
    });
    const result = await conn.execute<{ PROBECARDTYPE: string; CNT: number }>(
      `SELECT UPPER(TRIM(REGEXP_SUBSTR(lb.CARDID, '[^-]+', 1, 1))) AS PROBECARDTYPE,
              COUNT(*) AS CNT
       FROM INFCONTROL t1
       INNER JOIN INFLAYERBINLIST lb ON t1.KEYNUMBER = lb.KEYNUMBER
       WHERE UPPER(TRIM(t1.DEVICE)) = UPPER(TRIM(:device))
         AND UPPER(TRIM(t1.LOT)) = UPPER(TRIM(:lot))
         AND NOT REGEXP_LIKE(t1.LOT, '^(kk|gg|c)', 'i')
         AND UPPER(TRIM(lb.PASSTYPE)) = 'TEST'
         AND lb.PASSID IN (${passPlaceholders.join(", ")})
       GROUP BY UPPER(TRIM(REGEXP_SUBSTR(lb.CARDID, '[^-]+', 1, 1)))
       ORDER BY COUNT(*) DESC`,
      { device, lot, ...passBinds },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const rows = result.rows ?? [];
    const counts = new Map<string, number>();
    for (const row of rows) {
      const pct = String(row.PROBECARDTYPE ?? "").trim();
      if (!pct) continue;
      counts.set(pct, Number(row.CNT ?? 0));
    }
    return pickDominantProbeCardType(counts);
  });
}

export async function resolveDeviceLotFromQuery(
  lotRaw: string,
  deviceRaw: string | undefined
): Promise<{ device: string; lot: string; deviceResolvedFromJb: boolean }> {
  const lotTrimmed = lotRaw.trim();
  if (!lotTrimmed) {
    throw new OutputSiteBinByLotValidationError("Missing or empty query parameter: lot");
  }
  const deviceTrimmed = (deviceRaw ?? "").trim();
  if (deviceTrimmed) {
    const { device, lot } = validateDeviceLot(deviceTrimmed, lotTrimmed);
    return { device, lot, deviceResolvedFromJb: false };
  }
  const device = await resolveDeviceForLot(lotTrimmed);
  return { device, lot: lotTrimmed, deviceResolvedFromJb: true };
}

export async function fetchLotSiteBinPasses(params: {
  device: string;
  lot: string;
  passIds: number[];
  probeCardType?: string;
  testEndWindow?: SiteBinTestEndWindow;
}): Promise<LotSiteBinFetchResult> {
  const { device, lot, passIds } = params;
  const testEndWindow =
    params.testEndWindow ?? parseSiteBinByLotTestEndWindow({});

  let probeCardType = params.probeCardType?.trim() ?? "";
  let probeCardTypeResolvedFromJb = false;
  if (!probeCardType) {
    probeCardType = await resolveProbeCardTypeForLot(device, lot, passIds);
    probeCardTypeResolvedFromJb = true;
  }
  const cardType = validateProbeCardType(probeCardType);

  const dummy = tryResolveSiteBinByLotDummyForLot(
    device,
    lot,
    cardType,
    passIds,
    testEndWindow
  );
  if (dummy !== null) {
    return {
      device,
      lot,
      passIds,
      probeCardType: dummy.probeCardType ?? cardType,
      probeCardTypeResolvedFromJb,
      waferCount: dummy.waferCount,
      waferSlots: dummy.waferSlots,
      skippedInfPaths: dummy.skippedInfPaths ?? [],
      passes: dummy.passes,
    };
  }

  const res = await runOutputSiteBinByLotForLot(
    device,
    lot,
    cardType,
    passIds,
    testEndWindow
  );
  return {
    device,
    lot,
    passIds,
    probeCardType: res.probeCardType ?? cardType,
    probeCardTypeResolvedFromJb,
    waferCount: res.waferCount,
    waferSlots: res.waferSlots,
    skippedInfPaths: res.skippedInfPaths,
    passes: res.data.passes,
  };
}

export async function runLotUnderperformingDuts(params: {
  lot: string;
  device?: string;
  passIds?: number[];
  probeCardType?: string;
  thresholdRatio?: number;
  testEndWindow?: SiteBinTestEndWindow;
  includeMarkdown?: boolean;
}): Promise<LotUnderperformingDutsResponse> {
  const lotTrimmed = params.lot.trim();
  if (!lotTrimmed) {
    throw new OutputSiteBinByLotValidationError("Missing or empty query parameter: lot");
  }

  const thresholdRatio =
    params.thresholdRatio ?? parseUnderperformingThresholdRatio(undefined);
  const passIds = params.passIds ?? [1, 3, 5];

  const { device, lot, deviceResolvedFromJb } = await resolveDeviceLotFromQuery(
    lotTrimmed,
    params.device
  );

  const fetched = await fetchLotSiteBinPasses({
    device,
    lot,
    passIds,
    probeCardType: params.probeCardType,
    testEndWindow: params.testEndWindow,
  });

  const passResults = computeUnderperformingDutsForPasses(fetched.passes, {
    thresholdRatio,
  });

  const response: LotUnderperformingDutsResponse = {
    meta: {
      apiVersion: "4",
      summary: LOT_UNDERPERFORMING_DUTS_SUMMARY,
      aggregateScope: "lot",
    },
    device: fetched.device,
    lot: fetched.lot,
    passIds: fetched.passIds,
    probeCardType: fetched.probeCardType,
    ...(deviceResolvedFromJb ? { deviceResolvedFromJb: true } : {}),
    ...(fetched.probeCardTypeResolvedFromJb
      ? { probeCardTypeResolvedFromJb: true }
      : {}),
    waferCount: fetched.waferCount,
    waferSlots: fetched.waferSlots,
    ...(fetched.skippedInfPaths.length > 0
      ? { skippedInfPaths: fetched.skippedInfPaths }
      : {}),
    filters: {
      thresholdRatio,
      baselineMethod: "lotOverall",
    },
    passes: passResults,
  };

  if (params.includeMarkdown !== false) {
    response.underperformingDutsMarkdown = formatUnderperformingDutsMarkdown(
      fetched.lot,
      fetched.device,
      passResults,
      thresholdRatio
    );
  }

  return response;
}
