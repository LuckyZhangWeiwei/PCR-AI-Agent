import {
  type YieldMonitorGroupBy,
  YIELD_MONITOR_AGGREGATE_KEY_SEP,
} from "./yieldMonitorTriggerAggregate.js";
import { YIELD_MONITOR_TRIGGER_TOP } from "./yieldMonitorTriggerFilters.js";

/**
 * Dummy 联调：**与 manifest / 文档 §3.5 示例**一致（`device=D1` + 时间下界），保证至少一行。
 */
export const YIELD_MONITOR_DUMMY_EXAMPLE_QUERY =
  "device=D1&timeStampFrom=2026-01-01T00:00:00.000Z";

/** 与 Oracle 返回列一致（YMWEB_YIELDMONITORTRIGGER） */
export type YieldMonitorTriggerDummyRow = {
  HOSTNAME: string;
  DEVICE: string;
  LOTID: string;
  PASS: number;
  WAFER: string;
  TYPE: string;
  TRIGGER_LABEL: string;
  TIME_STAMP: string;
  ID: number;
  PROBECARD: string;
};

/**
 * 固定样本数据（结构与非 dummy 响应一致）；筛选逻辑与 SQL WHERE 等价。
 * 可按需替换或扩充。
 */
export const YIELD_MONITOR_TRIGGER_DUMMY_ROWS: readonly YieldMonitorTriggerDummyRow[] =
  [
    {
      HOSTNAME: "dummy-anchor",
      DEVICE: "D1",
      LOTID: "DEMO.LOT.1N",
      PASS: 1,
      WAFER: "01",
      TYPE: "delta_diff",
      TRIGGER_LABEL:
        "Dummy anchor row for manifest example (device=D1, Jan 2026).",
      TIME_STAMP: "2026-01-15T12:00:00.000Z",
      ID: 9_000_001,
      PROBECARD: "9400-01",
    },
    {
      HOSTNAME: "b3ps1601",
      DEVICE: "WA00P69K",
      LOTID: "DR31388.1N",
      PASS: 3,
      WAFER: "24",
      TYPE: "delta_diff",
      TRIGGER_LABEL:
        "Bin# goodbin on dut# 11 Yield: 21.43, Min Yield(Dut#11): 21.43 Max Yield(Dut#5): 100.00 Delta exceed Delta Limit 60.",
      TIME_STAMP: "2026-01-31T23:16:57.000Z",
      ID: 1415861,
      PROBECARD: "9464-01",
    },
    {
      HOSTNAME: "b3ps1606",
      DEVICE: "WC03N09Z",
      LOTID: "DR40774.1N",
      PASS: 1,
      WAFER: "1",
      TYPE: "delta_diff",
      TRIGGER_LABEL:
        "Bin# goodbin on dut# 4 Yield: 39.29, Min Yield(Dut#4): 39.29 Max Yield(Dut#25): 100.00 Delta exceed Delta Limit 60.",
      TIME_STAMP: "2026-01-31T23:04:37.000Z",
      ID: 1415841,
      PROBECARD: "9407-01",
    },
    {
      HOSTNAME: "b3flex24",
      DEVICE: "WB02N94R",
      LOTID: "TR14535.1C",
      PASS: 1,
      WAFER: "6",
      TYPE: "Consebin",
      TRIGGER_LABEL: "Bin#2 on dut#0 Conse_Count: 25 exceed limit 25  .",
      TIME_STAMP: "2026-01-31T22:19:06.000Z",
      ID: 1415825,
      PROBECARD: "7774-07",
    },
    {
      HOSTNAME: "b3j75060",
      DEVICE: "WK00N10K",
      LOTID: "TR15696.1X",
      PASS: 3,
      WAFER: "10",
      TYPE: "Consebin",
      TRIGGER_LABEL: "Bin# 8 Count: 81, exceed limit 80 .",
      TIME_STAMP: "2026-01-31T11:39:37.000Z",
      ID: 1415581,
      PROBECARD: "6095-02",
    },
    {
      HOSTNAME: "b3j75026",
      DEVICE: "WA01N13P",
      LOTID: "DR39941.1X",
      PASS: 1,
      WAFER: "6",
      TYPE: "ConseFail",
      TRIGGER_LABEL:
        "Totally no good die, exceed consecutive fail limit 100 .",
      TIME_STAMP: "2026-01-31T10:19:04.000Z",
      ID: 1415541,
      PROBECARD: "6060-01",
    },
    {
      HOSTNAME: "b3ps1617",
      DEVICE: "WA11P07K",
      LOTID: "DR39271.1A",
      PASS: 1,
      WAFER: "22",
      TYPE: "low_yield",
      TRIGGER_LABEL: "Bin goodbin yield 48.46 exceed lower yield limit 50 .",
      TIME_STAMP: "2026-01-31T13:38:22.000Z",
      ID: 1415621,
      PROBECARD: "9459-10",
    },
    {
      HOSTNAME: "b3flex06",
      DEVICE: "WC08N87J",
      LOTID: "TR14714.1A",
      PASS: 1,
      WAFER: "22",
      TYPE: "delta_diff",
      TRIGGER_LABEL:
        "Bin# 1 on dut# 0 Yield: 77.17, Min Yield(Dut#0): 77.17 Max Yield(Dut#3): 98.15 Delta exceed Delta Limit 20.",
      TIME_STAMP: "2026-01-31T01:03:12.000Z",
      ID: 1415241,
      PROBECARD: "7772-04",
    },
  ];

