import {
  API_LIST_LIMIT_CEILING,
  REPORT_LIST_LIMITS_DEFAULT,
  type ReportListLimits,
} from "../hooks/usePersistedReportLimits";

type Props = {
  limits: ReportListLimits;
  onChange: (patch: Partial<ReportListLimits>) => void;
  onReset: () => void;
};

export function ReportListLimitsSettings({ limits, onChange, onReset }: Props) {
  return (
    <section
      className="settings-section settings-section--limits"
      aria-labelledby="settings-list-limits"
    >
      <h2 id="settings-list-limits" className="settings-section-title">
        📊 明细行数（Yield / JB START）
      </h2>
      <div className="api-panel settings-limits-panel">
        <p className="field-hint settings-limits-intro">
          仅限制<strong>明细表</strong>（<code>GET …/v4</code>）返回行数；<strong>不</strong>
          影响 BIN 排名、探针卡类型等<strong>图表聚合</strong>（聚合在库内统计全部匹配行）。
          上限不超过 API 允许的 {API_LIST_LIMIT_CEILING} 行。修改后<strong>下次点「查询」</strong>
          生效。
        </p>
        <div className="settings-limits-grid">
          <label>
            <span>默认条数</span>
            <input
              type="number"
              min={1}
              max={limits.maxLimit}
              value={limits.defaultLimit}
              onChange={(e) =>
                onChange({ defaultLimit: Number(e.target.value) })
              }
            />
          </label>
          <label>
            <span>最多条数（≤ {API_LIST_LIMIT_CEILING}）</span>
            <input
              type="number"
              min={1}
              max={API_LIST_LIMIT_CEILING}
              value={limits.maxLimit}
              onChange={(e) => onChange({ maxLimit: Number(e.target.value) })}
            />
          </label>
        </div>
        <div className="api-panel-actions">
          <button type="button" className="btn ghost" onClick={onReset}>
            恢复默认（{REPORT_LIST_LIMITS_DEFAULT.defaultLimit} /{" "}
            {REPORT_LIST_LIMITS_DEFAULT.maxLimit}）
          </button>
        </div>
      </div>
    </section>
  );
}
