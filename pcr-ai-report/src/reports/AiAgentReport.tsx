import "./AiAgentReport.css";
import { useState, useRef, useEffect, useCallback } from "react";
import type { AgentConfig } from "../hooks/usePersistedAgentConfig.js";
import { DarkChart } from "../components/DarkChart.js";
import type { EChartsOption } from "echarts";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { sanitizeAgentMarkdownForDisplay } from "../utils/sanitizeAgentMarkdown.js";
const AGENT_MARKDOWN_COMPONENTS = {
  img: ({ alt }: { alt?: string }) => (
    <span className="ai-img-placeholder">[{alt}]</span>
  ),
  del: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  s: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
};

function RobotAvatar() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      {/* antenna */}
      <line x1="12" y1="1.5" x2="12" y2="4.5" stroke="#7ab0e8" strokeWidth="1.2" strokeLinecap="round"/>
      <circle cx="12" cy="1.2" r="1.1" fill="#5bc8f5"/>
      {/* head */}
      <rect x="4" y="4.5" width="16" height="13" rx="3" fill="#162540" stroke="#3d7ab8" strokeWidth="0.8"/>
      {/* left eye */}
      <circle cx="9" cy="10" r="2.2" fill="#0a1e35"/>
      <circle cx="9" cy="10" r="1.4" fill="#5bc8f5" opacity="0.9"/>
      <circle cx="9.6" cy="9.3" r="0.5" fill="white" opacity="0.8"/>
      {/* right eye */}
      <circle cx="15" cy="10" r="2.2" fill="#0a1e35"/>
      <circle cx="15" cy="10" r="1.4" fill="#5bc8f5" opacity="0.9"/>
      <circle cx="15.6" cy="9.3" r="0.5" fill="white" opacity="0.8"/>
      {/* mouth */}
      <path d="M8.5 14.5 Q12 17 15.5 14.5" stroke="#5bc8f5" strokeWidth="1.1" fill="none" strokeLinecap="round"/>
      {/* ear bolts */}
      <circle cx="4" cy="11" r="1" fill="#2a5a9a" stroke="#3d7ab8" strokeWidth="0.5"/>
      <circle cx="20" cy="11" r="1" fill="#2a5a9a" stroke="#3d7ab8" strokeWidth="0.5"/>
    </svg>
  );
}

interface UserMessage {
  kind: "user";
  text: string;
}
interface AiMessage {
  kind: "ai";
  text: string;
  streaming: boolean;
  hasToolContext?: boolean;
}
interface ToolMessage {
  kind: "tool";
  name: string;
  summary: string;
  open: boolean;
}
interface ChartMessage {
  kind: "chart";
  option: EChartsOption;
}
interface ErrorMessage {
  kind: "error";
  message: string;
  retryable?: boolean;
}
interface ClarificationMessage {
  kind: "clarification";
  question: string;
}
type ChatMessage =
  | UserMessage
  | AiMessage
  | ToolMessage
  | ChartMessage
  | ErrorMessage
  | ClarificationMessage;

interface SseEvent {
  type: string;
  delta?: string;
  name?: string;
  args?: Record<string, unknown>;
  summary?: string;
  option?: EChartsOption;
  message?: string;
  question?: string;
}

function formatAgentErrorMessage(
  message: string,
  isClientTimeout: boolean,
  clientTimeoutSec: number,
  streamTimeoutSecDefault: number
): string {
  if (isClientTimeout) {
    return `请求超时（约 ${clientTimeoutSec} 秒）。可点击「重试」继续，或缩小查询范围后重新提问。`;
  }
  if (/request timeout after/i.test(message)) {
    const msMatch = message.match(/(\d+)\s*ms/i);
    const sec = msMatch
      ? Math.round(Number(msMatch[1]) / 1000)
      : streamTimeoutSecDefault;
    return `请求超时（约 ${sec} 秒）。可点击「重试」从上次进度继续，或缩小查询范围后重新提问。`;
  }
  return message;
}

function isRetryableAgentError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("timeout") || message.includes("超时");
}

function parseSseLine(line: string, onEvent: (event: SseEvent) => void): void {
  if (!line.startsWith("data: ")) return;
  try {
    onEvent(JSON.parse(line.slice(6)) as SseEvent);
  } catch {
    // skip malformed line
  }
}

function findLastUserText(msgs: ChatMessage[]): string | undefined {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.kind === "user") return m.text;
  }
  return undefined;
}

interface Props {
  apiBase: string;
  agentConfig: AgentConfig;
}

