import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiGetJson } from "../api/client";
import { API_PREFIX, YIELD_AGGREGATE_PATH } from "../api/paths";
import type {
  AggregateGroup,
  YieldMonitorV3AggregateResponse,
  YieldMonitorV3Response,
  YieldMonitorV3Row,
} from "../api/types";
import { CollapsibleQueryPanel } from "../components/CollapsibleQueryPanel";
import { ChartDrillSplit } from "../components/ChartDrillSplit";
import { DarkChart } from "../components/DarkChart";
import { DataTable } from "../components/DataTable";
import {
  DraggableReportBlocks,
  DraggableReportSections,
  ReportLayoutResetButton,
  YIELD_MONITOR_LAYOUT_STORAGE_KEYS,
  resetReportLayoutStorage,
} from "../components/DraggableReportSections";
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
  horizontalBarCategoryAxisLabel,
  horizontalBarChartBase,
  rankBarChartHeight,
  YIELD_TREND_CHART_HEIGHT,
  yieldTrendChartGrid,
} from "../theme/chartTheme";
import {
  allSettledWithConcurrency,
  REPORT_ORACLE_FANOUT_CONCURRENCY,
} from "../utils/asyncConcurrency";
import { drillFromTree, storeDrillTab } from "../utils/drillAggregate";
import { datetimeLocalToIso, formatChartDayLabel } from "../utils/datetimeLocal";
import {
  buildTree,
  dateShortcutLast7Days,
  dateShortcutThisMonth,
  dateShortcutToday,
  parseDutNumber,
  tallyDutNumbers,
} from "../utils/yieldCalc";
import { TESTER_PLATFORM_OPTIONS } from "../utils/testerPlatform";
import type { ReportListLimits } from "../hooks/usePersistedReportLimits";
import type { EChartsOption } from "echarts";

type Props = { apiBase: string; listLimits: ReportListLimits };

type FormState = {
  device: string;
  mask: string;
  lotId: string;
  wafer: string;
  hostname: string;
  platform: string;
  probeCardType: string;
  probeCard: string;
  pass: string;
  timestampFrom: string;
  timestampTo: string;
};

const initialForm: FormState = {
  device: "",
  mask: "",
  lotId: "",
  wafer: "",
  hostname: "",
  platform: "",
  probeCardType: "",
  probeCard: "",
  pass: "",
  timestampFrom: "",
  timestampTo: "",
};

