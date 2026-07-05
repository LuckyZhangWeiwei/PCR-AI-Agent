/** Shared ECharts styling — theme-aware (see https://echarts.apache.org/handbook/zh/get-started/) */

export type ChartTheme = "light" | "dark";

type ChartPalette = {
  axisColor: string;
  textColor: string;
  splitLine: string;
  accent: string;
  accent2: string;
  accent3: string;
  /** RGB triplet (no "rgba(" wrapper) for halo/highlight strokes that must contrast with the canvas background */
  haloRgb: string;
};

const CHART_PALETTES: Record<ChartTheme, ChartPalette> = {
  dark: {
    axisColor: "#9aa4ae",
    textColor: "#e6edf3",
    splitLine: "rgba(240, 246, 252, 0.06)",
    accent: "#58a6ff",
    accent2: "#a371f7",
    accent3: "#3fb950",
    haloRgb: "255,255,255",
  },
  light: {
    axisColor: "#454e57",
    textColor: "#1f2328",
    splitLine: "rgba(31, 35, 40, 0.08)",
    accent: "#0969da",
    accent2: "#8250df",
    accent3: "#1a7f37",
    haloRgb: "31,35,40",
  },
};

export function getChartPalette(theme: ChartTheme = "dark"): ChartPalette {
  return CHART_PALETTES[theme];
}

type StatusTier = { border: string; bright: string; glow: string };
type StatusTierColors = { green: StatusTier; yellow: StatusTier; red: StatusTier };

const STATUS_TIERS: Record<ChartTheme, StatusTierColors> = {
  dark: {
    green: { border: "#238636", bright: "#3fb950", glow: "rgba(63,185,80,0.3)" },
    yellow: { border: "#9e6a03", bright: "#d29922", glow: "rgba(210,153,34,0.3)" },
    red: { border: "#da3633", bright: "#ff7b72", glow: "rgba(218,54,51,0.3)" },
  },
  light: {
    green: { border: "#1a7f37", bright: "#2da44e", glow: "rgba(26,127,55,0.22)" },
    yellow: { border: "#9a6700", bright: "#bf8700", glow: "rgba(154,103,0,0.2)" },
    red: { border: "#cf222e", bright: "#e5534b", glow: "rgba(207,34,46,0.2)" },
  },
};

/** Threshold-based (yield%) coloring for ranking charts: default/selected/other-selected-dimmed. */
export function getStatusTierColors(theme: ChartTheme = "dark"): StatusTierColors {
  return STATUS_TIERS[theme];
}

type SelectionTier = { base: string; bright: string; dim: string };
export type SelectionHue = "blue-deep" | "blue-light" | "purple" | "orange" | "gold";

const SELECTION_TIERS: Record<ChartTheme, Record<SelectionHue, SelectionTier>> = {
  dark: {
    "blue-deep": { base: "#58a6ff", bright: "#2080ff", dim: "rgba(88,166,255,0.3)" },
    "blue-light": { base: "#79c0ff", bright: "#58a6ff", dim: "rgba(121,192,255,0.2)" },
    purple: { base: "#a371f7", bright: "#bf8dff", dim: "rgba(163,113,247,0.3)" },
    orange: { base: "#f0883e", bright: "#ff9f60", dim: "rgba(240,136,62,0.3)" },
    gold: { base: "#e6b450", bright: "#ffd070", dim: "rgba(230,180,80,0.3)" },
  },
  light: {
    "blue-deep": { base: "#0969da", bright: "#2f81f7", dim: "rgba(9,105,218,0.25)" },
    "blue-light": { base: "#2f81f7", bright: "#0969da", dim: "rgba(47,129,247,0.18)" },
    purple: { base: "#8250df", bright: "#a371f7", dim: "rgba(130,80,223,0.22)" },
    orange: { base: "#bc4c00", bright: "#d1720f", dim: "rgba(188,76,0,0.2)" },
    gold: { base: "#9a6700", bright: "#bf8700", dim: "rgba(154,103,0,0.2)" },
  },
};

/** Ranking-chart selection highlight: unselected base / selected-bright / other-selected-dimmed. */
export function selectionTierColors(theme: ChartTheme = "dark", hue: SelectionHue): SelectionTier {
  return SELECTION_TIERS[theme][hue];
}

/** Funnel drill-down level dimension keys (mirrors index.css --dim-* custom properties). */
export type FunnelLevelKey = "mask" | "device" | "lot" | "passId" | "slot" | "cardId";

