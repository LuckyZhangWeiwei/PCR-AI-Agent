import type { BindParameters } from "oracledb";
import { clampLimit } from "../sqlIdent.js";

/** 默认 Top；可通过 **`limit`** 查询参数覆盖（见 **`INFCONTROL_LAYER_BIN_V2_MAX_TOP`**） */
export const INFCONTROL_LAYER_BIN_V2_DEFAULT_TOP = 200;

/** `limit` 查询参数上限 */
export const INFCONTROL_LAYER_BIN_V2_MAX_TOP = 2000;

/** **`rankTop`**：返回 bad 合计最高的前 **N** 个 BIN 下标（默认 **10**，范围 **5–10**） */
export const INFCONTROL_LAYER_BIN_V2_BAD_RANK_DEFAULT = 10;

export const INFCONTROL_LAYER_BIN_V2_BAD_RANK_MIN = 5;
export const INFCONTROL_LAYER_BIN_V2_BAD_RANK_MAX = 10;

type ParseFail = { ok: false; error: string };

type V2WhereOk = {
  ok: true;
  whereSql: string;
  binds: BindParameters;
  applied: Record<string, unknown>;
};

type ParseOk = V2WhereOk & {
  limit: number;
};

type BadBinsOk = V2WhereOk & {
  rankTop: number;
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
 * **`rankTop`**：钳制到 **[INFCONTROL_LAYER_BIN_V2_BAD_RANK_MIN, INFCONTROL_LAYER_BIN_V2_BAD_RANK_MAX]**
 */
export function clampInfcontrolLayerBinV2BadRank(raw: unknown): number {
  const n = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n)) return INFCONTROL_LAYER_BIN_V2_BAD_RANK_DEFAULT;
  return Math.min(
    INFCONTROL_LAYER_BIN_V2_BAD_RANK_MAX,
    Math.max(INFCONTROL_LAYER_BIN_V2_BAD_RANK_MIN, n)
  );
}

/**
 * 与列表接口相同的 **WHERE**（无 **`limit`**）。
 */
