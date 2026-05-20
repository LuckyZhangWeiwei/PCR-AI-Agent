import { useEffect, useState } from "react";
import ReactECharts from "echarts-for-react";
import type { EChartsOption } from "echarts";
import { apiGetJson } from "../api/client";
import { SITE_BIN_BY_LOT_PATH } from "../api/paths";
import type { SiteBinByLotResponse, SiteBinPass } from "../api/types";
import { buildInfPath } from "../utils/buildInfPath";
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
  apiBase: string;
  onClose: () => void;
};

function passLabel(passId: number): string {
  if (passId === 1) return "Pass 1 (sort1 · 常温)";
  if (passId === 3) return "Pass 3 (sort2 · 高温)";
  if (passId === 5) return "Pass 5 (sort3 · 低温)";
  return `Pass ${passId}`;
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

  const series: EChartsOption["series"] = duts.map((dut) => ({
    name: dut === "single" ? "Single" : `DUT ${dut}`,
    type: "bar",
    stack: "total",
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
    xAxis: {
      type: "category",
      data: bins,
      axisLabel: { color: chartAxisColor, rotate: bins.length > 8 ? 30 : 0 },
    },
    yAxis: {
      type: "value",
      name: "die count",
      nameTextStyle: { color: chartAxisColor },
      axisLabel: { color: chartAxisColor },
    },
    legend: { textStyle: { color: chartTextColor }, top: 0 },
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
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

  const title = `INF · DUT 分布 — LOT ${lot} · Slot ${slot}${cardId ? ` · 卡 ${cardId}` : ""}`;

  return (
    <div
      style={{
        background: "#0d1117",
        border: "1px solid rgba(240,246,252,0.1)",
        borderRadius: 8,
        padding: 16,
        marginTop: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 12,
        }}
      >
        <span style={{ fontSize: 13, color: "#8b949e", fontWeight: 600 }}>
          {title}
        </span>
        <button
          type="button"
          onClick={onClose}
          style={{
            background: "none",
            border: "none",
            color: "#8b949e",
            cursor: "pointer",
            fontSize: 16,
            lineHeight: 1,
            padding: "0 4px",
          }}
          aria-label="关闭"
        >
          ✕
        </button>
      </div>

      {loading && (
        <div
          style={{
            height: 160,
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
          {data.passes.map((pass) => (
            <div key={pass.passId} style={{ marginBottom: 16 }}>
              <div
                style={{ fontSize: 12, color: "#8b949e", marginBottom: 6 }}
              >
                {passLabel(pass.passId)}
              </div>
              {pass.bins.length === 0 ? (
                <div style={{ color: "#6e7681", fontSize: 12 }}>
                  此 pass 无 bin 数据
                </div>
              ) : (
                <ReactECharts
                  option={buildDutChartOption(pass, focusBin)}
                  style={{
                    height: Math.max(200, pass.bins.length * 20 + 80),
                    width: "100%",
                  }}
                  opts={{ renderer: "canvas" }}
                  notMerge
                  lazyUpdate
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
