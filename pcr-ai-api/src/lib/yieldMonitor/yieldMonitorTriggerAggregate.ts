import type { BindParameters } from "oracledb";
import { parseYieldMonitorTriggerQuery } from "./yieldMonitorTriggerFilters.js";

/** 默认返回的分组条数上限 */
export const YIELD_MONITOR_AGGREGATE_DEFAULT_TOP = 10;
/** groupTop 允许的最大值 */
export const YIELD_MONITOR_AGGREGATE_MAX_TOP = 50;

export type YieldMonitorGroupBy =
  | "hostname"
  | "device"
  | "lotId"
  | "wafer"
  | "type"
  | "probeCard"
  | "pass";

/** 单次聚合最多组合的维度数（避免过长 GROUP BY） */
export const YIELD_MONITOR_AGGREGATE_MAX_DIMENSIONS = 7;

type ParseFail = { ok: false; error: string };
type ParseOk = {
  ok: true;
  whereSql: string;
  binds: BindParameters;
  applied: Record<string, unknown>;
  /** 从左到右的复合分组维度（至少 1 个） */
  groupBy: YieldMonitorGroupBy[];
  groupTop: number;
};

function firstQueryValue(q: Record<string, unknown>, key: string): unknown {
  const lower = key.toLowerCase();
  for (const k of Object.keys(q)) {
    if (k.toLowerCase() === lower) return q[k];
  }
  return undefined;
}

function firstString(raw: unknown): string | undefined {
  if (raw == null) return undefined;
  if (Array.isArray(raw)) {
    const a = raw[0];
    if (a == null) return undefined;
    return String(a).trim();
  }
  const s = String(raw).trim();
  return s === "" ? undefined : s;
}

function parseGroupByParam(
  raw: string | undefined
): YieldMonitorGroupBy | undefined {
  if (raw === undefined) return undefined;
  const lower = raw.toLowerCase();
  const map: Record<string, YieldMonitorGroupBy> = {
    hostname: "hostname",
    device: "device",
    lotid: "lotId",
    wafer: "wafer",
    type: "type",
    probecard: "probeCard",
    pass: "pass",
  };
  return map[lower];
}

export function yieldMonitorGroupColumnSql(
  groupBy: YieldMonitorGroupBy
): string {
  switch (groupBy) {
    case "hostname":
      return "t.HOSTNAME";
    case "device":
      return "t.DEVICE";
    case "lotId":
      return "t.LOTID";
    case "wafer":
      return "t.WAFER";
    case "type":
      return 't."TYPE"';
    case "probeCard":
      return "t.PROBECARD";
    case "pass":
      return "t.PASS";
    default: {
      const _exhaustive: never = groupBy;
      return _exhaustive;
    }
  }
}

/** GRP_KEY 内拼接多列时使用的分隔符（与 dummy、Oracle SQL 一致；`|` 便于人工阅读） */
export const YIELD_MONITOR_AGGREGATE_KEY_SEP = "|";

/** NVL/TO_CHAR，用于 GRP_KEY 字符串中的一段 */
function sqlExprForGrpKeyFragment(groupBy: YieldMonitorGroupBy): string {
  const col = yieldMonitorGroupColumnSql(groupBy);
  if (groupBy === "pass") {
    return `NVL(TO_CHAR(${col}), '')`;
  }
  return `NVL(${col}, '')`;
}

function buildGrpKeySelectExpr(groupBys: YieldMonitorGroupBy[]): string {
  if (groupBys.length === 1) {
    return sqlExprForGrpKeyFragment(groupBys[0]);
  }
  return groupBys
    .map(sqlExprForGrpKeyFragment)
    .join(` || '|' || `);
}

/**
 * 与列表接口相同的筛选条件，外加必选 groupBy、可选 groupTop（默认 10，最大 50）。
 * 聚合在**符合 WHERE 的全集**上计算（不受列表 Top 200 限制）。
 *
 * **复合分组**：`groupBy` 为逗号分隔的多维，如 `device,type`（顺序决定 GRP_KEY / parts 键序）。
 */
