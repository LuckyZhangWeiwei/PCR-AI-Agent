import fs from "node:fs";

import { buildInfPath } from "./buildInfPath.js";
import { oracleMapFallbackEnabled } from "./infOracleMapFallback.js";
import { getInfcontrolLayerBinDummyRows } from "./infcontrolLayerBinDummy.js";
import { listApisForceOracleNoDummy } from "./listDummyRuntime.js";
import {
  OutputSiteBinByLotNotFoundError,
  OutputSiteBinByLotValidationError,
} from "./outputSiteBinByLot.js";
import { probeCardTypeLeadingSegment } from "./probeCardTypeLeadingSegment.js";
import {
  rowTestEndInWindow,
  type SiteBinTestEndWindow,
} from "./siteBinByLotTestEndWindow.js";
import oracledb from "oracledb";
import { withConnection } from "../oracle.js";

export type SiteBinWaferRef = {
  lot: string;
  slot: number;
  infPath: string;
};

export type ResolveSiteBinWafersParams = {
  device: string;
  lot?: string;
  /** 省略时仅 device 聚合：由 Oracle/Dummy JB 推断唯一卡型 */
  probeCardType?: string;
  passIds: number[];
  /** JB 路径必填：限制 TESTEND（device / lot+probeCardType） */
  testEndWindow: SiteBinTestEndWindow;
  /** device 聚合：仅纳入 TESTEND 最新的 N 个 lot */
  deviceTopLots?: number;
};

