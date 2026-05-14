import { useCallback, useMemo, useState } from "react";
import ReactECharts from "echarts-for-react";
import { apiGetJson } from "../api/client";
import { API_PREFIX } from "../api/paths";
import type {
  AggregateGroup,
  YieldMonitorV3AggregateResponse,
  YieldMonitorV3Response,
} from "../api/types";
import { DarkChart } from "../components/DarkChart";
import { DataTable } from "../components/DataTable";
import { DrillDownPanel } from "../components/DrillDownPanel";
import { KpiCard } from "../components/KpiCard";
import { TreeTable } from "../components/TreeTable";
import {
  baseChartOption,
  chartAccent,
  chartAccent2,
  chartAccent3,
  chartAxisColor,
  chartSplitLine,
  chartTextColor,
} from "../theme/chartTheme";
import {
  allSettledWithConcurrency,
  REPORT_ORACLE_FANOUT_CONCURRENCY,
} from "../utils/asyncConcurrency";
import { datetimeLocalToIso } from "../utils/datetimeLocal";
import {
  buildTree,
  dateShortcutLast7Days,
  dateShortcutThisMonth,
  dateShortcutToday,
  tallyDutNumbers,
} from "../utils/yieldCalc";
import type { EChartsOption } from "echarts";

type Props = { apiBase: string };

type FormState = {
  device: string;
  lotId: string;
  wafer: string;
  hostname: string;
  probeCard: string;
  pass: string;
  timestampFrom: string;
  timestampTo: string;
  limit: string;
};

const initialForm: FormState = {
  device: "",
  lotId: "",
  wafer: "",
  hostname: "",
  probeCard: "",
  pass: "",
  timestampFrom: "",
  timestampTo: "",
  limit: "500",
};

function buildCoreParams(f: FormState): Record<string, string | number | undefined> {
  return {
    device: f.device || undefined,
    lotId: f.lotId || undefined,
    wafer: f.wafer || undefined,
    hostname: f.hostname || undefined,
    probeCard: f.probeCard || undefined,
    pass: f.pass ? Number(f.pass) : undefined,
    timeStampFrom: datetimeLocalToIso(f.timestampFrom),
    timeStampTo: datetimeLocalToIso(f.timestampTo),
  };
}

function buildListParams(f: FormState): Record<string, string | number | undefined> {
  const lim = Number(f.limit);
  return {
    ...buildCoreParams(f),
    limit: Number.isFinite(lim) ? Math.min(500, Math.max(1, Math.floor(lim))) : 500,
  };
}

const HIDE_KEYS = new Set(["limit", "timeStampFrom", "timeStampTo"]);
function activeChips(f: FormState): { key: string; label: string }[] {
  const chips: { key: string; label: string }[] = [];
  const core = buildCoreParams(f);
  for (const [k, v] of Object.entries(core)) {
    if (v === undefined || HIDE_KEYS.has(k)) continue;
    chips.push({ key: k, label: `${k} = ${v}` });
  }
  if (f.timestampFrom || f.timestampTo) {
    const label =
      f.timestampFrom && f.timestampTo
        ? `时间 ${f.timestampFrom} → ${f.timestampTo}`
        : f.timestampFrom
        ? `时间 ≥ ${f.timestampFrom}`
        : `时间 ≤ ${f.timestampTo}`;
    chips.push({ key: "__time__", label });
  }
  return chips;
}

const FREE_DIMS: { label: string; value: string }[] = [
  { label: "按日", value: "timeDay" },
  { label: "Device", value: "device" },
  { label: "LotId", value: "lotId" },
  { label: "ProbeCard", value: "probeCard" },
  { label: "Wafer", value: "wafer" },
  { label: "Hostname", value: "hostname" },
  { label: "Pass", value: "pass" },
];

const DRILLDOWN_OPTS: { label: string; value: string }[] = [
  { label: "ProbeCard", value: "probeCard" },
  { label: "按日", value: "timeDay" },
  { label: "Device", value: "device" },
  { label: "Wafer", value: "wafer" },
];