export function parseInfcontrolLayerBinV2Where(
  q: Record<string, unknown>
): ParseFail | V2WhereOk {
  const clauses: string[] = [];
  const binds: BindParameters = {};
  const applied: Record<string, unknown> = {};

  try {
    const keynumber = parseOptionalNumber(
      firstQueryValue(q, "keynumber"),
      "keynumber"
    );
    if (keynumber !== undefined) {
      clauses.push("ic.KEYNUMBER = :v2_keynumber");
      binds.v2_keynumber = keynumber;
      applied.keynumber = keynumber;
    }

    const strEq = (param: string, columnSql: string, bindName: string) => {
      const v = firstString(firstQueryValue(q, param));
      if (v === undefined) return;
      const t = v.trim();
      if (t === "") return;
      clauses.push(`TRIM(${columnSql}) = :${bindName}`);
      (binds as Record<string, string | number | Date>)[bindName] = t;
      applied[param] = t;
    };

    strEq("device", "ic.DEVICE", "v2_device");
    strEq("lot", "ic.LOT", "v2_lot");
    strEq("meslot", "ic.MESLOT", "v2_meslot");
    strEq("notch", "ic.NOTCH", "v2_notch");
    strEq("testerId", "lb.TESTERID", "v2_testerid");
    strEq("tstype", "lb.TSTYPE", "v2_tstype");
    strEq("cardId", "lb.CARDID", "v2_cardid");
    strEq("pibId", "lb.PIBID", "v2_pibid");
    strEq("probe", "lb.PROBE", "v2_probe");

    const numEq = (param: string, columnSql: string, bindName: string) => {
      const n = parseOptionalNumber(firstQueryValue(q, param), param);
      if (n === undefined) return;
      parseRequiredFiniteNumber(n, param);
      clauses.push(`${columnSql} = :${bindName}`);
      (binds as Record<string, string | number | Date>)[bindName] = n;
      applied[param] = n;
    };

    numEq("slot", "ic.SLOT", "v2_slot");
    numEq("passId", "lb.PASSID", "v2_passid");

    const tsFrom = parseOptionalDate(
      firstQueryValue(q, "testStartFrom"),
      "testStartFrom"
    );
    const tsTo = parseOptionalDate(
      firstQueryValue(q, "testStartTo"),
      "testStartTo"
    );
    if (tsFrom !== undefined && tsTo !== undefined) {
      if (tsFrom > tsTo) {
        return { ok: false, error: "testStartFrom must be <= testStartTo" };
      }
    }
    if (tsFrom !== undefined) {
      clauses.push("lb.TESTSTART >= :v2_teststart_from");
      binds.v2_teststart_from = tsFrom;
      applied.testStartFrom = tsFrom.toISOString();
    }
    if (tsTo !== undefined) {
      clauses.push("lb.TESTSTART <= :v2_teststart_to");
      binds.v2_teststart_to = tsTo;
      applied.testStartTo = tsTo.toISOString();
    }

    const teFrom = parseOptionalDate(
      firstQueryValue(q, "testEndFrom"),
      "testEndFrom"
    );
    const teTo = parseOptionalDate(
      firstQueryValue(q, "testEndTo"),
      "testEndTo"
    );
    if (teFrom !== undefined && teTo !== undefined) {
      if (teFrom > teTo) {
        return { ok: false, error: "testEndFrom must be <= testEndTo" };
      }
    }
    if (teFrom !== undefined) {
      clauses.push("lb.TESTEND >= :v2_testend_from");
      binds.v2_testend_from = teFrom;
      applied.testEndFrom = teFrom.toISOString();
    }
    if (teTo !== undefined) {
      clauses.push("lb.TESTEND <= :v2_testend_to");
      binds.v2_testend_to = teTo;
      applied.testEndTo = teTo.toISOString();
    }

    const whereSql =
      clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

    /** v2 SQL 另固定 **`lb.PASSTYPE = TEST`**（见 `mergeV2WherePasstypeTest`） */
    applied.passtypeScope = "TEST";

    return { ok: true, whereSql, binds, applied };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: message };
  }
}

/**
 * v2：INFCONTROL ⋈ INFLAYERBINLIST，复合条件 **AND**。
 * **不提供** `bin*`、`passBin` 筛选；**PASSBIN** 仅用于响应内 **`bins[].isGoodBin`**。
 */
export function parseInfcontrolLayerBinV2Query(
  q: Record<string, unknown>
): ParseFail | ParseOk {
  const core = parseInfcontrolLayerBinV2Where(q);
  if (!core.ok) return core;

  try {
    const limit = clampLimit(
      firstQueryValue(q, "limit"),
      INFCONTROL_LAYER_BIN_V2_DEFAULT_TOP,
      INFCONTROL_LAYER_BIN_V2_MAX_TOP
    );
    const applied = { ...core.applied, limit };
    return {
      ok: true,
      whereSql: core.whereSql,
      binds: core.binds,
      applied,
      limit,
    };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: message };
  }
}

/**
 * 与 v2 相同筛选；**`rankTop`**（可选 **`badBinTop`**）默认 **10**，钳制 **5–10**：返回 bad 合计最高的前 **N** 个 BIN 下标。
 */
export function parseInfcontrolLayerBinV2BadBinsQuery(
  q: Record<string, unknown>
): ParseFail | BadBinsOk {
  const core = parseInfcontrolLayerBinV2Where(q);
  if (!core.ok) return core;

  const rankRaw =
    firstQueryValue(q, "rankTop") ?? firstQueryValue(q, "badBinTop");
  const rankTop = clampInfcontrolLayerBinV2BadRank(rankRaw);
  const applied = { ...core.applied, rankTop };

  return {
    ok: true,
    whereSql: core.whereSql,
    binds: core.binds,
    applied,
    rankTop,
  };
}
