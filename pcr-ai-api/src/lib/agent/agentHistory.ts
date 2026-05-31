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

/** Returns true when the history is long enough to warrant summarization. */
export function needsSummarization(sessionId: string): boolean {
  const s = sessions.get(sessionId);
  return s ? s.messages.length > SUMMARIZE_THRESHOLD : false;
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
