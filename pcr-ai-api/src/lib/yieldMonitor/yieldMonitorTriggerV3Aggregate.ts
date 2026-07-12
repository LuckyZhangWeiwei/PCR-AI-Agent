import type { BindParameters } from "oracledb";
import { parseYieldMonitorTriggerV3Query } from "./yieldMonitorTriggerFilters.js";
import { deviceBaseMask } from "../deviceMask.js";

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
  | "timeHour"
  /** 从 **`TRIGGER_LABEL`** 中 **`Bin#`** 片段派生（数字原样；`goodbin` 归一化为小写），空为 **''** */
  | "bin"
  /** 从 **`TRIGGER_LABEL`** 中 **`on dut#`** 片段派生（与列表 **`dutNumber`** 同源正则），空为 **''** */
  | "dutNumber";

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
    bin: "bin",
    dutnumber: "dutNumber",
  };
  return map[t];
}

/** `GROUP BY` / GRP_KEY 片段；`bare` 用于 `WITH filtered AS (SELECT t.* …)` 内层（无表别名）。 */
function dimSql(
  d: YieldMonitorV3AggDim,
  bare = false
): {
  groupByExpr: string;
  grpKeyFrag: string;
} {
  const col = (name: string) => (bare ? name : `t.${name}`);
  switch (d) {
    case "device":
      return {
        groupByExpr: col("DEVICE"),
        grpKeyFrag: `NVL(${col("DEVICE")}, '')`,
      };
    case "hostname":
      return {
        groupByExpr: col("HOSTNAME"),
        grpKeyFrag: `NVL(${col("HOSTNAME")}, '')`,
      };
    case "lotId":
      return {
        groupByExpr: col("LOTID"),
        grpKeyFrag: `NVL(${col("LOTID")}, '')`,
      };
    case "wafer":
      return {
        groupByExpr: col("WAFER"),
        grpKeyFrag: `NVL(${col("WAFER")}, '')`,
      };
    case "probeCard":
      return {
        groupByExpr: col("PROBECARD"),
        grpKeyFrag: `NVL(${col("PROBECARD")}, '')`,
      };
    case "probeCardType":
      return {
        groupByExpr: `NVL(REGEXP_SUBSTR(TRIM(${col("PROBECARD")}), '^[^-]+', 1, 1), '')`,
        grpKeyFrag: `NVL(REGEXP_SUBSTR(TRIM(${col("PROBECARD")}), '^[^-]+', 1, 1), '')`,
      };
    case "bin":
      return {
        groupByExpr: `NVL(LOWER(REGEXP_SUBSTR(${col("TRIGGER_LABEL")}, 'Bin#\\s*([0-9]+|goodbin)', 1, 1, 'i', 1)), '')`,
        grpKeyFrag: `NVL(LOWER(REGEXP_SUBSTR(${col("TRIGGER_LABEL")}, 'Bin#\\s*([0-9]+|goodbin)', 1, 1, 'i', 1)), '')`,
      };
    case "dutNumber":
      return {
        groupByExpr: `NVL(REGEXP_SUBSTR(${col("TRIGGER_LABEL")}, 'on\\s+dut#\\s*([0-9]+)', 1, 1, 'i', 1), '')`,
        grpKeyFrag: `NVL(REGEXP_SUBSTR(${col("TRIGGER_LABEL")}, 'on\\s+dut#\\s*([0-9]+)', 1, 1, 'i', 1), '')`,
      };
    case "pass":
      return {
        groupByExpr: col("PASS"),
        grpKeyFrag: `NVL(TO_CHAR(${col("PASS")}), '')`,
      };
    case "triggerLabel":
      return {
        groupByExpr: col("TRIGGER_LABEL"),
        grpKeyFrag: `NVL(${col("TRIGGER_LABEL")}, '')`,
      };
    case "timeDay":
      return {
        groupByExpr: `TRUNC(${col("TIME_STAMP")})`,
        grpKeyFrag: `TO_CHAR(TRUNC(${col("TIME_STAMP")}), 'YYYY-MM-DD HH24:MI:SS')`,
      };
    case "timeHour":
      return {
        groupByExpr: `TRUNC(${col("TIME_STAMP")}, 'HH24')`,
        grpKeyFrag: `TO_CHAR(TRUNC(${col("TIME_STAMP")}, 'HH24'), 'YYYY-MM-DD HH24:MI:SS')`,
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
 * `device`, `hostname`, `lotId`, `wafer`, `probeCard`, `probeCardType`, `pass`, `triggerLabel`, `timeDay`, `timeHour`, `bin`, `dutNumber`。
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
        'Missing required "dimensions" (comma-separated: device, hostname, lotId, wafer, probeCard, probeCardType, pass, triggerLabel, timeDay, timeHour, bin, dutNumber)',
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

/**
 * 单次表扫描：`COUNT(*)` 全量匹配行 + Top-N `GROUP BY`（`WITH filtered` 共用一次读）。
 */
export function buildYieldMonitorTriggerV3AggregateSqlWithTotal(
  whereSql: string,
  dimensions: YieldMonitorV3AggDim[]
): string {
  const wc = whereSql.trim();
  const groupByList = dimensions
    .map((d) => dimSql(d, true).groupByExpr)
    .join(", ");
  const grpKeyExpr = dimensions
    .map((d) => dimSql(d, true).grpKeyFrag)
    .join(` || '${GRP_SEP}' || `);

  return `
WITH filtered AS (
  SELECT t.*
  FROM YMWEB_YIELDMONITORTRIGGER t
  ${wc}
),
totals AS (
  SELECT COUNT(*) AS TOTAL_MATCHING FROM filtered
),
grouped AS (
  SELECT ${grpKeyExpr} AS GRP_KEY, COUNT(*) AS CNT
  FROM filtered
  GROUP BY ${groupByList}
),
ranked AS (
  SELECT GRP_KEY, CNT, ROWNUM AS rnum
  FROM (
    SELECT GRP_KEY, CNT
    FROM grouped
    ORDER BY CNT DESC NULLS LAST
  )
  WHERE ROWNUM <= :agg_lim
)
SELECT r.GRP_KEY, r.CNT, t.TOTAL_MATCHING
FROM ranked r
CROSS JOIN totals t
WHERE r.rnum >= 1
`.trim();
}

export function mapYieldMonitorV3AggregateRows(
  dimensions: YieldMonitorV3AggDim[],
  aggRows: Record<string, unknown>[]
): {
  totalRowsMatching: number;
  groups: Array<{ key: string; count: number; parts: Record<string, string | null> }>;
} {
  const totalObj = aggRows[0] as Record<string, unknown> | undefined;
  const totalRaw =
    totalObj?.TOTAL_MATCHING ?? totalObj?.total_matching ?? totalObj?.TOTAL;
  const totalRowsMatching =
    totalRaw != null && totalRaw !== "" ? Number(totalRaw) : 0;

  const groups = aggRows
    .filter((row) => {
      const cntRaw = row.CNT ?? row.cnt;
      return cntRaw != null && cntRaw !== "";
    })
    .map((row) => {
      const keyRaw = row.GRP_KEY ?? row.grp_key;
      const cntRaw = row.CNT ?? row.cnt;
      const keyStr = keyRaw == null ? "" : String(keyRaw);
      const n = Number(cntRaw);
      return {
        key: keyStr,
        count: Number.isFinite(n) ? n : 0,
        parts: buildYieldMonitorV3AggregateGroupParts(dimensions, keyStr),
      };
    });

  return { totalRowsMatching, groups };
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
