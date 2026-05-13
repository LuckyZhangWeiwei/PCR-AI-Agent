import type { BindParameters } from "oracledb";

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
 * 解析逗号分隔整数，如 "1,3,5" → [1,3,5]
 */
function parseBinList(raw: unknown, label: string): number[] {
  const s = firstString(raw);
  if (s === undefined) return [];
  const parts = s.split(",").map((p) => p.trim()).filter(Boolean);
  const out: number[] = [];
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      throw new Error(`Invalid integer in ${label}: ${p}`);
    }
    out.push(n);
  }
  return out;
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

    const binRe = /^bin(\d+)$/i;
    for (const key of Object.keys(q)) {
      const m = key.match(binRe);
      if (!m) continue;
      const idx = Number(m[1]);
      if (!Number.isInteger(idx) || idx < 0 || idx > 255) {
        return { ok: false, error: `Invalid BIN index in query key: ${key}` };
      }
      const values = parseBinList(q[key], key);
      if (values.length === 0) continue;
      const placeholders = values
        .map((_, i) => `:f_bin_${idx}_${i}`)
        .join(", ");
      clauses.push(`lb.BIN${idx} IN (${placeholders})`);
      applied[`bin${idx}`] = values;
      const bb = binds as Record<string, string | number | Date>;
      values.forEach((v, i) => {
        bb[`f_bin_${idx}_${i}`] = v;
      });
    }

    const whereSql =
      clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

    return { ok: true, whereSql, binds, applied };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: message };
  }
}
