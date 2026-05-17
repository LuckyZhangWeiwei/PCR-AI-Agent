import {
  INFCONTROL_LAYER_BIN_AGGREGATE_KEY_SEP,
  type InfcontrolLayerBinGroupBy,
} from "./infcontrolLayerBinAggregate.js";
import { INFCONTROL_LAYER_BIN_TOP } from "./infcontrolLayerBinFilters.js";
import {
  binColumnIndexIsGood,
  parsePassBinHyphenGoodBins,
} from "./passBinSemantics.js";
import { loadInfcontrolLayerBinRowsFromJbStartXlsx } from "./dummyRowsFromExcel.js";
import { listApisForceOracleNoDummy } from "./listDummyRuntime.js";
import { probeCardTypeLeadingSegment } from "./probeCardTypeLeadingSegment.js";

/**
 * 与 INFCONTROL ⋈ INFLAYERBINLIST 查询列一致（Oracle 列名大写，含 BIN0…BIN255）。
 * 索引签名便于填充 256 个 BIN 列。
 */
export interface InfcontrolLayerBinDummyRow {
  [key: string]: string | number | null | undefined;
  KEYNUMBER: number;
  DEVICE: string;
  LOT: string;
  CASSETTE: string;
  SLOT: number;
  NOTCH: string;
  MAPROWS: number;
  MAPCOLS: number;
  SAMPLETESTNUMBER: number;
  PDPW: number;
  MESLOT: string;
  TESTERID: string;
  TSTYPE: string;
  CARDID: string;
  PIBID: string;
  PROBE: string;
  GROSSDIE: number;
  PASSID: number;
  SESSIONNUMBER: number;
  PASSNUM: number;
  TESTSTART: string;
  TESTEND: string;
  LAYERNAME: string;
  PASSRESUME: string;
  PASSRESULT: string;
  PASSTYPE: string;
  PASSBIN: string;
  /** v3：由 **`filterInfcontrolLayerBinV3DummyRowsMatching`** 写入，与列表 **`PROBECARDTYPE`** 同源 */
  PROBECARDTYPE?: string | null;
}

/**
 * Dummy 联调：查询串由 **`docs/JBStart.xlsx` Sheet1 首行** 推导（`device/lot/slot/tstype/cardId` + 该行 `TESTEND` 所在自然月的 `testEndFrom`/`testEndTo`），保证至少一行命中。
 */
function buildInfcontrolDummyExampleQuery(
  first: InfcontrolLayerBinDummyRow
): string {
  const testEnd = new Date(String(first.TESTEND));
  const y = Number.isNaN(testEnd.getTime())
    ? 2026
    : testEnd.getUTCFullYear();
  const m = Number.isNaN(testEnd.getTime()) ? 0 : testEnd.getUTCMonth();
  const testEndFrom = new Date(Date.UTC(y, m, 1)).toISOString();
  const testEndTo = new Date(
    Date.UTC(y, m + 1, 0, 23, 59, 59, 999)
  ).toISOString();
  return new URLSearchParams({
    device: String(first.DEVICE),
    lot: String(first.LOT),
    slot: String(first.SLOT),
    tstype: String(first.TSTYPE),
    cardId: String(first.CARDID),
    testEndFrom,
    testEndTo,
  }).toString();
}

/** manifest 等在「强制 Oracle」时使用的占位查询串（不读 `docs/JBStart.xlsx`） */
const MANIFEST_INFCONTROL_EXAMPLE_FALLBACK =
  "device=WA00P69K&lot=DR39000.1N&slot=1&tstype=CP&cardId=9400-01&testEndFrom=2026-01-01T00:00:00.000Z&testEndTo=2026-01-31T23:59:59.999Z";

let _jbDummyRowsCache: readonly InfcontrolLayerBinDummyRow[] | undefined;

function getInfcontrolLayerBinDummyRowsInternal(): readonly InfcontrolLayerBinDummyRow[] {
  if (_jbDummyRowsCache !== undefined) return _jbDummyRowsCache;
  if (listApisForceOracleNoDummy()) {
    _jbDummyRowsCache = Object.freeze([]);
    return _jbDummyRowsCache;
  }
  _jbDummyRowsCache = Object.freeze(
    loadInfcontrolLayerBinRowsFromJbStartXlsx().slice(0, INFCONTROL_LAYER_BIN_TOP)
  );
  return _jbDummyRowsCache;
}

