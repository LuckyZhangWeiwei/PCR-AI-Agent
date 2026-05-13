import type { BindParameters } from "oracledb";

export const YIELD_MONITOR_TRIGGER_TOP = 200;

type ParseFail = { ok: false; error: string };
type ParseOk = {
  ok: true;
  whereSql: string;
  binds: BindParameters;
  applied: Record<string, unknown>;
  /** 是否在列表响应中附带 PROBECARD / HOSTNAME 分组计数（全量匹配行，与 Top 200 独立） */
  includeProbeCardSummary: boolean;
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

function parseOptionalNumber(raw: unknown, label: string): number | undefined {
  const s = firstString(raw);
  if (s === undefined) return undefined;
  const n = Number(s);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid number for ${label}`);
  }
  return n;
}

function parseRequiredFiniteNumber(n: number, label: string): void {
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid number for ${label}`);
  }
}

/** 默认 true；传 false / 0 / no 则关闭（少两次 GROUP BY：探针卡 + 机台） */
function parseIncludeProbeCardSummary(q: Record<string, unknown>): boolean {
  const raw = firstQueryValue(q, "includeProbeCardSummary");
  if (raw === undefined) return true;
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v === undefined || v === null) return true;
  const s = String(v).trim().toLowerCase();
  if (s === "" || s === "1" || s === "true" || s === "yes") return true;
  if (s === "0" || s === "false" || s === "no") return false;
  return true;
}

