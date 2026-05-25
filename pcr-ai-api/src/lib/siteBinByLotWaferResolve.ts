import fs from "node:fs";

import { buildInfPath } from "./buildInfPath.js";
import { getInfcontrolLayerBinDummyRows } from "./infcontrolLayerBinDummy.js";
import { listApisForceOracleNoDummy } from "./listDummyRuntime.js";
import {
  OutputSiteBinByLotNotFoundError,
  OutputSiteBinByLotValidationError,
} from "./outputSiteBinByLot.js";
import { probeCardTypeLeadingSegment } from "./probeCardTypeLeadingSegment.js";
import oracledb from "oracledb";
import { withConnection } from "../oracle.js";

export type SiteBinWaferRef = {
  lot: string;
  slot: number;
  infPath: string;
};

const LOT_PREFIX_EXCLUDE_RE = /^(kk|gg|c)/i;

export function cardIdMatchesProbeCardType(
  cardId: unknown,
  probeCardType: string
): boolean {
  const want = probeCardType.trim().toUpperCase();
  if (!want) return false;
  const cid = String(cardId ?? "").trim().toUpperCase();
  return cid === want || cid.startsWith(`${want}-`);
}

export function validateProbeCardType(raw: string): string {
  const probeCardType = raw.trim();
  if (!probeCardType) {
    throw new OutputSiteBinByLotValidationError(
      "Missing or empty query parameter: probeCardType (required for lot/device aggregation)"
    );
  }
  return probeCardType;
}

function lotExcluded(lot: string): boolean {
  return LOT_PREFIX_EXCLUDE_RE.test(String(lot).trim());
}

function dedupeWafers(wafers: SiteBinWaferRef[]): SiteBinWaferRef[] {
  const seen = new Set<string>();
  const out: SiteBinWaferRef[] = [];
  for (const w of wafers) {
    const key = `${w.lot}\0${w.slot}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  out.sort((a, b) => a.lot.localeCompare(b.lot) || a.slot - b.slot);
  return out;
}

export function resolveSiteBinWafersFromDummy(params: {
  device: string;
  lot?: string;
  probeCardType: string;
  passIds: number[];
}): SiteBinWaferRef[] {
  const deviceU = params.device.trim().toUpperCase();
  const lotU = params.lot?.trim().toUpperCase();
  const passSet = new Set(params.passIds);
  const wafers: SiteBinWaferRef[] = [];

  for (const row of getInfcontrolLayerBinDummyRows()) {
    if (String(row.PASSTYPE).trim() !== "TEST") continue;
    if (String(row.DEVICE).trim().toUpperCase() !== deviceU) continue;
    if (lotU !== undefined && String(row.LOT).trim().toUpperCase() !== lotU) continue;
    if (lotExcluded(String(row.LOT))) continue;
    if (!cardIdMatchesProbeCardType(row.CARDID, params.probeCardType)) continue;
    if (!passSet.has(Number(row.PASSID))) continue;

    const lot = String(row.LOT).trim();
    const slot = Number(row.SLOT);
    if (!Number.isInteger(slot) || slot < 1) continue;
    wafers.push({
      lot,
      slot,
      infPath: buildInfPath(params.device, lot, slot),
    });
  }
  return dedupeWafers(wafers);
}

async function resolveSiteBinWafersFromOracle(params: {
  device: string;
  lot?: string;
  probeCardType: string;
  passIds: number[];
}): Promise<SiteBinWaferRef[]> {
  const binds: Record<string, string | number> = {
    device: params.device.trim(),
    probeCardType: params.probeCardType.trim(),
  };
  const passPlaceholders = params.passIds.map((_, i) => `:pass${i}`);
  for (let i = 0; i < params.passIds.length; i++) {
    binds[`pass${i}`] = params.passIds[i]!;
  }

  let lotClause = "";
  if (params.lot !== undefined) {
    binds.lot = params.lot.trim();
    lotClause = " AND UPPER(TRIM(ic.LOT)) = UPPER(:lot)";
  }

  const sql = `
SELECT DISTINCT ic.LOT AS LOT, ic.SLOT AS SLOT
FROM INFCONTROL ic
INNER JOIN INFLAYERBINLIST lb ON ic.KEYNUMBER = lb.KEYNUMBER
WHERE UPPER(TRIM(ic.DEVICE)) = UPPER(:device)
  AND UPPER(TRIM(lb.PASSTYPE)) = 'TEST'
  AND (
    UPPER(TRIM(lb.CARDID)) = UPPER(:probeCardType)
    OR UPPER(TRIM(lb.CARDID)) LIKE UPPER(:probeCardType) || '-%'
  )
  AND lb.PASSID IN (${passPlaceholders.join(", ")})
  AND NOT REGEXP_LIKE(ic.LOT, '^(kk|gg|c)', 'i')
  ${lotClause}
ORDER BY ic.LOT, ic.SLOT
`.trim();

  const rows = await withConnection(async (conn) => {
    const result = await conn.execute<{
      LOT: string;
      SLOT: number;
    }>(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    return result.rows ?? [];
  });

  const wafers: SiteBinWaferRef[] = [];
  for (const row of rows) {
    const lot = String(row.LOT ?? "").trim();
    const slot = Number(row.SLOT);
    if (!lot || !Number.isInteger(slot) || slot < 1) continue;
    wafers.push({
      lot,
      slot,
      infPath: buildInfPath(params.device, lot, slot),
    });
  }
  return dedupeWafers(wafers);
}

/** 响应 meta：记录 JB 命中但磁盘无 INF 的 wafer（不阻断聚合）。 */
export async function resolveSiteBinWafersWithSkips(params: {
  device: string;
  lot?: string;
  probeCardType: string;
  passIds: number[];
}): Promise<{ wafers: SiteBinWaferRef[]; skippedInfPaths: string[] }> {
  const fromJb = listApisForceOracleNoDummy()
    ? await resolveSiteBinWafersFromOracle(params)
    : resolveSiteBinWafersFromDummy(params);

  if (fromJb.length === 0) {
    const scope = params.lot
      ? `device=${params.device}, lot=${params.lot}`
      : `device=${params.device}`;
    throw new OutputSiteBinByLotNotFoundError(
      `No JB TEST rows for ${scope}, probeCardType=${params.probeCardType}, passIds=[${params.passIds.join(", ")}]`
    );
  }

  const wafers: SiteBinWaferRef[] = [];
  const skippedInfPaths: string[] = [];
  for (const w of fromJb) {
    try {
      await fs.promises.access(w.infPath, fs.constants.R_OK);
      wafers.push(w);
    } catch {
      skippedInfPaths.push(w.infPath);
    }
  }

  if (wafers.length === 0) {
    throw new OutputSiteBinByLotNotFoundError(
      `JB matched ${fromJb.length} wafer(s) but none readable on disk`
    );
  }

  return { wafers, skippedInfPaths };
}

export function probeCardTypeFromCardId(cardId: unknown): string | null {
  return probeCardTypeLeadingSegment(cardId);
}
