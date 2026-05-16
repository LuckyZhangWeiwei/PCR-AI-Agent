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
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_MESSAGES = 40;

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
  while (s.messages.length > MAX_MESSAGES) {
    s.messages.shift();
  }
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
}, 5 * 60 * 1000);

// Allow process to exit cleanly in tests
if (typeof cleanupTimer.unref === "function") cleanupTimer.unref();