/**
 * Literal hex mirror of index.css's --dim-mask/--dim-device/--dim-lot/--dim-pass/--dim-slot/--dim-card.
 * Needed because canvas 2D (ECharts itemStyle.color) cannot resolve var(...) strings — fillStyle
 * assignments that aren't valid CSS colors are silently ignored. Keep in sync with index.css.
 */
const FUNNEL_LEVEL_HEX: Record<ChartTheme, Record<FunnelLevelKey, string>> = {
  dark: {
    mask: "#79c0ff",
    device: "#d2a8ff",
    lot: "#3fb950",
    passId: "#ff7b72",
    slot: "#e6b450",
    cardId: "#58a6ff",
  },
  light: {
    mask: "#0969da",
    device: "#8250df",
    lot: "#1a7f37",
    passId: "#cf222e",
    slot: "#9a6700",
    cardId: "#0969da",
  },
};

/** Literal hex value for a funnel level's dimension color, for use in canvas contexts (ECharts itemStyle). */
export function funnelLevelHex(theme: ChartTheme, key: FunnelLevelKey): string {
  return FUNNEL_LEVEL_HEX[theme][key];
}

export function baseChartOption(theme: ChartTheme = "dark"): Record<string, unknown> {
  const p = getChartPalette(theme);
  return {
    backgroundColor: "transparent",
    textStyle: {
      color: p.textColor,
      fontFamily:
        'ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif',
    },
    tooltip: {
      backgroundColor: "var(--surface-1)",
      borderColor: "var(--border)",
      textStyle: { color: "var(--text)" },
      /** 避免父级 .chart-card overflow:hidden 裁切悬浮层 */
      appendToBody: true,
      confine: false,
    },
    grid: {
      left: 48,
      right: 24,
      top: 40,
      bottom: 48,
      containLabel: true,
    },
  };
}

/** 横向排名条图：窄列网格里须截断 y 轴类目，否则条形区被挤没只剩「标签+数值」像表格 */
export function horizontalBarChartBase(theme: ChartTheme = "dark"): Record<string, unknown> {
  const base = baseChartOption(theme);
  return {
    ...base,
    grid: {
      left: 8,
      right: 44,
      top: 8,
      bottom: 8,
      containLabel: true,
    },
    tooltip: {
      ...(base.tooltip as Record<string, unknown>),
      trigger: "axis",
      axisPointer: { type: "shadow" },
    },
  };
}

export const horizontalBarCategoryAxisLabel = {
  color: "#e6edf3",
  fontSize: 11,
  width: 96,
  overflow: "truncate" as const,
  ellipsis: "...",
};

/** 较长类目（如 LOT Yield% Top）— 不截断，配合 grid.containLabel 自动留白 */
export const horizontalBarCategoryAxisLabelFull = {
  color: "#e6edf3",
  fontSize: 11,
};

export type BarChartHeightVariant = "default" | "medium" | "compact";

/** 排名条图高度（按可见条数） */
export function rankBarChartHeight(
  rowCount: number,
  maxRows = 20,
  variant: BarChartHeightVariant = "default"
): number {
  const n = Math.min(Math.max(rowCount, 1), maxRows);
  if (variant === "compact") return Math.max(118, n * 15 + 30);
  if (variant === "medium") return Math.max(138, n * 16.5 + 38);
  return Math.max(148, n * 18 + 40);
}

/** 下钻面板内条图 */
export function drillBarChartHeight(
  rowCount: number,
  maxRows = 10,
  variant: BarChartHeightVariant = "default"
): number {
  const n = Math.min(Math.max(rowCount, 1), maxRows);
  if (variant === "compact") return Math.max(108, n * 17 + 28);
  if (variant === "medium") return Math.max(118, n * 18.5 + 32);
  return Math.max(124, n * 20 + 36);
}

/** JB Slot 趋势图固定高度（介于原 240 与紧凑 176 之间） */
export const JB_SLOT_TREND_CHART_HEIGHT = 200;

/** 纵向柱图（如 Slot 趋势）— 较紧的 grid */
export const verticalBarChartGrid = {
  left: 36,
  right: 12,
  top: 10,
  bottom: 28,
  containLabel: true,
};

export const YIELD_TREND_CHART_HEIGHT = 168;

/** 折线趋势图（每日触发量）— 较紧的 grid */
export const yieldTrendChartGrid = {
  left: 40,
  right: 12,
  top: 24,
  bottom: 32,
  containLabel: true,
};
