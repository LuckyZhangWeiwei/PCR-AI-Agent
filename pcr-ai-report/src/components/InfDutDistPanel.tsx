import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ECharts } from "echarts";
import type { EChartsOption } from "echarts";
import { apiPostJson } from "../api/client";
import { SITE_BIN_BY_LOT_LAYERS_PATH } from "../api/paths";
import type { SiteBinByLotResponse, SiteBinLayersBatchResponse, SiteBinPass } from "../api/types";
import { DarkChart } from "./DarkChart";
import { buildInfPath } from "../utils/buildInfPath";
import {
  filterSiteBinPassBadOnlyNonZero,
  goodBinNumbersKey,
  normalizeGoodBinSet,
  isGoodBinLabel,
  siteBinPassBadDieTotal,
} from "../utils/infGoodBins";
import { mergeSiteBinPasses, siteBinPassesFromJbFallback } from "../utils/mergeSiteBinPasses";
import type { InfDutWaferSpec } from "../utils/infDutSelection";
import { infDutWaferCacheKey } from "../utils/infDutSelection";
import {
  baseChartOption,
  getChartPalette,
  type ChartTheme,
} from "../theme/chartTheme";
import { useThemeContext } from "../theme/ThemeContext";

type Props = {
  wafers: InfDutWaferSpec[];
  device: string;
  lot: string;
  selectionSummary?: string;
  focusBin?: string;
  /** JB 行推导的良品 bin 编号；图中不展示这些 bin */
  goodBinNumbers?: ReadonlySet<number>;
  apiBase: string;
  onClose: () => void;
};

function passLabel(passId: number): string {
  if (passId === 1) return "Pass 1 (sort1 · 常温)";
  if (passId === 3) return "Pass 3 (sort2 · 高温)";
  if (passId === 5) return "Pass 5 (sort3 · 低温)";
  return `Pass ${passId}`;
}

function filterPassBadBinsOnly(
  pass: SiteBinPass,
  goodBinNumbers: ReadonlySet<number> | undefined
): SiteBinPass {
  return filterSiteBinPassBadOnlyNonZero(pass, goodBinNumbers);
}

function validateLayerSiteBinResponse(
  wafer: InfDutWaferSpec,
  res: SiteBinByLotResponse
): string | null {
  if (!wafer.testEnd) return null;
  if (res.mapSource !== "oracle") {
    return (
      `分层 DUT×BIN 未生效（mapSource=${res.mapSource ?? "未知"}，整片 INF 合并图会把多层 bin 叠在一起）。` +
      "请确认 API 已 pm2 reload，报表 dist 已重新 build 发布，并对页面 Ctrl+F5 强刷。"
    );
  }
  if (res.testEnd && wafer.testEnd) {
    const a = new Date(res.testEnd).getTime();
    const b = new Date(wafer.testEnd).getTime();
    if (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) > 1000) {
      return `TESTEND 不一致：明细 ${wafer.testEnd}，API 返回 ${res.testEnd}`;
    }
  }
  return null;
}

function dutSeriesDieCount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value && typeof value === "object" && "value" in value) {
    const v = (value as { value: unknown }).value;
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return 0;
}

/** DUT 条目较多时用多列，避免单列过高在 confine 下被裁切 */
function dutDistTooltipColumns(itemCount: number): number {
  if (itemCount <= 6) return 1;
  if (itemCount <= 14) return 2;
  if (itemCount <= 30) return 3;
  return 4;
}

type DutTipRow = { html: string; seriesIndex: number };

function formatDutDistTooltipHtml(
  header: string,
  rows: DutTipRow[],
  hoveredSeriesIndex?: number | null
): string {
  if (!rows.length) return header;
  const cols = dutDistTooltipColumns(rows.length);
  const cells = rows
    .map((row) => {
      const isHovered =
        hoveredSeriesIndex != null && row.seriesIndex === hoveredSeriesIndex;
      const extraStyle = isHovered
        ? "background:rgba(var(--accent-rgb),0.32);border-radius:4px;padding:2px 7px;margin:-2px -7px;font-weight:700;color:var(--text);box-shadow:0 0 0 1px rgba(var(--accent-rgb),0.45);"
        : "";
      const cls = isHovered ? "dut-tip-row dut-tip-row--hovered" : "dut-tip-row";
      return `<div class="${cls}" data-series-index="${row.seriesIndex}" style="white-space:nowrap;line-height:1.7;font-size:12px;display:flex;align-items:center;gap:7px;${extraStyle}">${row.html}</div>`;
    })
    .join("");
  return [
    `<div style="font-weight:600;margin-bottom:9px;font-size:13px;">${header}</div>`,
    `<div style="display:grid;grid-template-columns:repeat(${cols},auto);column-gap:28px;row-gap:7px;max-height:min(380px,64vh);overflow-y:auto;overflow-x:hidden;padding-right:14px;">`,
    cells,
    `</div>`,
  ].join("");
}

