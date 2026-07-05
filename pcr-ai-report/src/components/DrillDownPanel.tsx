import type { EChartsOption } from "echarts";
import type { ReactNode } from "react";
import { DarkChart } from "./DarkChart";
import { formatChartDayLabel } from "../utils/datetimeLocal";
import {
  drillBarChartHeight,
  horizontalBarCategoryAxisLabel,
  horizontalBarChartBase,
  getChartPalette,
  selectionTierColors,
  type BarChartHeightVariant,
} from "../theme/chartTheme";
import { useThemeContext } from "../theme/ThemeContext";
import type { AggregateGroup } from "../api/types";

type SubDimOption = { label: string; value: string };

type Props = {
  /** e.g. "LOT: DR390" */
  title: string;
  groups: AggregateGroup[];
  loading: boolean;
  error?: string | null;
  /** Current active sub-dimension value (for the toggle buttons) */
  activeSubDim: string;
  subDimOptions: SubDimOption[];
  onSubDimChange: (dim: string) => void;
  onClose: () => void;
  /** Called when user clicks a bar — key is the group's key string */
  onBarClick?: (key: string) => void;
  /** Toggle bar in multi-select mode */
  onBarToggle?: (key: string) => void;
  /** Highlight this key as selected (deepened color) */
  selectedKey?: string | null;
  /** Multi-select bar keys (checkbox-style toggle on click) */
  selectedKeys?: ReadonlySet<string> | null;
  multiSelect?: boolean;
  /** Side-by-side with parent chart (right column) vs stacked below */
  layout?: "below" | "side";
  /** Rendered at the bottom of this panel (e.g. DUT distribution after picking a probe card) */
  footer?: ReactNode;
  /** Slightly shorter bar chart (e.g. free-dimension drill column) */
  compact?: boolean;
  /** Bar height tier; `compact` prop overrides this when true */
  chartSize?: BarChartHeightVariant;
  /** When true, clicking the chart is a real drill action — suppresses the prohibition cursor */
  interactive?: boolean;
};

/** Convert a parts map into a human-readable label, e.g. "Type 7744 · Bin 2" */
export function formatGroupLabel(parts: Record<string, string>): string {
  const entries = Object.entries(parts);
  if (entries.length === 0) return "";
  return entries
    .map(([dim, val]) => {
      switch (dim) {
        case "bin":           return `Bin ${val}`;
        case "probeCardType": return `Type ${val}`;
        case "slot":          return `Slot ${val}`;
        case "lot":
        case "lotId":         return `LOT ${val}`;
        case "passId":
        case "pass":          return `Pass ${val}`;
        case "testerId":      return `Tester ${val}`;
        case "meslot":        return `MES ${val}`;
        case "timeDay":       return formatChartDayLabel(val);
        default:              return val;
      }
    })
    .join(" · ");
}

