import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { apiGetJson } from "./api/client";
import { API_PREFIX } from "./api/paths";
import { ReportListLimitsSettings } from "./components/ReportListLimitsSettings";
import { usePersistedApiBase } from "./hooks/usePersistedApiBase";
import { usePersistedReportLimits } from "./hooks/usePersistedReportLimits";
import {
  usePersistedAgentConfig,
  AGENT_MAX_ROUNDS_DEFAULT,
  AGENT_MAX_ROUNDS_MAX,
  AGENT_MAX_ROUNDS_MIN,
  AGENT_STREAM_TIMEOUT_SEC_DEFAULT,
  AGENT_STREAM_TIMEOUT_SEC_MAX,
  AGENT_STREAM_TIMEOUT_SEC_MIN,
  AGENT_CLIENT_TIMEOUT_SEC_DEFAULT,
  AGENT_CLIENT_TIMEOUT_SEC_MAX,
  AGENT_CLIENT_TIMEOUT_BUFFER_SEC,
} from "./hooks/usePersistedAgentConfig.js";
import { AiAgentReport } from "./reports/AiAgentReport";
import { InfcontrolReport } from "./reports/InfcontrolReport";
import { OverviewReport } from "./reports/OverviewReport";
import { TableRowsReport } from "./reports/TableRowsReport";
import { YieldMonitorReport } from "./reports/YieldMonitorReport";
import "./index.css";

type Tab = "yield" | "infcontrol" | "ai" | "table" | "settings";