/** ECharts 默认 marker 约 10×10；略放大便于辨认 DUT 色块 */
function enlargeDutTooltipMarker(marker: string | undefined): string {
  if (!marker) return "";
  return marker.replace(
    /width:(\d+(?:\.\d+)?)px;height:(\d+(?:\.\d+)?)px/g,
    (_m, w, h) => {
      const nw = Math.min(14, Math.round(Number(w) * 1.25));
      const nh = Math.min(14, Math.round(Number(h) * 1.25));
      return `width:${nw}px;height:${nh}px`;
    }
  );
}

/** 悬浮层挂到 body 并限制在视口内，避免被报表区域 overflow 裁切 */
function dutDistTooltip(
  theme: ChartTheme,
  hoveredSeriesRef?: { current: number | null }
): EChartsOption["tooltip"] {
  const base = baseChartOption(theme).tooltip as Record<string, unknown> | undefined;
  return {
    ...base,
    trigger: "axis",
    axisPointer: { type: "shadow" },
    appendToBody: true,
    confine: true,
    enterable: true,
    extraCssText:
      "max-width:min(680px,96vw);padding:14px 16px;line-height:1.6;",
    formatter(params: unknown) {
      const items = (Array.isArray(params) ? params : [params]) as {
        axisValue?: string;
        seriesName?: string;
        seriesIndex?: number;
        marker?: string;
        value?: unknown;
      }[];
      if (!items.length) return "";
      const header = String(items[0]?.axisValue ?? "");
      const hoveredIdx = hoveredSeriesRef?.current ?? null;
      const rows = items
        .filter((p) => dutSeriesDieCount(p.value) !== 0)
        .sort((a, b) => dutSeriesDieCount(b.value) - dutSeriesDieCount(a.value))
        .map((p) => ({
          seriesIndex: p.seriesIndex ?? 0,
          html: `${enlargeDutTooltipMarker(p.marker)} ${p.seriesName ?? ""}: ${dutSeriesDieCount(p.value)}`,
        }));
      return formatDutDistTooltipHtml(header, rows, hoveredIdx);
    },
    position(
      point: number[],
      _params: unknown,
      _dom: unknown,
      _rect: unknown,
      size: { contentSize: number[]; viewSize: number[] }
    ) {
      const [x, y] = point;
      const [cw, ch] = size.contentSize;
      const [vw, vh] = size.viewSize;
      let left = x + 12;
      let top = y - ch - 12;
      if (left + cw > vw - 8) left = Math.max(8, x - cw - 12);
      if (top < 8) top = y + 12;
      if (top + ch > vh - 8) top = Math.max(8, vh - ch - 8);
      return [left, top];
    },
  };
}

/** 保证绘图区高度（不含底部 HTML 图例） */
function dutDistChartHeight(
  binCount: number,
  xLabelBottom = 20
): number {
  const gridTop = 24;
  const minPlot = 80;
  const byBins = binCount * 10 + gridTop + 24 + xLabelBottom;
  return Math.max(gridTop + xLabelBottom + minPlot, byBins, 120);
}

/** 与 ECharts 默认色板一致，供柱图与底部 HTML 图例共用 */
const DUT_DIST_PALETTE = [
  "#5470c6",
  "#91cc75",
  "#fac858",
  "#ee6666",
  "#73c0de",
  "#3ba272",
  "#fc8452",
  "#9a60b4",
  "#ea7ccc",
  "#58a6ff",
  "#a371f7",
  "#3fb950",
  "#d29922",
  "#f85149",
  "#79c0ff",
];

type DutSeriesItem = {
  seriesIndex: number;
  seriesName: string;
  label: string;
  dutKey: string;
  color: string;
};

