// pcr-ai-api/src/lib/agent/agentFilterValuesTool.ts
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
import { probeCardTypeLeadingSegment } from "../probeCardTypeLeadingSegment.js";
import {
  deviceMatchesMask,
  deviceMaskOracleWhere,
  looksLikeDeviceMaskToken,
} from "../deviceMask.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

const YIELD_FIELDS = ["probeCard", "probeCardType", "hostname", "lotId", "device"] as const;
const JB_FIELDS = ["cardId", "probeCardType", "testerId", "lot", "device"] as const;

type YieldField = (typeof YIELD_FIELDS)[number];
type JbField = (typeof JB_FIELDS)[number];

interface FilterValuesResult {
  domain: "yield" | "jb";
  field: string;
  values: string[];
  totalDistinct: number;
  hint?: string;
}

function clampLimit(raw: unknown): number {
  const n = typeof raw === "number" ? raw : DEFAULT_LIMIT;
  return Math.min(Math.max(1, Math.round(n)), MAX_LIMIT);
}

function countDistinct(rawValues: string[], limit: number, search?: string): {
  values: string[];
  totalDistinct: number;
} {
  const searchUpper = search?.toUpperCase();
  const counts = new Map<string, number>();
  for (const v of rawValues) {
    if (!v) continue;
    if (searchUpper && !v.toUpperCase().includes(searchUpper)) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const values = sorted.slice(0, limit).map(([v, cnt]) => `${v} (${cnt}次)`);
  return { values, totalDistinct: counts.size };
}

// ─── device-by-mask shared helper ────────────────────────────────────────────

function resolveDeviceMaskArg(
  field: string,
  args: Record<string, unknown>,
  filterBy: Record<string, string | undefined>
): string | undefined {
  if (field !== "device") return filterBy["mask"];

  if (filterBy["mask"]) return filterBy["mask"];

  if (args["mask"] != null) {
    return String(args["mask"]).trim().toUpperCase();
  }

  if (filterBy["search"]) return filterBy["search"].toUpperCase();
  if (args["search"] != null) {
    return String(args["search"]).trim().toUpperCase();
  }

  const devCandidate =
    filterBy["device"] ??
    (args["device"] != null ? String(args["device"]).trim() : undefined);
  if (devCandidate && looksLikeDeviceMaskToken(devCandidate)) {
    return devCandidate.toUpperCase();
  }

  return undefined;
}

function dummyDeviceByMask(
  domain: "yield" | "jb",
  rows: { device: string; testEnd: string }[],
  mask: string | undefined,
  limit: number
): FilterValuesResult {
  if (!mask) {
    return { domain, field: "device", values: [], totalDistinct: 0 };
  }
  const maskUpper = mask.toUpperCase();
  const latest = new Map<string, string>();
  for (const { device, testEnd } of rows) {
    if (!device) continue;
    if (!deviceMatchesMask(device, maskUpper)) continue;
    const prev = latest.get(device);
    if (!prev || testEnd > prev) latest.set(device, testEnd);
  }
  // Sort by most-recent testEnd desc
  const sorted = [...latest.entries()].sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0));
  const values = sorted.slice(0, limit).map(([dev, te]) => te ? `${dev} (最近: ${te.slice(0, 10)})` : dev);
  return { domain, field: "device", values, totalDistinct: latest.size };
}

// ─── Dummy paths ─────────────────────────────────────────────────────────────

