import type { BindParameters } from "oracledb";
import { deviceMaskOracleWhere } from "../deviceMask.js";
import { applyPlatformQueryFilter } from "../testerPlatform.js";
import { v3DefaultThroughNowMinusOneUtcYear } from "../v3DefaultOneYearWindow.js";

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
    const platformApplied = applyPlatformQueryFilter(
      q,
      clauses,
      applied,
      "t.HOSTNAME"
    );
    if (!platformApplied.ok) return platformApplied;

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

/** v3 产量列表 / 聚合：与 Oracle **`UPPER(TRIM(t."TYPE"))`** 及 Dummy 筛选一致（仅 **`delta_diff`** 行）。 */
export const YIELD_MONITOR_V3_TYPE_SCOPE = "delta_diff";

/**
 * **v3** `GET /yield-monitor-triggers/v3`：与库表列对应的 AND 筛选（无 triggerLabel / id）。
 * 字符串列：`UPPER(TRIM(列)) = UPPER(:bind)`，与库内实际大小写（如样例 `docs/delta-diff.xlsx` 中 HOSTNAME 小写）无关地匹配。
 * **固定**：始终 **`UPPER(TRIM(t."TYPE")) = UPPER(:v3_type_scope)`**，`:v3_type_scope` 为 **`delta_diff`**（响应 **`filters.typeScope`** 回显）；与 delta-diff 样本及 probeweb 中该类触发一致。
 * **`type`（库列 `TYPE`）**：v3 **不提供**按异常类型**再**筛选；传入 **`type`** 查询参数将返回校验错误。
 * 时间：`timeStampBegin` & `timeStampEnd`（ISO 8601），或与 v1 相同的 `timeStampFrom` / `timeStampTo` 别名。
 * **默认时间窗**：若请求未携带任一 **TIME_STAMP** 相关查询键（`timeStampBegin` / `From` / `End` / `To`），则追加 **`t.TIME_STAMP`** 在 **UTC 当前时刻起向前一个日历年**内（与 **`v3DefaultThroughNowMinusOneUtcYear`** 一致）。
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

    clauses.push(`UPPER(t."TYPE") = :v3_type_scope`);
    (binds as Record<string, string>).v3_type_scope = YIELD_MONITOR_V3_TYPE_SCOPE.toUpperCase();
    applied.typeScope = YIELD_MONITOR_V3_TYPE_SCOPE;

    // Exclude internal/test lots starting with kk, gg, or c (case-insensitive)
    clauses.push(`NOT REGEXP_LIKE(t.LOTID, '^(kk|gg|c)', 'i')`);

    // Exclude PASS 2/4/6 (not valid sort stages) from Yield Monitor data source
    clauses.push(`t.PASS NOT IN (2, 4, 6)`);

    const strEqTrimCi = (param: string, columnSql: string, bindName: string) => {
      const v = firstString(firstQueryValue(q, param));
      if (v === undefined) return;
      const t = v.trim();
      if (t === "") return;
      clauses.push(`UPPER(${columnSql}) = :${bindName}`);
      (binds as Record<string, string | number | Date>)[bindName] = t.toUpperCase();
      applied[param] = t;
    };

    strEqTrimCi("hostname", "t.HOSTNAME", "v3_hostname");
    const platformApplied = applyPlatformQueryFilter(
      q,
      clauses,
      applied,
      "t.HOSTNAME"
    );
    if (!platformApplied.ok) return platformApplied;

    strEqTrimCi("device", "t.DEVICE", "v3_device");
    strEqTrimCi("lotId", "t.LOTID", "v3_lotid");
    strEqTrimCi("wafer", "t.WAFER", "v3_wafer");
    strEqTrimCi("probeCard", "t.PROBECARD", "v3_probecard");

    // mask is last-4-chars of DEVICE base segment (computed suffix; not a DB column)
    const maskVal = firstString(firstQueryValue(q, "mask"));
    if (maskVal !== undefined && maskVal !== "") {
      const t = maskVal.trim();
      clauses.push(deviceMaskOracleWhere("t.DEVICE", "v3_mask"));
      (binds as Record<string, string | number | Date>).v3_mask = t;
      applied.mask = t;
    }

    // probeCardType is derived (prefix of PROBECARD before first '-'); filter as equality OR prefix match
    const pctVal = firstString(firstQueryValue(q, "probeCardType"));
    if (pctVal !== undefined && pctVal !== "") {
      const t = pctVal.trim();
      clauses.push(
        `(UPPER(t.PROBECARD) = :v3_pct OR UPPER(t.PROBECARD) LIKE :v3_pct || '-%')`
      );
      (binds as Record<string, string | number | Date>).v3_pct = t.toUpperCase();
      applied.probeCardType = t;
    }

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

    const yieldV3TimeQueryKeys = [
      "timeStampBegin",
      "timeStampFrom",
      "timeStampEnd",
      "timeStampTo",
    ] as const;
    const userTouchedYieldTime = yieldV3TimeQueryKeys.some(
      (k) => firstString(firstQueryValue(q, k)) !== undefined
    );
    if (!userTouchedYieldTime && tsLo === undefined && tsHi === undefined) {
      const { lo, hi } = v3DefaultThroughNowMinusOneUtcYear();
      clauses.push("t.TIME_STAMP >= :v3_ts_lo");
      clauses.push("t.TIME_STAMP <= :v3_ts_hi");
      (binds as Record<string, string | number | Date>).v3_ts_lo = lo;
      (binds as Record<string, string | number | Date>).v3_ts_hi = hi;
      applied.timeStampBegin = lo.toISOString();
      applied.timeStampEnd = hi.toISOString();
    }

    const whereSql =
      clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

    return { ok: true, whereSql, binds, applied };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: message };
  }
}

/**
 * v3 联动筛选（device / lot / … / TIME_STAMP），**不**固定 `TYPE = delta_diff`。
 * 供周期报警 Tester 频率分母：同期同筛选下机台在 YM 的全 TYPE 记录数。
 */
