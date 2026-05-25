import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ECharts } from "echarts";
import type { EChartsOption } from "echarts";
import { apiGetJson } from "../api/client";
import { SITE_BIN_BY_LOT_PATH } from "../api/paths";
import type { SiteBinByLotResponse, SiteBinPass } from "../api/types";
import { DarkChart } from "./DarkChart";
import { buildInfPath } from "../utils/buildInfPath";
import { filterSiteBinPassBadOnly, goodBinNumbersKey, normalizeGoodBinSet, isGoodBinLabel } from "../utils/infGoodBins";
import {
  baseChartOption,
  chartAxisColor,
} from "../theme/chartTheme";

type Props = {
  device: string;
  lot: string;
  slot: number;
  passIds: number[];
  cardId?: string;
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
  return filterSiteBinPassBadOnly(pass, goodBinNumbers);
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
  if (itemCount <= 8) return 1;
  if (itemCount <= 20) return 2;
  if (itemCount <= 45) return 3;
  return 4;
}

type DutTipRow = { html: string; seriesIndex: number };

function formatDutDistTooltipHtml(header: string, rows: DutTipRow[]): string {
  if (!rows.length) return header;
  const cols = dutDistTooltipColumns(rows.length);
  const cells = rows
    .map(
      (row) =>
        `<div class="dut-tip-row" data-series-index="${row.seriesIndex}" style="white-space:nowrap;line-height:1.55;font-size:11px;display:flex;align-items:center;gap:5px;">${row.html}</div>`
    )
    .join("");
  return [
    `<div style="font-weight:600;margin-bottom:6px;font-size:12px;">${header}</div>`,
    `<div style="display:grid;grid-template-columns:repeat(${cols},auto);column-gap:16px;row-gap:3px;max-height:min(340px,62vh);overflow-y:auto;overflow-x:hidden;">`,
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
function dutDistTooltip(): EChartsOption["tooltip"] {
  const base = baseChartOption().tooltip as Record<string, unknown> | undefined;
  return {
    ...base,
    trigger: "axis",
    axisPointer: { type: "shadow" },
    appendToBody: true,
    confine: true,
    enterable: true,
    extraCssText:
      "max-width:min(580px,96vw);padding:10px 12px;line-height:1.5;",
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
      const rows = items
        .filter((p) => dutSeriesDieCount(p.value) !== 0)
        .map((p) => ({
          seriesIndex: p.seriesIndex ?? 0,
          html: `${enlargeDutTooltipMarker(p.marker)} ${p.seriesName ?? ""}: ${dutSeriesDieCount(p.value)}`,
        }));
      return formatDutDistTooltipHtml(header, rows);
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
  const gridTop = 32;
  const minPlot = 128;
  const byBins = binCount * 14 + gridTop + 36 + xLabelBottom;
  return Math.max(gridTop + xLabelBottom + minPlot, byBins, 160);
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
  activeIndex,
  onEnter,
  onLeave,
}: {
  items: DutSeriesItem[];
  activeIndex: number | null;
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
            activeIndex === item.seriesIndex
              ? "dut-dist-html-legend-item--active"
              : "",
            activeIndex !== null && activeIndex !== item.seriesIndex
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

const DUT_SERIES_EMPHASIS = {
  focus: "series" as const,
  itemStyle: {
    borderWidth: 1.5,
    borderColor: "rgba(255,255,255,0.85)",
    shadowBlur: 10,
    shadowColor: "rgba(255,255,255,0.28)",
  },
};

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
}: {
  pass: SiteBinPass;
  focusBin?: string;
  goodBinNumbers?: ReadonlySet<number>;
  chartHeight: number;
}) {
  const chartRef = useRef<ECharts | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const clearTimerRef = useRef<number | null>(null);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const seriesList = useMemo(() => extractDutSeriesList(pass), [pass]);
  const option = useMemo(
    () => buildDutChartOption(pass, focusBin, goodBinNumbers),
    [pass, focusBin, goodBinNumbers]
  );

  const applyHighlight = useCallback((idx: number | null) => {
    if (clearTimerRef.current != null) {
      window.clearTimeout(clearTimerRef.current);
      clearTimerRef.current = null;
    }
    setActiveIndex(idx);
    if (idx == null) downplayDutSeries(chartRef.current);
    else highlightDutSeries(chartRef.current, idx);
  }, []);

  const scheduleClearHighlight = useCallback(() => {
    if (clearTimerRef.current != null) {
      window.clearTimeout(clearTimerRef.current);
    }
    clearTimerRef.current = window.setTimeout(() => {
      clearTimerRef.current = null;
      if (tooltipHovered()) return;
      if (wrapRef.current?.matches(":hover")) return;
      applyHighlight(null);
    }, 48);
  }, [applyHighlight]);

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
      if (clearTimerRef.current != null) {
        window.clearTimeout(clearTimerRef.current);
      }
    };
  }, [applyHighlight, scheduleClearHighlight]);

  const onEvents = useMemo(
    () => ({
      mouseover: (params: unknown) => {
        const p = params as { componentType?: string; seriesIndex?: number };
        if (p.componentType !== "series" || p.seriesIndex == null) return;
        applyHighlight(p.seriesIndex);
      },
      globalout: () => {
        scheduleClearHighlight();
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
        activeIndex={activeIndex}
        onEnter={applyHighlight}
        onLeave={scheduleClearHighlight}
      />
    </div>
  );
}

function buildDutChartOption(
  pass: SiteBinPass,
  focusBin: string | undefined,
  goodBinNumbers: ReadonlySet<number> | undefined
): EChartsOption {
  const good = normalizeGoodBinSet(goodBinNumbers);
  const badBinEntries = pass.bins.filter((b) => !isGoodBinLabel(b.bin, good));
  const bins = badBinEntries.map((b) => b.bin);
  const seriesList = extractDutSeriesList({ ...pass, bins: badBinEntries });
  const xLabelBottom = bins.length > 8 ? 34 : 20;
  const gridTop = 32;

  const series: EChartsOption["series"] = seriesList.map((item) => ({
    name: item.seriesName,
    type: "bar",
    stack: "total",
    barMaxWidth: 16,
    barCategoryGap: "35%",
    itemStyle: { color: item.color },
    data: bins.map((bin) => {
      const binEntry = badBinEntries.find((b) => b.bin === bin);
      const dutEntry = binEntry?.duts.find(
        (d) => String(d.dut) === item.dutKey
      );
      const val = dutEntry?.dieCount ?? 0;
      const dimmed = focusBin !== undefined && bin !== focusBin;
      return {
        value: val,
        itemStyle: dimmed ? { opacity: 0.3 } : undefined,
      };
    }),
    emphasis: DUT_SERIES_EMPHASIS,
    blur: DUT_SERIES_BLUR,
  }));

  return {
    ...baseChartOption(),
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
      axisLabel: { color: chartAxisColor, rotate: bins.length > 8 ? 30 : 0, fontSize: 9 },
    },
    yAxis: {
      type: "value",
      name: "die count",
      nameLocation: "end",
      nameGap: 10,
      nameTextStyle: { color: chartAxisColor, fontSize: 9, align: "left" },
      axisLabel: {
        color: chartAxisColor,
        fontSize: 9,
        margin: 10,
        hideOverlap: false,
      },
      splitLine: { lineStyle: { color: "rgba(240,246,252,0.06)" } },
    },
    legend: { show: false },
    tooltip: dutDistTooltip(),
    series,
  };
}

export function InfDutDistPanel({
  device,
  lot,
  slot,
  passIds,
  cardId,
  focusBin,
  goodBinNumbers,
  apiBase,
  onClose,
}: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<SiteBinByLotResponse | null>(null);

  const infPath = buildInfPath(device, lot, slot);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);

    const params: Record<string, string | number | boolean | undefined | null> = {
      infPath,
      passId: passIds.join(","),
    };

    apiGetJson<SiteBinByLotResponse>(apiBase, SITE_BIN_BY_LOT_PATH, params)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [apiBase, infPath, passIds.join(",")]);

  const meta = `LOT ${lot} · Slot ${slot}${cardId ? ` · 卡 ${cardId}` : ""} · Device ${device}`;

  return (
    <div className="inf-dut-dist-panel">
      <div className="inf-dut-dist-panel-meta">
        <span className="muted small">{meta}</span>
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
            background: "rgba(240,246,252,0.04)",
            borderRadius: 4,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#6e7681",
            fontSize: 13,
          }}
        >
          加载中…
        </div>
      )}

      {!loading && error && (
        <div style={{ color: "#f85149", fontSize: 13 }}>
          <div>读取失败：{error}</div>
          <div style={{ marginTop: 4, fontSize: 11, color: "#6e7681" }}>
            路径：{infPath}
          </div>
        </div>
      )}

      {!loading && !error && data && (
        <div>
          {data.passes.length === 0 && (
            <div style={{ color: "#8b949e", fontSize: 13 }}>
              未找到匹配的 pass 数据（infPath: {infPath}）
            </div>
          )}
          {data.passes.map((pass) => {
            const passBad = filterPassBadBinsOnly(pass, goodBinNumbers);
            return (
            <div key={pass.passId} style={{ marginBottom: 10 }}>
              <div
                style={{ fontSize: 11, color: "#8b949e", marginBottom: 4 }}
              >
                {passLabel(pass.passId)}
              </div>
              {passBad.bins.length === 0 ? (
                <div style={{ color: "#6e7681", fontSize: 12 }}>
                  此 pass 无不良 bin 数据（良品 bin 已隐藏）
                </div>
              ) : (
                <DutDistPassChart
                  pass={passBad}
                  focusBin={focusBin}
                  goodBinNumbers={goodBinNumbers}
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