export function DrillDownPanel({
  title,
  groups,
  loading,
  error,
  activeSubDim,
  subDimOptions,
  onSubDimChange,
  onClose,
  onBarClick,
  onBarToggle,
  selectedKey,
  selectedKeys,
  multiSelect = false,
  layout = "below",
  footer,
  compact = false,
  chartSize = "default",
  interactive = false,
}: Props) {
  const { theme } = useThemeContext();
  const chartPalette = getChartPalette(theme);
  const { base: COL_PANEL, bright: COL_PANEL_B, dim: COL_PANEL_D } = selectionTierColors(theme, "blue-deep");
  const barHeightVariant: BarChartHeightVariant = compact ? "compact" : chartSize;
  const sorted = [...groups].sort((a, b) => a.count - b.count).slice(-10);

  const labels = sorted.map((g) => {
    const formatted = formatGroupLabel(g.parts);
    return formatted || g.key;
  });

  const option: EChartsOption = {
    ...horizontalBarChartBase(theme),
    xAxis: {
      type: "value",
      axisLabel: { color: chartPalette.axisColor, fontSize: 11 },
      splitLine: { lineStyle: { color: chartPalette.splitLine } },
    },
    yAxis: {
      type: "category",
      data: labels,
      axisLabel: { ...horizontalBarCategoryAxisLabel, interval: 0, color: chartPalette.axisColor },
    },
    series: [
      {
        type: "bar",
        data: sorted.map((g) => {
          const picked = multiSelect
            ? selectedKeys?.has(g.key) === true
            : g.key === selectedKey;
          const anyPicked = multiSelect
            ? (selectedKeys?.size ?? 0) > 0
            : selectedKey != null;
          return {
            value: g.count,
            itemStyle: {
              color: picked
                ? COL_PANEL_B
                : anyPicked
                ? COL_PANEL_D
                : COL_PANEL,
              borderRadius: [0, 4, 4, 0],
            },
          };
        }),
        label: {
          show: true,
          position: "right",
          color: chartPalette.axisColor,
          fontSize: 10,
        },
      },
    ],
  };

  return (
    <div
      className={layout === "side" ? "chart-drill-panel chart-drill-panel--side" : undefined}
      style={{
        border: "1px solid rgba(var(--accent-rgb),0.45)",
        borderRadius: 8,
        background: "var(--surface-2)",
        padding: layout === "side" ? 8 : 12,
        marginTop: layout === "side" ? 0 : 8,
        minWidth: 0,
        maxWidth: "100%",
        overflowX: "clip",
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: layout === "side" ? 6 : 8,
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <span style={{ fontSize: 12, color: "var(--accent)", fontWeight: 600 }}>
          ↳ {title}
          {multiSelect && (selectedKeys?.size ?? 0) > 0 ? (
            <span style={{ marginLeft: 8, color: "var(--muted)", fontWeight: 400 }}>
              已选 {selectedKeys!.size} 项
            </span>
          ) : null}
        </span>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {subDimOptions.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className="chip"
              style={
                opt.value === activeSubDim
                  ? {
                      background: "rgba(var(--accent-rgb),0.2)",
                      borderColor: "var(--accent)",
                      color: "var(--accent)",
                    }
                  : undefined
              }
              onClick={() => onSubDimChange(opt.value)}
            >
              {opt.label}
            </button>
          ))}
          <button
            type="button"
            className="chip"
            style={{ color: "var(--red-text)", borderColor: "rgba(var(--red-rgb),0.3)" }}
            onClick={onClose}
          >
            ✕ 关闭
          </button>
        </div>
      </div>

      {!loading && error && (
        <div style={{ color: "var(--red-text)", fontSize: 12, padding: "8px 0" }}>
          {error}
        </div>
      )}
      {loading ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            height:
              barHeightVariant === "compact" ? 96 : barHeightVariant === "medium" ? 108 : 120,
            color: "var(--muted)",
            fontSize: 13,
            background: "rgba(var(--fg-rgb),0.03)",
            borderRadius: 4,
          }}
        >
          加载中…
        </div>
      ) : !error && groups.length === 0 ? (
        <div style={{ color: "var(--muted)", fontSize: 13, padding: "8px 0" }}>
          暂无数据
        </div>
      ) : !error && groups.length > 0 ? (
        <div className={`chart-drill-panel-chart${interactive ? "" : " chart-no-drill"}`}>
          <DarkChart
            option={option}
            height={drillBarChartHeight(sorted.length, 10, barHeightVariant)}
            onEvents={
              multiSelect && onBarToggle
                ? {
                    click: (p: unknown) => {
                      const idx = (p as { dataIndex?: number }).dataIndex;
                      if (idx == null || idx < 0 || idx >= sorted.length) return;
                      onBarToggle(sorted[idx]!.key);
                    },
                  }
                : onBarClick
                ? {
                    click: (p: unknown) => {
                      const idx = (p as { dataIndex?: number }).dataIndex;
                      if (idx == null || idx < 0 || idx >= sorted.length) return;
                      onBarClick(sorted[idx]!.key);
                    },
                  }
                : undefined
            }
          />
        </div>
      ) : null}
      {footer ? <div className="chart-drill-panel-footer">{footer}</div> : null}
    </div>
  );
}
