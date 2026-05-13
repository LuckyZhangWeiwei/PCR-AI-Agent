import {
  type YieldMonitorGroupBy,
  YIELD_MONITOR_AGGREGATE_KEY_SEP,
} from "./yieldMonitorTriggerAggregate.js";
import { YIELD_MONITOR_TRIGGER_TOP } from "./yieldMonitorTriggerFilters.js";
import type { YieldMonitorV3AggDim } from "./yieldMonitorTriggerV3Aggregate.js";
import { loadYieldMonitorTriggerRowsFromDeltaDiffXlsx } from "./dummyRowsFromExcel.js";
import { listApisForceOracleNoDummy } from "./listDummyRuntime.js";

/** 与 Oracle 返回列一致（YMWEB_YIELDMONITORTRIGGER） */
export type YieldMonitorTriggerDummyRow = {
  HOSTNAME: string;
  DEVICE: string;
  LOTID: string;
  PASS: number;
  WAFER: string;
  TYPE: string;
  TRIGGER_LABEL: string;
  TIME_STAMP: string;
  ID: number;
  PROBECARD: string;
};

/**
 * Dummy 联调：查询串由 **`docs/delta-diff.xlsx` Sheet1 首行** 推导（`device` + 该行 `TIME_STAMP` 所在自然月的 `timeStampFrom`），保证至少一行命中。
 */
function buildYieldDummyExampleQuery(first: YieldMonitorTriggerDummyRow): string {
  const t = new Date(first.TIME_STAMP);
  const y = Number.isNaN(t.getTime()) ? 2026 : t.getUTCFullYear();
  const mo = Number.isNaN(t.getTime()) ? 0 : t.getUTCMonth();
  const timeStampFrom = new Date(Date.UTC(y, mo, 1)).toISOString();
  return new URLSearchParams({
    device: first.DEVICE,
    timeStampFrom,
  }).toString();
}

const MANIFEST_YIELD_EXAMPLE_FALLBACK =
  "device=D1&timeStampFrom=2026-01-01T00:00:00.000Z";

let _yieldDummyRowsCache: readonly YieldMonitorTriggerDummyRow[] | undefined;

function getYieldMonitorTriggerDummyRowsInternal(): readonly YieldMonitorTriggerDummyRow[] {
  if (_yieldDummyRowsCache !== undefined) return _yieldDummyRowsCache;
  if (listApisForceOracleNoDummy()) {
    _yieldDummyRowsCache = Object.freeze([]);
    return _yieldDummyRowsCache;
  }
  _yieldDummyRowsCache = Object.freeze(
    loadYieldMonitorTriggerRowsFromDeltaDiffXlsx().slice(
      0,
      YIELD_MONITOR_TRIGGER_TOP
    )
  );
  return _yieldDummyRowsCache;
}

export function getYieldMonitorTriggerDummyRows(): readonly YieldMonitorTriggerDummyRow[] {
  return getYieldMonitorTriggerDummyRowsInternal();
}

export function getYieldMonitorDummyExampleQuery(): string {
  if (listApisForceOracleNoDummy()) return MANIFEST_YIELD_EXAMPLE_FALLBACK;
  const rows = getYieldMonitorTriggerDummyRowsInternal();
  if (!rows.length) return MANIFEST_YIELD_EXAMPLE_FALLBACK;
  return buildYieldDummyExampleQuery(rows[0]!);
}