function yieldMonitorTriggersDummyEnvTrue(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** 测试或本地无库时使用内存样本，不连 Oracle probeweb */
export function yieldMonitorTriggersUseDummy(): boolean {
  if (process.env.NODE_ENV === "test") return true;
  return yieldMonitorTriggersDummyEnvTrue(
    process.env.YIELD_MONITOR_TRIGGERS_DUMMY
  );
}

/** 与 parseYieldMonitorTriggerQuery / SQL WHERE 等价，不限 200 条（供聚合 B 模式） */
export function filterYieldMonitorDummyRowsMatching(
  applied: Record<string, unknown>
): YieldMonitorTriggerDummyRow[] {
  let rows = [...YIELD_MONITOR_TRIGGER_DUMMY_ROWS];

  const eqStr = (param: keyof YieldMonitorTriggerDummyRow, key: string) => {
    const v = applied[key];
    if (v === undefined) return;
    const s = String(v);
    rows = rows.filter((r) => r[param] === s);
  };

  eqStr("HOSTNAME", "hostname");
  eqStr("DEVICE", "device");
  eqStr("LOTID", "lotId");
  eqStr("WAFER", "wafer");
  eqStr("TYPE", "type");
  eqStr("TRIGGER_LABEL", "triggerLabel");
  eqStr("PROBECARD", "probeCard");

  if (applied.pass !== undefined) {
    const n = Number(applied.pass);
    rows = rows.filter((r) => r.PASS === n);
  }
  if (applied.id !== undefined) {
    const n = Number(applied.id);
    rows = rows.filter((r) => r.ID === n);
  }

  if (applied.timeStampFrom !== undefined) {
    const from = new Date(String(applied.timeStampFrom)).getTime();
    rows = rows.filter((r) => new Date(r.TIME_STAMP).getTime() >= from);
  }
  if (applied.timeStampTo !== undefined) {
    const to = new Date(String(applied.timeStampTo)).getTime();
    rows = rows.filter((r) => new Date(r.TIME_STAMP).getTime() <= to);
  }

  return rows;
}

export type YieldMonitorProbeCardSummaryEntry = {
  probeCard: string;
  count: number;
};

export type YieldMonitorHostnameSummaryEntry = {
  hostname: string;
  count: number;
};

/** 与 Oracle GROUP BY PROBECARD + COUNT(*) 语义一致；在全量匹配行上统计 */
export function buildYieldMonitorProbeCardSummaryDummy(
  applied: Record<string, unknown>
): YieldMonitorProbeCardSummaryEntry[] {
  const rows = filterYieldMonitorDummyRowsMatching(applied);
  const counts = new Map<string, number>();
  for (const r of rows) {
    const k = r.PROBECARD ?? "";
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([probeCard, count]) => ({ probeCard, count }));
}

/** 与 Oracle GROUP BY HOSTNAME + COUNT(*) 语义一致；在全量匹配行上统计 */
export function buildYieldMonitorHostnameSummaryDummy(
  applied: Record<string, unknown>
): YieldMonitorHostnameSummaryEntry[] {
  const rows = filterYieldMonitorDummyRowsMatching(applied);
  const counts = new Map<string, number>();
  for (const r of rows) {
    const k = r.HOSTNAME ?? "";
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([hostname, count]) => ({ hostname, count }));
}

export function filterYieldMonitorDummyRows(
  applied: Record<string, unknown>
): YieldMonitorTriggerDummyRow[] {
  let rows = filterYieldMonitorDummyRowsMatching(applied);
  rows.sort(
    (a, b) =>
      new Date(b.TIME_STAMP).getTime() - new Date(a.TIME_STAMP).getTime()
  );
  return rows.slice(0, YIELD_MONITOR_TRIGGER_TOP);
}

export type YieldMonitorDummyAggregateGroup = {
  /** 与 Oracle GRP_KEY 一致；复合维度时为 `|` 分隔的拼接串 */
  key: string;
  count: number;
  /** 各维度取值（键为 groupBy 参数名，与请求中维度顺序一致） */
  parts: Record<string, string>;
};

function valueForDimension(
  row: YieldMonitorTriggerDummyRow,
  d: YieldMonitorGroupBy
): string {
  switch (d) {
    case "hostname":
      return row.HOSTNAME;
    case "device":
      return row.DEVICE;
    case "lotId":
      return row.LOTID;
    case "wafer":
      return row.WAFER;
    case "type":
      return row.TYPE;
    case "probeCard":
      return row.PROBECARD;
    case "pass":
      return String(row.PASS);
    default: {
      const _exhaustive: never = d;
      throw new Error(`Unexpected dimension: ${String(_exhaustive)}`);
    }
  }
}

/** 在筛选后的全集上分组计数并取 Top groupTop（与库内聚合语义一致） */
export function aggregateYieldMonitorDummyRows(
  applied: Record<string, unknown>,
  groupBy: YieldMonitorGroupBy[],
  groupTop: number
): { totalRowsMatching: number; groups: YieldMonitorDummyAggregateGroup[] } {
  const rows = filterYieldMonitorDummyRowsMatching(applied);
  const counts = new Map<string, number>();
  const firstParts = new Map<string, Record<string, string>>();

  for (const row of rows) {
    const parts: Record<string, string> = {};
    for (const d of groupBy) {
      parts[d] = valueForDimension(row, d);
    }
    const key = groupBy.map((d) => parts[d]).join(YIELD_MONITOR_AGGREGATE_KEY_SEP);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (!firstParts.has(key)) {
      firstParts.set(key, parts);
    }
  }

  const groups = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, groupTop)
    .map(([key, count]) => ({
      key,
      count,
      parts: firstParts.get(key) ?? {},
    }));

  return { totalRowsMatching: rows.length, groups };
}
