import type { BindParameters } from "oracledb";
import { parseYieldMonitorTriggerV3Query } from "./yieldMonitorTriggerFilters.js";
import { deviceBaseMask } from "./deviceMask.js";

/** 随 JSON 返回的固定说明（给人与 Agent；与 manifest `purpose` 一致） */
export const YIELD_MONITOR_V3_AGGREGATE_DOCUMENTATION =
  "v3 产量聚合：在「与 GET /yield-monitor-triggers/v3 相同的 WHERE」（含固定 **TYPE = delta_diff**；未传 timeStamp* 时间键时默认最近一年 TIME_STAMP）所匹配的**全部行**上，" +
  "**Oracle** 在库内 **`COUNT(*)` + `GROUP BY`** 指定维度，再按计数降序取 Top groupTop 组；与 v3 **列表**不同：列表按 TIME_STAMP 排序后 FETCH FIRST :lim，仅最多 500 条明细，聚合统计时间窗/设备筛选下的全量匹配行。" +
  "**Dummy**（`YIELD_MONITOR_TRIGGERS_DUMMY=true` 且非 dist/production）在 Node 内对 delta-diff 样本行做与 **`aggregateYieldMonitorV3FromRows`** 等价的 COUNT。" +
  "必填 **dimensions**（逗号分隔）；其中 **probeCardType** 与列表 **PROBECARDTYPE** 一致（PROBECARD 首个「-」前段；Oracle 聚合 SQL 内用 **REGEXP_SUBSTR**）。";

/** 默认返回的分组条数上限（与 v3 列表「最多 500 行」解耦：此处限制的是 **组数**） */
export const YIELD_MONITOR_V3_AGG_DEFAULT_TOP = 25;
export const YIELD_MONITOR_V3_AGG_MAX_TOP = 100;
export const YIELD_MONITOR_V3_AGG_MAX_DIMENSIONS = 5;

export type YieldMonitorV3AggDim =
  | "device"
  | "hostname"
  | "lotId"
  | "wafer"
  | "probeCard"
  /** 与 v3 列表 **`PROBECARDTYPE`** 一致：**`PROBECARD`** 首个 **`-`** 前段（Oracle/Dummy 中空为 **''**） */
  | "probeCardType"
  | "pass"
  | "triggerLabel"
  | "timeDay"
  | "timeHour";

