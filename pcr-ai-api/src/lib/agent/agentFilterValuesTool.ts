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
import { logAgentSql } from "./agentSqlDebugLog.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const DEVICE_MASK_DEFAULT_LIMIT = 20;

const YIELD_FIELDS = ["probeCard", "probeCardType", "hostname", "lotId", "device"] as const;
const JB_FIELDS = ["cardId", "probeCardType", "testerId", "lot", "device"] as const;

type YieldField = (typeof YIELD_FIELDS)[number];
type JbField = (typeof JB_FIELDS)[number];

interface FilterValuesResult {
  domain: "yield" | "jb" | "both";
  field: string;
  values: string[];
  totalDistinct: number;
  hint?: string;
  suggestedSearchTerms?: string[];
  /** field=device + mask 时：跨域合并的完整 device 列表（含各域最近日期） */
  devices?: DeviceByMaskEntry[];
  note?: string;
}

interface DeviceByMaskEntry {
  device: string;
  lastYield: string | null;
  lastJb: string | null;
  lastOverall: string | null;
}

function clampDeviceMaskLimit(raw: unknown): number {
  const n = typeof raw === "number" ? raw : DEVICE_MASK_DEFAULT_LIMIT;
  return Math.min(Math.max(1, Math.round(n)), MAX_LIMIT);
}

function dateKey(raw: string | null | undefined): string | null {
  const s = String(raw ?? "").trim();
  return s.length >= 10 ? s.slice(0, 10) : s || null;
}

function maxDateKey(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}

function formatDeviceByMaskValue(entry: DeviceByMaskEntry): string {
  const parts: string[] = [];
  if (entry.lastYield) parts.push(`Yield: ${entry.lastYield}`);
  if (entry.lastJb) parts.push(`JB: ${entry.lastJb}`);
  return parts.length > 0
    ? `${entry.device} (${parts.join(", ")})`
    : entry.device;
}

function buildMultiDeviceNote(mask: string, total: number): string | undefined {
  if (total <= 1) return undefined;
  return (
    `mask ${mask} 对应 ${total} 个完整 device 代码；` +
    `后续查询请用 mask=${mask}（query_yield_triggers / query_jb_bins），` +
    `或分别查每个 device，禁止只查其中一个就下结论`
  );
}

function mergeDeviceByMaskMaps(
  mask: string,
  yieldLatest: Map<string, string>,
  jbLatest: Map<string, string>,
  limit: number
): FilterValuesResult {
  const codes = new Set([...yieldLatest.keys(), ...jbLatest.keys()]);
  const entries: DeviceByMaskEntry[] = [...codes].map((device) => {
    const lastYield = dateKey(yieldLatest.get(device));
    const lastJb = dateKey(jbLatest.get(device));
    return {
      device,
      lastYield,
      lastJb,
      lastOverall: maxDateKey(lastYield, lastJb),
    };
  });
  entries.sort((a, b) => {
    const ao = a.lastOverall ?? "";
    const bo = b.lastOverall ?? "";
    if (bo > ao) return 1;
    if (bo < ao) return -1;
    return a.device.localeCompare(b.device);
  });
  const totalDistinct = entries.length;
  const sliced = entries.slice(0, limit);
  return {
    domain: "both",
    field: "device",
    values: sliced.map(formatDeviceByMaskValue),
    totalDistinct,
    devices: sliced,
    note: buildMultiDeviceNote(mask, totalDistinct),
  };
}

function collectDeviceByMaskMaps(
  yieldRows: { device: string; testEnd: string }[],
  jbRows: { device: string; testEnd: string }[],
  mask: string
): { yieldLatest: Map<string, string>; jbLatest: Map<string, string> } {
  const maskUpper = mask.toUpperCase();
  const yieldLatest = new Map<string, string>();
  const jbLatest = new Map<string, string>();
  for (const { device, testEnd } of yieldRows) {
    if (!device || !deviceMatchesMask(device, maskUpper)) continue;
    const prev = yieldLatest.get(device);
    if (!prev || testEnd > prev) yieldLatest.set(device, testEnd);
  }
  for (const { device, testEnd } of jbRows) {
    if (!device || !deviceMatchesMask(device, maskUpper)) continue;
    const prev = jbLatest.get(device);
    if (!prev || testEnd > prev) jbLatest.set(device, testEnd);
  }
  return { yieldLatest, jbLatest };
}

