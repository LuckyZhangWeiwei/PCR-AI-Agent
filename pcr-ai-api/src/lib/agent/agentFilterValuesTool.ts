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

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

const YIELD_FIELDS = ["probeCard", "probeCardType", "hostname", "lotId"] as const;
const JB_FIELDS = ["cardId", "probeCardType", "testerId", "lot"] as const;

type YieldField = (typeof YIELD_FIELDS)[number];
type JbField = (typeof JB_FIELDS)[number];

interface FilterValuesResult {
  domain: "yield" | "jb";
  field: string;
  values: string[];
  totalDistinct: number;
}

function clampLimit(raw: unknown): number {
  const n = typeof raw === "number" ? raw : DEFAULT_LIMIT;
  return Math.min(Math.max(1, Math.round(n)), MAX_LIMIT);
}

function countDistinct(rawValues: string[], limit: number): {
  values: string[];
  totalDistinct: number;
} {
  const counts = new Map<string, number>();
  for (const v of rawValues) {
    if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const values = sorted.slice(0, limit).map(([v, cnt]) => `${v} (${cnt}次)`);
  return { values, totalDistinct: counts.size };
}

// ─── Dummy paths ─────────────────────────────────────────────────────────────

function dummyYield(
  field: YieldField,
  filterBy: Record<string, string | undefined>,
  limit: number
): FilterValuesResult {
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

  const { values, totalDistinct } = countDistinct(raw, limit);
  return { domain: "yield", field, values, totalDistinct };
}

function dummyJb(
  field: JbField,
  filterBy: Record<string, string | undefined>,
  limit: number
): FilterValuesResult {
  const rows = getInfcontrolLayerBinDummyRows().filter((r) => {
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

  const { values, totalDistinct } = countDistinct(raw, limit);
  return { domain: "jb", field, values, totalDistinct };
}

// ─── Oracle paths ─────────────────────────────────────────────────────────────

async function oracleYield(
  field: YieldField,
  filterBy: Record<string, string | undefined>,
  limit: number
): Promise<FilterValuesResult> {
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
    sql = `
      SELECT sub.pct AS grp_key, COUNT(*) AS cnt
      FROM (
        SELECT NVL(REGEXP_SUBSTR(TRIM(t.PROBECARD), '^[^-]+', 1, 1), '') AS pct
        FROM YMWEB_YIELDMONITORTRIGGER t
        WHERE ${where}
      ) sub
      WHERE sub.pct IS NOT NULL AND sub.pct != ''
      GROUP BY sub.pct
      ORDER BY cnt DESC
      FETCH FIRST :lim ROWS ONLY
    `;
  } else {
    const col = field === "probeCard" ? "t.PROBECARD"
      : field === "hostname" ? "t.HOSTNAME"
      : "t.LOTID";
    sql = `
      SELECT ${col} AS grp_key, COUNT(*) AS cnt
      FROM YMWEB_YIELDMONITORTRIGGER t
      WHERE ${where}
        AND ${col} IS NOT NULL AND TRIM(${col}) != ''
      GROUP BY ${col}
      ORDER BY cnt DESC
      FETCH FIRST :lim ROWS ONLY
    `;
  }

  const rows = await withProbeWebConnection(async (conn) => {
    const r = await conn.execute(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    return (r.rows ?? []) as Record<string, unknown>[];
  });

  const values = rows.map(
    (r) => `${String(r["GRP_KEY"] ?? "")} (${Number(r["CNT"] ?? 0)}次)`
  );
  return { domain: "yield", field, values, totalDistinct: rows.length };
}

async function oracleJb(
  field: JbField,
  filterBy: Record<string, string | undefined>,
  limit: number
): Promise<FilterValuesResult> {
  const conditions: string[] = [
    `t2.PASSTYPE = 'TEST'`,
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
  const fromClause = `FROM INFCONTROL t1 JOIN INFLAYERBINLIST t2 ON t1.ID = t2.INFCONTROLID WHERE ${where}`;

  let sql: string;
  if (field === "probeCardType") {
    sql = `
      SELECT sub.pct AS grp_key, COUNT(*) AS cnt
      FROM (
        SELECT NVL(REGEXP_SUBSTR(TRIM(t1.CARDID), '^[^-]+', 1, 1), '') AS pct
        ${fromClause}
      ) sub
      WHERE sub.pct IS NOT NULL AND sub.pct != ''
      GROUP BY sub.pct
      ORDER BY cnt DESC
      FETCH FIRST :lim ROWS ONLY
    `;
  } else {
    const col = field === "cardId" ? "t1.CARDID"
      : field === "testerId" ? "t1.TESTERID"
      : "t1.LOT";
    sql = `
      SELECT ${col} AS grp_key, COUNT(*) AS cnt
      ${fromClause}
        AND ${col} IS NOT NULL AND TRIM(${col}) != ''
      GROUP BY ${col}
      ORDER BY cnt DESC
      FETCH FIRST :lim ROWS ONLY
    `;
  }

  const rows = await withConnection(async (conn) => {
    const r = await conn.execute(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    return (r.rows ?? []) as Record<string, unknown>[];
  });

  const values = rows.map(
    (r) => `${String(r["GRP_KEY"] ?? "")} (${Number(r["CNT"] ?? 0)}次)`
  );
  return { domain: "jb", field, values, totalDistinct: rows.length };
}

// ─── Public entry point ───────────────────────────────────────────────────────

export async function runGetFilterValues(
  args: Record<string, unknown>
): Promise<string> {
  const domain = String(args["domain"] ?? "");
  const field = String(args["field"] ?? "");
  const filterBy = (args["filterBy"] as Record<string, string> | undefined) ?? {};
  const limit = clampLimit(args["limit"]);

  if (domain === "yield") {
    if (!(YIELD_FIELDS as readonly string[]).includes(field)) {
      return `get_filter_values 错误: yield domain 不支持 field="${field}"。支持: ${YIELD_FIELDS.join(", ")}`;
    }
    const result = yieldMonitorTriggersUseDummy()
      ? dummyYield(field as YieldField, filterBy, limit)
      : await oracleYield(field as YieldField, filterBy, limit);
    return JSON.stringify(result);
  }

  if (domain === "jb") {
    if (!(JB_FIELDS as readonly string[]).includes(field)) {
      return `get_filter_values 错误: jb domain 不支持 field="${field}"。支持: ${JB_FIELDS.join(", ")}`;
    }
    const result = infcontrolLayerBinsUseDummy()
      ? dummyJb(field as JbField, filterBy, limit)
      : await oracleJb(field as JbField, filterBy, limit);
    return JSON.stringify(result);
  }

  return `get_filter_values 错误: domain 必须是 "yield" 或 "jb"，收到 "${domain}"`;
}
