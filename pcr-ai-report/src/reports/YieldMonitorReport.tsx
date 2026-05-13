import { useCallback, useMemo, useState } from "react";
import { apiGetJson } from "../api/client";
import { API_PREFIX } from "../api/paths";
import type {
  YieldMonitorResponse,
  YieldMonitorV3AggregateResponse,
} from "../api/types";
import { DarkChart } from "../components/DarkChart";
import { DataTable } from "../components/DataTable";
import {
  baseChartOption,
  chartAccent,
  chartAccent2,
  chartAccent3,
  chartAxisColor,
  chartSplitLine,
  chartTextColor,
} from "../theme/chartTheme";
import type { EChartsOption } from "echarts";
import { datetimeLocalToIso } from "../utils/datetimeLocal";
import {
  isYieldMonitorTypeExcludedFromCharts,
  tallyColumn,
} from "../utils/rollup";

const TRIGGER_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "delta_diff", label: "delta_diff" },
  { value: "Consebin", label: "Consebin" },
  { value: "low_yield", label: "low_yield" },
  { value: "ConseFail", label: "ConseFail" },
];

const PASS_ID_OPTIONS = ["1", "3", "5"] as const;

type Props = {
  apiBase: string;
};

type FormState = {
  hostname: string;
  device: string;
  lotId: string;
  wafer: string;
  type: string;
  probeCard: string;
  pass: string;
  timeStampFrom: string;
  timeStampTo: string;
  /** v3 列表 limit 1…500 */
  limit: string;
  /** v3 聚合 dimensions（逗号分隔，见 manifest：type,device,hostname,…） */
  aggDimensions: string;
  aggGroupTop: string;
};

const initialForm: FormState = {
  hostname: "",
  device: "",
  lotId: "",
  wafer: "",
  type: "",
  probeCard: "",
  pass: "",
  timeStampFrom: "",
  timeStampTo: "",
  limit: "200",
  aggDimensions: "type,device",
  aggGroupTop: "20",
};

const AGG_DIM_PRESETS: { label: string; value: string }[] = [
  { label: "类型 + 设备", value: "type,device" },
  { label: "机台 + 类型", value: "hostname,type" },
  { label: "Lot + Wafer", value: "lotId,wafer" },
  { label: "探针卡 + 设备", value: "probeCard,device" },
  { label: "按日 + 类型", value: "timeDay,type" },
  { label: "按小时 + 设备", value: "timeHour,device" },
];

function buildV3ListParams(
  f: FormState
): Record<string, string | number | boolean | undefined> {
  const num = (s: string) => {
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  };
  const limRaw = num(f.limit);
  const limit =
    limRaw !== undefined
      ? Math.min(500, Math.max(1, Math.floor(limRaw)))
      : undefined;
  return {
    hostname: f.hostname || undefined,
    device: f.device || undefined,
    lotId: f.lotId || undefined,
    wafer: f.wafer || undefined,
    type: f.type || undefined,
    probeCard: f.probeCard || undefined,
    pass: f.pass ? num(f.pass) : undefined,
    timeStampFrom: datetimeLocalToIso(f.timeStampFrom),
    timeStampTo: datetimeLocalToIso(f.timeStampTo),
    limit,
  };
}

function buildYieldAggParams(
  f: FormState
): Record<string, string | number | boolean | undefined> {
  const gt = Number(f.aggGroupTop);
  const groupTop = Number.isFinite(gt)
    ? Math.min(100, Math.max(1, Math.floor(gt)))
    : 20;
  return {
    ...buildV3ListParams(f),
    dimensions: f.aggDimensions.trim() || "type,device",
    groupTop,
  };
}

const ROW_COLUMNS_PREF = [
  "TIME_STAMP",
  "HOSTNAME",
  "DEVICE",
  "LOTID",
  "WAFER",
  "TYPE",
  "TRIGGER_LABEL",
  "PASS",
  "PROBECARD",
];

const ROLLUP_DIMENSIONS = [
  { value: "DEVICE", label: "Device" },
  { value: "HOSTNAME", label: "机台名" },
  { value: "LOTID", label: "LotID" },
  { value: "WAFER", label: "Slot" },
  { value: "TYPE", label: "触发类型" },
  { value: "PROBECARD", label: "探针卡" },
  { value: "PASS", label: "PassID" },
] as const;