const WELCOME: AiMessage = {
  kind: "ai",
  text: "NXP ATTJ WaferTest 数据分析助手。可问：最近 7 天 WA03P02G 触发次数 / 按 probeCardType 分析 JB STAR 坏 bin / 某批次 lot yield 趋势",
  streaming: false,
};

function genId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export function AiAgentReport({ apiBase, agentConfig }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([WELCOME]);
  const [input, setInput] = useState("");
  const [sessionId, setSessionId] = useState(genId);
  const [loading, setLoading] = useState(false);
  const [statusHint, setStatusHint] = useState("");
  const messagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const atBottomRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  /** Bumped on New Chat so in-flight SSE cannot mutate the fresh session. */
  const chatGenerationRef = useRef(0);

  const handleMessagesScroll = () => {
    const el = messagesRef.current;
    if (!el) return;
    // 120px threshold: generous enough that a new message appearing while the
    // user is "at the bottom" still triggers auto-scroll even if the browser
    // hasn't finished updating layout yet.
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  useEffect(() => {
    if (!atBottomRef.current) return;
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const handleSseEvent = useCallback((event: SseEvent, generation: number) => {
    if (generation !== chatGenerationRef.current) return;
    switch (event.type) {
      case "text":
        setMessages((prev) => {
          const copy = [...prev];
          const last = copy[copy.length - 1];
          if (last && last.kind === "ai") {
            copy[copy.length - 1] = {
              ...last,
              text: last.text + (event.delta ?? ""),
            };
          } else {
            // second round: last message is a tool result, create new ai bubble
            copy.push({ kind: "ai", text: event.delta ?? "", streaming: true, hasToolContext: true });
          }
          return copy;
        });
        break;
      case "tool_start":
        setMessages((prev) => {
          const copy = [...prev];
          const last = copy[copy.length - 1];
          if (last && last.kind === "ai" && last.streaming) {
            if (last.text === "") {
              // discard the empty placeholder ai bubble created before SSE started
              copy.pop();
            } else {
              // AI finished speaking before calling a tool — stop its cursor
              copy[copy.length - 1] = { ...last, streaming: false };
            }
          }
          copy.push({ kind: "tool", name: event.name ?? "", summary: "", open: false });
          return copy;
        });
        break;
      case "tool_result":
        setMessages((prev) => {
          const copy = [...prev];
          for (let i = copy.length - 1; i >= 0; i--) {
            const m = copy[i];
            if (m.kind === "tool" && m.name === event.name && m.summary === "") {
              copy[i] = { ...m, summary: event.summary ?? "" };
              break;
            }
          }
          return copy;
        });
        break;
      case "chart":
        setMessages((prev) => [
          ...prev,
          { kind: "chart", option: event.option ?? {} },
        ]);
        break;
      case "done":
        setMessages((prev) =>
          prev.map((m) =>
            m.kind === "ai" && m.streaming ? { ...m, streaming: false } : m
          )
        );
        break;
      case "error":
        setMessages((prev) => [
          ...prev,
          {
            kind: "error",
            message: formatAgentErrorMessage(
              event.message ?? "未知错误",
              false,
              agentConfig.clientTimeoutSec,
              agentConfig.streamTimeoutSec
            ),
            retryable: isRetryableAgentError(event.message ?? ""),
          },
        ]);
        break;
      case "clarification": {
        const question = event.question ?? "";
        setMessages((prev) => {
          const copy = [...prev];
          const last = copy[copy.length - 1];
          if (last && last.kind === "ai" && last.text === "") {
            copy[copy.length - 1] = { kind: "clarification", question };
          } else {
            copy.push({ kind: "clarification", question });
          }
          return copy;
        });
        break;
      }
      case "status":
        if (event.message) setStatusHint(event.message);
        break;
    }
  }, [agentConfig.clientTimeoutSec, agentConfig.streamTimeoutSec]);

  const submitAgentRequest = useCallback(
    async (options: { text?: string; retry?: boolean }) => {
      const { text, retry = false } = options;
      const userText = (retry ? text ?? findLastUserText(messages) : text)?.trim();
      if (!userText) return;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const generation = chatGenerationRef.current;
      const clientTimeoutMs = agentConfig.clientTimeoutSec * 1000;
      const timeoutId = setTimeout(
        () => controller.abort(),
        clientTimeoutMs
      );

      setLoading(true);
      setStatusHint(retry ? "正在重试…" : "正在连接服务器…");

      if (retry) {
        setMessages((prev) => {
          const copy = [...prev];
          const last = copy[copy.length - 1];
          if (last?.kind === "error") copy.pop();
          const tail = copy[copy.length - 1];
          if (tail?.kind === "ai" && tail.text === "" && !tail.streaming) {
            copy[copy.length - 1] = { ...tail, streaming: true };
          } else {
            copy.push({ kind: "ai", text: "", streaming: true });
          }
          return copy;
        });
      } else {
        setMessages((prev) => [
          ...prev,
          { kind: "user", text: userText },
          { kind: "ai", text: "", streaming: true },
        ]);
      }

      try {
        const response = await fetch(`${apiBase}/api/v4/agent/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            retry
              ? { retry: true, message: userText, sessionId, agentConfig }
              : { message: userText, sessionId, agentConfig }
          ),
          signal: controller.signal,
        });

        if (!response.ok || !response.body) {
          if (generation !== chatGenerationRef.current) return;
          const errBody = await response
            .json()
            .catch(() => ({ message: "请求失败" })) as { message?: string };
          const errMessage = errBody.message ?? `HTTP ${response.status}`;
          setMessages((prev) => {
            const copy = [...prev];
            copy[copy.length - 1] = {
              kind: "error",
              message: errMessage,
              retryable:
                isRetryableAgentError(errMessage) ||
                /message is required/i.test(errMessage),
            };
            return copy;
          });
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop() ?? "";
            for (const line of lines) {
              if (generation !== chatGenerationRef.current) break;
              parseSseLine(line, (ev) => handleSseEvent(ev, generation));
            }
          }
          if (generation !== chatGenerationRef.current) return;
          if (buf.trim()) {
            for (const line of buf.split("\n")) {
              parseSseLine(line, (ev) => handleSseEvent(ev, generation));
            }
          }
        } catch (readerErr) {
          reader.cancel().catch(() => undefined);
          throw readerErr;
        }
      } catch (err) {
        if (generation !== chatGenerationRef.current) return;
        if (abortRef.current !== controller) return;

        const isTimeout =
          err instanceof DOMException &&
          (err.name === "TimeoutError" || err.name === "AbortError");
        const rawMessage = err instanceof Error ? err.message : String(err);
        const message = isTimeout
          ? formatAgentErrorMessage(
              rawMessage,
              true,
              agentConfig.clientTimeoutSec,
              agentConfig.streamTimeoutSec
            )
          : rawMessage;
        setMessages((prev) => {
          const copy = [...prev];
          const last = copy[copy.length - 1];
          if (last && (last.kind === "ai" || last.kind === "error")) {
            copy[copy.length - 1] = {
              kind: "error",
              message,
              retryable: isTimeout || isRetryableAgentError(rawMessage),
            };
          } else {
            copy.push({
              kind: "error",
              message,
              retryable: isTimeout || isRetryableAgentError(rawMessage),
            });
          }
          return copy;
        });
      } finally {
        clearTimeout(timeoutId);
        const stale =
          generation !== chatGenerationRef.current ||
          abortRef.current !== controller;
        if (stale) {
          // New Chat clears abortRef — ensure send button / hint don't stay stuck.
          if (abortRef.current === null) {
            setLoading(false);
            setStatusHint("");
          }
          return;
        }

        abortRef.current = null;
        setLoading(false);
        setStatusHint("");
        setMessages((prev) =>
          prev.map((m) =>
            m.kind === "ai" && m.streaming ? { ...m, streaming: false } : m
          )
        );
      }
    },
    [messages, sessionId, agentConfig, apiBase, handleSseEvent]
  );

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;
    setInput("");
    await submitAgentRequest({ text });
  }, [input, loading, submitAgentRequest]);

  const retryLastRequest = useCallback(async () => {
    await submitAgentRequest({ retry: true });
  }, [submitAgentRequest]);

  const lastMsg = messages[messages.length - 1];
  const canRetryFromError =
    lastMsg?.kind === "error" &&
    lastMsg.retryable === true &&
    Boolean(findLastUserText(messages));
  const showRetrySubmit = canRetryFromError && !input.trim();

  const handleSubmit = () => {
    if (showRetrySubmit) void retryLastRequest();
    else void sendMessage();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (showRetrySubmit) void retryLastRequest();
      else void sendMessage();
    }
  };

  const newSession = () => {
    chatGenerationRef.current += 1;
    setLoading(false);
    setStatusHint("");
    abortRef.current?.abort();
    abortRef.current = null;
    setSessionId(genId());
    setMessages([WELCOME]);
    setInput("");
    inputRef.current?.focus();
  };

  const toggleTool = (index: number) => {
    setMessages((prev) => {
      const copy = [...prev];
      const m = copy[index];
      if (m.kind === "tool") copy[index] = { ...m, open: !m.open };
      return copy;
    });
  };

  return (
    <div className="ai-agent-report">
      <div className="ai-agent-toolbar">
        <span className="ai-agent-title">🤖 AI Agent — Wafer Test Data Analytics</span>
        <button type="button" className="ai-agent-btn-new" onClick={newSession}>
          New Chat
        </button>
      </div>

      <div className="ai-agent-messages" ref={messagesRef} onScroll={handleMessagesScroll}>
        {messages.map((msg, i) => {
          if (msg.kind === "user") {
            return (
              <div key={i} className="ai-msg ai-msg--user">
                <div className="ai-msg-bubble">{msg.text}</div>
                <div className="ai-avatar ai-avatar--user">我</div>
              </div>
            );
          }
          if (msg.kind === "ai") {
            const planMatch = !msg.streaming && msg.text.match(/\[PLAN\]([\s\S]*?)\[\/PLAN\]/);
            return (
              <div key={i} className="ai-msg ai-msg--ai">
                <div className="ai-avatar ai-avatar--ai"><RobotAvatar /></div>
                <div className="ai-msg-bubble ai-msg-bubble--md">
                  {msg.text ? (
                    <ReactMarkdown
                      remarkPlugins={[[remarkGfm, { singleTilde: false }]]}
                      components={AGENT_MARKDOWN_COMPONENTS}
                    >
                      {sanitizeAgentMarkdownForDisplay(msg.text)}
                    </ReactMarkdown>
                  ) : (
                    msg.streaming
                      ? <span className="ai-status-hint">{statusHint || "正在思考…"}</span>
                      : ""
                  )}
                  {msg.streaming && <span className="ai-cursor" />}
                </div>
                {planMatch && (
                  <button
                    type="button"
                    className="ai-plan-confirm"
                    onClick={() => {
                      setInput("确认");
                      inputRef.current?.focus();
                    }}
                  >
                    ✓ 确认执行
                  </button>
                )}
              </div>
            );
          }
          if (msg.kind === "tool") {
            return (
              <div key={i} className="ai-msg ai-msg--tool">
                <button
                  type="button"
                  className="ai-tool-toggle"
                  onClick={() => toggleTool(i)}
                >
                  🔧 {msg.name} {msg.open ? "▲" : "▼"}
                </button>
                {msg.open && msg.summary && (
                  <div className="ai-tool-detail">{msg.summary}</div>
                )}
              </div>
            );
          }
          if (msg.kind === "chart") {
            return (
              <div key={i} className="ai-msg ai-msg--chart">
                <div className="ai-chart-wrap">
                  <DarkChart option={msg.option} height={320} />
                </div>
              </div>
            );
          }
          if (msg.kind === "error") {
            return (
              <div key={i} className="ai-msg ai-msg--error">
                <div className="ai-error-text">⚠ {msg.message}</div>
                {msg.retryable ? (
                  <button
                    type="button"
                    className="ai-error-retry"
                    onClick={() => void retryLastRequest()}
                  >
                    ↻ 重试
                  </button>
                ) : null}
              </div>
            );
          }
          if (msg.kind === "clarification") {
            return (
              <div key={i} className="ai-msg ai-msg--clarification">
                <div className="ai-avatar ai-avatar--ai"><RobotAvatar /></div>
                <div className="ai-clarification-bubble">
                  ❓ {msg.question}
                </div>
              </div>
            );
          }
          return null;
        })}
      </div>

      {loading && (
        <div className="ai-agent-processing-hint">
          ⏳ {statusHint || "AI 正在处理，请稍候…"}
        </div>
      )}
      <div className="ai-agent-input-area">
        <textarea
          ref={inputRef}
          className="ai-agent-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            showRetrySubmit
              ? "可直接点「重试」继续，无需重新输入…"
              : "输入问题，Enter 发送，Shift+Enter 换行…"
          }
          rows={2}
          disabled={loading && !showRetrySubmit}
        />
        <button
          type="button"
          className={`ai-agent-send${showRetrySubmit ? " ai-agent-send--retry" : ""}`}
          onClick={handleSubmit}
          disabled={!input.trim() && !showRetrySubmit}
          title={
            showRetrySubmit
              ? "从上次进度继续，无需重新输入"
              : loading
                ? "AI 正在处理中，请稍候"
                : undefined
          }
        >
          {loading && !showRetrySubmit
            ? "处理中"
            : showRetrySubmit
              ? "重试"
              : "发送"}
        </button>
      </div>
    </div>
  );
}
