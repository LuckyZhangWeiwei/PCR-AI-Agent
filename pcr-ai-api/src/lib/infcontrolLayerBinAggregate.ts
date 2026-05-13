import type { BindParameters } from "oracledb";
import { parseInfcontrolLayerBinQuery } from "./infcontrolLayerBinFilters.js";

/** 默认返回的分组条数上限 */
export const INFCONTROL_LAYER_BIN_AGGREGATE_DEFAULT_TOP = 10;
/** groupTop 允许的最大值 */
export const INFCONTROL_LAYER_BIN_AGGREGATE_MAX_TOP = 50;

/**
 * 聚合维度：`bin` 必选一次；其余为行级列，与列表筛选一致。
 * 复合示例：`device,bin` → 按 (DEVICE, BIN 列下标) 对 BIN 计数字段求和，再取 Top groupTop。
 */
export type InfcontrolLayerBinGroupBy =
  | "bin"
  | "device"
  | "lot"
  | "meslot"
  | "testerId"
  | "tstype"
  | "cardId"
  | "pibId"
  | "probe"
  | "layerName"
  | "passResume"
  | "passResult"
  | "passType"
  | "passBin"
  | "keynumber"
  | "slot"
  | "pdpw"
  | "grossDie"
  | "passId"
  | "sessionNumber"
  | "passNum";

/** 单次聚合最多组合的维度数 */
export const INFCONTROL_LAYER_BIN_AGGREGATE_MAX_DIMENSIONS = 8;

/** GRP_KEY 片段分隔（与 dummy、Oracle SQL 一致） */
export const INFCONTROL_LAYER_BIN_AGGREGATE_KEY_SEP = "|";

