import { useCallback, useLayoutEffect, useState } from "react";
import { apiGetJson } from "./api/client";
import { usePersistedApiBase } from "./hooks/usePersistedApiBase";
import { InfcontrolReport } from "./reports/InfcontrolReport";
import { YieldMonitorReport } from "./reports/YieldMonitorReport";
import "./index.css";

type Tab = "yield" | "infcontrol";

export default function App() {
  const [apiBase, setApiBase, resetApiBase] = usePersistedApiBase();
  const [tab, setTab] = useState<Tab>("yield");

  /** 切换 tab 时子面板从隐藏变为可见，通知图表重新计算尺寸（ECharts） */
  useLayoutEffect(() => {
    const id = requestAnimationFrame(() => {
      window.dispatchEvent(new Event("resize"));
    });
    return () => cancelAnimationFrame(id);
  }, [tab]);

  const [healthOk, setHealthOk] = useState<boolean | null>(null);
  const [dbOk, setDbOk] = useState<boolean | null>(null);
  const [probeMsg, setProbeMsg] = useState<string | null>(null);

  const probe = useCallback(async () => {
    setProbeMsg(null);
    setHealthOk(null);
    setDbOk(null);
    try {
      const h = await apiGetJson<{ status?: string }>(
        apiBase,
        "/health",
        undefined,
        { cache: "no-store" }
      );
      setHealthOk(h.status === "ok");
    } catch {
      setHealthOk(false);
    }
    try {
      const d = await apiGetJson<{ ok?: boolean }>(
        apiBase,
        "/api/v1/db/ping",
        undefined,
        { cache: "no-store" }
      );
      setDbOk(d.ok === true);
    } catch {
      setDbOk(false);
    }
    setProbeMsg("已刷新");
    setTimeout(() => setProbeMsg(null), 2400);
  }, [apiBase]);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-title-block">
          <h1>PCR 数据看板</h1>
          <p>
            用图表和表格查看测试与产量相关记录，仅供查询、不修改数据。
          </p>
          <p className="app-intro">
            <strong>怎么用：</strong>
            下面选一个主题 → 按需填写筛选项（留空表示不按该项筛选）→ 点「查询」。
            JB START 明细列表条数可在页面设置（默认约 200，上限见接口）；需要更细条件时请缩小时间范围或加上批次、设备等。
          </p>
        </div>

        <div className="api-panel">
          <label>
            <span>服务器地址</span>
            <input
              type="text"
              value={apiBase}
              onChange={(e) => setApiBase(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              placeholder="http://10.192.130.89:30008"
            />
          </label>
          <span className="field-hint">
            一般无需修改；若打不开数据，请向同事确认地址。
          </span>
          <div className="api-panel-actions">
            <button type="button" className="btn ghost" onClick={resetApiBase}>
              恢复默认地址
            </button>
            <button type="button" className="btn secondary" onClick={probe}>
              检查连接
            </button>
          </div>
          <div className="status-row">
            <span
              className={
                healthOk === null
                  ? "pill"
                  : healthOk
                    ? "pill ok"
                    : "pill bad"
              }
            >
              服务{" "}
              <strong>
                {healthOk === null ? "…" : healthOk ? "正常" : "不可用"}
              </strong>
            </span>
            <span
              className={
                dbOk === null ? "pill" : dbOk ? "pill ok" : "pill bad"
              }
            >
              数据库{" "}
              <strong>{dbOk === null ? "…" : dbOk ? "正常" : "异常"}</strong>
            </span>
            {probeMsg ? <span className="muted small">{probeMsg}</span> : null}
          </div>
        </div>
      </header>

      <nav className="tabs" aria-label="报表切换">
        <button
          type="button"
          className={`tab ${tab === "yield" ? "active" : ""}`}
          onClick={() => setTab("yield")}
        >
          yield monitor
        </button>
        <button
          type="button"
          className={`tab ${tab === "infcontrol" ? "active" : ""}`}
          onClick={() => setTab("infcontrol")}
        >
          JB START
        </button>
      </nav>

      <div className="tab-panel" hidden={tab !== "yield"}>
        <YieldMonitorReport apiBase={apiBase} />
      </div>
      <div className="tab-panel" hidden={tab !== "infcontrol"}>
        <InfcontrolReport apiBase={apiBase} />
      </div>
    </div>
  );
}
