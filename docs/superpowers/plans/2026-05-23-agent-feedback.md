# Agent Feedback System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 👍/👎 feedback buttons to AI messages that follow tool calls; store feedback server-side in `feedback.json`; inject matching good/bad examples into the agent's system prompt.

**Architecture:** New `agentFeedback.ts` encapsulates file IO and Jaccard keyword matching. A new `POST /api/v4/agent/feedback` route in the existing `agentRouter` writes records. `runAgentLoop` reads matching feedback before each session. Frontend adds `hasToolContext` flag to `AiMessage`, renders an inline `FeedbackBar`, and a new `FeedbackModal` component for negative feedback.

**Tech Stack:** Node.js `node:fs/promises`, Express Router, React 19, TypeScript. No new npm dependencies.

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `pcr-ai-api/src/lib/agent/agentFeedback.ts` | `FeedbackRecord` type, `saveFeedback`, `buildFeedbackInjection` |
| Create | `pcr-ai-api/test/agentFeedback.test.ts` | Unit tests for the above |
| Modify | `pcr-ai-api/src/routes/agent.ts` | Append `POST /feedback` route |
| Modify | `pcr-ai-api/src/lib/agent/agentLoop.ts` | Call `buildFeedbackInjection` at top of `runAgentLoop` |
| Create | `pcr-ai-api/data/.gitkeep` | Ensure data/ dir is tracked |
| Modify | `pcr-ai-api/.gitignore` | Ignore `data/feedback.json` |
| Modify | `pcr-ai-report/src/reports/AiAgentReport.tsx` | `AiMessage.hasToolContext`, `feedbackState`, `FeedbackBar`, modal wiring |
| Modify | `pcr-ai-report/src/reports/AiAgentReport.css` | Append `.ai-feedback-*` styles |
| Create | `pcr-ai-report/src/components/FeedbackModal.tsx` | Modal with category chips + textarea |
| Create | `pcr-ai-report/src/components/FeedbackModal.css` | Modal styles |

---

## Task 1: Create agentFeedback.ts with unit tests (TDD)

**Files:**
- Create: `pcr-ai-api/test/agentFeedback.test.ts`
- Create: `pcr-ai-api/src/lib/agent/agentFeedback.ts`

- [ ] **Step 1: Write the failing test**

Create `pcr-ai-api/test/agentFeedback.test.ts`:

```typescript
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  saveFeedback,
  buildFeedbackInjection,
  type FeedbackRecord,
} from "../src/lib/agent/agentFeedback.js";

describe("agentFeedback", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "pcr-feedback-test-"));
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("saveFeedback writes a record to the given file", async () => {
    const f = join(tmpDir, "test1.json");
    const record: FeedbackRecord = {
      id: "id-1",
      kind: "good",
      question: "WA03P02G 最近触发次数",
      answer: "最近 7 天触发 12 次",
      timestamp: new Date().toISOString(),
      sessionId: "sess-1",
    };
    await saveFeedback(record, f);
    const { readFile } = await import("node:fs/promises");
    const saved = JSON.parse(await readFile(f, "utf-8")) as FeedbackRecord[];
    assert.equal(saved.length, 1);
    assert.equal(saved[0].id, "id-1");
    assert.equal(saved[0].kind, "good");
  });

  it("saveFeedback appends to an existing file", async () => {
    const f = join(tmpDir, "test2.json");
    const base: FeedbackRecord = {
      id: "id-a", kind: "good", question: "q", answer: "a",
      timestamp: new Date().toISOString(), sessionId: "s",
    };
    const second: FeedbackRecord = {
      id: "id-b", kind: "bad", question: "q2", answer: "a2",
      category: "数据有误", timestamp: new Date().toISOString(), sessionId: "s",
    };
    await saveFeedback(base, f);
    await saveFeedback(second, f);
    const { readFile } = await import("node:fs/promises");
    const saved = JSON.parse(await readFile(f, "utf-8")) as FeedbackRecord[];
    assert.equal(saved.length, 2);
  });

  it("buildFeedbackInjection returns empty string when file does not exist", async () => {
    const result = await buildFeedbackInjection(
      "test question",
      join(tmpDir, "nonexistent.json")
    );
    assert.equal(result, "");
  });

  it("buildFeedbackInjection injects matching good record", async () => {
    const f = join(tmpDir, "test3.json");
    await saveFeedback({
      id: "id-2", kind: "good",
      question: "WA03P02G 触发次数分析",
      answer: "该设备最近 7 天触发了 12 次，主要集中在 dut3",
      timestamp: new Date().toISOString(), sessionId: "s",
    }, f);
    const result = await buildFeedbackInjection("WA03P02G 最近触发次数查询", f);
    assert.ok(result.includes("历史反馈参考"), `Got: ${result}`);
    assert.ok(result.includes("WA03P02G"));
  });

  it("buildFeedbackInjection returns empty for non-matching question", async () => {
    const f = join(tmpDir, "test4.json");
    await saveFeedback({
      id: "id-3", kind: "good",
      question: "XY99 良率分析报告",
      answer: "良率 98.5%",
      timestamp: new Date().toISOString(), sessionId: "s",
    }, f);
    const result = await buildFeedbackInjection("ABC123 完全不同的问题", f);
    assert.equal(result, "");
  });

  it("buildFeedbackInjection includes bad feedback warning with comment", async () => {
    const f = join(tmpDir, "test5.json");
    await saveFeedback({
      id: "id-4", kind: "bad",
      question: "WA03P02G 触发良率数据",
      answer: "...",
      category: "数据有误",
      comment: "触发次数统计时段写错了",
      timestamp: new Date().toISOString(), sessionId: "s",
    }, f);
    const result = await buildFeedbackInjection("WA03P02G 触发良率", f);
    assert.ok(result.includes("数据有误"), `Got: ${result}`);
    assert.ok(result.includes("触发次数统计时段写错了"));
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

```bash
cd pcr-ai-api
npm test -- --test-name-pattern "agentFeedback"
```

Expected: FAIL — `Cannot find module '../src/lib/agent/agentFeedback.js'`

- [ ] **Step 3: Implement agentFeedback.ts**

Create `pcr-ai-api/src/lib/agent/agentFeedback.ts`:

```typescript
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

export interface FeedbackRecord {
  id: string;
  kind: "good" | "bad";
  question: string;
  answer: string;
  category?: string;
  comment?: string;
  timestamp: string;
  sessionId: string;
}

// Using a function (not a constant) so PCR_FEEDBACK_DIR can be set in tests
// before the first call without worrying about module-load-time evaluation.
function defaultFeedbackFile(): string {
  const dir = process.env["PCR_FEEDBACK_DIR"] ?? join(process.cwd(), "data");
  return join(dir, "feedback.json");
}

async function readAll(filePath: string): Promise<FeedbackRecord[]> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw) as FeedbackRecord[];
  } catch {
    return [];
  }
}

export async function saveFeedback(
  record: FeedbackRecord,
  filePath = defaultFeedbackFile()
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const existing = await readAll(filePath);
  existing.push(record);
  await writeFile(filePath, JSON.stringify(existing, null, 2), "utf-8");
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[\s，。？！、：；,.?!:;\-_/\\()\[\]{}]+/)
      .filter((t) => t.length >= 2)
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const maxSize = Math.max(a.size, b.size);
  return maxSize === 0 ? 0 : intersection / maxSize;
}