function extractDutSeriesList(pass: SiteBinPass): DutSeriesItem[] {
  const dutSet = new Set<string>();
  for (const b of pass.bins) {
    for (const d of b.duts) dutSet.add(String(d.dut));
  }
  const duts = [...dutSet].sort((a, b) => {
    if (a === "single") return 1;
    if (b === "single") return -1;
    return Number(a) - Number(b);
  });
  return duts.map((dut, i) => {
    const label = dut === "single" ? "Single" : `DUT ${dut}`;
    return {
      seriesIndex: i,
      seriesName: label,
      label,
      dutKey: dut,
      color: DUT_DIST_PALETTE[i % DUT_DIST_PALETTE.length]!,
    };
  });
}

function DutDistHtmlLegend({
  items,
  activeSet,
  onEnter,
  onLeave,
}: {
  items: DutSeriesItem[];
  activeSet: Set<number> | null;
  onEnter: (index: number) => void;
  onLeave: () => void;
}) {
  return (
    <div className="dut-dist-html-legend" role="list" aria-label="DUT 图例">
      {items.map((item) => (
        <button
          key={item.seriesName}
          type="button"
          role="listitem"
          className={[
            "dut-dist-html-legend-item",
            activeSet?.has(item.seriesIndex)
              ? "dut-dist-html-legend-item--active"
              : "",
            activeSet !== null && !activeSet.has(item.seriesIndex)
              ? "dut-dist-html-legend-item--dim"
              : "",
          ]
            .filter(Boolean)
            .join(" ")}
          onMouseEnter={() => onEnter(item.seriesIndex)}
          onMouseLeave={onLeave}
        >
          <span
            className="dut-dist-html-legend-swatch"
            style={{ backgroundColor: item.color }}
            aria-hidden
          />
          <span>{item.label}</span>
        </button>
      ))}
    </div>
  );
}

/** Halo/glow border+shadow must be recomputed per theme — a module-level static white rgba
 * constant would never update on theme toggle (same bug class as the removed COL_PANEL constants). */
function dutSeriesEmphasis(chartPalette: { haloRgb: string }) {
  return {
    focus: "series" as const,
    itemStyle: {
      borderWidth: 1.5,
      borderColor: `rgba(${chartPalette.haloRgb},0.85)`,
      shadowBlur: 10,
      shadowColor: `rgba(${chartPalette.haloRgb},0.28)`,
    },
  };
}

const DUT_SERIES_BLUR = {
  itemStyle: { opacity: 0.16 },
};

function highlightDutSeries(chart: ECharts | null, seriesIndex: number): void {
  if (!chart) return;
  chart.dispatchAction({ type: "downplay" });
  chart.dispatchAction({ type: "highlight", seriesIndex });
}

function downplayDutSeries(chart: ECharts | null): void {
  chart?.dispatchAction({ type: "downplay" });
  document
    .querySelectorAll(".dut-tip-row--active")
    .forEach((el) => el.classList.remove("dut-tip-row--active"));
}

function tooltipHovered(): boolean {
  return [...document.querySelectorAll(".echarts-tooltip")].some((el) =>
    el.matches(":hover")
  );
}

