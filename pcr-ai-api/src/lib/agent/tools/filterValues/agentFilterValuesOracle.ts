// pcr-ai-api/src/lib/agent/tools/filterValues/agentFilterValuesOracle.ts
//
// Oracle-backed get_filter_values lookups for the generic (non-device-mask) fields:
// yield (probeCard/probeCardType/hostname/lotId) and jb (cardId/probeCardType/
// testerId/lot). field="device" delegates to agentFilterValuesDeviceMask.ts.
import { withConnection, withProbeWebConnection } from "../../../../oracle.js";
import oracledb from "oracledb";
import { oracleNonEmptyTrimmedColumn } from "../../../oracleStringSql.js";
import { infcontrolLayerBinV3PasstypeOracleIn } from "../../../infcontrolLayerBinPasstypeScope.js";
import { logAgentSql } from "../../agentSqlDebugLog.js";
import {
  type FilterValuesResult,
  type YieldField,
  type JbField,
  oracleYieldDeviceByMask,
  oracleJbDeviceByMask,
} from "./agentFilterValuesDeviceMask.js";

function buildYieldFilterValuesSql(
  field: YieldField,
  where: string,
  binds: Record<string, string | number>,
  filterBy: Record<string, string | undefined>
): string {
  if (field === "probeCardType") {
    const searchCond = filterBy["search"]
      ? `AND UPPER(sub.pct) LIKE '%' || UPPER(:search) || '%'`
      : "";
    if (filterBy["search"]) binds["search"] = filterBy["search"];
    return `
      SELECT grp_key, cnt, COUNT(*) OVER () AS total_distinct
      FROM (
        SELECT sub.pct AS grp_key, COUNT(*) AS cnt
        FROM (
          SELECT NVL(REGEXP_SUBSTR(TRIM(t.PROBECARD), '^[^-]+', 1, 1), '') AS pct
          FROM YMWEB_YIELDMONITORTRIGGER t
          WHERE ${where}
        ) sub
        WHERE ${oracleNonEmptyTrimmedColumn("sub.pct")}
        ${searchCond}
        GROUP BY sub.pct
      )
      ORDER BY cnt DESC
      FETCH FIRST :lim ROWS ONLY
    `;
  }
  const col = field === "probeCard" ? "t.PROBECARD"
    : field === "hostname" ? "t.HOSTNAME"
    : "t.LOTID";
  const searchCond = filterBy["search"]
    ? `AND UPPER(TRIM(${col})) LIKE '%' || UPPER(:search) || '%'`
    : "";
  if (filterBy["search"]) binds["search"] = filterBy["search"];
  return `
    SELECT grp_key, cnt, COUNT(*) OVER () AS total_distinct
    FROM (
      SELECT ${col} AS grp_key, COUNT(*) AS cnt
      FROM YMWEB_YIELDMONITORTRIGGER t
      WHERE ${where}
        AND ${oracleNonEmptyTrimmedColumn(col)}
        ${searchCond}
      GROUP BY ${col}
    )
    ORDER BY cnt DESC
    FETCH FIRST :lim ROWS ONLY
  `;
}

export async function oracleYield(
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
  const sql = buildYieldFilterValuesSql(field, where, binds, filterBy);

  logAgentSql(`filterValues:yield:${field}`, sql, binds, {
    probeCardType: filterBy["probeCardType"],
    device: filterBy["device"],
    search: filterBy["search"],
  });
  const rows = await withProbeWebConnection(async (conn) => {
    const r = await conn.execute(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    return (r.rows ?? []) as Record<string, unknown>[];
  });
  logAgentSql(`filterValues:yield:${field}:result`, "(rows returned)", binds, {
    rowCount: rows.length,
  });

  const totalDistinct = rows.length > 0 ? Number(rows[0]!["TOTAL_DISTINCT"] ?? rows.length) : 0;
  const values = rows.map(
    (r) => `${String(r["GRP_KEY"] ?? "")} (${Number(r["CNT"] ?? 0)}次)`
  );
  return { domain: "yield", field, values, totalDistinct };
}

function buildJbFilterValuesSql(
  field: JbField,
  fromClause: string,
  binds: Record<string, string | number>,
  filterBy: Record<string, string | undefined>
): string {
  if (field === "probeCardType") {
    const searchCond = filterBy["search"]
      ? `AND UPPER(sub.pct) LIKE '%' || UPPER(:search) || '%'`
      : "";
    if (filterBy["search"]) binds["search"] = filterBy["search"];
    return `
      SELECT grp_key, cnt, COUNT(*) OVER () AS total_distinct
      FROM (
        SELECT sub.pct AS grp_key, COUNT(*) AS cnt
        FROM (
          SELECT NVL(REGEXP_SUBSTR(TRIM(t2.CARDID), '^[^-]+', 1, 1), '') AS pct
          ${fromClause}
        ) sub
        WHERE ${oracleNonEmptyTrimmedColumn("sub.pct")}
        ${searchCond}
        GROUP BY sub.pct
      )
      ORDER BY cnt DESC
      FETCH FIRST :lim ROWS ONLY
    `;
  }
  // CARDID and TESTERID are both on INFLAYERBINLIST (t2), not INFCONTROL (t1)
  const col = field === "cardId" ? "t2.CARDID"
    : field === "testerId" ? "t2.TESTERID"
    : "t1.LOT";
  const searchCond = filterBy["search"]
    ? `AND UPPER(TRIM(${col})) LIKE '%' || UPPER(:search) || '%'`
    : "";
  if (filterBy["search"]) binds["search"] = filterBy["search"];
  return `
    SELECT grp_key, cnt, COUNT(*) OVER () AS total_distinct
    FROM (
      SELECT ${col} AS grp_key, COUNT(*) AS cnt
      ${fromClause}
        AND ${oracleNonEmptyTrimmedColumn(col)}
        ${searchCond}
      GROUP BY ${col}
    )
    ORDER BY cnt DESC
    FETCH FIRST :lim ROWS ONLY
  `;
}

export async function oracleJb(
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
    infcontrolLayerBinV3PasstypeOracleIn("t2"),
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
      `NVL(REGEXP_SUBSTR(TRIM(t2.CARDID), '^[^-]+', 1, 1), '') = :pct`
    );
    binds["pct"] = filterBy["probeCardType"];
  }

  const where = conditions.join(" AND ");
  const fromClause = `FROM INFCONTROL t1 JOIN INFLAYERBINLIST t2 ON t1.KEYNUMBER = t2.KEYNUMBER WHERE ${where}`;
  const sql = buildJbFilterValuesSql(field, fromClause, binds, filterBy);

  logAgentSql(`filterValues:jb:${field}`, sql, binds, {
    probeCardType: filterBy["probeCardType"],
    device: filterBy["device"],
    search: filterBy["search"],
  });
  const rows = await withConnection(async (conn) => {
    const r = await conn.execute(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    return (r.rows ?? []) as Record<string, unknown>[];
  });
  logAgentSql(`filterValues:jb:${field}:result`, "(rows returned)", binds, {
    rowCount: rows.length,
  });

  const totalDistinct = rows.length > 0 ? Number(rows[0]!["TOTAL_DISTINCT"] ?? rows.length) : 0;
  const values = rows.map(
    (r) => `${String(r["GRP_KEY"] ?? "")} (${Number(r["CNT"] ?? 0)}次)`
  );
  return { domain: "jb", field, values, totalDistinct };
}