export async function buildFeedbackInjection(
  question: string,
  filePath = defaultFeedbackFile()
): Promise<string> {
  const all = await readAll(filePath);
  if (all.length === 0) return "";

  const qTokens = tokenize(question);
  const rank = (kind: "good" | "bad") =>
    all
      .filter((r) => r.kind === kind)
      .map((r) => ({ r, score: jaccard(qTokens, tokenize(r.question)) }))
      .filter(({ score }) => score >= 0.15)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2)
      .map(({ r }) => r);

  const good = rank("good");
  const bad = rank("bad");
  if (good.length === 0 && bad.length === 0) return "";

  const parts: string[] = ["\n\n【历史反馈参考】"];

  if (good.length > 0) {
    parts.push("以下是用户对类似问题满意的回答示例，请参考其风格和深度：");
    for (const r of good) {
      parts.push(`Q: ${r.question}\nA: ${r.answer.slice(0, 500)}`);
    }
  }
  if (bad.length > 0) {
    parts.push("以下类型的回答曾被标记为不好，请注意避免：");
    for (const r of bad) {
      const comment = r.comment ? `，反馈：${r.comment}` : "";
      parts.push(
        `- [${r.category ?? "其他"}] 曾问：${r.question.slice(0, 60)}${comment}`
      );
    }
  }

  return parts.join("\n");
}
```

- [ ] **Step 4: Run tests to confirm pass**

```bash
cd pcr-ai-api
npm test -- --test-name-pattern "agentFeedback"
```

Expected: All 5 tests PASS

- [ ] **Step 5: Typecheck**

```bash
cd pcr-ai-api && npm run typecheck
```

Expected: no errors

- [ ] **Step 6: Commit**

```bash
cd pcr-ai-api
git add src/lib/agent/agentFeedback.ts test/agentFeedback.test.ts
git commit -m "feat(agent): add agentFeedback — saveFeedback + Jaccard injection"
```

---

## Task 2: Add POST /feedback route to agent.ts

**Files:**
- Modify: `pcr-ai-api/src/routes/agent.ts`

- [ ] **Step 1: Write the failing test**

Append this test block to `pcr-ai-api/test/agentRoute.test.ts` (after the last existing `test(...)` block, before any closing lines):

```typescript
// ── POST /api/v4/agent/feedback ──────────────────────────────────────────────
{
  // Use a temp dir so the route doesn't write to the real data/ directory.
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const tmpFeedbackDir = await mkdtemp(join(tmpdir(), "pcr-feedback-route-"));
  process.env["PCR_FEEDBACK_DIR"] = tmpFeedbackDir;

  const feedbackApp = createApp();
  const feedbackServer = feedbackApp.listen(0);
  await new Promise<void>((resolve) => feedbackServer.once("listening", resolve));
  const feedbackAddr = feedbackServer.address() as import("node:net").AddressInfo;
  const feedbackBase = `http://127.0.0.1:${feedbackAddr.port}`;

  test("POST /api/v4/agent/feedback returns 200 for good feedback", async () => {
    const res = await fetch(`${feedbackBase}/api/v4/agent/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "sess-test",
        question: "WA03P02G 触发次数",
        answer: "最近 7 天触发 12 次",
        kind: "good",
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: boolean };
    assert.equal(body.ok, true);
  });

  test("POST /api/v4/agent/feedback returns 200 for bad feedback with category", async () => {
    const res = await fetch(`${feedbackBase}/api/v4/agent/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "sess-test",
        question: "WA03P02G 触发次数",
        answer: "最近 7 天触发 12 次",
        kind: "bad",
        category: "数据有误",
        comment: "数据时段不对",
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: boolean };
    assert.equal(body.ok, true);
  });

  test("POST /api/v4/agent/feedback returns 400 when kind is missing", async () => {
    const res = await fetch(`${feedbackBase}/api/v4/agent/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "sess-test",
        question: "q",
        answer: "a",
      }),
    });
    assert.equal(res.status, 400);
  });

  test("POST /api/v4/agent/feedback returns 400 when bad feedback missing category", async () => {
    const res = await fetch(`${feedbackBase}/api/v4/agent/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "sess-test",
        question: "q",
        answer: "a",
        kind: "bad",
      }),
    });
    assert.equal(res.status, 400);
  });

  feedbackServer.close();
  await rm(tmpFeedbackDir, { recursive: true, force: true });
  delete process.env["PCR_FEEDBACK_DIR"];
}
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd pcr-ai-api && npm test
```

Expected: 4 new tests FAIL with 404 (route not found)

- [ ] **Step 3: Add POST /feedback route to agent.ts**

Open `pcr-ai-api/src/routes/agent.ts`. Add this import at the top (after existing imports):

```typescript
import { saveFeedback, type FeedbackRecord } from "../lib/agent/agentFeedback.js";
```

Then append this route at the bottom of the file (before the last line if it's a blank line, otherwise just append):

```typescript
const VALID_CATEGORIES = new Set([
  "回答不准确",
  "数据有误",
  "回答不完整",
  "其他",
]);

