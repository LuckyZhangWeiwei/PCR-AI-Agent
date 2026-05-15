import { useCallback, useMemo, useState, type ReactNode } from "react";
import ReactECharts from "echarts-for-react";
import { apiGetJson } from "../api/client";
import { API_PREFIX, INFCONTROL_AGGREGATE_PATH } from "../api/paths";
import type {
  AggregateGroup,
  InfcontrolAggregateResponse,
  InfcontrolLayerBinsV3Response,
  InfcontrolLayerBinV3Row,
} from "../api/types";
import { CollapsibleQueryPanel } from "../components/CollapsibleQueryPanel";
import { DarkChart } from "../components/DarkChart";
import { DataTable } from "../components/DataTable";
import {
  DraggableReportBlocks,
  DraggableReportSections,
  JB_START_LAYOUT_STORAGE_KEYS,
  ReportLayoutResetButton,
  resetReportLayoutStorage,
} from "../components/DraggableReportSections";
import { DrillDownPanel, formatGroupLabel } from "../components/DrillDownPanel";
import { KpiCard } from "../components/KpiCard";
import { TreeTable } from "../components/TreeTable";
import {
  baseChartOption,
  chartAxisColor,
  chartSplitLine,
  chartTextColor,
} from "../theme/chartTheme";
import {
  allSettledWithConcurrency,
  REPORT_AGGREGATE_FANOUT_CONCURRENCY,
} from "../utils/asyncConcurrency";
import { datetimeLocalToIso } from "../utils/datetimeLocal";
import {
  buildTree,
  computeYieldPct,
  dateShortcutLast7Days,
  dateShortcutThisMonth,
  dateShortcutToday,
  yieldColor,
  type TreeNode,
} from "../utils/yieldCalc";
import type { ReportListLimits } from "../hooks/usePersistedReportLimits";
import type { EChartsOption } from "echarts";

const TSTYPE_OPTIONS = ["UFLEX", "J750", "PS16", "MST", "FLEX", "93K", "J971"] as const;

type Props = { apiBase: string; listLimits: ReportListLimits };

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

function buildListParams(
  f: FormState,
  limits: ReportListLimits,
): Record<string, string | number | undefined> {
  return {
    ...buildCoreParams(f),
    limit: limits.defaultLimit,
  };
}

const HIDE_CHIPS = new Set(["testEndFrom", "testEndTo"]);
function activeChips(
  f: FormState,
  limits: ReportListLimits,
): { key: string; label: string }[] {
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
  chips.push({
    key: "limit",
    label: `limit = ${limits.defaultLimit}（最多 ${limits.maxLimit}）`,
  });
  return chips;
}

const FREE_DIMS: { label: string; value: string }[] = [
  { label: "Bin",          value: "bin"          },
  { label: "Lot",          value: "lot"          },
  { label: "Device",       value: "device"       },
  { label: "ProbeCardType",value: "probeCardType"},
  { label: "CardId",       value: "cardId"       },
  { label: "Slot",         value: "slot"         },
  { label: "TsType",       value: "tstype"       },
  { label: "PassId",       value: "passId"       },
  { label: "TesterId",     value: "testerId"     },
];

const JB_REPORT_SECTION_ORDER = [
  "kpi",
  "lotYield",
  "chartsGrid",
  "tree",
  "detail",
] as const;

const JB_KPI_BLOCK_ORDER = ["jbWafer", "jbYieldPct", "jbWorstType", "jbTopBin"] as const;

const JB_CHART_BLOCK_ORDER = ["jbBin", "jbPcType", "jbSlot", "jbFreeDim"] as const;

// Sub-dimension options per parent drill
const DRILL_FROM_CARDTYPE: { label: string; value: string }[] = [
  { label: "CardId", value: "cardId" },
  { label: "Slot",   value: "slot"   },
  { label: "Bin",    value: "bin"    },
  { label: "Lot",    value: "lot"    },
];

const DRILL_FROM_CARD: { label: string; value: string }[] = [
  { label: "Slot", value: "slot" },
  { label: "Bin",  value: "bin"  },
  { label: "Lot",  value: "lot"  },
];

const DRILL_FROM_SLOT: { label: string; value: string }[] = [
  { label: "Bin",    value: "bin"    },
  { label: "CardId", value: "cardId" },
  { label: "Lot",    value: "lot"    },
];