type ParseFail = { ok: false; error: string };
type ParseOk = {
  ok: true;
  whereSql: string;
  binds: BindParameters;
  applied: Record<string, unknown>;
  dimensions: YieldMonitorV3AggDim[];
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

function parseDimToken(raw: string): YieldMonitorV3AggDim | undefined {
  const t = raw.trim().toLowerCase();
  const map: Record<string, YieldMonitorV3AggDim> = {
    device: "device",
    hostname: "hostname",
    lotid: "lotId",
    wafer: "wafer",
    probecard: "probeCard",
    probecardtype: "probeCardType",
    pass: "pass",
    triggerlabel: "triggerLabel",
    timeday: "timeDay",
    timehour: "timeHour",
  };
  return map[t];
}

/** `GROUP BY` 与 GRP_KEY 片段（不含别名歧义） */
function dimSql(d: YieldMonitorV3AggDim): {
  groupByExpr: string;
  grpKeyFrag: string;
} {
  switch (d) {
    case "device":
      return {
        groupByExpr: "t.DEVICE",
        grpKeyFrag: "NVL(t.DEVICE, '')",
      };
    case "hostname":
      return {
        groupByExpr: "t.HOSTNAME",
        grpKeyFrag: "NVL(t.HOSTNAME, '')",
      };
    case "lotId":
      return {
        groupByExpr: "t.LOTID",
        grpKeyFrag: "NVL(t.LOTID, '')",
      };
    case "wafer":
      return {
        groupByExpr: "t.WAFER",
        grpKeyFrag: "NVL(t.WAFER, '')",
      };
    case "probeCard":
      return {
        groupByExpr: "t.PROBECARD",
        grpKeyFrag: "NVL(t.PROBECARD, '')",
      };
    case "probeCardType":
      return {
        groupByExpr:
          "NVL(REGEXP_SUBSTR(TRIM(t.PROBECARD), '^[^-]+', 1, 1), '')",
        grpKeyFrag:
          "NVL(REGEXP_SUBSTR(TRIM(t.PROBECARD), '^[^-]+', 1, 1), '')",
      };
    case "pass":
      return {
        groupByExpr: "t.PASS",
        grpKeyFrag: "NVL(TO_CHAR(t.PASS), '')",
      };
    case "triggerLabel":
      return {
        groupByExpr: "t.TRIGGER_LABEL",
        grpKeyFrag: "NVL(t.TRIGGER_LABEL, '')",
      };
    case "timeDay":
      return {
        groupByExpr: "TRUNC(t.TIME_STAMP)",
        grpKeyFrag:
          "TO_CHAR(TRUNC(t.TIME_STAMP), 'YYYY-MM-DD HH24:MI:SS')",
      };
    case "timeHour":
      return {
        groupByExpr: "TRUNC(t.TIME_STAMP, 'HH24')",
        grpKeyFrag:
          "TO_CHAR(TRUNC(t.TIME_STAMP, 'HH24'), 'YYYY-MM-DD HH24:MI:SS')",
      };
    default: {
      const _e: never = d;
      return _e;
    }
  }
}

const GRP_SEP = "|";

/**
 * **v3 产量聚合**：与 **`/yield-monitor-triggers/v3`** 相同的 **WHERE**（含 `UPPER(TRIM)` 字符串筛选），
 * **Oracle**：在库内 **`COUNT(*)`**、**`GROUP BY`** 指定维度，再按计数降序取 Top **`groupTop`** 组。
 * **Dummy**：Excel 样本在 Node 内按维度 **COUNT**（**`aggregateYieldMonitorV3DummyRows`**）。
 *
 * **必填**：**`dimensions`**（逗号分隔，至少 1 项，至多 5 项），取值：
 * `device`, `hostname`, `lotId`, `wafer`, `probeCard`, `probeCardType`, `pass`, `triggerLabel`, `timeDay`, `timeHour`。
 * **`timeDay`** 与 **`timeHour`** 不可同时出现。
 */
export function parseYieldMonitorTriggerV3AggregateQuery(
  q: Record<string, unknown>
): ParseFail | ParseOk {
  const dimRaw = firstString(firstQueryValue(q, "dimensions"));
  if (dimRaw === undefined || dimRaw === "") {
    return {
      ok: false,
      error:
        'Missing required "dimensions" (comma-separated: device, hostname, lotId, wafer, probeCard, probeCardType, pass, triggerLabel, timeDay, timeHour)',
    };
  }

  const tokens = dimRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (tokens.length === 0) {
    return { ok: false, error: "dimensions is empty" };
  }
  if (tokens.length > YIELD_MONITOR_V3_AGG_MAX_DIMENSIONS) {
    return {
      ok: false,
      error: `dimensions has at most ${YIELD_MONITOR_V3_AGG_MAX_DIMENSIONS} entries`,
    };
  }

  const dimensions: YieldMonitorV3AggDim[] = [];
  for (const tok of tokens) {
    const d = parseDimToken(tok);
    if (d === undefined) {
      return {
        ok: false,
        error: `Invalid dimensions segment: ${tok}`,
      };
    }
    if (dimensions.includes(d)) {
      return { ok: false, error: `Duplicate dimension: ${d}` };
    }
    dimensions.push(d);
  }

  if (dimensions.includes("timeDay") && dimensions.includes("timeHour")) {
    return {
      ok: false,
      error: "dimensions cannot include both timeDay and timeHour",
    };
  }

  let groupTop = YIELD_MONITOR_V3_AGG_DEFAULT_TOP;
  const topRaw = firstString(firstQueryValue(q, "groupTop"));
  if (topRaw !== undefined) {
    const n = Number(topRaw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
      return { ok: false, error: "groupTop must be a positive integer" };
    }
    groupTop = Math.min(n, YIELD_MONITOR_V3_AGG_MAX_TOP);
  }

  const base = parseYieldMonitorTriggerV3Query(q);
  if (!base.ok) {
    return base;
  }

  const applied = {
    ...base.applied,
    dimensions: dimensions.join(","),
    groupTop,
  };

  return {
    ok: true,
    whereSql: base.whereSql,
    binds: base.binds,
    applied,
    dimensions,
    groupTop,
  };
}

/**
 * Top-N 组：`ORDER BY COUNT(*) DESC`，`ROWNUM <= :agg_lim`。
 * `whereSql` 为空串或 `WHERE ...`。
 */
export function buildYieldMonitorTriggerV3AggregateSql(
  whereSql: string,
  dimensions: YieldMonitorV3AggDim[]
): string {
  const wc = whereSql.trim();
  const groupByList = dimensions
    .map((d) => dimSql(d).groupByExpr)
    .join(", ");
  const grpKeyExpr = dimensions
    .map((d) => dimSql(d).grpKeyFrag)
    .join(` || '${GRP_SEP}' || `);

  return `
SELECT GRP_KEY, CNT FROM (
  SELECT kv.GRP_KEY AS GRP_KEY, kv.CNT AS CNT, ROWNUM AS rnum
  FROM (
    SELECT ${grpKeyExpr} AS GRP_KEY, COUNT(*) AS CNT
    FROM YMWEB_YIELDMONITORTRIGGER t
    ${wc}
    GROUP BY ${groupByList}
    ORDER BY COUNT(*) DESC NULLS LAST
  ) kv
  WHERE ROWNUM <= :agg_lim
)
WHERE rnum >= 1
`.trim();
}

export function buildYieldMonitorTriggerV3AggregateTotalSql(
  whereSql: string
): string {
  const wc = whereSql.trim();
  return `
SELECT COUNT(*) AS TOTAL_MATCHING
FROM YMWEB_YIELDMONITORTRIGGER t
${wc}
`.trim();
}

export function buildYieldMonitorV3AggregateGroupParts(
  dimensions: YieldMonitorV3AggDim[],
  grpKey: string
): Record<string, string | null> {
  const parts: Record<string, string | null> = {};
  if (dimensions.length === 1) {
    parts[dimensions[0]] = grpKey;
  } else {
    const pieces = grpKey.split(GRP_SEP);
    dimensions.forEach((d, i) => {
      parts[d] = pieces[i] ?? "";
    });
  }
  if (dimensions.includes("device")) {
    parts["mask"] = deviceBaseMask(parts["device"]);
  }
  return parts;
}
