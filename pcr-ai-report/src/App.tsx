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
  AGENT_TOOL_RESULT_MAX_CHARS_DEFAULT,
  AGENT_TOOL_RESULT_MAX_CHARS_MAX,
  AGENT_TOOL_RESULT_MAX_CHARS_MIN,
  AGENT_TOOL_RESULT_MAX_HISTORY_CHARS_DEFAULT,
  AGENT_TOOL_RESULT_MAX_HISTORY_CHARS_MAX,
  AGENT_TOOL_RESULT_MAX_HISTORY_CHARS_MIN,
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

  const [agentEnabled, setAgentEnabled] = useState<boolean>(true);

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
      const h = await apiGetJson<{ status?: string; agentEnabled?: boolean }>(
        apiBase,
        "/health",
        undefined,
        { cache: "no-store" }
      );
      setHealthOk(h.status === "ok");
      const enabled = h.agentEnabled !== false;
      setAgentEnabled(enabled);
      if (!enabled && tab === "ai") setTab("yield");
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
  }, [apiBase, tab]);

  // Fetch agentEnabled from server on mount and whenever apiBase changes.
  useEffect(() => { probe(); }, [apiBase]); // eslint-disable-line react-hooks/exhaustive-deps

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
        {agentEnabled && (
          <button
            type="button"
            className={`tab ${tab === "ai" ? "active" : ""}`}
            onClick={() => setTab("ai")}
          >
            🤖 AI Agent
          </button>
        )}
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
      <div className="tab-panel tab-panel--agent" hidden={tab !== "ai"}>
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

              {/* ── 开关（服务端控制）── */}
              <div className="setting-toggle-row">
                <span className={`toggle-label-text ${agentEnabled ? "" : "toggle-label-disabled"}`}>
                  AI Agent 标签页当前：<strong>{agentEnabled ? "已启用" : "已禁用"}</strong>
                </span>
                <p className="field-hint">
                  由服务端环境变量 <code>AGENT_ENABLED</code> 控制，影响所有用户。
                  设为 <code>false</code> 后所有人的导航栏均隐藏 AI Agent 标签页；
                  默认为启用。
                </p>
              </div>

              <hr className="settings-divider" />

              {/* ── 接入配置 ── */}
              <p className="settings-group-title">接入配置</p>
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
              <p className="field-hint">
                SiliconFlow / OpenAI 兼容接口的密钥。留空时后端读取服务器环境变量
                <code>AGENT_API_KEY</code>；若两处均无则返回 400。
              </p>
              <label>
                <span>API Base URL</span>
                <input
                  type="text"
                  value={agentConfig.apiBase}
                  onChange={(e) => updateAgentConfig({ apiBase: e.target.value })}
                  spellCheck={false}
                />
              </label>
              <p className="field-hint">
                OpenAI 兼容接口地址，结尾不加 <code>/</code>。默认 SiliconFlow：
                <code>https://api.siliconflow.cn/v1</code>。
              </p>
              <label>
                <span>模型</span>
                <input
                  type="text"
                  value={agentConfig.model}
                  onChange={(e) => updateAgentConfig({ model: e.target.value })}
                  spellCheck={false}
                  placeholder="deepseek-ai/DeepSeek-V3"
                />
              </label>
              <p className="field-hint">
                SiliconFlow 模型 ID，例如 <code>deepseek-ai/DeepSeek-V3</code>、
                <code>MiniMax/MiniMax-M1</code>。需支持 Function Calling。
              </p>

              <hr className="settings-divider" />

              {/* ── 推理行为 ── */}
              <p className="settings-group-title">推理行为</p>
              <label>
                <span>
                  最大推理轮数（{AGENT_MAX_ROUNDS_MIN}–{AGENT_MAX_ROUNDS_MAX}，默认{" "}
                  {AGENT_MAX_ROUNDS_DEFAULT}）
                </span>
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
                每次提问 Agent 连续调用工具的轮次上限，超过后强制输出结论。
                简单查询 3–5 轮足够；跨表分析、INF 下钻可调至 8–10。
              </p>
              <label>
                <span>
                  工具结果最大字符数（{AGENT_TOOL_RESULT_MAX_CHARS_MIN}–
                  {AGENT_TOOL_RESULT_MAX_CHARS_MAX}，默认{" "}
                  {AGENT_TOOL_RESULT_MAX_CHARS_DEFAULT}）
                </span>
                <input
                  type="number"
                  min={AGENT_TOOL_RESULT_MAX_CHARS_MIN}
                  max={AGENT_TOOL_RESULT_MAX_CHARS_MAX}
                  value={agentConfig.toolResultMaxChars}
                  onChange={(e) =>
                    updateAgentConfig({ toolResultMaxChars: Number(e.target.value) })
                  }
                />
              </label>
              <p className="field-hint">
                每次工具调用结果发给 LLM 的数据量上限（<strong>仅影响当轮分析</strong>）。
                超限时 JB 查询自动切换紧凑格式（保留 slotBadBinsCompact /
                bin10Vs66ByLot 等摘要字段，省略 rows 明细）。建议 8 000–12 000，
                过大收益递减且增加延迟。
              </p>
              <label>
                <span>
                  历史存储上限（{AGENT_TOOL_RESULT_MAX_HISTORY_CHARS_MIN}–
                  {AGENT_TOOL_RESULT_MAX_HISTORY_CHARS_MAX}，默认{" "}
                  {AGENT_TOOL_RESULT_MAX_HISTORY_CHARS_DEFAULT}）
                </span>
                <input
                  type="number"
                  min={AGENT_TOOL_RESULT_MAX_HISTORY_CHARS_MIN}
                  max={AGENT_TOOL_RESULT_MAX_HISTORY_CHARS_MAX}
                  value={agentConfig.toolResultMaxHistoryChars}
                  onChange={(e) =>
                    updateAgentConfig({
                      toolResultMaxHistoryChars: Number(e.target.value),
                    })
                  }
                />
              </label>
              <p className="field-hint">
                工具结果写入<strong>会话历史</strong>时的上限（影响多轮上下文大小，独立于上方的当轮上限）。
                调低可减少长对话的上下文体积；调高可让后续轮次看到更完整的历史工具数据。
              </p>

              <hr className="settings-divider" />

              {/* ── 超时 ── */}
              <p className="settings-group-title">超时</p>
              <label>
                <span>
                  LLM 响应超时（秒，{AGENT_STREAM_TIMEOUT_SEC_MIN}–
                  {AGENT_STREAM_TIMEOUT_SEC_MAX}，默认{" "}
                  {AGENT_STREAM_TIMEOUT_SEC_DEFAULT}）
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
                后端等待 LLM 流式输出的 <strong>idle 超时</strong>：只要有 SSE
                字节到达就重置计时，真正"无字"才算超时。
                INF 下钻等重型查询可调至 200–300。
              </p>
              <label>
                <span>
                  浏览器请求超时（秒，至少 LLM 超时 +{" "}
                  {AGENT_CLIENT_TIMEOUT_BUFFER_SEC}s，最大{" "}
                  {AGENT_CLIENT_TIMEOUT_SEC_MAX}，默认{" "}
                  {AGENT_CLIENT_TIMEOUT_SEC_DEFAULT}）
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
                浏览器端整次 fetch 请求的最长等待。应比 LLM 响应超时多{" "}
                {AGENT_CLIENT_TIMEOUT_BUFFER_SEC}s 以上，让后端有机会完成流并关闭连接。
                超时后显示「↻ 重试」按钮，可从同一 session 续跑。
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
