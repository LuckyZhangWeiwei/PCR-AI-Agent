import { useEffect, useState } from "react";
import { apiGetJson } from "../api/client";
import { LOT_UNDERPERFORMING_DUTS_PATH } from "../api/paths";

type DutRow = {
  dut: number;
  goodDie: number;
  totalDie: number;
  yieldPct: number;
  gapToThresholdPct?: number;
};

type PassResult = {
  passId: number;
  sortLabel: string;
  dutCount: number;
  lotGoodDie: number;
  lotTotalDie: number;
  baseline: {
    method: "lotOverall";
    yieldPct: number;
    thresholdPct: number;
    thresholdRatio: number;
  } | null;
  underperformingDuts: DutRow[];
};

export type LotUnderperformingDutsResponse = {
  device: string;
  lot: string;
  probeCardType?: string;
  passIds: number[];
  waferCount: number;
  filters: { thresholdRatio: number; baselineMethod: string };
  passes: PassResult[];
};

type Props = {
  apiBase: string;
  lot: string;
  device?: string;
  thresholdRatio?: number;
};

export function LotUnderperformingDutsPanel({
  apiBase,
  lot,
  device,
  thresholdRatio = 0.75,
}: Props) {
  const [data, setData] = useState<LotUnderperformingDutsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const lotTrim = lot.trim();
    if (!lotTrim) {
      setData(null);
      setError(null);
      return;
    }

    const params: Record<string, string | number> = {
      lot: lotTrim,
      thresholdRatio,
    };
    const deviceTrim = device?.trim();
    if (deviceTrim) params.device = deviceTrim;

    let cancelled = false;
    setLoading(true);
    setError(null);
    void apiGetJson<LotUnderperformingDutsResponse>(apiBase, LOT_UNDERPERFORMING_DUTS_PATH, params)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setData(null);
          setError(e instanceof Error ? e.message : String(e));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [apiBase, lot, device, thresholdRatio]);

  if (!lot.trim()) return null;

  return (
    <div
      className="report-chart-panel"
      style={{
        background: "#0d1117",
        border: "1px solid rgba(240,246,252,0.1)",
        borderRadius: 8,
        padding: 16,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: "#e6edf3" }}>
        低良率 DUT（DUT 良率 &lt; lot 整体 × {thresholdRatio}）
      </div>
      {loading ? (
        <p className="muted small">正在加载 INF DUT 良率…</p>
      ) : error ? (
        <p style={{ color: "#f85149", fontSize: 12 }}>{error}</p>
      ) : data ? (
        <>
          <p className="muted small" style={{ margin: "0 0 12px" }}>
            {data.device} · {data.lot}
            {data.probeCardType ? ` · 卡型 ${data.probeCardType}` : ""} · {data.waferCount} 片 wafer
          </p>
          {data.passes.map((pass) => (
            <div key={pass.passId} style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, color: "#8b949e", marginBottom: 6 }}>
                {pass.sortLabel}
                {pass.baseline
                  ? ` — lot 整体 ${pass.baseline.yieldPct}% · 阈值 ${pass.baseline.thresholdPct}%`
                  : " — 无有效 die 数据"}
              </div>
              {pass.underperformingDuts.length === 0 ? (
                <p className="muted small" style={{ margin: 0 }}>
                  无低于阈值的 DUT
                </p>
              ) : (
                <table className="data-table" style={{ fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th>DUT</th>
                      <th>良率%</th>
                      <th>good/total</th>
                      <th>距阈值%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pass.underperformingDuts.map((d) => (
                      <tr key={d.dut}>
                        <td>DUT{d.dut}</td>
                        <td>{d.yieldPct}</td>
                        <td>
                          {d.goodDie}/{d.totalDie}
                        </td>
                        <td>{d.gapToThresholdPct ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))}
        </>
      ) : null}
    </div>
  );
}
