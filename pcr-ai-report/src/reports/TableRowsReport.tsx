import { useCallback, useMemo, useState } from "react";
import { apiGetJson } from "../api/client";
import type { TableRowsResponse } from "../api/types";
import { DataTable } from "../components/DataTable";

type Props = {
  apiBase: string;
};

function numOrUndef(s: string): number | undefined {
  if (!s.trim()) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

export function TableRowsReport({ apiBase }: Props) {
  const [table, setTable] = useState("");
  const [limit, setLimit] = useState("50");
  const [data, setData] = useState<TableRowsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requestParams = useMemo(
    () => ({
      table: table.trim() || undefined,
      limit: numOrUndef(limit),
    }),
    [table, limit]
  );

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiGetJson<TableRowsResponse>(
        apiBase,
        "/api/v1/table-rows",
        requestParams
      );
      setData(res);
    } catch (e: unknown) {
      setData(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [apiBase, requestParams]);

  return (
    <section className="report-panel">
      <header className="report-panel-header">
        <div>
          <h2>数据表浏览（运维）</h2>
          <p className="report-desc">
            直接预览数据库里某张表的前若干行，便于核对字段。
            <strong>若无权限或不了解表名，请不要使用本页</strong>
            ，请优先用「yield monitor」或「JB START」。
          </p>
        </div>
        <div className="report-actions">
          <button
            type="button"
            className="btn primary"
            onClick={run}
            disabled={loading}
          >
            {loading ? "加载中…" : "读取"}
          </button>
        </div>
      </header>

      <div className="filter-grid">
        <label className="span-2">
          <span>表名（可不填则用后台默认表）</span>
          <input
            value={table}
            onChange={(e) => setTable(e.target.value)}
            placeholder="例如 OWNER.TABLE"
            spellCheck={false}
          />
        </label>
        <label>
          <span>最多读多少行（≤500）</span>
          <input
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
            inputMode="numeric"
          />
        </label>
      </div>

      {error ? <div className="alert error">{error}</div> : null}

      {data ? (
        <>
          <div className="report-meta">
            <span>
              表 <strong>{data.table}</strong> · 本次读取最多{" "}
              <strong>{data.limit}</strong> 行 · 实际返回{" "}
              <strong>{data.rows?.length ?? 0}</strong> 行
            </span>
          </div>
          <div className="card">
            <h3 className="card-title">预览</h3>
            <DataTable rows={data.rows ?? []} maxHeight={560} />
          </div>
        </>
      ) : null}
    </section>
  );
}
