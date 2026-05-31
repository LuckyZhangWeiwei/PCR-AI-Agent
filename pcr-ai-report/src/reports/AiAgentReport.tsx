import "./AiAgentReport.css";
import { useState, useRef, useEffect, useCallback } from "react";
import { FeedbackModal } from "../components/FeedbackModal.js";
import type { AgentConfig } from "../hooks/usePersistedAgentConfig.js";
import { DarkChart } from "../components/DarkChart.js";
import type { ECharts, EChartsOption } from "echarts";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { buildUrl } from "../api/client.js";
import { sanitizeAgentMarkdownForDisplay } from "../utils/sanitizeAgentMarkdown.js";
function downloadMarkdown(text: string, title: string): void {
  const safe = title.slice(0, 50).replace(/[^\w一-龥.\-]/g, "_").trim() || "answer";
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safe}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadChartPng(instance: ECharts, title: string): void {
  const safe = title.slice(0, 40).replace(/[^\w一-龥.\-]/g, "_").trim() || "chart";
  const dataUrl = instance.getDataURL({ type: "png", pixelRatio: 2, backgroundColor: "#141414" });
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = `${safe}.png`;
  a.click();
}

const AGENT_MARKDOWN_COMPONENTS = {
  img: ({ alt }: { alt?: string }) => (
    <span className="ai-img-placeholder">[{alt}]</span>
  ),
  del: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  s: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
};

/** Hidden SVG defs rendered once; all RobotAvatar instances share these paint servers. */
function RobotAvatarDefs() {
  return (
    <svg className="rav-defs" aria-hidden="true">
      <defs>
        <radialGradient id="rav-bg" cx="50%" cy="42%" r="58%">
          <stop offset="0%" stopColor="#ddeeff"/>
          <stop offset="100%" stopColor="#b8d4f0"/>
        </radialGradient>
        <radialGradient id="rav-head" cx="38%" cy="28%" r="72%">
          <stop offset="0%" stopColor="#ffffff"/>
          <stop offset="100%" stopColor="#ddf0ff"/>
        </radialGradient>
        <radialGradient id="rav-eye" cx="38%" cy="32%" r="68%">
          <stop offset="0%" stopColor="#e8f6ff"/>
          <stop offset="45%" stopColor="#90caf9"/>
          <stop offset="100%" stopColor="#1976d2"/>
        </radialGradient>
        <filter id="rav-glow" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="1.4" result="blur"/>
          <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>
    </svg>
  );
}

