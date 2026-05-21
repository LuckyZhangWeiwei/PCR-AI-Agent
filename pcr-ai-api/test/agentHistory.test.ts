import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  getHistory,
  appendMessages,
  clearHistory,
  sessionCount,
} from "../src/lib/agent/agentHistory.js";

describe("agentHistory", () => {
  beforeEach(() => {
    clearHistory("sess-1");
    clearHistory("sess-2");
    clearHistory("sess-trim");
  });

  it("starts empty for a new sessionId", () => {
    const h = getHistory("sess-new-" + Date.now());
    assert.deepEqual(h, []);
  });

  it("appends messages and retrieves them", () => {
    appendMessages("sess-1", { role: "user", content: "hello" });
    appendMessages("sess-1", { role: "assistant", content: "hi" });
    const h = getHistory("sess-1");
    assert.equal(h.length, 2);
    assert.equal(h[0].content, "hello");
    assert.equal(h[1].content, "hi");
  });

  it("sessions are isolated", () => {
    appendMessages("sess-1", { role: "user", content: "a" });
    appendMessages("sess-2", { role: "user", content: "b" });
    assert.equal(getHistory("sess-1").length, 1);
    assert.equal(getHistory("sess-2").length, 1);
    assert.equal(getHistory("sess-1")[0].content, "a");
  });

  it("clearHistory removes the session", () => {
    appendMessages("sess-1", { role: "user", content: "x" });
    clearHistory("sess-1");
    assert.deepEqual(getHistory("sess-1"), []);
  });

  it("trims oldest messages when MAX_MESSAGES exceeded", () => {
    const sid = "sess-trim";
    clearHistory(sid);
    for (let i = 0; i < 85; i++) {
      appendMessages(sid, { role: "user", content: `msg-${i}` });
    }
    const h = getHistory(sid);
    assert.ok(h.length <= 80, `Expected ≤80 messages, got ${h.length}`);
    // Most recent message should be preserved
    assert.equal(h[h.length - 1].content, "msg-84");
  });
});