function buildCoreParams(f: FormState): Record<string, string | number | undefined> {
  return {
    device: f.device || undefined,
    mask: f.mask || undefined,
    lotId: f.lotId || undefined,
    wafer: f.wafer || undefined,
    hostname: f.hostname || undefined,
    platform: f.platform || undefined,
    probeCardType: f.probeCardType || undefined,
    probeCard: f.probeCard || undefined,
    pass: f.pass ? Number(f.pass) : undefined,
    timeStampFrom: datetimeLocalToIso(f.timestampFrom),
    timeStampTo: datetimeLocalToIso(f.timestampTo),
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

const HIDE_KEYS = new Set(["timeStampFrom", "timeStampTo"]);
function activeChips(
  f: FormState,
  limits: ReportListLimits,
): { key: string; label: string }[] {
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
  chips.push({
    key: "limit",
    label: `limit = ${limits.defaultLimit}（最多 ${limits.maxLimit}）`,
  });
  return chips;
}

const YIELD_REPORT_SECTION_ORDER = [
  "kpi",
  "timeTrend",
  "chartsGrid",
  "tree",
  "detail",
] as const;

const YIELD_KPI_BLOCK_ORDER = [
  "kpiTrig",
  "kpiLots",
  "kpiWorstPct",
  "kpiSelPc",
] as const;

const YIELD_CHART_BLOCK_ORDER = ["chPcType", "chDevice", "chLot"] as const;

// Sub-dimension options for drill-down panels
const DRILL_FROM_DEVICE: { label: string; value: string }[] = [
  { label: "LOT",    value: "lotId"   },
  { label: "Pass",   value: "pass"    },
  { label: "Wafer",  value: "wafer"   },
  { label: "按日",   value: "timeDay" },
];

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

// Dimensions in aggTree (device→lotId→probeCardType→probeCard).
const YIELD_TREE_DRILL_DIMS = new Set([
  "device",
  "lotId",
  "probeCardType",
  "probeCard",
]);

const YIELD_DRILL_KEY_SEP = "\x00";

function rowMatchesYieldDrillParent(
  row: YieldMonitorV3Row,
  parentDimKey: string,
  parentDimVal: string
): boolean {
  const val = parentDimVal.trim();
  switch (parentDimKey) {
    case "device":
      return String(row.DEVICE ?? "").trim() === val;
    case "lotId":
      return String(row.LOTID ?? "").trim() === val;
    case "probeCard":
      return String(row.PROBECARD ?? "").trim() === val;
    case "probeCardType": {
      const typeLower = val.toLowerCase();
      const pct = row.PROBECARDTYPE;
      if (pct !== undefined && pct !== null && String(pct).trim()) {
        return String(pct).trim().toLowerCase() === typeLower;
      }
      const card = String(row.PROBECARD ?? "").trim();
      if (!card) return false;
      const dash = card.indexOf("-");
      const prefix = (dash > 0 ? card.slice(0, dash) : card).toLowerCase();
      return prefix === typeLower;
    }
    default:
      return true;
  }
}

function yieldRowDimValue(row: YieldMonitorV3Row, dim: string): string | undefined {
  switch (dim) {
    case "device":
      return String(row.DEVICE ?? "").trim() || undefined;
    case "lotId":
      return String(row.LOTID ?? "").trim() || undefined;
    case "wafer":
      return String(row.WAFER ?? "").trim() || undefined;
    case "hostname":
      return String(row.HOSTNAME ?? "").trim() || undefined;
    case "pass":
      return row.PASS !== undefined && row.PASS !== null
        ? String(row.PASS)
        : undefined;
    case "probeCard":
      return String(row.PROBECARD ?? "").trim() || undefined;
    case "probeCardType": {
      const pct = row.PROBECARDTYPE;
      if (pct !== undefined && pct !== null && String(pct).trim()) {
        return String(pct).trim();
      }
      const card = String(row.PROBECARD ?? "").trim();
      if (!card) return undefined;
      const dash = card.indexOf("-");
      return dash > 0 ? card.slice(0, dash) : card;
    }
    case "timeDay": {
      if (!row.TIME_STAMP) return undefined;
      const t = new Date(row.TIME_STAMP).getTime();
      if (Number.isNaN(t)) return undefined;
      const d0 = new Date(t);
      d0.setUTCHours(0, 0, 0, 0);
      return d0.toISOString().replace("T", " ").slice(0, 19);
    }
    default:
      return undefined;
  }
}

/** Roll up loaded list rows for drill tabs (pass/wafer/timeDay etc.). */
function drillFromYieldListRows(
  rows: YieldMonitorV3Row[],
  parentDimKey: string,
  parentDimVal: string,
  subDim: string,
  top = 50
): AggregateGroup[] {
  const subDimKeys = subDim
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const sums = new Map<string, number>();
  const partsMap = new Map<string, Record<string, string>>();

  for (const row of rows) {
    if (!rowMatchesYieldDrillParent(row, parentDimKey, parentDimVal)) continue;
    const parts: Record<string, string> = {};
    let valid = true;
    for (const k of subDimKeys) {
      const dv = yieldRowDimValue(row, k);
      if (dv === undefined) {
        valid = false;
        break;
      }
      parts[k] = dv;
    }
    if (!valid) continue;
    const key = subDimKeys.map((k) => parts[k]).join(YIELD_DRILL_KEY_SEP);
    sums.set(key, (sums.get(key) ?? 0) + 1);
    if (!partsMap.has(key)) partsMap.set(key, parts);
  }

  return [...sums.entries()]
    .map(([key, count]) => ({ key, count, parts: partsMap.get(key)! }))
    .sort((a, b) => b.count - a.count)
    .slice(0, top);
}

function filterYieldDrillGroupsForProbeCardType(
  groups: AggregateGroup[],
  filterDim: string,
  filterVal: string,
  subDim: string
): AggregateGroup[] {
  if (filterDim !== "probeCardType" || subDim !== "probeCard") return groups;
  const typeLower = filterVal.trim().toLowerCase();
  return groups.filter((g) => {
    const card = (g.parts.probeCard ?? g.key).trim();
    const dash = card.indexOf("-");
    const prefix = (dash > 0 ? card.slice(0, dash) : card).toLowerCase();
    return prefix === typeLower;
  });
}

export function YieldMonitorReport({ apiBase, listLimits }: Props) {
  const [form, setForm] = useState<FormState>(initialForm);
  const [list, setList] = useState<YieldMonitorV3Response | null>(null);
  const [aggTime, setAggTime] = useState<YieldMonitorV3AggregateResponse | null>(null);
  // probeCardType-level aggregate (chart); probeCard detail accessed via drill
  const [aggCardType, setAggCardType] = useState<YieldMonitorV3AggregateResponse | null>(null);
  const [aggLot, setAggLot] = useState<YieldMonitorV3AggregateResponse | null>(null);
  const [aggDevice, setAggDevice] = useState<YieldMonitorV3AggregateResponse | null>(null);
  const [aggTree, setAggTree] = useState<YieldMonitorV3AggregateResponse | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingAgg, setLoadingAgg] = useState(false);
  const [errorList, setErrorList] = useState<string | null>(null);
  const [errorAgg, setErrorAgg] = useState<string | null>(null);

  const [drills, setDrills] = useState<Record<string, DrillState>>({});
  const drillCacheRef = useRef<
    Record<string, { val: string; tabs: Record<string, AggregateGroup[]> }>
  >({});
  const [showTree,   setShowTree]   = useState(false);
  const [showDetail, setShowDetail] = useState(false);
  // The probeCard the user selected by clicking a bar inside the drill panel
  const [selectedProbeCard, setSelectedProbeCard] = useState<string | null>(null);
  // Dedicated list rows for DUT distribution — fetched with probeCard filter
  // so we're not limited by the main list's row cap
  const [dutList, setDutList] = useState<YieldMonitorV3Response | null>(null);
  const [loadingDut, setLoadingDut] = useState(false);
  const [selectedCardTypeName, setSelectedCardTypeName] = useState<string | null>(null);
  const [selectedLotId,       setSelectedLotId]       = useState<string | null>(null);
  const [selectedDevice,      setSelectedDevice]      = useState<string | null>(null);
  const [layoutEpoch, setLayoutEpoch] = useState(0);

  const resetReportLayout = useCallback(() => {
    resetReportLayoutStorage(YIELD_MONITOR_LAYOUT_STORAGE_KEYS);
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
    if (key === "__time__") {
      setForm((f) => ({ ...f, timestampFrom: "", timestampTo: "" }));
    } else {
      setForm((f) => ({ ...f, [key]: "" } as FormState));
    }
  }, []);

  const clearAll = useCallback(() => {
    setForm(initialForm);
    setList(null);
    setAggTime(null);
    setAggCardType(null);
    setAggLot(null);
    setAggDevice(null);
    setAggTree(null);
    setDrills({});
    drillCacheRef.current = {};
    setSelectedProbeCard(null);
    setSelectedCardTypeName(null);
    setSelectedLotId(null);
    setSelectedDevice(null);
    setDutList(null);
    setLoadingDut(false);
    setErrorList(null);
    setErrorAgg(null);
    setLoadingList(false);
    setLoadingAgg(false);
  }, []);

  const applyDateShortcut = useCallback((fn: () => [string, string]) => {
    const [from, to] = fn();
    setForm((f) => ({ ...f, timestampFrom: from, timestampTo: to }));
  }, []);

  const fetchDrill = useCallback(
    async (
      drillStateKey: string,
      filterDim: string,
      filterVal: string,
      subDim: string,
      currentForm: FormState
    ) => {
      const subDimKeys = subDim
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const listRows = (list?.rows ?? []) as YieldMonitorV3Row[];

      const cached = drillCacheRef.current[drillStateKey];
      if (cached?.val === filterVal && subDim in cached.tabs) {
        setDrills((prev) => ({
          ...prev,
          [drillStateKey]: {
            parentDimKey: filterDim,
            parentDimVal: filterVal,
            subDim,
            groups: cached.tabs[subDim],
            loading: false,
            error: null,
          },
        }));
        return;
      }

      if (
        aggTree?.groups != null &&
        YIELD_TREE_DRILL_DIMS.has(filterDim) &&
        subDimKeys.every((k) => YIELD_TREE_DRILL_DIMS.has(k))
      ) {
        let groups = drillFromTree(
          aggTree.groups,
          filterDim,
          filterVal,
          subDimKeys
        );
        groups = filterYieldDrillGroupsForProbeCardType(
          groups,
          filterDim,
          filterVal,
          subDim
        );
        if (groups.length > 0) {
          storeDrillTab(
            drillStateKey,
            filterVal,
            subDim,
            groups,
            drillCacheRef,
            setDrills
          );
          return;
        }
      }

      if (listRows.length > 0) {
        const fromList = drillFromYieldListRows(
          listRows,
          filterDim,
          filterVal,
          subDim
        );
        if (fromList.length > 0) {
          storeDrillTab(
            drillStateKey,
            filterVal,
            subDim,
            fromList,
            drillCacheRef,
            setDrills
          );
          return;
        }
      }

      setDrills((prev) => ({
        ...prev,
        [drillStateKey]: {
          parentDimKey: filterDim,
          parentDimVal: filterVal,
          subDim,
          groups: [],
          loading: true,
          error: null,
        },
      }));
      try {
        const params = {
          ...buildCoreParams(currentForm),
          [filterDim]: filterVal,
          dimensions: subDim,
          groupTop: 50,
        };
        const res = await apiGetJson<YieldMonitorV3AggregateResponse>(
          apiBase,
          YIELD_AGGREGATE_PATH,
          params
        );
        let groups = filterYieldDrillGroupsForProbeCardType(
          res.groups,
          filterDim,
          filterVal,
          subDim
        );
        if (groups.length === 0 && listRows.length > 0) {
          groups = drillFromYieldListRows(
            listRows,
            filterDim,
            filterVal,
            subDim
          );
        }
        setDrills((prev) => {
          const d = prev[drillStateKey];
          if (!d || d.parentDimVal !== filterVal) return prev;
          if (
            !drillCacheRef.current[drillStateKey] ||
            drillCacheRef.current[drillStateKey].val !== filterVal
          ) {
            drillCacheRef.current[drillStateKey] = { val: filterVal, tabs: {} };
          }
          drillCacheRef.current[drillStateKey].tabs[subDim] = groups;
          return { ...prev, [drillStateKey]: { ...d, groups, loading: false } };
        });
      } catch (e) {
        setDrills((prev) => {
          const d = prev[drillStateKey];
          if (!d || d.parentDimVal !== filterVal) return prev;
          return {
            ...prev,
            [drillStateKey]: {
              ...d,
              loading: false,
              error: e instanceof Error ? e.message : String(e),
            },
          };
        });
      }
    },
    [apiBase, aggTree, list?.rows]
  );

  const query = useCallback(async () => {
    setLoadingList(true);
    setLoadingAgg(true);
    setErrorList(null);
    setErrorAgg(null);
    setDrills({});
    drillCacheRef.current = {};
    setSelectedProbeCard(null);
    setSelectedCardTypeName(null);
    setSelectedLotId(null);
    setSelectedDevice(null);
    setAggDevice(null);
    const core = buildCoreParams(form);

    const settled = await allSettledWithConcurrency(
      [
        () =>
          apiGetJson<YieldMonitorV3Response>(
            apiBase,
            `${API_PREFIX}/yield-monitor-triggers/v4`,
            buildListParams(form, listLimits)
          ),
        () =>
          apiGetJson<YieldMonitorV3AggregateResponse>(
            apiBase,
            YIELD_AGGREGATE_PATH,
            { ...core, dimensions: "timeDay", groupTop: 60 }
          ),
        () =>
          apiGetJson<YieldMonitorV3AggregateResponse>(
            apiBase,
            YIELD_AGGREGATE_PATH,
            { ...core, dimensions: "probeCardType", groupTop: 25 }
          ),
        () =>
          apiGetJson<YieldMonitorV3AggregateResponse>(
            apiBase,
            YIELD_AGGREGATE_PATH,
            { ...core, dimensions: "lotId", groupTop: 25 }
          ),
        () =>
          apiGetJson<YieldMonitorV3AggregateResponse>(
            apiBase,
            YIELD_AGGREGATE_PATH,
            { ...core, dimensions: "device,lotId,probeCardType,probeCard", groupTop: 100 }
          ),
        () =>
          apiGetJson<YieldMonitorV3AggregateResponse>(
            apiBase,
            YIELD_AGGREGATE_PATH,
            { ...core, dimensions: "device", groupTop: 30 }
          ),
      ],
      REPORT_ORACLE_FANOUT_CONCURRENCY
    );
    const [listRes, timeRes, cardTypeRes, lotRes, treeRes, deviceRes] = settled as [
      PromiseSettledResult<YieldMonitorV3Response>,
      PromiseSettledResult<YieldMonitorV3AggregateResponse>,
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
    if (deviceRes.status === "fulfilled") setAggDevice(deviceRes.value);
    if (timeRes.status === "rejected" || cardTypeRes.status === "rejected") {
      setErrorAgg("部分聚合请求失败，图表可能不完整");
    }

  }, [apiBase, form, listLimits]);

  /** 当前应加载 DUT 分布的探针卡 */
  const dutProbeCardTarget = useMemo(() => {
    if (selectedProbeCard && drills.probeCardType?.subDim === "probeCard") {
      return selectedProbeCard;
    }
    return null;
  }, [selectedProbeCard, drills.probeCardType]);

  useEffect(() => {
    if (!dutProbeCardTarget) {
      setDutList(null);
      return;
    }
    const card = dutProbeCardTarget.trim();
    const fromMain = (list?.rows ?? []).filter(
      (r) => String(r.PROBECARD ?? "").trim() === card
    );
    if (fromMain.length > 0 && list) {
      setDutList({
        ...list,
        rows: fromMain,
        count: fromMain.length,
      });
      setLoadingDut(false);
      return;
    }
    let cancelled = false;
    setLoadingDut(true);
    setDutList(null);
    apiGetJson<YieldMonitorV3Response>(
      apiBase,
      `${API_PREFIX}/yield-monitor-triggers/v4`,
      { ...buildListParams(form, listLimits), probeCard: dutProbeCardTarget }
    )
      .then((res) => {
        if (!cancelled) setDutList(res);
      })
      .catch(() => {
        if (!cancelled) setDutList(null);
      })
      .finally(() => {
        if (!cancelled) setLoadingDut(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dutProbeCardTarget, apiBase, form, listLimits, list]);

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
    const dates = groups.map((g) =>
      formatChartDayLabel(String(g.parts.timeDay ?? g.key)),
    );
    const counts = groups.map((g) => g.count);
    return {
      ...baseChartOption(),
      grid: yieldTrendChartGrid,
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
      ...horizontalBarChartBase(),
      xAxis: {
        type: "value",
        axisLabel: { color: chartAxisColor },
        splitLine: { lineStyle: { color: chartSplitLine } },
      },
      yAxis: {
        type: "category",
        data: sorted.map((g) => g.parts.probeCardType ?? g.key),
        axisLabel: horizontalBarCategoryAxisLabel,
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

  // DUT distribution — rows from dutList (probeCard filter); keyed by dutProbeCardTarget
  const dutRows = useMemo(() => {
    if (!dutProbeCardTarget) return null;
    if (loadingDut) return null;
    if (!dutList?.rows?.length) return [];
    return dutList.rows as YieldMonitorV3Row[];
  }, [dutProbeCardTarget, dutList, loadingDut]);

  const dutTally = useMemo(() => {
    if (!dutRows?.length) return [];
    return tallyDutNumbers(
      dutRows.map((r) => ({
        dutNumber: r.dutNumber ?? parseDutNumber(r.TRIGGER_LABEL),
      }))
    ).slice(0, 10);
  }, [dutRows]);

  const dutOption = useMemo((): EChartsOption => {
    const sorted = [...dutTally].sort((a, b) => a.count - b.count);
    return {
      ...horizontalBarChartBase(),
      xAxis: {
        type: "value",
        axisLabel: { color: chartAxisColor },
        splitLine: { lineStyle: { color: chartSplitLine } },
      },
      yAxis: {
        type: "category",
        data: sorted.map((e) => `dut#${e.dut}`),
        axisLabel: horizontalBarCategoryAxisLabel,
      },
      series: [
        {
          type: "bar",
          cursor: "default",
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
  }, [dutTally]);

  const dutDistributionFooter = useCallback(
    (
      cardId: string,
      chartVariant: "default" | "compact" = "default",
      onClose?: () => void
    ) => (
      <>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 8,
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontSize: 12, color: "#58a6ff", fontWeight: 600 }}>
            {onClose ? `↳ DUT# 分布 · ${cardId}` : `DUT# 分布 · ${cardId}`}
          </span>
          {onClose ? (
            <button
              type="button"
              className="chip"
              style={{ color: "#ff7b72", borderColor: "rgba(248,81,73,0.3)" }}
              onClick={onClose}
            >
              ✕ 关闭
            </button>
          ) : null}
        </div>
        {loadingDut ? (
          <div style={{ color: "#8b949e", fontSize: 12, padding: "8px 0" }}>
            加载中…
          </div>
        ) : dutRows === null ? null : dutRows.length === 0 ? (
          <div style={{ color: "#8b949e", fontSize: 12, padding: "4px 0" }}>
            该探针卡暂无触发记录
          </div>
        ) : dutTally.length === 0 ? (
          <div style={{ color: "#8b949e", fontSize: 12, padding: "4px 0" }}>
            有触发记录，但 TRIGGER_LABEL 中未解析到 dut#
          </div>
        ) : (
          <div className="chart-no-drill">
            <DarkChart
              option={dutOption}
              height={rankBarChartHeight(dutTally.length, 10, chartVariant)}
            />
          </div>
        )}
      </>
    ),
    [loadingDut, dutRows, dutTally, dutOption]
  );

  const probeCardDutFooter = useMemo(() => {
    if (!selectedProbeCard) return null;
    if (drills.probeCardType?.subDim !== "probeCard") return null;
    return dutDistributionFooter(selectedProbeCard);
  }, [selectedProbeCard, drills.probeCardType, dutDistributionFooter]);

  const lotOption = useMemo((): EChartsOption => {
    const sorted = [...(aggLot?.groups ?? [])]
      .sort((a, b) => a.count - b.count)
      .slice(-10);
    const COL = "#f0883e", COL_B = "#ff9f60", COL_D = "rgba(240,136,62,0.3)";
    return {
      ...horizontalBarChartBase(),
      xAxis: {
        type: "value",
        axisLabel: { color: chartAxisColor },
        splitLine: { lineStyle: { color: chartSplitLine } },
      },
      yAxis: {
        type: "category",
        data: sorted.map((g) => g.parts.lotId ?? g.key),
        axisLabel: horizontalBarCategoryAxisLabel,
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

  const deviceOption = useMemo((): EChartsOption => {
    const sorted = [...(aggDevice?.groups ?? [])]
      .sort((a, b) => a.count - b.count)
      .slice(-20);
    const COL = "#79c0ff", COL_B = "#58a6ff", COL_D = "rgba(88,166,255,0.2)";
    return {
      ...horizontalBarChartBase(),
      xAxis: {
        type: "value",
        axisLabel: { color: chartAxisColor },
        splitLine: { lineStyle: { color: chartSplitLine } },
      },
      yAxis: {
        type: "category",
        data: sorted.map((g) => g.parts.device ?? g.key),
        axisLabel: horizontalBarCategoryAxisLabel,
      },
      series: [
        {
          type: "bar",
          data: sorted.map((g) => {
            const name = g.parts.device ?? g.key;
            const isSel = selectedDevice !== null && name === selectedDevice;
            return {
              value: g.count,
              itemStyle: {
                color: isSel ? COL_B : selectedDevice !== null ? COL_D : COL,
                borderRadius: [0, 4, 4, 0] as unknown as number,
              },
            };
          }),
          label: { show: true, position: "right", color: chartAxisColor, fontSize: 10 },
          animationDuration: 600,
        },
      ],
    };
  }, [aggDevice, selectedDevice]);

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
      MASK: r.MASK ?? "—",
      LOTID: r.LOTID ?? "",
      WAFER: r.WAFER ?? "",
      PROBECARDTYPE: r.PROBECARDTYPE ?? "—",
      PROBECARD: r.PROBECARD ?? "",
      dutNumber: r.dutNumber ?? "—",
    }));
  }, [list]);

  const chips = useMemo(() => activeChips(form, listLimits), [form, listLimits]);
  const hasData = !!(list || aggTime || aggCardType);

  const yieldReportSections = useMemo(() => {
    if (!hasData) return {};

    const kpiSection = (
      <DraggableReportBlocks
        storageKey="pcr-ai-report:yield-monitor-kpi-blocks"
        defaultOrder={YIELD_KPI_BLOCK_ORDER}
        layoutEpoch={layoutEpoch}
        axis="x"
        groupClassName="report-reorder-group--kpis"
        labels={{
          kpiTrig: "触发总数",
          kpiLots: "涉及 Lot 数",
          kpiWorstPct: "触发最多探针卡类型",
          kpiSelPc: "已选探针卡",
        }}
        sections={{
          kpiTrig: (
            <KpiCard label="触发总数" value={totalTriggers} color="blue" subtext="触发总数" showLabel={false} />
          ),
          kpiLots: (
            <KpiCard label="涉及 Lot 数" value={uniqueLots} color="white" subtext="涉及 LOT 数" showLabel={false} />
          ),
          kpiWorstPct: (
            <KpiCard
              label="触发最多探针卡类型"
              value={worstCardType}
              color="red"
              subtext="触发次数最多"
              showLabel={false}
            />
          ),
          kpiSelPc: (
            <KpiCard
              label="已选探针卡"
              value={selectedProbeCard ?? "—"}
              color={selectedProbeCard ? "blue" : "white"}
              subtext={selectedProbeCard ? "点击下方图表切换" : "点击钻取面板中的卡选择"}
              showLabel={false}
            />
          ),
        }}
      />
    );

    const timeTrendSection =
      aggTime ? (
        <div className="yield-trend-block chart-no-drill">
          <DarkChart option={timeTrendOption} height={YIELD_TREND_CHART_HEIGHT} />
        </div>
      ) : null;

    const chartsGridSection = (
      <DraggableReportBlocks
        storageKey="pcr-ai-report:yield-monitor-chart-blocks"
        defaultOrder={YIELD_CHART_BLOCK_ORDER}
        layoutEpoch={layoutEpoch}
        axis="grid"
        fullRowIds={["chPcType", "chDevice", "chLot"]}
        groupClassName="report-reorder-group--chartgrid"
        labels={{
          chPcType: "ProbeCard Type 触发排名",
          chDevice: "Device 触发排名",
          chLot: "LOT 触发排名",
        }}
        sections={{
          chDevice: (
            <div className="report-chart-panel">
              <ChartDrillSplit
                hint="点击 Device → 钻取 LOT / Pass / Wafer 分布"
                chart={
                  aggDevice ? (
                    <DarkChart
                      option={deviceOption}
                      height={rankBarChartHeight(aggDevice.groups?.length ?? 0)}
                      onEvents={{
                        click: (params: unknown) => {
                          const { name } = params as { name: string };
                          setSelectedDevice(name);
                          fetchDrill("device", "device", name, "lotId", form);
                        },
                      }}
                    />
                  ) : null
                }
                drill={
                  drills["device"] != null ? (
                    <DrillDownPanel
                      layout="side"
                      title={`Device: ${drills["device"]!.parentDimVal} · 下钻：按 ${drills["device"]!.subDim}`}
                      groups={drills["device"]!.groups}
                      loading={drills["device"]!.loading}
                      error={drills["device"]!.error}
                      activeSubDim={drills["device"]!.subDim}
                      subDimOptions={DRILL_FROM_DEVICE}
                      onSubDimChange={(d) =>
                        fetchDrill("device", drills.device!.parentDimKey, drills.device!.parentDimVal, d, form)
                      }
                      onClose={() => {
                        setSelectedDevice(null);
                        setDrills((prev) => { const n = { ...prev }; delete n["device"]; return n; });
                      }}
                    />
                  ) : null
                }
              />
            </div>
          ),
          chPcType: (
            <div className="report-chart-panel">
              <ChartDrillSplit
                hint="点击类型 → 钻取 ProbeCard → 点选具体卡，DUT# 分布显示在右侧面板底部"
                chart={
                  aggCardType ? (
                    <DarkChart
                      option={cardTypeOption}
                      height={rankBarChartHeight(aggCardType.groups?.length ?? 0, 10)}
                      onEvents={{
                        click: (params: unknown) => {
                          const { name } = params as { name: string };
                          setSelectedCardTypeName(name);
                          setSelectedProbeCard(null);
                          fetchDrill("probeCardType", "probeCardType", name, "probeCard", form);
                        },
                      }}
                    />
                  ) : null
                }
                drill={
                  drills["probeCardType"] != null ? (
                    <DrillDownPanel
                      layout="side"
                      title={`${drills["probeCardType"]!.parentDimVal} · 下钻：按 ${drills["probeCardType"]!.subDim}`}
                      groups={drills["probeCardType"]!.groups}
                      loading={drills["probeCardType"]!.loading}
                      error={drills["probeCardType"]!.error}
                      activeSubDim={drills["probeCardType"]!.subDim}
                      subDimOptions={DRILL_FROM_CARDTYPE}
                      onSubDimChange={(d) => {
                        if (d !== "probeCard") setSelectedProbeCard(null);
                        fetchDrill(
                          "probeCardType",
                          drills.probeCardType!.parentDimKey,
                          drills.probeCardType!.parentDimVal,
                          d,
                          form
                        );
                      }}
                      onClose={() => {
                        setSelectedCardTypeName(null);
                        setSelectedProbeCard(null);
                        setDrills((prev) => { const n = { ...prev }; delete n["probeCardType"]; return n; });
                      }}
                      interactive={drills["probeCardType"]!.subDim === "probeCard"}
                      onBarClick={
                        drills["probeCardType"]!.subDim === "probeCard"
                          ? (key) => setSelectedProbeCard(key)
                          : undefined
                      }
                      selectedKey={
                        drills.probeCardType?.subDim === "probeCard"
                          ? selectedProbeCard
                          : null
                      }
                      footer={probeCardDutFooter}
                    />
                  ) : null
                }
              />
            </div>
          ),
          chLot: (
            <div className="report-chart-panel">
              <ChartDrillSplit
                chart={
                  aggLot ? (
                    <DarkChart
                      option={lotOption}
                      height={rankBarChartHeight(aggLot.groups?.length ?? 0, 10)}
                      onEvents={{
                        click: (params: unknown) => {
                          const { name } = params as { name: string };
                          setSelectedLotId(name);
                          fetchDrill("lotId", "lotId", name, "probeCardType", form);
                        },
                      }}
                    />
                  ) : null
                }
                drill={
                  drills["lotId"] != null ? (
                    <DrillDownPanel
                      layout="side"
                      title={`${drills["lotId"]!.parentDimVal} · 下钻：按 ${drills["lotId"]!.subDim}`}
                      groups={drills["lotId"]!.groups}
                      loading={drills["lotId"]!.loading}
                      error={drills["lotId"]!.error}
                      activeSubDim={drills["lotId"]!.subDim}
                      subDimOptions={DRILL_FROM_LOT}
                      onSubDimChange={(d) =>
                        fetchDrill("lotId", drills.lotId!.parentDimKey, drills.lotId!.parentDimVal, d, form)
                      }
                      onClose={() => {
                        setSelectedLotId(null);
                        setDrills((prev) => { const n = { ...prev }; delete n["lotId"]; return n; });
                      }}
                    />
                  ) : null
                }
              />
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
            Device → LOT → ProbeCard Type → ProbeCard ID
            <span style={{ fontSize: 11, color: "#6e7681", fontWeight: 400 }}>
              {showTree ? "" : `— ${treeRoots.length} 组，点击展开`}
            </span>
          </div>
          {showTree && <TreeTable roots={treeRoots} totalHeader="触发次数" />}
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
            共 {list?.count ?? 0} 条（含 PROBECARDTYPE / dutNumber）
          </div>
          {showDetail && <DataTable rows={detailRows} maxHeight={400} />}
        </div>
      ) : null;

    return {
      kpi: kpiSection,
      timeTrend: timeTrendSection,
      chartsGrid: chartsGridSection,
      tree: treeSection,
      detail: detailSection,
    };
  }, [
    hasData,
    totalTriggers,
    uniqueLots,
    worstCardType,
    selectedProbeCard,
    aggTime,
    timeTrendOption,
    aggCardType,
    cardTypeOption,
    drills,
    aggDevice,
    deviceOption,
    selectedDevice,
    form,
    fetchDrill,
    probeCardDutFooter,
    loadingDut,
    dutRows,
    aggLot,
    lotOption,
    treeRoots,
    showTree,
    detailRows,
    list,
    showDetail,
    layoutEpoch,
  ]);

  return (
    <div className="report-panel">
      {/* ── Header ── */}
      <div className="report-panel-header">
        <div>
          <h2>⚡ Yield Monitor</h2>
          <p className="report-desc">
            Trigger analysis (<code>TYPE = delta_diff</code>). Set filters and click <strong>Query</strong> to
            fetch detail rows + time trend + probe card type / LOT aggregates in parallel.
            Click probe card type <span className="desc-arrow">→</span> drill to card ID <span className="desc-arrow">→</span> select <span className="desc-arrow">→</span> view DUT distribution.
          </p>
        </div>
      </div>

      <CollapsibleQueryPanel
        storageKey="pcr-ai-report:yield-monitor-query-open"
        filters={
        <div className="filter-grid">
          {(
            [
              ["Device", "device"],
              ["Mask (后4位)", "mask"],
              ["LotID", "lotId"],
              ["Wafer", "wafer"],
              ["Hostname", "hostname"],
              ["ProbeCard Type", "probeCardType"],
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

          <label>
            <span>Platform（机台大类 / HOSTNAME）</span>
            <select
              value={form.platform}
              onChange={(e) => setField("platform", e.target.value)}
            >
              <option value="">全部</option>
              {TESTER_PLATFORM_OPTIONS.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </label>

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
            <button
              type="button"
              className="btn ghost query-panel-clear"
              disabled={loadingList || loadingAgg}
              onClick={clearAll}
            >
              清空
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

      {hasData && (
        <DraggableReportSections
            storageKey="pcr-ai-report:yield-monitor-modules"
            defaultOrder={YIELD_REPORT_SECTION_ORDER}
            sections={yieldReportSections}
            layoutEpoch={layoutEpoch}
          />
      )}
    </div>
  );
}
