/**
 * Oracle wafer-map fallback when disk INF is missing or unreadable.
 * Mirrors legacy VB GetMultiWafers: INFLAYERMAP.BINCODELAST + INFLAYERBINLIST.TESTSITELAST.
 */

import oracledb from "oracledb";
import fs from "node:fs";

import { withConnection } from "../oracle.js";
import { siteBinByLotUseDummy } from "./outputSiteBinByLotDummy.js";
import type { SiteBinByLotData, SiteBinPass } from "./outputSiteBinByLot/types.js";

const CLOB_AS_STRING = {
  BINCODELAST: { type: oracledb.STRING },
  TESTSITELAST: { type: oracledb.STRING },
} as const;

/** Skip when site-bin-bylot dummy fixture is active (no Oracle needed). */
export function oracleMapFallbackEnabled(): boolean {
  if (siteBinByLotUseDummy()) return false;
  const raw = process.env.SITE_BIN_ORACLE_FALLBACK?.trim().toLowerCase();
  if (raw === "false" || raw === "0" || raw === "no") return false;
  return true;
}

export class OracleMapFallbackNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OracleMapFallbackNotFoundError";
  }
}

const SKIP_TOKENS = new Set(["__", "@@", ""]);

/** VB: parallel hex tokens from BINCODELAST + TESTSITELAST; skip __/@@/empty. */
export function parseOracleBinSiteMap(
  binCodeLast: string,
  testSiteLast: string
): Map<string, number> {
  const binTokens = binCodeLast.trim().split(/\s+/);
  const siteTokens = testSiteLast.trim().split(/\s+/);
  const summary = new Map<string, number>();
  const len = Math.min(binTokens.length, siteTokens.length);
  for (let i = 0; i < len; i++) {
    const bTok = binTokens[i]!;
    const sTok = siteTokens[i]!;
    if (SKIP_TOKENS.has(bTok) || SKIP_TOKENS.has(sTok)) continue;
    const decBin = parseInt(bTok, 16);
    const decSite = parseInt(sTok, 16);
    if (!Number.isFinite(decBin) || !Number.isFinite(decSite)) continue;
    const key = `${decBin},${decSite}`;
    summary.set(key, (summary.get(key) ?? 0) + 1);
  }
  return summary;
}

export function binSiteSummaryToSiteBinPass(
  passId: number,
  summary: Map<string, number>
): SiteBinPass {
  const binMap = new Map<number, Map<number, number>>();
  for (const [key, count] of summary) {
    const [binStr, siteStr] = key.split(",");
    const bin = Number(binStr);
    const site = Number(siteStr);
    if (!Number.isFinite(bin) || !Number.isFinite(site)) continue;
    if (!binMap.has(bin)) binMap.set(bin, new Map());
    const dutMap = binMap.get(bin)!;
    dutMap.set(site, (dutMap.get(site) ?? 0) + count);
  }
  const bins = [...binMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([binNum, dutMap]) => ({
      bin: `bin${binNum}`,
      duts: [...dutMap.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([dut, dieCount]) => ({ dut, dieCount })),
    }));
  return { passId, bins };
}

function mergeBinSiteSummaries(into: Map<string, number>, add: Map<string, number>): void {
  for (const [k, v] of add) {
    into.set(k, (into.get(k) ?? 0) + v);
  }
}

export function mergeBinSiteSummariesToSiteBinByLotData(
  passSummaries: Map<number, Map<string, number>>
): SiteBinByLotData {
  const passes: SiteBinPass[] = [];
  for (const passId of [...passSummaries.keys()].sort((a, b) => a - b)) {
    passes.push(binSiteSummaryToSiteBinPass(passId, passSummaries.get(passId)!));
  }
  return { passes };
}

type OracleMapRow = {
  PASSID: number;
  BINCODELAST: string;
  TESTSITELAST: string;
};

/**
 * Fetch bin×DUT map from Oracle (INFCONTROL ⋈ INFLAYERMAP ⋈ INFLAYERBINLIST).
 * Without layer keys: all matching rows for the slot are merged (legacy VB loop).
 * With `testEnd` (+ optional keynumber / passNum): one INFLAYERBINLIST layer row only.
 */