function DutDistPassChart({
  pass,
  focusBin,
  goodBinNumbers,
  chartHeight,
  theme,
}: {
  pass: SiteBinPass;
  focusBin?: string;
  goodBinNumbers?: ReadonlySet<number>;
  chartHeight: number;
  theme: ChartTheme;
}) {
  const chartRef = useRef<ECharts | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const clearTimerRef = useRef<number | null>(null);
  // Tracks the currently hovered series for tooltip row highlight (read by formatter at call time)
  const hoveredSeriesIndexRef = useRef<number | null>(null);

  // ── Interaction states ────────────────────────────────────────────────────
  // DUT legend item hovered → dims bins where that DUT has count=0
  const [legendHoveredDut, setLegendHoveredDut] = useState<number | null>(null);
  // Bar (bin) clicked → highlights DUTs that have count>0 in that bin
  const [clickedBinIndex, setClickedBinIndex] = useState<number | null>(null);
  // Chart bar/tooltip hover → highlights all DUTs with count>0 in the hovered bin
  const [hoveredBinDuts, setHoveredBinDuts] = useState<Set<number> | null>(null);

  // ── Precomputed chart data (mirrors buildDutChartOption internals) ─────────
  const good = useMemo(() => normalizeGoodBinSet(goodBinNumbers), [goodBinNumbers]);
  const badBinEntries = useMemo(
    () => pass.bins.filter((b) => !isGoodBinLabel(b.bin, good)),
    [pass.bins, good]
  );
  const seriesList = useMemo(
    () => extractDutSeriesList({ ...pass, bins: badBinEntries }),
    [pass, badBinEntries]
  );

  // ── Derived: which bin indices are "active" for the hovered legend DUT ────
  const activeBinIndices = useMemo<Set<number> | null>(() => {
    if (legendHoveredDut === null) return null;
    const item = seriesList[legendHoveredDut];
    if (!item) return null;
    const active = new Set<number>();
    badBinEntries.forEach((b, i) => {
      const de = b.duts.find((d) => String(d.dut) === item.dutKey);
      if ((de?.dieCount ?? 0) > 0) active.add(i);
    });
    return active;
  }, [legendHoveredDut, seriesList, badBinEntries]);

  // ── Derived: which DUT series indices are active for the clicked bin ──────
  const clickedBinDuts = useMemo<Set<number> | null>(() => {
    if (clickedBinIndex === null) return null;
    const binEntry = badBinEntries[clickedBinIndex];
    if (!binEntry) return null;
    const active = new Set<number>();
    seriesList.forEach((item, i) => {
      const de = binEntry.duts.find((d) => String(d.dut) === item.dutKey);
      if ((de?.dieCount ?? 0) > 0) active.add(i);
    });
    return active;
  }, [clickedBinIndex, seriesList, badBinEntries]);

  // ── Legend highlight set (priority: legend hover > bar click > bar/tooltip hover)
  const legendActiveSet = useMemo<Set<number> | null>(() => {
    if (legendHoveredDut !== null) return new Set([legendHoveredDut]);
    if (clickedBinDuts !== null) return clickedBinDuts;
    if (hoveredBinDuts !== null) return hoveredBinDuts;
    return null;
  }, [legendHoveredDut, clickedBinDuts, hoveredBinDuts]);

  // ── Chart option (includes activeBinIndices + hoveredSeriesIndex for legend-hover opacity) ─────
  // hoveredSeriesIndexRef is intentionally excluded from deps: ref identity is stable,
  // and the formatter reads ref.current at call time — no re-render needed.
  const option = useMemo(
    () =>
      buildDutChartOption(
        pass,
        focusBin,
        goodBinNumbers,
        activeBinIndices,
        legendHoveredDut,
        theme,
        hoveredSeriesIndexRef
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pass, focusBin, goodBinNumbers, activeBinIndices, legendHoveredDut, theme]
  );

  // ── ECharts highlight helpers ─────────────────────────────────────────────
  // When activeBinIndices is set (legend hover), emphasis/blur are stripped from
  // the series option, so ECharts dispatch has no visible effect — safe to always call.
  // binDuts: explicit set to use for legend; omit to default to Set([idx]) for single-DUT cases.
  const applyHighlight = useCallback((idx: number | null, binDuts?: Set<number> | null) => {
    hoveredSeriesIndexRef.current = idx; // keep ref in sync for tooltip formatter
    if (clearTimerRef.current != null) {
      window.clearTimeout(clearTimerRef.current);
      clearTimerRef.current = null;
    }
    setHoveredBinDuts(
      binDuts !== undefined ? binDuts : idx != null ? new Set([idx]) : null
    );
    if (idx == null) downplayDutSeries(chartRef.current);
    else highlightDutSeries(chartRef.current, idx);
  }, []);

  const scheduleClearHighlight = useCallback(() => {
    if (clearTimerRef.current != null) window.clearTimeout(clearTimerRef.current);
    clearTimerRef.current = window.setTimeout(() => {
      clearTimerRef.current = null;
      if (tooltipHovered()) return;
      if (wrapRef.current?.matches(":hover")) return;
      applyHighlight(null);
    }, 48);
  }, [applyHighlight]);

  // ── Legend DUT hover handlers ─────────────────────────────────────────────
  const onLegendEnter = useCallback((index: number) => {
    if (clearTimerRef.current != null) {
      window.clearTimeout(clearTimerRef.current);
      clearTimerRef.current = null;
    }
    setLegendHoveredDut(index);
    downplayDutSeries(chartRef.current); // clear any ECharts native highlight
  }, []);

  const onLegendLeave = useCallback(() => {
    setLegendHoveredDut(null);
    scheduleClearHighlight();
  }, [scheduleClearHighlight]);

  // ── Tooltip DUT row hover ─────────────────────────────────────────────────
  useEffect(() => {
    const onTipRowOver = (e: MouseEvent) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>(".dut-tip-row");
      if (!row?.closest(".echarts-tooltip")) return;
      const idx = row.dataset.seriesIndex;
      if (idx == null || idx === "") return;
      applyHighlight(Number(idx));
      document
        .querySelectorAll(".dut-tip-row--active")
        .forEach((el) => el.classList.remove("dut-tip-row--active"));
      row.classList.add("dut-tip-row--active");
    };

    const onTipRowOut = (e: MouseEvent) => {
      const row = (e.target as HTMLElement).closest(".dut-tip-row");
      if (!row) return;
      const related = e.relatedTarget as HTMLElement | null;
      if (related?.closest(".dut-tip-row")) return;
      row.classList.remove("dut-tip-row--active");
      scheduleClearHighlight();
    };

    document.addEventListener("mouseover", onTipRowOver);
    document.addEventListener("mouseout", onTipRowOut);
    return () => {
      document.removeEventListener("mouseover", onTipRowOver);
      document.removeEventListener("mouseout", onTipRowOut);
      if (clearTimerRef.current != null) window.clearTimeout(clearTimerRef.current);
    };
  }, [applyHighlight, scheduleClearHighlight]);

  // ── Chart events ──────────────────────────────────────────────────────────
  const onEvents = useMemo(
    () => ({
      // Hovering a specific segment highlights only that segment's DUT in the legend.
      mouseover: (params: unknown) => {
        const p = params as { componentType?: string; seriesIndex?: number };
        if (p.componentType !== "series" || p.seriesIndex == null) return;
        applyHighlight(p.seriesIndex);
      },
      globalout: () => {
        scheduleClearHighlight();
      },
      // Clicking a bar highlights corresponding DUTs in the legend.
      // Click same bin again (or outside a bar) to clear.
      click: (params: unknown) => {
        const p = params as { componentType?: string; dataIndex?: number };
        if (p.componentType !== "series" || p.dataIndex == null) {
          setClickedBinIndex(null);
          return;
        }
        setClickedBinIndex((prev) =>
          prev === p.dataIndex ? null : (p.dataIndex as number)
        );
      },
    }),
    [applyHighlight, scheduleClearHighlight]
  );

  return (
    <div ref={wrapRef} className="dut-dist-chart-block">
      <div className="chart-no-drill">
        <DarkChart
          key={`pass-${pass.passId}-good-${goodBinNumbersKey(goodBinNumbers)}`}
          option={option}
          height={chartHeight}
          onEvents={onEvents}
          onChartReady={(chart) => {
            chartRef.current = chart;
          }}
        />
      </div>
      <DutDistHtmlLegend
        items={seriesList}
        activeSet={legendActiveSet}
        onEnter={onLegendEnter}
        onLeave={onLegendLeave}
      />
    </div>
  );
}