function RobotAvatar() {
  return (
    <svg viewBox="0 0 100 100" width="32" height="32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      {/* background circle */}
      <circle cx="50" cy="50" r="50" fill="url(#rav-bg)"/>
      {/* antenna stick */}
      <rect x="47" y="7" width="6" height="15" rx="3" fill="#90caf9"/>
      {/* antenna ball */}
      <circle cx="50" cy="6" r="7" fill="#2196f3"/>
      <circle cx="47.5" cy="3.5" r="2.8" fill="white" opacity="0.65"/>
      {/* head */}
      <rect x="11" y="19" width="78" height="65" rx="17" fill="url(#rav-head)" stroke="#c5e0f8" strokeWidth="1.5"/>
      {/* head top shine */}
      <ellipse cx="37" cy="24" rx="17" ry="5" fill="white" opacity="0.55"/>
      {/* ear joints */}
      <circle cx="11" cy="53" r="10" fill="#90caf9" stroke="white" strokeWidth="2.5"/>
      <circle cx="8.5" cy="49.5" r="3.5" fill="white" opacity="0.62"/>
      <circle cx="89" cy="53" r="10" fill="#90caf9" stroke="white" strokeWidth="2.5"/>
      <circle cx="86.5" cy="49.5" r="3.5" fill="white" opacity="0.62"/>
      {/* face screen */}
      <rect x="19" y="27" width="62" height="44" rx="12" fill="#0c1825"/>
      {/* left eye */}
      <circle cx="36" cy="44" r="11" fill="#061018"/>
      <circle cx="36" cy="44" r="9" fill="url(#rav-eye)" filter="url(#rav-glow)"/>
      <circle cx="36" cy="44" r="5" fill="#1565c0"/>
      <circle cx="38.8" cy="40" r="3.5" fill="white" opacity="0.92"/>
      <circle cx="33.5" cy="45" r="1.3" fill="white" opacity="0.42"/>
      {/* right eye */}
      <circle cx="64" cy="44" r="11" fill="#061018"/>
      <circle cx="64" cy="44" r="9" fill="url(#rav-eye)" filter="url(#rav-glow)"/>
      <circle cx="64" cy="44" r="5" fill="#1565c0"/>
      <circle cx="66.8" cy="40" r="3.5" fill="white" opacity="0.92"/>
      <circle cx="61.5" cy="45" r="1.3" fill="white" opacity="0.42"/>
      {/* smile */}
      <path d="M29 58 Q50 70 71 58" stroke="#90caf9" strokeWidth="3.2" fill="none" strokeLinecap="round"/>
      {/* blush */}
      <circle cx="21" cy="57" r="7" fill="#f48fb1" opacity="0.38"/>
      <circle cx="79" cy="57" r="7" fill="#f48fb1" opacity="0.38"/>
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
  /** 本轮回复已结束且可展示结论后，由 SSE done 置 true */
  showFeedback?: boolean;
  /** 用户已提交 👍/👎 后显示「感谢反馈」 */
  feedback?: "good" | "bad";
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
  if (lower.includes("timeout") || message.includes("超时")) return true;
  // Tool-summary round returned empty text — backend supports retry: true on same sessionId.
  if (message.includes("模型未返回分析结论")) return true;
  if (message.includes("请点「重试」")) return true;
  return false;
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

/** User prompt that produced the AI message at `aiIdx` (last user bubble before it). */
function findUserTextForAiMessage(msgs: ChatMessage[], aiIdx: number): string | undefined {
  return findLastUserText(msgs.slice(0, aiIdx));
}

/** Mark the last non-empty AI bubble as conclusive (feedback/export eligible). */
function markConclusiveAiMessages(msgs: ChatMessage[]): ChatMessage[] {
  let lastAiIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.kind === "ai") {
      lastAiIdx = i;
      break;
    }
  }
  return msgs.map((m, i) => {
    if (m.kind !== "ai") return m;
    const next = m.streaming ? { ...m, streaming: false } : m;
    if (i === lastAiIdx && next.text.trim()) {
      return { ...next, showFeedback: true };
    }
    return next;
  });
}

function setAiMessageFeedback(
  msgs: ChatMessage[],
  aiIdx: number,
  feedback: "good" | "bad" | undefined
): ChatMessage[] {
  return msgs.map((m, i) =>
    i === aiIdx && m.kind === "ai" ? { ...m, feedback } : m
  );
}

interface Props {
  apiBase: string;
  agentConfig: AgentConfig;
}

