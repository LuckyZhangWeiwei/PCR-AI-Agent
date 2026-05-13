import { useCallback, useMemo, useState } from "react";
import ReactECharts from "echarts-for-react";
import { apiGetJson } from "../api/client";
import { API_PREFIX } from "../api/paths";
import type {
  AggregateGroup,
  InfcontrolAggregateResponse,
  InfcontrolLayerBinsV3Response,
  InfcontrolLayerBinV3Row,
} from "../api/types";
import { DarkChart } from "../components/DarkChart";
import { DataTable } from "../components/DataTable";
import { DrillDownPanel } from "../components/DrillDownPanel";
import { KpiCard } from "../components/KpiCard";
import { TreeTable } from "../components/TreeTable";
import {
  baseChartOption,
  chartAxisColor,
  chartSplitLine,
  chartTextColor,
} from "../theme/chartTheme";
import { datetimeLocalToIso } from "../utils/datetimeLocal";
import {
  buildTree,
  computeYieldPct,
  dateShortcutLast7Days,
  dateShortcutThisMonth,
  dateShortcutToday,
  yieldColor,
} from "../utils/yieldCalc";
import type { EChartsOption } from "echarts";

const TSTYPE_OPTIONS = ["UFLEX", "J750", "PS16", "MST", "FLEX", "93K", "J971"] as const;

type Props = { apiBase: string };

type FormState = {
  device: string;
  lot: string;
  slot: string;
  cardId: string;
  tstype: string;
  testerId: string;
  passId: string;
  meslot: string;
  testEndFrom: string;
  testEndTo: string;
  limit: string;
};

const initialForm: FormState = {
  device: "",
  lot: "",
  slot: "",
  cardId: "",
  tstype: "",
  testerId: "",
  passId: "",
  meslot: "",
  testEndFrom: "",
  testEndTo: "",
  limit: "500",
};

function buildCoreParams(f: FormState): Record<string, string | number | undefined> {
  return {
    device:      f.device   || undefined,
    lot:         f.lot      || undefined,
    slot:        f.slot     ? Number(f.slot)   : undefined,
    cardId:      f.cardId   || undefined,
    tstype:      f.tstype   || undefined,
    testerId:    f.testerId || undefined,
    passId:      f.passId   ? Number(f.passId) : undefined,
    meslot:      f.meslot   || undefined,
    testEndFrom: datetimeLocalToIso(f.testEndFrom),
    testEndTo:   datetimeLocalToIso(f.testEndTo),
  };
}

function buildListParams(f: FormState): Record<string, string | number | undefined> {
  const lim = Number(f.limit);
  return {
    ...buildCoreParams(f),
    limit: Number.isFinite(lim) ? Math.min(500, Math.max(1, Math.floor(lim))) : 500,
  };
}

const HIDE_CHIPS = new Set(["testEndFrom", "testEndTo"]);
function activeChips(f: FormState): { key: string; label: string }[] {
  const chips: { key: string; label: string }[] = [];
  for (const [k, v] of Object.entries(buildCoreParams(f))) {
    if (v === undefined || HIDE_CHIPS.has(k)) continue;
    chips.push({ key: k, label: `${k} = ${v}` });
  }
  if (f.testEndFrom || f.testEndTo) {
    const label =
      f.testEndFrom && f.testEndTo
        ? `testEnd ${f.testEndFrom} → ${f.testEndTo}`
        : f.testEndFrom
        ? `testEnd ≥ ${f.testEndFrom}`
        : `testEnd ≤ ${f.testEndTo}`;
    chips.push({ key: "__time__", label });
  }
  return chips;
}

const FREE_DIMS: { label: string; value: string }[] = [
  { label: "Bin",      value: "bin"      },
  { label: "Lot",      value: "lot"      },
  { label: "Device",   value: "device"   },
  { label: "CardId",   value: "cardId"   },
  { label: "Slot",     value: "slot"     },
  { label: "TsType",   value: "tstype"   },
  { label: "PassId",   value: "passId"   },
  { label: "TesterId", value: "testerId" },
];

type DrillState = {
  parentDimKey: string;
  parentDimVal: string;
  subDim: string;
  groups: AggregateGroup[];
  loading: boolean;
  error: string | null;
};