function dummyDeviceByMaskBoth(
  mask: string | undefined,
  limit: number
): FilterValuesResult {
  if (!mask) {
    return {
      domain: "both",
      field: "device",
      values: [],
      totalDistinct: 0,
      hint: 'field="device" 需要 filterBy.mask（如 "N84R"）或顶层 mask 参数',
    };
  }
  const { yieldLatest, jbLatest } = collectDeviceByMaskMaps(
    getYieldMonitorTriggerDummyRows().map((r) => ({
      device: String(r.DEVICE ?? "").trim(),
      testEnd: String(r.TIME_STAMP ?? "").trim(),
    })),
    getInfcontrolLayerBinDummyRows().map((r) => ({
      device: String(r.DEVICE ?? "").trim(),
      testEnd: String(r.TESTEND ?? "").trim(),
    })),
    mask
  );
  return mergeDeviceByMaskMaps(mask, yieldLatest, jbLatest, limit);
}

async function oracleDeviceByMaskBoth(
  mask: string,
  limit: number
): Promise<FilterValuesResult> {
  const fetchLimit = MAX_LIMIT;
  const [yieldData, jbData] = await Promise.all([
    oracleYieldDeviceByMaskMap(mask, fetchLimit),
    oracleJbDeviceByMaskMap(mask, fetchLimit),
  ]);
  const merged = mergeDeviceByMaskMaps(mask, yieldData.latest, jbData.latest, limit);
  merged.totalDistinct = Math.max(
    merged.totalDistinct,
    yieldData.totalDistinct,
    jbData.totalDistinct
  );
  if (merged.totalDistinct > merged.values.length) {
    merged.note =
      (merged.note ? `${merged.note}；` : "") +
      `共 ${merged.totalDistinct} 个 device，已展示最近 ${merged.values.length} 个`;
  }
  return merged;
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

/** 机台 search 无命中时尝试 uflex24 → flex24 / b3uflex24 等变体。 */
function expandTesterSearchTerms(search: string): string[] {
  const normalized = search.trim().toLowerCase().replace(/\s+/g, "");
  const terms = new Set<string>([search.trim(), normalized]);
  const uflex = normalized.match(/uflex(\d+)/);
  if (uflex) {
    terms.add(`flex${uflex[1]}`);
    terms.add(`b3uflex${uflex[1]}`);
    terms.add(`b3uflex${uflex[1]!.padStart(2, "0")}`);
  }
  const flexOnly = normalized.match(/^flex(\d+)$/);
  if (flexOnly) {
    terms.add(`b3uflex${flexOnly[1]}`);
    terms.add(`uflex${flexOnly[1]}`);
  }
  if (normalized.startsWith("b3")) terms.add(normalized.slice(2));
  return [...terms];
}

function countDistinctWithSearchFallback(
  rawValues: string[],
  limit: number,
  search?: string
): { values: string[]; totalDistinct: number } {
  const first = countDistinct(rawValues, limit, search);
  if (first.totalDistinct > 0 || !search?.trim()) return first;
  for (const alt of expandTesterSearchTerms(search)) {
    if (alt.toUpperCase() === search.trim().toUpperCase()) continue;
    const retry = countDistinct(rawValues, limit, alt);
    if (retry.totalDistinct > 0) return retry;
  }
  return first;
}

function enrichEmptyTesterSearchResult(
  result: FilterValuesResult,
  field: string,
  search?: string
): FilterValuesResult {
  if (result.totalDistinct > 0 || !search?.trim()) return result;
  if (field !== "hostname" && field !== "testerId") return result;
  const suggestions = expandTesterSearchTerms(search).filter(
    (t) => t.toUpperCase() !== search.trim().toUpperCase()
  );
  return {
    ...result,
    hint:
      "filter 索引未命中不代表无机台/无 lot 数据；若用户句中已有 device+机台（如 b3uflex24），" +
      "请直接 query_jb_bins(testerId) / query_yield_triggers(hostname)，禁止据此报告「未找到机台」。",
    suggestedSearchTerms: suggestions.slice(0, 6),
  };
}

/**
 * cardId / probeCard 按 probeCardType 枚举返回空时，附 hint：filter 索引未命中不等于
 * 该型号无测试记录（CARDID 前缀格式差异常致空命中）。禁止据此回答「型号无记录/无法对比」。
 */
function enrichEmptyCardEnumResult(
  result: FilterValuesResult,
  field: string,
  filterBy: Record<string, string | undefined>
): FilterValuesResult {
  if (result.totalDistinct > 0) return result;
  if (field !== "cardId" && field !== "probeCard") return result;
  const pct = filterBy["probeCardType"]?.trim();
  if (!pct) return result;
  const aggHint =
    result.domain === "yield"
      ? `query_yield_triggers(probeCard:"<完整卡号>")`
      : `aggregate_jb_bins(probeCardType:"${pct}", groupBy:"bin,cardId", groupTop:50)`;
  return {
    ...result,
    hint:
      `未按 probeCardType="${pct}" 枚举到具体卡号；filter 索引未命中并不代表该型号无测试记录或未投入使用` +
      `（CARDID/PROBECARD 前缀提取格式差异常致空命中）。` +
      `请改用已知的完整卡号直接查询（query_jb_bins(cardId) / query_yield_triggers(probeCard)），` +
      `或用 ${aggHint} 在库内按 CARDID 枚举该型号下各卡再横向对比。` +
      `禁止据此回答「型号无记录 / 无法对比」。`,
  };
}

async function oracleYieldWithSearchFallback(
  field: YieldField,
  filterBy: Record<string, string | undefined>,
  limit: number
): Promise<FilterValuesResult> {
  let result = await oracleYield(field, filterBy, limit);
  if (result.totalDistinct > 0 || !filterBy["search"] || field !== "hostname") {
    return result;
  }
  for (const alt of expandTesterSearchTerms(filterBy["search"])) {
    if (alt.toUpperCase() === filterBy["search"]!.toUpperCase()) continue;
    result = await oracleYield(field, { ...filterBy, search: alt }, limit);
    if (result.totalDistinct > 0) return result;
  }
  return result;
}

async function oracleJbWithSearchFallback(
  field: JbField,
  filterBy: Record<string, string | undefined>,
  limit: number
): Promise<FilterValuesResult> {
  let result = await oracleJb(field, filterBy, limit);
  if (result.totalDistinct > 0 || !filterBy["search"] || field !== "testerId") {
    return result;
  }
  for (const alt of expandTesterSearchTerms(filterBy["search"])) {
    if (alt.toUpperCase() === filterBy["search"]!.toUpperCase()) continue;
    result = await oracleJb(field, { ...filterBy, search: alt }, limit);
    if (result.totalDistinct > 0) return result;
  }
  return result;
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

  const useSearchFallback = field === "hostname";
  const { values, totalDistinct } = useSearchFallback
    ? countDistinctWithSearchFallback(raw, limit, filterBy["search"])
    : countDistinct(raw, limit, filterBy["search"]);
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

  const useSearchFallback = field === "testerId";
  const { values, totalDistinct } = useSearchFallback
    ? countDistinctWithSearchFallback(raw, limit, filterBy["search"])
    : countDistinct(raw, limit, filterBy["search"]);
  return { domain: "jb", field, values, totalDistinct };
}

// ─── Oracle paths ─────────────────────────────────────────────────────────────

function formatOracleLastTest(te: unknown): string {
  return te instanceof Date ? te.toISOString().slice(0, 10) : String(te ?? "").slice(0, 10);
}

async function oracleYieldDeviceByMaskMap(
  mask: string,
  limit: number
): Promise<{ latest: Map<string, string>; totalDistinct: number }> {
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
  const binds = { mask: mask.toUpperCase(), lim: limit };
  logAgentSql("filterValues:yieldDeviceByMask", sql, binds);
  const rows = await withProbeWebConnection(async (conn) => {
    const r = await conn.execute(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    return (r.rows ?? []) as Record<string, unknown>[];
  });
  logAgentSql("filterValues:yieldDeviceByMask:result", "(rows returned)", binds, {
    rowCount: rows.length,
  });
  const totalDistinct = rows.length > 0 ? Number(rows[0]!["TOTAL_DISTINCT"] ?? rows.length) : 0;
  const latest = new Map<string, string>();
  for (const row of rows) {
    const dev = String(row["GRP_KEY"] ?? "").trim();
    if (!dev) continue;
    latest.set(dev, formatOracleLastTest(row["LAST_TEST"]));
  }
  return { latest, totalDistinct };
}

async function oracleJbDeviceByMaskMap(
  mask: string,
  limit: number
): Promise<{ latest: Map<string, string>; totalDistinct: number }> {
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
  const binds = { mask: mask.toUpperCase(), lim: limit };
  logAgentSql("filterValues:jbDeviceByMask", sql, binds);
  const rows = await withConnection(async (conn) => {
    const r = await conn.execute(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    return (r.rows ?? []) as Record<string, unknown>[];
  });
  logAgentSql("filterValues:jbDeviceByMask:result", "(rows returned)", binds, {
    rowCount: rows.length,
  });
  const totalDistinct = rows.length > 0 ? Number(rows[0]!["TOTAL_DISTINCT"] ?? rows.length) : 0;
  const latest = new Map<string, string>();
  for (const row of rows) {
    const dev = String(row["GRP_KEY"] ?? "").trim();
    if (!dev) continue;
    latest.set(dev, formatOracleLastTest(row["LAST_TEST"]));
  }
  return { latest, totalDistinct };
}

async function oracleYieldDeviceByMask(
  mask: string,
  limit: number
): Promise<FilterValuesResult> {
  const { latest, totalDistinct } = await oracleYieldDeviceByMaskMap(mask, limit);
  const values = [...latest.entries()].map(([dev, te]) =>
    te ? `${dev} (最近: ${te})` : dev
  );
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

async function oracleJbDeviceByMask(
  mask: string,
  limit: number
): Promise<FilterValuesResult> {
  const { latest, totalDistinct } = await oracleJbDeviceByMaskMap(mask, limit);
  const values = [...latest.entries()].map(([dev, te]) =>
    te ? `${dev} (最近: ${te})` : dev
  );
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
      `NVL(REGEXP_SUBSTR(TRIM(t2.CARDID), '^[^-]+', 1, 1), '') = :pct`
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
          SELECT NVL(REGEXP_SUBSTR(TRIM(t2.CARDID), '^[^-]+', 1, 1), '') AS pct
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
    // CARDID and TESTERID are both on INFLAYERBINLIST (t2), not INFCONTROL (t1)
    const col = field === "cardId" ? "t2.CARDID"
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

  const deviceMaskLimit = field === "device" && filterBy["mask"]
    ? clampDeviceMaskLimit(args["limit"])
    : limit;

  if (domain === "both") {
    if (field !== "device") {
      return `get_filter_values 错误: domain="both" 仅支持 field="device" + mask`;
    }
    const mask = filterBy["mask"] ?? "";
    if (!mask) {
      return JSON.stringify({
        domain: "both",
        field: "device",
        values: [],
        totalDistinct: 0,
        hint: 'field="device" 需要 filterBy.mask（如 "N84R"）或顶层 mask 参数',
      } satisfies FilterValuesResult);
    }
    try {
      const result = yieldMonitorTriggersUseDummy() || infcontrolLayerBinsUseDummy()
        ? dummyDeviceByMaskBoth(mask, deviceMaskLimit)
        : await oracleDeviceByMaskBoth(mask, deviceMaskLimit);
      return JSON.stringify(result);
    } catch (err) {
      return `get_filter_values 错误: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (domain === "yield") {
    if (!(YIELD_FIELDS as readonly string[]).includes(field)) {
      return `get_filter_values 错误: yield domain 不支持 field="${field}"。支持: ${YIELD_FIELDS.join(", ")}`;
    }
    try {
      const result = yieldMonitorTriggersUseDummy()
        ? dummyYield(field as YieldField, filterBy, deviceMaskLimit)
        : await oracleYieldWithSearchFallback(field as YieldField, filterBy, deviceMaskLimit);
      return JSON.stringify(
        enrichEmptyCardEnumResult(
          enrichEmptyTesterSearchResult(result, field, filterBy["search"]),
          field,
          filterBy
        )
      );
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
        ? dummyJb(field as JbField, filterBy, deviceMaskLimit)
        : await oracleJbWithSearchFallback(field as JbField, filterBy, deviceMaskLimit);
      return JSON.stringify(
        enrichEmptyCardEnumResult(
          enrichEmptyTesterSearchResult(result, field, filterBy["search"]),
          field,
          filterBy
        )
      );
    } catch (err) {
      return `get_filter_values 错误: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  return `get_filter_values 错误: domain 必须是 "yield"、"jb" 或 "both"（field=device+mask 推荐 both），收到 "${domain}"`;
}
