// pcr-ai-api/src/lib/agent/tools/agentChartTool.ts

import type { ChatMessage } from "../agentHistory.js";
import type { SiteBinPass, SiteBinDutEntry } from "../../outputSiteBinByLot.js";

export interface ChartData {
  labels: string[];
  series: { name: string; values: number[] }[];
}

export interface ChartSentinel {
  __chartOption: object;
}

export interface ClarificationSentinel {
  __clarification: string;
  __clarification_options?: string[];
}

/** Parse JSON array/object strings from GLM arg_value / tool arguments. */
export function tryParseJsonish(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const t = value.trim();
  if (!t || (t[0] !== "{" && t[0] !== "[")) return value;
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return value;
  }
}

function asNumberArray(values: unknown[]): number[] {
  return values.map((v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  });
}

function buildChartDataFromFlat(
  labels: unknown[],
  values: unknown[],
  seriesName: string
): ChartData {
  return {
    labels: labels.map((l) => String(l)),
    series: [{ name: seriesName, values: asNumberArray(values) }],
  };
}

function chartDataFromRecord(d: Record<string, unknown>): ChartData | null {
  let labels = tryParseJsonish(d.labels);
  let values = tryParseJsonish(d.values);
  const series = tryParseJsonish(d.series);

  if (Array.isArray(labels) && Array.isArray(values)) {
    const seriesName =
      typeof d.seriesName === "string" && d.seriesName.trim()
        ? d.seriesName.trim()
        : "占比";
    return buildChartDataFromFlat(labels, values, seriesName);
  }

  if (Array.isArray(labels) && Array.isArray(series) && series.length > 0) {
    const allSeries = series
      .filter((s) => s != null && typeof s === "object" && !Array.isArray(s))
      .map((s) => {
        const s0 = s as Record<string, unknown>;
        const sValues = tryParseJsonish(s0.values);
        if (!Array.isArray(sValues)) return null;
        return { name: String(s0.name ?? "series"), values: asNumberArray(sValues) };
      })
      .filter(Boolean) as { name: string; values: number[] }[];
    if (allSeries.length > 0) {
      return { labels: labels.map((l) => String(l)), series: allSeries };
    }
  }

  return null;
}

/** GLM / some providers pass flat labels+values or JSON strings instead of nested data.series. */
export function normalizeGenerateChartArgs(
  args: Record<string, unknown>
): Record<string, unknown> {
  // Unwrap GLM-style { "arguments": "...JSON..." } wrapping produced by some models.
  const keys = Object.keys(args);
  if (keys.length === 1 && keys[0] === "arguments" && typeof args.arguments === "string") {
    try {
      const inner = JSON.parse(args.arguments) as unknown;
      if (inner && typeof inner === "object" && !Array.isArray(inner)) {
        args = inner as Record<string, unknown>;
      }
    } catch { /* keep original */ }
  }

  const chartType =
    typeof args.chartType === "string" && args.chartType.trim()
      ? args.chartType.trim()
      : "pie";
  const title = args.title;

  let dataRaw = tryParseJsonish(args.data);
  if (dataRaw != null && typeof dataRaw === "object" && !Array.isArray(dataRaw)) {
    const built = chartDataFromRecord(dataRaw as Record<string, unknown>);
    if (built) {
      return { chartType, title, data: built };
    }
  }

  let labels = tryParseJsonish(args.labels);
  let values = tryParseJsonish(args.values);
  if (Array.isArray(labels) && Array.isArray(values)) {
    const seriesName =
      typeof args.seriesName === "string" && args.seriesName.trim()
        ? args.seriesName.trim()
        : "占比";
    return {
      chartType,
      title,
      data: buildChartDataFromFlat(labels, values, seriesName),
    };
  }

  return { chartType, title, data: args.data };
}

/** True when args already contain enough structure to build a chart. */
export function generateChartArgsHaveData(args: Record<string, unknown>): boolean {
  return resolveGenerateChartData(normalizeGenerateChartArgs(args)) !== null;
}