function yieldMonitorTriggersDummyEnvTrue(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * 测试或本地无库时使用内存样本，不连 Oracle probeweb。
 * **`npm run build` 后的 `dist` 进程** 或 **`NODE_ENV=production`** 时恒为 **false**（走库，忽略 `YIELD_MONITOR_TRIGGERS_DUMMY`）。
 */
export function yieldMonitorTriggersUseDummy(): boolean {
  if (listApisForceOracleNoDummy()) return false;
  if (process.env.NODE_ENV === "test") return true;
  return yieldMonitorTriggersDummyEnvTrue(
    process.env.YIELD_MONITOR_TRIGGERS_DUMMY
  );
}

/** 与 parseYieldMonitorTriggerQuery / SQL WHERE 等价，不限 200 条（供聚合 B 模式） */
export function filterYieldMonitorDummyRowsMatching(
  applied: Record<string, unknown>
): YieldMonitorTriggerDummyRow[] {
  let rows = [...getYieldMonitorTriggerDummyRowsInternal()];

  const eqStr = (param: keyof YieldMonitorTriggerDummyRow, key: string) => {
    const v = applied[key];
    if (v === undefined) return;
    const s = String(v);
    rows = rows.filter((r) => r[param] === s);
  };

  eqStr("HOSTNAME", "hostname");
  eqStr("DEVICE", "device");
  eqStr("LOTID", "lotId");
  eqStr("WAFER", "wafer");
  eqStr("TYPE", "type");
  eqStr("TRIGGER_LABEL", "triggerLabel");
  eqStr("PROBECARD", "probeCard");

  if (applied.pass !== undefined) {
    const n = Number(applied.pass);
    rows = rows.filter((r) => r.PASS === n);
  }
  if (applied.id !== undefined) {
    const n = Number(applied.id);
    rows = rows.filter((r) => r.ID === n);
  }

  if (applied.timeStampFrom !== undefined) {
    const from = new Date(String(applied.timeStampFrom)).getTime();
    rows = rows.filter((r) => new Date(r.TIME_STAMP).getTime() >= from);
  }
  if (applied.timeStampTo !== undefined) {
    const to = new Date(String(applied.timeStampTo)).getTime();
    rows = rows.filter((r) => new Date(r.TIME_STAMP).getTime() <= to);
  }

  return rows;
}

export type YieldMonitorProbeCardSummaryEntry = {
  probeCard: string;
  count: number;
};

export type YieldMonitorHostnameSummaryEntry = {
  hostname: string;
  count: number;
};

/** 与 Oracle GROUP BY PROBECARD + COUNT(*) 语义一致；在全量匹配行上统计 */
export function buildYieldMonitorProbeCardSummaryDummy(
  applied: Record<string, unknown>
): YieldMonitorProbeCardSummaryEntry[] {
  const rows = filterYieldMonitorDummyRowsMatching(applied);
  const counts = new Map<string, number>();
  for (const r of rows) {
    const k = r.PROBECARD ?? "";
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([probeCard, count]) => ({ probeCard, count }));
}

/** 与 Oracle GROUP BY HOSTNAME + COUNT(*) 语义一致；在全量匹配行上统计 */
export function buildYieldMonitorHostnameSummaryDummy(
  applied: Record<string, unknown>
): YieldMonitorHostnameSummaryEntry[] {
  const rows = filterYieldMonitorDummyRowsMatching(applied);
  const counts = new Map<string, number>();
  for (const r of rows) {
    const k = r.HOSTNAME ?? "";
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([hostname, count]) => ({ hostname, count }));
}

export function filterYieldMonitorDummyRows(
  applied: Record<string, unknown>
): YieldMonitorTriggerDummyRow[] {
  let rows = filterYieldMonitorDummyRowsMatching(applied);
  rows.sort(
    (a, b) =>
      new Date(b.TIME_STAMP).getTime() - new Date(a.TIME_STAMP).getTime()
  );
  return rows.slice(0, YIELD_MONITOR_TRIGGER_TOP);
}

export type YieldMonitorDummyAggregateGroup = {
  /** 与 Oracle GRP_KEY 一致；复合维度时为 `|` 分隔的拼接串 */
  key: string;
  count: number;
  /** 各维度取值（键为 groupBy 参数名，与请求中维度顺序一致） */
  parts: Record<string, string>;
};

function valueForDimension(
  row: YieldMonitorTriggerDummyRow,
  d: YieldMonitorGroupBy
): string {
  switch (d) {
    case "hostname":
      return row.HOSTNAME;
    case "device":
      return row.DEVICE;
    case "lotId":
      return row.LOTID;
    case "wafer":
      return row.WAFER;
    case "type":
      return row.TYPE;
    case "probeCard":
      return row.PROBECARD;
    case "pass":
      return String(row.PASS);
    default: {
      const _exhaustive: never = d;
      throw new Error(`Unexpected dimension: ${String(_exhaustive)}`);
    }
  }
}

/** 在筛选后的全集上分组计数并取 Top groupTop（与库内聚合语义一致） */
export function aggregateYieldMonitorDummyRows(
  applied: Record<string, unknown>,
  groupBy: YieldMonitorGroupBy[],
  groupTop: number
): { totalRowsMatching: number; groups: YieldMonitorDummyAggregateGroup[] } {
  const rows = filterYieldMonitorDummyRowsMatching(applied);
  const counts = new Map<string, number>();
  const firstParts = new Map<string, Record<string, string>>();

  for (const row of rows) {
    const parts: Record<string, string> = {};
    for (const d of groupBy) {
      parts[d] = valueForDimension(row, d);
    }
    const key = groupBy.map((d) => parts[d]).join(YIELD_MONITOR_AGGREGATE_KEY_SEP);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (!firstParts.has(key)) {
      firstParts.set(key, parts);
    }
  }

  const groups = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, groupTop)
    .map(([key, count]) => ({
      key,
      count,
      parts: firstParts.get(key) ?? {},
    }));

  return { totalRowsMatching: rows.length, groups };
}