const DRILL_FROM_BIN: { label: string; value: string }[] = [
  { label: "CardId", value: "cardId" },
  { label: "Lot",    value: "lot"    },
  { label: "Slot",   value: "slot"   },
];

const DRILL_FROM_LOT: { label: string; value: string }[] = [
  { label: "CardId",       value: "cardId"       },
  { label: "ProbeCardType",value: "probeCardType"},
  { label: "Slot",         value: "slot"         },
  { label: "Bin",          value: "bin"          },
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
): Array<{ lot: string; passId: string; slot: string; label: string; yieldPct: number }> {
  const byKey = new Map<string, InfcontrolLayerBinV3Row[]>();
  for (const r of rows) {
    const lot    = r.LOT    ?? "—";
    const passId = r.PASSID !== undefined && r.PASSID !== null ? String(r.PASSID) : "";
    const slot   = r.SLOT   !== undefined && r.SLOT   !== null ? String(r.SLOT)   : "";
    const key    = `${lot}__P${passId}__S${slot}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(r);
  }
  const result: Array<{ lot: string; passId: string; slot: string; label: string; yieldPct: number }> = [];
  for (const [key, keyRows] of byKey.entries()) {
    const yp = computeYieldPct(keyRows);
    if (yp === null) continue;
    const r0     = keyRows[0];
    const lot    = r0.LOT ?? "—";
    const passId = r0.PASSID !== undefined && r0.PASSID !== null ? String(r0.PASSID) : "";
    const slot   = r0.SLOT   !== undefined && r0.SLOT   !== null ? String(r0.SLOT)   : "";
    let label = lot;
    if (passId) label += ` [P${passId}]`;
    if (slot)   label += ` S${slot}`;
    result.push({ lot, passId, slot, label, yieldPct: yp });
    void key;
  }
  return result.sort((a, b) => a.yieldPct - b.yieldPct);
}

function infcontrolTreeYieldExtra(
  rows: InfcontrolLayerBinV3Row[] | undefined,
  node: TreeNode,
  depth: number,
): ReactNode {
  if (depth > 1) return null;
  const device = node.dimKey === "device" ? node.dimValue : undefined;
  const lot = node.dimKey === "lot" ? node.dimValue : undefined;
  if (!rows?.length) return null;
  const filtered = rows.filter((r) => {
    if (device && r.DEVICE !== device) return false;
    if (lot && r.LOT !== lot) return false;
    return true;
  });
  const byPass = new Map<string, InfcontrolLayerBinV3Row[]>();
  for (const r of filtered) {
    const p = r.PASSID !== undefined && r.PASSID !== null ? String(r.PASSID) : "—";
    if (!byPass.has(p)) byPass.set(p, []);
    byPass.get(p)!.push(r);
  }
  if (byPass.size === 0) return null;
  return (
    <span style={{ fontSize: 11, display: "flex", gap: 6, flexWrap: "wrap" }}>
      {[...byPass.entries()].map(([p, rs]) => {
        const yp = computeYieldPct(rs);
        if (yp === null) return null;
        return (
          <span key={p} style={{ color: yieldColor(yp) }}>
            P{p} {yp.toFixed(1)}%
          </span>
        );
      })}
    </span>
  );
}

export function InfcontrolReport({ apiBase, listLimits }: Props) {
  const [form, setForm] = useState<FormState>(initialForm);
  const [list,        setList]        = useState<InfcontrolLayerBinsV3Response | null>(null);
  const [aggBin,      setAggBin]      = useState<InfcontrolAggregateResponse | null>(null);
  // probeCardType,bin aggregate — chart shows type-level; cardId accessed via drill
  const [aggCardType, setAggCardType] = useState<InfcontrolAggregateResponse | null>(null);
  const [aggSlot,     setAggSlot]     = useState<InfcontrolAggregateResponse | null>(null);
  const [aggTree,     setAggTree]     = useState<InfcontrolAggregateResponse | null>(null);
  const [aggFree,     setAggFree]     = useState<InfcontrolAggregateResponse | null>(null);
  const [freeDim, setFreeDim] = useState("bin");

  const [loadingList, setLoadingList] = useState(false);
  const [loadingAgg,  setLoadingAgg]  = useState(false);
  const [errorList,   setErrorList]   = useState<string | null>(null);
  const [errorAgg,    setErrorAgg]    = useState<string | null>(null);
  const [drill,       setDrill]       = useState<DrillState | null>(null);
  const [showTree,   setShowTree]   = useState(false);
  const [showDetail, setShowDetail] = useState(false);
  const [selectedLotLabel, setSelectedLotLabel] = useState<string | null>(null);
  const [selectedBin,      setSelectedBin]      = useState<string | null>(null);
  const [selectedCardType, setSelectedCardType] = useState<string | null>(null);
  const [selectedSlot,     setSelectedSlot]     = useState<string | null>(null);
  const [layoutEpoch, setLayoutEpoch] = useState(0);

  const resetReportLayout = useCallback(() => {
    resetReportLayoutStorage(JB_START_LAYOUT_STORAGE_KEYS);
    setLayoutEpoch((n) => n + 1);
  }, []);

  const setField = useCallback(
    <K extends keyof FormState>(k: K, v: FormState[K]) => {
      setForm((f) => ({ ...f, [k]: v }));
    },
    []
  );

  const clearFilter = useCallback((key: string) => {
    if (key === "limit") return;
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
          groupTop: 50,
        };
        const res = await apiGetJson<InfcontrolAggregateResponse>(
          apiBase,
          INFCONTROL_AGGREGATE_PATH,
          params
        );
        // probeCardType and bin are not real DB WHERE-clause columns — API ignores them.
        // Filter client-side after fetching.
        let groups = res.groups;

        if (parentDimKey === "probeCardType") {
          // Only filter when the result parts contain cardId (i.e. subDim involves cardId).
          // For slot/bin/lot sub-dims the parts don't have cardId, so we cannot derive
          // the type membership — leave those results unfiltered rather than returning empty.
          if (groups.some((g) => g.parts.cardId !== undefined)) {
            const typeLower = parentDimVal.trim().toLowerCase();
            groups = groups.filter((g) => {
              const cardId = (g.parts.cardId ?? "").trim();
              if (!cardId) return false;
              const dash = cardId.indexOf("-");
              const prefix = (dash > 0 ? cardId.slice(0, dash) : cardId).toLowerCase();
              return prefix === typeLower;
            });
          }
        }

        if (parentDimKey === "bin") {
          // bin is an UNPIVOT virtual column — filter groups to the clicked bin value.
          groups = groups.filter((g) => g.parts.bin === parentDimVal);
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
        const gby = dim === "bin" ? "bin" : `${dim},bin`;
        const res = await apiGetJson<InfcontrolAggregateResponse>(
          apiBase,
          INFCONTROL_AGGREGATE_PATH,
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
    setSelectedLotLabel(null);
    setSelectedBin(null);
    setSelectedCardType(null);
    setSelectedSlot(null);
    setList(null);
    setAggBin(null);
    setAggCardType(null);
    setAggSlot(null);
    setAggTree(null);
    setAggFree(null);

    const core = buildCoreParams(form);

    // Phase 1: 明细列表（受 limit 约束，通常很快）
    try {
      const listRes = await apiGetJson<InfcontrolLayerBinsV3Response>(
        apiBase,
        `${API_PREFIX}/infcontrol-layer-bins/v4`,
        buildListParams(form, listLimits),
      );
      setList(listRes);
    } catch (e) {
      setErrorList(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingList(false);
    }

    // Phase 2: 图表聚合（v3 库内全量匹配行；与 limit 无关，并行 2 路）
    const [binRes, cardTypeRes, slotRes, treeRes] =
      (await allSettledWithConcurrency(
        [
          () =>
            apiGetJson<InfcontrolAggregateResponse>(
              apiBase,
              INFCONTROL_AGGREGATE_PATH,
              { ...core, groupBy: "bin", groupTop: 30 },
            ),
          () =>
            apiGetJson<InfcontrolAggregateResponse>(
              apiBase,
              INFCONTROL_AGGREGATE_PATH,
              { ...core, groupBy: "probeCardType,bin", groupTop: 25 },
            ),
          () =>
            apiGetJson<InfcontrolAggregateResponse>(
              apiBase,
              INFCONTROL_AGGREGATE_PATH,
              { ...core, groupBy: "slot,bin", groupTop: 50 },
            ),
          () =>
            apiGetJson<InfcontrolAggregateResponse>(
              apiBase,
              INFCONTROL_AGGREGATE_PATH,
              {
                ...core,
                groupBy: "device,lot,probeCardType,cardId",
                groupTop: 100,
              },
            ),
        ],
        REPORT_AGGREGATE_FANOUT_CONCURRENCY,
      )) as [
        PromiseSettledResult<InfcontrolAggregateResponse>,
        PromiseSettledResult<InfcontrolAggregateResponse>,
        PromiseSettledResult<InfcontrolAggregateResponse>,
        PromiseSettledResult<InfcontrolAggregateResponse>,
      ];

    setLoadingAgg(false);

    if (binRes.status === "fulfilled") setAggBin(binRes.value);
    if (cardTypeRes.status === "fulfilled") setAggCardType(cardTypeRes.value);
    if (slotRes.status === "fulfilled") setAggSlot(slotRes.value);
    if (treeRes.status === "fulfilled") setAggTree(treeRes.value);
    if (binRes.status === "rejected") {
      const detail =
        binRes.reason instanceof Error
          ? binRes.reason.message
          : String(binRes.reason);
      setErrorAgg(
        `BIN 聚合请求失败，部分图表不可用（limit 仅限制明细；聚合统计全部匹配行。请收窄 testEnd 时间等筛选）：${detail}`,
      );
    }

    void fetchFreeAgg(freeDim, form);
  }, [apiBase, form, freeDim, fetchFreeAgg, listLimits]);

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

  // Worst probeCardType by total bad-die count
  const worstCardType = useMemo(() => {
    if (!aggCardType?.groups?.length) return null;
    const typeBad = new Map<string, number>();
    for (const g of aggCardType.groups) {
      const t = g.parts.probeCardType ?? "";
      if (t) typeBad.set(t, (typeBad.get(t) ?? 0) + g.count);
    }
    if (typeBad.size === 0) return null;
    return [...typeBad.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }, [aggCardType]);

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
    // reverse: lowest yield ends up at top → reads low-to-high from top to bottom
    const data = lotYieldData.slice(0, 10).reverse();
    return {
      ...baseChartOption(),
      xAxis: {
        type: "value",
        max: 100,
        axisLabel: { color: chartAxisColor, formatter: "{value}%" },
        splitLine: { lineStyle: { color: chartSplitLine } },
      },
      yAxis: {
        type: "category",
        data: data.map((d) => d.label),
        axisLabel: { color: chartTextColor, fontSize: 11 },
      },
      series: [
        {
          type: "bar",
          data: data.map((d) => {
            const base   = d.yieldPct >= 95 ? "#238636" : d.yieldPct >= 80 ? "#9e6a03" : "#da3633";
            const bright = d.yieldPct >= 95 ? "#3fb950" : d.yieldPct >= 80 ? "#d29922" : "#f85149";
            const dim    = d.yieldPct >= 95 ? "rgba(35,134,54,0.3)" : d.yieldPct >= 80 ? "rgba(158,106,3,0.3)" : "rgba(218,54,51,0.3)";
            const isSel  = selectedLotLabel === d.label;
            return {
              value: Number(d.yieldPct.toFixed(2)),
              itemStyle: {
                color: isSel ? bright : selectedLotLabel !== null ? dim : base,
                borderRadius: [0, 4, 4, 0] as unknown as number,
              },
            };
          }),
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
  }, [lotYieldData, selectedLotLabel]);

  const binRankOption = useMemo((): EChartsOption => {
    const sorted = [...(aggBin?.groups ?? [])]
      .sort((a, b) => a.count - b.count)
      .slice(-10);
    const COL = "#ff7b72", COL_B = "#ff5050", COL_D = "rgba(255,123,114,0.3)";
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
          data: sorted.map((g) => {
            const key = `Bin ${g.parts.bin ?? g.key}`;
            const isSel = selectedBin !== null && key === `Bin ${selectedBin}`;
            return {
              value: g.count,
              itemStyle: {
                color: isSel ? COL_B : selectedBin !== null ? COL_D : COL,
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
  }, [aggBin, selectedBin]);

  // ProbeCard Type — sum bad-die per type (aggregate over bin dimension)
  const cardTypeOption = useMemo((): EChartsOption => {
    const typeBad = new Map<string, number>();
    for (const g of aggCardType?.groups ?? []) {
      const t = g.parts.probeCardType ?? "—";
      typeBad.set(t, (typeBad.get(t) ?? 0) + g.count);
    }
    const sorted = [...typeBad.entries()].sort((a, b) => a[1] - b[1]).slice(-10);
    const COL = "#e6b450", COL_B = "#ffd070", COL_D = "rgba(230,180,80,0.3)";
    return {
      ...baseChartOption(),
      xAxis: {
        type: "value",
        axisLabel: { color: chartAxisColor },
        splitLine: { lineStyle: { color: chartSplitLine } },
      },
      yAxis: {
        type: "category",
        data: sorted.map(([t]) => t),
        axisLabel: { color: chartTextColor, fontSize: 11 },
      },
      series: [
        {
          type: "bar",
          data: sorted.map(([t, v]) => {
            const isSel = selectedCardType !== null && t === selectedCardType;
            return {
              value: v,
              itemStyle: {
                color: isSel ? COL_B : selectedCardType !== null ? COL_D : COL,
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
  }, [aggCardType, selectedCardType]);

  const slotOption = useMemo((): EChartsOption => {
    const slotBad = new Map<string, number>();
    for (const g of aggSlot?.groups ?? []) {
      const s = g.parts.slot ?? "—";
      slotBad.set(s, (slotBad.get(s) ?? 0) + g.count);
    }
    const sorted = [...slotBad.entries()]
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .slice(0, 10);
    const COL = "#79c0ff", COL_B = "#4da6ff", COL_D = "rgba(121,192,255,0.3)";
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
          data: sorted.map(([s, v]) => {
            const key = `Slot ${s}`;
            const isSel = selectedSlot !== null && key === selectedSlot;
            return {
              value: v,
              itemStyle: {
                color: isSel ? COL_B : selectedSlot !== null ? COL_D : COL,
                borderRadius: [4, 4, 0, 0] as unknown as number,
              },
            };
          }),
          animationDuration: 600,
        },
      ],
    };
  }, [aggSlot, selectedSlot]);

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
        data: sorted.map((g) => formatGroupLabel(g.parts) || g.key),
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

  // ── Tree: Device → LOT → ProbeCard Type → CardId ─────────────────────────

  const treeRoots = useMemo(() => {
    if (!aggTree?.groups?.length) return [];
    return buildTree(aggTree.groups, ["device", "lot", "probeCardType", "cardId"]);
  }, [aggTree]);

  // ── Detail rows ──────────────────────────────────────────────────────────

  const detailRows = useMemo(() => {
    if (!list?.rows?.length) return [];
    return (list.rows as InfcontrolLayerBinV3Row[]).map((r) => {
      const yp = computeYieldPct([r]);
      return {
        TESTEND:       r.TESTEND ?? "",
        DEVICE:        r.DEVICE ?? "",
        LOT:           r.LOT ?? "",
        SLOT:          r.SLOT ?? "",
        PROBECARDTYPE: r.PROBECARDTYPE ?? "—",
        CARDID:        r.CARDID ?? "",
        PASSID:        r.PASSID ?? "",
        "Yield%":      yp !== null ? `${yp.toFixed(1)}%` : "—",
      };
    });
  }, [list]);

  const chips = useMemo(() => activeChips(form, listLimits), [form, listLimits]);
  const hasData = !!(list || aggBin || aggCardType);
  const noTestEndFilter = !form.testEndFrom && !form.testEndTo;

  const jbReportSections = useMemo(() => {
    if (!hasData) return {};

    const kpiSection = (
      <DraggableReportBlocks
        storageKey="pcr-ai-report:jb-start-kpi-blocks"
        defaultOrder={JB_KPI_BLOCK_ORDER}
        layoutEpoch={layoutEpoch}
        axis="x"
        groupClassName="report-reorder-group--kpis"
        labels={{
          jbWafer: "匹配 Wafer 数",
          jbYieldPct: "综合 Yield%",
          jbWorstType: "最差探针卡类型",
          jbTopBin: "Top 不良 Bin",
        }}
        sections={{
          jbWafer: (
            <KpiCard label="匹配 Wafer 数" value={totalWafers} color="blue" showLabel={false} />
          ),
          jbYieldPct: (
            <KpiCard
              label="综合 Yield%"
              value={overallYield !== null ? `${overallYield.toFixed(1)}%` : null}
              color={
                overallYield !== null
                  ? overallYield >= 95 ? "green" : overallYield >= 80 ? "yellow" : "red"
                  : "white"
              }
              subtext="前端计算"
              showLabel={false}
            />
          ),
          jbWorstType: (
            <KpiCard
              label="最差探针卡类型"
              value={worstCardType}
              color="red"
              subtext="坏 die 最多"
              showLabel={false}
            />
          ),
          jbTopBin: (
            <KpiCard
              label="Top 不良 Bin"
              value={topBin}
              color="yellow"
              subtext="全量最高"
              showLabel={false}
            />
          ),
        }}
      />
    );

    const lotYieldSection =
      lotYieldData.length > 0 ? (
        <div
          style={{
            background: "#0d1117",
            border: "1px solid rgba(240,246,252,0.1)",
            borderRadius: 8,
            padding: 16,
          }}
        >
          <div style={{ fontSize: 12, color: "#8b949e", marginBottom: 8 }}>
            <span>绿≥95% · 黄80–95% · 红&lt;80%</span>
            <span style={{ marginLeft: 8, fontSize: 11, color: "#6e7681" }}>
              点击条形钻取
            </span>
          </div>
          <ReactECharts
            option={lotYieldOption}
            style={{
              height: Math.max(160, Math.min(lotYieldData.length, 10) * 26 + 40),
              width: "100%",
            }}
            opts={{ renderer: "canvas" }}
            notMerge
            lazyUpdate
            onEvents={{
              click: (params: { name: string }) => {
                const entry = lotYieldData.find((d) => d.label === params.name);
                if (!entry) return;
                setSelectedLotLabel(params.name);
                fetchDrill("lot", entry.lot, "cardId", form);
              },
            }}
          />
          {drill?.parentDimKey === "lot" && (
            <DrillDownPanel
              title={`LOT: ${drill.parentDimVal} · 下钻：按 ${drill.subDim}`}
              groups={drill.groups}
              loading={drill.loading}
              error={drill.error}
              activeSubDim={drill.subDim}
              subDimOptions={DRILL_FROM_LOT}
              onSubDimChange={(d) =>
                fetchDrill("lot", drill.parentDimVal, d, form)
              }
              onClose={() => {
                setSelectedLotLabel(null);
                setDrill(null);
              }}
            />
          )}
        </div>
      ) : null;

    const chartsGridSection = (
      <DraggableReportBlocks
        storageKey="pcr-ai-report:jb-start-chart-blocks"
        defaultOrder={JB_CHART_BLOCK_ORDER}
        layoutEpoch={layoutEpoch}
        axis="grid"
        groupClassName="report-reorder-group--chartgrid"
        labels={{
          jbBin: "不良 BIN 全量排名",
          jbPcType: "ProbeCard Type 不良对比",
          jbSlot: "Slot 趋势（Wafer 间）",
          jbFreeDim: "自由维度聚合",
        }}
        sections={{
          jbBin: (
            <div
              style={{
                background: "#0d1117",
                border: "1px solid rgba(240,246,252,0.1)",
                borderRadius: 8,
                padding: 16,
              }}
            >
              <div style={{ fontSize: 11, color: "#6e7681", marginBottom: 8 }}>
                点击钻取
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
                      setSelectedBin(bin);
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
                  subDimOptions={DRILL_FROM_BIN}
                  onSubDimChange={(d) =>
                    fetchDrill("bin", drill.parentDimVal, d, form)
                  }
                  onClose={() => {
                    setSelectedBin(null);
                    setDrill(null);
                  }}
                />
              )}
            </div>
          ),
          jbPcType: (
            <div
              style={{
                background: "#0d1117",
                border: "1px solid rgba(240,246,252,0.1)",
                borderRadius: 8,
                padding: 16,
              }}
            >
              <div style={{ fontSize: 11, color: "#6e7681", marginBottom: 8 }}>
                点击类型 → 钻取具体 CardId
              </div>
              {aggCardType && (
                <ReactECharts
                  option={cardTypeOption}
                  style={{
                    height: Math.max(
                      180,
                      new Map(
                        aggCardType.groups?.map((g) => [g.parts.probeCardType, 1]) ?? []
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
                      setSelectedCardType(params.name);
                      fetchDrill("probeCardType", params.name, "cardId", form);
                    },
                  }}
                />
              )}
              {drill?.parentDimKey === "probeCardType" && (
                <DrillDownPanel
                  title={`Type: ${drill.parentDimVal} · 下钻：按 ${drill.subDim}`}
                  groups={drill.groups}
                  loading={drill.loading}
                  error={drill.error}
                  activeSubDim={drill.subDim}
                  subDimOptions={DRILL_FROM_CARDTYPE}
                  onSubDimChange={(d) =>
                    fetchDrill("probeCardType", drill.parentDimVal, d, form)
                  }
                  onClose={() => {
                    setSelectedCardType(null);
                    setDrill(null);
                  }}
                />
              )}
              {drill?.parentDimKey === "cardId" && (
                <DrillDownPanel
                  title={`CardId: ${drill.parentDimVal} · 下钻：按 ${drill.subDim}`}
                  groups={drill.groups}
                  loading={drill.loading}
                  error={drill.error}
                  activeSubDim={drill.subDim}
                  subDimOptions={DRILL_FROM_CARD}
                  onSubDimChange={(d) =>
                    fetchDrill("cardId", drill.parentDimVal, d, form)
                  }
                  onClose={() => setDrill(null)}
                />
              )}
            </div>
          ),
          jbSlot: (
            <div
              style={{
                background: "#0d1117",
                border: "1px solid rgba(240,246,252,0.1)",
                borderRadius: 8,
                padding: 16,
              }}
            >
              <div style={{ fontSize: 11, color: "#6e7681", marginBottom: 8 }}>
                点击 Slot 钻取
              </div>
              {aggSlot && (
                <ReactECharts
                  option={slotOption}
                  style={{ height: 240, width: "100%" }}
                  opts={{ renderer: "canvas" }}
                  notMerge
                  lazyUpdate
                  onEvents={{
                    click: (params: { name: string }) => {
                      const slotNum = params.name.replace(/^Slot /, "");
                      setSelectedSlot(params.name);
                      fetchDrill("slot", slotNum, "bin", form);
                    },
                  }}
                />
              )}
              {drill?.parentDimKey === "slot" && (
                <DrillDownPanel
                  title={`Slot ${drill.parentDimVal} · 下钻：按 ${drill.subDim}`}
                  groups={drill.groups}
                  loading={drill.loading}
                  error={drill.error}
                  activeSubDim={drill.subDim}
                  subDimOptions={DRILL_FROM_SLOT}
                  onSubDimChange={(d) =>
                    fetchDrill("slot", drill.parentDimVal, d, form)
                  }
                  onClose={() => {
                    setSelectedSlot(null);
                    setDrill(null);
                  }}
                />
              )}
            </div>
          ),
          jbFreeDim: (
            <div
              style={{
                background: "#0d1117",
                border: "1px solid rgba(240,246,252,0.1)",
                borderRadius: 8,
                padding: 16,
              }}
            >
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
                  height={Math.max(180, (aggFree.groups?.length ?? 0) * 22 + 60)}
                />
              )}
            </div>
          ),
        }}
      />
    );

    const treeSection =
      treeRoots.length > 0 ? (
        <div
          style={{
            background: "#0d1117",
            border: "1px solid rgba(240,246,252,0.1)",
            borderRadius: 8,
            padding: 16,
          }}
        >
          <div
            style={{
              fontSize: 12,
              color: "#8b949e",
              marginBottom: showTree ? 10 : 0,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 6,
              userSelect: "none",
            }}
            onClick={() => setShowTree((s) => !s)}
          >
            <span style={{ fontSize: 10, opacity: 0.6 }}>{showTree ? "▼" : "▶"}</span>
            Device → LOT → ProbeCard Type → CardId
            <span style={{ fontSize: 11, color: "#6e7681", fontWeight: 400 }}>
              {showTree ? "" : `— ${treeRoots.length} 组，点击展开`}
            </span>
          </div>
          {showTree && (
            <TreeTable
              roots={treeRoots}
              totalHeader="坏 die"
              renderExtra={(node, depth) =>
                infcontrolTreeYieldExtra(list?.rows as InfcontrolLayerBinV3Row[], node, depth)
              }
            />
          )}
        </div>
      ) : null;

    const detailSection =
      detailRows.length > 0 ? (
        <div
          style={{
            background: "#0d1117",
            border: "1px solid rgba(240,246,252,0.1)",
            borderRadius: 8,
            padding: 16,
          }}
        >
          <div
            style={{
              fontSize: 12,
              color: "#8b949e",
              marginBottom: showDetail ? 8 : 0,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 6,
              userSelect: "none",
            }}
            onClick={() => setShowDetail((s) => !s)}
          >
            <span style={{ fontSize: 10, opacity: 0.6 }}>{showDetail ? "▼" : "▶"}</span>
            共 {list?.count ?? 0} 条（含 PROBECARDTYPE / Yield%）
          </div>
          {showDetail && <DataTable rows={detailRows} maxHeight={400} />}
        </div>
      ) : null;

    return {
      kpi: kpiSection,
      lotYield: lotYieldSection,
      chartsGrid: chartsGridSection,
      tree: treeSection,
      detail: detailSection,
    };
  }, [
    hasData,
    totalWafers,
    overallYield,
    worstCardType,
    topBin,
    lotYieldData,
    lotYieldOption,
    drill,
    form,
    fetchDrill,
    aggBin,
    binRankOption,
    aggCardType,
    cardTypeOption,
    aggSlot,
    slotOption,
    aggFree,
    freeOption,
    freeDim,
    handleFreeDimChange,
    treeRoots,
    showTree,
    list,
    detailRows,
    showDetail,
    layoutEpoch,
  ]);

  return (
    <div className="report-panel">
      {/* ── Header ── */}
      <div className="report-panel-header">
        <div>
          <h2>🔬 JB START</h2>
          <p className="report-desc">
            层控 BIN 数据（PASSTYPE = TEST）。复合筛选，一键触发：明细 + BIN 排名 +
            探针卡类型对比 + Slot 趋势。点击图表钻取。Yield% 由前端从 bins[].isGoodBin + GROSSDIE 计算。
          </p>
        </div>
      </div>

      <CollapsibleQueryPanel
        storageKey="pcr-ai-report:jb-start-query-open"
        filters={
        <div className="filter-grid">
          {(
            [
              ["Device", "device"],
              ["Lot", "lot"],
              ["Slot", "slot"],
              ["CardId", "cardId"],
              ["TesterID", "testerId"],
              ["PassID", "passId"],
              ["MES Slot", "meslot"],
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
        }
        footer={
          <>
            {chips.length > 0 && (
              <div className="query-panel-chips">
              <span className="query-panel-chips-label">生效筛选：</span>
              {chips.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  className="query-chip"
                  onClick={() => clearFilter(c.key)}
                >
                  {c.label} ✕
                </button>
              ))}
            </div>
          )}
          <div className="query-panel-actions-buttons">
            <button
              type="button"
              className="btn primary query-panel-submit"
              disabled={loadingList || loadingAgg}
              onClick={query}
            >
              {loadingList || loadingAgg ? "查询中…" : "查询"}
            </button>
            {hasData ? (
              <ReportLayoutResetButton onReset={resetReportLayout} />
            ) : null}
          </div>
          </>
        }
      />

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

      {noTestEndFilter && !loadingList ? (
        <p className="field-hint" style={{ margin: "0 0 8px" }}>
          未设置 testEnd 时间时，API 默认统计近 <strong>1 年</strong>匹配行；图表聚合较慢，与明细 limit 无关。建议先点「近7天」或「本月」再查询。
        </p>
      ) : null}

      {loadingAgg && list ? (
        <p className="field-hint" style={{ margin: "0 0 8px" }}>
          明细已返回（limit={listLimits.defaultLimit}）；图表聚合仍在加载（Oracle 全量匹配行统计）…
        </p>
      ) : null}

      {hasData && (
        <DraggableReportSections
          storageKey="pcr-ai-report:jb-start-modules"
          defaultOrder={JB_REPORT_SECTION_ORDER}
          sections={jbReportSections}
          layoutEpoch={layoutEpoch}
        />
      )}
    </div>
  );
}
