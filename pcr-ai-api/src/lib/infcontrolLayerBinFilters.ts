import type { BindParameters } from "oracledb";
import { deviceMaskOracleWhere } from "./deviceMask.js";
import { applyInfcontrolBinColumnFilters } from "./infcontrolBinColumnFilters.js";
import { v3DefaultThroughNowMinusOneUtcYear } from "./v3DefaultOneYearWindow.js";

/** 固定取前 200 条 */
export const INFCONTROL_LAYER_BIN_TOP = 200;

type ParseFail = { ok: false; error: string };
type ParseOk = {
  ok: true;
  whereSql: string;
  binds: BindParameters;
  applied: Record<string, unknown>;
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
 * 从 GET 查询对象解析 WHERE 与绑定变量（复合条件 AND）。
 * 支持的参数名不区分大小写。
 */
export function parseInfcontrolLayerBinQuery(
  q: Record<string, unknown>
): ParseFail | ParseOk {
  const clauses: string[] = [];
  const binds: BindParameters = {};
  const applied: Record<string, unknown> = {};

  try {
    const keynumber = parseOptionalNumber(
      firstQueryValue(q, "keynumber"),
      "keynumber"
    );
    if (keynumber !== undefined) {
      clauses.push("ic.KEYNUMBER = :f_keynumber");
      binds.f_keynumber = keynumber;
      applied.keynumber = keynumber;
    }

    /** 字符串相等：输入与库端均 TRIM，避免空格导致筛不住或误匹配 */
    const strEq = (param: string, columnSql: string, bindName: string) => {
      const v = firstString(firstQueryValue(q, param));
      if (v === undefined) return;
      const t = v.trim();
      if (t === "") return;
      clauses.push(`TRIM(${columnSql}) = :${bindName}`);
      (binds as Record<string, string | number | Date>)[bindName] = t;
      applied[param] = t;
    };

    strEq("device", "ic.DEVICE", "f_device");
    strEq("lot", "ic.LOT", "f_lot");
    strEq("meslot", "ic.MESLOT", "f_meslot");
    strEq("testerId", "lb.TESTERID", "f_testerid");
    strEq("tstype", "lb.TSTYPE", "f_tstype");
    strEq("cardId", "lb.CARDID", "f_cardid");
    strEq("pibId", "lb.PIBID", "f_pibid");
    strEq("probe", "lb.PROBE", "f_probe");
    strEq("layerName", "lb.LAYERNAME", "f_layername");
    strEq("passResume", "lb.PASSRESUME", "f_passresume");
    strEq("passResult", "lb.PASSRESULT", "f_passresult");
    strEq("passType", "lb.PASSTYPE", "f_passtype");
    strEq("passBin", "lb.PASSBIN", "f_passbin");

    const numEq = (param: string, columnSql: string, bindName: string) => {
      const n = parseOptionalNumber(firstQueryValue(q, param), param);
      if (n === undefined) return;
      parseRequiredFiniteNumber(n, param);
      clauses.push(`${columnSql} = :${bindName}`);
      (binds as Record<string, string | number | Date>)[bindName] = n;
      applied[param] = n;
    };

    numEq("slot", "ic.SLOT", "f_slot");
    numEq("pdpw", "ic.PDPW", "f_pdpw");
    numEq("grossDie", "lb.GROSSDIE", "f_grossdie");
    numEq("passId", "lb.PASSID", "f_passid");
    numEq("sessionNumber", "lb.SESSIONNUMBER", "f_sessionnumber");
    numEq("passNum", "lb.PASSNUM", "f_passnum");

    const tsFrom = parseOptionalDate(firstQueryValue(q, "testStartFrom"), "testStartFrom");
    const tsTo = parseOptionalDate(firstQueryValue(q, "testStartTo"), "testStartTo");
    if (tsFrom !== undefined && tsTo !== undefined) {
      if (tsFrom > tsTo) {
        return { ok: false, error: "testStartFrom must be <= testStartTo" };
      }
    }
    if (tsFrom !== undefined) {
      clauses.push("lb.TESTSTART >= :f_teststart_from");
      binds.f_teststart_from = tsFrom;
      applied.testStartFrom = tsFrom.toISOString();
    }
    if (tsTo !== undefined) {
      clauses.push("lb.TESTSTART <= :f_teststart_to");
      binds.f_teststart_to = tsTo;
      applied.testStartTo = tsTo.toISOString();
    }

    const teFrom = parseOptionalDate(firstQueryValue(q, "testEndFrom"), "testEndFrom");
    const teTo = parseOptionalDate(firstQueryValue(q, "testEndTo"), "testEndTo");
    if (teFrom !== undefined && teTo !== undefined) {
      if (teFrom > teTo) {
        return { ok: false, error: "testEndFrom must be <= testEndTo" };
      }
    }
    if (teFrom !== undefined) {
      clauses.push("lb.TESTEND >= :f_testend_from");
      binds.f_testend_from = teFrom;
      applied.testEndFrom = teFrom.toISOString();
    }
    if (teTo !== undefined) {
      clauses.push("lb.TESTEND <= :f_testend_to");
      binds.f_testend_to = teTo;
      applied.testEndTo = teTo.toISOString();
    }

    const binApplied = applyInfcontrolBinColumnFilters(
      q,
      clauses,
      binds,
      applied,
      "lb."
    );
    if (!binApplied.ok) return binApplied;

    const whereSql =
      clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

    return { ok: true, whereSql, binds, applied };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: message };
  }
}