function valueForYieldV3Dimension(
  row: YieldMonitorTriggerDummyRow,
  d: YieldMonitorV3AggDim
): string {
  switch (d) {
    case "hostname":
      return row.HOSTNAME;
    case "device":
      return row.DEVICE;
    case "lotId":
      return row.LOTID;
    case "wafer":
      return row.WAFER;
    case "type":
      return row.TYPE;
    case "probeCard":
      return row.PROBECARD;
    case "pass":
      return String(row.PASS);
    case "triggerLabel":
      return row.TRIGGER_LABEL;
    case "timeDay": {
      const t = new Date(row.TIME_STAMP).getTime();
      if (Number.isNaN(t)) return "";
      const d0 = new Date(t);
      d0.setUTCHours(0, 0, 0, 0);
      return d0.toISOString().replace("T", " ").slice(0, 19);
    }
    case "timeHour": {
      const t = new Date(row.TIME_STAMP).getTime();
      if (Number.isNaN(t)) return "";
      const h = new Date(t);
      h.setUTCMinutes(0, 0, 0);
      return h.toISOString().replace("T", " ").slice(0, 19);
    }
    default: {
      const _e: never = d;
      return _e;
    }
  }
}

/** 与 v3 Oracle **`UPPER(TRIM)`** 及 **`timeStampBegin`/`End`** 别名一致（Dummy 用 trim + toUpperCase）。 */
export function filterYieldMonitorDummyRowsMatchingV3(
  applied: Record<string, unknown>
): YieldMonitorTriggerDummyRow[] {
  let rows = [...getYieldMonitorTriggerDummyRowsInternal()];

  const ci = (param: keyof YieldMonitorTriggerDummyRow, key: string) => {
    const v = applied[key];
    if (v === undefined) return;
    const want = String(v).trim().toUpperCase();
    rows = rows.filter(
      (r) => String(r[param]).trim().toUpperCase() === want
    );
  };

  ci("HOSTNAME", "hostname");
  ci("DEVICE", "device");
  ci("LOTID", "lotId");
  ci("WAFER", "wafer");
  ci("TYPE", "type");
  ci("PROBECARD", "probeCard");

  if (applied.pass !== undefined) {
    const n = Number(applied.pass);
    rows = rows.filter((r) => r.PASS === n);
  }

  const tsLo = applied.timeStampBegin ?? applied.timeStampFrom;
  const tsHi = applied.timeStampEnd ?? applied.timeStampTo;
  if (tsLo !== undefined) {
    const from = new Date(String(tsLo)).getTime();
    rows = rows.filter((r) => new Date(r.TIME_STAMP).getTime() >= from);
  }
  if (tsHi !== undefined) {
    const to = new Date(String(tsHi)).getTime();
    rows = rows.filter((r) => new Date(r.TIME_STAMP).getTime() <= to);
  }

  return rows;
}

/** v3 列表 Dummy：按 **`TIME_STAMP`** 降序后截断 **`limit`**（上限 500，与路由 clamp 一致）。 */
export function filterYieldMonitorDummyRowsV3(
  applied: Record<string, unknown>,
  limit: number
): YieldMonitorTriggerDummyRow[] {
  const rows = filterYieldMonitorDummyRowsMatchingV3(applied);
  rows.sort(
    (a, b) =>
      new Date(b.TIME_STAMP).getTime() - new Date(a.TIME_STAMP).getTime()
  );
  const cap =
    Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 200;
  const maxCap = Math.min(cap, 500);
  return rows.slice(0, maxCap);
}

/** v3 产量聚合 Dummy：与 **`/yield-monitor-triggers/v3/aggregate`** Oracle 语义一致（`COUNT(*)` + 维度 bucket）。 */
export function aggregateYieldMonitorV3DummyRows(
  applied: Record<string, unknown>,
  dimensions: YieldMonitorV3AggDim[],
  groupTop: number
): { totalRowsMatching: number; groups: YieldMonitorDummyAggregateGroup[] } {
  const rows = filterYieldMonitorDummyRowsMatchingV3(applied);
  const counts = new Map<string, number>();
  const firstParts = new Map<string, Record<string, string>>();

  for (const row of rows) {
    const parts: Record<string, string> = {};
    for (const d of dimensions) {
      parts[d] = valueForYieldV3Dimension(row, d);
    }
    const key = dimensions
      .map((d) => parts[d] ?? "")
      .join(YIELD_MONITOR_AGGREGATE_KEY_SEP);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (!firstParts.has(key)) {
      firstParts.set(key, parts);
    }
  }

  const groups = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, groupTop)
    .map(([key, count]) => ({
      key,
      count,
      parts: firstParts.get(key) ?? {},
    }));

  return { totalRowsMatching: rows.length, groups };
}