/**
 * 当接口未返回 hostnameSummary（旧版后端）或为空时，用本页明细行的 HOSTNAME 聚合，
 * 与探针卡全量汇总并存时，标题会标明「本页」以免误解。
 */
function hostnameSummaryFromPageRows(
  rows: Record<string, unknown>[]
): { hostname: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const raw = r.HOSTNAME ?? r.hostname;
    const k =
      raw === null || raw === undefined || String(raw).trim() === ""
        ? ""
        : String(raw).trim();
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([hostname, count]) => ({ hostname, count }));
}

/** v3 列表无全量 PROBECARD 汇总时，用本页行聚合（与 hostname 兜底一致）。 */
function probeCardSummaryFromPageRows(
  rows: Record<string, unknown>[]
): { probeCard: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const raw = r.PROBECARD ?? r.probecard ?? r.ProbeCard;
    const k =
      raw === null || raw === undefined || String(raw).trim() === ""
        ? ""
        : String(raw).trim();
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([probeCard, count]) => ({ probeCard, count }));
}

/** Oracle / JSON 可能返回 ISO 字符串或毫秒级时间戳 */
function parseYieldMonitorTimeMs(ts: unknown): number {
  if (ts == null || ts === "") return NaN;
  if (typeof ts === "number" && Number.isFinite(ts)) {
    if (ts > 1e12) return ts;
    if (ts > 1e9) return ts * 1000;
    return NaN;
  }
  const s = String(ts).trim();
  const fromIso = Date.parse(s);
  if (Number.isFinite(fromIso)) return fromIso;
  return NaN;
}