type DrillState = {
  parentDimKey: string;
  parentDimVal: string;
  subDim: string;
  groups: AggregateGroup[];
  loading: boolean;
  error: string | null;
};

export function YieldMonitorReport({ apiBase }: Props) {
  const [form, setForm] = useState<FormState>(initialForm);
  const [list, setList] = useState<YieldMonitorV3Response | null>(null);
  const [aggTime, setAggTime] = useState<YieldMonitorV3AggregateResponse | null>(null);
  const [aggCard, setAggCard] = useState<YieldMonitorV3AggregateResponse | null>(null);
  const [aggLot, setAggLot] = useState<YieldMonitorV3AggregateResponse | null>(null);
  const [aggTree, setAggTree] = useState<YieldMonitorV3AggregateResponse | null>(null);
  const [aggFree, setAggFree] = useState<YieldMonitorV3AggregateResponse | null>(null);
  const [freeDim, setFreeDim] = useState("timeDay");

  const [loadingList, setLoadingList] = useState(false);
  const [loadingAgg, setLoadingAgg] = useState(false);
  const [errorList, setErrorList] = useState<string | null>(null);
  const [errorAgg, setErrorAgg] = useState<string | null>(null);

  const [drill, setDrill] = useState<DrillState | null>(null);

  const setField = useCallback(
    <K extends keyof FormState>(k: K, v: FormState[K]) => {
      setForm((f) => ({ ...f, [k]: v }));
    },
    []
  );

  const clearFilter = useCallback((key: string) => {
    if (key === "__time__") {
      setForm((f) => ({ ...f, timestampFrom: "", timestampTo: "" }));
    } else {
      setForm((f) => ({ ...f, [key]: "" } as FormState));
    }
  }, []);

  const applyDateShortcut = useCallback((fn: () => [string, string]) => {
    const [from, to] = fn();
    setForm((f) => ({ ...f, timestampFrom: from, timestampTo: to }));
  }, []);

  const fetchDrill = useCallback(
    async (
      parentDimKey: string,
      parentDimVal: string,
      subDim: string,
      currentForm: FormState
    ) => {
      setDrill({
        parentDimKey,
        parentDimVal,
        subDim,
        groups: [],
        loading: true,
        error: null,
      });
      try {
        const params = {
          ...buildCoreParams(currentForm),
          [parentDimKey]: parentDimVal,
          dimensions: subDim,
          groupTop: 25,
        };
        const res = await apiGetJson<YieldMonitorV3AggregateResponse>(
          apiBase,
          `${API_PREFIX}/yield-monitor-triggers/v4/aggregate`,
          params
        );
        setDrill((d) =>
          d && d.parentDimKey === parentDimKey && d.parentDimVal === parentDimVal
            ? { ...d, groups: res.groups, loading: false }
            : d
        );
      } catch (e) {
        setDrill((d) =>
          d && d.parentDimKey === parentDimKey && d.parentDimVal === parentDimVal
            ? {
                ...d,
                loading: false,
                error: e instanceof Error ? e.message : String(e),
              }
            : d
        );
      }
    },
    [apiBase]
  );

  const fetchFreeAgg = useCallback(
    async (dim: string, currentForm: FormState) => {
      try {
        const res = await apiGetJson<YieldMonitorV3AggregateResponse>(
          apiBase,
          `${API_PREFIX}/yield-monitor-triggers/v4/aggregate`,
          { ...buildCoreParams(currentForm), dimensions: dim, groupTop: 30 }
        );
        setAggFree(res);
      } catch {
        setAggFree(null);
      }
    },
    [apiBase]
  );

  const query = useCallback(async () => {
    setLoadingList(true);
    setLoadingAgg(true);
    setErrorList(null);
    setErrorAgg(null);
    setDrill(null);
    const core = buildCoreParams(form);

    const settled = await allSettledWithConcurrency(
      [
        () =>
          apiGetJson<YieldMonitorV3Response>(
            apiBase,
            `${API_PREFIX}/yield-monitor-triggers/v4`,
            buildListParams(form)
          ),
        () =>
          apiGetJson<YieldMonitorV3AggregateResponse>(
            apiBase,
            `${API_PREFIX}/yield-monitor-triggers/v4/aggregate`,
            { ...core, dimensions: "timeDay", groupTop: 60 }
          ),
        () =>
          apiGetJson<YieldMonitorV3AggregateResponse>(
            apiBase,
            `${API_PREFIX}/yield-monitor-triggers/v4/aggregate`,
            { ...core, dimensions: "probeCard", groupTop: 25 }
          ),
        () =>
          apiGetJson<YieldMonitorV3AggregateResponse>(
            apiBase,
            `${API_PREFIX}/yield-monitor-triggers/v4/aggregate`,
            { ...core, dimensions: "lotId", groupTop: 25 }
          ),
        () =>
          apiGetJson<YieldMonitorV3AggregateResponse>(
            apiBase,
            `${API_PREFIX}/yield-monitor-triggers/v4/aggregate`,
            { ...core, dimensions: "device,lotId,probeCard", groupTop: 50 }
          ),
      ],
      REPORT_ORACLE_FANOUT_CONCURRENCY
    );
    const [listRes, timeRes, cardRes, lotRes, treeRes] = settled as [
      PromiseSettledResult<YieldMonitorV3Response>,
      PromiseSettledResult<YieldMonitorV3AggregateResponse>,
      PromiseSettledResult<YieldMonitorV3AggregateResponse>,
      PromiseSettledResult<YieldMonitorV3AggregateResponse>,
      PromiseSettledResult<YieldMonitorV3AggregateResponse>,
    ];

    setLoadingList(false);
    setLoadingAgg(false);

    if (listRes.status === "fulfilled") setList(listRes.value);
    else
      setErrorList(
        listRes.reason instanceof Error
          ? listRes.reason.message
          : String(listRes.reason)
      );

    if (timeRes.status === "fulfilled") setAggTime(timeRes.value);
    if (cardRes.status === "fulfilled") setAggCard(cardRes.value);
    if (lotRes.status === "fulfilled") setAggLot(lotRes.value);
    if (treeRes.status === "fulfilled") setAggTree(treeRes.value);
    if (timeRes.status === "rejected" || cardRes.status === "rejected") {
      setErrorAgg("部分聚合请求失败，图表可能不完整");
    }

    fetchFreeAgg(freeDim, form);
  }, [apiBase, form, freeDim, fetchFreeAgg]);

  const handleFreeDimChange = useCallback(
    (dim: string) => {
      setFreeDim(dim);
      if (list || aggTime) fetchFreeAgg(dim, form);
    },
    [list, aggTime, form, fetchFreeAgg]
  );

  // ── KPI derivations ──────────────────────────────────────────────────────

  const totalTriggers =
    aggTime?.totalRowsMatching ?? aggCard?.totalRowsMatching ?? null;

  const uniqueLots = useMemo(() => {
    if (!list) return null;
    return new Set(list.rows.map((r) => r.LOTID).filter(Boolean)).size;
  }, [list]);

  const worstProbeCard = useMemo(() => {
    const groups = aggCard?.groups ?? [];
    return groups[0]?.parts?.probeCard ?? null;
  }, [aggCard]);

  const topDut = useMemo(() => {
    if (!list) return null;
    const entries = tallyDutNumbers(list.rows);
    if (entries.length === 0) return null;
    return `dut#${entries[0].dut}`;
  }, [list]);

  // ── Chart options ────────────────────────────────────────────────────────

  const timeTrendOption = useMemo((): EChartsOption => {
    const groups = (aggTime?.groups ?? [])
      .slice()
      .sort((a, b) =>
        (a.parts.timeDay ?? "").localeCompare(b.parts.timeDay ?? "")
      );
    const dates = groups.map((g) => g.parts.timeDay ?? g.key);
    const counts = groups.map((g) => g.count);
    return {
      ...baseChartOption(),
      xAxis: {
        type: "category",
        data: dates,
        axisLabel: { color: chartAxisColor, fontSize: 10, rotate: 30 },
      },
      yAxis: {
        type: "value",
        axisLabel: { color: chartAxisColor },
        splitLine: { lineStyle: { color: chartSplitLine } },
      },
      series: [
        {
          type: "line",
          data: counts,
          smooth: true,
          areaStyle: {
            color: {
              type: "linear",
              x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: "rgba(88,166,255,0.3)" },
                { offset: 1, color: "rgba(88,166,255,0.02)" },
              ],
            },
          },
          lineStyle: { color: chartAccent, width: 2 },
          itemStyle: { color: chartAccent },
          animationDuration: 600,
        },
      ],
      tooltip: { trigger: "axis" },
    };
  }, [aggTime]);

  const probeCardOption = useMemo((): EChartsOption => {
    const sorted = [...(aggCard?.groups ?? [])]
      .sort((a, b) => a.count - b.count)
      .slice(-20);
    return {
      ...baseChartOption(),
      xAxis: {
        type: "value",
        axisLabel: { color: chartAxisColor },
        splitLine: { lineStyle: { color: chartSplitLine } },
      },
      yAxis: {
        type: "category",
        data: sorted.map((g) => g.parts.probeCard ?? g.key),
        axisLabel: { color: chartTextColor, fontSize: 11 },
      },
      series: [
        {
          type: "bar",
          data: sorted.map((g) => g.count),
          itemStyle: { color: chartAccent2, borderRadius: [0, 4, 4, 0] as any },
          label: {
            show: true,
            position: "right",
            color: chartAxisColor,
            fontSize: 10,
          },
          animationDuration: 600,
        },
      ],
    };
  }, [aggCard]);

  const dutOption = useMemo((): EChartsOption => {
    const entries = tallyDutNumbers(list?.rows ?? []).slice(0, 20);
    const sorted = [...entries].sort((a, b) => a.count - b.count);
    return {
      ...baseChartOption(),
      xAxis: {
        type: "value",
        axisLabel: { color: chartAxisColor },
        splitLine: { lineStyle: { color: chartSplitLine } },
      },
      yAxis: {
        type: "category",
        data: sorted.map((e) => `dut#${e.dut}`),
        axisLabel: { color: chartTextColor, fontSize: 11 },
      },
      series: [
        {
          type: "bar",
          data: sorted.map((e) => e.count),
          itemStyle: { color: chartAccent3, borderRadius: [0, 4, 4, 0] as any },
          label: {
            show: true,
            position: "right",
            color: chartAxisColor,
            fontSize: 10,
          },
          animationDuration: 600,
        },
      ],
    };
  }, [list]);

  const lotOption = useMemo((): EChartsOption => {
    const sorted = [...(aggLot?.groups ?? [])]
      .sort((a, b) => a.count - b.count)
      .slice(-20);
    return {
      ...baseChartOption(),
      xAxis: {
        type: "value",
        axisLabel: { color: chartAxisColor },
        splitLine: { lineStyle: { color: chartSplitLine } },
      },
      yAxis: {
        type: "category",
        data: sorted.map((g) => g.parts.lotId ?? g.key),
        axisLabel: { color: chartTextColor, fontSize: 11 },
      },
      series: [
        {
          type: "bar",
          data: sorted.map((g) => g.count),
          itemStyle: { color: "#f0883e", borderRadius: [0, 4, 4, 0] as any },
          label: {
            show: true,
            position: "right",
            color: chartAxisColor,
            fontSize: 10,
          },
          animationDuration: 600,
        },
      ],
    };
  }, [aggLot]);

  const freeOption = useMemo((): EChartsOption => {
    const sorted = [...(aggFree?.groups ?? [])]
      .sort((a, b) => a.count - b.count)
      .slice(-25);
    return {
      ...baseChartOption(),
      xAxis: {
        type: "value",
        axisLabel: { color: chartAxisColor },
        splitLine: { lineStyle: { color: chartSplitLine } },
      },
      yAxis: {
        type: "category",
        data: sorted.map((g) => g.key),
        axisLabel: { color: chartTextColor, fontSize: 10 },
      },
      series: [
        {
          type: "bar",
          data: sorted.map((g) => g.count),
          itemStyle: { color: chartAccent, borderRadius: [0, 4, 4, 0] as any },
          animationDuration: 600,
        },
      ],
    };
  }, [aggFree]);

  // ── Tree ─────────────────────────────────────────────────────────────────

  const treeRoots = useMemo(() => {
    if (!aggTree?.groups?.length) return [];
    return buildTree(aggTree.groups, ["device", "lotId", "probeCard"]);
  }, [aggTree]);

  // ── Detail table rows ────────────────────────────────────────────────────

  const detailRows = useMemo(() => {
    if (!list?.rows?.length) return [];
    return list.rows.map((r) => ({
      TIME_STAMP: r.TIME_STAMP ?? "",
      HOSTNAME: r.HOSTNAME ?? "",
      DEVICE: r.DEVICE ?? "",
      LOTID: r.LOTID ?? "",
      WAFER: r.WAFER ?? "",
      PROBECARD: r.PROBECARD ?? "",
      dutNumber: r.dutNumber ?? "—",
    }));
  }, [list]);

  const chips = useMemo(() => activeChips(form), [form]);
  const hasData = !!(list || aggTime || aggCard);

  return (
    <div className="report-panel">
      {/* ── Header ── */}
      <div className="report-panel-header">
        <div>
          <h2>⚡ Yield Monitor</h2>
          <p className="report-desc">
            产量触发分析（TYPE = delta_diff）。选填筛选条件后点「查询」，
            并行获取明细 + 时间趋势 + 探针卡/DUT/LOT 聚合。
          </p>
        </div>
      </div>

      {/* ── Filter grid ── */}
      <div className="filter-grid">
        {(
          [
            ["Device", "device"],
            ["LotID", "lotId"],
            ["Wafer", "wafer"],
            ["Hostname", "hostname"],
            ["ProbeCard", "probeCard"],
            ["Pass", "pass"],
          ] as [string, keyof FormState][]
        ).map(([label, key]) => (
          <label key={key}>
            <span>{label}</span>
            <input
              type="text"
              value={form[key]}
              onChange={(e) => setField(key, e.target.value)}
              placeholder="留空不筛"
            />
          </label>
        ))}

        <label className="span-2">
          <span>时间范围（TIME_STAMP）</span>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="datetime-local"
              value={form.timestampFrom}
              onChange={(e) => setField("timestampFrom", e.target.value)}
              style={{ flex: 1 }}
            />
            <span style={{ color: "#8b949e", fontSize: 12 }}>→</span>
            <input
              type="datetime-local"
              value={form.timestampTo}
              onChange={(e) => setField("timestampTo", e.target.value)}
              style={{ flex: 1 }}
            />
          </div>
          <div className="preset-chips" style={{ marginTop: 6 }}>
            {(
              [
                ["今天", dateShortcutToday],
                ["近7天", dateShortcutLast7Days],
                ["本月", dateShortcutThisMonth],
              ] as const
            ).map(([lbl, fn]) => (
              <button
                key={lbl}
                type="button"
                className="chip"
                onClick={() => applyDateShortcut(fn)}
              >
                {lbl}
              </button>
            ))}
          </div>
        </label>
      </div>

      {/* ── Active chips + Query button ── */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          alignItems: "center",
        }}
      >
        {chips.length > 0 && (
          <span style={{ fontSize: 11, color: "#8b949e" }}>生效筛选：</span>
        )}
        {chips.map((c) => (
          <span
            key={c.key}
            style={{
              background: "rgba(56,139,253,0.12)",
              color: "#58a6ff",
              border: "1px solid rgba(56,139,253,0.35)",
              borderRadius: 999,
              padding: "2px 10px",
              fontSize: 12,
              cursor: "pointer",
            }}
            onClick={() => clearFilter(c.key)}
          >
            {c.label} ✕
          </span>
        ))}
        <button
          type="button"
          className="btn primary"
          style={{ marginLeft: "auto" }}
          disabled={loadingList || loadingAgg}
          onClick={query}
        >
          {loadingList || loadingAgg ? "查询中…" : "查询"}
        </button>
      </div>

      {(errorList || errorAgg) && (
        <div
          style={{
            color: "#ff7b72",
            fontSize: 13,
            background: "rgba(248,81,73,0.08)",
            padding: "8px 12px",
            borderRadius: 6,
          }}
        >
          {errorList || errorAgg}
        </div>
      )}

      {hasData && (
        <>
          {/* ── KPI Cards ── */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(4, 1fr)",
              gap: 12,
            }}
          >
            <KpiCard label="触发总数" value={totalTriggers} color="blue" />
            <KpiCard label="涉及 Lot 数" value={uniqueLots} color="white" />
            <KpiCard
              label="触发最多探针卡"
              value={worstProbeCard}
              color="red"
              subtext="触发次数最多"
            />
            <KpiCard label="触发最多 DUT" value={topDut} color="white" />
          </div>

          {/* ── Time trend (full width) ── */}
          {aggTime && (
            <div
              style={{
                background: "#0d1117",
                border: "1px solid rgba(240,246,252,0.1)",
                borderRadius: 8,
                padding: 16,
              }}
            >
              <div style={{ fontSize: 12, color: "#8b949e", marginBottom: 8 }}>
                📈 每日触发量趋势
              </div>
              <DarkChart option={timeTrendOption} height={220} />
            </div>
          )}

          {/* ── Charts 2×2 grid ── */}
          <div
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}
          >
            {/* ProbeCard ranking */}
            <div
              style={{
                background: "#0d1117",
                border: "1px solid rgba(240,246,252,0.1)",
                borderRadius: 8,
                padding: 16,
              }}
            >
              <div style={{ fontSize: 12, color: "#8b949e", marginBottom: 8 }}>
                🔴 ProbeCard 触发排名
              </div>
              {aggCard && (
                <ReactECharts
                  option={probeCardOption}
                  style={{
                    height: Math.max(180, (aggCard.groups?.length ?? 0) * 22 + 60),
                    width: "100%",
                  }}
                  opts={{ renderer: "canvas" }}
                  notMerge
                  lazyUpdate
                  onEvents={{
                    click: (params: { name: string }) => {
                      fetchDrill("probeCard", params.name, "timeDay", form);
                    },
                  }}
                />
              )}
              {drill?.parentDimKey === "probeCard" && (
                <DrillDownPanel
                  title={`${drill.parentDimVal} · 下钻：按 ${drill.subDim}`}
                  groups={drill.groups}
                  loading={drill.loading}
                  error={drill.error}
                  activeSubDim={drill.subDim}
                  subDimOptions={DRILLDOWN_OPTS.filter(
                    (o) => o.value !== "probeCard"
                  )}
                  onSubDimChange={(d) =>
                    fetchDrill("probeCard", drill.parentDimVal, d, form)
                  }
                  onClose={() => setDrill(null)}
                />
              )}
            </div>

            {/* DUT distribution */}
            <div
              style={{
                background: "#0d1117",
                border: "1px solid rgba(240,246,252,0.1)",
                borderRadius: 8,
                padding: 16,
              }}
            >
              <div style={{ fontSize: 12, color: "#8b949e", marginBottom: 8 }}>
                🎯 DUT# 触发分布
              </div>
              {list && (
                <DarkChart
                  option={dutOption}
                  height={Math.max(
                    180,
                    tallyDutNumbers(list.rows).length * 22 + 60
                  )}
                />
              )}
            </div>

            {/* LOT ranking */}
            <div
              style={{
                background: "#0d1117",
                border: "1px solid rgba(240,246,252,0.1)",
                borderRadius: 8,
                padding: 16,
              }}
            >
              <div style={{ fontSize: 12, color: "#8b949e", marginBottom: 8 }}>
                📦 LOT 触发排名
              </div>
              {aggLot && (
                <ReactECharts
                  option={lotOption}
                  style={{
                    height: Math.max(180, (aggLot.groups?.length ?? 0) * 22 + 60),
                    width: "100%",
                  }}
                  opts={{ renderer: "canvas" }}
                  notMerge
                  lazyUpdate
                  onEvents={{
                    click: (params: { name: string }) => {
                      fetchDrill("lotId", params.name, "probeCard", form);
                    },
                  }}
                />
              )}
              {drill?.parentDimKey === "lotId" && (
                <DrillDownPanel
                  title={`${drill.parentDimVal} · 下钻：按 ${drill.subDim}`}
                  groups={drill.groups}
                  loading={drill.loading}
                  error={drill.error}
                  activeSubDim={drill.subDim}
                  subDimOptions={DRILLDOWN_OPTS.filter(
                    (o) => o.value !== "lotId"
                  )}
                  onSubDimChange={(d) =>
                    fetchDrill("lotId", drill.parentDimVal, d, form)
                  }
                  onClose={() => setDrill(null)}
                />
              )}
            </div>

            {/* Free-dimension aggregate */}
            <div
              style={{
                background: "#0d1117",
                border: "1px solid rgba(240,246,252,0.1)",
                borderRadius: 8,
                padding: 16,
              }}
            >
              <div style={{ fontSize: 12, color: "#8b949e", marginBottom: 6 }}>
                🔢 自由维度聚合
              </div>
              <div
                style={{
                  display: "flex",
                  gap: 6,
                  flexWrap: "wrap",
                  marginBottom: 8,
                }}
              >
                {FREE_DIMS.map((d) => (
                  <button
                    key={d.value}
                    type="button"
                    className="chip"
                    style={
                      d.value === freeDim
                        ? {
                            background: "rgba(56,139,253,0.2)",
                            borderColor: "#388bfd",
                            color: "#58a6ff",
                          }
                        : undefined
                    }
                    onClick={() => handleFreeDimChange(d.value)}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
              {aggFree && (
                <DarkChart
                  option={freeOption}
                  height={Math.max(
                    180,
                    aggFree.groups.length * 22 + 60
                  )}
                />
              )}
            </div>
          </div>

          {/* ── Tree table ── */}
          {treeRoots.length > 0 && (
            <div
              style={{
                background: "#0d1117",
                border: "1px solid rgba(240,246,252,0.1)",
                borderRadius: 8,
                padding: 16,
              }}
            >
              <div
                style={{ fontSize: 12, color: "#8b949e", marginBottom: 10 }}
              >
                📊 分组汇总（Device → LOT → ProbeCard）
              </div>
              <TreeTable roots={treeRoots} totalHeader="触发次数" />
            </div>
          )}

          {/* ── Detail table ── */}
          {detailRows.length > 0 && (
            <div
              style={{
                background: "#0d1117",
                border: "1px solid rgba(240,246,252,0.1)",
                borderRadius: 8,
                padding: 16,
              }}
            >
              <div style={{ fontSize: 12, color: "#8b949e", marginBottom: 8 }}>
                明细表 — 共 {list?.count ?? 0} 条（含 dutNumber）
              </div>
              <DataTable rows={detailRows} maxHeight={400} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