type JbWaferFilterParams = {
  device: string;
  lot?: string;
  probeCardType: string;
  passIds: number[];
  testEndWindow: SiteBinTestEndWindow;
  lotsIn?: string[];
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
      "Missing or empty query parameter: probeCardType"
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

function rowMatchesDeviceLotPass(
  row: {
    DEVICE: string;
    LOT: string;
    PASSTYPE: string;
    PASSID: number;
    TESTEND?: string;
  },
  device: string,
  lot: string | undefined,
  passIds: Set<number>,
  testEndWindow: SiteBinTestEndWindow
): boolean {
  if (String(row.PASSTYPE).trim() !== "TEST") return false;
  if (String(row.DEVICE).trim().toUpperCase() !== device.trim().toUpperCase()) {
    return false;
  }
  if (lot !== undefined && String(row.LOT).trim().toUpperCase() !== lot.trim().toUpperCase()) {
    return false;
  }
  if (lotExcluded(String(row.LOT))) return false;
  if (!passIds.has(Number(row.PASSID))) return false;
  if (!rowTestEndInWindow(row.TESTEND, testEndWindow)) return false;
  return true;
}

/** device + passId 下 JB 中出现的不同 probeCardType（CARDID 首段）。 */
export function distinctProbeCardTypesFromDummy(params: {
  device: string;
  lot?: string;
  passIds: number[];
  testEndWindow: SiteBinTestEndWindow;
}): string[] {
  const passSet = new Set(params.passIds);
  const types = new Set<string>();
  for (const row of getInfcontrolLayerBinDummyRows()) {
    if (
      !rowMatchesDeviceLotPass(
        row,
        params.device,
        params.lot,
        passSet,
        params.testEndWindow
      )
    ) {
      continue;
    }
    const pct = probeCardTypeLeadingSegment(row.CARDID);
    if (pct) types.add(pct.toUpperCase());
  }
  return [...types].sort((a, b) => a.localeCompare(b));
}

async function distinctProbeCardTypesFromOracle(params: {
  device: string;
  lot?: string;
  passIds: number[];
  testEndWindow: SiteBinTestEndWindow;
}): Promise<string[]> {
  const binds: Record<string, string | number | Date> = {
    device: params.device.trim(),
    testend_lo: params.testEndWindow.lo,
    testend_hi: params.testEndWindow.hi,
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
SELECT DISTINCT NVL(REGEXP_SUBSTR(TRIM(lb.CARDID), '^[^-]+', 1, 1), '') AS PCT
FROM INFCONTROL ic
INNER JOIN INFLAYERBINLIST lb ON ic.KEYNUMBER = lb.KEYNUMBER
WHERE UPPER(TRIM(ic.DEVICE)) = UPPER(:device)
  AND UPPER(TRIM(lb.PASSTYPE)) = 'TEST'
  AND lb.PASSID IN (${passPlaceholders.join(", ")})
  AND lb.TESTEND >= :testend_lo
  AND lb.TESTEND <= :testend_hi
  AND NOT REGEXP_LIKE(ic.LOT, '^(kk|gg|c)', 'i')
  AND NVL(REGEXP_SUBSTR(TRIM(lb.CARDID), '^[^-]+', 1, 1), '') IS NOT NULL
  ${lotClause}
`.trim();

  const rows = await withConnection(async (conn) => {
    const result = await conn.execute<{ PCT: string }>(sql, binds, {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
    });
    return result.rows ?? [];
  });

  const types = new Set<string>();
  for (const row of rows) {
    const pct = String(row.PCT ?? "").trim().toUpperCase();
    if (pct) types.add(pct);
  }
  return [...types].sort((a, b) => a.localeCompare(b));
}

async function inferProbeCardTypeForDeviceScope(
  params: ResolveSiteBinWafersParams
): Promise<string> {
  const types = listApisForceOracleNoDummy()
    ? await distinctProbeCardTypesFromOracle({
        device: params.device,
        passIds: params.passIds,
        testEndWindow: params.testEndWindow,
      })
    : distinctProbeCardTypesFromDummy({
        device: params.device,
        passIds: params.passIds,
        testEndWindow: params.testEndWindow,
      });

  if (types.length === 0) {
    throw new OutputSiteBinByLotNotFoundError(
      `No JB TEST rows for device=${params.device}, passIds=[${params.passIds.join(", ")}]`
    );
  }
  if (types.length > 1) {
    throw new OutputSiteBinByLotValidationError(
      `Multiple probe card types for device+passId: ${types.join(", ")}. Pass probeCardType to select one.`
    );
  }
  return types[0]!;
}

async function effectiveProbeCardType(
  params: ResolveSiteBinWafersParams
): Promise<string> {
  const explicit = params.probeCardType?.trim();
  if (explicit) return explicit;
  if (params.lot !== undefined) {
    throw new OutputSiteBinByLotValidationError(
      "probeCardType is required when filtering a lot via JB (omit probeCardType only for lot directory scan or device aggregation)"
    );
  }
  return inferProbeCardTypeForDeviceScope(params);
}

/** device 范围：按 lot 的 MAX(TESTEND) 降序取前 topN 个 lot。 */
export function recentLotsForDeviceFromDummy(params: {
  device: string;
  probeCardType: string;
  passIds: number[];
  testEndWindow: SiteBinTestEndWindow;
  topN: number;
}): string[] {
  const passSet = new Set(params.passIds);
  const lotMaxEnd = new Map<string, number>();

  for (const row of getInfcontrolLayerBinDummyRows()) {
    if (
      !rowMatchesDeviceLotPass(
        row,
        params.device,
        undefined,
        passSet,
        params.testEndWindow
      )
    ) {
      continue;
    }
    if (!cardIdMatchesProbeCardType(row.CARDID, params.probeCardType)) continue;

    const lot = String(row.LOT).trim();
    const t = new Date(String(row.TESTEND ?? "")).getTime();
    if (Number.isNaN(t)) continue;
    const prev = lotMaxEnd.get(lot) ?? 0;
    if (t > prev) lotMaxEnd.set(lot, t);
  }

  return [...lotMaxEnd.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, params.topN)
    .map(([lot]) => lot);
}

async function recentLotsForDeviceFromOracle(params: {
  device: string;
  probeCardType: string;
  passIds: number[];
  testEndWindow: SiteBinTestEndWindow;
  topN: number;
}): Promise<string[]> {
  const binds: Record<string, string | number | Date> = {
    device: params.device.trim(),
    probeCardType: params.probeCardType.trim(),
    testend_lo: params.testEndWindow.lo,
    testend_hi: params.testEndWindow.hi,
    topn: params.topN,
  };
  const passPlaceholders = params.passIds.map((_, i) => `:pass${i}`);
  for (let i = 0; i < params.passIds.length; i++) {
    binds[`pass${i}`] = params.passIds[i]!;
  }

  const sql = `
SELECT LOT FROM (
  SELECT LOT, MAX_TE FROM (
    SELECT TRIM(ic.LOT) AS LOT, MAX(lb.TESTEND) AS MAX_TE
    FROM INFCONTROL ic
    INNER JOIN INFLAYERBINLIST lb ON ic.KEYNUMBER = lb.KEYNUMBER
    WHERE UPPER(TRIM(ic.DEVICE)) = UPPER(:device)
      AND UPPER(TRIM(lb.PASSTYPE)) = 'TEST'
      AND (
        UPPER(TRIM(lb.CARDID)) = UPPER(:probeCardType)
        OR UPPER(TRIM(lb.CARDID)) LIKE UPPER(:probeCardType) || '-%'
      )
      AND lb.PASSID IN (${passPlaceholders.join(", ")})
      AND lb.TESTEND >= :testend_lo
      AND lb.TESTEND <= :testend_hi
      AND NOT REGEXP_LIKE(ic.LOT, '^(kk|gg|c)', 'i')
    GROUP BY TRIM(ic.LOT)
  )
  ORDER BY MAX_TE DESC
)
WHERE ROWNUM <= :topn
`.trim();

  const rows = await withConnection(async (conn) => {
    const result = await conn.execute<{ LOT: string }>(sql, binds, {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
    });
    return result.rows ?? [];
  });

  const lots: string[] = [];
  for (const row of rows) {
    const lot = String(row.LOT ?? "").trim();
    if (lot) lots.push(lot);
  }
  return lots;
}

export function resolveSiteBinWafersFromDummy(params: JbWaferFilterParams): SiteBinWaferRef[] {
  const passSet = new Set(params.passIds);
  const wafers: SiteBinWaferRef[] = [];

  for (const row of getInfcontrolLayerBinDummyRows()) {
    if (
      !rowMatchesDeviceLotPass(
        row,
        params.device,
        params.lot,
        passSet,
        params.testEndWindow
      )
    ) {
      continue;
    }
    if (!cardIdMatchesProbeCardType(row.CARDID, params.probeCardType)) continue;

    const lot = String(row.LOT).trim();
    if (
      params.lotsIn !== undefined &&
      params.lotsIn.length > 0 &&
      !params.lotsIn.includes(lot)
    ) {
      continue;
    }
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

async function resolveSiteBinWafersFromOracle(
  params: JbWaferFilterParams
): Promise<SiteBinWaferRef[]> {
  const binds: Record<string, string | number | Date> = {
    device: params.device.trim(),
    probeCardType: params.probeCardType.trim(),
    testend_lo: params.testEndWindow.lo,
    testend_hi: params.testEndWindow.hi,
  };
  const passPlaceholders = params.passIds.map((_, i) => `:pass${i}`);
  for (let i = 0; i < params.passIds.length; i++) {
    binds[`pass${i}`] = params.passIds[i]!;
  }

  let lotClause = "";
  if (params.lot !== undefined) {
    binds.lot = params.lot.trim();
    lotClause = " AND UPPER(TRIM(ic.LOT)) = UPPER(:lot)";
  } else if (params.lotsIn !== undefined && params.lotsIn.length > 0) {
    const lotPlaceholders = params.lotsIn.map((_, i) => `:lotin${i}`);
    for (let i = 0; i < params.lotsIn.length; i++) {
      binds[`lotin${i}`] = params.lotsIn[i]!.trim();
    }
    lotClause = ` AND UPPER(TRIM(ic.LOT)) IN (${lotPlaceholders
      .map((p) => `UPPER(${p})`)
      .join(", ")})`;
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
  AND lb.TESTEND >= :testend_lo
  AND lb.TESTEND <= :testend_hi
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

/** JB 锁定 wafer 列表；返回实际使用的 probeCardType（传入或 device 级自动推断）。 */
export async function resolveSiteBinWafersWithSkips(
  params: ResolveSiteBinWafersParams
): Promise<{
  wafers: SiteBinWaferRef[];
  skippedInfPaths: string[];
  probeCardType: string;
  /** device 聚合：按 TESTEND 选中的 lot（有序，新→旧） */
  selectedLots?: string[];
  topN?: number;
}> {
  const probeCardType = await effectiveProbeCardType(params);

  let selectedLots: string[] | undefined;
  let lotsIn: string[] | undefined;
  if (params.lot === undefined && params.deviceTopLots !== undefined) {
    const topN = params.deviceTopLots;
    selectedLots = listApisForceOracleNoDummy()
      ? await recentLotsForDeviceFromOracle({
          device: params.device,
          probeCardType,
          passIds: params.passIds,
          testEndWindow: params.testEndWindow,
          topN,
        })
      : recentLotsForDeviceFromDummy({
          device: params.device,
          probeCardType,
          passIds: params.passIds,
          testEndWindow: params.testEndWindow,
          topN,
        });
    if (selectedLots.length === 0) {
      throw new OutputSiteBinByLotNotFoundError(
        `No JB TEST lots for device=${params.device}, probeCardType=${probeCardType}, passIds=[${params.passIds.join(", ")}]`
      );
    }
    lotsIn = selectedLots;
  }

  const resolved: JbWaferFilterParams = {
    device: params.device,
    lot: params.lot,
    probeCardType,
    passIds: params.passIds,
    testEndWindow: params.testEndWindow,
    lotsIn,
  };

  const fromJb = listApisForceOracleNoDummy()
    ? await resolveSiteBinWafersFromOracle(resolved)
    : resolveSiteBinWafersFromDummy(resolved);

  if (fromJb.length === 0) {
    const scope = params.lot
      ? `device=${params.device}, lot=${params.lot}`
      : selectedLots
        ? `device=${params.device}, topN lots=[${selectedLots.join(", ")}]`
        : `device=${params.device}`;
    throw new OutputSiteBinByLotNotFoundError(
      `No JB TEST rows for ${scope}, probeCardType=${probeCardType}, passIds=[${params.passIds.join(", ")}]`
    );
  }

  const accessResults = await Promise.allSettled(
    fromJb.map((w) => fs.promises.access(w.infPath, fs.constants.R_OK).then(() => w))
  );
  const wafers: SiteBinWaferRef[] = [];
  const skippedInfPaths: string[] = [];

  if (oracleMapFallbackEnabled()) {
    // INF 丢失时由 Oracle map 回退；仍保留全部 JB 匹配 wafer。
    return {
      wafers: fromJb,
      skippedInfPaths: [],
      probeCardType,
      ...(selectedLots !== undefined
        ? { selectedLots, topN: params.deviceTopLots }
        : {}),
    };
  }

  for (let i = 0; i < accessResults.length; i++) {
    const r = accessResults[i]!;
    if (r.status === "fulfilled") {
      wafers.push(r.value);
    } else {
      skippedInfPaths.push(fromJb[i]!.infPath);
    }
  }

  if (wafers.length === 0) {
    throw new OutputSiteBinByLotNotFoundError(
      `JB matched ${fromJb.length} wafer(s) but none readable on disk`
    );
  }

  return {
    wafers,
    skippedInfPaths,
    probeCardType,
    ...(selectedLots !== undefined
      ? { selectedLots, topN: params.deviceTopLots }
      : {}),
  };
}

export function probeCardTypeFromCardId(cardId: unknown): string | null {
  return probeCardTypeLeadingSegment(cardId);
}
