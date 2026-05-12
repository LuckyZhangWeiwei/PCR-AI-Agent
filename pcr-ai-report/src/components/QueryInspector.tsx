import { useCallback, useMemo, useState } from "react";
import { buildUrl } from "../api/client";
import "./QueryInspector.css";

type Props = {
  apiBase: string;
  path: string;
  requestParams: Record<
    string,
    string | number | boolean | undefined | null
  >;
  appliedFilters?: Record<string, unknown> | null;
};

export function QueryInspector({
  apiBase,
  path,
  requestParams,
  appliedFilters,
}: Props) {
  const url = useMemo(() => {
    return buildUrl(
      apiBase,
      path,
      requestParams as Record<
        string,
        string | number | boolean | undefined | null
      >
    );
  }, [apiBase, path, JSON.stringify(requestParams)]);

  const [copied, setCopied] = useState(false);

  const copyUrl = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("请手动复制下方链接", url);
    }
  }, [url]);

  const copyJson = useCallback(async () => {
    const text = JSON.stringify(appliedFilters ?? {}, null, 2);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      window.prompt("请手动复制", text);
    }
  }, [appliedFilters]);

  return (
    <details className="query-inspector">
      <summary>高级 · 复制链接与原始筛选参数</summary>
      <div className="query-inspector-inner">
        <p className="muted small query-inspector-lead">
          下列内容供核对或与同事沟通时使用；日常看图看表即可。
        </p>
        <div className="query-inspector-actions">
          <button type="button" className="btn secondary" onClick={copyUrl}>
            {copied ? "已复制" : "复制本次查询链接"}
          </button>
          {appliedFilters ? (
            <button type="button" className="btn ghost" onClick={copyJson}>
              复制筛选参数（JSON）
            </button>
          ) : null}
        </div>
        <label className="query-url-field">
          <span>完整链接</span>
          <input readOnly value={url} spellCheck={false} />
        </label>
        {appliedFilters && Object.keys(appliedFilters).length > 0 ? (
          <div className="query-filters-block">
            <span className="query-filters-label">
              服务端最终采用的筛选（规范化之后）
            </span>
            <pre className="query-filters-pre">
              {JSON.stringify(appliedFilters, null, 2)}
            </pre>
          </div>
        ) : (
          <p className="muted small query-inspector-hint">
            查询成功后，会在这里显示服务端确认的筛选条件。
          </p>
        )}
      </div>
    </details>
  );
}