const WELCOME: AiMessage = {
  kind: "ai",
  text: "有什么可以帮你分析的？",
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
  const chartInstancesRef = useRef<Map<number, ECharts>>(new Map());
  const [input, setInput] = useState("");
  const [sessionId, setSessionId] = useState(genId);
  const [loading, setLoading] = useState(false);
  const [statusHint, setStatusHint] = useState("");
  const [feedbackHint, setFeedbackHint] = useState("");
  const [feedbackModal, setFeedbackModal] = useState<{
    msgIndex: number;
    question: string;
    answer: string;
  } | null>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const atBottomRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  /** Bumped on New Chat so in-flight SSE cannot mutate the fresh session. */
  const chatGenerationRef = useRef(0);
  const feedbackContextRef = useRef({ messages, sessionId, apiBase });
  feedbackContextRef.current = { messages, sessionId, apiBase };

  useEffect(() => {
    if (!feedbackHint) return;
    const timer = window.setTimeout(() => setFeedbackHint(""), 5000);
    return () => window.clearTimeout(timer);
  }, [feedbackHint]);

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
            copy.push({ kind: "ai", text: event.delta ?? "", streaming: true });
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
        setMessages((prev) => markConclusiveAiMessages(prev));
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
    async (options: { text?: string; retry?: boolean; baseMessages?: ChatMessage[] }) => {
      const { text, retry = false, baseMessages } = options;
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
      setStatusHint(retry ? "正在重试…" : baseMessages !== undefined ? "正在重新生成…" : "正在连接服务器…");

      if (baseMessages !== undefined) {
        setMessages([
          ...baseMessages,
          { kind: "user", text: userText },
          { kind: "ai", text: "", streaming: true },
        ]);
      } else if (retry) {
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
        const response = await fetch(buildUrl(apiBase, "/api/v4/agent/chat"), {
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
        setMessages((prev) => {
          if (prev[prev.length - 1]?.kind === "error") {
            return prev.map((m) =>
              m.kind === "ai" && m.streaming ? { ...m, streaming: false } : m
            );
          }
          return markConclusiveAiMessages(prev);
        });
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

  const cancelRequest = useCallback(() => {
    if (!abortRef.current) return;
    const ctrl = abortRef.current;
    abortRef.current = null; // null BEFORE abort → finally stale-null path cleans up loading
    ctrl.abort();
    setMessages((prev) =>
      prev.map((m) =>
        m.kind === "ai" && m.streaming ? { ...m, streaming: false } : m
      )
    );
  }, []);

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
    setFeedbackHint("");
    setFeedbackModal(null);
    atBottomRef.current = true;
    if (messagesRef.current) messagesRef.current.scrollTop = 0;
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

  function handleGoodFeedback(idx: number, msg: AiMessage) {
    setMessages((prev) => setAiMessageFeedback(prev, idx, "good"));

    const { messages: liveMessages, sessionId: liveSessionId, apiBase: liveApiBase } =
      feedbackContextRef.current;
    const question = findUserTextForAiMessage(liveMessages, idx)?.trim();
    const answer = msg.text.trim().slice(0, 1500);
    if (!question || !answer) {
      setFeedbackHint("无法提交反馈：缺少对应的问题或回答内容");
      return;
    }
    void (async () => {
      try {
        const res = await fetch(buildUrl(liveApiBase, "/api/v4/agent/feedback"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: liveSessionId,
            question,
            answer,
            kind: "good",
          }),
        });
        if (!res.ok) {
          const errBody = (await res.json().catch(() => null)) as {
            error?: string;
            code?: string;
          } | null;
          const detail = errBody?.error ?? `HTTP ${res.status}`;
          setFeedbackHint(`反馈提交失败：${detail}`);
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        setFeedbackHint(`反馈提交失败：${detail}`);
      }
    })();
  }

  function handleOpenBadFeedback(idx: number, msg: AiMessage) {
    const question = findUserTextForAiMessage(messages, idx)?.trim();
    if (!question || !msg.text.trim()) return;
    setMessages((prev) => setAiMessageFeedback(prev, idx, "bad"));
    setFeedbackModal({ msgIndex: idx, question, answer: msg.text });
  }

  function handleCloseBadFeedbackModal() {
    setFeedbackModal(null);
  }

  const handleRegenerate = useCallback(async (idx: number) => {
    if (loading) return;
    const question = findUserTextForAiMessage(messages, idx)?.trim();
    if (!question) return;
    let userIdx = -1;
    for (let k = idx - 1; k >= 0; k--) {
      if (messages[k].kind === "user") { userIdx = k; break; }
    }
    if (userIdx === -1) return;
    await submitAgentRequest({ text: question, baseMessages: messages.slice(0, userIdx) });
  }, [loading, messages, submitAgentRequest]);

  return (
    <div className="ai-agent-report">
      <RobotAvatarDefs />
      <div className="ai-agent-toolbar">
        <span className="ai-agent-title">🤖 AI Agent — Wafer Test Data Analytics</span>
        {feedbackHint ? (
          <span className="ai-feedback-hint" role="status">{feedbackHint}</span>
        ) : null}
        <button type="button" className="ai-agent-btn-new" onClick={newSession}>
          ＋ New Chat
        </button>
      </div>

      <div className="ai-agent-messages" ref={messagesRef} onScroll={handleMessagesScroll}>
        {(() => {
          // Regenerate only on the most recent conclusive AI message; export/thumbs on all.
          const lastFeedbackIdx = messages.reduce(
            (last, m, idx) => (m.kind === "ai" && m.showFeedback === true ? idx : last),
            -1
          );

          // Group each AI message with its immediately-following tool messages so
          // tool chips render inside the same visual block as the robot avatar.
          type ToolEntry = { idx: number; msg: ToolMessage };
          const rendered: React.ReactNode[] = [];
          let i = 0;
          while (i < messages.length) {
            const msg = messages[i];

            if (msg.kind === "user") {
              rendered.push(
                <div key={i} className="ai-msg ai-msg--user">
                  <div className="ai-msg-bubble">{msg.text}</div>
                  <div className="ai-avatar ai-avatar--user">我</div>
                </div>
              );
              i++;
              continue;
            }

            if (msg.kind === "ai") {
              // Collect consecutive tool messages that follow this AI turn.
              const tools: ToolEntry[] = [];
              let j = i + 1;
              while (j < messages.length && messages[j].kind === "tool") {
                tools.push({ idx: j, msg: messages[j] as ToolMessage });
                j++;
              }

              // Capture i by value before mutating it (i = j below).
              // Closures in the JSX would otherwise capture the mutated value.
              const aiIdx = i;

              const planMatch = !msg.streaming && msg.text.match(/\[PLAN\]([\s\S]*?)\[\/PLAN\]/);
              const showFeedbackBar =
                !msg.streaming &&
                msg.showFeedback === true &&
                msg.text.trim().length > 0 &&
                findUserTextForAiMessage(messages, aiIdx) !== undefined;
              const showRegenerateButton =
                showFeedbackBar && !loading && aiIdx === lastFeedbackIdx;

              rendered.push(
                <div key={aiIdx} className="ai-msg ai-msg--ai">
                  <div className="ai-avatar ai-avatar--ai"><RobotAvatar /></div>
                  <div className="ai-msg-content">

                    {/* Tool chips row — shown inline with the avatar */}
                    {tools.length > 0 && (
                      <div className="ai-tool-chips-row">
                        <span className="ai-tool-chips-label">
                          {msg.streaming ? "查询中" : "已查询"}
                        </span>
                        {tools.map(({ idx: ti, msg: t }) => (
                          <button
                            key={ti}
                            type="button"
                            className="ai-tool-toggle"
                            onClick={() => toggleTool(ti)}
                          >
                            🔧 {t.name} {t.open ? "▲" : "▼"}
                          </button>
                        ))}
                        {msg.streaming && <span className="ai-cursor ai-cursor--inline" />}
                      </div>
                    )}

                    {/* Expanded tool details */}
                    {tools.map(({ idx: ti, msg: t }) =>
                      t.open && t.summary ? (
                        <div key={`detail-${ti}`} className="ai-tool-detail">{t.summary}</div>
                      ) : null
                    )}

                    {/* Text bubble — omit when empty with tools already shown */}
                    {(msg.text || (msg.streaming && tools.length === 0)) && (
                      <div className="ai-msg-bubble ai-msg-bubble--md">
                        {msg.text ? (
                          <ReactMarkdown
                            remarkPlugins={[[remarkGfm, { singleTilde: false }]]}
                            components={AGENT_MARKDOWN_COMPONENTS}
                          >
                            {sanitizeAgentMarkdownForDisplay(msg.text)}
                          </ReactMarkdown>
                        ) : (
                          <span className="ai-status-hint">{statusHint || "正在思考…"}</span>
                        )}
                        {msg.streaming && <span className="ai-cursor" />}
                      </div>
                    )}

                    {planMatch && (
                      <button
                        type="button"
                        className="ai-plan-confirm"
                        onClick={() => { void submitAgentRequest({ text: "确认" }); }}
                      >
                        ✓ 确认执行
                      </button>
                    )}
                    {/* Feedback bar — only on conclusive (showFeedback) messages */}
                    {showFeedbackBar && (
                      <div className="ai-feedback-bar">
                        {/* Export icon — conclusive messages only */}
                        <button
                          type="button"
                          className="ai-feedback-btn ai-export-btn"
                          title="导出为 Markdown 文件"
                          onClick={() => downloadMarkdown(
                            msg.text,
                            findUserTextForAiMessage(messages, aiIdx) ?? `answer_${aiIdx}`
                          )}
                        >
                          ⬇
                        </button>
                        {msg.feedback !== undefined ? (
                          <span className="ai-feedback-thanks">感谢反馈</span>
                        ) : (
                          <>
                            <button type="button" className="ai-feedback-btn"
                              onClick={() => handleGoodFeedback(aiIdx, msg)} title="这条回答有用">👍</button>
                            <button type="button" className="ai-feedback-btn"
                              onClick={() => handleOpenBadFeedback(aiIdx, msg)} title="这条回答有问题">👎</button>
                          </>
                        )}
                        {showRegenerateButton && (
                          <button type="button" className="ai-feedback-btn ai-feedback-btn--regen"
                            onClick={() => void handleRegenerate(aiIdx)} title="重新生成这条回答">🔄</button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );

              i = j; // skip absorbed tool messages
              continue;
            }

            if (msg.kind === "tool") {
              // Orphan tool message (not preceded by an ai message) — rare fallback.
              rendered.push(
                <div key={i} className="ai-msg ai-msg--tool">
                  <button type="button" className="ai-tool-toggle" onClick={() => toggleTool(i)}>
                    🔧 {msg.name} {msg.open ? "▲" : "▼"}
                  </button>
                  {msg.open && msg.summary && <div className="ai-tool-detail">{msg.summary}</div>}
                </div>
              );
              i++;
              continue;
            }

            if (msg.kind === "chart") {
              const chartIdx = i;
              const chartTitle = findLastUserText(messages.slice(0, i)) ?? `chart_${i}`;
              rendered.push(
                <div key={i} className="ai-msg ai-msg--chart">
                  <div className="ai-chart-wrap">
                    <DarkChart
                      option={msg.option}
                      height={320}
                      onChartReady={(inst) => { chartInstancesRef.current.set(chartIdx, inst); }}
                    />
                  </div>
                  <div className="ai-chart-actions">
                    <button
                      type="button"
                      className="ai-chart-dl-btn"
                      title="下载图表 PNG"
                      onClick={() => {
                        const inst = chartInstancesRef.current.get(chartIdx);
                        if (inst) downloadChartPng(inst, chartTitle);
                      }}
                    >
                      ⬇
                    </button>
                  </div>
                </div>
              );
              i++;
              continue;
            }

            if (msg.kind === "error") {
              rendered.push(
                <div key={i} className="ai-msg ai-msg--error">
                  <div className="ai-error-text">⚠ {msg.message}</div>
                  {msg.retryable && (
                    <button type="button" className="ai-error-retry" onClick={() => void retryLastRequest()}>
                      ↻ 重试
                    </button>
                  )}
                </div>
              );
              i++;
              continue;
            }

            if (msg.kind === "clarification") {
              rendered.push(
                <div key={i} className="ai-msg ai-msg--clarification">
                  <div className="ai-avatar ai-avatar--ai"><RobotAvatar /></div>
                  <div className="ai-clarification-bubble">❓ {msg.question}</div>
                </div>
              );
              i++;
              continue;
            }

            i++;
          }
          return rendered;
        })()}
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
        {loading && !showRetrySubmit ? (
          <button
            type="button"
            className="ai-agent-send ai-agent-send--cancel"
            onClick={cancelRequest}
            title="停止当前回答"
          >
            ✕ 取消
          </button>
        ) : (
          <button
            type="button"
            className={`ai-agent-send${showRetrySubmit ? " ai-agent-send--retry" : ""}`}
            onClick={handleSubmit}
            disabled={!input.trim() && !showRetrySubmit}
            title={showRetrySubmit ? "从上次进度继续，无需重新输入" : undefined}
          >
            {showRetrySubmit ? "↻ 重试" : "▶ 发送"}
          </button>
        )}
      </div>
      {feedbackModal && (
        <FeedbackModal
          apiBase={apiBase}
          sessionId={sessionId}
          question={feedbackModal.question}
          answer={feedbackModal.answer}
          onSubmit={() => handleCloseBadFeedbackModal()}
          onClose={() => handleCloseBadFeedbackModal()}
        />
      )}
    </div>
  );
}