function dummyYield(
  field: YieldField,
  filterBy: Record<string, string | undefined>,
  limit: number
): FilterValuesResult {
  if (field === "device") {
    if (!filterBy["mask"]) {
      return {
        domain: "yield",
        field: "device",
        values: [],
        totalDistinct: 0,
        hint: 'field="device" 需要 filterBy.mask（如 "P02G"）或顶层 mask 参数',
      };
    }
    return dummyDeviceByMask("yield", getYieldMonitorTriggerDummyRows().map((r) => ({
      device: String(r.DEVICE ?? "").trim(),
      testEnd: String(r.TIME_STAMP ?? "").trim(),
    })), filterBy["mask"], limit);
  }

  const rows = getYieldMonitorTriggerDummyRows().filter((r) => {
    if (filterBy["device"] && String(r.DEVICE).trim() !== filterBy["device"]) return false;
    if (filterBy["probeCardType"]) {
      if (probeCardTypeLeadingSegment(r.PROBECARD) !== filterBy["probeCardType"]) return false;
    }
    return true;
  });

  const raw: string[] = rows.map((r) => {
    switch (field) {
      case "probeCard":     return String(r.PROBECARD).trim();
      case "probeCardType": return probeCardTypeLeadingSegment(r.PROBECARD) ?? "";
      case "hostname":      return String(r.HOSTNAME).trim();
      case "lotId":         return String(r.LOTID).trim();
    }
  });

  const { values, totalDistinct } = countDistinct(raw, limit, filterBy["search"]);
  return { domain: "yield", field, values, totalDistinct };
}

function dummyJb(
  field: JbField,
  filterBy: Record<string, string | undefined>,
  limit: number
): FilterValuesResult {
  if (field === "device") {
    if (!filterBy["mask"]) {
      return {
        domain: "jb",
        field: "device",
        values: [],
        totalDistinct: 0,
        hint: 'field="device" 需要 filterBy.mask（如 "P02G"）或顶层 mask 参数',
      };
    }
    const jbRows = getInfcontrolLayerBinDummyRows();
    return dummyDeviceByMask("jb", jbRows.map((r) => ({
      device: String(r.DEVICE ?? "").trim(),
      testEnd: String(r.TESTEND ?? "").trim(),
    })), filterBy["mask"], limit);
  }

  const rows = getInfcontrolLayerBinDummyRows().filter((r) => {
    const pt = String(r.PASSTYPE).trim().toUpperCase();
    if (pt !== "TEST" && pt !== "INTERRUPT") return false;
    if (String(r.LAYERNAME ?? "").trim().toUpperCase() === "ABANDONED") return false;
    if (filterBy["device"] && String(r.DEVICE).trim() !== filterBy["device"]) return false;
    if (filterBy["probeCardType"]) {
      if (probeCardTypeLeadingSegment(r.CARDID) !== filterBy["probeCardType"]) return false;
    }
    return true;
  });

  const raw: string[] = rows.map((r) => {
    switch (field) {
      case "cardId":        return String(r.CARDID).trim();
      case "probeCardType": return probeCardTypeLeadingSegment(r.CARDID) ?? "";
      case "testerId":      return String(r.TESTERID).trim();
      case "lot":           return String(r.LOT).trim();
    }
  });

  const { values, totalDistinct } = countDistinct(raw, limit, filterBy["search"]);
  return { domain: "jb", field, values, totalDistinct };
}

// ─── Oracle paths ─────────────────────────────────────────────────────────────