agentRouter.post("/feedback", async (req, res) => {
  const body = req.body as {
    sessionId?: unknown;
    question?: unknown;
    answer?: unknown;
    kind?: unknown;
    category?: unknown;
    comment?: unknown;
  };

  const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  const question = typeof body.question === "string" ? body.question.trim() : "";
  const answer = typeof body.answer === "string" ? body.answer.trim() : "";
  const kind = body.kind;

  if (!sessionId || !question || !answer) {
    return res.status(400).json({
      error: "VALIDATION_ERROR",
      message: "sessionId, question, and answer are required",
    });
  }
  if (kind !== "good" && kind !== "bad") {
    return res.status(400).json({
      error: "VALIDATION_ERROR",
      message: 'kind must be "good" or "bad"',
    });
  }

  const category =
    typeof body.category === "string" ? body.category.trim() : undefined;
  const comment =
    typeof body.comment === "string" ? body.comment.trim() || undefined : undefined;

  if (kind === "bad" && (!category || !VALID_CATEGORIES.has(category))) {
    return res.status(400).json({
      error: "VALIDATION_ERROR",
      message: `category must be one of: ${[...VALID_CATEGORIES].join(", ")}`,
    });
  }

  const record: FeedbackRecord = {
    id: crypto.randomUUID(),
    kind,
    question,
    answer: answer.slice(0, 1500),
    category,
    comment,
    timestamp: new Date().toISOString(),
    sessionId,
  };

  try {
    await saveFeedback(record);
    return res.json({ ok: true });
  } catch (err) {
    console.error("[feedback] Failed to save:", err);
    return res.status(500).json({ error: "INTERNAL_ERROR", message: "Failed to save feedback" });
  }
});
```

- [ ] **Step 4: Run full test suite to confirm pass**

```bash
cd pcr-ai-api && npm test
```

Expected: all tests PASS including the 4 new feedback route tests

- [ ] **Step 5: Typecheck**

```bash
cd pcr-ai-api && npm run typecheck
```

Expected: no errors

- [ ] **Step 6: Commit**

```bash
cd pcr-ai-api
git add src/routes/agent.ts test/agentRoute.test.ts
git commit -m "feat(agent): add POST /api/v4/agent/feedback endpoint"
```

---

## Task 3: Integrate buildFeedbackInjection into agentLoop.ts

**Files:**
- Modify: `pcr-ai-api/src/lib/agent/agentLoop.ts`

- [ ] **Step 1: Add import at top of agentLoop.ts**

In `pcr-ai-api/src/lib/agent/agentLoop.ts`, add to the existing imports (after the last `import` statement near line 17):

```typescript
import { buildFeedbackInjection } from "./agentFeedback.js";
```

- [ ] **Step 2: Call buildFeedbackInjection at the start of runAgentLoop**

Find the `runAgentLoop` function (around line 396). It starts with:

```typescript
export async function runAgentLoop(
  message: string,
  sessionId: string,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void,
  options?: { resume?: boolean }
): Promise<void> {
  if (!options?.resume) {
    appendMessages(sessionId, { role: "user", content: message });
  }
```

Add the feedback injection call right after the function opens (before the `if (!options?.resume)` line):

```typescript
export async function runAgentLoop(
  message: string,
  sessionId: string,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void,
  options?: { resume?: boolean }
): Promise<void> {
  // Fetch relevant feedback examples once per session start (non-blocking on failure).
  const feedbackInjection = await buildFeedbackInjection(message).catch(() => "");

  if (!options?.resume) {
    appendMessages(sessionId, { role: "user", content: message });
  }
```

- [ ] **Step 3: Append feedbackInjection to systemContent**

Find the `systemContent` assignment inside the `for` loop (around line 439):

```typescript
    const systemContent = awaitingSummary
      ? `${buildSystemPrompt(manifest)}\n\n${SUMMARIZE_NUDGE}`
      : buildSystemPrompt(manifest);
```

Replace it with:

```typescript
    const basePrompt = buildSystemPrompt(manifest) + feedbackInjection;
    const systemContent = awaitingSummary
      ? `${basePrompt}\n\n${SUMMARIZE_NUDGE}`
      : basePrompt;
```

- [ ] **Step 4: Run full test suite**

```bash
cd pcr-ai-api && npm test
```

Expected: all tests PASS (agentLoop tests should pass since feedback file won't exist in test env → empty injection)

- [ ] **Step 5: Typecheck**

```bash
cd pcr-ai-api && npm run typecheck
```

Expected: no errors

- [ ] **Step 6: Commit**

```bash
cd pcr-ai-api
git add src/lib/agent/agentLoop.ts
git commit -m "feat(agent): inject matching feedback examples into system prompt"
```

---

## Task 4: Git housekeeping — data directory

**Files:**
- Create: `pcr-ai-api/data/.gitkeep`
- Modify: `pcr-ai-api/.gitignore`

- [ ] **Step 1: Create the data directory placeholder**

```bash
mkdir -p pcr-ai-api/data
touch pcr-ai-api/data/.gitkeep
```

- [ ] **Step 2: Add feedback.json to .gitignore**

Open `pcr-ai-api/.gitignore`. Add at the end:

```
# Agent feedback data (runtime-generated, may contain user questions)
data/feedback.json
```

- [ ] **Step 3: Commit**

```bash
cd pcr-ai-api
git add data/.gitkeep .gitignore
git commit -m "chore: track data/ dir, gitignore feedback.json"
```

---

## Task 5: Frontend — extend AiMessage + set hasToolContext

**Files:**
- Modify: `pcr-ai-report/src/reports/AiAgentReport.tsx` (interfaces + handleSseEvent only)

- [ ] **Step 1: Add hasToolContext to AiMessage interface**

In `AiAgentReport.tsx` find the `AiMessage` interface (around line 47):

```typescript
interface AiMessage {
  kind: "ai";
  text: string;
  streaming: boolean;
}
```

Replace with:

```typescript
interface AiMessage {
  kind: "ai";
  text: string;
  streaming: boolean;
  hasToolContext?: boolean;
}
```

- [ ] **Step 2: Set hasToolContext when creating AI bubble after tool results**

In `handleSseEvent`, find the `text` case. There is a comment `// second round: last message is a tool result, create new ai bubble`. The line that follows it creates the bubble:

```typescript
copy.push({ kind: "ai", text: event.delta ?? "", streaming: true });
```

Replace it with:

```typescript
copy.push({ kind: "ai", text: event.delta ?? "", streaming: true, hasToolContext: true });
```

- [ ] **Step 3: Typecheck**

```bash
cd pcr-ai-report && npm run build 2>&1 | head -30
```

Expected: no TypeScript errors related to `hasToolContext`

- [ ] **Step 4: Commit**

```bash
cd pcr-ai-report
git add src/reports/AiAgentReport.tsx
git commit -m "feat(report): mark AI messages that follow tool calls with hasToolContext"
```

---

## Task 6: Frontend — feedbackState + FeedbackBar + newSession reset

**Files:**
- Modify: `pcr-ai-report/src/reports/AiAgentReport.tsx`

- [ ] **Step 1: Add feedbackState and feedbackModal state**

In `AiAgentReport`, after the existing `useState` declarations (around line 149–157), add:

```typescript
const [feedbackState, setFeedbackState] = useState<Record<number, "good" | "bad">>({});
const [feedbackModal, setFeedbackModal] = useState<{
  msgIndex: number;
  question: string;
  answer: string;
} | null>(null);
```

- [ ] **Step 2: Add handler functions**

Add these two functions inside the `AiAgentReport` component, before the `return` statement. Place them after `toggleTool` (around line 475):

```typescript
async function handleGoodFeedback(idx: number, msg: AiMessage) {
  const question = findLastUserText(messages.slice(0, idx));
  if (!question) return;
  setFeedbackState((prev) => ({ ...prev, [idx]: "good" }));
  try {
    await fetch(`${apiBase}/api/v4/agent/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        question,
        answer: msg.text.slice(0, 1500),
        kind: "good",
      }),
    });
  } catch {
    // non-critical: feedback failure must not surface to user
  }
}