function lotYields(
  rows: InfcontrolLayerBinV3Row[]
): Array<{ lot: string; yieldPct: number }> {
  const byLot = new Map<string, InfcontrolLayerBinV3Row[]>();
  for (const r of rows) {
    const lot = r.LOT ?? "—";
    if (!byLot.has(lot)) byLot.set(lot, []);
    byLot.get(lot)!.push(r);
  }
  const result: Array<{ lot: string; yieldPct: number }> = [];
  for (const [lot, lotRows] of byLot.entries()) {
    const yp = computeYieldPct(lotRows);
    if (yp !== null) result.push({ lot, yieldPct: yp });
  }
  return result.sort((a, b) => a.yieldPct - b.yieldPct);
}

export function InfcontrolReport({ apiBase }: Props) {
  const [form, setForm] = useState<FormState>(initialForm);
  const [list,    setList]    = useState<InfcontrolLayerBinsV3Response | null>(null);
  const [aggBin,  setAggBin]  = useState<InfcontrolAggregateResponse | null>(null);
  const [aggCard, setAggCard] = useState<InfcontrolAggregateResponse | null>(null);
  const [aggSlot, setAggSlot] = useState<InfcontrolAggregateResponse | null>(null);
  const [aggTree, setAggTree] = useState<InfcontrolAggregateResponse | null>(null);
  const [aggFree, setAggFree] = useState<InfcontrolAggregateResponse | null>(null);
  const [freeDim, setFreeDim] = useState("bin");

  const [loadingList, setLoadingList] = useState(false);
  const [loadingAgg,  setLoadingAgg]  = useState(false);
  const [errorList,   setErrorList]   = useState<string | null>(null);
  const [errorAgg,    setErrorAgg]    = useState<string | null>(null);
  const [drill,       setDrill]       = useState<DrillState | null>(null);

  const setField = useCallback(
    <K extends keyof FormState>(k: K, v: FormState[K]) => {
      setForm((f) => ({ ...f, [k]: v }));
    },
    []
  );

  const clearFilter = useCallback((key: string) => {
    if (key === "__time__")
      setForm((f) => ({ ...f, testEndFrom: "", testEndTo: "" }));
    else setForm((f) => ({ ...f, [key]: "" } as FormState));
  }, []);

  const applyDateShortcut = useCallback((fn: () => [string, string]) => {
    const [from, to] = fn();
    setForm((f) => ({ ...f, testEndFrom: from, testEndTo: to }));
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
        const gby = subDim.includes("bin") ? subDim : `${subDim},bin`;
        const params = {
          ...buildCoreParams(currentForm),
          [parentDimKey]: parentDimVal,
          groupBy: gby,
          groupTop: 25,
        };
        const res = await apiGetJson<InfcontrolAggregateResponse>(
          apiBase,
          `${API_PREFIX}/infcontrol-layer-bins/v3/aggregate`,
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
        const gby = dim === "bin" ? "bin" : `${dim},bin`;
        const res = await apiGetJson<InfcontrolAggregateResponse>(
          apiBase,
          `${API_PREFIX}/infcontrol-layer-bins/v3/aggregate`,
          { ...buildCoreParams(currentForm), groupBy: gby, groupTop: 30 }
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

    const [listRes, binRes, cardRes, slotRes, treeRes] =
      await Promise.allSettled([
        apiGetJson<InfcontrolLayerBinsV3Response>(
          apiBase,
          `${API_PREFIX}/infcontrol-layer-bins/v3`,
          buildListParams(form)
        ),
        apiGetJson<InfcontrolAggregateResponse>(
          apiBase,
          `${API_PREFIX}/infcontrol-layer-bins/v3/aggregate`,
          { ...core, groupBy: "bin", groupTop: 30 }
        ),
        apiGetJson<InfcontrolAggregateResponse>(
          apiBase,
          `${API_PREFIX}/infcontrol-layer-bins/v3/aggregate`,
          { ...core, groupBy: "cardId,bin", groupTop: 25 }
        ),
        apiGetJson<InfcontrolAggregateResponse>(
          apiBase,
          `${API_PREFIX}/infcontrol-layer-bins/v3/aggregate`,
          { ...core, groupBy: "slot,bin", groupTop: 50 }
        ),
        apiGetJson<InfcontrolAggregateResponse>(
          apiBase,
          `${API_PREFIX}/infcontrol-layer-bins/v3/aggregate`,
          { ...core, groupBy: "device,lot,cardId,bin", groupTop: 50 }
        ),
      ]);

    setLoadingList(false);
    setLoadingAgg(false);

    if (listRes.status === "fulfilled") setList(listRes.value);
    else
      setErrorList(
        listRes.reason instanceof Error
          ? listRes.reason.message
          : String(listRes.reason)
      );

    if (binRes.status  === "fulfilled") setAggBin(binRes.value);
    if (cardRes.status === "fulfilled") setAggCard(cardRes.value);
    if (slotRes.status === "fulfilled") setAggSlot(slotRes.value);
    if (treeRes.status === "fulfilled") setAggTree(treeRes.value);
    if (binRes.status === "rejected")
      setErrorAgg("BIN 聚合请求失败，部分图表不可用");

    fetchFreeAgg(freeDim, form);
  }, [apiBase, form, freeDim, fetchFreeAgg]);

  const handleFreeDimChange = useCallback(
    (dim: string) => {
      setFreeDim(dim);
      if (list || aggBin) fetchFreeAgg(dim, form);
    },
    [list, aggBin, form, fetchFreeAgg]
  );

  // ── KPI derivations ──────────────────────────────────────────────────────

  const totalWafers = aggBin?.totalRowsMatching ?? null;

  const overallYield = useMemo(() => {
    if (!list?.rows?.length) return null;
    return computeYieldPct(list.rows as InfcontrolLayerBinV3Row[]);
  }, [list]);

  const worstCard = useMemo(() => {
    if (!aggCard?.groups?.length) return null;
    const cardBad = new Map<string, number>();
    for (const g of aggCard.groups) {
      const c = g.parts.cardId ?? "";
      if (c) cardBad.set(c, (cardBad.get(c) ?? 0) + g.count);
    }
    if (cardBad.size === 0) return null;
    return [...cardBad.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }, [aggCard]);

  const topBin = useMemo(() => {
    const groups = aggBin?.groups ?? [];
    if (!groups.length) return null;
    return `Bin ${groups[0].parts.bin ?? groups[0].key}`;
  }, [aggBin]);

  // ── Chart options ────────────────────────────────────────────────────────

  const lotYieldData = useMemo(() => {
    if (!list?.rows?.length) return [];
    return lotYields(list.rows as InfcontrolLayerBinV3Row[]);
  }, [list]);

  const lotYieldOption = useMemo((): EChartsOption => {
    const data = lotYieldData.slice(-30);
    return {
      ...baseChartOption(),
      xAxis: {
        type: "value",
        max: 100,
        axisLabel: {
          color: chartAxisColor,
          formatter: "{value}%",
        },
        splitLine: { lineStyle: { color: chartSplitLine } },
      },
      yAxis: {
        type: "category",
        data: data.map((d) => d.lot),
        axisLabel: { color: chartTextColor, fontSize: 11 },
      },
      series: [
        {
          type: "bar",
          data: data.map((d) => ({
            value: Number(d.yieldPct.toFixed(2)),
            itemStyle: {
              color:
                d.yieldPct >= 95
                  ? "#238636"
                  : d.yieldPct >= 80
                  ? "#9e6a03"
                  : "#da3633",
              borderRadius: [0, 4, 4, 0] as unknown as number,
            },
          })),
          label: {
            show: true,
            position: "right",
            color: chartAxisColor,
            fontSize: 10,
            formatter: "{c}%",
          },
          animationDuration: 600,
        },
      ],
    };
  }, [lotYieldData]);

  const binRankOption = useMemo((): EChartsOption => {
    const sorted = [...(aggBin?.groups ?? [])]
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
        data: sorted.map((g) => `Bin ${g.parts.bin ?? g.key}`),
        axisLabel: { color: chartTextColor, fontSize: 11 },
      },
      series: [
        {
          type: "bar",
          data: sorted.map((g) => g.count),
          itemStyle: { color: "#ff7b72", borderRadius: [0, 4, 4, 0] as unknown as number },
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
  }, [aggBin]);

  const cardOption = useMemo((): EChartsOption => {
    const cardBad = new Map<string, number>();
    for (const g of aggCard?.groups ?? []) {
      const c = g.parts.cardId ?? "—";
      cardBad.set(c, (cardBad.get(c) ?? 0) + g.count);
    }
    const sorted = [...cardBad.entries()].sort((a, b) => a[1] - b[1]).slice(-20);
    return {
      ...baseChartOption(),
      xAxis: {
        type: "value",
        axisLabel: { color: chartAxisColor },
        splitLine: { lineStyle: { color: chartSplitLine } },
      },
      yAxis: {
        type: "category",
        data: sorted.map(([c]) => c),
        axisLabel: { color: chartTextColor, fontSize: 11 },
      },
      series: [
        {
          type: "bar",
          data: sorted.map(([, v]) => v),
          itemStyle: { color: "#e6b450", borderRadius: [0, 4, 4, 0] as unknown as number },
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

  const slotOption = useMemo((): EChartsOption => {
    const slotBad = new Map<string, number>();
    for (const g of aggSlot?.groups ?? []) {
      const s = g.parts.slot ?? "—";
      slotBad.set(s, (slotBad.get(s) ?? 0) + g.count);
    }
    const sorted = [...slotBad.entries()].sort(
      (a, b) => Number(a[0]) - Number(b[0])
    );
    return {
      ...baseChartOption(),
      xAxis: {
        type: "category",
        data: sorted.map(([s]) => `Slot ${s}`),
        axisLabel: { color: chartAxisColor, fontSize: 10, rotate: 30 },
      },
      yAxis: {
        type: "value",
        axisLabel: { color: chartAxisColor },
        splitLine: { lineStyle: { color: chartSplitLine } },
      },
      series: [
        {
          type: "bar",
          data: sorted.map(([, v]) => v),
          itemStyle: { color: "#79c0ff", borderRadius: [4, 4, 0, 0] as unknown as number },
          animationDuration: 600,
        },
      ],
    };
  }, [aggSlot]);

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
          itemStyle: { color: "#58a6ff", borderRadius: [0, 4, 4, 0] as unknown as number },
          animationDuration: 600,
        },
      ],
    };
  }, [aggFree]);

  // ── Tree ─────────────────────────────────────────────────────────────────

  const treeRoots = useMemo(() => {
    if (!aggTree?.groups?.length) return [];
    return buildTree(aggTree.groups, ["device", "lot", "cardId", "bin"]);
  }, [aggTree]);

  // ── Detail rows ──────────────────────────────────────────────────────────

  const detailRows = useMemo(() => {
    if (!list?.rows?.length) return [];
    return (list.rows as InfcontrolLayerBinV3Row[]).map((r) => {
      const yp = computeYieldPct([r]);
      return {
        TESTEND:  r.TESTEND ?? "",
        DEVICE:   r.DEVICE ?? "",
        LOT:      r.LOT ?? "",
        SLOT:     r.SLOT ?? "",
        CARDID:   r.CARDID ?? "",
        PASSID:   r.PASSID ?? "",
        "Yield%": yp !== null ? `${yp.toFixed(1)}%` : "—",
      };
    });
  }, [list]);

  const chips = useMemo(() => activeChips(form), [form]);
  const hasData = !!(list || aggBin || aggCard);

  return (
    <div className="report-panel">
      {/* ── Header ── */}
      <div className="report-panel-header">
        <div>
          <h2>🔬 JB START</h2>
          <p className="report-desc">
            层控 BIN 数据（PASSTYPE = TEST）。复合筛选，一键触发：明细 + BIN 排名 +
            探针卡对比 + Slot 趋势。Yield% 由前端从 bins[].isGoodBin + GROSSDIE 计算。
          </p>
        </div>
      </div>

      {/* ── Filter grid ── */}
      <div className="filter-grid">
        {(
          [
            ["Device",   "device"  ],
            ["Lot",      "lot"     ],
            ["Slot",     "slot"    ],
            ["CardId",   "cardId"  ],
            ["TesterID", "testerId"],
            ["PassID",   "passId"  ],
            ["MES Slot", "meslot"  ],
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

        <label>
          <span>Tester Type</span>
          <select
            value={form.tstype}
            onChange={(e) => setField("tstype", e.target.value)}
          >
            <option value="">全部</option>
            {TSTYPE_OPTIONS.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </label>

        <label className="span-2">
          <span>测试结束时间（testEnd）</span>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="datetime-local"
              value={form.testEndFrom}
              onChange={(e) => setField("testEndFrom", e.target.value)}
              style={{ flex: 1 }}
            />
            <span style={{ color: "#8b949e", fontSize: 12 }}>→</span>
            <input
              type="datetime-local"
              value={form.testEndTo}
              onChange={(e) => setField("testEndTo", e.target.value)}
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

      {/* ── Chips + Query button ── */}
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
              gridTemplateColumns: "repeat(4,1fr)",
              gap: 12,
            }}
          >
            <KpiCard label="匹配 Wafer 数" value={totalWafers} color="blue" />
            <KpiCard
              label="综合 Yield%"
              value={
                overallYield !== null ? `${overallYield.toFixed(1)}%` : null
              }
              color={
                overallYield !== null
                  ? overallYield >= 95
                    ? "green"
                    : overallYield >= 80
                    ? "yellow"
                    : "red"
                  : "white"
              }
              subtext="前端计算"
            />
            <KpiCard
              label="最差探针卡"
              value={worstCard}
              color="red"
              subtext="坏 die 最多"
            />
            <KpiCard
              label="Top 不良 Bin"
              value={topBin}
              color="yellow"
              subtext="全量最高"
            />
          </div>

          {/* ── LOT Yield% bar (full width) ── */}
          {lotYieldData.length > 0 && (
            <div
              style={{
                background: "#0d1117",
                border: "1px solid rgba(240,246,252,0.1)",
                borderRadius: 8,
                padding: 16,
              }}
            >
              <div style={{ fontSize: 12, color: "#8b949e", marginBottom: 8 }}>
                🟢 各 LOT Yield%（绿≥95% / 黄80-95% / 红&lt;80%）
              </div>
              <ReactECharts
                option={lotYieldOption}
                style={{
                  height: Math.max(180, lotYieldData.length * 22 + 60),
                  width: "100%",
                }}
                opts={{ renderer: "canvas" }}
                notMerge
                lazyUpdate
                onEvents={{
                  click: (params: { name: string }) => {
                    fetchDrill("lot", params.name, "slot", form);
                  },
                }}
              />
              {drill?.parentDimKey === "lot_yield" && (
                <DrillDownPanel
                  title={`${drill.parentDimVal} · 下钻：按 ${drill.subDim}`}
                  groups={drill.groups}
                  loading={drill.loading}
                  error={drill.error}
                  activeSubDim={drill.subDim}
                  subDimOptions={[
                    { label: "CardId", value: "cardId" },
                    { label: "Slot",   value: "slot"   },
                    { label: "Bin",    value: "bin"    },
                  ]}
                  onSubDimChange={(d) =>
                    fetchDrill("lot", drill.parentDimVal, d, form)
                  }
                  onClose={() => setDrill(null)}
                />
              )}
            </div>
          )}

          {/* ── Charts 2×2 ── */}
          <div
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}
          >
            {/* BIN ranking */}
            <div
              style={{
                background: "#0d1117",
                border: "1px solid rgba(240,246,252,0.1)",
                borderRadius: 8,
                padding: 16,
              }}
            >
              <div style={{ fontSize: 12, color: "#8b949e", marginBottom: 8 }}>
                🔴 不良 BIN 全量排名
              </div>
              {aggBin && (
                <ReactECharts
                  option={binRankOption}
                  style={{
                    height: Math.max(180, (aggBin.groups?.length ?? 0) * 22 + 60),
                    width: "100%",
                  }}
                  opts={{ renderer: "canvas" }}
                  notMerge
                  lazyUpdate
                  onEvents={{
                    click: (params: { name: string }) => {
                      const bin = params.name.replace(/^Bin /, "");
                      fetchDrill("bin", bin, "cardId", form);
                    },
                  }}
                />
              )}
              {drill?.parentDimKey === "bin" && (
                <DrillDownPanel
                  title={`Bin ${drill.parentDimVal} · 下钻：按 ${drill.subDim}`}
                  groups={drill.groups}
                  loading={drill.loading}
                  error={drill.error}
                  activeSubDim={drill.subDim}
                  subDimOptions={[
                    { label: "CardId", value: "cardId" },
                    { label: "Lot",    value: "lot"    },
                    { label: "Slot",   value: "slot"   },
                  ]}
                  onSubDimChange={(d) =>
                    fetchDrill("bin", drill.parentDimVal, d, form)
                  }
                  onClose={() => setDrill(null)}
                />
              )}
            </div>

            {/* ProbeCard comparison */}
            <div
              style={{
                background: "#0d1117",
                border: "1px solid rgba(240,246,252,0.1)",
                borderRadius: 8,
                padding: 16,
              }}
            >
              <div style={{ fontSize: 12, color: "#8b949e", marginBottom: 8 }}>
                🃏 ProbeCard 不良对比
              </div>
              {aggCard && (
                <ReactECharts
                  option={cardOption}
                  style={{
                    height: Math.max(
                      180,
                      new Map(
                        aggCard.groups?.map((g) => [g.parts.cardId, 1]) ?? []
                      ).size *
                        22 +
                        60
                    ),
                    width: "100%",
                  }}
                  opts={{ renderer: "canvas" }}
                  notMerge
                  lazyUpdate
                  onEvents={{
                    click: (params: { name: string }) => {
                      fetchDrill("cardId", params.name, "slot", form);
                    },
                  }}
                />
              )}
              {drill?.parentDimKey === "cardId" && (
                <DrillDownPanel
                  title={`${drill.parentDimVal} · 下钻：按 ${drill.subDim}`}
                  groups={drill.groups}
                  loading={drill.loading}
                  error={drill.error}
                  activeSubDim={drill.subDim}
                  subDimOptions={[
                    { label: "Slot", value: "slot" },
                    { label: "Bin",  value: "bin"  },
                    { label: "Lot",  value: "lot"  },
                  ]}
                  onSubDimChange={(d) =>
                    fetchDrill("cardId", drill.parentDimVal, d, form)
                  }
                  onClose={() => setDrill(null)}
                />
              )}
            </div>

            {/* Slot trend */}
            <div
              style={{
                background: "#0d1117",
                border: "1px solid rgba(240,246,252,0.1)",
                borderRadius: 8,
                padding: 16,
              }}
            >
              <div style={{ fontSize: 12, color: "#8b949e", marginBottom: 8 }}>
                📊 Slot 趋势（wafer 间比较）
              </div>
              {aggSlot && <DarkChart option={slotOption} height={240} />}
            </div>

            {/* Free-dim aggregate */}
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
                    (aggFree.groups?.length ?? 0) * 22 + 60
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
                📊 分组汇总（Device → LOT → CardId → Bin）
              </div>
              <TreeTable
                roots={treeRoots}
                totalHeader="坏 die"
                renderExtra={(node, depth) => {
                  if (depth > 1) return null;
                  const device =
                    node.dimKey === "device" ? node.dimValue : undefined;
                  const lot =
                    node.dimKey === "lot" ? node.dimValue : undefined;
                  if (!list?.rows?.length) return null;
                  const filtered = (
                    list.rows as InfcontrolLayerBinV3Row[]
                  ).filter((r) => {
                    if (device && r.DEVICE !== device) return false;
                    if (lot && r.LOT !== lot) return false;
                    return true;
                  });
                  const yp = computeYieldPct(filtered);
                  if (yp === null) return null;
                  return (
                    <span style={{ fontSize: 11, color: yieldColor(yp) }}>
                      {yp.toFixed(1)}%
                    </span>
                  );
                }}
              />
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
                明细表 — 共 {list?.count ?? 0} 条（含 Yield%）
              </div>
              <DataTable rows={detailRows} maxHeight={400} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
