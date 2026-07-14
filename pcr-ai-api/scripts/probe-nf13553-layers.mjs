import "../dist/loadEnv.js";
import { withConnection } from "../dist/oracle.js";
import oracledb from "oracledb";
import { fetchSiteBinByLotFromOracle, parseOracleBinSiteMap } from "../dist/lib/infOracleMapFallback.js";

const lot = "NF13553.1H";
const slot = 14;
const passId = 3;

const sql = `
SELECT lb.KEYNUMBER, lb.PASSID, lb.PASSNUM, lb.TESTEND, lb.GROSSDIE, lb.PASSTYPE,
  DBMS_LOB.GETLENGTH(lm.BINCODELAST) AS BIN_LEN,
  DBMS_LOB.GETLENGTH(lb.TESTSITELAST) AS SITE_LEN,
  lm.BINCODELAST,
  lb.TESTSITELAST
FROM INFCONTROL ic
INNER JOIN INFLAYERBINLIST lb ON ic.KEYNUMBER = lb.KEYNUMBER
LEFT JOIN INFLAYERMAP lm ON lm.KEYNUMBER = lb.KEYNUMBER AND lm.PASSID = lb.PASSID AND lm.PASSNUM = lb.PASSNUM
WHERE UPPER(TRIM(ic.LOT)) = UPPER(:lot) AND ic.SLOT = :slot AND lb.PASSID = :passId
  AND UPPER(TRIM(lb.PASSTYPE)) LIKE 'TEST%'
ORDER BY lb.TESTEND
`;

const rows = await withConnection(async (conn) => {
  const r = await conn.execute(
    sql,
    { lot, slot, passId },
    {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
      fetchInfo: { BINCODELAST: { type: oracledb.STRING }, TESTSITELAST: { type: oracledb.STRING } },
    }
  );
  return r.rows ?? [];
});

console.log("lb rows", rows.length);
for (const row of rows) {
  const bin = row.BINCODELAST ? String(row.BINCODELAST) : "";
  const site = row.TESTSITELAST ? String(row.TESTSITELAST) : "";
  const parsed = bin && site ? parseOracleBinSiteMap(bin, site) : new Map();
  let die = 0;
  for (const v of parsed.values()) die += v;
  console.log(
    JSON.stringify({
      KEYNUMBER: row.KEYNUMBER,
      PASSNUM: row.PASSNUM,
      TESTEND: row.TESTEND?.toISOString?.(),
      GROSSDIE: row.GROSSDIE,
      BIN_LEN: row.BIN_LEN,
      SITE_LEN: row.SITE_LEN,
      parsedDie: die,
      hasLmBin: Boolean(row.BIN_LEN),
    })
  );
}

for (const row of rows) {
  const data = await fetchSiteBinByLotFromOracle({
    device: "WA20N65N",
    lot,
    slot,
    passIds: [passId],
    keynumber: Number(row.KEYNUMBER),
    passNum: Number(row.PASSNUM),
    testEnd: row.TESTEND,
  });
  const p = data.passes.find((x) => x.passId === passId);
  const die = (p?.bins ?? []).reduce(
    (s, b) => s + b.duts.reduce((t, d) => t + d.dieCount, 0),
    0
  );
  console.log("fetchSiteBin", row.TESTEND?.toISOString?.(), "die", die);
}

process.exit(0);