function buildDutChartOption(
  pass: SiteBinPass,
  focusBin: string | undefined,
  goodBinNumbers: ReadonlySet<number> | undefined,
  activeBinIndices: Set<number> | null,
  hoveredSeriesIndex: number | null,
  theme: ChartTheme,
  hoveredSeriesRef?: { current: number | null }
): EChartsOption {
  const chartPalette = getChartPalette(theme);
  const good = normalizeGoodBinSet(goodBinNumbers);
  const badBinEntries = pass.bins.filter((b) => !isGoodBinLabel(b.bin, good));
  const bins = badBinEntries.map((b) => b.bin);
  const seriesList = extractDutSeriesList({ ...pass, bins: badBinEntries });
  const xLabelBottom = bins.length > 8 ? 34 : 20;
  const gridTop = 32;
  // When legend DUT is hovered, disable ECharts focus so per-item opacity drives visuals
  const useCustomOpacity = activeBinIndices !== null;

  const series: EChartsOption["series"] = seriesList.map((item, seriesIdx) => ({
    name: item.seriesName,
    type: "bar",
    stack: "total",
    barMaxWidth: 16,
    barCategoryGap: "35%",
    itemStyle: { color: item.color },
    data: bins.map((bin, binIdx) => {
      const binEntry = badBinEntries.find((b) => b.bin === bin);
      const dutEntry = binEntry?.duts.find(
        (d) => String(d.dut) === item.dutKey
      );
      const val = dutEntry?.dieCount ?? 0;
      const focusDimmed = focusBin !== undefined && bin !== focusBin;
      // Inactive bin (hovered DUT has 0 count here): fully dim all series
      const legendDimmed = useCustomOpacity && !activeBinIndices!.has(binIdx);
      // Active bin, this is the hovered DUT's own segment → glow highlight
      const isHoveredSegment =
        useCustomOpacity &&
        activeBinIndices!.has(binIdx) &&
        hoveredSeriesIndex !== null &&
        seriesIdx === hoveredSeriesIndex;
      // Active bin but not the hovered DUT's segment: dim others to make hovered stand out
      const otherInActiveBin =
        useCustomOpacity &&
        activeBinIndices!.has(binIdx) &&
        hoveredSeriesIndex !== null &&
        seriesIdx !== hoveredSeriesIndex;
      if (isHoveredSegment) {
        return {
          value: val,
          itemStyle: {
            opacity: 1,
            shadowBlur: 14,
            shadowColor: `rgba(${chartPalette.haloRgb},0.55)`,
            borderColor: `rgba(${chartPalette.haloRgb},0.75)`,
            borderWidth: 1.5,
          },
        };
      }
      const opacity = focusDimmed
        ? 0.3
        : legendDimmed
        ? 0.08
        : otherInActiveBin
        ? 0.22
        : undefined;
      return {
        value: val,
        itemStyle: opacity !== undefined ? { opacity } : undefined,
      };
    }),
    emphasis: useCustomOpacity ? undefined : dutSeriesEmphasis(chartPalette),
    blur: useCustomOpacity ? undefined : DUT_SERIES_BLUR,
  }));

  return {
    ...baseChartOption(theme),
    color: DUT_DIST_PALETTE,
    stateAnimation: { duration: 200, easing: "cubicOut" },
    grid: {
      left: 10,
      right: 14,
      top: gridTop,
      bottom: xLabelBottom,
      containLabel: true,
    },
    xAxis: {
      type: "category",
      data: bins,
      axisLabel: { color: chartPalette.axisColor, rotate: bins.length > 8 ? 30 : 0, fontSize: 11 },
    },
    yAxis: {
      type: "value",
      name: "die count",
      nameLocation: "end",
      nameGap: 10,
      nameTextStyle: { color: chartPalette.axisColor, fontSize: 9, align: "left" },
      axisLabel: {
        color: chartPalette.axisColor,
        fontSize: 9,
        margin: 10,
        hideOverlap: false,
      },
      splitLine: { lineStyle: { color: chartPalette.splitLine } },
    },
    legend: { show: false },
    tooltip: dutDistTooltip(theme, hoveredSeriesRef),
    series,
  };
}