export function parseYieldMonitorTriggerAggregateQuery(
  q: Record<string, unknown>
): ParseFail | ParseOk {
  const groupRaw = firstString(firstQueryValue(q, "groupBy"));
  if (groupRaw === undefined) {
    return { ok: false, error: "groupBy is required" };
  }

  const tokens = groupRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (tokens.length === 0) {
    return { ok: false, error: "groupBy is required" };
  }
  if (tokens.length > YIELD_MONITOR_AGGREGATE_MAX_DIMENSIONS) {
    return {
      ok: false,
      error: `groupBy has at most ${YIELD_MONITOR_AGGREGATE_MAX_DIMENSIONS} dimensions`,
    };
  }

  const groupBy: YieldMonitorGroupBy[] = [];
  for (const t of tokens) {
    const g = parseGroupByParam(t);
    if (g === undefined) {
      return {
        ok: false,
        error: `Invalid groupBy segment: ${t} (use hostname, device, lotId, wafer, type, probeCard, pass)`,
      };
    }
    if (groupBy.includes(g)) {
      return {
        ok: false,
        error: `Duplicate groupBy dimension: ${g}`,
      };
    }
    groupBy.push(g);
  }

  let groupTop = YIELD_MONITOR_AGGREGATE_DEFAULT_TOP;
  const topRaw = firstString(firstQueryValue(q, "groupTop"));
  if (topRaw !== undefined) {
    const n = Number(topRaw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
      return { ok: false, error: "groupTop must be a positive integer" };
    }
    groupTop = Math.min(n, YIELD_MONITOR_AGGREGATE_MAX_TOP);
  }

  const base = parseYieldMonitorTriggerQuery(q);
  if (!base.ok) {
    return base;
  }

  const applied = {
    ...base.applied,
    groupBy,
    groupTop,
  };

  return {
    ok: true,
    whereSql: base.whereSql,
    binds: base.binds,
    applied,
    groupBy,
    groupTop,
  };
}

/**
 * Top-N 分组计数：按 COUNT(*) DESC；Top groupTop 组（ROWNUM，兼容旧版 Oracle）。
 * `groupBys` 为多列时，`GROUP BY` 列出全部列，`GRP_KEY` 为列值用 `|` 拼接。
 */
export function buildYieldMonitorTriggerAggregateSql(
  whereClause: string,
  groupBys: YieldMonitorGroupBy[]
): string {
  const wc = whereClause.trim();
  const grpKeyExpr = buildGrpKeySelectExpr(groupBys);
  const groupByCols = groupBys.map(yieldMonitorGroupColumnSql).join(", ");
  return `
SELECT GRP_KEY, CNT FROM (
  SELECT agg.GRP_KEY AS GRP_KEY, agg.CNT AS CNT, ROWNUM AS rnum
  FROM (
    SELECT ${grpKeyExpr} AS GRP_KEY, COUNT(*) AS CNT
    FROM YMWEB_YIELDMONITORTRIGGER t
    ${wc}
    GROUP BY ${groupByCols}
    ORDER BY COUNT(*) DESC NULLS LAST
  ) agg
  WHERE ROWNUM <= :agg_lim
)
WHERE rnum >= 1
`.trim();
}

/** 与列表/聚合相同的 WHERE，返回匹配行总数 */
export function buildYieldMonitorTriggerMatchingCountSql(
  whereClause: string
): string {
  const wc = whereClause.trim();
  return `
SELECT COUNT(*) AS TOTAL_MATCHING
FROM YMWEB_YIELDMONITORTRIGGER t
${wc}
`.trim();
}

/**
 * 将 Oracle 返回的 GRP_KEY 解析为与 `groupBy` 顺序对应的 `parts`（单维时整串即该列值）。
 */
export function buildAggregateGroupParts(
  grpKey: string,
  dimensions: YieldMonitorGroupBy[]
): Record<string, string> {
  if (dimensions.length === 1) {
    return { [dimensions[0]]: grpKey };
  }
  const pieces = grpKey.split(YIELD_MONITOR_AGGREGATE_KEY_SEP);
  const parts: Record<string, string> = {};
  dimensions.forEach((d, i) => {
    parts[d] = pieces[i] ?? "";
  });
  return parts;
}
