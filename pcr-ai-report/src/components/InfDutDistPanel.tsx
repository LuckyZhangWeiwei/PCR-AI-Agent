import { useEffect, useState } from "react";
import type { EChartsOption } from "echarts";
import { apiGetJson } from "../api/client";
import { SITE_BIN_BY_LOT_PATH } from "../api/paths";
import type { SiteBinByLotResponse, SiteBinPass } from "../api/types";
import { DarkChart } from "./DarkChart";
import { buildInfPath } from "../utils/buildInfPath";
import { goodBinNumbersKey, isGoodBinLabel } from "../utils/infGoodBins";
import {
  baseChartOption,
  chartAxisColor,
  chartTextColor,
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
  const good =
    goodBinNumbers?.size ? goodBinNumbers : new Set<number>([1]);
  const bins = pass.bins.filter((b) => !isGoodBinLabel(b.bin, good));
  return { ...pass, bins };
}

function dutSeriesDieCount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value && typeof value === "object" && "value" in value) {
    const v = (value as { value: unknown }).value;
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return 0;
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
    formatter(params: unknown) {
      const items = (Array.isArray(params) ? params : [params]) as {
        axisValue?: string;
        seriesName?: string;
        marker?: string;
        value?: unknown;
      }[];
      if (!items.length) return "";
      const header = String(items[0]?.axisValue ?? "");
      const lines = items
        .filter((p) => dutSeriesDieCount(p.value) !== 0)
        .map(
          (p) =>
            `${p.marker ?? ""} ${p.seriesName ?? ""}: ${dutSeriesDieCount(p.value)}`
        );
      if (!lines.length) return header;
      return `${header}<br/>${lines.join("<br/>")}`;
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

function buildDutChartOption(
  pass: SiteBinPass,
  focusBin: string | undefined
): EChartsOption {
  const bins = pass.bins.map((b) => b.bin);
  const dutSet = new Set<string>();
  for (const b of pass.bins) {
    for (const d of b.duts) dutSet.add(String(d.dut));
  }
  const duts = [...dutSet].sort((a, b) => {
    if (a === "single") return 1;
    if (b === "single") return -1;
    return Number(a) - Number(b);
  });

  /** 底部图例约每行 8 项（plain + width 自动换行） */
  const legendRows = Math.max(1, Math.ceil(duts.length / 8));
  const legendArea = legendRows * 13 + 2;
  const xLabelBottom = bins.length > 8 ? 34 : 20;
  /** 图例底边对齐 x 轴标签区上沿，整体贴近柱状图 */
  const legendBottom = xLabelBottom;

  const series: EChartsOption["series"] = duts.map((dut) => ({
    name: dut === "single" ? "Single" : `DUT ${dut}`,
    type: "bar",
    stack: "total",
    barMaxWidth: 16,
    barCategoryGap: "35%",
    data: bins.map((bin) => {
      const binEntry = pass.bins.find((b) => b.bin === bin);
      const dutEntry = binEntry?.duts.find((d) => String(d.dut) === dut);
      const val = dutEntry?.dieCount ?? 0;
      const dimmed = focusBin !== undefined && bin !== focusBin;
      return {
        value: val,
        itemStyle: dimmed ? { opacity: 0.3 } : undefined,
      };
    }),
    emphasis: { focus: "series" },
  }));

  return {
    ...baseChartOption(),
    grid: {
      left: 40,
      right: 12,
      top: 20,
      bottom: legendBottom + legendArea,
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
      nameTextStyle: { color: chartAxisColor, fontSize: 9 },
      axisLabel: { color: chartAxisColor, fontSize: 9 },
    },
    legend: {
      type: "plain",
      orient: "horizontal",
      bottom: legendBottom,
      left: "center",
      width: "92%",
      padding: [0, 0, 0, 0],
      textStyle: { color: chartTextColor, fontSize: 9 },
      itemWidth: 8,
      itemHeight: 6,
      itemGap: 5,
    },
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
                <DarkChart
                  key={`pass-${pass.passId}-good-${goodBinNumbersKey(goodBinNumbers)}`}
                  option={buildDutChartOption(passBad, focusBin)}
                  height={(() => {
                    const dutN = new Set(
                      passBad.bins.flatMap((b) =>
                        b.duts.map((d) => String(d.dut))
                      )
                    ).size;
                    const xLbl = passBad.bins.length > 8 ? 34 : 20;
                    const legendH = Math.max(1, Math.ceil(dutN / 8)) * 13 + 2;
                    return Math.max(
                      150,
                      passBad.bins.length * 14 + 52 + xLbl + legendH
                    );
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