export function extractDutNumberFromText(text: string): number | undefined {
  const m =
    text.match(/\bdut\s*#?\s*(\d+)\b/i) ??
    text.match(/\bDUT\s*(\d+)\b/);
  if (!m) return undefined;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : undefined;
}

export function extractBinHintFromText(text: string): string | undefined {
  const m = text.match(/\bBIN\s*(\d+)\b/i);
  if (!m) return undefined;
  return `bin${m[1]}`;
}

function parseInfSiteBinToolJson(content: string): { passes: SiteBinPass[] } | null {
  try {
    const o = JSON.parse(content) as { passes?: unknown };
    if (o && Array.isArray(o.passes)) {
      return { passes: o.passes as SiteBinPass[] };
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function buildDutShareChartData(
  passes: SiteBinPass[],
  dut: number,
  binFilter?: string
): ChartData | null {
  const binKey = binFilter?.toLowerCase();
  let dutSum = 0;
  let otherSum = 0;
  for (const pass of passes) {
    for (const binEntry of pass.bins) {
      if (binKey && String(binEntry.bin).toLowerCase() !== binKey) continue;
      // compact format stores duts as `_duts`; good bins may have no duts at all
      const duts: SiteBinDutEntry[] =
        (Array.isArray(binEntry.duts) ? binEntry.duts : null) ??
        (Array.isArray((binEntry as unknown as Record<string, unknown>)._duts)
          ? (binEntry as unknown as Record<string, unknown>)._duts as SiteBinDutEntry[]
          : []);
      for (const { dut: d, dieCount } of duts) {
        if (typeof d !== "number") continue;
        if (d === dut) dutSum += dieCount;
        else otherSum += dieCount;
      }
    }
  }
  if (dutSum === 0 && otherSum === 0) return null;
  return {
    labels: [`DUT${dut}`, "其他DUT"],
    series: [{ name: "dieCount", values: [dutSum, otherSum] }],
  };
}

/**
 * When the model calls generate_chart with empty or incomplete args, build pie data
 * from the latest query_inf_site_bin_by_dut tool result (DUTn vs 其他).
 */
export function inferGenerateChartArgsFromHistory(
  history: ChatMessage[],
  args: Record<string, unknown>
): Record<string, unknown> | null {
  const existing = normalizeGenerateChartArgs(args);
  if (resolveGenerateChartData(existing)) return existing;

  let dutHint = extractDutNumberFromText(String(args.title ?? ""));
  let binHint = extractBinHintFromText(String(args.title ?? ""));

  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role === "user" && typeof msg.content === "string") {
      dutHint = dutHint ?? extractDutNumberFromText(msg.content);
      binHint = binHint ?? extractBinHintFromText(msg.content);
    }
    if (msg.role === "tool" && msg.name === "inf_site_stats") {
      const parsed = tryParseJsonish(String(msg.content ?? ""));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const sitesRaw = (parsed as Record<string, unknown>).sites;
      if (!Array.isArray(sitesRaw) || sitesRaw.length === 0) continue;
      const sites = sitesRaw as Array<{ site_id: number; yield: number }>;
      const labels = sites.map((s) => `DUT${s.site_id}`);
      const values = sites.map((s) => +(s.yield * 100).toFixed(2));
      const chartType =
        typeof args.chartType === "string" && args.chartType.trim()
          ? args.chartType.trim()
          : "bar";
      const title = String(args.title ?? "").trim() || "各DUT良率%";
      return { chartType, title, data: { labels, series: [{ name: "良率%", values }] } };
    }
    if (msg.role === "tool" && msg.name === "query_inf_site_bin_by_dut") {
      const inf = parseInfSiteBinToolJson(String(msg.content ?? ""));
      if (!inf) continue;
      const dut = dutHint ?? 2;
      const data = buildDutShareChartData(inf.passes, dut, binHint);
      if (!data) continue;
      const chartType =
        typeof args.chartType === "string" && args.chartType.trim()
          ? args.chartType.trim()
          : "pie";
      const title = String(args.title ?? "").trim();
      return {
        chartType,
        title: title || (binHint ? `${binHint.toUpperCase()} DUT${dut} 占比` : `DUT${dut} 占比`),
        data,
      };
    }
  }
  return null;
}

export function resolveGenerateChartData(
  normalized: Record<string, unknown>
): ChartData | null {
  const data = normalized.data;
  if (data == null) return null;
  if (typeof data === "string") {
    const parsed = tryParseJsonish(data);
    if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return chartDataFromRecord(parsed as Record<string, unknown>);
    }
    return null;
  }
  if (typeof data === "object" && !Array.isArray(data)) {
    const d = data as ChartData;
    if (Array.isArray(d.labels) && Array.isArray(d.series) && d.series.length > 0) {
      return d;
    }
    return chartDataFromRecord(data as Record<string, unknown>);
  }
  return null;
}

export function buildChartOption(
  chartType: "bar" | "line" | "pie" | "scatter",
  title: string,
  data: ChartData
): object {
  if (!Array.isArray(data.labels) || !Array.isArray(data.series)) {
    throw new Error("图表 data 缺少 labels 或 series");
  }

  if (chartType === "pie") {
    const pieData = data.labels.map((label, i) => ({
      name: label,
      value: data.series[0]?.values[i] ?? 0,
    }));
    return {
      title: { text: title, left: "center" },
      tooltip: { trigger: "item" },
      legend: { orient: "vertical", left: "left" },
      series: [{ type: "pie", radius: "50%", data: pieData }],
    };
  }

  const xAxis =
    chartType === "scatter"
      ? undefined
      : { type: "category", data: data.labels, axisLabel: { rotate: 30 } };

  const series = data.series.map((s) => {
    if (chartType === "scatter") {
      return {
        name: s.name,
        type: "scatter",
        data: data.labels.map((label, i) => [label, s.values[i] ?? 0]),
      };
    }
    return { name: s.name, type: chartType, data: s.values };
  });

  return {
    title: { text: title, left: 24 },
    tooltip: { trigger: "axis" },
    legend: { data: data.series.map((s) => s.name) },
    // left 与 title.left 对齐（containLabel 会自动为轴刻度让出空间）；
    // right 留小边距让绘图区尽量贴左铺满，避免超宽容器里两侧留白显得居中。
    grid: { left: 24, right: "3%", top: 60, bottom: 80, containLabel: true },
    xAxis,
    yAxis: { type: "value" },
    series,
  };
}
