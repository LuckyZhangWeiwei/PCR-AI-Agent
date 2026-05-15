import { useCallback, useState } from "react";
import { apiGetJson } from "../api/client";
import { API_PREFIX } from "../api/paths";
import type { ManifestCatalogResponse } from "../api/types";

type Props = {
  apiBase: string;
  /** Nested under Settings — omit duplicate page chrome */
  embedded?: boolean;
};

function truncate(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + "…";
}

export function OverviewReport({ apiBase, embedded = false }: Props) {
  const [manifest, setManifest] = useState<ManifestCatalogResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiGetJson<ManifestCatalogResponse>(
        apiBase,
        `${API_PREFIX}/manifest`,
        undefined,
        { cache: "no-store" }
      );
      setManifest(res);
    } catch (e: unknown) {
      setManifest(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  const eps = manifest?.endpoints ?? [];

  return (
    <section className={`report-panel${embedded ? " report-panel--embedded" : ""}`}>
      <header className="report-panel-header">
        <div>
          {!embedded ? <h2>API 概览（v4）</h2> : null}
          <p className="report-desc">
            拉取 <code>{API_PREFIX}/manifest</code>，展示当前服务在{" "}
            <strong>v4 目录</strong> 下暴露的端点（<code>catalogScope</code> 一般为{" "}
            <code>v4-surfaces-only</code>）。便于核对报表所用路径是否与后端一致。
          </p>
        </div>
        <div className="report-actions">
          <button
            type="button"
            className="btn primary"
            onClick={load}
            disabled={loading}
          >
            {loading ? "加载中…" : "刷新 manifest"}
          </button>
        </div>
      </header>

      {error ? <div className="alert error">{error}</div> : null}

      {manifest ? (
        <div className="overview-meta card subtle">
          <p>
            <strong>{manifest.title ?? "pcr-ai-api"}</strong>
            {manifest.catalogScope ? (
              <>
                {" "}
                · <code>{manifest.catalogScope}</code>
              </>
            ) : null}
          </p>
          {manifest.description ? (
            <p className="muted small">{truncate(manifest.description, 360)}</p>
          ) : null}
          <p className="muted small">
            共 <strong>{eps.length}</strong> 条端点说明
          </p>
        </div>
      ) : null}

      <div className="endpoint-grid">
        {eps.map((ep, i) => (
          <article key={`${ep.path ?? i}-${i}`} className="endpoint-card card">
            <h3 className="endpoint-card-path">
              <code>{ep.path ?? "（无 path）"}</code>
            </h3>
            {ep.methods?.length ? (
              <p className="muted small">{ep.methods.join(", ")}</p>
            ) : null}
            <p className="endpoint-card-purpose">
              {ep.purpose ? truncate(ep.purpose, 220) : "—"}
            </p>
          </article>
        ))}
      </div>

      {!manifest && !loading && !error ? (
        <div className="card chart-placeholder subtle">
          <p>点击「刷新 manifest」加载 v4 端点目录。</p>
        </div>
      ) : null}
    </section>
  );
}