export async function fetchSiteBinByLotFromOracle(params: {
  device: string;
  lot: string;
  slot: number;
  passIds: number[];
  /** JB 明细一行；与 passNum / testEnd 联用精确定位 INFLAYERBINLIST 行。 */
  keynumber?: number;
  passNum?: number;
  testEnd?: Date;
}): Promise<SiteBinByLotData> {
  const passIds = [...new Set(params.passIds)].sort((a, b) => a - b);
  if (passIds.length === 0) return { passes: [] };

  const passPlaceholders = passIds.map((_, i) => `:pass${i}`);
  const binds: Record<string, string | number | Date> = {
    device: params.device.trim(),
    lot: params.lot.trim(),
    slot: params.slot,
  };
  for (let i = 0; i < passIds.length; i++) {
    binds[`pass${i}`] = passIds[i]!;
  }

  const extraClauses: string[] = [];
  if (params.keynumber !== undefined && Number.isFinite(params.keynumber)) {
    extraClauses.push("  AND ic.KEYNUMBER = :keynumber");
    binds.keynumber = params.keynumber;
  }
  if (params.passNum !== undefined && Number.isFinite(params.passNum)) {
    extraClauses.push("  AND lb.PASSNUM = :passNum");
    binds.passNum = params.passNum;
  }
  if (params.testEnd !== undefined && !Number.isNaN(params.testEnd.getTime())) {
    extraClauses.push("  AND lb.TESTEND = :testEnd");
    binds.testEnd = params.testEnd;
  }

  const sql = `
SELECT
  lb.PASSID,
  lm.BINCODELAST,
  lb.TESTSITELAST
FROM INFCONTROL ic
INNER JOIN INFLAYERMAP lm
  ON ic.KEYNUMBER = lm.KEYNUMBER
INNER JOIN INFLAYERBINLIST lb
  ON lm.KEYNUMBER = lb.KEYNUMBER
 AND lm.PASSID = lb.PASSID
 AND lm.PASSNUM = lb.PASSNUM
WHERE UPPER(TRIM(ic.DEVICE)) = UPPER(:device)
  AND UPPER(TRIM(ic.LOT)) = UPPER(:lot)
  AND ic.SLOT = :slot
  AND lb.PASSID IN (${passPlaceholders.join(", ")})
  AND UPPER(TRIM(lb.PASSTYPE)) LIKE 'TEST%'
${extraClauses.join("\n")}
ORDER BY lb.PASSID, lb.PASSNUM
`.trim();

  const rows = await withConnection(async (conn) => {
    const r = await conn.execute<OracleMapRow>(sql, binds, {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
      fetchInfo: CLOB_AS_STRING,
    });
    return r.rows ?? [];
  });

  if (rows.length === 0) {
    throw new OracleMapFallbackNotFoundError(
      `No Oracle map rows for device=${params.device} lot=${params.lot} slot=${params.slot} passIds=[${passIds.join(", ")}]`
    );
  }

  const byPass = new Map<number, Map<string, number>>();
  for (const row of rows) {
    const passId = Number(row.PASSID);
    if (!Number.isInteger(passId)) continue;
    const binRaw = row.BINCODELAST != null ? String(row.BINCODELAST) : "";
    const siteRaw = row.TESTSITELAST != null ? String(row.TESTSITELAST) : "";
    if (!binRaw.trim() || !siteRaw.trim()) continue;
    const chunk = parseOracleBinSiteMap(binRaw, siteRaw);
    if (!byPass.has(passId)) byPass.set(passId, new Map());
    mergeBinSiteSummaries(byPass.get(passId)!, chunk);
  }

  const foundPassIds = new Set(byPass.keys());
  for (const pid of passIds) {
    if (!foundPassIds.has(pid)) {
      byPass.set(pid, new Map());
    }
  }

  return mergeBinSiteSummariesToSiteBinByLotData(byPass);
}

export async function infPathReadable(infPath: string): Promise<boolean> {
  try {
    await fs.promises.access(infPath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export type SiteBinWaferSource = "inf" | "oracle";

export type RunSiteBinWaferResult = {
  data: SiteBinByLotData;
  source: SiteBinWaferSource;
  /** Non-fatal notes (e.g. oracle fallback used). */
  notices: string[];
};
