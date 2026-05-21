/** Shared ECharts styling for dark UI (see https://echarts.apache.org/handbook/zh/get-started/) */
export const chartAxisColor = "#8b949e";
export const chartTextColor = "#e6edf3";
export const chartSplitLine = "rgba(240, 246, 252, 0.06)";
export const chartAccent = "#58a6ff";
export const chartAccent2 = "#a371f7";
export const chartAccent3 = "#3fb950";

export function baseChartOption(): Record<string, unknown> {
  return {
    backgroundColor: "transparent",
    textStyle: {
      color: chartTextColor,
      fontFamily:
        'ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif',
    },
    tooltip: {
      backgroundColor: "rgba(22, 27, 34, 0.96)",
      borderColor: "rgba(240, 246, 252, 0.12)",
      textStyle: { color: chartTextColor },
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
export function horizontalBarChartBase(): Record<string, unknown> {
  const base = baseChartOption();
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
  color: chartTextColor,
  fontSize: 11,
  width: 96,
  overflow: "truncate" as const,
  ellipsis: "...",
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
