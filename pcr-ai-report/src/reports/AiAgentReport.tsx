import { useCallback, useState } from "react";
import { apiGetJson, displayApiOrigin } from "../api/client";
import { API_PREFIX } from "../api/paths";

type Props = { apiBase: string };

type SiliconflowChatJson = {
  message: string;
  reply: string | null;
  model: string;
  reasoningContent?: string;
};

const DEFAULT_PROMPT = "用一句话介绍你自己。";

export function AiAgentReport({ apiBase }: Props) {
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SiliconflowChatJson | null>(null);

  const callSiliconflow = useCallback(async () => {
    const message = prompt.trim();
    if (!message) {
      setError("请输入要向模型发送的内容。");
      setResult(null);
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await apiGetJson<SiliconflowChatJson>(
        apiBase,
        `${API_PREFIX}/siliconflow/chat`,
        { message },
        { cache: "no-store" }
      );
      setResult(res);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [apiBase, prompt]);

  const effectiveOrigin = displayApiOrigin(apiBase);

  return (
    <section className="report-panel">
      <header className="report-panel-header">
        <div>
          <h2>🤖 AI 助手</h2>
          <p className="report-desc">
            与其它 Tab 相同，请求使用页顶「<strong>服务器地址</strong>」作为
            base URL（经规范化后如下），再拼接{" "}
            <code>{API_PREFIX}/siliconflow/chat</code>（查询参数{" "}
            <code>message</code>
            ）；由服务端携带硅基流动密钥转发。请先在 <strong>pcr-ai-api</strong>{" "}
            的 <code>.env</code> 中配置 <code>SILICONFLOW_API_KEY</code> 并重启
            API。
          </p>
          <p className="muted small ai-agent-base-line">
            本页请求路径（不含 <code>message</code> 查询串）：{" "}
            <code className="ai-agent-base-url">
              {effectiveOrigin}
              {API_PREFIX}/siliconflow/chat
            </code>
          </p>
        </div>
        <div className="report-actions">
          <button
            type="button"
            className="btn primary"
            onClick={callSiliconflow}
            disabled={loading}
          >
            {loading ? "请求中…" : "调用硅基流动"}
          </button>
        </div>
      </header>

      {error ? <div className="alert error">{error}</div> : null}

      <div className="ai-agent-layout">
        <div className="ai-agent-col card subtle">
          <h3>输入</h3>
          <textarea
            className="ai-agent-textarea"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            spellCheck={false}
            placeholder="输入要发给模型的内容…"
            aria-label="发给硅基流动的消息"
          />
        </div>
        <div className="ai-agent-col card subtle">
          <h3>模型回复</h3>
          {result ? (
            <>
              <p className="ai-agent-meta">
                模型：<code>{result.model}</code>
              </p>
              {result.reasoningContent ? (
                <details className="ai-agent-reasoning">
                  <summary>推理过程（reasoning）</summary>
                  <pre className="ai-agent-reasoning-pre">
                    {result.reasoningContent}
                  </pre>
                </details>
              ) : null}
              <pre className="ai-agent-reply">{result.reply ?? ""}</pre>
            </>
          ) : (
            <p className="ai-agent-placeholder">
              点击「调用硅基流动」后，回复将显示在这里。
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
