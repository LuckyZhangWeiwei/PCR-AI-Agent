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
}

const sessions = new Map<string, Session>();
const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const MAX_MESSAGES = 40;

/**
 * Trim history to MAX_MESSAGES while never splitting a tool-call group.
 * A tool-call group is: one assistant message with tool_calls[] followed by
 * one or more tool messages.  Dropping the assistant part but keeping the
 * tool parts (or vice-versa) causes an API error on the next round.
 */
function trimMessages(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= MAX_MESSAGES) return messages;
  // Drop from the front until we are within the limit AND the first
  // remaining message is a "user" message (clean conversation start).
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

export function clearHistory(sessionId: string): void {
  sessions.delete(sessionId);
}

export function sessionCount(): number {
  return sessions.size;
}

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastActive > SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }
}, 10 * 60 * 1000);

// Allow process to exit cleanly in tests
if (typeof cleanupTimer.unref === "function") cleanupTimer.unref();
