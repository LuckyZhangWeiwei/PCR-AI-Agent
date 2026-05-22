// pcr-ai-api/src/lib/agent/agentManifest.ts
import { withConnection, withProbeWebConnection } from "../../oracle.js";
import oracledb from "oracledb";
import {
  yieldMonitorTriggersUseDummy,
  getYieldMonitorTriggerDummyRows,
} from "../yieldMonitorTriggerDummy.js";
import {
  infcontrolLayerBinsUseDummy,
  getInfcontrolLayerBinDummyRows,
} from "../infcontrolLayerBinDummy.js";

export interface DataManifest {
  fetchedAt: number;
  yield: {
    timeMin: string | null;
    timeMax: string | null;
    topDevices: Array<{ device: string; count: number }>;
  };
  jb: {
    timeMin: string | null;
    timeMax: string | null;
    topDevices: Array<{ device: string; count: number }>;
  };
}

const MANIFEST_TTL_MS = 60 * 60 * 1000; // 1 hour
let _cachedManifest: DataManifest | null = null;

function emptyDomain(): DataManifest["yield"] {
  return { timeMin: null, timeMax: null, topDevices: [] };
}

async function fetchYieldDomain(): Promise<DataManifest["yield"]> {
  if (yieldMonitorTriggersUseDummy()) {
    const rows = getYieldMonitorTriggerDummyRows().filter(
      (r) =>
        String(r.TYPE).trim().toUpperCase() === "DELTA_DIFF" &&
        !/^(kk|gg|c)/i.test(String(r.LOTID))
    );
    if (rows.length === 0) return emptyDomain();

    let timeMin: string | null = null;
    let timeMax: string | null = null;
    const devCount = new Map<string, number>();

    for (const r of rows) {
      if (r.TIME_STAMP) {
        if (timeMin === null || r.TIME_STAMP < timeMin) timeMin = r.TIME_STAMP;
        if (timeMax === null || r.TIME_STAMP > timeMax) timeMax = r.TIME_STAMP;
      }
      devCount.set(r.DEVICE, (devCount.get(r.DEVICE) ?? 0) + 1);
    }

    const topDevices = [...devCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([device, count]) => ({ device, count }));

    return { timeMin, timeMax, topDevices };
  }

  const timeRangeSql = `
    SELECT MIN(t.TIME_STAMP) AS ts_min, MAX(t.TIME_STAMP) AS ts_max
    FROM YMWEB_YIELDMONITORTRIGGER t
    WHERE UPPER(TRIM(t."TYPE")) = 'DELTA_DIFF'
      AND NOT REGEXP_LIKE(t.LOTID, '^(kk|gg|c)', 'i')
  `;
  const topDeviceSql = `
    SELECT t.DEVICE, COUNT(*) AS cnt
    FROM YMWEB_YIELDMONITORTRIGGER t
    WHERE UPPER(TRIM(t."TYPE")) = 'DELTA_DIFF'
      AND NOT REGEXP_LIKE(t.LOTID, '^(kk|gg|c)', 'i')
    GROUP BY t.DEVICE
    ORDER BY cnt DESC
    FETCH FIRST 10 ROWS ONLY
  `;

  return withProbeWebConnection(async (conn) => {
    const rangeResult = await conn.execute(timeRangeSql, {}, {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
    });
    const devResult = await conn.execute(topDeviceSql, {}, {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
    });
    const rangeRow =
      ((rangeResult.rows ?? []) as Record<string, unknown>[])[0] ?? {};
    const devRows = (devResult.rows ?? []) as Record<string, unknown>[];
    return {
      timeMin:
        rangeRow["TS_MIN"] != null
          ? String(rangeRow["TS_MIN"]).slice(0, 10)
          : null,
      timeMax:
        rangeRow["TS_MAX"] != null
          ? String(rangeRow["TS_MAX"]).slice(0, 10)
          : null,
      topDevices: devRows.map((r) => ({
        device: String(r["DEVICE"] ?? ""),
        count: Number(r["CNT"] ?? 0),
      })),
    };
  });
}

