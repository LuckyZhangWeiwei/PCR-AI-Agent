export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface Session {
  messages: ChatMessage[];
  lastActive: number;
  summary?: string; // rolling compressed summary of older turns
}

const sessions = new Map<string, Session>();
const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const MAX_MESSAGES = 80; // hard safety cap

/** Threshold at which summarization should be triggered */
export const SUMMARIZE_THRESHOLD = 40;
/** Number of recent messages to keep verbatim after summarization */
export const KEEP_RECENT = 20;

/**
 * Trim history to MAX_MESSAGES while never splitting a tool-call group.
 * Tool-call group: one assistant message with tool_calls[] followed by
 * one or more tool messages.  Dropping one side causes an API error.
 */
function trimMessages(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= MAX_MESSAGES) return messages;
  let start = messages.length - MAX_MESSAGES;
  while (start < messages.length && messages[start].role !== "user") {
    start++;
  }
  return messages.slice(start);
}

function touch(sessionId: string): Session {
  let s = sessions.get(sessionId);
  if (!s) {
    s = { messages: [], lastActive: Date.now() };
    sessions.set(sessionId, s);
  } else {
    s.lastActive = Date.now();
  }
  return s;
}

export function getHistory(sessionId: string): ChatMessage[] {
  return touch(sessionId).messages;
}

export function appendMessages(
  sessionId: string,
  ...msgs: ChatMessage[]
): void {
  const s = touch(sessionId);
  s.messages.push(...msgs);
  s.messages = trimMessages(s.messages);
}

/**
 * PRE_LLM 直连路由写入 tool 结果时，必须同时写入带 tool_calls 的 assistant，
 * 否则 MiniMax 等严格模型会拒绝后续含该历史的请求：
 * 「Message has tool role, but there was no previous assistant message with a tool call」。
 */
export function appendSyntheticToolTurn(
  sessionId: string,
  opts: {
    name: string;
    content: string;
    args?: Record<string, unknown>;
    toolCallId?: string;
  }
): string {
  const callId =
    opts.toolCallId?.trim() || `${opts.name}_${Date.now()}`;
  appendMessages(
    sessionId,
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: callId,
          type: "function",
          function: {
            name: opts.name,
            arguments: JSON.stringify(opts.args ?? {}),
          },
        },
      ],
    },
    {
      role: "tool",
      name: opts.name,
      tool_call_id: callId,
      content: opts.content,
    }
  );
  return callId;
}

/**
 * 修复「孤立 tool 消息」（前面没有匹配 tool_calls 的 assistant）。
 * 供出站 LLM 请求使用（不改 session 存储）；DeepSeek 往往宽松放过，
 * MiniMax / 部分 OpenAI 兼容网关会直接 HTTP 400。
 *
 * 合法组：assistant(tool_calls[]) + 其后一条或多条 tool（tool_call_id 均在该组内）。
 */
export function repairToolCallGroupsForLlm(
  messages: ChatMessage[]
): ChatMessage[] {
  const out: ChatMessage[] = [];
  let i = 0;
  let synthSeq = 0;
  while (i < messages.length) {
    const m = messages[i]!;
    if (m.role !== "tool") {
      out.push(m);
      i++;
      continue;
    }

    const tools: ChatMessage[] = [];
    while (i < messages.length && messages[i]!.role === "tool") {
      tools.push(messages[i]!);
      i++;
    }

    const prev = out[out.length - 1];
    const prevCalls =
      prev?.role === "assistant" && Array.isArray(prev.tool_calls)
        ? prev.tool_calls
        : undefined;
    const coveredIds = new Set((prevCalls ?? []).map((tc) => tc.id));
    const allCovered =
      !!prevCalls &&
      prevCalls.length > 0 &&
      tools.every((t) => {
        const id = t.tool_call_id?.trim();
        return !!id && coveredIds.has(id);
      });

    if (allCovered) {
      out.push(...tools);
      continue;
    }

    const synthCalls: ToolCall[] = tools.map((t, idx) => {
      const id =
        t.tool_call_id?.trim() || `synth_call_${Date.now()}_${synthSeq++}_${idx}`;
      return {
        id,
        type: "function" as const,
        function: {
          name: (t.name ?? "").trim() || "unknown_tool",
          arguments: "{}",
        },
      };
    });
    out.push({
      role: "assistant",
      content: null,
      tool_calls: synthCalls,
    });
    out.push(
      ...tools.map((t, idx) => ({
        ...t,
        tool_call_id: synthCalls[idx]!.id,
        name: t.name ?? synthCalls[idx]!.function.name,
      }))
    );
  }
  return out;
}

/**
 * Returns true when the history is long enough to warrant summarization.
 * Pass a custom `threshold` for large-context models (e.g. 80 for 200K models)
 * to defer compression until the context window is more fully utilised.
 */
export function needsSummarization(sessionId: string, threshold = SUMMARIZE_THRESHOLD): boolean {
  const s = sessions.get(sessionId);
  return s ? s.messages.length > threshold : false;
}

/**
 * Removes the older portion of the history (everything except the most recent
 * KEEP_RECENT messages) and returns those removed messages for summarization.
 * The cut is always aligned to a "user" turn boundary to keep groups intact.
 * Returns [] if there is nothing old enough to remove.
 */
export function popOldMessagesForSummarization(
  sessionId: string
): ChatMessage[] {
  const s = sessions.get(sessionId);
  if (!s) return [];
  const cutoff = s.messages.length - KEEP_RECENT;
  if (cutoff <= 0) return [];
  // Walk backward from cutoff to find a clean "user" turn boundary.
  let cut = cutoff;
  while (cut > 0 && s.messages[cut]?.role !== "user") cut--;
  if (cut <= 0) return [];
  const old = s.messages.splice(0, cut);
  return old;
}

/** Stores a compressed summary for the session. */
export function storeSummary(sessionId: string, summary: string): void {
  touch(sessionId).summary = summary;
}

/** Returns the stored summary, or undefined if none exists. */
export function getSummary(sessionId: string): string | undefined {
  return sessions.get(sessionId)?.summary;
}

const sessionCleanupHooks: Array<(id: string) => void> = [];

/** Register a callback to be called whenever a session is deleted (TTL or explicit clear). */
export function registerSessionCleanupHook(fn: (id: string) => void): void {
  sessionCleanupHooks.push(fn);
}

export function clearHistory(sessionId: string): void {
  for (const hook of sessionCleanupHooks) hook(sessionId);
  sessions.delete(sessionId);
}

export function sessionCount(): number {
  return sessions.size;
}

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastActive > SESSION_TTL_MS) {
      for (const hook of sessionCleanupHooks) hook(id);
      sessions.delete(id);
    }
  }
}, 10 * 60 * 1000);

// Allow process to exit cleanly in tests
if (typeof cleanupTimer.unref === "function") cleanupTimer.unref();
