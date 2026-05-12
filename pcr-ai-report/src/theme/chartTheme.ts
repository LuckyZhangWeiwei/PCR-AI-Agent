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