async function fetchJbDomain(): Promise<DataManifest["jb"]> {
  if (infcontrolLayerBinsUseDummy()) {
    const rows = getInfcontrolLayerBinDummyRows().filter((r) => {
      const pt = String(r.PASSTYPE).trim().toUpperCase();
      return (
        (pt === "TEST" || pt === "INTERRUPT") &&
        String(r.LAYERNAME ?? "").trim().toUpperCase() !== "ABANDONED" &&
        !/^(kk|gg|c)/i.test(String(r.LOT))
      );
    });
    if (rows.length === 0) return emptyDomain();

    let timeMin: string | null = null;
    let timeMax: string | null = null;
    const devCount = new Map<string, number>();

    for (const r of rows) {
      const te = String(r.TESTEND);
      if (te) {
        if (timeMin === null || te < timeMin) timeMin = te;
        if (timeMax === null || te > timeMax) timeMax = te;
      }
      const dev = String(r.DEVICE);
      devCount.set(dev, (devCount.get(dev) ?? 0) + 1);
    }

    const topDevices = [...devCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([device, count]) => ({ device, count }));

    return { timeMin, timeMax, topDevices };
  }

  const timeRangeSql = `
    SELECT MIN(t2.TESTEND) AS ts_min, MAX(t2.TESTEND) AS ts_max
    FROM INFCONTROL t1
    JOIN INFLAYERBINLIST t2 ON t1.KEYNUMBER = t2.KEYNUMBER
    WHERE UPPER(TRIM(t2.PASSTYPE)) IN ('TEST', 'INTERRUPT')
      AND UPPER(TRIM(t2.LAYERNAME)) <> 'ABANDONED'
      AND NOT REGEXP_LIKE(t1.LOT, '^(kk|gg|c)', 'i')
  `;
  const topDeviceSql = `
    SELECT t1.DEVICE, COUNT(*) AS cnt
    FROM INFCONTROL t1
    JOIN INFLAYERBINLIST t2 ON t1.KEYNUMBER = t2.KEYNUMBER
    WHERE UPPER(TRIM(t2.PASSTYPE)) IN ('TEST', 'INTERRUPT')
      AND UPPER(TRIM(t2.LAYERNAME)) <> 'ABANDONED'
      AND NOT REGEXP_LIKE(t1.LOT, '^(kk|gg|c)', 'i')
    GROUP BY t1.DEVICE
    ORDER BY cnt DESC
    FETCH FIRST 10 ROWS ONLY
  `;

  return withConnection(async (conn) => {
    const rangeResult = await conn.execute(timeRangeSql, {}, {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
    });
    const devResult = await conn.execute(topDeviceSql, {}, {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
    });
    const rangeRow =
      ((rangeResult.rows ?? []) as Record<string, unknown>[])[0] ?? {};
    const devRows = (devResult.rows ?? []) as Record<string, unknown>[];
    return {
      timeMin:
        rangeRow["TS_MIN"] != null
          ? String(rangeRow["TS_MIN"]).slice(0, 10)
          : null,
      timeMax:
        rangeRow["TS_MAX"] != null
          ? String(rangeRow["TS_MAX"]).slice(0, 10)
          : null,
      topDevices: devRows.map((r) => ({
        device: String(r["DEVICE"] ?? ""),
        count: Number(r["CNT"] ?? 0),
      })),
    };
  });
}

export function invalidateManifestCache(): void {
  _cachedManifest = null;
}

export async function fetchOrCacheManifest(): Promise<DataManifest> {
  if (
    _cachedManifest !== null &&
    Date.now() - _cachedManifest.fetchedAt < MANIFEST_TTL_MS
  ) {
    return _cachedManifest;
  }

  const [yieldDomain, jbDomain] = await Promise.all([
    fetchYieldDomain().catch(() => emptyDomain()),
    fetchJbDomain().catch(() => emptyDomain()),
  ]);

  const manifest: DataManifest = {
    fetchedAt: Date.now(),
    yield: yieldDomain,
    jb: jbDomain,
  };
  _cachedManifest = manifest;
  return manifest;
}