/** 来自 `docs/JBStart.xlsx`（至多 **INFCONTROL_LAYER_BIN_TOP** 条）；仅 Dummy 模式会加载 */
export function getInfcontrolLayerBinDummyRows(): readonly InfcontrolLayerBinDummyRow[] {
  return getInfcontrolLayerBinDummyRowsInternal();
}

/** manifest `example` 等：Dummy 时由 Excel 首行推导；`dist`/production 下为占位串 */
export function getInfcontrolDummyExampleQuery(): string {
  if (listApisForceOracleNoDummy()) return MANIFEST_INFCONTROL_EXAMPLE_FALLBACK;
  const rows = getInfcontrolLayerBinDummyRowsInternal();
  if (!rows.length) return MANIFEST_INFCONTROL_EXAMPLE_FALLBACK;
  return buildInfcontrolDummyExampleQuery(rows[0]!);
}

function infcontrolLayerBinsDummyEnvTrue(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * 测试或本地无库时使用内存样本，不连 Oracle。
 * **`npm run build` 后的 `dist` 进程** 或 **`NODE_ENV=production`** 时恒为 **false**（走库，忽略 `INFCONTROL_LAYER_BINS_DUMMY`）。
 */
export function infcontrolLayerBinsUseDummy(): boolean {
  if (listApisForceOracleNoDummy()) return false;
  if (process.env.NODE_ENV === "test") return true;
  return infcontrolLayerBinsDummyEnvTrue(
    process.env.INFCONTROL_LAYER_BINS_DUMMY
  );
}

/** 与 parseInfcontrolLayerBinQuery / SQL WHERE 等价，不限 200 条（供聚合） */
export function filterInfcontrolLayerDummyRowsMatching(
  applied: Record<string, unknown>
): InfcontrolLayerBinDummyRow[] {
  let rows = [...getInfcontrolLayerBinDummyRowsInternal()];

  const eqStr = (column: string, param: string) => {
    const v = applied[param];
    if (v === undefined) return;
    const s = String(v);
    rows = rows.filter((r) => String(r[column]) === s);
  };

  eqStr("DEVICE", "device");
  eqStr("LOT", "lot");
  eqStr("MESLOT", "meslot");
  eqStr("TESTERID", "testerId");
  eqStr("TSTYPE", "tstype");
  eqStr("CARDID", "cardId");
  eqStr("PIBID", "pibId");
  eqStr("PROBE", "probe");
  eqStr("LAYERNAME", "layerName");
  eqStr("PASSRESUME", "passResume");
  eqStr("PASSRESULT", "passResult");
  eqStr("PASSTYPE", "passType");
  eqStr("PASSBIN", "passBin");

  const eqNum = (column: string, param: string) => {
    const v = applied[param];
    if (v === undefined) return;
    const n = Number(v);
    rows = rows.filter((r) => Number(r[column]) === n);
  };

  eqNum("KEYNUMBER", "keynumber");
  eqNum("SLOT", "slot");
  eqNum("PDPW", "pdpw");
  eqNum("GROSSDIE", "grossDie");
  eqNum("PASSID", "passId");
  eqNum("SESSIONNUMBER", "sessionNumber");
  eqNum("PASSNUM", "passNum");

  if (applied.testStartFrom !== undefined) {
    const from = new Date(String(applied.testStartFrom)).getTime();
    rows = rows.filter(
      (r) => new Date(String(r.TESTSTART)).getTime() >= from
    );
  }
  if (applied.testStartTo !== undefined) {
    const to = new Date(String(applied.testStartTo)).getTime();
    rows = rows.filter((r) => new Date(String(r.TESTSTART)).getTime() <= to);
  }
  if (applied.testEndFrom !== undefined) {
    const from = new Date(String(applied.testEndFrom)).getTime();
    rows = rows.filter((r) => new Date(String(r.TESTEND)).getTime() >= from);
  }
  if (applied.testEndTo !== undefined) {
    const to = new Date(String(applied.testEndTo)).getTime();
    rows = rows.filter((r) => new Date(String(r.TESTEND)).getTime() <= to);
  }

  for (const key of Object.keys(applied)) {
    const m = key.match(/^bin(\d+)$/i);
    if (!m) continue;
    const idx = m[1];
    const values = applied[key];
    if (!Array.isArray(values) || values.length === 0) continue;
    const col = `BIN${idx}`;
    const set = new Set(values.map((x) => Number(x)));
    rows = rows.filter((r) => set.has(Number(r[col])));
  }

  return rows;
}

export function filterInfcontrolLayerDummyRows(
  applied: Record<string, unknown>
): InfcontrolLayerBinDummyRow[] {
  let rows = filterInfcontrolLayerDummyRowsMatching(applied);
  rows.sort((a, b) => {
    const tb = new Date(String(b.TESTEND)).getTime();
    const ta = new Date(String(a.TESTEND)).getTime();
    if (tb !== ta) return tb - ta;
    return b.KEYNUMBER - a.KEYNUMBER;
  });

  return rows.slice(0, INFCONTROL_LAYER_BIN_TOP);
}

/** v2：与 **`parseInfcontrolLayerBinV2Query`** 等价筛选（无 bin* / passBin）；**PASSTYPE=TEST** 与 Oracle 固定条件一致 */
export function filterInfcontrolLayerBinV2DummyRows(
  applied: Record<string, unknown>,
  limit: number
): InfcontrolLayerBinDummyRow[] {
  let rows = [...getInfcontrolLayerBinDummyRowsInternal()].filter(
    (r) => String(r.PASSTYPE).trim() === "TEST"
  );

  const eqStr = (column: string, param: string) => {
    const v = applied[param];
    if (v === undefined) return;
    const s = String(v);
    rows = rows.filter((r) => String(r[column]) === s);
  };

  eqStr("DEVICE", "device");
  eqStr("LOT", "lot");
  eqStr("MESLOT", "meslot");
  eqStr("NOTCH", "notch");
  eqStr("TESTERID", "testerId");
  eqStr("TSTYPE", "tstype");
  eqStr("CARDID", "cardId");
  eqStr("PIBID", "pibId");
  eqStr("PROBE", "probe");

  const eqNum = (column: string, param: string) => {
    const v = applied[param];
    if (v === undefined) return;
    const n = Number(v);
    rows = rows.filter((r) => Number(r[column]) === n);
  };

  eqNum("KEYNUMBER", "keynumber");
  eqNum("SLOT", "slot");
  eqNum("PASSID", "passId");

  if (applied.testStartFrom !== undefined) {
    const from = new Date(String(applied.testStartFrom)).getTime();
    rows = rows.filter(
      (r) => new Date(String(r.TESTSTART)).getTime() >= from
    );
  }
  if (applied.testStartTo !== undefined) {
    const to = new Date(String(applied.testStartTo)).getTime();
    rows = rows.filter((r) => new Date(String(r.TESTSTART)).getTime() <= to);
  }
  if (applied.testEndFrom !== undefined) {
    const from = new Date(String(applied.testEndFrom)).getTime();
    rows = rows.filter((r) => new Date(String(r.TESTEND)).getTime() >= from);
  }
  if (applied.testEndTo !== undefined) {
    const to = new Date(String(applied.testEndTo)).getTime();
    rows = rows.filter((r) => new Date(String(r.TESTEND)).getTime() <= to);
  }

  rows.sort((a, b) => {
    const tb = new Date(String(b.TESTEND)).getTime();
    const ta = new Date(String(a.TESTEND)).getTime();
    if (tb !== ta) return tb - ta;
    return b.KEYNUMBER - a.KEYNUMBER;
  });

  const cap =
    Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : INFCONTROL_LAYER_BIN_TOP;
  return rows.slice(0, cap);
}

/**
 * 对单行：按 **PASSBIN** **`-`** 分隔的 good 下标排除后，对每个 **坏 bin** 列调用 **`on(binIdx, die)`**（die>0）。
 * 与 Oracle **`REGEXP_LIKE '(^|-)k(-|$)'`**（v3 aggregate）、**`aggregateInfcontrolLayerBinV2BadBinsDummy`** 语义一致。
 */
function forEachBadBinDieContribution(
  row: InfcontrolLayerBinDummyRow,
  on: (binIdx: number, die: number) => void
): void {
  const good = parsePassBinHyphenGoodBins(row.PASSBIN);
  for (let k = 0; k < 256; k++) {
    if (good.has(k)) continue;
    const raw = row[`BIN${k}`];
    if (raw == null || raw === "") continue;
    const v = Number(raw);
    if (!Number.isFinite(v) || v === 0) continue;
    on(k, v);
  }
}

/** v2 bad-bin 排行：与 Oracle **`REGEXP_LIKE` + SUM** 语义一致（dummy 全表匹配行上累计） */
export function aggregateInfcontrolLayerBinV2BadBinsDummy(
  applied: Record<string, unknown>,
  rankTop: number
): { n: number; badTotal: number }[] {
  const rows = filterInfcontrolLayerBinV2DummyRows(applied, 1_000_000);
  const totals = new Array<number>(256).fill(0);

  for (const row of rows) {
    forEachBadBinDieContribution(row, (k, v) => {
      totals[k] += v;
    });
  }

  const pairs = totals.map((badTotal, n) => ({ n, badTotal }));
  pairs.sort((a, b) => {
    if (b.badTotal !== a.badTotal) return b.badTotal - a.badTotal;
    return a.n - b.n;
  });
  return pairs.slice(0, rankTop);
}

export type InfcontrolLayerBinDummyAggregateGroup = {
  key: string;
  /** 与 Oracle 一致：各 BIN 列数值之和（先 UNPIVOT 再 SUM） */
  count: number;
  parts: Record<string, string>;
};

function valueForInfcontrolDimension(
  row: InfcontrolLayerBinDummyRow,
  d: InfcontrolLayerBinGroupBy
): string {
  if (d === "bin") {
    throw new Error("bin handled separately");
  }
  switch (d) {
    case "device":
      return String(row.DEVICE);
    case "lot":
      return String(row.LOT);
    case "meslot":
      return String(row.MESLOT);
    case "testerId":
      return String(row.TESTERID);
    case "tstype":
      return String(row.TSTYPE);
    case "cardId":
      return String(row.CARDID);
    case "probeCardType": {
      const v = row.PROBECARDTYPE;
      if (v !== undefined && v !== null && v !== "") return String(v);
      return probeCardTypeLeadingSegment(row.CARDID) ?? "";
    }
    case "pibId":
      return String(row.PIBID);
    case "probe":
      return String(row.PROBE);
    case "probeCard":
      return String(row.PROBE);
    case "layerName":
      return String(row.LAYERNAME);
    case "passResume":
      return String(row.PASSRESUME);
    case "passResult":
      return String(row.PASSRESULT);
    case "passType":
      return String(row.PASSTYPE);
    case "passBin":
      return String(row.PASSBIN);
    case "keynumber":
      return String(row.KEYNUMBER);
    case "slot":
      return String(row.SLOT);
    case "pdpw":
      return String(row.PDPW);
    case "grossDie":
      return String(row.GROSSDIE);
    case "passId":
      return String(row.PASSID);
    case "sessionNumber":
      return String(row.SESSIONNUMBER);
    case "passNum":
      return String(row.PASSNUM);
    default: {
      const _e: never = d;
      return _e;
    }
  }
}

/** 筛选后全集上按 BIN 列求和并取 Top groupTop（与 Oracle UNPIVOT + SUM 语义一致） */
export function aggregateInfcontrolLayerBinDummyRows(
  applied: Record<string, unknown>,
  groupBy: InfcontrolLayerBinGroupBy[],
  groupTop: number
): {
  totalRowsMatching: number;
  groups: InfcontrolLayerBinDummyAggregateGroup[];
} {
  const rows = filterInfcontrolLayerDummyRowsMatching(applied);
  const sums = new Map<string, number>();
  const firstParts = new Map<string, Record<string, string>>();

  for (const row of rows) {
    for (let binIdx = 0; binIdx < 256; binIdx++) {
      if (binIdx === 1) continue;
      if (binColumnIndexIsGood(row.PASSBIN, binIdx)) continue;
      const rawVal = row[`BIN${binIdx}`];
      /** 与 Oracle UNPIVOT EXCLUDE NULLS 一致：BIN(n) 为 null 不参与聚合、不出现在 groups */
      if (rawVal == null || rawVal === "") continue;
      const add = Number(rawVal);
      if (!Number.isFinite(add)) continue;

      const parts: Record<string, string> = {};
      for (const d of groupBy) {
        if (d === "bin") {
          parts[d] = String(binIdx);
        } else {
          parts[d] = valueForInfcontrolDimension(row, d);
        }
      }
      const key = groupBy
        .map((d) => parts[d])
        .join(INFCONTROL_LAYER_BIN_AGGREGATE_KEY_SEP);
      sums.set(key, (sums.get(key) ?? 0) + add);
      if (!firstParts.has(key)) {
        firstParts.set(key, parts);
      }
    }
  }

  const groups = [...sums.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, groupTop)
    .map(([key, count]) => ({
      key,
      count,
      parts: firstParts.get(key) ?? {},
    }));

  return { totalRowsMatching: rows.length, groups };
}

/** v3：与 `parseInfcontrolLayerBinsV3Query` 的 applied 键一致；**PASSTYPE=TEST**；字符串等价 Oracle **`UPPER(TRIM)`**（Dummy 内用 trim + toUpperCase）。每行附 **`PROBECARDTYPE`**（与列表 / 聚合维度同源）。 */
export function filterInfcontrolLayerBinV3DummyRowsMatching(
  applied: Record<string, unknown>
): Array<InfcontrolLayerBinDummyRow & { PROBECARDTYPE: string | null }> {
  let rows = [...getInfcontrolLayerBinDummyRowsInternal()].filter(
    (r) =>
      String(r.PASSTYPE).trim().toUpperCase() === "TEST" &&
      !["kk", "gg", "c"].some((pfx) =>
        String(r.LOT ?? "").trim().toLowerCase().startsWith(pfx)
      )
  );

  const ci = (col: string, param: string) => {
    const v = applied[param];
    if (v === undefined) return;
    const want = String(v).trim().toUpperCase();
    rows = rows.filter((r) => String(r[col]).trim().toUpperCase() === want);
  };

  ci("DEVICE", "device");
  ci("LOT", "lot");
  ci("MESLOT", "meslot");
  ci("TESTERID", "testerId");
  ci("TSTYPE", "tstype");
  ci("CARDID", "cardId");

  if (applied.probeCardType !== undefined) {
    const want = String(applied.probeCardType).trim().toUpperCase();
    rows = rows.filter((r) => {
      const cid = String(r.CARDID).trim().toUpperCase();
      return cid === want || cid.startsWith(want + "-");
    });
  }

  if (applied.slot !== undefined) {
    const n = Number(applied.slot);
    rows = rows.filter((r) => Number(r.SLOT) === n);
  }
  if (applied.passId !== undefined) {
    const n = Number(applied.passId);
    rows = rows.filter((r) => Number(r.PASSID) === n);
  }

  const tsLo = applied.testStartBegin ?? applied.testStartFrom;
  const tsHi = applied.testStartEnd ?? applied.testStartTo;
  const teLo = applied.testEndBegin ?? applied.testEndFrom;
  const teHi = applied.testEndEnd ?? applied.testEndTo;

  if (tsLo !== undefined || tsHi !== undefined || teLo !== undefined || teHi !== undefined) {
    // Dummy data has fixed historical timestamps. Shift filter bounds so that
    // relative queries like "last 7 days" always hit data in dummy mode.
    const maxTs = rows.reduce(
      (m, r) => Math.max(m, new Date(String(r.TESTEND)).getTime()), 0
    );
    const offset = maxTs > 0 ? Date.now() - maxTs : 0;
    if (tsLo !== undefined) {
      const from = new Date(String(tsLo)).getTime() - offset;
      rows = rows.filter((r) => new Date(String(r.TESTSTART)).getTime() >= from);
    }
    if (tsHi !== undefined) {
      const to = new Date(String(tsHi)).getTime() - offset;
      rows = rows.filter((r) => new Date(String(r.TESTSTART)).getTime() <= to);
    }
    if (teLo !== undefined) {
      const from = new Date(String(teLo)).getTime() - offset;
      rows = rows.filter((r) => new Date(String(r.TESTEND)).getTime() >= from);
    }
    if (teHi !== undefined) {
      const to = new Date(String(teHi)).getTime() - offset;
      rows = rows.filter((r) => new Date(String(r.TESTEND)).getTime() <= to);
    }
  }

  return rows.map((r) => ({
    ...r,
    PROBECARDTYPE: probeCardTypeLeadingSegment(r.CARDID),
  }));
}

/** v3 列表 Dummy：在 **`filterInfcontrolLayerBinV3DummyRowsMatching`** 结果上排序，再 **`limit`** 截断（**`PROBECARDTYPE`** 已在 matching 阶段写入）。 */
export function filterInfcontrolLayerBinV3DummyRows(
  applied: Record<string, unknown>,
  limit: number
): Array<InfcontrolLayerBinDummyRow & { PROBECARDTYPE: string | null }> {
  let rows = filterInfcontrolLayerBinV3DummyRowsMatching(applied);
  rows.sort((a, b) => {
    const tb = new Date(String(b.TESTEND)).getTime();
    const ta = new Date(String(a.TESTEND)).getTime();
    if (tb !== ta) return tb - ta;
    if (Number(b.SLOT) !== Number(a.SLOT)) return Number(b.SLOT) - Number(a.SLOT);
    if (Number(b.PASSID) !== Number(a.PASSID))
      return Number(b.PASSID) - Number(a.PASSID);
    return Number(b.PASSNUM) - Number(a.PASSNUM);
  });
  const cap =
    Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : INFCONTROL_LAYER_BIN_TOP;
  return rows.slice(0, cap);
}

/**
 * 在**已筛选**的行集上执行与 **`/infcontrol-layer-bins/v3/aggregate`** Dummy / Oracle **`v3-hyphen-tokens`** 等价的坏-bin **SUM**（**`forEachBadBinDieContribution`**）。
 * 行须仍含顶层 **`BINn`** 与 **`PASSBIN`**（未经过 **`enrichInfcontrolLayerBinRowV2`** 剥离 BIN 列）。
 */
export function aggregateInfcontrolLayerBinV3FromRows(
  rows: InfcontrolLayerBinDummyRow[],
  groupBy: InfcontrolLayerBinGroupBy[],
  groupTop: number
): {
  totalRowsMatching: number;
  groups: InfcontrolLayerBinDummyAggregateGroup[];
} {
  const sums = new Map<string, number>();
  const firstParts = new Map<string, Record<string, string>>();

  for (const row of rows) {
    forEachBadBinDieContribution(row, (binIdx, add) => {
      const parts: Record<string, string> = {};
      for (const d of groupBy) {
        if (d === "bin") {
          parts[d] = String(binIdx);
        } else {
          parts[d] = valueForInfcontrolDimension(row, d);
        }
      }
      const key = groupBy
        .map((d) => parts[d])
        .join(INFCONTROL_LAYER_BIN_AGGREGATE_KEY_SEP);
      sums.set(key, (sums.get(key) ?? 0) + add);
      if (!firstParts.has(key)) {
        firstParts.set(key, parts);
      }
    });
  }

  const groups = [...sums.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, groupTop)
    .map(([key, count]) => ({
      key,
      count,
      parts: firstParts.get(key) ?? {},
    }));

  return { totalRowsMatching: rows.length, groups };
}

/** v3 聚合 Dummy：与 Oracle **`v3-hyphen-tokens`** 及 **`forEachBadBinDieContribution`**（同 v2 top-bad-bins dummy）一致。 */
export function aggregateInfcontrolLayerBinV3DummyRows(
  applied: Record<string, unknown>,
  groupBy: InfcontrolLayerBinGroupBy[],
  groupTop: number
): {
  totalRowsMatching: number;
  groups: InfcontrolLayerBinDummyAggregateGroup[];
} {
  return aggregateInfcontrolLayerBinV3FromRows(
    filterInfcontrolLayerBinV3DummyRowsMatching(applied),
    groupBy,
    groupTop
  );
}
