/**
 * 真库探针：读取 INFLAYERBINLIST.TESTSITELAST（CLOB）样例 + INFCONTROL 几何字段。
 * 必须在能连 Oracle 的环境运行：
 *   cd pcr-ai-api && PCR_AI_LOCAL_DUMMY=false npx tsx scripts/probe-inf-oracle-fallback.ts
 * 可选参数：device lot slot passId
 *   npx tsx scripts/probe-inf-oracle-fallback.ts WA03P02G NF13664.1C 13 1
 */
import "../src/loadEnv.js";
import oracledb from "oracledb";
import { withConnection } from "../src/oracle.js";

oracledb.fetchAsString = [oracledb.CLOB];

const device = process.argv[2] ?? "WA03P02G";
const lot = process.argv[3] ?? "NF13664.1C";
const slot = Number(process.argv[4] ?? 13);
const passId = Number(process.argv[5] ?? 1);

async function probeColumnNames(): Promise<void> {
  for (const [label, where] of [
    ["INFLAYERBINLIST TEST%", "TABLE_NAME = 'INFLAYERBINLIST' AND COLUMN_NAME LIKE 'TEST%'"],
    ["INFLAYERBINLIST %LAST%", "TABLE_NAME = 'INFLAYERBINLIST' AND COLUMN_NAME LIKE '%LAST%'"],
    ["INFCONTROL map/bin", "TABLE_NAME = 'INFCONTROL' AND (COLUMN_NAME LIKE '%MAP%' OR COLUMN_NAME LIKE '%NOTCH%' OR COLUMN_NAME LIKE '%BIN%')"],
  ] as const) {
    const sql = `
SELECT COLUMN_NAME, DATA_TYPE, DATA_LENGTH
FROM ALL_TAB_COLUMNS
WHERE ${where}
ORDER BY COLUMN_NAME
`.trim();
    const rows = await withConnection(async (conn) => {
      const r = await conn.execute<{ COLUMN_NAME: string; DATA_TYPE: string; DATA_LENGTH: number }>(
        sql,
        {},
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      return r.rows ?? [];
    });
    console.log(`\n[ALL_TAB_COLUMNS ${label}]`);
    for (const row of rows) {
      console.log(`  ${row.COLUMN_NAME} ${row.DATA_TYPE}(${row.DATA_LENGTH})`);
    }
  }
  return;
}

async function probeSampleRow(): Promise<void> {
  const sql = `
SELECT
  ic.KEYNUMBER,
  ic.DEVICE,
  ic.LOT,
  ic.SLOT,
  ic.NOTCH,
  ic.MAPROWS,
  ic.MAPCOLS,
  lb.PASSID,
  lb.PASSNUM,
  lb.PASSTYPE,
  lb.PASSBIN,
  lb.GROSSDIE,
  lb.CARDID,
  lb.TESTEND,
  DBMS_LOB.GETLENGTH(lb.TESTSITELAST) AS SITE_LAST_LEN,
  DBMS_LOB.SUBSTR(lb.TESTSITELAST, 800, 1) AS SITE_LAST_HEAD
FROM INFCONTROL ic
INNER JOIN INFLAYERBINLIST lb ON ic.KEYNUMBER = lb.KEYNUMBER
WHERE UPPER(TRIM(ic.DEVICE)) = UPPER(:device)
  AND UPPER(TRIM(ic.LOT)) = UPPER(:lot)
  AND ic.SLOT = :slot
  AND lb.PASSID = :passId
  AND UPPER(TRIM(lb.PASSTYPE)) = 'TEST'
ORDER BY lb.TESTEND DESC NULLS LAST, lb.PASSNUM DESC NULLS LAST
FETCH FIRST 3 ROWS ONLY
`.trim();

  const rows = await withConnection(async (conn) => {
    const r = await conn.execute<Record<string, unknown>>(
      sql,
      { device, lot, slot, passId },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    return r.rows ?? [];
  });

  console.log(`\n[sample JOIN device=${device} lot=${lot} slot=${slot} passId=${passId}]`);
  console.log(`rowCount=${rows.length}`);
  for (const row of rows) {
    console.log(JSON.stringify(row, null, 2));
  }
}

async function probeNonNullSiteLastStats(): Promise<void> {
  const sql = `
SELECT
  COUNT(*) AS CNT,
  MIN(DBMS_LOB.GETLENGTH(lb.TESTSITELAST)) AS MIN_LEN,
  MAX(DBMS_LOB.GETLENGTH(lb.TESTSITELAST)) AS MAX_LEN,
  ROUND(AVG(DBMS_LOB.GETLENGTH(lb.TESTSITELAST))) AS AVG_LEN
FROM INFLAYERBINLIST lb
WHERE lb.TESTSITELAST IS NOT NULL
  AND DBMS_LOB.GETLENGTH(lb.TESTSITELAST) > 0
  AND UPPER(TRIM(lb.PASSTYPE)) = 'TEST'
`.trim();
  const rows = await withConnection(async (conn) => {
    const r = await conn.execute(sql, {}, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    return r.rows ?? [];
  });
  console.log("\n[TESTSITELAST population TEST rows]");
  console.log(JSON.stringify(rows[0], null, 2));
}

async function probeParseSiteLastMatrix(): Promise<void> {
  const sql = `
SELECT
  ic.MAPROWS,
  ic.MAPCOLS,
  lb.GROSSDIE,
  lb.TESTSITELAST AS SITE_LAST
FROM INFCONTROL ic
INNER JOIN INFLAYERBINLIST lb ON ic.KEYNUMBER = lb.KEYNUMBER
WHERE UPPER(TRIM(ic.DEVICE)) = UPPER(:device)
  AND UPPER(TRIM(ic.LOT)) = UPPER(:lot)
  AND ic.SLOT = :slot
  AND lb.PASSID = :passId
  AND UPPER(TRIM(lb.PASSTYPE)) = 'TEST'
ORDER BY lb.TESTEND DESC NULLS LAST, lb.PASSNUM DESC NULLS LAST
FETCH FIRST 1 ROWS ONLY
`.trim();

  const row = await withConnection(async (conn) => {
    const r = await conn.execute<{
      MAPROWS: number;
      MAPCOLS: number;
      GROSSDIE: number;
      SITE_LAST: string;
    }>(sql, { device, lot, slot, passId }, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    return r.rows?.[0];
  });
  if (!row?.SITE_LAST) {
    console.log("\n[parse TESTSITELAST] no row");
    return;
  }

  const lines = String(row.SITE_LAST).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const offPad = "__";
  const onPad = "@@";
  let testedDie = 0;
  const siteCounts = new Map<number, number>();
  for (const line of lines) {
    for (const tok of line.split(/\s+/)) {
      if (!tok || tok === offPad || tok === onPad) continue;
      testedDie++;
      const site = parseInt(tok, 16);
      if (Number.isFinite(site)) siteCounts.set(site, (siteCounts.get(site) ?? 0) + 1);
    }
  }
  const topSites = [...siteCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  console.log("\n[parse TESTSITELAST matrix — hex tokens, skip __/@@]");
  console.log(
    JSON.stringify(
      {
        mapRows: row.MAPROWS,
        mapCols: row.MAPCOLS,
        grossDie: row.GROSSDIE,
        rowDataLines: lines.length,
        parsedTestedDie: testedDie,
        distinctSites: siteCounts.size,
        topSites,
      },
      null,
      2
    )
  );
}

/** VB GetMultiWafers: parallel hex tokens from INFLAYERMAP.BINCODELAST + INFLAYERBINLIST.TESTSITELAST */
function parseBinSiteSummary(
  binCodeLast: string,
  testSiteLast: string,
  passBin: string
): {
  binSiteSummary: Map<string, number>;
  goodBins: Set<number>;
  grossDie: number;
  tokenMismatch: boolean;
} {
  const binTokens = binCodeLast.trim().split(/\s+/);
  const siteTokens = testSiteLast.trim().split(/\s+/);
  const goodBins = new Set(
    passBin
      .split("-")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => parseInt(s, 10))
      .filter((n) => Number.isFinite(n))
  );
  const binSiteSummary = new Map<string, number>();
  let grossDie = 0;
  const len = Math.min(binTokens.length, siteTokens.length);
  for (let i = 0; i < len; i++) {
    const bTok = binTokens[i]!;
    const sTok = siteTokens[i]!;
    if (bTok === "__" || bTok === "@@" || bTok === "" || sTok === "__" || sTok === "@@" || sTok === "") {
      continue;
    }
    const decBin = parseInt(bTok, 16);
    const decSite = parseInt(sTok, 16);
    if (!Number.isFinite(decBin) || !Number.isFinite(decSite)) continue;
    grossDie++;
    const key = `${decBin},${decSite}`;
    binSiteSummary.set(key, (binSiteSummary.get(key) ?? 0) + 1);
  }
  return {
    binSiteSummary,
    goodBins,
    grossDie,
    tokenMismatch: binTokens.length !== siteTokens.length,
  };
}

function binSiteSummaryToSiteBinPasses(
  passId: number,
  summary: Map<string, number>
): { passId: number; bins: { bin: string; duts: { dut: number; dieCount: number }[] }[] } {
  const binMap = new Map<number, Map<number, number>>();
  for (const [key, count] of summary) {
    const [binStr, siteStr] = key.split(",");
    const bin = Number(binStr);
    const site = Number(siteStr);
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

async function probeInLayerMapColumns(): Promise<void> {
  const sql = `
SELECT COLUMN_NAME, DATA_TYPE, DATA_LENGTH
FROM ALL_TAB_COLUMNS
WHERE TABLE_NAME = 'INFLAYERMAP'
ORDER BY COLUMN_ID
`.trim();
  const rows = await withConnection(async (conn) => {
    const r = await conn.execute<{ COLUMN_NAME: string; DATA_TYPE: string; DATA_LENGTH: number }>(
      sql,
      {},
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    return r.rows ?? [];
  });
  console.log("\n[ALL_TAB_COLUMNS INFLAYERMAP]");
  for (const row of rows) {
    console.log(`  ${row.COLUMN_NAME} ${row.DATA_TYPE}(${row.DATA_LENGTH})`);
  }
}

/** Mirrors VB SQL: InfControl ⋈ INFLAYERMAP ⋈ INFLAYERBINLIST on KEYNUMBER+PASSID+PASSNUM */
async function probeVbStyleJoin(): Promise<void> {
  const sql = `
SELECT
  ic.DEVICE,
  ic.LOT,
  ic.SLOT,
  ic.NOTCH,
  ic.MAPROWS,
  ic.MAPCOLS,
  lm.GOODDIE,
  lm.GROSSDIE,
  lb.PASSID,
  lb.PASSNUM,
  lb.PASSBIN,
  lb.PASSTYPE,
  DBMS_LOB.GETLENGTH(lm.BINCODELAST) AS BIN_LEN,
  DBMS_LOB.GETLENGTH(lb.TESTSITELAST) AS SITE_LEN,
  DBMS_LOB.SUBSTR(lm.BINCODELAST, 400, 1) AS BIN_HEAD,
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
  AND lb.PASSID = :passId
  AND UPPER(TRIM(lb.PASSTYPE)) LIKE 'TEST%'
ORDER BY lb.PASSID, lb.PASSNUM
`.trim();

  const rows = await withConnection(async (conn) => {
    const r = await conn.execute<{
      DEVICE: string;
      LOT: string;
      SLOT: number;
      NOTCH: number;
      MAPROWS: number;
      MAPCOLS: number;
      GOODDIE: number;
      GROSSDIE: number;
      PASSID: number;
      PASSNUM: number;
      PASSBIN: string;
      PASSTYPE: string;
      BIN_LEN: number;
      SITE_LEN: number;
      BIN_HEAD: string;
      BINCODELAST: string;
      TESTSITELAST: string;
    }>(sql, { device, lot, slot, passId }, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    return r.rows ?? [];
  });

  console.log(`\n[VB-style 3-table JOIN device=${device} lot=${lot} slot=${slot} passId=${passId}]`);
  console.log(`rowCount=${rows.length}`);
  if (rows.length === 0) {
    console.log("  (no rows — INFLAYERMAP join may be missing for this wafer/pass)");
    return;
  }

  const row = rows[0]!;
  console.log(
    JSON.stringify(
      {
        lot: row.LOT,
        slot: row.SLOT,
        passId: row.PASSID,
        passNum: row.PASSNUM,
        passBin: row.PASSBIN,
        passtype: row.PASSTYPE,
        goodDie: row.GOODDIE,
        grossDie: row.GROSSDIE,
        notch: row.NOTCH,
        mapRows: row.MAPROWS,
        mapCols: row.MAPCOLS,
        binLen: row.BIN_LEN,
        siteLen: row.SITE_LEN,
        binHead: row.BIN_HEAD,
      },
      null,
      2
    )
  );

  const parsed = parseBinSiteSummary(row.BINCODELAST, row.TESTSITELAST, row.PASSBIN);
  const siteBin = binSiteSummaryToSiteBinPasses(passId, parsed.binSiteSummary);
  const distinctBins = siteBin.bins.length;
  const distinctSites = new Set(
    [...parsed.binSiteSummary.keys()].map((k) => Number(k.split(",")[1]))
  ).size;

  console.log("\n[VB parse bin×site summary]");
  console.log(
    JSON.stringify(
      {
        parsedGrossDie: parsed.grossDie,
        oracleGrossDie: row.GROSSDIE,
        tokenMismatch: parsed.tokenMismatch,
        distinctBins,
        distinctSites,
        goodBins: [...parsed.goodBins].sort((a, b) => a - b),
        sampleBins: siteBin.bins.slice(0, 3),
      },
      null,
      2
    )
  );
}

async function probeBinCodeColumnsAnywhere(): Promise<void> {
  const sql = `
SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE
FROM ALL_TAB_COLUMNS
WHERE OWNER = USER
  AND (
    COLUMN_NAME LIKE '%BINCODE%'
    OR COLUMN_NAME LIKE '%BIN%LAST%'
    OR COLUMN_NAME LIKE '%TESTBIN%'
  )
ORDER BY TABLE_NAME, COLUMN_NAME
`.trim();
  const rows = await withConnection(async (conn) => {
    const r = await conn.execute<{ TABLE_NAME: string; COLUMN_NAME: string; DATA_TYPE: string }>(
      sql,
      {},
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    return r.rows ?? [];
  });
  console.log("\n[ALL_TAB_COLUMNS bin-map columns in schema]");
  for (const row of rows) {
    console.log(`  ${row.TABLE_NAME}.${row.COLUMN_NAME} ${row.DATA_TYPE}`);
  }
}

async function main(): Promise<void> {
  console.log("=== probe-inf-oracle-fallback.ts (direct Oracle) ===");
  await probeInLayerMapColumns();
  await probeColumnNames();
  await probeBinCodeColumnsAnywhere();
  await probeNonNullSiteLastStats();
  await probeVbStyleJoin();
  await probeSampleRow();
  await probeParseSiteLastMatrix();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
