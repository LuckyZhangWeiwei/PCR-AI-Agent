import type { EChartsOption } from "echarts";
import { DarkChart } from "./DarkChart";
import { formatChartDayLabel } from "../utils/datetimeLocal";
import {
  baseChartOption,
  chartAccent,
  chartAxisColor,
  chartTextColor,
} from "../theme/chartTheme";
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
  /** Highlight this key as selected (deepened color) */
  selectedKey?: string | null;
};

const COL_PANEL = chartAccent;
const COL_PANEL_B = "#2080ff";
const COL_PANEL_D = "rgba(88,166,255,0.3)";

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
  selectedKey,
}: Props) {
  const sorted = [...groups].sort((a, b) => a.count - b.count).slice(-10);

  const labels = sorted.map((g) => {
    const formatted = formatGroupLabel(g.parts);
    return formatted || g.key;
  });

  const option: EChartsOption = {
    ...baseChartOption(),
    xAxis: {
      type: "value",
      axisLabel: { color: chartAxisColor, fontSize: 11 },
      splitLine: { lineStyle: { color: "rgba(240,246,252,0.06)" } },
    },
    yAxis: {
      type: "category",
      data: labels,
      axisLabel: { color: chartTextColor, fontSize: 11, interval: 0 },
    },
    series: [
      {
        type: "bar",
        data: sorted.map((g) => ({
          value: g.count,
          itemStyle: {
            color:
              g.key === selectedKey
                ? COL_PANEL_B
                : selectedKey != null
                ? COL_PANEL_D
                : COL_PANEL,
            borderRadius: [0, 4, 4, 0],
          },
        })),
        label: {
          show: true,
          position: "right",
          color: chartAxisColor,
          fontSize: 10,
        },
      },
    ],
  };

  return (
    <div
      style={{
        border: "1px solid #388bfd",
        borderRadius: 8,
        background: "#0d1929",
        padding: 12,
        marginTop: 8,
      }}
    >
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
          ↳ {title}
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
                      background: "rgba(56,139,253,0.2)",
                      borderColor: "#388bfd",
                      color: "#58a6ff",
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
            style={{ color: "#ff7b72", borderColor: "rgba(248,81,73,0.3)" }}
            onClick={onClose}
          >
            ✕ 关闭
          </button>
        </div>
      </div>

      {loading && (
        <div style={{ color: "#8b949e", fontSize: 12, padding: "8px 0" }}>
          加载中…
        </div>
      )}
      {error && (
        <div style={{ color: "#ff7b72", fontSize: 12, padding: "8px 0" }}>
          {error}
        </div>
      )}
      {!loading && !error && groups.length === 0 && (
        <div style={{ color: "#8b949e", fontSize: 12, padding: "8px 0" }}>
          暂无数据
        </div>
      )}
      {!loading && groups.length > 0 && (
        <DarkChart
          option={option}
          height={Math.max(160, sorted.length * 28 + 60)}
          onEvents={
            onBarClick
              ? { click: (p: unknown) => onBarClick((p as { name: string }).name) }
              : undefined
          }
        />
      )}
    </div>
  );
}