export function parseYieldMonitorTriggerActivityQuery(
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

    clauses.push(`NOT REGEXP_LIKE(t.LOTID, '^(kk|gg|c)', 'i')`);

    // Exclude PASS 2/4/6 (not valid sort stages) from Yield Monitor data source
    clauses.push(`t.PASS NOT IN (2, 4, 6)`);

    const strEqTrimCi = (param: string, columnSql: string, bindName: string) => {
      const v = firstString(firstQueryValue(q, param));
      if (v === undefined) return;
      const t = v.trim();
      if (t === "") return;
      clauses.push(`UPPER(${columnSql}) = :${bindName}`);
      (binds as Record<string, string | number | Date>)[bindName] = t.toUpperCase();
      applied[param] = t;
    };

    strEqTrimCi("hostname", "t.HOSTNAME", "v3a_hostname");
    const platformApplied = applyPlatformQueryFilter(
      q,
      clauses,
      applied,
      "t.HOSTNAME"
    );
    if (!platformApplied.ok) return platformApplied;

    strEqTrimCi("device", "t.DEVICE", "v3a_device");
    strEqTrimCi("lotId", "t.LOTID", "v3a_lotid");
    strEqTrimCi("wafer", "t.WAFER", "v3a_wafer");
    strEqTrimCi("probeCard", "t.PROBECARD", "v3a_probecard");

    const maskVal = firstString(firstQueryValue(q, "mask"));
    if (maskVal !== undefined && maskVal !== "") {
      const t = maskVal.trim();
      clauses.push(deviceMaskOracleWhere("t.DEVICE", "v3a_mask"));
      (binds as Record<string, string | number | Date>).v3a_mask = t;
      applied.mask = t;
    }

    const pctVal = firstString(firstQueryValue(q, "probeCardType"));
    if (pctVal !== undefined && pctVal !== "") {
      const t = pctVal.trim();
      clauses.push(
        `(UPPER(t.PROBECARD) = :v3a_pct OR UPPER(t.PROBECARD) LIKE :v3a_pct || '-%')`
      );
      (binds as Record<string, string | number | Date>).v3a_pct = t.toUpperCase();
      applied.probeCardType = t;
    }

    const passN = parseOptionalNumber(firstQueryValue(q, "pass"), "pass");
    if (passN !== undefined) {
      parseRequiredFiniteNumber(passN, "pass");
      clauses.push("t.PASS = :v3a_pass");
      binds.v3a_pass = passN;
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
      clauses.push("t.TIME_STAMP >= :v3a_ts_lo");
      binds.v3a_ts_lo = tsLo;
      if (firstQueryValue(q, "timeStampBegin") != null) {
        applied.timeStampBegin = tsLo.toISOString();
      } else {
        applied.timeStampFrom = tsLo.toISOString();
      }
    }
    if (tsHi !== undefined) {
      clauses.push("t.TIME_STAMP <= :v3a_ts_hi");
      binds.v3a_ts_hi = tsHi;
      if (firstQueryValue(q, "timeStampEnd") != null) {
        applied.timeStampEnd = tsHi.toISOString();
      } else {
        applied.timeStampTo = tsHi.toISOString();
      }
    }

    const yieldV3TimeQueryKeys = [
      "timeStampBegin",
      "timeStampFrom",
      "timeStampEnd",
      "timeStampTo",
    ] as const;
    const userTouchedYieldTime = yieldV3TimeQueryKeys.some(
      (k) => firstString(firstQueryValue(q, k)) !== undefined
    );
    if (!userTouchedYieldTime && tsLo === undefined && tsHi === undefined) {
      const { lo, hi } = v3DefaultThroughNowMinusOneUtcYear();
      clauses.push("t.TIME_STAMP >= :v3a_ts_lo");
      clauses.push("t.TIME_STAMP <= :v3a_ts_hi");
      (binds as Record<string, string | number | Date>).v3a_ts_lo = lo;
      (binds as Record<string, string | number | Date>).v3a_ts_hi = hi;
      applied.timeStampBegin = lo.toISOString();
      applied.timeStampEnd = hi.toISOString();
    }

    const whereSql =
      clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

    return { ok: true, whereSql, binds, applied };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: message };
  }
}
