import { useCallback, useMemo, useState } from "react";
import ReactECharts from "echarts-for-react";
import { apiGetJson } from "../api/client";
import { API_PREFIX } from "../api/paths";
import type {
  AggregateGroup,
  YieldMonitorV3AggregateResponse,
  YieldMonitorV3Response,
  YieldMonitorV3Row,
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
  { label: "ProbeCardType", value: "probeCardType" },
  { label: "Wafer", value: "wafer" },
  { label: "Hostname", value: "hostname" },
  { label: "Pass", value: "pass" },
];

// Sub-dimension options for drill-down panels
const DRILL_FROM_CARDTYPE: { label: string; value: string }[] = [
  { label: "ProbeCard", value: "probeCard" },
  { label: "按日", value: "timeDay" },
  { label: "Device", value: "device" },
  { label: "Wafer", value: "wafer" },
  { label: "Hostname", value: "hostname" },
];

const DRILL_FROM_LOT: { label: string; value: string }[] = [
  { label: "ProbeCardType", value: "probeCardType" },
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
  // probeCardType-level aggregate (chart); probeCard detail accessed via drill
  const [aggCardType, setAggCardType] = useState<YieldMonitorV3AggregateResponse | null>(null);
  const [aggLot, setAggLot] = useState<YieldMonitorV3AggregateResponse | null>(null);
  const [aggTree, setAggTree] = useState<YieldMonitorV3AggregateResponse | null>(null);
  const [aggFree, setAggFree] = useState<YieldMonitorV3AggregateResponse | null>(null);
  const [freeDim, setFreeDim] = useState("timeDay");

  const [loadingList, setLoadingList] = useState(false);
  const [loadingAgg, setLoadingAgg] = useState(false);
  const [errorList, setErrorList] = useState<string | null>(null);
  const [errorAgg, setErrorAgg] = useState<string | null>(null);

  const [drill, setDrill] = useState<DrillState | null>(null);
  const [showTree,   setShowTree]   = useState(false);
  const [showDetail, setShowDetail] = useState(false);
  // The probeCard the user selected by clicking a bar inside the drill panel
  const [selectedProbeCard, setSelectedProbeCard] = useState<string | null>(null);
  const [selectedCardTypeName, setSelectedCardTypeName] = useState<string | null>(null);
  const [selectedLotId,       setSelectedLotId]       = useState<string | null>(null);

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
        // probeCardType is not a real DB column — the API ignores it as a filter.
        // Send probeCard prefix instead (no-op for other parentDimKeys).
        const extraParams: Record<string, string | number | undefined> = {
          [parentDimKey]: parentDimVal,
        };
        const params = {
          ...buildCoreParams(currentForm),
          ...extraParams,
          dimensions: subDim,
          groupTop: 50,
        };
        const res = await apiGetJson<YieldMonitorV3AggregateResponse>(
          apiBase,
          `${API_PREFIX}/yield-monitor-triggers/v4/aggregate`,
          params
        );
        // When drilling from probeCardType → probeCard, the API ignores the
        // probeCardType filter (not a real column). Filter client-side:
        // PROBECARDTYPE = leading segment before the first '-' in PROBECARD.
        let groups = res.groups;
        if (parentDimKey === "probeCardType" && subDim === "probeCard") {
          const typeLower = parentDimVal.trim().toLowerCase();
          groups = groups.filter((g) => {
            const card = (g.parts.probeCard ?? g.key).trim();
            const dash = card.indexOf("-");
            const prefix = (dash > 0 ? card.slice(0, dash) : card).toLowerCase();
            return prefix === typeLower;
          });
        }
        setDrill((d) =>
          d && d.parentDimKey === parentDimKey && d.parentDimVal === parentDimVal
            ? { ...d, groups, loading: false }
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
    setSelectedProbeCard(null);
    setSelectedCardTypeName(null);
    setSelectedLotId(null);
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
            { ...core, dimensions: "probeCardType", groupTop: 25 }
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
            { ...core, dimensions: "device,lotId,probeCardType,probeCard", groupTop: 100 }
          ),
      ],
      REPORT_ORACLE_FANOUT_CONCURRENCY
    );
    const [listRes, timeRes, cardTypeRes, lotRes, treeRes] = settled as [
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
    if (cardTypeRes.status === "fulfilled") setAggCardType(cardTypeRes.value);
    if (lotRes.status === "fulfilled") setAggLot(lotRes.value);
    if (treeRes.status === "fulfilled") setAggTree(treeRes.value);
    if (timeRes.status === "rejected" || cardTypeRes.status === "rejected") {
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
    aggTime?.totalRowsMatching ?? aggCardType?.totalRowsMatching ?? null;

  const uniqueLots = useMemo(() => {
    if (!list) return null;
    return new Set(list.rows.map((r) => r.LOTID).filter(Boolean)).size;
  }, [list]);

  // Worst probeCardType (most triggers)
  const worstCardType = useMemo(() => {
    const groups = aggCardType?.groups ?? [];
    return groups[0]?.parts?.probeCardType ?? null;
  }, [aggCardType]);

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

  // ProbeCard Type ranking bar chart
  const cardTypeOption = useMemo((): EChartsOption => {
    const sorted = [...(aggCardType?.groups ?? [])]
      .sort((a, b) => a.count - b.count)
      .slice(-10);
    const COL = chartAccent2, COL_B = "#bf8dff", COL_D = "rgba(163,113,247,0.3)";
    return {
      ...baseChartOption(),
      xAxis: {
        type: "value",
        axisLabel: { color: chartAxisColor },
        splitLine: { lineStyle: { color: chartSplitLine } },
      },
      yAxis: {
        type: "category",
        data: sorted.map((g) => g.parts.probeCardType ?? g.key),
        axisLabel: { color: chartTextColor, fontSize: 11 },
      },
      series: [
        {
          type: "bar",
          data: sorted.map((g) => {
            const name = g.parts.probeCardType ?? g.key;
            const isSel = selectedCardTypeName !== null && name === selectedCardTypeName;
            return {
              value: g.count,
              itemStyle: {
                color: isSel ? COL_B : selectedCardTypeName !== null ? COL_D : COL,
                borderRadius: [0, 4, 4, 0] as unknown as number,
              },
            };
          }),
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
  }, [aggCardType, selectedCardTypeName]);

  // DUT distribution — only meaningful once a specific ProbeCard is selected
  const dutRows = useMemo(() => {
    if (!selectedProbeCard || !list?.rows?.length) return null;
    return (list.rows as YieldMonitorV3Row[]).filter(
      (r) => r.PROBECARD === selectedProbeCard
    );
  }, [selectedProbeCard, list]);

  const dutOption = useMemo((): EChartsOption => {
    const entries = tallyDutNumbers(dutRows ?? []).slice(0, 10);
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
          itemStyle: { color: chartAccent3, borderRadius: [0, 4, 4, 0] as unknown as number },
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
  }, [dutRows]);

  const lotOption = useMemo((): EChartsOption => {
    const sorted = [...(aggLot?.groups ?? [])]
      .sort((a, b) => a.count - b.count)
      .slice(-10);
    const COL = "#f0883e", COL_B = "#ff9f60", COL_D = "rgba(240,136,62,0.3)";
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
          data: sorted.map((g) => {
            const name = g.parts.lotId ?? g.key;
            const isSel = selectedLotId !== null && name === selectedLotId;
            return {
              value: g.count,
              itemStyle: {
                color: isSel ? COL_B : selectedLotId !== null ? COL_D : COL,
                borderRadius: [0, 4, 4, 0] as unknown as number,
              },
            };
          }),
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
  }, [aggLot, selectedLotId]);

  const freeOption = useMemo((): EChartsOption => {
    const sorted = [...(aggFree?.groups ?? [])]
      .sort((a, b) => a.count - b.count)
      .slice(-10);
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
          itemStyle: { color: chartAccent, borderRadius: [0, 4, 4, 0] as unknown as number },
          animationDuration: 600,
        },
      ],
    };
  }, [aggFree]);

  // ── Tree ─────────────────────────────────────────────────────────────────

  const treeRoots = useMemo(() => {
    if (!aggTree?.groups?.length) return [];
    return buildTree(aggTree.groups, ["device", "lotId", "probeCardType", "probeCard"]);
  }, [aggTree]);

  // ── Detail table rows ────────────────────────────────────────────────────

  const detailRows = useMemo(() => {
    if (!list?.rows?.length) return [];
    return (list.rows as YieldMonitorV3Row[]).map((r) => ({
      TIME_STAMP: r.TIME_STAMP ?? "",
      HOSTNAME: r.HOSTNAME ?? "",
      DEVICE: r.DEVICE ?? "",
      LOTID: r.LOTID ?? "",
      WAFER: r.WAFER ?? "",
      PROBECARDTYPE: r.PROBECARDTYPE ?? "—",
      PROBECARD: r.PROBECARD ?? "",
      dutNumber: r.dutNumber ?? "—",
    }));
  }, [list]);

  const chips = useMemo(() => activeChips(form), [form]);
  const hasData = !!(list || aggTime || aggCardType);

  return (
    <div className="report-panel">
      {/* ── Header ── */}
      <div className="report-panel-header">
        <div>
          <h2>⚡ Yield Monitor</h2>
          <p className="report-desc">
            产量触发分析（TYPE = delta_diff）。选填筛选条件后点「查询」，
            并行获取明细 + 时间趋势 + 探针卡类型/LOT 聚合。点击探针卡类型→钻取卡ID→点选→查看 DUT 分布。
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
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
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
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
            <KpiCard label="触发总数" value={totalTriggers} color="blue" />
            <KpiCard label="涉及 Lot 数" value={uniqueLots} color="white" />
            <KpiCard
              label="触发最多探针卡类型"
              value={worstCardType}
              color="red"
              subtext="触发次数最多"
            />
            <KpiCard
              label="已选探针卡"
              value={selectedProbeCard ?? "—"}
              color={selectedProbeCard ? "blue" : "white"}
              subtext={selectedProbeCard ? "点击下方图表切换" : "点击钻取面板中的卡选择"}
            />
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
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            {/* ProbeCard Type ranking — click to drill into probeCard IDs */}
            <div
              style={{
                background: "#0d1117",
                border: "1px solid rgba(240,246,252,0.1)",
                borderRadius: 8,
                padding: 16,
              }}
            >
              <div style={{ fontSize: 12, color: "#8b949e", marginBottom: 8 }}>
                🔴 ProbeCard Type 触发排名
                <span style={{ marginLeft: 8, fontSize: 11, color: "#6e7681" }}>
                  点击类型 → 钻取卡ID → 点选卡查看 DUT
                </span>
              </div>
              {aggCardType && (
                <ReactECharts
                  option={cardTypeOption}
                  style={{
                    height: Math.max(180, (aggCardType.groups?.length ?? 0) * 22 + 60),
                    width: "100%",
                  }}
                  opts={{ renderer: "canvas" }}
                  notMerge
                  lazyUpdate
                  onEvents={{
                    click: (params: { name: string }) => {
                      setSelectedCardTypeName(params.name);
                      setSelectedProbeCard(null);
                      fetchDrill("probeCardType", params.name, "probeCard", form);
                    },
                  }}
                />
              )}
              {/* Drill panel: probeCardType → probeCard, bars clickable to select */}
              {drill?.parentDimKey === "probeCardType" && (
                <DrillDownPanel
                  title={`${drill.parentDimVal} · 下钻：按 ${drill.subDim}`}
                  groups={drill.groups}
                  loading={drill.loading}
                  error={drill.error}
                  activeSubDim={drill.subDim}
                  subDimOptions={DRILL_FROM_CARDTYPE}
                  onSubDimChange={(d) => {
                    if (d !== "probeCard") setSelectedProbeCard(null);
                    fetchDrill("probeCardType", drill.parentDimVal, d, form);
                  }}
                  onClose={() => {
                    setSelectedCardTypeName(null);
                    setSelectedProbeCard(null);
                    setDrill(null);
                  }}
                  onBarClick={
                    drill.subDim === "probeCard"
                      ? (key) => setSelectedProbeCard(key)
                      : undefined
                  }
                  selectedKey={drill.subDim === "probeCard" ? selectedProbeCard : null}
                />
              )}
            </div>

            {/* DUT distribution — linked to selectedProbeCard */}
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
                {selectedProbeCard && (
                  <span
                    style={{
                      marginLeft: 8,
                      color: "#58a6ff",
                      fontWeight: 600,
                      fontSize: 11,
                    }}
                  >
                    — {selectedProbeCard}
                  </span>
                )}
              </div>
              {selectedProbeCard && dutRows !== null ? (
                dutRows.length === 0 ? (
                  <div style={{ color: "#8b949e", fontSize: 12, padding: "12px 0" }}>
                    该探针卡在当前明细范围内无数据（明细最多 500 条）
                  </div>
                ) : (
                  <DarkChart
                    option={dutOption}
                    height={Math.max(180, tallyDutNumbers(dutRows).length * 22 + 60)}
                  />
                )
              ) : (
                <div
                  style={{
                    color: "#8b949e",
                    fontSize: 12,
                    padding: "32px 0",
                    textAlign: "center",
                    lineHeight: 1.8,
                  }}
                >
                  ← 点击左侧「ProbeCard Type」图表中的类型
                  <br />
                  展开后点击具体探针卡即可查看该卡的 DUT# 分布
                </div>
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
                      setSelectedLotId(params.name);
                      fetchDrill("lotId", params.name, "probeCardType", form);
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
                  subDimOptions={DRILL_FROM_LOT}
                  onSubDimChange={(d) =>
                    fetchDrill("lotId", drill.parentDimVal, d, form)
                  }
                  onClose={() => { setSelectedLotId(null); setDrill(null); }}
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
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
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
                  height={Math.max(180, aggFree.groups.length * 22 + 60)}
                />
              )}
            </div>
          </div>

          {/* ── Tree table: Device → LOT → ProbeCard Type → ProbeCard ── */}
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
                style={{ fontSize: 12, color: "#8b949e", marginBottom: showTree ? 10 : 0, cursor: "pointer", display: "flex", alignItems: "center", gap: 6, userSelect: "none" }}
                onClick={() => setShowTree((s) => !s)}
              >
                <span style={{ fontSize: 10, opacity: 0.6 }}>{showTree ? "▼" : "▶"}</span>
                📊 分组汇总（Device → LOT → ProbeCard Type → ProbeCard ID）
                <span style={{ fontSize: 11, color: "#6e7681", fontWeight: 400 }}>{showTree ? "" : `— ${treeRoots.length} 组，点击展开`}</span>
              </div>
              {showTree && <TreeTable roots={treeRoots} totalHeader="触发次数" />}
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
              <div
                style={{ fontSize: 12, color: "#8b949e", marginBottom: showDetail ? 8 : 0, cursor: "pointer", display: "flex", alignItems: "center", gap: 6, userSelect: "none" }}
                onClick={() => setShowDetail((s) => !s)}
              >
                <span style={{ fontSize: 10, opacity: 0.6 }}>{showDetail ? "▼" : "▶"}</span>
                明细表 — 共 {list?.count ?? 0} 条（含 PROBECARDTYPE / dutNumber）
              </div>
              {showDetail && <DataTable rows={detailRows} maxHeight={400} />}
            </div>
          )}
        </>
      )}
    </div>
  );
}