export type ParseInfcontrolLayerBinsV3Fail = { ok: false; error: string };
export type ParseInfcontrolLayerBinsV3Ok = {
  ok: true;
  whereAndSql: string;
  binds: BindParameters;
  applied: Record<string, unknown>;
};

/**
 * **v3** `GET /infcontrol-layer-bins/v3`：在 `PASSTYPE='TEST'` 之上追加 AND 条件（绑定变量）。
 * 字符串列使用 `UPPER(TRIM(列)) = UPPER(:bind)`，与库内实际大小写（如样例表 `docs/JBStart.xlsx`）无关地匹配。
 * **默认时间窗**：若请求未携带任一 **TESTSTART / TESTEND** 相关查询键（`testStart*`、`testEnd*` 共 8 个），则追加 **`t2.TESTEND`** 在 **UTC 当前时刻起向前一个日历年**内（与 **`v3DefaultThroughNowMinusOneUtcYear`** 一致）。
 */
export function parseInfcontrolLayerBinsV3Query(
  q: Record<string, unknown>
): ParseInfcontrolLayerBinsV3Fail | ParseInfcontrolLayerBinsV3Ok {
  const clauses: string[] = [];
  const binds: BindParameters = {};
  const applied: Record<string, unknown> = {};

  try {
    const strEqTrimCi = (param: string, columnSql: string, bindName: string) => {
      const v = firstString(firstQueryValue(q, param));
      if (v === undefined) return;
      const t = v.trim();
      if (t === "") return;
      clauses.push(`UPPER(TRIM(${columnSql})) = UPPER(:${bindName})`);
      (binds as Record<string, string | number | Date>)[bindName] = t;
      applied[param] = t;
    };

    // Exclude internal/test lots starting with kk, gg, or c (case-insensitive)
    clauses.push(`NOT REGEXP_LIKE(t1.LOT, '^(kk|gg|c)', 'i')`);

    strEqTrimCi("device", "t1.DEVICE", "ic3_device");
    strEqTrimCi("lot", "t1.LOT", "ic3_lot");
    strEqTrimCi("meslot", "t1.MESLOT", "ic3_meslot");
    strEqTrimCi("testerId", "t2.TESTERID", "ic3_testerid");
    strEqTrimCi("tstype", "t2.TSTYPE", "ic3_tstype");
    strEqTrimCi("cardId", "t2.CARDID", "ic3_cardid");

    // mask is last-4-chars of DEVICE base segment (computed suffix; not a DB column)
    const maskVal = firstString(firstQueryValue(q, "mask"));
    if (maskVal !== undefined && maskVal !== "") {
      const t = maskVal.trim();
      clauses.push(deviceMaskOracleWhere("t1.DEVICE", "ic3_mask"));
      (binds as Record<string, string | number | Date>).ic3_mask = t;
      applied.mask = t;
    }

    // probeCardType is derived (prefix of CARDID before first '-'); filter as equality OR prefix match
    const pctVal = firstString(firstQueryValue(q, "probeCardType"));
    if (pctVal !== undefined && pctVal !== "") {
      const t = pctVal.trim();
      clauses.push(
        `(UPPER(TRIM(t2.CARDID)) = UPPER(:ic3_pct) OR UPPER(TRIM(t2.CARDID)) LIKE UPPER(:ic3_pct) || '-%')`
      );
      (binds as Record<string, string | number | Date>).ic3_pct = t;
      applied.probeCardType = t;
    }

    const slotN = parseOptionalNumber(firstQueryValue(q, "slot"), "slot");
    if (slotN !== undefined) {
      parseRequiredFiniteNumber(slotN, "slot");
      clauses.push("t1.SLOT = :ic3_slot");
      binds.ic3_slot = slotN;
      applied.slot = slotN;
    }

    const passIdN = parseOptionalNumber(firstQueryValue(q, "passId"), "passId");
    if (passIdN !== undefined) {
      parseRequiredFiniteNumber(passIdN, "passId");
      clauses.push("t2.PASSID = :ic3_passid");
      binds.ic3_passid = passIdN;
      applied.passId = passIdN;
    }

    const testStartLo =
      parseOptionalDate(
        firstQueryValue(q, "testStartBegin"),
        "testStartBegin"
      ) ??
      parseOptionalDate(
        firstQueryValue(q, "testStartFrom"),
        "testStartFrom"
      );
    const testStartHi =
      parseOptionalDate(firstQueryValue(q, "testStartEnd"), "testStartEnd") ??
      parseOptionalDate(firstQueryValue(q, "testStartTo"), "testStartTo");
    if (
      testStartLo !== undefined &&
      testStartHi !== undefined &&
      testStartLo > testStartHi
    ) {
      return {
        ok: false,
        error:
          "TESTSTART window: lower bound must be <= upper bound (testStartBegin/testStartEnd or testStartFrom/testStartTo)",
      };
    }
    if (testStartLo !== undefined) {
      clauses.push("t2.TESTSTART >= :ic3_teststart_lo");
      binds.ic3_teststart_lo = testStartLo;
      if (firstQueryValue(q, "testStartBegin") != null) {
        applied.testStartBegin = testStartLo.toISOString();
      } else {
        applied.testStartFrom = testStartLo.toISOString();
      }
    }
    if (testStartHi !== undefined) {
      clauses.push("t2.TESTSTART <= :ic3_teststart_hi");
      binds.ic3_teststart_hi = testStartHi;
      if (firstQueryValue(q, "testStartEnd") != null) {
        applied.testStartEnd = testStartHi.toISOString();
      } else {
        applied.testStartTo = testStartHi.toISOString();
      }
    }

    const testEndLo =
      parseOptionalDate(firstQueryValue(q, "testEndBegin"), "testEndBegin") ??
      parseOptionalDate(firstQueryValue(q, "testEndFrom"), "testEndFrom");
    const testEndHi =
      parseOptionalDate(firstQueryValue(q, "testEndEnd"), "testEndEnd") ??
      parseOptionalDate(firstQueryValue(q, "testEndTo"), "testEndTo");
    if (
      testEndLo !== undefined &&
      testEndHi !== undefined &&
      testEndLo > testEndHi
    ) {
      return {
        ok: false,
        error:
          "TESTEND window: lower bound must be <= upper bound (testEndBegin/testEndEnd or testEndFrom/testEndTo)",
      };
    }
    if (testEndLo !== undefined) {
      clauses.push("t2.TESTEND >= :ic3_testend_lo");
      binds.ic3_testend_lo = testEndLo;
      if (firstQueryValue(q, "testEndBegin") != null) {
        applied.testEndBegin = testEndLo.toISOString();
      } else {
        applied.testEndFrom = testEndLo.toISOString();
      }
    }
    if (testEndHi !== undefined) {
      clauses.push("t2.TESTEND <= :ic3_testend_hi");
      binds.ic3_testend_hi = testEndHi;
      if (firstQueryValue(q, "testEndEnd") != null) {
        applied.testEndEnd = testEndHi.toISOString();
      } else {
        applied.testEndTo = testEndHi.toISOString();
      }
    }

    const infcontrolV3TimeQueryKeys = [
      "testStartBegin",
      "testStartFrom",
      "testStartEnd",
      "testStartTo",
      "testEndBegin",
      "testEndFrom",
      "testEndEnd",
      "testEndTo",
    ] as const;
    const userTouchedTimeParams = infcontrolV3TimeQueryKeys.some(
      (k) => firstString(firstQueryValue(q, k)) !== undefined
    );
    if (
      !userTouchedTimeParams &&
      testStartLo === undefined &&
      testStartHi === undefined &&
      testEndLo === undefined &&
      testEndHi === undefined
    ) {
      const { lo, hi } = v3DefaultThroughNowMinusOneUtcYear();
      clauses.push("t2.TESTEND >= :ic3_testend_lo");
      clauses.push("t2.TESTEND <= :ic3_testend_hi");
      (binds as Record<string, string | number | Date>).ic3_testend_lo = lo;
      (binds as Record<string, string | number | Date>).ic3_testend_hi = hi;
      applied.testEndBegin = lo.toISOString();
      applied.testEndEnd = hi.toISOString();
    }

    const binApplied = applyInfcontrolBinColumnFilters(
      q,
      clauses,
      binds,
      applied,
      "t2."
    );
    if (!binApplied.ok) return binApplied;

    const whereAndSql = clauses.join(" AND ");
    return { ok: true, whereAndSql, binds, applied };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: message };
  }
}