function handleOpenBadFeedback(idx: number, msg: AiMessage) {
  const question = findLastUserText(messages.slice(0, idx));
  if (!question) return;
  setFeedbackModal({ msgIndex: idx, question, answer: msg.text });
}
```

- [ ] **Step 3: Reset feedbackState and feedbackModal in newSession**

Find the `newSession` function (around line 463). It currently ends with:

```typescript
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
```

Add two resets before `inputRef.current?.focus()`:

```typescript
  const newSession = () => {
    chatGenerationRef.current += 1;
    setLoading(false);
    setStatusHint("");
    abortRef.current?.abort();
    abortRef.current = null;
    setSessionId(genId());
    setMessages([WELCOME]);
    setInput("");
    setFeedbackState({});
    setFeedbackModal(null);
    inputRef.current?.focus();
  };
```

- [ ] **Step 4: Render FeedbackBar inside AI message section**

Find the AI message rendering block (the `if (msg.kind === "ai")` return, around line 503). The current JSX ends with the optional `planMatch` button:

```tsx
              {planMatch && (
                <button ...>
                  ✓ 确认执行
                </button>
              )}
            </div>
```

Add the FeedbackBar **after** the `planMatch` button, still inside the outer `<div className="ai-msg ai-msg--ai">`:

```tsx
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
              {!msg.streaming && msg.hasToolContext && findLastUserText(messages.slice(0, i)) !== undefined && (
                <div className="ai-feedback-bar">
                  {feedbackState[i] !== undefined ? (
                    <span className="ai-feedback-thanks">感谢反馈</span>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="ai-feedback-btn"
                        onClick={() => void handleGoodFeedback(i, msg)}
                        title="这条回答有用"
                      >
                        👍
                      </button>
                      <button
                        type="button"
                        className="ai-feedback-btn"
                        onClick={() => handleOpenBadFeedback(i, msg)}
                        title="这条回答有问题"
                      >
                        👎
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
```

- [ ] **Step 5: Render FeedbackModal at the end of the component return**

In the component's `return`, find the closing `</div>` of `ai-agent-report`. Before it, add:

```tsx
      {feedbackModal && (
        <FeedbackModal
          apiBase={apiBase}
          sessionId={sessionId}
          question={feedbackModal.question}
          answer={feedbackModal.answer}
          onSubmit={() => {
            setFeedbackState((prev) => ({
              ...prev,
              [feedbackModal.msgIndex]: "bad",
            }));
            setFeedbackModal(null);
          }}
          onClose={() => setFeedbackModal(null)}
        />
      )}
    </div>
```

- [ ] **Step 6: Add FeedbackModal import**

At the top of `AiAgentReport.tsx`, add after the existing CSS import:

```typescript
import { FeedbackModal } from "../components/FeedbackModal.js";
```

- [ ] **Step 7: Typecheck**

```bash
cd pcr-ai-report && npm run build 2>&1 | head -40
```

Expected: errors only about `FeedbackModal` not yet existing — that's fine for now.

- [ ] **Step 8: Commit (partial — FeedbackModal will be wired in next task)**

```bash
cd pcr-ai-report
git add src/reports/AiAgentReport.tsx
git commit -m "feat(report): add feedbackState + FeedbackBar inline rendering"
```

---

## Task 7: Create FeedbackModal component

**Files:**
- Create: `pcr-ai-report/src/components/FeedbackModal.tsx`
- Create: `pcr-ai-report/src/components/FeedbackModal.css`

- [ ] **Step 1: Create FeedbackModal.css**

Create `pcr-ai-report/src/components/FeedbackModal.css`:

```css
.feedback-modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.feedback-modal {
  background: var(--bg-card, #1a2744);
  border: 1px solid var(--border, #2a3f6f);
  border-radius: 10px;
  padding: 20px 24px;
  width: 420px;
  max-width: 92vw;
  display: flex;
  flex-direction: column;
  gap: 14px;
  color: var(--text, #c8d8f0);
}

.feedback-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 0.97rem;
  font-weight: 600;
}

.feedback-modal-close {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text, #c8d8f0);
  font-size: 1.1rem;
  padding: 2px 6px;
  border-radius: 4px;
  opacity: 0.7;
}
.feedback-modal-close:hover { opacity: 1; }

.feedback-modal-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.feedback-chip {
  background: var(--bg, #0f1e38);
  border: 1px solid var(--border, #2a3f6f);
  border-radius: 20px;
  padding: 5px 14px;
  font-size: 0.87rem;
  cursor: pointer;
  color: var(--text, #c8d8f0);
  transition: background 0.15s, border-color 0.15s;
}
.feedback-chip:hover { border-color: #5bc8f5; }
.feedback-chip--active {
  background: #1a4a7a;
  border-color: #5bc8f5;
  color: #5bc8f5;
}

.feedback-modal-label {
  font-size: 0.85rem;
  color: #8aa8c8;
  display: block;
  margin-bottom: 6px;
}

.feedback-modal-textarea {
  width: 100%;
  background: var(--bg, #0f1e38);
  border: 1px solid var(--border, #2a3f6f);
  border-radius: 6px;
  color: var(--text, #c8d8f0);
  padding: 8px 10px;
  font-size: 0.88rem;
  resize: vertical;
  font-family: inherit;
  box-sizing: border-box;
}
.feedback-modal-textarea:focus {
  outline: none;
  border-color: #3d7ab8;
}

.feedback-modal-error {
  color: #ff7070;
  font-size: 0.85rem;
}

.feedback-modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.feedback-modal-cancel {
  background: none;
  border: 1px solid var(--border, #2a3f6f);
  border-radius: 6px;
  padding: 6px 16px;
  font-size: 0.87rem;
  cursor: pointer;
  color: var(--text, #c8d8f0);
}
.feedback-modal-cancel:hover { border-color: #5bc8f5; }

.feedback-modal-submit {
  background: #1a4a7a;
  border: 1px solid #3d7ab8;
  border-radius: 6px;
  padding: 6px 18px;
  font-size: 0.87rem;
  cursor: pointer;
  color: #c8d8f0;
  transition: background 0.15s;
}
.feedback-modal-submit:hover:not(:disabled) { background: #2a5a9a; }
.feedback-modal-submit:disabled { opacity: 0.5; cursor: default; }
```

- [ ] **Step 2: Create FeedbackModal.tsx**

Create `pcr-ai-report/src/components/FeedbackModal.tsx`:

```tsx
import "./FeedbackModal.css";
import { useState } from "react";

const CATEGORIES = [
  "回答不准确",
  "数据有误",
  "回答不完整",
  "其他",
] as const;
type Category = (typeof CATEGORIES)[number];

interface Props {
  apiBase: string;
  sessionId: string;
  question: string;
  answer: string;
  onSubmit: () => void;
  onClose: () => void;
}

export function FeedbackModal({
  apiBase,
  sessionId,
  question,
  answer,
  onSubmit,
  onClose,
}: Props) {
  const [category, setCategory] = useState<Category | "">("");
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async () => {
    if (!category) {
      setError("请选择一个反馈类别");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      await fetch(`${apiBase}/api/v4/agent/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          question,
          answer: answer.slice(0, 1500),
          kind: "bad",
          category,
          comment: comment.trim() || undefined,
        }),
      });
      onSubmit();
    } catch {
      setError("提交失败，请重试");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="feedback-modal-overlay" onClick={onClose}>
      <div
        className="feedback-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="feedback-modal-header">
          <span>这条回答哪里不好？</span>
          <button
            type="button"
            className="feedback-modal-close"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <div className="feedback-modal-chips">
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              type="button"
              className={`feedback-chip${category === cat ? " feedback-chip--active" : ""}`}
              onClick={() => {
                setCategory(cat);
                setError("");
              }}
            >
              {cat}
            </button>
          ))}
        </div>

        <div>
          <label className="feedback-modal-label">详细说明（选填）</label>
          <textarea
            className="feedback-modal-textarea"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={3}
            placeholder="描述具体问题…"
          />
        </div>

        {error && <div className="feedback-modal-error">{error}</div>}

        <div className="feedback-modal-actions">
          <button
            type="button"
            className="feedback-modal-cancel"
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="button"
            className="feedback-modal-submit"
            onClick={() => void handleSubmit()}
            disabled={submitting}
          >
            {submitting ? "提交中…" : "提交反馈"}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Build to confirm no TypeScript errors**

```bash
cd pcr-ai-report && npm run build 2>&1 | head -40
```

Expected: build succeeds with no errors

- [ ] **Step 4: Commit**

```bash
cd pcr-ai-report
git add src/components/FeedbackModal.tsx src/components/FeedbackModal.css
git commit -m "feat(report): add FeedbackModal component with category chips"
```

---

## Task 8: Add FeedbackBar CSS to AiAgentReport.css

**Files:**
- Modify: `pcr-ai-report/src/reports/AiAgentReport.css`

- [ ] **Step 1: Append feedback bar styles**

Open `pcr-ai-report/src/reports/AiAgentReport.css` and append at the very end:

```css
/* ── Feedback bar (👍 👎 below tool-context AI messages) ── */
.ai-feedback-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  padding-left: 2px;
}

.ai-feedback-btn {
  background: none;
  border: 1px solid transparent;
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.95rem;
  padding: 2px 6px;
  opacity: 0.4;
  transition: opacity 0.15s, border-color 0.15s;
  line-height: 1;
}
.ai-feedback-btn:hover {
  opacity: 0.9;
  border-color: var(--border, #2a3f6f);
}

.ai-feedback-thanks {
  font-size: 0.8rem;
  color: #6a8aaa;
  font-style: italic;
}
```

- [ ] **Step 2: Build to confirm**

```bash
cd pcr-ai-report && npm run build 2>&1 | tail -5
```

Expected: `✓ built in ...ms` (or equivalent success message)

- [ ] **Step 3: Commit**

```bash
cd pcr-ai-report
git add src/reports/AiAgentReport.css
git commit -m "feat(report): add feedback bar and button styles"
```

---

## Task 9: Build verification + manual test checklist

- [ ] **Step 1: Build pcr-ai-api**

```bash
cd pcr-ai-api && npm run build
```

Expected: `dist/` updated, no errors, verify-dist-no-undici passes

- [ ] **Step 2: Run full backend test suite**

```bash
cd pcr-ai-api && npm test
```

Expected: all tests pass

- [ ] **Step 3: Build pcr-ai-report**

```bash
cd pcr-ai-report && npm run build
```

Expected: `dist/` updated, no TypeScript or Vite errors

- [ ] **Step 4: Start dev server and manual test**

```bash
cd pcr-ai-api && npm run dev
# In a second terminal:
cd pcr-ai-report && npm run dev
```

Run through this checklist in the browser:

- [ ] Send a question that triggers a tool call (e.g., "最近 7 天 WA03P02G 触发次数")
- [ ] After the AI summary appears, confirm 👍 👎 appear below the bubble
- [ ] Confirm no 👍 👎 on the welcome message or on pure-text AI replies
- [ ] Click 👍 → buttons disappear, "感谢反馈" appears
- [ ] Check `pcr-ai-api/data/feedback.json` — one `"kind":"good"` record exists
- [ ] Send another similar question — check server console for feedback injection log
- [ ] Send a different question that triggers a tool call
- [ ] Click 👎 → FeedbackModal appears
- [ ] Try submitting without selecting category → error "请选择一个反馈类别"
- [ ] Select "数据有误", fill optional text, click "提交反馈"
- [ ] Modal closes, "感谢反馈" appears, `feedback.json` has a `"kind":"bad"` record
- [ ] Click "New Chat" → feedbackState clears (no stale 感谢反馈 on new session's messages)
- [ ] Click overlay or ✕ on modal → modal closes without submitting

- [ ] **Step 5: Final commit (if any stragglers)**

```bash
git status
# If clean — you're done. If any unstaged changes, commit them.
```
