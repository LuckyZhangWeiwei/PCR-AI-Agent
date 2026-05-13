import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiGetJson } from "../api/client";
import { API_PREFIX } from "../api/paths";
import type {
  InfcontrolAggregateResponse,
  InfcontrolLayerBinsV3Response,
  InfcontrolTopBadBinsResponse,
} from "../api/types";
import { DarkChart } from "../components/DarkChart";
import { DataTable } from "../components/DataTable";
import {
  baseChartOption,
  chartAccent,
  chartAccent2,
  chartAccent3,
  chartAxisColor,
  chartSplitLine,
  chartTextColor,
} from "../theme/chartTheme";
import type { EChartsOption } from "echarts";
import { datetimeLocalToIso } from "../utils/datetimeLocal";
import { sumBinsOnPage } from "../utils/rollup";

/** JB START：Tester Type（TSTYPE）下拉固定选项 */
const TSTYPE_OPTIONS = [
  "UFLEX",
  "J750",
  "PS16",
  "MST",
  "FLEX",
  "93K",
  "J971",
] as const;

type Props = {
  apiBase: string;
};

/** 与 v3 列表 / v3 聚合筛选一致（不含 limit、rankTop、groupBy） */
type FormState = {
  device: string;
  lot: string;
  slot: string;
  meslot: string;
  testerId: string;
  tstype: string;
  cardId: string;
  passId: string;
  testStartFrom: string;
  testStartTo: string;
  testEndFrom: string;
  testEndTo: string;
  /** 列表行数上限 1…500，默认 200 */
  limit: string;
  /** 不良 BIN 排名条数 5…10 */
  rankTop: string;
  /** v3 聚合：groupBy，须含 bin */
  aggGroupBy: "bin" | "device,bin";
  /** v3 聚合 groupTop 1…50 */
  aggGroupTop: string;
};

const initialForm: FormState = {
  device: "",
  lot: "",
  slot: "",
  meslot: "",
  testerId: "",
  tstype: "",
  cardId: "",
  passId: "",
  testStartFrom: "",
  testStartTo: "",
  testEndFrom: "",
  testEndTo: "",
  limit: "200",
  rankTop: "10",
  aggGroupBy: "bin",
  aggGroupTop: "10",
};

function numOrUndef(s: string): number | undefined {
  if (!s.trim()) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function optTrim(s: string): string | undefined {
  const t = s.trim();
  return t === "" ? undefined : t;
}

/** v3 列表 / v3 聚合共用 WHERE 参数（与 `parseInfcontrolLayerBinsV3Query` 对齐） */
function buildV3CoreParams(
  f: FormState
): Record<string, string | number | undefined> {
  return {
    device: optTrim(f.device),
    lot: optTrim(f.lot),
    slot: numOrUndef(f.slot),
    meslot: optTrim(f.meslot),
    testerId: optTrim(f.testerId),
    tstype: optTrim(f.tstype),
    cardId: optTrim(f.cardId),
    passId: numOrUndef(f.passId),
    testStartFrom: datetimeLocalToIso(f.testStartFrom),
    testStartTo: datetimeLocalToIso(f.testStartTo),
    testEndFrom: datetimeLocalToIso(f.testEndFrom),
    testEndTo: datetimeLocalToIso(f.testEndTo),
  };
}

function buildV3ListParams(
  f: FormState
): Record<string, string | number | undefined> {
  const lim = numOrUndef(f.limit);
  return {
    ...buildV3CoreParams(f),
    limit:
      lim !== undefined
        ? Math.min(500, Math.max(1, Math.floor(lim)))
        : undefined,
  };
}

/** v2 top-bad-bins：与 v3 相同筛选项子集即可（多余键后端忽略） */
function buildTopBadBinsParams(
  f: FormState
): Record<string, string | number | undefined> {
  const rt = numOrUndef(f.rankTop);
  const rankTop =
    rt !== undefined ? Math.min(10, Math.max(5, Math.floor(rt))) : undefined;
  return {
    ...buildV3CoreParams(f),
    rankTop,
  };
}

function buildV3AggregateParams(
  f: FormState
): Record<string, string | number | undefined> {
  const gt = numOrUndef(f.aggGroupTop);
  const groupTop =
    gt !== undefined ? Math.min(50, Math.max(1, Math.floor(gt))) : 10;
  return {
    ...buildV3CoreParams(f),
    groupBy: f.aggGroupBy,
    groupTop,
  };
}

function stableParamsKey(
  p: Record<string, string | number | undefined>
): string {
  const o: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined || v === null || v === "") continue;
    o[k] = typeof v === "number" ? v : String(v);
  }
  const keys = Object.keys(o).sort();
  const sorted: Record<string, string | number> = {};
  for (const kk of keys) sorted[kk] = o[kk];
  return JSON.stringify(sorted);
}

