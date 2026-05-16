import "./AiAgentReport.css";
import { useState, useRef, useEffect, useCallback } from "react";
import type { AgentConfig } from "../hooks/usePersistedAgentConfig.js";
import { DarkChart } from "../components/DarkChart.js";
import type { EChartsOption } from "echarts";

interface UserMessage {
  kind: "user";
  text: string;
}
interface AiMessage {
  kind: "ai";
  text: string;
  streaming: boolean;
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

interface Props {
  apiBase: string;
  agentConfig: AgentConfig;
}

const WELCOME: AiMessage = {
  kind: "ai",
  text: "你好！我是 NXP ATTJ WaferTest 数据分析助手。你可以问我：\n- 最近 7 天 device WA03P02G 的触发次数\n- 按 probeCardType 分析 JB STAR 坏 bin 分布\n- 某批次的 lot yield 趋势",
  streaming: false,
};

export function AiAgentReport({ apiBase, agentConfig }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([WELCOME]);
  const [input, setInput] = useState("");
  const [sessionId, setSessionId] = useState(() => crypto.randomUUID());
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSseEvent = useCallback((event: SseEvent) => {
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
          }
          return copy;
        });
        break;
      case "tool_start":
        setMessages((prev) => [
          ...prev,
          { kind: "tool", name: event.name ?? "", summary: "", open: false },
        ]);
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
        setMessages((prev) => {
          const copy = [...prev];
          const last = copy[copy.length - 1];
          if (last && last.kind === "ai" && last.streaming) {
            copy[copy.length - 1] = { ...last, streaming: false };
          }
          return copy;
        });
        break;
      case "error":
        setMessages((prev) => [
          ...prev,
          { kind: "error", message: event.message ?? "未知错误" },
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
    }
  }, []);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;

    setInput("");
    setLoading(true);
    setMessages((prev) => [
      ...prev,
      { kind: "user", text },
      { kind: "ai", text: "", streaming: true },
    ]);

    try {
      const response = await fetch(`${apiBase}/api/v4/agent/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, sessionId, agentConfig }),
      });

      if (!response.ok || !response.body) {
        const errBody = await response
          .json()
          .catch(() => ({ message: "请求失败" })) as { message?: string };
        setMessages((prev) => {
          const copy = [...prev];
          copy[copy.length - 1] = {
            kind: "error",
            message: errBody.message ?? `HTTP ${response.status}`,
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
            if (!line.startsWith("data: ")) continue;
            try {
              const ev = JSON.parse(line.slice(6)) as SseEvent;
              handleSseEvent(ev);
            } catch {
              // skip malformed line
            }
          }
        }
      } catch (readerErr) {
        reader.cancel().catch(() => undefined);
        throw readerErr;
      }
    } catch (err) {
      setMessages((prev) => {
        const copy = [...prev];
        const last = copy[copy.length - 1];
        if (last && (last.kind === "ai" || last.kind === "error")) {
          copy[copy.length - 1] = {
            kind: "error",
            message: err instanceof Error ? err.message : String(err),
          };
        }
        return copy;
      });
    } finally {
      setLoading(false);
      setMessages((prev) => {
        const copy = [...prev];
        const last = copy[copy.length - 1];
        if (last && last.kind === "ai" && last.streaming) {
          copy[copy.length - 1] = { ...last, streaming: false };
        }
        return copy;
      });
    }
  }, [input, loading, sessionId, agentConfig, apiBase, handleSseEvent]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
    }
  };

  const newSession = () => {
    setSessionId(crypto.randomUUID());
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
        <span className="ai-agent-title">AI 数据分析助手</span>
        <button type="button" className="ai-agent-btn-new" onClick={newSession}>
          新对话
        </button>
      </div>

      <div className="ai-agent-messages">
        {messages.map((msg, i) => {
          if (msg.kind === "user") {
            return (
              <div key={i} className="ai-msg ai-msg--user">
                <div className="ai-msg-bubble">{msg.text}</div>
              </div>
            );
          }
          if (msg.kind === "ai") {
            const planMatch = !msg.streaming && msg.text.match(/\[PLAN\]([\s\S]*?)\[\/PLAN\]/);
            return (
              <div key={i} className="ai-msg ai-msg--ai">
                <div className="ai-msg-bubble">
                  {msg.text || (msg.streaming ? "…" : "")}
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
                <DarkChart option={msg.option} height={320} />
              </div>
            );
          }
          if (msg.kind === "error") {
            return (
              <div key={i} className="ai-msg ai-msg--error">
                ⚠ {msg.message}
              </div>
            );
          }
          if (msg.kind === "clarification") {
            return (
              <div key={i} className="ai-msg ai-msg--clarification">
                <div className="ai-clarification-bubble">
                  ❓ {msg.question}
                </div>
              </div>
            );
          }
          return null;
        })}
        <div ref={bottomRef} />
      </div>

      <div className="ai-agent-input-area">
        <textarea
          ref={inputRef}
          className="ai-agent-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入问题，Enter 发送，Shift+Enter 换行…"
          rows={2}
          disabled={loading}
        />
        <button
          type="button"
          className="ai-agent-send"
          onClick={() => void sendMessage()}
          disabled={loading || !input.trim()}
        >
          {loading ? "…" : "发送"}
        </button>
      </div>
    </div>
  );
}
