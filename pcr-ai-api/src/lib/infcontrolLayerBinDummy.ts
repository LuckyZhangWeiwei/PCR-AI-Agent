import {
  INFCONTROL_LAYER_BIN_AGGREGATE_KEY_SEP,
  type InfcontrolLayerBinGroupBy,
} from "./infcontrolLayerBinAggregate.js";
import { INFCONTROL_LAYER_BIN_TOP } from "./infcontrolLayerBinFilters.js";
import {
  binColumnIndexIsGood,
  parsePassBinHyphenGoodBins,
} from "./passBinSemantics.js";

/**
 * Dummy 联调：**与 manifest / 文档示例一致**的查询串片段（同一条件 AND 下至少命中一行，含 §3.4.1 聚合示例的时间窗）。
 * 正式库无此保证。
 */
export const INFCONTROL_DUMMY_EXAMPLE_QUERY =
  "device=WA00P69K&lot=DR39000.1N&slot=1&tstype=CP&cardId=9400-01&testEndFrom=2026-01-01T00:00:00.000Z&testEndTo=2026-01-31T23:59:59.999Z";

/**
 * 与 INFCONTROL ⋈ INFLAYERBINLIST 查询列一致（Oracle 列名大写，含 BIN0…BIN255）。
 * 索引签名便于填充 256 个 BIN 列。
 */
export interface InfcontrolLayerBinDummyRow {
  [key: string]: string | number;
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
}

function zeroBins(): Record<string, number> {
  const o: Record<string, number> = {};
  for (let i = 0; i < 256; i++) o[`BIN${i}`] = 0;
  return o;
}

function buildInfcontrolLayerBinDummyRows(): InfcontrolLayerBinDummyRow[] {
  const list: InfcontrolLayerBinDummyRow[] = [];
  /** i≥1 的行：测试结束时间螺旋（与 i=0 错开，避免占同一文档时间窗） */
  const spiralAnchor = Date.parse("2026-05-09T12:00:00.000Z");

  for (let i = 0; i < INFCONTROL_LAYER_BIN_TOP; i++) {
    let testEnd: string;
    let testStart: string;
    if (i === 0) {
      /** 锚点行：`tstype=CP`、`TESTEND` 落在 2026-01，与文档 aggregate / 列表示例时间筛选一致 */
      testEnd = "2026-01-15T14:30:00.000Z";
      testStart = "2026-01-15T11:00:00.000Z";
    } else {
      const testEndMs = spiralAnchor - i * 120_000;
      testEnd = new Date(testEndMs).toISOString();
      testStart = new Date(testEndMs - 3_600_000).toISOString();
    }
    const bins = zeroBins();

    bins.BIN0 = 120 + (i % 40);
    bins.BIN1 = i % 9;
    bins.BIN2 = (i * 7) % 100;
    bins.BIN3 = 1 + (i % 2);
    bins.BIN8 = i % 5 === 0 ? 3 : 0;

    const devicePool = ["WA00P69K", "WC03N09Z", "WK00N10K", "WB02N94R"];
    const layerPool = ["LAYER_A", "LAYER_B", "MAP_TOP"];

    const row: InfcontrolLayerBinDummyRow = {
      ...bins,
      KEYNUMBER: 9_000_000 + i,
      DEVICE: devicePool[i % devicePool.length],
      LOT: `DR${39000 + (i % 800)}.${1 + (i % 3)}N`,
      CASSETTE: String((i % 25) + 1),
      SLOT: (i % 24) + 1,
      NOTCH: "DOWN",
      MAPROWS: 80 + (i % 5),
      MAPCOLS: 90 + (i % 4),
      SAMPLETESTNUMBER: i % 4,
      PDPW: 25 + (i % 10),
      MESLOT: `MES${10000 + i}`,
      /** i=0：T101、9400-01、CP，与 manifest 聚合示例一致 */
      TESTERID: `T${100 + ((i + 1) % 8)}`,
      TSTYPE: i === 0 ? "CP" : i % 3 === 0 ? "FT" : "CP",
      CARDID: `${9400 + (i % 12)}-01`,
      PIBID: `PIB${(i % 6) + 1}`,
      PROBE: `${7700 + (i % 20)}-0${1 + (i % 8)}`,
      GROSSDIE: 2000 + (i % 300),
      PASSID: 500 + i,
      SESSIONNUMBER: 1 + (i % 4),
      PASSNUM: 1 + (i % 6),
      TESTSTART: testStart,
      TESTEND: testEnd,
      LAYERNAME: layerPool[i % layerPool.length],
      PASSRESUME: i % 2 === 0 ? "Y" : "N",
      PASSRESULT: "PASS",
      PASSTYPE: "TEST",
      /** 半数样本为 `1-55`（PASSBIN 解析参考）；enrich 后 bins.isGood 依 BIN1 / PASSBIN 两端计算 */
      PASSBIN: i % 2 === 0 ? "1-55" : `BIN${i % 12}`,
    };
    list.push(row);
  }

  return list;
}

/** 固定 200 条样本（结构与非 dummy 响应一致）；筛选逻辑与 SQL WHERE 等价 */
export const INFCONTROL_LAYER_BIN_DUMMY_ROWS: readonly InfcontrolLayerBinDummyRow[] =
  buildInfcontrolLayerBinDummyRows();

function infcontrolLayerBinsDummyEnvTrue(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** 测试或本地无库时使用内存样本，不连 Oracle */
export function infcontrolLayerBinsUseDummy(): boolean {
  if (process.env.NODE_ENV === "test") return true;
  return infcontrolLayerBinsDummyEnvTrue(
    process.env.INFCONTROL_LAYER_BINS_DUMMY
  );
}

/** 与 parseInfcontrolLayerBinQuery / SQL WHERE 等价，不限 200 条（供聚合） */
export function filterInfcontrolLayerDummyRowsMatching(
  applied: Record<string, unknown>
): InfcontrolLayerBinDummyRow[] {
  let rows = [...INFCONTROL_LAYER_BIN_DUMMY_ROWS];

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
  let rows = [...INFCONTROL_LAYER_BIN_DUMMY_ROWS].filter(
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

/** v2 bad-bin 排行：与 Oracle **`REGEXP_LIKE` + SUM** 语义一致（dummy 全表匹配行上累计） */
export function aggregateInfcontrolLayerBinV2BadBinsDummy(
  applied: Record<string, unknown>,
  rankTop: number
): { n: number; badTotal: number }[] {
  const rows = filterInfcontrolLayerBinV2DummyRows(applied, 1_000_000);
  const totals = new Array<number>(256).fill(0);

  for (const row of rows) {
    const good = parsePassBinHyphenGoodBins(row.PASSBIN);
    for (let k = 0; k < 256; k++) {
      const raw = row[`BIN${k}`];
      if (raw == null || raw === "") continue;
      const v = Number(raw);
      if (!Number.isFinite(v) || v === 0) continue;
      if (good.has(k)) continue;
      totals[k] += v;
    }
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
    case "pibId":
      return String(row.PIBID);
    case "probe":
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