/** 明细表不展示：JOIN 键、PASSBIN、以及已剥离的 bins */
function infcontrolRowsForDetailTable(
  rows: Record<string, unknown>[]
): Record<string, unknown>[] {
  return rows.map((row) => {
    const { bins: _b, ...rest } = row;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) {
      const lk = k.toLowerCase();
      if (lk === "keynumber" || lk === "passbin" || lk === "notch") continue;
      const outKey = lk === "passtype" ? "PASSTYPE" : k;
      out[outKey] = v;
    }
    if (!Object.prototype.hasOwnProperty.call(out, "PASSTYPE")) {
      const pv = row.PASSTYPE ?? row.passtype;
      out.PASSTYPE = pv ?? "";
    }
    return out;
  });
}

const LIST_COLUMNS_PREF = [
  "TESTEND",
  "DEVICE",
  "LOT",
  "SLOT",
  "MESLOT",
  "TSTYPE",
  "PASSTYPE",
  "CARDID",
  "TESTERID",
  "TESTSTART",
  "PASSID",
  "PIBID",
  "PROBE",
];

export function InfcontrolReport({ apiBase }: Props) {
  const [form, setForm] = useState<FormState>(initialForm);
  const [list, setList] = useState<InfcontrolLayerBinsV3Response | null>(null);
  const [badBins, setBadBins] = useState<InfcontrolTopBadBinsResponse | null>(
    null
  );
  const [agg, setAgg] = useState<InfcontrolAggregateResponse | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingBad, setLoadingBad] = useState(false);
  const [loadingAgg, setLoadingAgg] = useState(false);
  const [errorList, setErrorList] = useState<string | null>(null);
  const [errorBad, setErrorBad] = useState<string | null>(null);
  const [errorAgg, setErrorAgg] = useState<string | null>(null);

  const listParamsWhenFetchedRef = useRef<string | null>(null);
  const badParamsWhenFetchedRef = useRef<string | null>(null);
  const aggParamsWhenFetchedRef = useRef<string | null>(null);

  const searchList = useCallback(async () => {
    setLoadingList(true);
    setErrorList(null);
    try {
      const params = buildV3ListParams(form);
      const res = await apiGetJson<InfcontrolLayerBinsV3Response>(
        apiBase,
        `${API_PREFIX}/infcontrol-layer-bins/v3`,
        params
      );
      setList(res);
      listParamsWhenFetchedRef.current = stableParamsKey(params);
    } catch (e: unknown) {
      setList(null);
      setErrorList(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingList(false);
    }
  }, [apiBase, form]);

  const searchBadBins = useCallback(async () => {
    setLoadingBad(true);
    setErrorBad(null);
    try {
      const params = buildTopBadBinsParams(form);
      const res = await apiGetJson<InfcontrolTopBadBinsResponse>(
        apiBase,
        `${API_PREFIX}/infcontrol-layer-bins/v2/top-bad-bins`,
        params
      );
      setBadBins(res);
      badParamsWhenFetchedRef.current = stableParamsKey(params);
    } catch (e: unknown) {
      setBadBins(null);
      setErrorBad(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingBad(false);
    }
  }, [apiBase, form]);

  const searchAggregate = useCallback(async () => {
    setLoadingAgg(true);
    setErrorAgg(null);
    try {
      const params = buildV3AggregateParams(form);
      const res = await apiGetJson<InfcontrolAggregateResponse>(
        apiBase,
        `${API_PREFIX}/infcontrol-layer-bins/v3/aggregate`,
        params
      );
      setAgg(res);
      aggParamsWhenFetchedRef.current = stableParamsKey(params);
    } catch (e: unknown) {
      setAgg(null);
      setErrorAgg(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingAgg(false);
    }
  }, [apiBase, form]);

  useEffect(() => {
    const cur = stableParamsKey(buildV3ListParams(form));
    if (
      listParamsWhenFetchedRef.current !== null &&
      cur !== listParamsWhenFetchedRef.current
    ) {
      setList(null);
      setErrorList(null);
    }
  }, [form]);

  useEffect(() => {
    const cur = stableParamsKey(buildTopBadBinsParams(form));
    if (
      badParamsWhenFetchedRef.current !== null &&
      cur !== badParamsWhenFetchedRef.current
    ) {
      setBadBins(null);
      setErrorBad(null);
    }
  }, [form]);

  useEffect(() => {
    const cur = stableParamsKey(buildV3AggregateParams(form));
    if (
      aggParamsWhenFetchedRef.current !== null &&
      cur !== aggParamsWhenFetchedRef.current
    ) {
      setAgg(null);
      setErrorAgg(null);
    }
  }, [form]);

  const listDetailRows = useMemo(() => {
    if (!list?.rows?.length) return [];
    const mapped = infcontrolRowsForDetailTable(list.rows);
    const base = Object.fromEntries(
      LIST_COLUMNS_PREF.map((k) => [k, ""])
    ) as Record<string, unknown>;
    return mapped.map((r) => ({ ...base, ...r }));
  }, [list]);

  const badBinsChartOption = useMemo((): EChartsOption | null => {
    const bins = badBins?.bins ?? [];
    if (!bins.length) return null;
    const sorted = [...bins].sort((a, b) => a.badTotal - b.badTotal);
    const base = baseChartOption();
    const tipBase =
      typeof base.tooltip === "object" && base.tooltip !== null
        ? base.tooltip
        : {};
    return {
      ...base,
      tooltip: {
        ...tipBase,
        trigger: "item",
        formatter(p: unknown) {
          const params = p as { dataIndex?: number; value?: unknown };
          const idx = params?.dataIndex ?? 0;
          const row = sorted[idx];
          if (!row) return "";
          const raw = params?.value;
          const val =
            typeof raw === "number"
              ? raw
              : Array.isArray(raw)
                ? Number(raw[0])
                : row.badTotal;
          return `Bin ${row.n}<br/>不良合计：${val}`;
        },
      },
      grid: {
        ...(base.grid as object),
        top: 88,
      },
      title: {
        text:
          "不良 BIN 合计排名（全量匹配行，前 " +
          String(badBins?.rankTop ?? sorted.length) +
          " 名）",
        subtext:
          "服务端按 PASSBIN（- 分隔的 good bin 下标）判定不良后，对每列 BIN 求 SUM；与 v3 列表 bins[].isGoodBin 口径一致。",
        left: 0,
        top: 4,
        textStyle: { color: chartTextColor, fontSize: 14, fontWeight: 600 },
        subtextStyle: {
          color: chartAxisColor,
          fontSize: 11,
          lineHeight: 16,
        },
      },
      xAxis: {
        type: "value",
        axisLabel: { color: chartAxisColor },
        splitLine: { lineStyle: { color: chartSplitLine } },
      },
      yAxis: {
        type: "category",
        data: sorted.map((x) => "Bin " + String(x.n)),
        axisLabel: {
          color: chartAxisColor,
          interval: 0,
        },
      },
      series: [
        {
          type: "bar",
          data: sorted.map((x) => x.badTotal),
          itemStyle: {
            color: {
              type: "linear",
              x: 0,
              y: 0,
              x2: 1,
              y2: 0,
              colorStops: [
                { offset: 0, color: chartAccent2 },
                { offset: 1, color: chartAccent },
              ],
            },
          },
        },
      ],
    };
  }, [badBins]);

  const aggChartOption = useMemo((): EChartsOption | null => {
    const groups = agg?.groups ?? [];
    if (!groups.length) return null;
    const sorted = [...groups].sort((a, b) => a.count - b.count);
    const base = baseChartOption();
    const tipBase =
      typeof base.tooltip === "object" && base.tooltip !== null
        ? base.tooltip
        : {};
    return {
      ...base,
      tooltip: {
        ...tipBase,
        trigger: "item",
        formatter(p: unknown) {
          const params = p as { dataIndex?: number; value?: unknown };
          const idx = params?.dataIndex ?? 0;
          const row = sorted[idx];
          if (!row) return "";
          const raw = params?.value;
          const val =
            typeof raw === "number"
              ? raw
              : Array.isArray(raw)
                ? Number(raw[0])
                : row.count;
          return `${row.key}<br/>坏 bin die 合计：${val}`;
        },
      },
      grid: { ...(base.grid as object), top: 96 },
      title: {
        text: `v3 BIN 聚合（groupBy=${(agg?.groupBy ?? []).join(",")}，Top ${agg?.groupTop ?? sorted.length}）`,
        subtext:
          "SUM 仅累计坏 bin die（与 v3 列表 isGoodBin / top-bad-bins token 规则一致）；totalRowsMatching 为筛选下明细行数。",
        left: 0,
        top: 4,
        textStyle: { color: chartTextColor, fontSize: 14, fontWeight: 600 },
        subtextStyle: {
          color: chartAxisColor,
          fontSize: 11,
          lineHeight: 16,
        },
      },
      xAxis: {
        type: "value",
        axisLabel: { color: chartAxisColor },
        splitLine: { lineStyle: { color: chartSplitLine } },
      },
      yAxis: {
        type: "category",
        data: sorted.map((g) =>
          g.key.length > 48 ? g.key.slice(0, 47) + "…" : g.key
        ),
        axisLabel: { color: chartAxisColor, width: 200, overflow: "truncate" },
      },
      series: [
        {
          type: "bar",
          data: sorted.map((g) => g.count),
          itemStyle: {
            color: {
              type: "linear",
              x: 0,
              y: 0,
              x2: 1,
              y2: 0,
              colorStops: [
                { offset: 0, color: chartAccent3 },
                { offset: 1, color: chartAccent },
              ],
            },
          },
        },
      ],
    };
  }, [agg]);

  const pageBinsOption = useMemo((): EChartsOption | null => {
    const rows = list?.rows ?? [];
    if (!rows.length) return null;
    const top = sumBinsOnPage(rows, 22);
    if (!top.length) return null;
    const sorted = [...top].sort((a, b) => a.sum - b.sum);
    const base = baseChartOption();
    const tipBase =
      typeof base.tooltip === "object" && base.tooltip !== null
        ? base.tooltip
        : {};
    return {
      ...base,
      tooltip: {
        ...tipBase,
        trigger: "item",
        formatter(p: unknown) {
          const params = p as { dataIndex?: number; value?: unknown };
          const idx = params?.dataIndex ?? 0;
          const row = sorted[idx];
          if (!row) return "";
          const raw = params?.value;
          const val =
            typeof raw === "number"
              ? raw
              : Array.isArray(raw)
                ? Number(raw[0])
                : row.sum;
          return `Bin ${row.bin}<br/>合计颗数：${val}`;
        },
      },
      grid: {
        ...(base.grid as object),
        top: 88,
      },
      title: {
        text: "本页不良 BIN 颗数合计",
        subtext:
          "按 v3 列表 bins[]：累加 isGoodBin 为 false 的 value；仅当前列表返回的若干行（由 limit 决定）。",
        left: 0,
        top: 4,
        textStyle: { color: chartTextColor, fontSize: 14, fontWeight: 600 },
        subtextStyle: {
          color: chartAxisColor,
          fontSize: 11,
          lineHeight: 16,
        },
      },
      xAxis: {
        type: "value",
        axisLabel: { color: chartAxisColor },
        splitLine: { lineStyle: { color: chartSplitLine } },
      },
      yAxis: {
        type: "category",
        data: sorted.map((x) => "Bin " + String(x.bin)),
        axisLabel: {
          color: chartAxisColor,
          interval: 0,
        },
      },
      series: [
        {
          type: "bar",
          data: sorted.map((x) => x.sum),
          itemStyle: {
            color: chartAccent3,
            borderRadius: [0, 4, 4, 0],
          },
        },
      ],
    };
  }, [list]);

  return (
    <section className="report-panel">
      <header className="report-panel-header">
        <div>
          <h2>JB START（v3）</h2>
          <p className="report-desc">
            列表与 BIN 聚合：<code>{API_PREFIX}/infcontrol-layer-bins/v3</code>、
            <code>{API_PREFIX}/infcontrol-layer-bins/v3/aggregate</code>
            ；不良全量排名仍用{" "}
            <code>{API_PREFIX}/infcontrol-layer-bins/v2/top-bad-bins</code>
            。PASSBIN 以 <strong>-</strong> 分隔 good bin；明细{" "}
            <code>bins[]</code> 含 <code>value</code>、<code>n</code>、
            <code>isGoodBin</code>。
            <br />
            <span className="muted small">
              修改条件后请再次点击各查询按钮，否则会清空旧结果以免误判。
            </span>
          </p>
        </div>
        <div className="report-actions">
          <button
            type="button"
            className="btn secondary"
            onClick={searchList}
            disabled={loadingList}
          >
            {loadingList ? "查询中…" : "查列表"}
          </button>
          <button
            type="button"
            className="btn secondary"
            onClick={searchAggregate}
            disabled={loadingAgg}
          >
            {loadingAgg ? "聚合中…" : "查 BIN 聚合"}
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={searchBadBins}
            disabled={loadingBad}
          >
            {loadingBad ? "统计中…" : "查不良排名"}
          </button>
        </div>
      </header>

      <div className="filter-grid">
        <label>
          <span>Device</span>
          <input
            value={form.device}
            onChange={(e) =>
              setForm((s) => ({ ...s, device: e.target.value }))
            }
          />
        </label>
        <label>
          <span>LotID</span>
          <input
            value={form.lot}
            onChange={(e) => setForm((s) => ({ ...s, lot: e.target.value }))}
          />
        </label>
        <label>
          <span>Slot</span>
          <input
            value={form.slot}
            onChange={(e) => setForm((s) => ({ ...s, slot: e.target.value }))}
          />
        </label>
        <label>
          <span>MES Lot</span>
          <input
            value={form.meslot}
            onChange={(e) =>
              setForm((s) => ({ ...s, meslot: e.target.value }))
            }
          />
        </label>
        <label>
          <span>Tester Type</span>
          <select
            value={form.tstype}
            onChange={(e) =>
              setForm((s) => ({ ...s, tstype: e.target.value }))
            }
          >
            <option value="">（不筛选）</option>
            {TSTYPE_OPTIONS.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>ProbeCardID</span>
          <input
            value={form.cardId}
            onChange={(e) =>
              setForm((s) => ({ ...s, cardId: e.target.value }))
            }
          />
        </label>
        <label>
          <span>HostName（testerId）</span>
          <input
            value={form.testerId}
            onChange={(e) =>
              setForm((s) => ({ ...s, testerId: e.target.value }))
            }
          />
        </label>
        <label>
          <span>PassID</span>
          <select
            value={form.passId}
            onChange={(e) =>
              setForm((s) => ({ ...s, passId: e.target.value }))
            }
          >
            <option value="">（不筛选）</option>
            <option value="1">1</option>
            <option value="3">3</option>
            <option value="5">5</option>
          </select>
        </label>
        <label className="span-2">
          <span>测试开始 · 起始时间</span>
          <input
            type="datetime-local"
            step={1}
            value={form.testStartFrom}
            onChange={(e) =>
              setForm((s) => ({ ...s, testStartFrom: e.target.value }))
            }
          />
        </label>
        <label className="span-2">
          <span>测试开始 · 结束时间</span>
          <input
            type="datetime-local"
            step={1}
            value={form.testStartTo}
            onChange={(e) =>
              setForm((s) => ({ ...s, testStartTo: e.target.value }))
            }
          />
        </label>
        <label className="span-2">
          <span>测试结束 · 起始时间</span>
          <input
            type="datetime-local"
            step={1}
            value={form.testEndFrom}
            onChange={(e) =>
              setForm((s) => ({ ...s, testEndFrom: e.target.value }))
            }
          />
        </label>
        <label className="span-2">
          <span>测试结束 · 结束时间</span>
          <input
            type="datetime-local"
            step={1}
            value={form.testEndTo}
            onChange={(e) =>
              setForm((s) => ({ ...s, testEndTo: e.target.value }))
            }
          />
        </label>
        <label>
          <span>列表条数上限（1～500）</span>
          <input
            value={form.limit}
            onChange={(e) =>
              setForm((s) => ({ ...s, limit: e.target.value }))
            }
          />
        </label>
        <label>
          <span>不良排名条数（5～10）</span>
          <input
            value={form.rankTop}
            onChange={(e) =>
              setForm((s) => ({ ...s, rankTop: e.target.value }))
            }
          />
        </label>
        <label>
          <span>v3 聚合维度</span>
          <select
            value={form.aggGroupBy}
            onChange={(e) =>
              setForm((s) => ({
                ...s,
                aggGroupBy: e.target.value as FormState["aggGroupBy"],
              }))
            }
            className="select-input"
          >
            <option value="bin">仅 BIN</option>
            <option value="device,bin">Device + BIN</option>
          </select>
        </label>
        <label>
          <span>聚合返回组数（1～50）</span>
          <input
            value={form.aggGroupTop}
            onChange={(e) =>
              setForm((s) => ({ ...s, aggGroupTop: e.target.value }))
            }
          />
        </label>
      </div>

      {errorList ? <div className="alert error">{errorList}</div> : null}
      {errorBad ? <div className="alert error">{errorBad}</div> : null}
      {errorAgg ? <div className="alert error">{errorAgg}</div> : null}

      {agg ? (
        <div className="report-meta">
          <span>
            匹配明细行 <strong>{agg.totalRowsMatching}</strong> ·{" "}
            {agg.orderBy}
          </span>
        </div>
      ) : null}

      {aggChartOption ? (
        <div className="card chart-card">
          <DarkChart option={aggChartOption} height={420} />
        </div>
      ) : null}

      {agg?.groups?.length ? (
        <div className="card">
          <h3 className="card-title">v3 聚合组（前 {agg.groupTop} 组）</h3>
          <DataTable
            rows={agg.groups.map((g, i) => ({
              _rank: i + 1,
              key: g.key,
              count: g.count,
              parts: JSON.stringify(g.parts),
            }))}
            columnOrder={["_rank", "key", "count", "parts"]}
          />
        </div>
      ) : null}

      {badBins ? (
        <div className="report-meta">
          <span>
            不良排名取前 <strong>{badBins.rankTop}</strong> 个 BIN（可调
            5～10）
          </span>
          <span className="muted small">{badBins.orderBy}</span>
        </div>
      ) : null}

      {badBinsChartOption ? (
        <div className="card chart-card">
          <DarkChart option={badBinsChartOption} height={420} />
        </div>
      ) : (
        <div className="card chart-placeholder subtle">
          <p>
            点击 <strong>查不良排名</strong>{" "}
            后，将在当前筛选下的<strong>全部匹配行</strong>上汇总不良 BIN 合计并绘图。
          </p>
        </div>
      )}

      {badBins?.bins?.length ? (
        <div className="card">
          <h3 className="card-title">不良 BIN 排名表</h3>
          <DataTable
            rows={badBins.bins.map((b, i) => ({
              _rank: i + 1,
              binName: b.n,
              badTotal: b.badTotal,
            }))}
            columnOrder={["_rank", "binName", "badTotal"]}
          />
        </div>
      ) : null}

      {list ? (
        <div className="card">
          <div className="card-head">
            <h3 className="card-title">明细表（{list.count} 条）</h3>
            <span className="muted small">
              limit≤{list.limitMax} · {list.orderBy}
            </span>
          </div>
          <p className="muted small">
            明细表不显示 KEYNUMBER、PASSBIN 及 BIN 展开列；本页不良 BIN 图仍基于接口返回的{" "}
            <code>bins</code>。
          </p>
          <DataTable
            rows={listDetailRows}
            columnOrder={LIST_COLUMNS_PREF}
            omitKeys={["NOTCH", "notch"]}
          />
        </div>
      ) : null}

      {pageBinsOption ? (
        <div className="card chart-card">
          <DarkChart option={pageBinsOption} height={380} />
        </div>
      ) : null}
    </section>
  );
}