export function YieldMonitorReport({ apiBase }: Props) {
  const [form, setForm] = useState<FormState>(initialForm);
  const [rollupDim, setRollupDim] = useState<string>("DEVICE");
  const [data, setData] = useState<YieldMonitorResponse | null>(null);
  const [aggData, setAggData] = useState<YieldMonitorV3AggregateResponse | null>(
    null
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aggError, setAggError] = useState<string | null>(null);

  const runSearch = useCallback(async () => {
    setLoading(true);
    setError(null);
    setAggError(null);
    setAggData(null);
    try {
      const listRes = await apiGetJson<YieldMonitorResponse>(
        apiBase,
        `${API_PREFIX}/yield-monitor-triggers/v3`,
        buildV3ListParams(form)
      );
      setData(listRes);
    } catch (e: unknown) {
      setData(null);
      setError(e instanceof Error ? e.message : String(e));
      setLoading(false);
      return;
    }
    try {
      const aggRes = await apiGetJson<YieldMonitorV3AggregateResponse>(
        apiBase,
        `${API_PREFIX}/yield-monitor-triggers/v3/aggregate`,
        buildYieldAggParams(form)
      );
      setAggData(aggRes);
    } catch (e: unknown) {
      setAggData(null);
      setAggError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [apiBase, form]);

  const probeChartSource = useMemo((): {
    summary: { probeCard: string; count: number }[];
    scope: "full" | "page";
  } | null => {
    const api = data?.probeCardSummary;
    if (api && api.length > 0) {
      return { summary: api, scope: "full" };
    }
    const pageRows = data?.rows ?? [];
    if (!pageRows.length) return null;
    const fromPage = probeCardSummaryFromPageRows(pageRows);
    return fromPage.length > 0
      ? { summary: fromPage, scope: "page" }
      : null;
  }, [data]);

  const probeChartOption = useMemo((): EChartsOption | null => {
    const src = probeChartSource;
    if (!src?.summary.length) return null;
    const sorted = [...src.summary].sort((a, b) => a.count - b.count);
    const labels = sorted.map((s) => s.probeCard || "（空）");
    const values = sorted.map((s) => s.count);
    const base = baseChartOption();
    const gridTop = src.scope === "page" ? 112 : 76;
    return {
      ...base,
      grid: {
        ...(base.grid as object),
        top: gridTop,
      },
      title: {
        text: "探针卡（PROBECARD）出现次数",
        subtext:
          src.scope === "full"
            ? "符合筛选条件的全量匹配行（与列表条数上限无关）"
            : `基于本页至多 ${data?.limit ?? ""} 条明细；全量分布请使用下方「维度聚合」或调大 limit`,
        left: 0,
        top: 4,
        textStyle: { color: chartTextColor, fontSize: 14, fontWeight: 600 },
        subtextStyle: {
          color: chartAxisColor,
          fontSize: 11,
          lineHeight: 16,
        },
      },
      xAxis: {
        type: "value",
        axisLabel: { color: chartAxisColor },
        splitLine: { lineStyle: { color: chartSplitLine } },
      },
      yAxis: {
        type: "category",
        data: labels,
        axisLabel: { color: chartAxisColor, width: 120, overflow: "truncate" },
      },
      series: [
        {
          type: "bar",
          data: values,
          itemStyle: {
            color: {
              type: "linear",
              x: 0,
              y: 0,
              x2: 1,
              y2: 0,
              colorStops: [
                { offset: 0, color: chartAccent },
                { offset: 1, color: chartAccent2 },
              ],
            },
          },
        },
      ],
    };
  }, [data?.limit, probeChartSource]);

  /** 优先用工接口 hostnameSummary（v1）；v3 列表通常无此项，则用本页 rows 兜底 */
  const hostnameChartSource = useMemo((): {
    summary: { hostname: string; count: number }[];
    scope: "full" | "page";
  } | null => {
    const api = data?.hostnameSummary;
    if (api && api.length > 0) {
      return { summary: api, scope: "full" };
    }
    const pageRows = data?.rows ?? [];
    if (!pageRows.length) return null;
    const fromPage = hostnameSummaryFromPageRows(pageRows);
    return fromPage.length > 0
      ? { summary: fromPage, scope: "page" }
      : null;
  }, [data]);

  const hostnameChartOption = useMemo((): EChartsOption | null => {
    const src = hostnameChartSource;
    if (!src?.summary.length) return null;
    const sorted = [...src.summary].sort((a, b) => a.count - b.count);
    const labels = sorted.map((s) => s.hostname || "（空）");
    const values = sorted.map((s) => s.count);
    const base = baseChartOption();
    /** 标题 + 副标题占位较高，避免与坐标系重叠（默认 grid.top 仅 40） */
    const gridTop = src.scope === "page" ? 112 : 76;
    return {
      ...base,
      grid: {
        ...(base.grid as object),
        top: gridTop,
      },
      title: {
        text: "机台（HOSTNAME）出现次数",
        subtext:
          src.scope === "full"
            ? "符合您筛选条件的全部记录"
            : `基于本页至多 ${data?.limit ?? ""} 条明细；全量机台分布请使用下方「维度聚合」（如 hostname,type）`,
        left: 0,
        top: 4,
        textStyle: { color: chartTextColor, fontSize: 14, fontWeight: 600 },
        subtextStyle: {
          color: chartAxisColor,
          fontSize: 11,
          lineHeight: 16,
        },
      },
      xAxis: {
        type: "value",
        axisLabel: { color: chartAxisColor },
        splitLine: { lineStyle: { color: chartSplitLine } },
      },
      yAxis: {
        type: "category",
        data: labels,
        axisLabel: { color: chartAxisColor, width: 140, overflow: "truncate" },
      },
      series: [
        {
          type: "bar",
          data: values,
          itemStyle: {
            color: {
              type: "linear",
              x: 0,
              y: 0,
              x2: 1,
              y2: 0,
              colorStops: [
                { offset: 0, color: chartAccent3 },
                { offset: 1, color: chartAccent },
              ],
            },
          },
        },
      ],
    };
  }, [data?.limit, hostnameChartSource]);

  const typeMixOption = useMemo((): EChartsOption | null => {
    const rows = data?.rows ?? [];
    if (!rows.length) return null;
    const tally = new Map<string, number>();
    for (const r of rows) {
      const t = r.TYPE ?? r.type;
      if (isYieldMonitorTypeExcludedFromCharts(t)) continue;
      const key =
        t === null || t === undefined || t === ""
          ? "（空）"
          : String(t);
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
    if (!tally.size) return null;
    const pairs = [...tally.entries()].sort((a, b) => b[1] - a[1]);
    return {
      ...baseChartOption(),
      title: {
        text: "触发类型分布（本页表格里的记录）",
        left: 0,
        textStyle: { color: chartTextColor, fontSize: 14, fontWeight: 600 },
      },
      xAxis: {
        type: "category",
        data: pairs.map(([k]) => k),
        axisLabel: {
          color: chartAxisColor,
          rotate: pairs.length > 8 ? 35 : 0,
        },
      },
      yAxis: {
        type: "value",
        axisLabel: { color: chartAxisColor },
        splitLine: { lineStyle: { color: chartSplitLine } },
      },
      series: [
        {
          type: "bar",
          data: pairs.map(([, v]) => v),
          itemStyle: {
            color: chartAccent3,
            borderRadius: [6, 6, 0, 0],
          },
        },
      ],
    };
  }, [data]);

  const rollupByDimOption = useMemo((): EChartsOption | null => {
    const rows = data?.rows ?? [];
    if (!rows.length) return null;
    const rowsForRollup =
      rollupDim === "TYPE"
        ? rows.filter(
            (r) =>
              !isYieldMonitorTypeExcludedFromCharts(r.TYPE ?? r.type)
          )
        : rows;
    const pairs = tallyColumn(rowsForRollup, rollupDim, 30);
    if (!pairs.length) return null;
    const sorted = [...pairs].sort((a, b) => a[1] - b[1]);
    return {
      ...baseChartOption(),
      title: {
        text: `按「${ROLLUP_DIMENSIONS.find((d) => d.value === rollupDim)?.label ?? rollupDim}」计数（本页最多 ${data?.limit ?? "—"} 条）`,
        left: 0,
        textStyle: { color: chartTextColor, fontSize: 14, fontWeight: 600 },
      },
      xAxis: {
        type: "value",
        axisLabel: { color: chartAxisColor },
        splitLine: { lineStyle: { color: chartSplitLine } },
      },
      yAxis: {
        type: "category",
        data: sorted.map(([k]) =>
          k.length > 40 ? `${k.slice(0, 40)}…` : k
        ),
        axisLabel: { color: chartAxisColor, width: 160, overflow: "truncate" },
      },
      series: [
        {
          type: "bar",
          data: sorted.map(([, n]) => n),
          itemStyle: {
            color: {
              type: "linear",
              x: 0,
              y: 0,
              x2: 1,
              y2: 0,
              colorStops: [
                { offset: 0, color: chartAccent2 },
                { offset: 1, color: chartAccent3 },
              ],
            },
          },
        },
      ],
    };
  }, [data, rollupDim]);

  const yieldAggChartOption = useMemo((): EChartsOption | null => {
    if (!aggData?.groups?.length) return null;
    const ad = aggData;
    const groups = ad.groups;
    const sorted = [...groups].sort((a, b) => a.count - b.count);
    const labels = sorted.map((g) =>
      g.key.length > 52 ? `${g.key.slice(0, 52)}…` : g.key
    );
    const values = sorted.map((g) => g.count);
    const dims = (ad.dimensions ?? []).join(", ");
    const base = baseChartOption();
    return {
      ...base,
      grid: { ...(base.grid as object), top: 108 },
      title: {
        text: "v3 维度聚合（全量匹配行）",
        subtext: `维度：${dims} · 匹配总行数 ${ad.totalRowsMatching ?? "—"} · 展示组数 ${sorted.length}`,
        left: 0,
        top: 4,
        textStyle: { color: chartTextColor, fontSize: 14, fontWeight: 600 },
        subtextStyle: {
          color: chartAxisColor,
          fontSize: 11,
          lineHeight: 16,
        },
      },
      xAxis: {
        type: "value",
        axisLabel: { color: chartAxisColor },
        splitLine: { lineStyle: { color: chartSplitLine } },
      },
      yAxis: {
        type: "category",
        data: labels,
        axisLabel: { color: chartAxisColor, width: 200, overflow: "truncate" },
      },
      series: [
        {
          type: "bar",
          data: values,
          itemStyle: {
            color: {
              type: "linear",
              x: 0,
              y: 0,
              x2: 1,
              y2: 0,
              colorStops: [
                { offset: 0, color: chartAccent2 },
                { offset: 1, color: chartAccent },
              ],
            },
          },
        },
      ],
    };
  }, [aggData]);

  const aggTableRows = useMemo((): Record<string, unknown>[] => {
    if (!aggData?.groups?.length) return [];
    return aggData.groups.map((g) => ({
      compositeKey: g.key,
      count: g.count,
      ...g.parts,
    }));
  }, [aggData]);

  const timelineChart = useMemo((): {
    option: EChartsOption | null;
    placeholder: string | null;
  } => {
    const rows = data?.rows ?? [];
    if (!rows.length) return { option: null, placeholder: null };
    const points = rows
      .map((r) => {
        const ts = r.TIME_STAMP ?? r.time_stamp;
        const ms = parseYieldMonitorTimeMs(ts);
        return { ms };
      })
      .filter((p) => Number.isFinite(p.ms))
      .sort((a, b) => a.ms - b.ms);
    if (!points.length) {
      return {
        option: null,
        placeholder:
          "本页记录的 TIME_STAMP 无法解析为时间，无法绘制先后图；请检查接口字段格式。",
      };
    }
    const distinctTimes = new Set(points.map((p) => p.ms)).size;
    if (distinctTimes < 2) {
      return {
        option: null,
        placeholder:
          "本页内触发时间相同（或有效时间仅一种），折线只会是水平线，故不展示该图；请看明细表 TIME_STAMP 列或缩小筛选使时间更分散。",
      };
    }
    const minT = points[0].ms;
    const maxT = points[points.length - 1].ms;
    const span = maxT - minT;
    const pad = Math.max(60_000, span * 0.08);
    const labels = points.map((_, i) => String(i + 1));

    const fmtTime = (ms: number) => {
      const d = new Date(ms);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    };

    return {
      option: {
        ...baseChartOption(),
        grid: {
          left: 96,
          right: 32,
          top: 56,
          bottom: 56,
          containLabel: true,
        },
        title: {
          text: "触发时间先后",
          subtext: "横轴：本页按时间排序后的第几条 · 纵轴：触发时刻",
          left: 0,
          top: 4,
          textStyle: { color: chartTextColor, fontSize: 14, fontWeight: 600 },
          subtextStyle: {
            color: chartAxisColor,
            fontSize: 11,
            lineHeight: 16,
          },
        },
        xAxis: {
          type: "category",
          data: labels,
          name: "序号",
          nameLocation: "middle",
          nameGap: 36,
          nameTextStyle: { color: chartAxisColor, fontSize: 11 },
          axisLabel: {
            color: chartAxisColor,
            interval: Math.max(0, Math.floor(points.length / 14)),
          },
        },
        yAxis: {
          type: "value",
          min: minT - pad,
          max: maxT + pad,
          axisLabel: {
            color: chartAxisColor,
            formatter: (v: number) => fmtTime(v),
            width: 118,
            overflow: "truncate",
          },
          splitLine: { lineStyle: { color: chartSplitLine } },
        },
        series: [
          {
            type: "line",
            smooth: true,
            showSymbol: points.length <= 48,
            symbolSize: 6,
            data: points.map((p) => p.ms),
            lineStyle: { width: 2, color: chartAccent },
            emphasis: {
              focus: "series",
              itemStyle: { borderWidth: 2, borderColor: chartTextColor },
            },
            areaStyle: {
              color: {
                type: "linear",
                x: 0,
                y: 0,
                x2: 0,
                y2: 1,
                colorStops: [
                  { offset: 0, color: "rgba(88, 166, 255, 0.35)" },
                  { offset: 1, color: "rgba(88, 166, 255, 0.02)" },
                ],
              },
            },
          },
        ],
        tooltip: {
          ...(baseChartOption().tooltip as object),
          trigger: "axis",
          axisPointer: {
            type: "cross",
            crossStyle: { color: chartAccent },
            label: {
              backgroundColor: "rgba(22, 27, 34, 0.92)",
            },
          },
          formatter: (params: unknown) => {
            const arr = Array.isArray(params) ? params : [params];
            const item = arr[0] as {
              dataIndex?: number;
              value?: number | string | (number | string)[];
            };
            const idx =
              typeof item?.dataIndex === "number" ? item.dataIndex + 1 : 1;
            const v = item?.value;
            let ms: number | undefined;
            if (typeof v === "number") ms = v;
            else if (Array.isArray(v)) {
              const last = v[v.length - 1];
              if (typeof last === "number") ms = last;
            }
            if (ms === undefined || !Number.isFinite(ms)) return "";
            return `<div style="padding:4px 6px;line-height:1.5"><strong>第 ${idx} 条</strong><br/>${fmtTime(ms)}</div>`;
          },
          extraCssText: "max-width:280px;white-space:normal;",
        },
      },
      placeholder: null,
    };
  }, [data]);

  return (
    <section className="report-panel">
      <header className="report-panel-header">
        <div>
          <h2>yield monitor（v3）</h2>
          <p className="report-desc">
            数据来自 <code>{API_PREFIX}/yield-monitor-triggers/v3</code>
            与 <code>…/v3/aggregate</code>。列表按时间倒序，最多{" "}
            <strong>500</strong> 条（可在下方设置）；探针卡 / 机台条形图默认基于<strong>本页</strong>行聚合，全量匹配行请看「维度聚合」图表与表格。
            v3 列表<strong>不支持</strong>按 TRIGGER_LABEL 筛选，该维度仅用于聚合。
          </p>
        </div>
        <div className="report-actions">
          <button
            type="button"
            className="btn primary"
            onClick={runSearch}
            disabled={loading}
          >
            {loading ? "查询中…" : "查询"}
          </button>
        </div>
      </header>

      <div className="filter-grid filter-grid--yield">
        <label>
          <span>机台名</span>
          <input
            value={form.hostname}
            onChange={(e) =>
              setForm((s) => ({ ...s, hostname: e.target.value }))
            }
          />
        </label>
        <label>
          <span>Device</span>
          <input
            value={form.device}
            onChange={(e) => setForm((s) => ({ ...s, device: e.target.value }))}
          />
        </label>
        <label>
          <span>LotID</span>
          <input
            value={form.lotId}
            onChange={(e) => setForm((s) => ({ ...s, lotId: e.target.value }))}
          />
        </label>
        <label>
          <span>Slot</span>
          <input
            value={form.wafer}
            onChange={(e) => setForm((s) => ({ ...s, wafer: e.target.value }))}
          />
        </label>
        <label>
          <span>触发类型</span>
          <select
            value={form.type}
            onChange={(e) =>
              setForm((s) => ({ ...s, type: e.target.value }))
            }
            className="select-input"
          >
            <option value="">全部</option>
            {TRIGGER_TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <p className="field-hint span-2 muted small">
          v3 列表不按 TRIGGER_LABEL 筛选；若需按触发说明统计，请在下方「维度聚合」的 dimensions 中加入{" "}
          <code>triggerLabel</code>（与 <code>timeDay</code> / <code>timeHour</code> 等组合时勿超过接口上限）。
        </p>
        <label>
          <span>PROBECARD</span>
          <input
            value={form.probeCard}
            onChange={(e) =>
              setForm((s) => ({ ...s, probeCard: e.target.value }))
            }
          />
        </label>
        <label>
          <span>PassID</span>
          <select
            value={form.pass}
            onChange={(e) =>
              setForm((s) => ({ ...s, pass: e.target.value }))
            }
            className="select-input"
          >
            <option value="">全部</option>
            {PASS_ID_OPTIONS.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>列表条数上限（1–500）</span>
          <input
            type="number"
            min={1}
            max={500}
            value={form.limit}
            onChange={(e) =>
              setForm((s) => ({ ...s, limit: e.target.value }))
            }
          />
        </label>
        <label className="span-2">
          <span>维度聚合 preset</span>
          <select
            className="select-input"
            aria-label="维度聚合快捷模板"
            value=""
            onChange={(e) => {
              const v = e.target.value;
              if (v)
                setForm((s) => ({ ...s, aggDimensions: v }));
              e.target.value = "";
            }}
          >
            <option value="">选择模板填入 dimensions…</option>
            {AGG_DIM_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}（{p.value}）
              </option>
            ))}
          </select>
        </label>
        <label className="span-2">
          <span>维度聚合 dimensions（逗号分隔）</span>
          <span className="field-hint">
            例如 type,device 或 hostname,type；最多 5 维；timeDay 与 timeHour 勿同用。
          </span>
          <input
            value={form.aggDimensions}
            onChange={(e) =>
              setForm((s) => ({ ...s, aggDimensions: e.target.value }))
            }
            spellCheck={false}
            placeholder="type,device"
          />
        </label>
        <label>
          <span>聚合 Top 组数（1–100）</span>
          <input
            type="number"
            min={1}
            max={100}
            value={form.aggGroupTop}
            onChange={(e) =>
              setForm((s) => ({ ...s, aggGroupTop: e.target.value }))
            }
          />
        </label>
        <label className="span-2">
          <span>起始时间</span>
          <span className="field-hint">点选日期与时间；用于限定「从何时起」的记录。</span>
          <input
            type="datetime-local"
            step={1}
            value={form.timeStampFrom}
            onChange={(e) =>
              setForm((s) => ({ ...s, timeStampFrom: e.target.value }))
            }
          />
        </label>
        <label className="span-2">
          <span>结束时间</span>
          <span className="field-hint">可与「起始时间」一起缩小查找范围。</span>
          <input
            type="datetime-local"
            step={1}
            value={form.timeStampTo}
            onChange={(e) =>
              setForm((s) => ({ ...s, timeStampTo: e.target.value }))
            }
          />
        </label>
      </div>

      {error ? <div className="alert error">{error}</div> : null}
      {aggError ? (
        <div className="alert error">
          维度聚合请求失败（列表结果仍可能已显示）：{aggError}
        </div>
      ) : null}

      {data ? (
        <div className="report-meta">
          <span>
            本页共 <strong>{data.count}</strong> 条（本次 limit={data.limit}
            {data.limitMax != null ? `，接口上限 ${data.limitMax}` : ""}）
          </span>
          <span className="muted small">排序：{data.orderBy}</span>
        </div>
      ) : null}

      <div className="chart-grid">
        {probeChartOption ? (
          <div className="card chart-card">
            <DarkChart option={probeChartOption} height={380} />
          </div>
        ) : (
          <div className="card chart-placeholder subtle">
            <p>
              查询后若有 PROBECARD 列数据，此处显示分布图（v3 默认按本页行聚合；全量请看维度聚合）。
            </p>
          </div>
        )}
        {hostnameChartOption ? (
          <div className="card chart-card">
            <DarkChart option={hostnameChartOption} height={380} />
          </div>
        ) : (
          <div className="card chart-placeholder subtle">
            <p>
              查询后若明细含 HOSTNAME，此处显示机台图（v3 默认按本页行聚合；全量请看维度聚合）。
            </p>
          </div>
        )}
        {typeMixOption ? (
          <div className="card chart-card">
            <DarkChart option={typeMixOption} height={380} />
          </div>
        ) : null}
        <div className="filter-grid rollup-dim-bar span-2 chart-grid-rollup-toolbar">
          <label>
            <span>本页数据按哪一列汇总（条形图）</span>
            <select
              value={rollupDim}
              onChange={(e) => setRollupDim(e.target.value)}
              className="select-input"
            >
              {ROLLUP_DIMENSIONS.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {rollupByDimOption ? (
          <div className="card chart-card span-2">
            <DarkChart option={rollupByDimOption} height={400} />
          </div>
        ) : null}
        {yieldAggChartOption ? (
          <div className="card chart-card span-2">
            <DarkChart option={yieldAggChartOption} height={420} />
          </div>
        ) : null}
        {aggTableRows.length ? (
          <div className="card span-2">
            <h3 className="card-title">维度聚合结果（Top 组）</h3>
            {aggData?.documentation ? (
              <p className="muted small" style={{ marginBottom: "0.75rem" }}>
                {aggData.documentation}
              </p>
            ) : null}
            <DataTable
              rows={aggTableRows}
              columnOrder={["compositeKey", "count"]}
            />
          </div>
        ) : null}
        {timelineChart.option ? (
          <div className="card chart-card span-2">
            <DarkChart option={timelineChart.option} height={420} />
          </div>
        ) : timelineChart.placeholder ? (
          <div className="card chart-placeholder subtle span-2">
            <p>
              <strong>触发时间先后</strong>：{timelineChart.placeholder}
            </p>
          </div>
        ) : null}
      </div>

      {data?.rows?.length ? (
        <div className="card">
          <h3 className="card-title">明细表</h3>
          <DataTable
            rows={data.rows}
            columnOrder={ROW_COLUMNS_PREF}
            omitKeys={["ID", "id"]}
          />
        </div>
      ) : null}
    </section>
  );
}