function parseOptionalDate(raw: unknown, label: string): Date | undefined {
  const s = firstString(raw);
  if (s === undefined) return undefined;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid date for ${label}`);
  }
  return d;
}

/**
 * 复合条件 AND；时间列 TIME_STAMP 用 timeStampFrom / timeStampTo（ISO 8601）
 */
export function parseYieldMonitorTriggerQuery(
  q: Record<string, unknown>
): ParseFail | ParseOk {
  const clauses: string[] = [];
  const binds: BindParameters = {};
  const applied: Record<string, unknown> = {};

  try {
    const strEq = (param: string, columnSql: string, bindName: string) => {
      const v = firstString(firstQueryValue(q, param));
      if (v === undefined) return;
      clauses.push(`${columnSql} = :${bindName}`);
      (binds as Record<string, string | number | Date>)[bindName] = v;
      applied[param] = v;
    };

    strEq("hostname", "t.HOSTNAME", "f_hostname");
    strEq("device", "t.DEVICE", "f_device");
    strEq("lotId", "t.LOTID", "f_lotid");
    strEq("wafer", "t.WAFER", "f_wafer");
    strEq("type", 't."TYPE"', "f_type");
    strEq("triggerLabel", "t.TRIGGER_LABEL", "f_trigger_label");
    strEq("probeCard", "t.PROBECARD", "f_probecard");

    const numEq = (param: string, columnSql: string, bindName: string) => {
      const n = parseOptionalNumber(firstQueryValue(q, param), param);
      if (n === undefined) return;
      parseRequiredFiniteNumber(n, param);
      clauses.push(`${columnSql} = :${bindName}`);
      (binds as Record<string, string | number | Date>)[bindName] = n;
      applied[param] = n;
    };

    numEq("pass", "t.PASS", "f_pass");
    numEq("id", "t.ID", "f_id");

    const tsFrom = parseOptionalDate(firstQueryValue(q, "timeStampFrom"), "timeStampFrom");
    const tsTo = parseOptionalDate(firstQueryValue(q, "timeStampTo"), "timeStampTo");
    if (tsFrom !== undefined && tsTo !== undefined) {
      if (tsFrom > tsTo) {
        return { ok: false, error: "timeStampFrom must be <= timeStampTo" };
      }
    }
    if (tsFrom !== undefined) {
      clauses.push("t.TIME_STAMP >= :f_ts_from");
      binds.f_ts_from = tsFrom;
      applied.timeStampFrom = tsFrom.toISOString();
    }
    if (tsTo !== undefined) {
      clauses.push("t.TIME_STAMP <= :f_ts_to");
      binds.f_ts_to = tsTo;
      applied.timeStampTo = tsTo.toISOString();
    }

    const whereSql =
      clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

    const includeProbeCardSummary = parseIncludeProbeCardSummary(q);
    applied.includeProbeCardSummary = includeProbeCardSummary;

    return { ok: true, whereSql, binds, applied, includeProbeCardSummary };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: message };
  }
}

export type ParseYieldMonitorV3Ok = {
  ok: true;
  whereSql: string;
  binds: BindParameters;
  applied: Record<string, unknown>;
};

/**
 * **v3** `GET /yield-monitor-triggers/v3`：与库表列对应的 AND 筛选（无 triggerLabel / id）。
 * 字符串列：`UPPER(TRIM(列)) = UPPER(:bind)`，与库内实际大小写（如样例 `docs/delta-diff.xlsx` 中 HOSTNAME 小写）无关地匹配。
 * **`type`（库列 `TYPE`）**：v3 **不提供**按异常类型筛选；传入 **`type`** 查询参数将返回校验错误。
 * 时间：`timeStampBegin` & `timeStampEnd`（ISO 8601），或与 v1 相同的 `timeStampFrom` / `timeStampTo` 别名。
 */
export function parseYieldMonitorTriggerV3Query(
  q: Record<string, unknown>
): ParseFail | ParseYieldMonitorV3Ok {
  const clauses: string[] = [];
  const binds: BindParameters = {};
  const applied: Record<string, unknown> = {};

  try {
    if (firstString(firstQueryValue(q, "type")) !== undefined) {
      return {
        ok: false,
        error:
          'Query parameter "type" is not supported on v3 yield endpoints (list or aggregate)',
      };
    }

    const strEqTrimCi = (param: string, columnSql: string, bindName: string) => {
      const v = firstString(firstQueryValue(q, param));
      if (v === undefined) return;
      const t = v.trim();
      if (t === "") return;
      clauses.push(`UPPER(TRIM(${columnSql})) = UPPER(:${bindName})`);
      (binds as Record<string, string | number | Date>)[bindName] = t;
      applied[param] = t;
    };

    strEqTrimCi("hostname", "t.HOSTNAME", "v3_hostname");
    strEqTrimCi("device", "t.DEVICE", "v3_device");
    strEqTrimCi("lotId", "t.LOTID", "v3_lotid");
    strEqTrimCi("wafer", "t.WAFER", "v3_wafer");
    strEqTrimCi("probeCard", "t.PROBECARD", "v3_probecard");

    const passN = parseOptionalNumber(firstQueryValue(q, "pass"), "pass");
    if (passN !== undefined) {
      parseRequiredFiniteNumber(passN, "pass");
      clauses.push("t.PASS = :v3_pass");
      binds.v3_pass = passN;
      applied.pass = passN;
    }

    const tsLo =
      parseOptionalDate(
        firstQueryValue(q, "timeStampBegin"),
        "timeStampBegin"
      ) ??
      parseOptionalDate(
        firstQueryValue(q, "timeStampFrom"),
        "timeStampFrom"
      );
    const tsHi =
      parseOptionalDate(firstQueryValue(q, "timeStampEnd"), "timeStampEnd") ??
      parseOptionalDate(firstQueryValue(q, "timeStampTo"), "timeStampTo");

    if (tsLo !== undefined && tsHi !== undefined && tsLo > tsHi) {
      return {
        ok: false,
        error:
          "time window: lower bound must be <= upper bound (timeStampBegin/timeStampEnd or timeStampFrom/timeStampTo)",
      };
    }
    if (tsLo !== undefined) {
      clauses.push("t.TIME_STAMP >= :v3_ts_lo");
      binds.v3_ts_lo = tsLo;
      if (firstQueryValue(q, "timeStampBegin") != null) {
        applied.timeStampBegin = tsLo.toISOString();
      } else {
        applied.timeStampFrom = tsLo.toISOString();
      }
    }
    if (tsHi !== undefined) {
      clauses.push("t.TIME_STAMP <= :v3_ts_hi");
      binds.v3_ts_hi = tsHi;
      if (firstQueryValue(q, "timeStampEnd") != null) {
        applied.timeStampEnd = tsHi.toISOString();
      } else {
        applied.timeStampTo = tsHi.toISOString();
      }
    }

    const whereSql =
      clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

    return { ok: true, whereSql, binds, applied };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: message };
  }
}