export default function App() {
  const [apiBase, setApiBase, resetApiBase] = usePersistedApiBase();
  const [listLimits, setListLimits, resetListLimits] = usePersistedReportLimits();
  const [apiBaseInput, setApiBaseInput] = useState(apiBase);
  const [agentConfig, updateAgentConfig, resetAgentConfig] = usePersistedAgentConfig();
  const [agentApiKeyVisible, setAgentApiKeyVisible] = useState(false);

  // Sync input when apiBase changes externally (resetApiBase)
  useEffect(() => { setApiBaseInput(apiBase); }, [apiBase]);

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
    await new Promise((r) => setTimeout(r, 200));
    try {
      const d = await apiGetJson<{ ok?: boolean }>(
        apiBase,
        `${API_PREFIX}/db/ping`,
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
          <div className="app-brand-row">
            <span className="app-brand-badge">NXP</span>
            <h1 className="app-title-main">ATTJ WaferTest PCR Dashboard</h1>
            <div className="app-feature-chips">
              <span className="app-chip">Probe Card Yield Monitor</span>
              <span className="app-chip">Layer BIN Analysis</span>
              <span className="app-chip">Trigger Trends</span>
              <span className="app-chip app-chip--ai">✦ AI Query</span>
            </div>
          </div>
          <span className="app-hint">Select tab → Set filters → Query → Click chart to drill down · Yield% calculated from bins in browser</span>
        </div>
      </header>

      <nav className="tabs" aria-label="报表切换">
        <button
          type="button"
          className={`tab ${tab === "yield" ? "active" : ""}`}
          onClick={() => setTab("yield")}
        >
          ⚡ Yield Monitor
        </button>
        <button
          type="button"
          className={`tab ${tab === "infcontrol" ? "active" : ""}`}
          onClick={() => setTab("infcontrol")}
        >
          🔬 JB Star
        </button>
        <button
          type="button"
          className={`tab ${tab === "ai" ? "active" : ""}`}
          onClick={() => setTab("ai")}
        >
          🤖 AI Agent
        </button>
        <button
          type="button"
          className={`tab ${tab === "table" ? "active" : ""}`}
          onClick={() => setTab("table")}
        >
          📋 Table Browser
        </button>
        <button
          type="button"
          className={`tab tab-settings ${tab === "settings" ? "active" : ""}`}
          onClick={() => setTab("settings")}
        >
          ⚙ Settings
        </button>
      </nav>

      <div className="tab-panel" hidden={tab !== "yield"}>
        <YieldMonitorReport apiBase={apiBase} listLimits={listLimits} />
      </div>
      <div className="tab-panel" hidden={tab !== "infcontrol"}>
        <InfcontrolReport apiBase={apiBase} listLimits={listLimits} />
      </div>
      <div className="tab-panel" hidden={tab !== "ai"}>
        <AiAgentReport apiBase={apiBase} agentConfig={agentConfig} />
      </div>
      <div className="tab-panel" hidden={tab !== "table"}>
        <TableRowsReport apiBase={apiBase} listLimits={listLimits} />
      </div>
      <div className="tab-panel" hidden={tab !== "settings"}>
        <div className="settings-panel">
          <h2 className="settings-title">⚙ 设置</h2>
          <div className="api-panel">
            <label>
              <span>服务器地址</span>
              <input
                type="text"
                value={apiBaseInput}
                onChange={(e) => setApiBaseInput(e.target.value)}
                onBlur={(e) => setApiBase(e.target.value)}
                spellCheck={false}
                autoComplete="off"
                placeholder={
                  import.meta.env.DEV &&
                  String(import.meta.env.VITE_DEV_API_VIA_PROXY ?? "")
                    .toLowerCase() === "true"
                    ? "留空：经本站 Vite 转发（推荐）"
                    : "http://10.192.130.89:30008"
                }
              />
            </label>
            <span className="field-hint">
              {import.meta.env.DEV &&
              String(import.meta.env.VITE_DEV_API_VIA_PROXY ?? "")
                .toLowerCase() === "true" ? (
                <>
                  开发模式默认<strong>走 Vite 代理</strong>到{" "}
                  {import.meta.env.VITE_DEV_PROXY_TARGET ?? "网关"}（地址栏留空或点「恢复默认」）。
                  若在此填写内网 <code>http://10.x...</code>，Chrome 可能拦截跨站访问私网。
                </>
              ) : (
                <>一般无需修改；若打不开数据，请向同事确认地址。</>
              )}
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
              <span className={healthOk === null ? "pill" : healthOk ? "pill ok" : "pill bad"}>
                服务 <strong>{healthOk === null ? "…" : healthOk ? "正常" : "不可用"}</strong>
              </span>
              <span className={dbOk === null ? "pill" : dbOk ? "pill ok" : "pill bad"}>
                数据库 <strong>{dbOk === null ? "…" : dbOk ? "正常" : "异常"}</strong>
              </span>
              {probeMsg ? <span className="muted small">{probeMsg}</span> : null}
            </div>
          </div>

          <ReportListLimitsSettings
            limits={listLimits}
            onChange={setListLimits}
            onReset={resetListLimits}
          />

          <section className="settings-section">
            <h2 className="settings-section-title">AI Agent 配置</h2>
            <div className="api-panel">
              <label>
                <span>API Key</span>
                <div className="api-panel-key-row">
                  <input
                    type={agentApiKeyVisible ? "text" : "password"}
                    value={agentConfig.apiKey}
                    placeholder="sk-..."
                    onChange={(e) => updateAgentConfig({ apiKey: e.target.value })}
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    className="btn ghost"
                    onClick={() => setAgentApiKeyVisible((v) => !v)}
                    title={agentApiKeyVisible ? "隐藏" : "显示"}
                  >
                    {agentApiKeyVisible ? "🙈" : "👁"}
                  </button>
                </div>
              </label>
              <label>
                <span>API Base URL</span>
                <input type="text" value={agentConfig.apiBase} onChange={(e) => updateAgentConfig({ apiBase: e.target.value })} />
              </label>
              <label>
                <span>模型</span>
                <input type="text" value={agentConfig.model} onChange={(e) => updateAgentConfig({ model: e.target.value })} />
              </label>
              <label>
                <span>最大推理轮数（{AGENT_MAX_ROUNDS_MIN}–{AGENT_MAX_ROUNDS_MAX}）</span>
                <input
                  type="number"
                  min={AGENT_MAX_ROUNDS_MIN}
                  max={AGENT_MAX_ROUNDS_MAX}
                  value={agentConfig.maxRounds}
                  onChange={(e) =>
                    updateAgentConfig({ maxRounds: Number(e.target.value) })
                  }
                />
              </label>
              <p className="field-hint">
                Agent 连续调用工具的上限；跨表分析、INF 下钻等复杂问题可适当提高（默认{" "}
                {AGENT_MAX_ROUNDS_DEFAULT}）。
              </p>
              <label>
                <span>
                  流式 idle 超时（秒，{AGENT_STREAM_TIMEOUT_SEC_MIN}–
                  {AGENT_STREAM_TIMEOUT_SEC_MAX}）
                </span>
                <input
                  type="number"
                  min={AGENT_STREAM_TIMEOUT_SEC_MIN}
                  max={AGENT_STREAM_TIMEOUT_SEC_MAX}
                  value={agentConfig.streamTimeoutSec}
                  onChange={(e) =>
                    updateAgentConfig({ streamTimeoutSec: Number(e.target.value) })
                  }
                />
              </label>
              <p className="field-hint">
                后端等待 LLM 流式输出的 idle 上限；有 SSE 字节会重置计时（默认{" "}
                {AGENT_STREAM_TIMEOUT_SEC_DEFAULT}）。
              </p>
              <label>
                <span>
                  客户端总超时（秒，至少流式 + {AGENT_CLIENT_TIMEOUT_BUFFER_SEC}，最大{" "}
                  {AGENT_CLIENT_TIMEOUT_SEC_MAX}）
                </span>
                <input
                  type="number"
                  min={
                    agentConfig.streamTimeoutSec + AGENT_CLIENT_TIMEOUT_BUFFER_SEC
                  }
                  max={AGENT_CLIENT_TIMEOUT_SEC_MAX}
                  value={agentConfig.clientTimeoutSec}
                  onChange={(e) =>
                    updateAgentConfig({ clientTimeoutSec: Number(e.target.value) })
                  }
                />
              </label>
              <p className="field-hint">
                浏览器整次聊天请求的最长等待，应略大于流式 idle 超时（默认{" "}
                {AGENT_CLIENT_TIMEOUT_SEC_DEFAULT}）。
              </p>
              <div className="api-panel-actions">
                <button type="button" className="btn ghost" onClick={resetAgentConfig}>
                  恢复默认
                </button>
              </div>
            </div>
          </section>

          <section className="settings-section settings-section--catalog" aria-labelledby="settings-api-catalog">
            <h2 id="settings-api-catalog" className="settings-section-title">
              🗂️ API 目录
            </h2>
            <OverviewReport apiBase={apiBase} embedded />
          </section>
        </div>
      </div>
    </div>
  );
}