function wafersFetchKey(wafers: InfDutWaferSpec[]): string {
  return wafers.map(infDutWaferCacheKey).join(";");
}

function waferToLayerRequest(w: InfDutWaferSpec): {
  infPath: string;
  device: string;
  passIds: number[];
  keynumber?: number;
  passNum?: number;
  testEnd?: string;
} {
  const req: {
    infPath: string;
    device: string;
    passIds: number[];
    keynumber?: number;
    passNum?: number;
    testEnd?: string;
  } = {
    infPath: buildInfPath(w.device, w.lot, w.slot),
    device: w.device,
    passIds: w.passIds,
  };
  if (w.keynumber !== undefined) req.keynumber = w.keynumber;
  if (w.passNum !== undefined) req.passNum = w.passNum;
  if (w.testEnd) req.testEnd = w.testEnd;
  return req;
}

function layerTestEndMs(raw: string | undefined): number | null {
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

function findBatchLayerForWafer(
  batch: SiteBinLayersBatchResponse,
  w: InfDutWaferSpec,
  index: number
): SiteBinLayersBatchResponse["layers"][number] | undefined {
  const byIndex = batch.layers[index];
  if (byIndex) {
    const infPath = buildInfPath(w.device, w.lot, w.slot);
    const te = layerTestEndMs(w.testEnd);
    const layerTe = layerTestEndMs(byIndex.testEnd);
    if (
      byIndex.infPath === infPath &&
      (te === null || layerTe === null || te === layerTe)
    ) {
      return byIndex;
    }
  }
  const infPath = buildInfPath(w.device, w.lot, w.slot);
  const te = layerTestEndMs(w.testEnd);
  return batch.layers.find((l) => {
    if (l.infPath !== infPath) return false;
    const layerTe = layerTestEndMs(l.testEnd);
    if (te !== null && layerTe !== null && te !== layerTe) return false;
    return true;
  });
}

function storeBatchLayersInCache(
  cache: Map<string, SiteBinByLotResponse>,
  missing: InfDutWaferSpec[],
  batch: SiteBinLayersBatchResponse
): void {
  if (batch.layers.length !== missing.length) {
    throw new Error(
      `批量 DUT×BIN 层数不符: 请求 ${missing.length}，响应 ${batch.layers.length}`
    );
  }
  for (let i = 0; i < missing.length; i++) {
    const w = missing[i]!;
    const layer = findBatchLayerForWafer(batch, w, i);
    if (!layer) {
      throw new Error(
        `批量 DUT×BIN 响应缺少层: slot ${w.slot} testEnd=${w.testEnd ?? ""}`
      );
    }
    cache.set(infDutWaferCacheKey(w), layerResponseFromBatchItem(layer, w));
  }
}

async function fetchLayersBatch(
  apiBase: string,
  wafers: InfDutWaferSpec[]
): Promise<SiteBinLayersBatchResponse> {
  return apiPostJson<SiteBinLayersBatchResponse>(
    apiBase,
    SITE_BIN_BY_LOT_LAYERS_PATH,
    { layers: wafers.map(waferToLayerRequest) },
    { cache: "no-store" }
  );
}

function layerResponseFromBatchItem(
  layer: SiteBinLayersBatchResponse["layers"][number],
  wafer?: InfDutWaferSpec
): SiteBinByLotResponse {
  return {
    meta: { apiVersion: "1", requestId: "", summary: "" },
    infPath: layer.infPath,
    passIds: layer.passIds,
    passes: layer.passes,
    mapSource: layer.mapSource,
    keynumber: layer.keynumber ?? wafer?.keynumber,
    passNum: layer.passNum ?? wafer?.passNum,
    testEnd: layer.testEnd ?? wafer?.testEnd,
  };
}

export function InfDutDistPanel({
  wafers,
  device,
  lot,
  selectionSummary,
  focusBin,
  goodBinNumbers,
  apiBase,
  onClose,
}: Props) {
  const { theme } = useThemeContext();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mergedPasses, setMergedPasses] = useState<SiteBinPass[] | null>(null);
  const [fetchPaths, setFetchPaths] = useState<string[]>([]);
  const [fetchMeta, setFetchMeta] = useState<{
    mapSources: string[];
    badDieTotal: number;
    usedJbFallback?: boolean;
  } | null>(null);

  const waferKey = wafersFetchKey(wafers);
  const layerCacheRef = useRef(new Map<string, SiteBinByLotResponse>());
  const apiBaseRef = useRef(apiBase);

  useEffect(() => {
    if (apiBaseRef.current !== apiBase) {
      apiBaseRef.current = apiBase;
      layerCacheRef.current.clear();
    }

    let cancelled = false;
    if (wafers.length === 0) {
      setLoading(false);
      setError(null);
      setMergedPasses(null);
      setFetchPaths([]);
      setFetchMeta(null);
      return;
    }

    setLoading(true);
    setError(null);
    setMergedPasses(null);
    setFetchMeta(null);
    setFetchPaths(wafers.map((w) => buildInfPath(w.device, w.lot, w.slot)));

    void (async () => {
      try {
        const cache = layerCacheRef.current;
        const missing = wafers.filter((w) => !cache.has(infDutWaferCacheKey(w)));

        if (missing.length > 0) {
          const batch = await fetchLayersBatch(apiBase, missing);
          if (cancelled) return;
          storeBatchLayersInCache(cache, missing, batch);
        }

        const results = wafers.map((w) => {
          const hit = cache.get(infDutWaferCacheKey(w));
          if (!hit) {
            throw new Error(`DUT×BIN 缓存未命中: slot ${w.slot}`);
          }
          return hit;
        });

        if (cancelled) return;
        for (let i = 0; i < results.length; i++) {
          const layerErr = validateLayerSiteBinResponse(wafers[i]!, results[i]!);
          if (layerErr) {
            setError(layerErr);
            setMergedPasses(null);
            setFetchMeta(null);
            return;
          }
        }
        const passesFromMap = mergeSiteBinPasses(results.map((r) => r.passes));
        let passes = passesFromMap;
        let usedJbFallback = false;
        if (passes.length === 0) {
          const fromJb = siteBinPassesFromJbFallback(wafers);
          if (fromJb.length > 0) {
            passes = fromJb;
            usedJbFallback = true;
          }
        }
        const mapSources = usedJbFallback
          ? ["jb"]
          : [...new Set(results.map((r) => r.mapSource ?? "unknown"))];
        let badDieTotal = 0;
        for (const pass of passes) {
          badDieTotal += siteBinPassBadDieTotal(pass, goodBinNumbers);
        }
        setMergedPasses(passes);
        setFetchMeta({ mapSources, badDieTotal, usedJbFallback });
        setError(null);
      } catch (e: unknown) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setMergedPasses(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  // waferKey is derived entirely from wafers content, so listing wafers (an array reference)
  // alongside waferKey is redundant and causes spurious re-fetches when the parent rebuilds
  // the array with identical content (different reference, same waferKey).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase, waferKey]);

  const meta =
    selectionSummary ??
    `LOT ${lot} · ${wafers.length} 片 · Device ${device}`;
  const sourceLabel = fetchMeta
    ? ` · 数据源 ${fetchMeta.mapSources.join("+")}${
        fetchMeta.usedJbFallback ? "（无 site 图，按 JB 层 BIN）" : ""
      } · 不良 die ${fetchMeta.badDieTotal}`
    : "";

  return (
    <div className="inf-dut-dist-panel">
      <div className="inf-dut-dist-panel-meta">
        <span className="muted small">
          {meta}
          {sourceLabel}
        </span>
        <button
          type="button"
          className="chip inf-dut-dist-panel-dismiss"
          onClick={onClose}
          aria-label="关闭 DUT 分布"
        >
          关闭
        </button>
      </div>

      {loading && (
        <div
          style={{
            height: 100,
            background: "rgba(var(--fg-rgb),0.04)",
            borderRadius: 4,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--dimmed)",
            fontSize: 14,
          }}
        >
          加载中…
        </div>
      )}

      {!loading && error && (
        <div style={{ color: "var(--red-text)", fontSize: 13 }}>
          <div>读取失败：{error}</div>
          {fetchPaths.length > 0 && (
            <div style={{ marginTop: 4, fontSize: 12, color: "var(--dimmed)" }}>
              {fetchPaths.map((p) => (
                <div key={p}>{p}</div>
              ))}
            </div>
          )}
        </div>
      )}

      {!loading && !error && mergedPasses && (
        <div>
          {mergedPasses.length === 0 && (
            <div style={{ color: "var(--muted)", fontSize: 14 }}>
              未找到匹配的 pass 数据（Oracle/INF 无 bin×DUT 图，且该层 JB bins
              为空）
            </div>
          )}
          {fetchMeta?.usedJbFallback && mergedPasses.length > 0 && (
            <div
              style={{
                color: "var(--dimmed)",
                fontSize: 12,
                marginBottom: 8,
              }}
            >
              本层无 probe site 图（TESTSITELAST 空），已用 JB 明细 BIN
              颗数按 Single DUT 展示；无法按 DUT 分解。
            </div>
          )}
          {mergedPasses.map((pass) => {
            const passBad = filterPassBadBinsOnly(pass, goodBinNumbers);
            return (
            <div key={pass.passId} style={{ marginBottom: 10 }}>
              <div
                style={{ fontSize: 12, color: "var(--muted)", marginBottom: 4 }}
              >
                {passLabel(pass.passId)}
              </div>
              {passBad.bins.length === 0 ? (
                <div style={{ color: "var(--dimmed)", fontSize: 13 }}>
                  此 pass 无不良 bin 数据（良品 bin 已隐藏）
                </div>
              ) : (
                <DutDistPassChart
                  pass={passBad}
                  focusBin={focusBin}
                  goodBinNumbers={goodBinNumbers}
                  theme={theme}
                  chartHeight={(() => {
                    const xLbl = passBad.bins.length > 8 ? 34 : 20;
                    return dutDistChartHeight(passBad.bins.length, xLbl);
                  })()}
                />
              )}
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
