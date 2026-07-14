// pcr-ai-api/src/lib/agent/tools/filterValues/agentFilterValuesDeviceMask.ts
//
// field="device" + mask resolution (single-domain and cross-domain "both"), plus the
// shared consts/types used across all four filterValues/* files and the slimmed
// dispatcher (agentFilterValuesTool.ts). This file sits at the base of the
// filterValues/ dependency chain (deviceMask -> oracle -> search -> dummy) and has no
// imports from its sibling files, which is why the shared consts/types live here
// rather than in the dispatcher — see agentFilterValuesTool.ts header comment for the
// full placement rationale.
import { withConnection, withProbeWebConnection } from "../../../../oracle.js";
import oracledb from "oracledb";
import {
  getYieldMonitorTriggerDummyRows,
} from "../../../yieldMonitor/yieldMonitorTriggerDummy.js";
import {
  getInfcontrolLayerBinDummyRows,
} from "../../../infcontrol/infcontrolLayerBinDummy.js";
import {
  deviceMatchesMask,
  deviceMaskOracleWhere,
  looksLikeDeviceMaskToken,
} from "../../../deviceMask.js";
import { oracleNonEmptyTrimmedColumn } from "../../../oracleStringSql.js";
import { logAgentSql } from "../../agentSqlDebugLog.js";

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;
export const DEVICE_MASK_DEFAULT_LIMIT = 20;

export const YIELD_FIELDS = ["probeCard", "probeCardType", "hostname", "lotId", "device"] as const;
export const JB_FIELDS = ["cardId", "probeCardType", "testerId", "lot", "device"] as const;

export type YieldField = (typeof YIELD_FIELDS)[number];
export type JbField = (typeof JB_FIELDS)[number];

export interface FilterValuesResult {
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

export interface DeviceByMaskEntry {
  device: string;
  lastYield: string | null;
  lastJb: string | null;
  lastOverall: string | null;
}

export function clampDeviceMaskLimit(raw: unknown): number {
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

export function dummyDeviceByMaskBoth(
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

export async function oracleDeviceByMaskBoth(
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
  const valueCount = merged.values?.length ?? 0;
  if (merged.totalDistinct > valueCount) {
    merged.note =
      (merged.note ? `${merged.note}；` : "") +
      `共 ${merged.totalDistinct} 个 device，已展示最近 ${valueCount} 个`;
  }
  return merged;
}

// ─── device-by-mask shared helper ────────────────────────────────────────────

export function resolveDeviceMaskArg(
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

export function dummyDeviceByMask(
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

// ─── Oracle device-by-mask lookups ────────────────────────────────────────────

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
        AND ${oracleNonEmptyTrimmedColumn("t.DEVICE")}
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
    sampleDevices: rows.slice(0, 5).map((r) => String(r["GRP_KEY"] ?? "").trim()),
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
        AND ${oracleNonEmptyTrimmedColumn("t1.DEVICE")}
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
    sampleDevices: rows.slice(0, 5).map((r) => String(r["GRP_KEY"] ?? "").trim()),
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

export async function oracleYieldDeviceByMask(
  mask: string,
  limit: number
): Promise<FilterValuesResult> {
  const { latest, totalDistinct } = await oracleYieldDeviceByMaskMap(mask, limit);
  const values = [...latest.entries()].map(([dev, te]) =>
    te ? `${dev} (最近: ${te})` : dev
  );
  return { domain: "yield", field: "device", values, totalDistinct };
}

export async function oracleJbDeviceByMask(
  mask: string,
  limit: number
): Promise<FilterValuesResult> {
  const { latest, totalDistinct } = await oracleJbDeviceByMaskMap(mask, limit);
  const values = [...latest.entries()].map(([dev, te]) =>
    te ? `${dev} (最近: ${te})` : dev
  );
  return { domain: "jb", field: "device", values, totalDistinct };
}
