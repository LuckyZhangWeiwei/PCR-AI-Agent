import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiGetJson } from "../api/client";
import { API_PREFIX, YIELD_AGGREGATE_PATH, YIELD_COMBINED_PATH, YIELD_PERIOD_ALARM_TREND_PATH } from "../api/paths";
import type {
  AggregateGroup,
  PeriodAlarmTopDevice,
  PeriodAlarmTopProbeCard,
  PeriodAlarmTopTester,
  YieldMonitorAggregateBlock,
  YieldMonitorCombinedResponse,
  YieldMonitorPeriodAlarmTrendResponse,
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
import { KpiCard, type KpiColor } from "../components/KpiCard";
import { TreeTable } from "../components/TreeTable";
import {
  baseChartOption,
  getChartPalette,
  selectionTierColors,
  horizontalBarCategoryAxisLabel,
  horizontalBarChartBase,
  rankBarChartHeight,
  YIELD_TREND_CHART_HEIGHT,
  yieldTrendChartGrid,
} from "../theme/chartTheme";
import { useThemeContext } from "../theme/ThemeContext";
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
  formatBinLabel,
  parseDutNumber,
  periodBucketsInRange,
  periodWindow,
  resolvePeriodAlarmTimeRangeFromIso,
  tallyDutNumbers,
  type PeriodBucket,
  type PeriodKey,
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

/** 周期报警趋势查询参数：device/lot/… + TIME_STAMP（与 v3 列表键名一致）。 */
function buildPeriodAlarmQueryParams(
  f: FormState
): Record<string, string | number | undefined> {
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
  "periodAlarm",
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

const YIELD_ALARM_KPI_BLOCK_ORDER = ["kpiAlarmTotal", "kpiAlarmRatio"] as const;

const YIELD_ALARM_CHART_BLOCK_ORDER = [
  "chAlarmTester",
  "chAlarmCard",
  "chAlarmBin",
  "chAlarmDut",
] as const;

/** 旧版「单周期 Top10 + 环比」KPI/图表保留代码但不再展示，见 periodAlarmSection 内的用法。 */
const SHOW_LEGACY_PERIOD_CHARTS = false;

const YIELD_ALARM_TREND_CHART_BLOCK_ORDER = [
  "chAlarmTotalTrend",
  "chAlarmTesterTrend",
  "chAlarmCardTrend",
  "chAlarmDailyTrend",
] as const;

const PERIOD_ALARM_FALLBACK_GROUP_TOP = 100;

/**
 * 报警频率 tab 按钮的 title 提示（口径说明放 tooltip，不占用行高，保持四宫格卡片高度一致）。
 * 分母固定是同桶 JB Start distinct (LOT,SLOT) 片数（同片多断片计 1）；分子按各块自己的口径（触发总和/Tester 数/Probe Card 数）。
 */
const PERIOD_ALARM_RATE_DENOMINATOR_HINT =
  "该桶同期同筛选下 JB Start distinct (LOT,SLOT) 片数（含 TEST / INTERRUPT / TEST ISR / TEST INTERRUPT，不含 Auto retest；同片多断片计 1）";
const PERIOD_ALARM_TOTAL_RATE_TAB_HINT = `delta_diff 报警次数 ÷ ${PERIOD_ALARM_RATE_DENOMINATOR_HINT}`;
const PERIOD_ALARM_TESTER_RATE_TAB_HINT = `该桶 distinct Tester 数 ÷ ${PERIOD_ALARM_RATE_DENOMINATOR_HINT}`;
const PERIOD_ALARM_CARD_RATE_TAB_HINT = `该桶 distinct Probe Card 数 ÷ ${PERIOD_ALARM_RATE_DENOMINATOR_HINT}`;

/**
 * 图表矩阵三张排名图（ProbeCard Type / Device / LOT）固定左边距，使柱子左对齐。
 * `containLabel: true`（默认）会按各图类目文字的实际渲染宽度动态留白，短类目（如 4 位数字）和长类目
 * （如设备名）算出的左边距不同，导致三张图的柱子起点不对齐；改成固定 left + containLabel:false 消除这个差异。
 */
const YIELD_CHART_MATRIX_GRID = { left: 110, right: 44, top: 8, bottom: 8, containLabel: false };

const YM_AGG_TIME_DAY = "timeDay";
const YM_AGG_PROBE_CARD_TYPE = "probeCardType";
const YM_AGG_LOT_ID = "lotId";
const YM_AGG_TREE = "device,lotId,probeCardType,probeCard";
const YM_AGG_DEVICE = "device";

const YM_MAIN_QUERY_AGGS = [
  `${YM_AGG_TIME_DAY}:60`,
  `${YM_AGG_PROBE_CARD_TYPE}:25`,
  `${YM_AGG_LOT_ID}:25`,
  `${YM_AGG_TREE}:100`,
  `${YM_AGG_DEVICE}:30`,
].join("|");

function yieldAggBlockToResponse(
  block: YieldMonitorAggregateBlock | undefined,
  filters: Record<string, unknown>
): YieldMonitorV3AggregateResponse | null {
  if (!block) return null;
  return {
    dimensions: block.dimensions,
    groupTop: block.groupTop,
    orderBy: "COUNT(*) DESC NULLS LAST",
    filters,
    totalRowsMatching: block.totalRowsMatching,
    groups: block.groups,
  };
}

function isPeriodAlarmTrendNotFound(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("NOT_FOUND") || msg.includes("404");
}

type TrendPoint = {
  bucket: PeriodBucket;
  total: number | null;
  testerCount: number | null;
  cardCount: number | null;
  /** 来自 period-alarm-trend；legacy fallback 无此字段 */
  testerAlarmRate?: number | null;
  testerAlarmNumerator?: number | null;
  testerActivityTotal?: number | null;
  topTesters?: PeriodAlarmTopTester[];
  topDevices?: PeriodAlarmTopDevice[];
  topProbeCards?: PeriodAlarmTopProbeCard[];
};

/** buildTrendBarOption/buildTrendLineOption 的 Top N tooltip 通用条目（tester / device / probe card 均可）。 */
type TopTrendEntry = { label: string; count: number };

function resolveTesterAlarmRate(
  rate: number | null | undefined,
  total: number | null,
  numerator?: number | null,
  activityTotal?: number | null
): number | null {
  if (rate != null && Number.isFinite(rate)) {
    return rate > 1 ? null : rate;
  }
  const num = numerator ?? total ?? 0;
  const denom = activityTotal ?? 0;
  if (denom > 0 && num > 0) {
    const computed = num / denom;
    return computed > 1 ? null : computed;
  }
  return null;
}

type TesterTrendTab = "count" | "rate";
type TotalTrendTab = "total" | "rate";

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

/** 周期报警统计 4 图共用的横向 Top10 条形图 option 构建（DRY，避免 4 份近乎重复的 useMemo）。 */
function buildRankBarOption(
  theme: "light" | "dark",
  groups: AggregateGroup[],
  dimKey: string,
  color: string,
  formatLabel: (raw: string) => string = (v) => v
): EChartsOption {
  const palette = getChartPalette(theme);
  const sorted = [...groups].sort((a, b) => a.count - b.count).slice(-10);
  return {
    ...horizontalBarChartBase(theme),
    xAxis: {
      type: "value",
      axisLabel: { color: palette.axisColor },
      splitLine: { lineStyle: { color: palette.splitLine } },
    },
    yAxis: {
      type: "category",
      data: sorted.map((g) => formatLabel(g.parts[dimKey] ?? g.key)),
      axisLabel: { ...horizontalBarCategoryAxisLabel, color: palette.axisColor },
    },
    series: [
      {
        type: "bar",
        data: sorted.map((g) => g.count),
        itemStyle: { color, borderRadius: [0, 4, 4, 0] as unknown as number },
        label: { show: true, position: "right", color: palette.axisColor, fontSize: 10 },
        animationDuration: 600,
      },
    ],
  };
}

/** 近 N 期趋势柱图（竖版）：x 轴为周期桶 label，y 轴为对应数值（null 按 0 展示）。 */
function buildTrendBarOption(
  theme: "light" | "dark",
  buckets: PeriodBucket[],
  values: (number | null)[],
  color: string,
  opts?: {
    period?: PeriodKey;
    metricLabel?: string;
    topEntriesByBucket?: TopTrendEntry[][];
    /** 与 Top 5 触发次数对照的桶内 delta_diff 总和（非柱图主指标时使用） */
    triggerTotalsByBucket?: (number | null)[];
  }
): EChartsOption {
  const palette = getChartPalette(theme);
  const periodPrefix =
    opts?.period === "week" ? "每周" : opts?.period === "month" ? "每月" : "";
  return {
    ...baseChartOption(theme),
    grid: yieldTrendChartGrid,
    xAxis: {
      type: "category",
      data: buckets.map((b) => b.label),
      axisLabel: { color: palette.axisColor, fontSize: 10 },
    },
    yAxis: {
      type: "value",
      axisLabel: { color: palette.axisColor },
      splitLine: { lineStyle: { color: palette.splitLine } },
    },
    series: [
      {
        type: "bar",
        cursor: "default",
        data: values.map((v) => v ?? 0),
        itemStyle: { color, borderRadius: [4, 4, 0, 0] as unknown as number },
        label: { show: true, position: "top", color: palette.axisColor, fontSize: 10 },
        animationDuration: 600,
      },
    ],
    tooltip:
      opts?.topEntriesByBucket && opts.period
        ? {
            ...axisTooltipBase(theme),
            formatter: (params: unknown) => {
              const idx = trendTooltipDataIndex(params);
              if (idx === null) return "";
              const label = buckets[idx]?.label ?? "";
              const val = values[idx];
              const lines = [
                `${periodPrefix} ${label}`,
                `${periodPrefix}${opts.metricLabel ?? ""}: ${val ?? 0}`,
              ];
              const triggerTotal =
                opts.triggerTotalsByBucket?.[idx] ?? val ?? null;
              appendTopEntryTooltipLines(lines, periodPrefix, opts.topEntriesByBucket![idx], {
                triggerTotal,
              });
              return lines.join("<br/>");
            },
          }
        : axisTooltipBase(theme),
  };
}

function topTestersFromAggregateGroups(
  groups: YieldMonitorV3AggregateResponse["groups"] | undefined,
  limit = 5
): PeriodAlarmTopTester[] {
  return [...(groups ?? [])]
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map((g) => ({
      hostname: g.parts.hostname ?? g.key,
      count: g.count,
    }));
}

function topDevicesFromAggregateGroups(
  groups: YieldMonitorV3AggregateResponse["groups"] | undefined,
  limit = 5
): PeriodAlarmTopDevice[] {
  return [...(groups ?? [])]
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map((g) => ({
      device: g.parts.device ?? g.key,
      count: g.count,
    }));
}

function topProbeCardsFromAggregateGroups(
  groups: YieldMonitorV3AggregateResponse["groups"] | undefined,
  limit = 5
): PeriodAlarmTopProbeCard[] {
  return [...(groups ?? [])]
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map((g) => ({
      probeCard: g.parts.probeCard ?? g.key,
      count: g.count,
    }));
}

function axisTooltipBase(theme: "light" | "dark"): Record<string, unknown> {
  return {
    ...(baseChartOption(theme).tooltip as Record<string, unknown>),
    trigger: "axis",
  };
}

function appendTopEntryTooltipLines(
  lines: string[],
  periodPrefix: string,
  top: TopTrendEntry[] | undefined,
  opts?: { triggerTotal?: number | null; header?: string }
): void {
  if (!top?.length) return;
  lines.push(opts?.header ?? `${periodPrefix} Top 5 触发次数:`);
  for (const t of top) {
    lines.push(`${t.label}: ${t.count}`);
  }
  const sum = top.reduce((s, t) => s + t.count, 0);
  const triggerTotal = opts?.triggerTotal;
  if (triggerTotal != null && triggerTotal > 0) {
    lines.push(`Top 5 合计: ${sum} / ${periodPrefix}触发总和 ${triggerTotal}`);
  }
}

function trendTooltipDataIndex(params: unknown): number | null {
  const items = Array.isArray(params) ? params : [params];
  const p = items[0] as { dataIndex?: number } | undefined;
  if (!p || typeof p.dataIndex !== "number") return null;
  return p.dataIndex;
}

/** 总和趋势柱图：hover 展示该桶 Top 5 条目（随周/月粒度切换）。 */
function buildTrendTotalBarOption(
  theme: "light" | "dark",
  period: PeriodKey,
  buckets: PeriodBucket[],
  values: (number | null)[],
  color: string,
  topEntriesByBucket: TopTrendEntry[][]
): EChartsOption {
  const palette = getChartPalette(theme);
  const periodPrefix = period === "week" ? "每周" : "每月";
  return {
    ...baseChartOption(theme),
    grid: yieldTrendChartGrid,
    xAxis: {
      type: "category",
      data: buckets.map((b) => b.label),
      axisLabel: { color: palette.axisColor, fontSize: 10 },
    },
    yAxis: {
      type: "value",
      axisLabel: { color: palette.axisColor },
      splitLine: { lineStyle: { color: palette.splitLine } },
    },
    series: [
      {
        type: "bar",
        cursor: "default",
        data: values.map((v) => v ?? 0),
        itemStyle: { color, borderRadius: [4, 4, 0, 0] as unknown as number },
        label: { show: true, position: "top", color: palette.axisColor, fontSize: 10 },
        animationDuration: 600,
      },
    ],
    tooltip: {
      ...axisTooltipBase(theme),
      formatter: (params: unknown) => {
        const idx = trendTooltipDataIndex(params);
        if (idx === null) return "";
        const items = Array.isArray(params) ? params : [params];
        const p = items[0] as { name?: string; value?: unknown } | undefined;
        const label = buckets[idx]?.label ?? p?.name ?? "";
        const val = values[idx];
        const lines = [`${periodPrefix} ${label}`, `${periodPrefix}触发总和: ${val ?? 0}`];
        appendTopEntryTooltipLines(lines, periodPrefix, topEntriesByBucket[idx], {
          triggerTotal: val ?? null,
        });
        return lines.join("<br/>");
      },
    },
  };
}

/** 周期趋势折线图（y 轴可为百分比等）；tooltip 随周/月粒度切换。 */
function buildTrendLineOption(
  theme: "light" | "dark",
  period: PeriodKey,
  buckets: PeriodBucket[],
  values: (number | null)[],
  color: string,
  valueFormatter: (v: number) => string = (v) => String(v),
  metricLabel: string,
  topEntriesByBucket?: TopTrendEntry[][],
  triggerTotals?: (number | null)[]
): EChartsOption {
  const palette = getChartPalette(theme);
  const periodPrefix = period === "week" ? "每周" : "每月";
  return {
    ...baseChartOption(theme),
    grid: yieldTrendChartGrid,
    xAxis: {
      type: "category",
      data: buckets.map((b) => b.label),
      axisLabel: { color: palette.axisColor, fontSize: 10 },
    },
    yAxis: {
      type: "value",
      axisLabel: {
        color: palette.axisColor,
        formatter: (v: number) => valueFormatter(v),
      },
      splitLine: { lineStyle: { color: palette.splitLine } },
    },
    series: [
      {
        type: "line",
        cursor: "default",
        data: values.map((v) => (v != null ? v : null)),
        smooth: true,
        connectNulls: true,
        lineStyle: { color, width: 2 },
        itemStyle: { color },
        label: {
          show: true,
          position: "top",
          color: palette.axisColor,
          fontSize: 10,
          formatter: (p: { value: unknown }) =>
            typeof p.value === "number" ? valueFormatter(p.value) : "—",
        },
        animationDuration: 600,
      },
    ],
    tooltip: {
      ...axisTooltipBase(theme),
      formatter: (params: unknown) => {
        const idx = trendTooltipDataIndex(params);
        if (idx === null) return "";
        const items = Array.isArray(params) ? params : [params];
        const p = items[0] as { name?: string; value?: unknown } | undefined;
        const label = buckets[idx]?.label ?? p?.name ?? "";
        const raw = p?.value;
        const val =
          typeof raw === "number"
            ? valueFormatter(raw)
            : Array.isArray(raw) && typeof raw[1] === "number"
            ? valueFormatter(raw[1])
            : "—";
        const lines = [`${periodPrefix} ${label}`, `${periodPrefix}${metricLabel}: ${val}`];
        const triggerTotal = triggerTotals?.[idx];
        if (triggerTotal != null) {
          lines.push(`${periodPrefix}触发总和: ${triggerTotal}`);
        }
        appendTopEntryTooltipLines(lines, periodPrefix, topEntriesByBucket?.[idx], {
          triggerTotal: triggerTotal ?? null,
        });
        return lines.join("<br/>");
      },
    },
  };
}

export function YieldMonitorReport({ apiBase, listLimits }: Props) {
  const { theme } = useThemeContext();
  const chartPalette = getChartPalette(theme);
  const [form, setForm] = useState<FormState>(initialForm);
  /** 最近一次「查询」提交的筛选，周期报警统计与之联动。 */
  const [appliedForm, setAppliedForm] = useState<FormState>(initialForm);
  /** 是否已执行过查询；周期报警统计仅在查询后展示。 */
  const [hasQueried, setHasQueried] = useState(false);
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
  const [period, setPeriod] = useState<PeriodKey>("week");
  const [periodTotal, setPeriodTotal] = useState<number | null>(null);
  const [periodPrevTotal, setPeriodPrevTotal] = useState<number | null>(null);
  const [periodByTester, setPeriodByTester] = useState<YieldMonitorV3AggregateResponse | null>(null);
  const [periodByCard, setPeriodByCard] = useState<YieldMonitorV3AggregateResponse | null>(null);
  const [periodByBin, setPeriodByBin] = useState<YieldMonitorV3AggregateResponse | null>(null);
  const [periodByDut, setPeriodByDut] = useState<YieldMonitorV3AggregateResponse | null>(null);
  const [loadingPeriod, setLoadingPeriod] = useState(false);
  const [errorPeriod, setErrorPeriod] = useState<string | null>(null);
  const [trendPoints, setTrendPoints] = useState<TrendPoint[]>([]);
  const [loadingTrend, setLoadingTrend] = useState(false);
  const [errorTrend, setErrorTrend] = useState<string | null>(null);
  const [testerTrendTab, setTesterTrendTab] = useState<TesterTrendTab>("count");
  const [totalTrendTab, setTotalTrendTab] = useState<TotalTrendTab>("total");
  const [cardTrendTab, setCardTrendTab] = useState<TesterTrendTab>("count");
  const trendFetchGenRef = useRef(0);

  const changePeriodAlarmGranularity = useCallback((next: PeriodKey) => {
    setPeriod(next);
    setTrendPoints([]);
    setLoadingTrend(true);
    setErrorTrend(null);
  }, []);

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
    setAppliedForm(initialForm);
    setHasQueried(false);
    setTrendPoints([]);
    setErrorTrend(null);
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
    setAppliedForm(form);
    setHasQueried(true);
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

    try {
      const res = await apiGetJson<YieldMonitorCombinedResponse>(
        apiBase,
        YIELD_COMBINED_PATH,
        {
          ...buildListParams(form, listLimits),
          aggs: YM_MAIN_QUERY_AGGS,
        }
      );
      const filters = res.filters ?? {};
      setList(res);
      setAggTime(
        yieldAggBlockToResponse(res.aggregates[YM_AGG_TIME_DAY], filters)
      );
      setAggCardType(
        yieldAggBlockToResponse(res.aggregates[YM_AGG_PROBE_CARD_TYPE], filters)
      );
      setAggLot(yieldAggBlockToResponse(res.aggregates[YM_AGG_LOT_ID], filters));
      setAggTree(yieldAggBlockToResponse(res.aggregates[YM_AGG_TREE], filters));
      setAggDevice(
        yieldAggBlockToResponse(res.aggregates[YM_AGG_DEVICE], filters)
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErrorList(msg);
      setErrorAgg(msg);
    } finally {
      setLoadingList(false);
      setLoadingAgg(false);
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

  useEffect(() => {
    if (!SHOW_LEGACY_PERIOD_CHARTS || !hasQueried) return;
    let cancelled = false;
    const { start, end, prevStart, prevEnd } = periodWindow(period);
    const periodFilterParams = buildPeriodAlarmQueryParams(appliedForm);
    const periodParams = {
      ...periodFilterParams,
      timeStampFrom: start.toISOString(),
      timeStampTo: end.toISOString(),
    };
    const prevParams = {
      ...periodFilterParams,
      timeStampFrom: prevStart.toISOString(),
      timeStampTo: prevEnd.toISOString(),
    };
    setLoadingPeriod(true);
    setErrorPeriod(null);

    (async () => {
      const settled = await allSettledWithConcurrency(
        [
          () =>
            apiGetJson<YieldMonitorV3AggregateResponse>(apiBase, YIELD_AGGREGATE_PATH, {
              ...periodParams,
              dimensions: "hostname",
              groupTop: 10,
            }),
          () =>
            apiGetJson<YieldMonitorV3AggregateResponse>(apiBase, YIELD_AGGREGATE_PATH, {
              ...periodParams,
              dimensions: "probeCard",
              groupTop: 10,
            }),
          () =>
            apiGetJson<YieldMonitorV3AggregateResponse>(apiBase, YIELD_AGGREGATE_PATH, {
              ...periodParams,
              dimensions: "bin",
              groupTop: 10,
            }),
          () =>
            apiGetJson<YieldMonitorV3AggregateResponse>(apiBase, YIELD_AGGREGATE_PATH, {
              ...periodParams,
              dimensions: "dutNumber",
              groupTop: 10,
            }),
          () =>
            apiGetJson<YieldMonitorV3AggregateResponse>(apiBase, YIELD_AGGREGATE_PATH, {
              ...prevParams,
              dimensions: "hostname",
              groupTop: 1,
            }),
        ],
        REPORT_ORACLE_FANOUT_CONCURRENCY
      );
      if (cancelled) return;
      const [testerRes, cardRes, binRes, dutRes, prevRes] = settled as [
        PromiseSettledResult<YieldMonitorV3AggregateResponse>,
        PromiseSettledResult<YieldMonitorV3AggregateResponse>,
        PromiseSettledResult<YieldMonitorV3AggregateResponse>,
        PromiseSettledResult<YieldMonitorV3AggregateResponse>,
        PromiseSettledResult<YieldMonitorV3AggregateResponse>,
      ];
      setLoadingPeriod(false);

      if (testerRes.status === "fulfilled") {
        setPeriodByTester(testerRes.value);
        setPeriodTotal(testerRes.value.totalRowsMatching ?? null);
      } else {
        setErrorPeriod(
          testerRes.reason instanceof Error
            ? testerRes.reason.message
            : String(testerRes.reason)
        );
      }
      if (cardRes.status === "fulfilled") setPeriodByCard(cardRes.value);
      if (binRes.status === "fulfilled") setPeriodByBin(binRes.value);
      if (dutRes.status === "fulfilled") setPeriodByDut(dutRes.value);
      if (prevRes.status === "fulfilled") {
        setPeriodPrevTotal(prevRes.value.totalRowsMatching ?? null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [apiBase, period, appliedForm, hasQueried]);

  const periodAlarmQueryParams = useMemo(
    () => buildPeriodAlarmQueryParams(appliedForm),
    [appliedForm]
  );

  const periodAlarmBucketPlan = useMemo(() => {
    const { from, to } = resolvePeriodAlarmTimeRangeFromIso(
      periodAlarmQueryParams.timeStampFrom as string | undefined,
      periodAlarmQueryParams.timeStampTo as string | undefined
    );
    return periodBucketsInRange(period, from, to);
  }, [period, periodAlarmQueryParams]);

  const periodAlarmBuckets = periodAlarmBucketPlan.ok ? periodAlarmBucketPlan.buckets : [];

  useEffect(() => {
    if (!hasQueried) return;
    const fetchGen = ++trendFetchGenRef.current;
    let cancelled = false;
    setTrendPoints([]);
    setLoadingTrend(true);
    setErrorTrend(null);

    if (!periodAlarmBucketPlan.ok) {
      setTrendPoints([]);
      setErrorTrend(periodAlarmBucketPlan.error);
      setLoadingTrend(false);
      return;
    }

    const nowIso = new Date().toISOString();

    const loadLegacyFallback = async (): Promise<TrendPoint[]> => {
      const buckets = periodAlarmBuckets;
      const calls: (() => Promise<YieldMonitorV3AggregateResponse>)[] = [];
      for (const bucket of buckets) {
        const bucketParams = {
          ...periodAlarmQueryParams,
          timeStampFrom: bucket.start.toISOString(),
          timeStampTo: bucket.end.toISOString(),
        };
        calls.push(() =>
          apiGetJson<YieldMonitorV3AggregateResponse>(apiBase, YIELD_AGGREGATE_PATH, {
            ...bucketParams,
            dimensions: "hostname",
            groupTop: PERIOD_ALARM_FALLBACK_GROUP_TOP,
          })
        );
        calls.push(() =>
          apiGetJson<YieldMonitorV3AggregateResponse>(apiBase, YIELD_AGGREGATE_PATH, {
            ...bucketParams,
            dimensions: "probeCard",
            groupTop: PERIOD_ALARM_FALLBACK_GROUP_TOP,
          })
        );
        calls.push(() =>
          apiGetJson<YieldMonitorV3AggregateResponse>(apiBase, YIELD_AGGREGATE_PATH, {
            ...bucketParams,
            dimensions: "device",
            groupTop: PERIOD_ALARM_FALLBACK_GROUP_TOP,
          })
        );
      }
      const settled = (await allSettledWithConcurrency(
        calls,
        REPORT_ORACLE_FANOUT_CONCURRENCY
      )) as PromiseSettledResult<YieldMonitorV3AggregateResponse>[];
      const firstRejected = settled.find((r) => r.status === "rejected");
      if (firstRejected?.status === "rejected") {
        throw firstRejected.reason;
      }
      return buckets.map((bucket, i) => {
        const [testerRes, cardRes, deviceRes] = settled.slice(i * 3, i * 3 + 3);
        const ok = (r: PromiseSettledResult<YieldMonitorV3AggregateResponse>) =>
          r.status === "fulfilled" ? r.value : null;
        const tester = ok(testerRes);
        const card = ok(cardRes);
        const device = ok(deviceRes);
        return {
          bucket,
          total: tester?.totalRowsMatching ?? card?.totalRowsMatching ?? null,
          testerCount: tester ? tester.groups.length : null,
          cardCount: card ? card.groups.length : null,
          topTesters: topTestersFromAggregateGroups(tester?.groups),
          topDevices: topDevicesFromAggregateGroups(device?.groups),
          topProbeCards: topProbeCardsFromAggregateGroups(card?.groups),
        };
      });
    };

    (async () => {
      try {
        const res = await apiGetJson<YieldMonitorPeriodAlarmTrendResponse>(
          apiBase,
          YIELD_PERIOD_ALARM_TREND_PATH,
          { period, now: nowIso, ...periodAlarmQueryParams }
        );
        if (cancelled || fetchGen !== trendFetchGenRef.current) return;
        setTrendPoints(
          res.buckets.map((b) => ({
            bucket: {
              start: new Date(b.timeStampFrom),
              end: new Date(b.timeStampTo),
              label: b.label,
            },
            total: b.total,
            testerCount: b.testerCount,
            cardCount: b.cardCount,
            testerAlarmNumerator: b.testerAlarmNumerator ?? b.total,
            testerActivityTotal: b.testerActivityTotal,
            testerAlarmRate: resolveTesterAlarmRate(
              b.testerAlarmRate,
              b.total,
              b.testerAlarmNumerator ?? b.total,
              b.testerActivityTotal
            ),
            topTesters: b.topTesters ?? [],
            topDevices: b.topDevices ?? [],
            topProbeCards: b.topProbeCards ?? [],
          }))
        );
        setErrorTrend(null);
      } catch (e) {
        if (cancelled || fetchGen !== trendFetchGenRef.current) return;
        if (!isPeriodAlarmTrendNotFound(e)) {
          setTrendPoints([]);
          setErrorTrend(e instanceof Error ? e.message : String(e));
          return;
        }
        try {
          const points = await loadLegacyFallback();
          if (cancelled || fetchGen !== trendFetchGenRef.current) return;
          setTrendPoints(points);
          setErrorTrend(null);
        } catch (fallbackErr) {
          if (cancelled || fetchGen !== trendFetchGenRef.current) return;
          setTrendPoints([]);
          setErrorTrend(
            fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)
          );
        }
      } finally {
        if (!cancelled && fetchGen === trendFetchGenRef.current) {
          setLoadingTrend(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [apiBase, period, periodAlarmQueryParams, periodAlarmBucketPlan, hasQueried]);

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
      ...baseChartOption(theme),
      grid: yieldTrendChartGrid,
      xAxis: {
        type: "category",
        data: dates,
        axisLabel: { color: chartPalette.axisColor, fontSize: 10, rotate: 30 },
      },
      yAxis: {
        type: "value",
        axisLabel: { color: chartPalette.axisColor },
        splitLine: { lineStyle: { color: chartPalette.splitLine } },
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
                { offset: 0, color: `rgba(${theme === "light" ? "9,105,218" : "88,166,255"},0.3)` },
                { offset: 1, color: `rgba(${theme === "light" ? "9,105,218" : "88,166,255"},0.02)` },
              ],
            },
          },
          lineStyle: { color: chartPalette.accent, width: 2 },
          itemStyle: { color: chartPalette.accent },
          animationDuration: 600,
        },
      ],
      tooltip: { trigger: "axis" },
    };
  }, [aggTime, theme]);

  // ProbeCard Type ranking bar chart
  const cardTypeOption = useMemo((): EChartsOption => {
    const sorted = [...(aggCardType?.groups ?? [])]
      .sort((a, b) => a.count - b.count)
      .slice(-10);
    const { base: COL, bright: COL_B, dim: COL_D } = selectionTierColors(theme, "purple");
    return {
      ...horizontalBarChartBase(theme),
      grid: YIELD_CHART_MATRIX_GRID,
      xAxis: {
        type: "value",
        axisLabel: { color: chartPalette.axisColor },
        splitLine: { lineStyle: { color: chartPalette.splitLine } },
      },
      yAxis: {
        type: "category",
        data: sorted.map((g) => g.parts.probeCardType ?? g.key),
        axisLabel: { ...horizontalBarCategoryAxisLabel, color: chartPalette.axisColor },
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
            color: chartPalette.axisColor,
            fontSize: 10,
          },
          animationDuration: 600,
        },
      ],
    };
  }, [aggCardType, selectedCardTypeName, theme]);

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
      ...horizontalBarChartBase(theme),
      xAxis: {
        type: "value",
        axisLabel: { color: chartPalette.axisColor },
        splitLine: { lineStyle: { color: chartPalette.splitLine } },
      },
      yAxis: {
        type: "category",
        data: sorted.map((e) => `dut#${e.dut}`),
        axisLabel: { ...horizontalBarCategoryAxisLabel, color: chartPalette.axisColor },
      },
      series: [
        {
          type: "bar",
          cursor: "default",
          data: sorted.map((e) => e.count),
          itemStyle: { color: chartPalette.accent3, borderRadius: [0, 4, 4, 0] as unknown as number },
          label: {
            show: true,
            position: "right",
            color: chartPalette.axisColor,
            fontSize: 10,
          },
          animationDuration: 600,
        },
      ],
    };
  }, [dutTally, theme]);

  const periodTesterOption = useMemo(
    () => buildRankBarOption(theme, periodByTester?.groups ?? [], "hostname", chartPalette.accent),
    [periodByTester, theme, chartPalette.accent]
  );
  const periodCardOption = useMemo(
    () => buildRankBarOption(theme, periodByCard?.groups ?? [], "probeCard", chartPalette.accent2),
    [periodByCard, theme, chartPalette.accent2]
  );
  const periodBinOption = useMemo(
    () =>
      buildRankBarOption(theme, periodByBin?.groups ?? [], "bin", chartPalette.accent3, formatBinLabel),
    [periodByBin, theme, chartPalette.accent3]
  );
  const periodDutOption = useMemo(
    () =>
      buildRankBarOption(
        theme,
        periodByDut?.groups ?? [],
        "dutNumber",
        selectionTierColors(theme, "orange").base,
        (v) => `dut#${v}`
      ),
    [periodByDut, theme]
  );

  const trendBuckets = useMemo(() => trendPoints.map((p) => p.bucket), [trendPoints]);
  const trendTopTesterEntriesByBucket = useMemo(
    () => trendPoints.map((p) => (p.topTesters ?? []).map((t) => ({ label: t.hostname, count: t.count }))),
    [trendPoints]
  );
  const trendTopDeviceEntriesByBucket = useMemo(
    () => trendPoints.map((p) => (p.topDevices ?? []).map((d) => ({ label: d.device, count: d.count }))),
    [trendPoints]
  );
  const trendTopProbeCardEntriesByBucket = useMemo(
    () => trendPoints.map((p) => (p.topProbeCards ?? []).map((c) => ({ label: c.probeCard, count: c.count }))),
    [trendPoints]
  );
  const trendTotalOption = useMemo(
    () =>
      buildTrendTotalBarOption(
        theme,
        period,
        trendBuckets,
        trendPoints.map((p) => p.total),
        selectionTierColors(theme, "gold").base,
        trendTopDeviceEntriesByBucket
      ),
    [trendBuckets, trendPoints, trendTopDeviceEntriesByBucket, theme, period]
  );

  const periodAlarmTotalTrendLabel =
    period === "week" ? "每周触发总和" : "每月触发总和";
  const periodAlarmTesterTrendLabel =
    period === "week" ? "每周 Tester 数" : "每月 Tester 数";

  const trendTesterOption = useMemo(
    () =>
      buildTrendBarOption(
        theme,
        trendBuckets,
        trendPoints.map((p) => p.testerCount),
        chartPalette.accent,
        {
          period,
          metricLabel: " Tester 数",
          topEntriesByBucket: trendTopTesterEntriesByBucket,
          triggerTotalsByBucket: trendPoints.map((p) => p.total),
        }
      ),
    [trendBuckets, trendPoints, trendTopTesterEntriesByBucket, theme, chartPalette.accent, period]
  );
  /** 每块「报警频率」的分子各用自己的口径（触发总和/Tester 数/Probe Card 数），分母统一是 JB distinct (LOT,SLOT) 片数。 */
  const trendTotalRateValues = useMemo(
    () =>
      trendPoints.map((p) => {
        const rate = resolveTesterAlarmRate(
          p.testerAlarmRate,
          p.total,
          p.testerAlarmNumerator,
          p.testerActivityTotal
        );
        return rate != null ? rate * 100 : null;
      }),
    [trendPoints]
  );
  const trendTesterRateValues = useMemo(
    () =>
      trendPoints.map((p) => {
        const rate = resolveTesterAlarmRate(null, null, p.testerCount, p.testerActivityTotal);
        return rate != null ? rate * 100 : null;
      }),
    [trendPoints]
  );
  const trendCardRateValues = useMemo(
    () =>
      trendPoints.map((p) => {
        const rate = resolveTesterAlarmRate(null, null, p.cardCount, p.testerActivityTotal);
        return rate != null ? rate * 100 : null;
      }),
    [trendPoints]
  );
  const trendTotalRateOption = useMemo(
    () =>
      buildTrendLineOption(
        theme,
        period,
        trendBuckets,
        trendTotalRateValues,
        chartPalette.accent,
        (v) => `${v.toFixed(1)}%`,
        "触发总和 报警频率",
        trendTopDeviceEntriesByBucket,
        trendPoints.map((p) => p.total)
      ),
    [trendBuckets, trendTotalRateValues, trendTopDeviceEntriesByBucket, trendPoints, theme, chartPalette.accent, period]
  );
  const trendTesterRateOption = useMemo(
    () =>
      buildTrendLineOption(
        theme,
        period,
        trendBuckets,
        trendTesterRateValues,
        chartPalette.accent,
        (v) => `${v.toFixed(1)}%`,
        "Tester 报警频率",
        trendTopTesterEntriesByBucket,
        trendPoints.map((p) => p.total)
      ),
    [trendBuckets, trendTesterRateValues, trendTopTesterEntriesByBucket, trendPoints, theme, chartPalette.accent, period]
  );
  const trendCardRateOption = useMemo(
    () =>
      buildTrendLineOption(
        theme,
        period,
        trendBuckets,
        trendCardRateValues,
        chartPalette.accent2,
        (v) => `${v.toFixed(1)}%`,
        "Probe Card 报警频率",
        trendTopProbeCardEntriesByBucket,
        trendPoints.map((p) => p.total)
      ),
    [trendBuckets, trendCardRateValues, trendTopProbeCardEntriesByBucket, trendPoints, theme, chartPalette.accent2, period]
  );
  const periodAlarmCardTrendLabel =
    period === "week" ? "每周 Probe Card 数" : "每月 Probe Card 数";

  const trendCardOption = useMemo(
    () =>
      buildTrendBarOption(
        theme,
        trendBuckets,
        trendPoints.map((p) => p.cardCount),
        chartPalette.accent2,
        {
          period,
          metricLabel: " Probe Card 数",
          topEntriesByBucket: trendTopProbeCardEntriesByBucket,
          triggerTotalsByBucket: trendPoints.map((p) => p.total),
        }
      ),
    [trendBuckets, trendPoints, trendTopProbeCardEntriesByBucket, theme, chartPalette.accent2, period]
  );

  const periodRatioPct = useMemo(() => {
    if (periodTotal === null || periodPrevTotal === null) return null;
    if (periodPrevTotal === 0) return periodTotal > 0 ? Infinity : 0;
    return ((periodTotal - periodPrevTotal) / periodPrevTotal) * 100;
  }, [periodTotal, periodPrevTotal]);

  const periodRatioLabel = useMemo(() => {
    if (periodRatioPct === null) return "—";
    if (periodRatioPct === Infinity) return "新增";
    if (periodRatioPct === 0) return "0%";
    const sign = periodRatioPct > 0 ? "↑" : "↓";
    return `${sign}${Math.abs(periodRatioPct).toFixed(1)}%`;
  }, [periodRatioPct]);

  const periodRatioColor: KpiColor = useMemo(() => {
    if (periodRatioPct === null || periodRatioPct === 0) return "white";
    return periodRatioPct === Infinity || periodRatioPct > 0 ? "red" : "green";
  }, [periodRatioPct]);

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
          <span style={{ fontSize: 12, color: "var(--accent)", fontWeight: 600 }}>
            {onClose ? `↳ DUT# 分布 · ${cardId}` : `DUT# 分布 · ${cardId}`}
          </span>
          {onClose ? (
            <button
              type="button"
              className="chip"
              style={{ color: "var(--red-text)", borderColor: "rgba(var(--red-rgb),0.3)" }}
              onClick={onClose}
            >
              ✕ 关闭
            </button>
          ) : null}
        </div>
        {loadingDut ? (
          <div style={{ color: "var(--muted)", fontSize: 13, padding: "8px 0" }}>
            加载中…
          </div>
        ) : dutRows === null ? null : dutRows.length === 0 ? (
          <div style={{ color: "var(--muted)", fontSize: 13, padding: "4px 0" }}>
            该探针卡暂无触发记录
          </div>
        ) : dutTally.length === 0 ? (
          <div style={{ color: "var(--muted)", fontSize: 13, padding: "4px 0" }}>
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
    const { base: COL, bright: COL_B, dim: COL_D } = selectionTierColors(theme, "orange");
    return {
      ...horizontalBarChartBase(theme),
      grid: YIELD_CHART_MATRIX_GRID,
      xAxis: {
        type: "value",
        axisLabel: { color: chartPalette.axisColor },
        splitLine: { lineStyle: { color: chartPalette.splitLine } },
      },
      yAxis: {
        type: "category",
        data: sorted.map((g) => g.parts.lotId ?? g.key),
        axisLabel: { ...horizontalBarCategoryAxisLabel, color: chartPalette.axisColor },
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
            color: chartPalette.axisColor,
            fontSize: 10,
          },
          animationDuration: 600,
        },
      ],
    };
  }, [aggLot, selectedLotId, theme]);

  const deviceOption = useMemo((): EChartsOption => {
    const sorted = [...(aggDevice?.groups ?? [])]
      .sort((a, b) => a.count - b.count)
      .slice(-20);
    const { base: COL, bright: COL_B, dim: COL_D } = selectionTierColors(theme, "blue-light");
    return {
      ...horizontalBarChartBase(theme),
      grid: YIELD_CHART_MATRIX_GRID,
      xAxis: {
        type: "value",
        axisLabel: { color: chartPalette.axisColor },
        splitLine: { lineStyle: { color: chartPalette.splitLine } },
      },
      yAxis: {
        type: "category",
        data: sorted.map((g) => g.parts.device ?? g.key),
        axisLabel: { ...horizontalBarCategoryAxisLabel, color: chartPalette.axisColor },
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
          label: { show: true, position: "right", color: chartPalette.axisColor, fontSize: 10 },
          animationDuration: 600,
        },
      ],
    };
  }, [aggDevice, selectedDevice, theme]);

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
      DUTNUMBER: r.dutNumber ?? "—",
    }));
  }, [list]);

  const chips = useMemo(() => activeChips(form, listLimits), [form, listLimits]);
  const periodAlarmFilterLabels = useMemo(() => {
    const labels: string[] = [];
    for (const [k, v] of Object.entries(periodAlarmQueryParams)) {
      if (v !== undefined && k !== "timeStampFrom" && k !== "timeStampTo") {
        labels.push(`${k} = ${v}`);
      }
    }
    return labels;
  }, [periodAlarmQueryParams]);

  const periodAlarmTimeHint = useMemo(() => {
    if (!periodAlarmBucketPlan.ok) {
      return periodAlarmBucketPlan.error;
    }
    const bucketCount = periodAlarmBucketPlan.buckets.length;
    const unit = period === "week" ? "周" : "月";
    if (appliedForm.timestampFrom && appliedForm.timestampTo) {
      return `每${unit}触发总和，按 ${appliedForm.timestampFrom} → ${appliedForm.timestampTo} 共 ${bucketCount} 个${unit}`;
    }
    if (appliedForm.timestampFrom) {
      return `每${unit}触发总和，自 ${appliedForm.timestampFrom} 起至当前，共 ${bucketCount} 个${unit}`;
    }
    if (appliedForm.timestampTo) {
      return `每${unit}触发总和，截至 ${appliedForm.timestampTo}（向前 1 年），共 ${bucketCount} 个${unit}`;
    }
    return `每${unit}触发总和，未选 TIME_STAMP 时默认近 1 年，共 ${bucketCount} 个${unit}`;
  }, [appliedForm, period, periodAlarmBucketPlan]);
  const hasData = !!(list || aggTime || aggCardType);

  const yieldReportSections = useMemo(() => {
    const periodAlarmSection = (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <p className="yield-trend-scope-hint muted small">
          {periodAlarmFilterLabels.length > 0
            ? `与查询条件联动：${periodAlarmFilterLabels.join(" · ")} · `
            : ""}
          {periodAlarmTimeHint}
        </p>
        <div className="preset-chips">
          {(["week", "month"] as const).map((p) => (
            <button
              key={p}
              type="button"
              className={`chip${period === p ? " chip--active" : ""}`}
              onClick={() => changePeriodAlarmGranularity(p)}
            >
              {p === "week" ? "周" : "月"}
            </button>
          ))}
        </div>
        {SHOW_LEGACY_PERIOD_CHARTS && (
          <>
            <DraggableReportBlocks
              storageKey="pcr-ai-report:yield-monitor-alarm-kpi-blocks"
              defaultOrder={YIELD_ALARM_KPI_BLOCK_ORDER}
              layoutEpoch={layoutEpoch}
              axis="x"
              groupClassName="report-reorder-group--kpis"
              labels={{
                kpiAlarmTotal: "总触发次数",
                kpiAlarmRatio: "环比变化率",
              }}
              sections={{
                kpiAlarmTotal: (
                  <KpiCard
                    label="总触发次数"
                    value={periodTotal}
                    color="blue"
                    subtext={periodPrevTotal !== null ? `上一周期 ${periodPrevTotal} 次` : undefined}
                    showLabel={false}
                  />
                ),
                kpiAlarmRatio: (
                  <KpiCard
                    label="环比变化率"
                    value={periodRatioLabel}
                    color={periodRatioColor}
                    subtext="vs 上一周期"
                    showLabel={false}
                  />
                ),
              }}
            />
            {errorPeriod && (
              <div style={{ color: "var(--red-text)", fontSize: 12 }}>{errorPeriod}</div>
            )}
            <DraggableReportBlocks
              storageKey="pcr-ai-report:yield-monitor-alarm-chart-blocks"
              defaultOrder={YIELD_ALARM_CHART_BLOCK_ORDER}
              layoutEpoch={layoutEpoch}
              axis="grid"
              groupClassName="report-reorder-group--chartgrid"
              labels={{
                chAlarmTester: "Tester 分布",
                chAlarmCard: "Probe Card 分布",
                chAlarmBin: "Bin 分布",
                chAlarmDut: "DUT 分布",
              }}
              sections={{
                chAlarmTester: (
                  <div className="report-chart-panel chart-no-drill">
                    {loadingPeriod ? (
                      <div style={{ color: "var(--muted)", fontSize: 13, padding: "8px 0" }}>加载中…</div>
                    ) : (periodByTester?.groups.length ?? 0) === 0 ? (
                      <div style={{ color: "var(--muted)", fontSize: 13, padding: "8px 0" }}>该周期无触发记录</div>
                    ) : (
                      <DarkChart
                        option={periodTesterOption}
                        height={rankBarChartHeight(periodByTester?.groups.length ?? 0, 10)}
                      />
                    )}
                  </div>
                ),
                chAlarmCard: (
                  <div className="report-chart-panel chart-no-drill">
                    {loadingPeriod ? (
                      <div style={{ color: "var(--muted)", fontSize: 13, padding: "8px 0" }}>加载中…</div>
                    ) : (periodByCard?.groups.length ?? 0) === 0 ? (
                      <div style={{ color: "var(--muted)", fontSize: 13, padding: "8px 0" }}>该周期无触发记录</div>
                    ) : (
                      <DarkChart
                        option={periodCardOption}
                        height={rankBarChartHeight(periodByCard?.groups.length ?? 0, 10)}
                      />
                    )}
                  </div>
                ),
                chAlarmBin: (
                  <div className="report-chart-panel chart-no-drill">
                    {loadingPeriod ? (
                      <div style={{ color: "var(--muted)", fontSize: 13, padding: "8px 0" }}>加载中…</div>
                    ) : (periodByBin?.groups.length ?? 0) === 0 ? (
                      <div style={{ color: "var(--muted)", fontSize: 13, padding: "8px 0" }}>该周期无触发记录</div>
                    ) : (
                      <DarkChart
                        option={periodBinOption}
                        height={rankBarChartHeight(periodByBin?.groups.length ?? 0, 10)}
                      />
                    )}
                  </div>
                ),
                chAlarmDut: (
                  <div className="report-chart-panel chart-no-drill">
                    {loadingPeriod ? (
                      <div style={{ color: "var(--muted)", fontSize: 13, padding: "8px 0" }}>加载中…</div>
                    ) : (periodByDut?.groups.length ?? 0) === 0 ? (
                      <div style={{ color: "var(--muted)", fontSize: 13, padding: "8px 0" }}>该周期无触发记录</div>
                    ) : (
                      <DarkChart
                        option={periodDutOption}
                        height={rankBarChartHeight(periodByDut?.groups.length ?? 0, 10)}
                      />
                    )}
                  </div>
                ),
              }}
            />
          </>
        )}
        {errorTrend && (
          <div style={{ color: "var(--red-text)", fontSize: 12 }}>{errorTrend}</div>
        )}
        <DraggableReportBlocks
          storageKey="pcr-ai-report:yield-monitor-alarm-trend-chart-blocks"
          defaultOrder={YIELD_ALARM_TREND_CHART_BLOCK_ORDER}
          layoutEpoch={layoutEpoch}
          axis="grid"
          groupClassName="report-reorder-group--chartgrid"
          labels={{
            chAlarmTotalTrend: periodAlarmTotalTrendLabel,
            chAlarmTesterTrend: periodAlarmTesterTrendLabel,
            chAlarmCardTrend: periodAlarmCardTrendLabel,
            chAlarmDailyTrend: "每日触发量趋势",
          }}
          sections={{
            chAlarmTotalTrend: (
              <div className="report-chart-panel">
                <div className="preset-chips tester-trend-tabs" style={{ marginBottom: 8 }}>
                  <button
                    type="button"
                    className={`chip${totalTrendTab === "total" ? " chip--active" : ""}`}
                    onClick={() => setTotalTrendTab("total")}
                  >
                    {period === "week" ? "每周" : "每月"} 触发总和
                  </button>
                  <button
                    type="button"
                    className={`chip${totalTrendTab === "rate" ? " chip--active" : ""}`}
                    onClick={() => setTotalTrendTab("rate")}
                    title={PERIOD_ALARM_TOTAL_RATE_TAB_HINT}
                  >
                    {period === "week" ? "每周" : "每月"} 报警频率
                  </button>
                </div>
                {loadingTrend ? (
                  <div style={{ color: "var(--muted)", fontSize: 13, padding: "8px 0" }}>加载中…</div>
                ) : (
                  <div className="chart-no-drill">
                    {totalTrendTab === "total" ? (
                      <DarkChart
                        key={`alarm-total-${period}`}
                        option={trendTotalOption}
                        height={YIELD_TREND_CHART_HEIGHT}
                      />
                    ) : (
                      <DarkChart
                        key={`alarm-total-rate-${period}`}
                        option={trendTotalRateOption}
                        height={YIELD_TREND_CHART_HEIGHT}
                      />
                    )}
                  </div>
                )}
              </div>
            ),
            chAlarmTesterTrend: (
              <div className="report-chart-panel">
                <div className="preset-chips tester-trend-tabs" style={{ marginBottom: 8 }}>
                  <button
                    type="button"
                    className={`chip${testerTrendTab === "count" ? " chip--active" : ""}`}
                    onClick={() => setTesterTrendTab("count")}
                  >
                    {period === "week" ? "每周" : "每月"} Tester 数
                  </button>
                  <button
                    type="button"
                    className={`chip${testerTrendTab === "rate" ? " chip--active" : ""}`}
                    onClick={() => setTesterTrendTab("rate")}
                    title={PERIOD_ALARM_TESTER_RATE_TAB_HINT}
                  >
                    {period === "week" ? "每周" : "每月"} 报警频率
                  </button>
                </div>
                {loadingTrend ? (
                  <div style={{ color: "var(--muted)", fontSize: 13, padding: "8px 0" }}>加载中…</div>
                ) : (
                  <div className="chart-no-drill">
                    {testerTrendTab === "count" ? (
                      <DarkChart
                        key={`alarm-tester-count-${period}`}
                        option={trendTesterOption}
                        height={YIELD_TREND_CHART_HEIGHT}
                      />
                    ) : (
                      <DarkChart
                        key={`alarm-tester-rate-${period}`}
                        option={trendTesterRateOption}
                        height={YIELD_TREND_CHART_HEIGHT}
                      />
                    )}
                  </div>
                )}
              </div>
            ),
            chAlarmCardTrend: (
              <div className="report-chart-panel">
                <div className="preset-chips tester-trend-tabs" style={{ marginBottom: 8 }}>
                  <button
                    type="button"
                    className={`chip${cardTrendTab === "count" ? " chip--active" : ""}`}
                    onClick={() => setCardTrendTab("count")}
                  >
                    {period === "week" ? "每周" : "每月"} Probe Card 数
                  </button>
                  <button
                    type="button"
                    className={`chip${cardTrendTab === "rate" ? " chip--active" : ""}`}
                    onClick={() => setCardTrendTab("rate")}
                    title={PERIOD_ALARM_CARD_RATE_TAB_HINT}
                  >
                    {period === "week" ? "每周" : "每月"} 报警频率
                  </button>
                </div>
                {loadingTrend ? (
                  <div style={{ color: "var(--muted)", fontSize: 13, padding: "8px 0" }}>加载中…</div>
                ) : (
                  <div className="chart-no-drill">
                    {cardTrendTab === "count" ? (
                      <DarkChart
                        key={`alarm-card-count-${period}`}
                        option={trendCardOption}
                        height={YIELD_TREND_CHART_HEIGHT}
                      />
                    ) : (
                      <DarkChart
                        key={`alarm-card-rate-${period}`}
                        option={trendCardRateOption}
                        height={YIELD_TREND_CHART_HEIGHT}
                      />
                    )}
                  </div>
                )}
              </div>
            ),
            chAlarmDailyTrend: (
              <div className="report-chart-panel chart-no-drill">
                {aggTime ? (
                  <>
                    <p
                      className="yield-trend-scope-hint small"
                      style={{ marginBottom: 8, minHeight: 33, display: "flex", alignItems: "center" }}
                    >
                      {appliedForm.timestampFrom || appliedForm.timestampTo
                        ? "按所选 TIME_STAMP 时间窗统计全部匹配行（不受明细 limit 影响）"
                        : "未选手动时间时默认统计近一年全部匹配行（不受明细 limit 影响）"}
                    </p>
                    <DarkChart option={timeTrendOption} height={YIELD_TREND_CHART_HEIGHT} />
                  </>
                ) : (
                  <div style={{ color: "var(--muted)", fontSize: 13, padding: "8px 0" }}>加载中…</div>
                )}
              </div>
            ),
          }}
        />
      </div>
    );

    if (!hasQueried) return {};

    if (!hasData) return { periodAlarm: periodAlarmSection };

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
        labelSuffixes={{
          kpiTrig: "全量 · 不受 limit",
          kpiWorstPct: "全量 · 不受 limit",
        }}
        sections={{
          kpiTrig: (
            <KpiCard
              label="触发总数"
              value={totalTriggers}
              color="blue"
              subtext="全量匹配 · 不受明细 limit 影响"
              subtextClassName="report-scope-hint"
              showLabel={false}
            />
          ),
          kpiLots: (
            <KpiCard
              label="涉及 Lot 数"
              value={uniqueLots}
              color="white"
              subtext={`明细 Top-${listLimits.defaultLimit} 内去重`}
              subtextClassName="report-scope-hint"
              showLabel={false}
            />
          ),
          kpiWorstPct: (
            <KpiCard
              label="触发最多探针卡类型"
              value={worstCardType}
              color="red"
              subtext="全量匹配 · 不受明细 limit 影响"
              subtextClassName="report-scope-hint"
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
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: 16,
          }}
        >
          <div
            style={{
              fontSize: 13,
              color: "var(--muted)",
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
            <span style={{ fontSize: 12, color: "var(--dimmed)", fontWeight: 400 }}>
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
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: 16,
          }}
        >
          <div
            style={{
              fontSize: 13,
              color: "var(--muted)",
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
            共 {list?.count ?? 0} 条（含 PROBECARDTYPE / DUTNUMBER）
          </div>
          {showDetail && <DataTable rows={detailRows} maxHeight={400} />}
        </div>
      ) : null;

    return {
      kpi: kpiSection,
      periodAlarm: periodAlarmSection,
      chartsGrid: chartsGridSection,
      tree: treeSection,
      detail: detailSection,
    };
  }, [
    hasData,
    hasQueried,
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
    listLimits.defaultLimit,
    showDetail,
    layoutEpoch,
    period,
    periodAlarmFilterLabels,
    periodAlarmTimeHint,
    periodAlarmTotalTrendLabel,
    periodAlarmTesterTrendLabel,
    periodAlarmCardTrendLabel,
    periodTotal,
    periodPrevTotal,
    periodRatioLabel,
    periodRatioColor,
    periodByTester,
    periodByCard,
    periodByBin,
    periodByDut,
    periodTesterOption,
    periodCardOption,
    periodBinOption,
    periodDutOption,
    loadingPeriod,
    errorPeriod,
    trendPoints,
    trendBuckets,
    trendTotalOption,
    trendTotalRateOption,
    trendTesterOption,
    trendTesterRateOption,
    trendCardRateOption,
    testerTrendTab,
    totalTrendTab,
    cardTrendTab,
    changePeriodAlarmGranularity,
    trendCardOption,
    loadingTrend,
    errorTrend,
  ]);

  return (
    <div className="report-panel">
      {/* ── Header ── */}
      <div className="report-panel-header">
        <div>
          <h2>⚡ Yield Monitor</h2>
          <p className="report-desc">
            Trigger analysis (<code className="report-desc-type-scope">TYPE = delta_diff</code>). Set filters and click <strong>Query</strong> to
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
            <span style={{ color: "var(--muted)", fontSize: 13 }}>→</span>
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
              {loadingList || loadingAgg ? "🔍 查询中…" : "🔍 查询"}
            </button>
            <button
              type="button"
              className="btn ghost query-panel-clear"
              disabled={loadingList || loadingAgg}
              onClick={clearAll}
            >
              ✕ 清空
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
            color: "var(--red-text)",
            fontSize: 13,
            background: "rgba(var(--red-rgb),0.08)",
            padding: "8px 12px",
            borderRadius: 6,
          }}
        >
          {errorList || errorAgg}
        </div>
      )}

      <DraggableReportSections
          storageKey="pcr-ai-report:yield-monitor-modules"
          defaultOrder={YIELD_REPORT_SECTION_ORDER}
          sections={yieldReportSections}
          layoutEpoch={layoutEpoch}
        />
    </div>
  );
}
