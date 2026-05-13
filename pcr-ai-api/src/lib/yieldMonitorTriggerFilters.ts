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