async function oracleYieldDeviceByMask(
  mask: string,
  limit: number
): Promise<FilterValuesResult> {
  const sql = `
    SELECT grp_key, last_test, COUNT(*) OVER () AS total_distinct
    FROM (
      SELECT t.DEVICE AS grp_key, MAX(t.TIME_STAMP) AS last_test
      FROM YMWEB_YIELDMONITORTRIGGER t
      WHERE UPPER(TRIM(t."TYPE")) = 'DELTA_DIFF'
        AND NOT REGEXP_LIKE(t.LOTID, '^(kk|gg|c)', 'i')
        AND ${deviceMaskOracleWhere("t.DEVICE", "mask")}
        AND t.DEVICE IS NOT NULL AND TRIM(t.DEVICE) != ''
      GROUP BY t.DEVICE
    )
    ORDER BY last_test DESC NULLS LAST
    FETCH FIRST :lim ROWS ONLY
  `;
  const rows = await withProbeWebConnection(async (conn) => {
    const r = await conn.execute(sql, { mask: mask.toUpperCase(), lim: limit }, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    return (r.rows ?? []) as Record<string, unknown>[];
  });
  const totalDistinct = rows.length > 0 ? Number(rows[0]!["TOTAL_DISTINCT"] ?? rows.length) : 0;
  const values = rows.map((r) => {
    const dev = String(r["GRP_KEY"] ?? "");
    const te = r["LAST_TEST"];
    const dateStr = te instanceof Date ? te.toISOString().slice(0, 10) : String(te ?? "").slice(0, 10);
    return dateStr ? `${dev} (最近: ${dateStr})` : dev;
  });
  return { domain: "yield", field: "device", values, totalDistinct };
}

async function oracleYield(
  field: YieldField,
  filterBy: Record<string, string | undefined>,
  limit: number
): Promise<FilterValuesResult> {
  if (field === "device") {
    const mask = filterBy["mask"] ?? "";
    if (!mask) {
      return {
        domain: "yield",
        field: "device",
        values: [],
        totalDistinct: 0,
        hint: 'field="device" 需要 filterBy.mask（如 "P02G"）或顶层 mask 参数',
      };
    }
    return oracleYieldDeviceByMask(mask, limit);
  }

  const conditions: string[] = [
    `UPPER(TRIM(t."TYPE")) = 'DELTA_DIFF'`,
    `NOT REGEXP_LIKE(t.LOTID, '^(kk|gg|c)', 'i')`,
  ];
  const binds: Record<string, string | number> = { lim: limit };

  if (filterBy["device"]) {
    conditions.push(`t.DEVICE = :device`);
    binds["device"] = filterBy["device"];
  }
  if (filterBy["probeCardType"]) {
    conditions.push(
      `NVL(REGEXP_SUBSTR(TRIM(t.PROBECARD), '^[^-]+', 1, 1), '') = :pct`
    );
    binds["pct"] = filterBy["probeCardType"];
  }

  const where = conditions.join(" AND ");

  let sql: string;
  if (field === "probeCardType") {
    const searchCond = filterBy["search"]
      ? `AND UPPER(sub.pct) LIKE '%' || UPPER(:search) || '%'`
      : "";
    if (filterBy["search"]) binds["search"] = filterBy["search"];
    sql = `
      SELECT grp_key, cnt, COUNT(*) OVER () AS total_distinct
      FROM (
        SELECT sub.pct AS grp_key, COUNT(*) AS cnt
        FROM (
          SELECT NVL(REGEXP_SUBSTR(TRIM(t.PROBECARD), '^[^-]+', 1, 1), '') AS pct
          FROM YMWEB_YIELDMONITORTRIGGER t
          WHERE ${where}
        ) sub
        WHERE sub.pct IS NOT NULL AND sub.pct != ''
        ${searchCond}
        GROUP BY sub.pct
      )
      ORDER BY cnt DESC
      FETCH FIRST :lim ROWS ONLY
    `;
  } else {
    const col = field === "probeCard" ? "t.PROBECARD"
      : field === "hostname" ? "t.HOSTNAME"
      : "t.LOTID";
    const searchCond = filterBy["search"]
      ? `AND UPPER(TRIM(${col})) LIKE '%' || UPPER(:search) || '%'`
      : "";
    if (filterBy["search"]) binds["search"] = filterBy["search"];
    sql = `
      SELECT grp_key, cnt, COUNT(*) OVER () AS total_distinct
      FROM (
        SELECT ${col} AS grp_key, COUNT(*) AS cnt
        FROM YMWEB_YIELDMONITORTRIGGER t
        WHERE ${where}
          AND ${col} IS NOT NULL AND TRIM(${col}) != ''
          ${searchCond}
        GROUP BY ${col}
      )
      ORDER BY cnt DESC
      FETCH FIRST :lim ROWS ONLY
    `;
  }

  const rows = await withProbeWebConnection(async (conn) => {
    const r = await conn.execute(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    return (r.rows ?? []) as Record<string, unknown>[];
  });

  const totalDistinct = rows.length > 0 ? Number(rows[0]!["TOTAL_DISTINCT"] ?? rows.length) : 0;
  const values = rows.map(
    (r) => `${String(r["GRP_KEY"] ?? "")} (${Number(r["CNT"] ?? 0)}次)`
  );
  return { domain: "yield", field, values, totalDistinct };
}

async function oracleJbDeviceByMask(
  mask: string,
  limit: number
): Promise<FilterValuesResult> {
  const sql = `
    SELECT grp_key, last_test, COUNT(*) OVER () AS total_distinct
    FROM (
      SELECT t1.DEVICE AS grp_key, MAX(t2.TESTEND) AS last_test
      FROM INFCONTROL t1
      JOIN INFLAYERBINLIST t2 ON t1.KEYNUMBER = t2.KEYNUMBER
      WHERE NOT REGEXP_LIKE(t1.LOT, '^(kk|gg|c)', 'i')
        AND ${deviceMaskOracleWhere("t1.DEVICE", "mask")}
        AND t1.DEVICE IS NOT NULL AND TRIM(t1.DEVICE) != ''
      GROUP BY t1.DEVICE
    )
    ORDER BY last_test DESC NULLS LAST
    FETCH FIRST :lim ROWS ONLY
  `;
  const rows = await withConnection(async (conn) => {
    const r = await conn.execute(sql, { mask: mask.toUpperCase(), lim: limit }, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    return (r.rows ?? []) as Record<string, unknown>[];
  });
  const totalDistinct = rows.length > 0 ? Number(rows[0]!["TOTAL_DISTINCT"] ?? rows.length) : 0;
  const values = rows.map((r) => {
    const dev = String(r["GRP_KEY"] ?? "");
    const te = r["LAST_TEST"];
    const dateStr = te instanceof Date ? te.toISOString().slice(0, 10) : String(te ?? "").slice(0, 10);
    return dateStr ? `${dev} (最近: ${dateStr})` : dev;
  });
  return { domain: "jb", field: "device", values, totalDistinct };
}

async function oracleJb(
  field: JbField,
  filterBy: Record<string, string | undefined>,
  limit: number
): Promise<FilterValuesResult> {
  if (field === "device") {
    const mask = filterBy["mask"] ?? "";
    if (!mask) {
      return {
        domain: "jb",
        field: "device",
        values: [],
        totalDistinct: 0,
        hint: 'field="device" 需要 filterBy.mask（如 "P02G"）或顶层 mask 参数',
      };
    }
    return oracleJbDeviceByMask(mask, limit);
  }

  const conditions: string[] = [
    `UPPER(TRIM(t2.PASSTYPE)) IN ('TEST', 'INTERRUPT')`,
    `UPPER(TRIM(t2.LAYERNAME)) <> 'ABANDONED'`,
    `NOT REGEXP_LIKE(t1.LOT, '^(kk|gg|c)', 'i')`,
  ];
  const binds: Record<string, string | number> = { lim: limit };

  if (filterBy["device"]) {
    conditions.push(`t1.DEVICE = :device`);
    binds["device"] = filterBy["device"];
  }
  if (filterBy["probeCardType"]) {
    conditions.push(
      `NVL(REGEXP_SUBSTR(TRIM(t1.CARDID), '^[^-]+', 1, 1), '') = :pct`
    );
    binds["pct"] = filterBy["probeCardType"];
  }

  const where = conditions.join(" AND ");
  const fromClause = `FROM INFCONTROL t1 JOIN INFLAYERBINLIST t2 ON t1.KEYNUMBER = t2.KEYNUMBER WHERE ${where}`;

  let sql: string;
  if (field === "probeCardType") {
    const searchCond = filterBy["search"]
      ? `AND UPPER(sub.pct) LIKE '%' || UPPER(:search) || '%'`
      : "";
    if (filterBy["search"]) binds["search"] = filterBy["search"];
    sql = `
      SELECT grp_key, cnt, COUNT(*) OVER () AS total_distinct
      FROM (
        SELECT sub.pct AS grp_key, COUNT(*) AS cnt
        FROM (
          SELECT NVL(REGEXP_SUBSTR(TRIM(t1.CARDID), '^[^-]+', 1, 1), '') AS pct
          ${fromClause}
        ) sub
        WHERE sub.pct IS NOT NULL AND sub.pct != ''
        ${searchCond}
        GROUP BY sub.pct
      )
      ORDER BY cnt DESC
      FETCH FIRST :lim ROWS ONLY
    `;
  } else {
    // TESTERID is on INFLAYERBINLIST (t2), not INFCONTROL (t1)
    const col = field === "cardId" ? "t1.CARDID"
      : field === "testerId" ? "t2.TESTERID"
      : "t1.LOT";
    const searchCond = filterBy["search"]
      ? `AND UPPER(TRIM(${col})) LIKE '%' || UPPER(:search) || '%'`
      : "";
    if (filterBy["search"]) binds["search"] = filterBy["search"];
    sql = `
      SELECT grp_key, cnt, COUNT(*) OVER () AS total_distinct
      FROM (
        SELECT ${col} AS grp_key, COUNT(*) AS cnt
        ${fromClause}
          AND ${col} IS NOT NULL AND TRIM(${col}) != ''
          ${searchCond}
        GROUP BY ${col}
      )
      ORDER BY cnt DESC
      FETCH FIRST :lim ROWS ONLY
    `;
  }

  const rows = await withConnection(async (conn) => {
    const r = await conn.execute(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    return (r.rows ?? []) as Record<string, unknown>[];
  });

  const totalDistinct = rows.length > 0 ? Number(rows[0]!["TOTAL_DISTINCT"] ?? rows.length) : 0;
  const values = rows.map(
    (r) => `${String(r["GRP_KEY"] ?? "")} (${Number(r["CNT"] ?? 0)}次)`
  );
  return { domain: "jb", field, values, totalDistinct };
}

// ─── Public entry point ───────────────────────────────────────────────────────

export async function runGetFilterValues(
  args: Record<string, unknown>
): Promise<string> {
  const domain = String(args["domain"] ?? "");
  const field = String(args["field"] ?? "");
  const limit = clampLimit(args["limit"]);

  // Safely coerce filterBy values to strings — LLM may pass numbers or nulls.
  const rawFilterBy = args["filterBy"];
  const filterBy: Record<string, string | undefined> = {};
  if (typeof rawFilterBy === "string" && rawFilterBy.trim() !== "") {
    filterBy["mask"] = rawFilterBy.trim().toUpperCase();
  } else if (rawFilterBy !== null && typeof rawFilterBy === "object") {
    const fb = rawFilterBy as Record<string, unknown>;
    if (fb["device"] != null) filterBy["device"] = String(fb["device"]);
    if (fb["probeCardType"] != null) filterBy["probeCardType"] = String(fb["probeCardType"]);
    if (fb["mask"] != null) filterBy["mask"] = String(fb["mask"]).trim().toUpperCase();
    if (fb["search"] != null) filterBy["search"] = String(fb["search"]).trim();
  }

  if (field === "device") {
    const resolvedMask = resolveDeviceMaskArg(field, args, filterBy);
    if (resolvedMask) {
      filterBy["mask"] = resolvedMask;
      delete filterBy["search"];
    }
  }

  if (domain === "yield") {
    if (!(YIELD_FIELDS as readonly string[]).includes(field)) {
      return `get_filter_values 错误: yield domain 不支持 field="${field}"。支持: ${YIELD_FIELDS.join(", ")}`;
    }
    try {
      const result = yieldMonitorTriggersUseDummy()
        ? dummyYield(field as YieldField, filterBy, limit)
        : await oracleYield(field as YieldField, filterBy, limit);
      return JSON.stringify(result);
    } catch (err) {
      return `get_filter_values 错误: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (domain === "jb") {
    if (!(JB_FIELDS as readonly string[]).includes(field)) {
      return `get_filter_values 错误: jb domain 不支持 field="${field}"。支持: ${JB_FIELDS.join(", ")}`;
    }
    try {
      const result = infcontrolLayerBinsUseDummy()
        ? dummyJb(field as JbField, filterBy, limit)
        : await oracleJb(field as JbField, filterBy, limit);
      return JSON.stringify(result);
    } catch (err) {
      return `get_filter_values 错误: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  return `get_filter_values 错误: domain 必须是 "yield" 或 "jb"，收到 "${domain}"`;
}