type ParseFail = { ok: false; error: string };
type ParseOk = {
  ok: true;
  whereSql: string;
  binds: BindParameters;
  applied: Record<string, unknown>;
  groupBy: InfcontrolLayerBinGroupBy[];
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

function parseGroupByToken(
  raw: string
): InfcontrolLayerBinGroupBy | undefined {
  const lower = raw.trim().toLowerCase();
  const map: Record<string, InfcontrolLayerBinGroupBy> = {
    bin: "bin",
    device: "device",
    lot: "lot",
    meslot: "meslot",
    testerid: "testerId",
    tstype: "tstype",
    cardid: "cardId",
    pibid: "pibId",
    probe: "probe",
    layername: "layerName",
    passresume: "passResume",
    passresult: "passResult",
    passtype: "passType",
    passbin: "passBin",
    keynumber: "keynumber",
    slot: "slot",
    pdpw: "pdpw",
    grossdie: "grossDie",
    passid: "passId",
    sessionnumber: "sessionNumber",
    passnum: "passNum",
  };
  return map[lower];
}

/** UNPIVOT 之后用于 GROUP BY / GRP_KEY 的列别名（与 bin_idx 并列） */
export function infcontrolLayerBinNonBinSelectSql(
  d: InfcontrolLayerBinGroupBy
): string | null {
  if (d === "bin") return null;
  switch (d) {
    case "device":
      return "ic.DEVICE AS DEVICE";
    case "lot":
      return "ic.LOT AS LOT";
    case "meslot":
      return "ic.MESLOT AS MESLOT";
    case "keynumber":
      return "ic.KEYNUMBER AS KEYNUMBER";
    case "slot":
      return "ic.SLOT AS SLOT";
    case "pdpw":
      return "ic.PDPW AS PDPW";
    case "testerId":
      return "lb.TESTERID AS TESTERID";
    case "tstype":
      return "lb.TSTYPE AS TSTYPE";
    case "cardId":
      return "lb.CARDID AS CARDID";
    case "pibId":
      return "lb.PIBID AS PIBID";
    case "probe":
      return "lb.PROBE AS PROBE";
    case "grossDie":
      return "lb.GROSSDIE AS GROSSDIE";
    case "passId":
      return "lb.PASSID AS PASSID";
    case "sessionNumber":
      return "lb.SESSIONNUMBER AS SESSIONNUMBER";
    case "passNum":
      return "lb.PASSNUM AS PASSNUM";
    case "layerName":
      return "lb.LAYERNAME AS LAYERNAME";
    case "passResume":
      return "lb.PASSRESUME AS PASSRESUME";
    case "passResult":
      return "lb.PASSRESULT AS PASSRESULT";
    case "passType":
      return "lb.PASSTYPE AS PASSTYPE";
    case "passBin":
      return "lb.PASSBIN AS PASSBIN";
    default: {
      const _e: never = d;
      return _e;
    }
  }
}

/** unpivoted 子查询别名 u 上的片段（NVL + 数值 TO_CHAR） */
function sqlExprForGrpKeyFragment(
  d: InfcontrolLayerBinGroupBy,
  alias = "u"
): string {
  if (d === "bin") {
    return `TO_CHAR(${alias}.bin_idx)`;
  }
  switch (d) {
    case "keynumber":
    case "slot":
    case "pdpw":
    case "grossDie":
    case "passId":
    case "sessionNumber":
    case "passNum":
      return `NVL(TO_CHAR(${alias}.${oracleGroupColumnName(d)}), '')`;
    default:
      return `NVL(${alias}.${oracleGroupColumnName(d)}, '')`;
  }
}

function oracleGroupColumnName(d: Exclude<InfcontrolLayerBinGroupBy, "bin">): string {
  switch (d) {
    case "device":
      return "DEVICE";
    case "lot":
      return "LOT";
    case "meslot":
      return "MESLOT";
    case "testerId":
      return "TESTERID";
    case "tstype":
      return "TSTYPE";
    case "cardId":
      return "CARDID";
    case "pibId":
      return "PIBID";
    case "probe":
      return "PROBE";
    case "layerName":
      return "LAYERNAME";
    case "passResume":
      return "PASSRESUME";
    case "passResult":
      return "PASSRESULT";
    case "passType":
      return "PASSTYPE";
    case "passBin":
      return "PASSBIN";
    case "keynumber":
      return "KEYNUMBER";
    case "slot":
      return "SLOT";
    case "pdpw":
      return "PDPW";
    case "grossDie":
      return "GROSSDIE";
    case "passId":
      return "PASSID";
    case "sessionNumber":
      return "SESSIONNUMBER";
    case "passNum":
      return "PASSNUM";
    default: {
      const _e: never = d;
      return _e;
    }
  }
}

function groupBySqlExprs(
  groupBys: InfcontrolLayerBinGroupBy[],
  alias = "u"
): string[] {
  return groupBys.map((d) => {
    if (d === "bin") return `${alias}.bin_idx`;
    return `${alias}.${oracleGroupColumnName(d)}`;
  });
}

function buildGrpKeySelectExpr(
  groupBys: InfcontrolLayerBinGroupBy[],
  alias = "u"
): string {
  if (groupBys.length === 1) {
    return sqlExprForGrpKeyFragment(groupBys[0], alias);
  }
  return groupBys
    .map((d) => sqlExprForGrpKeyFragment(d, alias))
    .join(` || '|' || `);
}

/** BIN0…BIN255 UNPIVOT 列表 */
export function buildInfcontrolBinUnpivotInList(): string {
  const parts: string[] = [];
  for (let i = 0; i < 256; i++) {
    parts.push(`BIN${i} AS ${i}`);
  }
  return parts.join(",\n          ");
}

export type ParseInfcontrolLayerBinAggregateGroupSpecFail = {
  ok: false;
  error: string;
};
export type ParseInfcontrolLayerBinAggregateGroupSpecOk = {
  ok: true;
  groupBy: InfcontrolLayerBinGroupBy[];
  groupTop: number;
};

/**
 * 仅解析 **groupBy** / **groupTop**（与 v1 `/aggregate` 及 **v3 aggregate** 共用规则）。
 */
export function parseInfcontrolLayerBinAggregateGroupSpec(
  q: Record<string, unknown>
): ParseInfcontrolLayerBinAggregateGroupSpecFail | ParseInfcontrolLayerBinAggregateGroupSpecOk {
  const groupRaw = firstString(firstQueryValue(q, "groupBy"));
  const rawForTokens = groupRaw ?? "bin";

  const tokens = rawForTokens
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (tokens.length === 0) {
    return { ok: false, error: "groupBy is empty (omit groupBy to default to bin)" };
  }
  if (tokens.length > INFCONTROL_LAYER_BIN_AGGREGATE_MAX_DIMENSIONS) {
    return {
      ok: false,
      error: `groupBy has at most ${INFCONTROL_LAYER_BIN_AGGREGATE_MAX_DIMENSIONS} dimensions`,
    };
  }

  const groupBy: InfcontrolLayerBinGroupBy[] = [];
  for (const t of tokens) {
    const g = parseGroupByToken(t);
    if (g === undefined) {
      return {
        ok: false,
        error: `Invalid groupBy segment: ${t} (must include bin once, plus optional device, lot, testerId, cardId, …; see manifest)`,
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

  if (!groupBy.includes("bin")) {
    return {
      ok: false,
      error: 'groupBy must include "bin" exactly once (e.g. bin or device,bin)',
    };
  }

  let groupTop = INFCONTROL_LAYER_BIN_AGGREGATE_DEFAULT_TOP;
  const topRaw = firstString(firstQueryValue(q, "groupTop"));
  if (topRaw !== undefined) {
    const n = Number(topRaw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
      return { ok: false, error: "groupTop must be a positive integer" };
    }
    groupTop = Math.min(n, INFCONTROL_LAYER_BIN_AGGREGATE_MAX_TOP);
  }

  return { ok: true, groupBy, groupTop };
}

/**
 * 与列表接口相同的筛选；**groupBy** 可选，省略时视为 **`bin`**（按 BIN0…BIN255 合计取 Top）；
 * 若传入则须**恰好含一个 `bin`**（可与 device、lot、slot、tstype、cardId 等复合）。可选 **groupTop**（默认 10，最大 50）。
 * 聚合指标为各组内 **SUM(BIN 列数值)**（先 UNPIVOT 再 SUM），取 SUM 最大的 Top groupTop 组。
 */
export function parseInfcontrolLayerBinAggregateQuery(
  q: Record<string, unknown>
): ParseFail | ParseOk {
  const gs = parseInfcontrolLayerBinAggregateGroupSpec(q);
  if (!gs.ok) {
    return gs;
  }
  const { groupBy, groupTop } = gs;

  const base = parseInfcontrolLayerBinQuery(q);
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
 * Top-N：按 SUM(BIN 列) DESC；GRP_KEY 为维度拼接（含 bin 下标字符串）。
 */
export function buildInfcontrolLayerBinAggregateSql(
  whereClause: string,
  groupBys: InfcontrolLayerBinGroupBy[]
): string {
  const wc = whereClause.trim();

  const nonBinDims = groupBys.filter((d) => d !== "bin");
  const innerSelectParts: string[] = [];
  /** 聚合时排除 PASSBIN「两端」good bin；UNPIVOT 后需能读到 PASSBIN */
  if (!nonBinDims.includes("passBin")) {
    innerSelectParts.push(`lb.PASSBIN AS PASSBIN`);
  }
  for (const d of nonBinDims) {
    const sql = infcontrolLayerBinNonBinSelectSql(d);
    if (sql) innerSelectParts.push(sql);
  }
  for (let i = 0; i < 256; i++) {
    innerSelectParts.push(`lb.BIN${i}`);
  }

  const innerSelect = innerSelectParts.join(",\n        ");
  const unpivotIn = buildInfcontrolBinUnpivotInList();
  const grpKeyExpr = buildGrpKeySelectExpr(groupBys, "u");
  const groupByList = groupBySqlExprs(groupBys, "u").join(", ");

  /** BIN1 视为硬良品不计入；PASSBIN 为 N-M 时两端 BIN 亦不计入（与列表 passBinPair 一致） */
  const sumCntExpr = `SUM(
      CASE
        WHEN u.bin_idx = 1 THEN 0
        WHEN REGEXP_LIKE(TRIM(u.PASSBIN), '^\\d+\\s*-\\s*\\d+$')
             AND (
               u.bin_idx = TO_NUMBER(REGEXP_SUBSTR(TRIM(u.PASSBIN), '[0-9]+', 1, 1))
               OR u.bin_idx = TO_NUMBER(REGEXP_SUBSTR(TRIM(u.PASSBIN), '[0-9]+', 1, 2))
             )
        THEN 0
        ELSE u.cnt
      END
    )`;

  return `
SELECT GRP_KEY, CNT FROM (
  SELECT agg.GRP_KEY AS GRP_KEY, agg.CNT AS CNT, ROWNUM AS rnum
  FROM (
    SELECT ${grpKeyExpr} AS GRP_KEY, ${sumCntExpr} AS CNT
    FROM (
      SELECT
        ${innerSelect}
      FROM INFCONTROL ic
      INNER JOIN INFLAYERBINLIST lb ON ic.KEYNUMBER = lb.KEYNUMBER
      ${wc}
    ) base
    UNPIVOT EXCLUDE NULLS (
      cnt FOR bin_idx IN (
          ${unpivotIn}
      )
    ) u
    GROUP BY ${groupByList}
    HAVING ${sumCntExpr} > 0
    ORDER BY ${sumCntExpr} DESC NULLS LAST
  ) agg
  WHERE ROWNUM <= :agg_lim
)
WHERE rnum >= 1
`.trim();
}

export function buildInfcontrolLayerBinMatchingCountSql(
  whereClause: string
): string {
  const wc = whereClause.trim();
  return `
SELECT COUNT(*) AS TOTAL_MATCHING
FROM INFCONTROL ic
INNER JOIN INFLAYERBINLIST lb ON ic.KEYNUMBER = lb.KEYNUMBER
${wc}
`.trim();
}

export function buildInfcontrolLayerBinAggregateGroupParts(
  grpKey: string,
  dimensions: InfcontrolLayerBinGroupBy[]
): Record<string, string> {
  if (dimensions.length === 1) {
    return { [dimensions[0]]: grpKey };
  }
  const pieces = grpKey.split(INFCONTROL_LAYER_BIN_AGGREGATE_KEY_SEP);
  const parts: Record<string, string> = {};
  dimensions.forEach((d, i) => {
    parts[d] = pieces[i] ?? "";
  });
  return parts;
}
