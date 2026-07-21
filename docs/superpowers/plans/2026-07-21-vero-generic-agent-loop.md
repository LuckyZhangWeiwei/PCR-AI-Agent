# Vero 驱动的通用 Agent 循环内核 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a parallel, Vero (wchat/Claude 4.6)-driven generic ReAct loop (`runVeroAgentLoop`) that the AI Agent uses instead of the SiliconFlow-based loop when a flag is on, reusing all existing tool execution / pre-LLM direct-route / session-history infrastructure and calibrated for a 128K context budget.

**Architecture:** New files under `pcr-ai-api/src/lib/agent/core/` (`veroAgentLoopConfig.ts`, `veroAgentProtocol.ts`, `veroAgentLoopPrompt.ts`, `veroAgentLoopSetup.ts`, `veroAgentToolExecutor.ts`, `veroAgentLoop.ts`) implement a hand-written JSON action protocol (`{"action":"tool"|"final"|"chat", ...}`) driving Vero's single-shot `simple-agent/invoke`, one tool call per round. `agentLoop.ts`'s `runAgentLoop` gains a one-line gate at the top that delegates to `runVeroAgentLoop` when `isVeroGenericLoopReady()` is true; otherwise the existing SiliconFlow implementation runs unchanged.

**Tech Stack:** TypeScript, Node.js `node:test` test runner, existing `pcr-ai-api` agent module structure (no new npm dependencies).

**Spec:** [`docs/superpowers/specs/2026-07-21-vero-generic-agent-loop-design.md`](../specs/2026-07-21-vero-generic-agent-loop-design.md)

## Global Constraints

- **no-undici**: all Vero outbound calls go through the existing `invokeVeroSimpleAgent` (`node:https`, already no-undici-compliant) — no new HTTP client code in this plan.
- **oracledb pinned at 5.5.0**: not touched by this plan (no Oracle driver changes).
- **dummy-parity**: not applicable — this plan does not change any Oracle/Dummy WHERE clause, filter, or response shape; it only changes which code decides "which tool to call."
- **Never commit `WCHAT_ACCESS_TOKEN`** to the repo, front end, or docs — env-var name only in `.env.example`/`ecosystem.config.cjs`.
- **Default-off**: `AGENT_VERO_GENERIC_LOOP` must default to disabled so existing production behavior (SiliconFlow loop) is completely unaffected until the flag is explicitly turned on.
- **Known, deliberate scope reduction** (see spec §1.2 and design rationale below — not a placeholder, a stated decision): this plan ports `PRE_LLM_DIRECT_ROUTES` (the same array `agentLoop.ts` uses today) into the new loop unchanged, but does **not** port the additional `awaitingSummary`-gated mid-loop recovery branches (wafer-map plan application, deterministic JB/probe-card summary tables, touchdown reply, DUT×BIN map / DUT yield chart auto-routes) that live inline in `agentLoop.ts` between lines ~146–311. Those question types still work through the new loop's generic `action:"tool"` protocol (the model just calls `query_jb_bins`/`generate_chart`/etc. explicitly), they just don't get the old loop's automatic short-circuit optimizations yet. This is called out as an open follow-up, not silently dropped.

---

### Task 1: Vero generic-loop flag + calibration constants

**Files:**
- Modify: `pcr-ai-api/src/lib/vero/veroSimpleAgent.ts`
- Create: `pcr-ai-api/src/lib/agent/core/veroAgentLoopConfig.ts`
- Test: `pcr-ai-api/test/veroAgentLoopConfig.test.ts`

**Interfaces:**
- Produces: `isVeroGenericLoopEnabled(): boolean`, `isVeroGenericLoopReady(): boolean` (exported from `veroSimpleAgent.ts`); `VERO_SUMMARIZE_THRESHOLD: number`, `VERO_TOOL_RESULT_MAX_HISTORY_CHARS: number`, `VERO_PROMPT_CHAR_BUDGET: number` (exported from `veroAgentLoopConfig.ts`)

- [ ] **Step 1: Write the failing test**

Create `pcr-ai-api/test/veroAgentLoopConfig.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  isVeroGenericLoopEnabled,
  isVeroGenericLoopReady,
} from "../src/lib/vero/veroSimpleAgent.js";
import {
  VERO_SUMMARIZE_THRESHOLD,
  VERO_TOOL_RESULT_MAX_HISTORY_CHARS,
  VERO_PROMPT_CHAR_BUDGET,
} from "../src/lib/agent/core/veroAgentLoopConfig.js";

test("isVeroGenericLoopEnabled / isVeroGenericLoopReady toggle with env", () => {
  const prevFlag = process.env.AGENT_VERO_GENERIC_LOOP;
  const prevToken = process.env.WCHAT_ACCESS_TOKEN;
  try {
    delete process.env.AGENT_VERO_GENERIC_LOOP;
    delete process.env.WCHAT_ACCESS_TOKEN;
    assert.equal(isVeroGenericLoopEnabled(), false);
    assert.equal(isVeroGenericLoopReady(), false);

    process.env.AGENT_VERO_GENERIC_LOOP = "true";
    assert.equal(isVeroGenericLoopEnabled(), true);
    assert.equal(isVeroGenericLoopReady(), false); // no token yet

    process.env.WCHAT_ACCESS_TOKEN = "tok";
    assert.equal(isVeroGenericLoopReady(), true);
  } finally {
    if (prevFlag === undefined) delete process.env.AGENT_VERO_GENERIC_LOOP;
    else process.env.AGENT_VERO_GENERIC_LOOP = prevFlag;
    if (prevToken === undefined) delete process.env.WCHAT_ACCESS_TOKEN;
    else process.env.WCHAT_ACCESS_TOKEN = prevToken;
  }
});

test("Vero loop calibration constants are sane relative to SiliconFlow large-context bucket", () => {
  // Claude 4.6 (128K) is smaller than the existing MiniMax-M2.5 large-context
  // bucket (192K, SUMMARIZE_THRESHOLD=80 in agentHistory.ts usage), so the
  // Vero-specific threshold must stay below it (see design doc §4.1).
  assert.ok(VERO_SUMMARIZE_THRESHOLD > 0 && VERO_SUMMARIZE_THRESHOLD < 80);
  assert.ok(VERO_TOOL_RESULT_MAX_HISTORY_CHARS > 0 && VERO_TOOL_RESULT_MAX_HISTORY_CHARS < 20000);
  assert.ok(VERO_PROMPT_CHAR_BUDGET > 100_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `pcr-ai-api/`): `npx tsx --test test/veroAgentLoopConfig.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/agent/core/veroAgentLoopConfig.js'` (and `isVeroGenericLoopEnabled` is not exported).

- [ ] **Step 3: Add the flag helpers to `veroSimpleAgent.ts`**

Open `pcr-ai-api/src/lib/vero/veroSimpleAgent.ts`. Directly below the existing `isProbeCardVeroPilotReady` function (after line 31), add:

```ts
/** Feature flag: the generic ReAct loop (all free-form questions, not just
 * probe-card×tester) uses Vero when true — see docs/superpowers/specs/
 * 2026-07-21-vero-generic-agent-loop-design.md. */
export function isVeroGenericLoopEnabled(): boolean {
  return isEnvTruthy(process.env.AGENT_VERO_GENERIC_LOOP);
}

/** Generic loop is usable only when flag is on and a bearer token is present. */
export function isVeroGenericLoopReady(): boolean {
  return isVeroGenericLoopEnabled() && getVeroAccessToken().length > 0;
}
```

- [ ] **Step 4: Create `veroAgentLoopConfig.ts`**

Create `pcr-ai-api/src/lib/agent/core/veroAgentLoopConfig.ts`:

```ts
// pcr-ai-api/src/lib/agent/core/veroAgentLoopConfig.ts
// Calibration constants for the Vero-driven generic agent loop (128K context).
// See docs/superpowers/specs/2026-07-21-vero-generic-agent-loop-design.md §4.
// Values are initial estimates — flagged in the spec (§8) as needing real-Vero
// tuning once Cursor observes actual output quality/size against these numbers.

/**
 * Message-count threshold before cross-turn history summarization kicks in
 * (passed to agentHistory.ts's needsSummarization). Lower than the
 * SiliconFlow large-context bucket's 80 (calibrated for MiniMax-M2.5's 192K)
 * because Claude 4.6 via Vero is 128K.
 */
export const VERO_SUMMARIZE_THRESHOLD = 60;

/** Max chars kept per tool result when appended to session history (agentLoopShared.ts's toolResultForHistory). */
export const VERO_TOOL_RESULT_MAX_HISTORY_CHARS = 15000;

/**
 * Conservative character-budget ceiling for a single prompt string sent to
 * Vero (system + summary + history + latest tool result). Vero has no
 * messages[] array — the whole round is one prompt string — so this guards
 * against a single turn's rounds piling up tool results past what 128K
 * tokens can safely hold (leaving room for the model's own output).
 */
export const VERO_PROMPT_CHAR_BUDGET = 180_000;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsx --test test/veroAgentLoopConfig.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add src/lib/vero/veroSimpleAgent.ts src/lib/agent/core/veroAgentLoopConfig.ts test/veroAgentLoopConfig.test.ts
git commit -m "feat(agent): add Vero generic-loop flag + 128K calibration constants"
```

---

### Task 2: Protocol module — tool schema rendering + JSON decision parsing

**Files:**
- Create: `pcr-ai-api/src/lib/agent/core/veroAgentProtocol.ts`
- Test: `pcr-ai-api/test/veroAgentProtocol.test.ts`

**Interfaces:**
- Consumes: `parseJsonLoose(text: string): unknown` from `../../vero/veroSimpleAgent.js` (existing)
- Produces: `VeroToolDecision`, `VeroReplyDecision`, `VeroRoundDecision` types; `renderToolSchemasAsText(schemas: unknown[]): string`; `VERO_ACTION_PROTOCOL_INSTRUCTIONS: string`; `parseVeroRoundDecision(raw: string): VeroRoundDecision`

- [ ] **Step 1: Write the failing test**

Create `pcr-ai-api/test/veroAgentProtocol.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  renderToolSchemasAsText,
  parseVeroRoundDecision,
} from "../src/lib/agent/core/veroAgentProtocol.js";

test("renderToolSchemasAsText renders name/description/params with required marker", () => {
  const schemas = [
    {
      type: "function",
      function: {
        name: "query_jb_bins",
        description: "查询 JB STAR bin 数据",
        parameters: {
          type: "object",
          properties: {
            device: { type: "string", description: "产品代码" },
            limit: { type: "number", description: "返回行数" },
          },
          required: ["device"],
        },
      },
    },
  ];
  const text = renderToolSchemasAsText(schemas);
  assert.ok(text.includes("### query_jb_bins"));
  assert.ok(text.includes("查询 JB STAR bin 数据"));
  assert.ok(text.includes("device (string，必填): 产品代码"));
  assert.ok(text.includes("limit (number): 返回行数"));
});

test("renderToolSchemasAsText handles a tool with no parameters", () => {
  const schemas = [
    {
      type: "function",
      function: { name: "noop", description: "d", parameters: { type: "object", properties: {}, required: [] } },
    },
  ];
  const text = renderToolSchemasAsText(schemas);
  assert.ok(text.includes("### noop"));
  assert.ok(text.includes("(无参数)"));
});

test("parseVeroRoundDecision parses a tool decision", () => {
  const d = parseVeroRoundDecision(
    '{"action":"tool","tool":"query_jb_bins","args":{"device":"WA03P02G"}}'
  );
  assert.deepEqual(d, { action: "tool", tool: "query_jb_bins", args: { device: "WA03P02G" } });
});

test("parseVeroRoundDecision defaults args to {} when omitted", () => {
  const d = parseVeroRoundDecision('{"action":"tool","tool":"get_filter_values"}');
  assert.deepEqual(d, { action: "tool", tool: "get_filter_values", args: {} });
});

test("parseVeroRoundDecision parses final/chat decisions", () => {
  assert.deepEqual(parseVeroRoundDecision('{"action":"final","reply":"结论：良率 95%"}'), {
    action: "final",
    reply: "结论：良率 95%",
  });
  assert.deepEqual(parseVeroRoundDecision('{"action":"chat","reply":"你好"}'), {
    action: "chat",
    reply: "你好",
  });
});

test("parseVeroRoundDecision accepts fenced JSON (via parseJsonLoose)", () => {
  const d = parseVeroRoundDecision('```json\n{"action":"chat","reply":"hi"}\n```');
  assert.deepEqual(d, { action: "chat", reply: "hi" });
});

test("parseVeroRoundDecision throws on missing tool name", () => {
  assert.throws(() => parseVeroRoundDecision('{"action":"tool","args":{}}'), /missing "tool" name/);
});

test("parseVeroRoundDecision throws on missing reply text", () => {
  assert.throws(() => parseVeroRoundDecision('{"action":"final"}'), /missing "reply" text/);
});

test("parseVeroRoundDecision throws on unknown action", () => {
  assert.throws(() => parseVeroRoundDecision('{"action":"nope"}'), /unknown action/);
});

test("parseVeroRoundDecision throws on non-object JSON", () => {
  assert.throws(() => parseVeroRoundDecision("[1,2,3]"), /not a JSON object/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/veroAgentProtocol.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/agent/core/veroAgentProtocol.js'`

- [ ] **Step 3: Write the implementation**

Create `pcr-ai-api/src/lib/agent/core/veroAgentProtocol.ts`:

```ts
// pcr-ai-api/src/lib/agent/core/veroAgentProtocol.ts
// JSON action protocol for the Vero-driven generic agent loop.
// Vero's simple-agent/invoke has no native tools[]/messages[] params — the
// model must reply with one JSON object per round describing what to do
// next. Same style as agentProbeCardVeroPilot.ts's extract protocol,
// generalized to cover the full tool list and multi-round looping.
import { parseJsonLoose } from "../../vero/veroSimpleAgent.js";

export interface VeroToolDecision {
  action: "tool";
  tool: string;
  args: Record<string, unknown>;
}

export interface VeroReplyDecision {
  action: "final" | "chat";
  reply: string;
}

export type VeroRoundDecision = VeroToolDecision | VeroReplyDecision;

interface ToolSchemaFunction {
  name: string;
  description: string;
  parameters?: {
    properties?: Record<string, { type?: string; description?: string }>;
    required?: string[];
  };
}

interface ToolSchemaEntry {
  type: string;
  function: ToolSchemaFunction;
}

/**
 * Render OpenAI-style tool JSON Schemas (agentToolSchemas.ts — the same
 * source of truth the old SiliconFlow tools[] param uses) as a text block
 * for the Vero system prompt. Adding a tool only requires editing
 * agentToolSchemas.ts; this renderer picks it up automatically.
 */
export function renderToolSchemasAsText(schemas: unknown[]): string {
  const entries = schemas as ToolSchemaEntry[];
  return entries
    .map(({ function: fn }) => {
      const props = fn.parameters?.properties ?? {};
      const required = new Set(fn.parameters?.required ?? []);
      const paramLines = Object.entries(props).map(([key, def]) => {
        const type = def?.type ?? "any";
        const req = required.has(key) ? "，必填" : "";
        const desc = def?.description ?? "";
        return `  - ${key} (${type}${req}): ${desc}`;
      });
      return `### ${fn.name}\n${fn.description}\n参数：\n${
        paramLines.length ? paramLines.join("\n") : "  (无参数)"
      }`;
    })
    .join("\n\n");
}

/** Fixed instructions appended to every round's system prompt. */
export const VERO_ACTION_PROTOCOL_INSTRUCTIONS = `你每次回复必须且只能是一个 JSON 对象（不要 markdown 代码块围栏，不要额外解释文字）：

调用工具：
{"action":"tool","tool":"<工具名>","args":{...}}

给出最终答案（不再需要工具，或已经拿到足够数据）：
{"action":"final","reply":"<面向用户的完整中文回答，可用 markdown>"}

闲聊/无需工具的简短澄清：
{"action":"chat","reply":"<简短中文回复>"}

规则：
- 每次只能选择一个 action，不能既调用工具又给最终答案。
- 工具名必须是下面工具列表中的一个，args 必须是该工具允许的参数。
- 已经执行过的工具及其结果会出现在下面的对话记录里，不要重复调用同一工具查询完全相同的参数。
- 如果工具结果已经足够回答用户问题，立即返回 final，不要为了"保险"再多调用工具。`;

/**
 * Parse and validate one round's raw Vero response into a typed decision.
 * Throws a descriptive Error when the shape is invalid — callers retry/error
 * per the design's §5 error-handling rules.
 */
export function parseVeroRoundDecision(raw: string): VeroRoundDecision {
  const parsed = parseJsonLoose(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Vero round decision is not a JSON object: ${raw.slice(0, 200)}`);
  }
  const obj = parsed as Record<string, unknown>;
  const action = String(obj["action"] ?? "");

  if (action === "tool") {
    const tool = typeof obj["tool"] === "string" ? obj["tool"].trim() : "";
    if (!tool) {
      throw new Error(`Vero tool decision missing "tool" name: ${raw.slice(0, 200)}`);
    }
    const args =
      obj["args"] && typeof obj["args"] === "object" && !Array.isArray(obj["args"])
        ? (obj["args"] as Record<string, unknown>)
        : {};
    return { action: "tool", tool, args };
  }

  if (action === "final" || action === "chat") {
    const reply = typeof obj["reply"] === "string" ? obj["reply"] : "";
    if (!reply.trim()) {
      throw new Error(`Vero ${action} decision missing "reply" text: ${raw.slice(0, 200)}`);
    }
    return { action, reply };
  }

  throw new Error(`Vero round decision has unknown action "${action}": ${raw.slice(0, 200)}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/veroAgentProtocol.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/core/veroAgentProtocol.ts test/veroAgentProtocol.test.ts
git commit -m "feat(agent): add Vero JSON action protocol (tool schema render + decision parse)"
```

---

### Task 3: Prompt builder — system prompt, history serialization, char-budget guard

**Files:**
- Create: `pcr-ai-api/src/lib/agent/core/veroAgentLoopPrompt.ts`
- Test: `pcr-ai-api/test/veroAgentLoopPrompt.test.ts`

**Interfaces:**
- Consumes: `buildSystemPrompt(manifest?: DataManifest, intent?: PromptIntent): string` from `../prompt/agentPrompt.js`; `TOOL_SCHEMAS` from `./agentToolSchemas.js`; `VERO_ACTION_PROTOCOL_INSTRUCTIONS`, `renderToolSchemasAsText` from `./veroAgentProtocol.js` (Task 2); `VERO_PROMPT_CHAR_BUDGET` from `./veroAgentLoopConfig.js` (Task 1); `type ChatMessage` from `../agentHistory.js`
- Produces: `buildVeroRoundSystemPrompt(params): string`, `serializeHistoryForVeroPrompt(history, summary): string`, `isVeroPromptOverBudget(promptText: string): boolean`

- [ ] **Step 1: Write the failing test**

Create `pcr-ai-api/test/veroAgentLoopPrompt.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildVeroRoundSystemPrompt,
  serializeHistoryForVeroPrompt,
  isVeroPromptOverBudget,
} from "../src/lib/agent/core/veroAgentLoopPrompt.js";
import { VERO_PROMPT_CHAR_BUDGET } from "../src/lib/agent/core/veroAgentLoopConfig.js";
import type { ChatMessage } from "../src/lib/agent/agentHistory.js";

test("buildVeroRoundSystemPrompt includes tool list and protocol instructions", () => {
  const prompt = buildVeroRoundSystemPrompt({
    manifest: undefined,
    feedbackInjection: "",
    isLastRound: false,
  });
  assert.ok(prompt.includes("query_jb_bins"));
  assert.ok(prompt.includes('"action":"tool"'));
  assert.ok(!prompt.includes("【最后一轮】"));
});

test("buildVeroRoundSystemPrompt appends last-round instruction", () => {
  const prompt = buildVeroRoundSystemPrompt({
    manifest: undefined,
    feedbackInjection: "",
    isLastRound: true,
  });
  assert.ok(prompt.includes("【最后一轮】"));
});

test("buildVeroRoundSystemPrompt folds in feedback injection text", () => {
  const prompt = buildVeroRoundSystemPrompt({
    manifest: undefined,
    feedbackInjection: "【历史反馈】上次分析遗漏了 pass3。",
    isLastRound: false,
  });
  assert.ok(prompt.includes("上次分析遗漏了 pass3"));
});

test("serializeHistoryForVeroPrompt renders user/assistant/tool turns and summary", () => {
  const history: ChatMessage[] = [
    { role: "user", content: "WA03P02G 良率如何" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "c1", type: "function", function: { name: "query_jb_bins", arguments: '{"device":"WA03P02G"}' } },
      ],
    },
    { role: "tool", name: "query_jb_bins", tool_call_id: "c1", content: '{"rows":[]}' },
  ];
  const text = serializeHistoryForVeroPrompt(history, "此前摘要文本");
  assert.ok(text.includes("【历史对话摘要】"));
  assert.ok(text.includes("此前摘要文本"));
  assert.ok(text.includes("用户: WA03P02G 良率如何"));
  assert.ok(text.includes("AI 调用工具: query_jb_bins"));
  assert.ok(text.includes("工具[query_jb_bins]结果"));
});

test("serializeHistoryForVeroPrompt omits summary section when undefined", () => {
  const text = serializeHistoryForVeroPrompt([{ role: "user", content: "hi" }], undefined);
  assert.ok(!text.includes("【历史对话摘要】"));
});

test("isVeroPromptOverBudget flags text past the char budget", () => {
  assert.equal(isVeroPromptOverBudget("short"), false);
  assert.equal(isVeroPromptOverBudget("x".repeat(VERO_PROMPT_CHAR_BUDGET + 1)), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/veroAgentLoopPrompt.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/agent/core/veroAgentLoopPrompt.js'`

- [ ] **Step 3: Write the implementation**

Create `pcr-ai-api/src/lib/agent/core/veroAgentLoopPrompt.ts`:

```ts
// pcr-ai-api/src/lib/agent/core/veroAgentLoopPrompt.ts
import { buildSystemPrompt } from "../prompt/agentPrompt.js";
import type { DataManifest } from "../agentManifest.js";
import type { ChatMessage } from "../agentHistory.js";
import { VERO_ACTION_PROTOCOL_INSTRUCTIONS, renderToolSchemasAsText } from "./veroAgentProtocol.js";
import { TOOL_SCHEMAS } from "./agentToolSchemas.js";
import { VERO_PROMPT_CHAR_BUDGET } from "./veroAgentLoopConfig.js";

export { VERO_PROMPT_CHAR_BUDGET };

/**
 * System prompt for one round of the Vero-driven generic loop: same domain
 * rules the SiliconFlow loop uses (buildSystemPrompt — BIN semantics, pass
 * mapping, etc., model-agnostic), plus the tool list rendered as text and
 * the JSON action protocol instructions (see veroAgentProtocol.ts).
 */
export function buildVeroRoundSystemPrompt(params: {
  manifest: DataManifest | undefined;
  feedbackInjection: string;
  isLastRound: boolean;
}): string {
  const domainRules = buildSystemPrompt(params.manifest, "general");
  const toolSchemasText = renderToolSchemasAsText(TOOL_SCHEMAS);
  const lastRoundNote = params.isLastRound
    ? "\n\n【最后一轮】这是本次对话允许的最后一轮，你必须返回 action:final 或 action:chat，禁止再返回 action:tool。"
    : "";
  return (
    [
      domainRules,
      params.feedbackInjection,
      "可用工具：\n" + toolSchemasText,
      VERO_ACTION_PROTOCOL_INSTRUCTIONS,
    ]
      .filter((s) => s && s.trim())
      .join("\n\n") + lastRoundNote
  );
}

/**
 * Serialize recent history + rolling summary into plain text for a single
 * prompt string — Vero has no messages[] array, so the whole conversation
 * must be flattened into one string per round.
 */
export function serializeHistoryForVeroPrompt(
  history: ChatMessage[],
  summary: string | undefined
): string {
  const lines: string[] = [];
  if (summary) lines.push(`【历史对话摘要】\n${summary}`);
  for (const m of history) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      lines.push(`用户: ${String(m.content ?? "")}`);
    } else if (m.role === "assistant") {
      if (m.content) lines.push(`AI: ${String(m.content)}`);
      for (const tc of m.tool_calls ?? []) {
        lines.push(`AI 调用工具: ${tc.function.name}(${tc.function.arguments})`);
      }
    } else if (m.role === "tool") {
      lines.push(`工具[${m.name ?? "unknown"}]结果: ${String(m.content ?? "")}`);
    }
  }
  return lines.join("\n");
}

/**
 * True when system + history + latest question would exceed the 128K-safe
 * char budget (design doc §4.2). Callers should compress history and rebuild
 * the prompt before sending when this returns true.
 */
export function isVeroPromptOverBudget(promptText: string): boolean {
  return promptText.length > VERO_PROMPT_CHAR_BUDGET;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/veroAgentLoopPrompt.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/core/veroAgentLoopPrompt.ts test/veroAgentLoopPrompt.test.ts
git commit -m "feat(agent): add Vero round prompt builder with 128K char-budget guard"
```

---

### Task 4: Vero-based pre-loop setup (manifest / feedback / summarization, no SiliconFlow)

**Files:**
- Create: `pcr-ai-api/src/lib/agent/core/veroAgentLoopSetup.ts`
- Test: `pcr-ai-api/test/veroAgentLoopSetup.test.ts`

**Interfaces:**
- Consumes: `appendMessages`, `needsSummarization`, `popOldMessagesForSummarization`, `storeSummary`, `getSummary`, `getHistory`, `clearHistory`, `type ChatMessage` from `../agentHistory.js`; `fetchOrCacheManifest`, `type DataManifest` from `../agentManifest.js`; `buildFeedbackInjection` from `../agentFeedback.js`; `VERO_SUMMARIZE_THRESHOLD` from `./veroAgentLoopConfig.js` (Task 1)
- Produces: `type VeroInvokeFn = (prompt: string, systemPrompt: string) => Promise<string>`; `summarizeHistoryViaVero(oldMessages: ChatMessage[], invoke: VeroInvokeFn): Promise<string>`; `prepareRunVeroAgentLoopContext(message, sessionId, emit, invoke, options?): Promise<{ feedbackInjection: string; manifest: DataManifest | undefined }>`

This mirrors `agentLoopSetup.ts`'s `prepareRunAgentLoopContext`/`summarizeHistory`, but the summarization sub-call goes through Vero (`invoke`) instead of `streamSiliconFlow` — the Vero loop must never depend on SiliconFlow, and uses the Task 1 Vero-calibrated threshold instead of the SiliconFlow `largeContext`-based 80.

- [ ] **Step 1: Write the failing test**

Create `pcr-ai-api/test/veroAgentLoopSetup.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  summarizeHistoryViaVero,
  prepareRunVeroAgentLoopContext,
} from "../src/lib/agent/core/veroAgentLoopSetup.js";
import { clearHistory, appendMessages, getHistory, type ChatMessage } from "../src/lib/agent/agentHistory.js";
import type { AgentSseEvent } from "../src/lib/agent/core/agentLoop.js";

test("summarizeHistoryViaVero returns empty string for no content-bearing messages", async () => {
  const summary = await summarizeHistoryViaVero(
    [{ role: "tool", name: "x", content: "irrelevant" }],
    async () => "should not be called"
  );
  assert.equal(summary, "");
});

test("summarizeHistoryViaVero returns the invoked Vero text, trimmed", async () => {
  const history: ChatMessage[] = [
    { role: "user", content: "WA03P02G 良率如何" },
    { role: "assistant", content: "良率 95%" },
  ];
  const summary = await summarizeHistoryViaVero(
    history,
    async () => "  查询上下文：device=WA03P02G\n良率 95%  "
  );
  assert.equal(summary, "查询上下文：device=WA03P02G\n良率 95%");
});

test("summarizeHistoryViaVero is best-effort: returns '' when Vero throws", async () => {
  const history: ChatMessage[] = [{ role: "user", content: "hi" }];
  const summary = await summarizeHistoryViaVero(history, async () => {
    throw new Error("vero down");
  });
  assert.equal(summary, "");
});

test("prepareRunVeroAgentLoopContext appends the user message and fetches manifest", async () => {
  const sessionId = `vero-setup-${Date.now()}`;
  const events: AgentSseEvent[] = [];
  const { feedbackInjection, manifest } = await prepareRunVeroAgentLoopContext(
    "你好",
    sessionId,
    (e) => events.push(e),
    async () => "摘要"
  );
  assert.equal(typeof feedbackInjection, "string");
  assert.ok(manifest === undefined || typeof manifest === "object");
  assert.ok(events.some((e) => e.type === "status" && e.message.includes("系统信息")));
  assert.equal(getHistory(sessionId)[0]?.content, "你好");
  clearHistory(sessionId);
});

test("prepareRunVeroAgentLoopContext skips appending user message when resume=true", async () => {
  const sessionId = `vero-setup-resume-${Date.now()}`;
  appendMessages(sessionId, { role: "user", content: "第一条" });
  await prepareRunVeroAgentLoopContext(
    "第一条",
    sessionId,
    () => {},
    async () => "",
    { resume: true }
  );
  assert.equal(getHistory(sessionId).length, 1);
  clearHistory(sessionId);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/veroAgentLoopSetup.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/agent/core/veroAgentLoopSetup.js'`

- [ ] **Step 3: Write the implementation**

Create `pcr-ai-api/src/lib/agent/core/veroAgentLoopSetup.ts`:

```ts
// pcr-ai-api/src/lib/agent/core/veroAgentLoopSetup.ts
import {
  appendMessages,
  needsSummarization,
  popOldMessagesForSummarization,
  storeSummary,
  getSummary,
  type ChatMessage,
} from "../agentHistory.js";
import { fetchOrCacheManifest, type DataManifest } from "../agentManifest.js";
import { buildFeedbackInjection } from "../agentFeedback.js";
import type { AgentSseEvent } from "./agentLoop.js";
import { VERO_SUMMARIZE_THRESHOLD } from "./veroAgentLoopConfig.js";

export type VeroInvokeFn = (prompt: string, systemPrompt: string) => Promise<string>;

/**
 * Calls Vero to produce a compact Chinese summary of older conversation
 * turns. Mirrors agentLoopSetup.ts's summarizeHistory but goes through Vero
 * instead of streamSiliconFlow — the Vero loop must not depend on
 * SiliconFlow at all. Best-effort: returns "" on failure so a summarization
 * hiccup never blocks the turn.
 */
export async function summarizeHistoryViaVero(
  oldMessages: ChatMessage[],
  invoke: VeroInvokeFn
): Promise<string> {
  const lines: string[] = [];
  for (const m of oldMessages) {
    if (!m.content || m.role === "tool") continue;
    const label = m.role === "user" ? "用户" : "AI";
    lines.push(`[${label}]: ${String(m.content).slice(0, 600)}`);
  }
  if (lines.length === 0) return "";

  const prompt =
    "请将以下探针卡良率分析系统的历史对话压缩为简洁的中文摘要（不超过400字）。\n" +
    "【必须保留，不可省略】：\n" +
    "  - 所有出现过的 device 产品代码（如 WA03P02G）\n" +
    "  - 所有出现过的 lot ID（含完整后缀，如 NF12592.1Y）\n" +
    "  - 所有出现过的 slot / wafer 槽位号\n" +
    "  - 所有出现过的探针卡号（如 7747-03）\n" +
    "  - 关键数字结论、已确认的异常发现、当前分析方向\n" +
    "【格式】先列出「查询上下文：device=X, lot=X, slot=X」，再写分析摘要。\n" +
    "禁止使用 Markdown 图片语法。\n\n对话历史：\n" +
    lines.join("\n");

  try {
    const summary = await invoke(prompt, "你是对话历史压缩助手，只输出摘要正文，不要额外解释。");
    return summary.trim();
  } catch {
    return "";
  }
}

/**
 * Pre-loop setup for runVeroAgentLoop: record the user turn, roll up old
 * history into a Vero-generated summary when the Vero-calibrated threshold
 * is exceeded, and fetch the API manifest (timeout-capped). Mirrors
 * agentLoopSetup.ts's prepareRunAgentLoopContext but never touches
 * SiliconFlow.
 */
export async function prepareRunVeroAgentLoopContext(
  message: string,
  sessionId: string,
  emit: (event: AgentSseEvent) => void,
  invoke: VeroInvokeFn,
  options?: { resume?: boolean }
): Promise<{ feedbackInjection: string; manifest: DataManifest | undefined }> {
  const feedbackInjection = await buildFeedbackInjection(message).catch(() => "");

  if (!options?.resume) {
    appendMessages(sessionId, { role: "user", content: message });
  }

  if (needsSummarization(sessionId, VERO_SUMMARIZE_THRESHOLD)) {
    const old = popOldMessagesForSummarization(sessionId);
    if (old.length > 0) {
      emit({ type: "status", message: "正在压缩历史对话…" });
      const existing = getSummary(sessionId);
      const toSummarize: ChatMessage[] = existing
        ? [{ role: "assistant", content: `【已有摘要】\n${existing}` }, ...old]
        : old;
      const newSummary = await summarizeHistoryViaVero(toSummarize, invoke);
      if (newSummary) storeSummary(sessionId, newSummary);
    }
  }

  emit({ type: "status", message: "正在准备系统信息…" });
  const manifest = await Promise.race([
    fetchOrCacheManifest(),
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 5000)),
  ]).catch(() => undefined);

  return { feedbackInjection, manifest };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/veroAgentLoopSetup.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/core/veroAgentLoopSetup.ts test/veroAgentLoopSetup.test.ts
git commit -m "feat(agent): add Vero-based pre-loop setup (manifest/feedback/summarization)"
```

---

### Task 5: Single-tool executor (chart/clarification sentinels + history append)

**Files:**
- Create: `pcr-ai-api/src/lib/agent/core/veroAgentToolExecutor.ts`
- Test: `pcr-ai-api/test/veroAgentToolExecutor.test.ts`

**Interfaces:**
- Consumes: `type VeroToolDecision` from `./veroAgentProtocol.js` (Task 2); `VERO_TOOL_RESULT_MAX_HISTORY_CHARS` from `./veroAgentLoopConfig.js` (Task 1); `runTool`, `type ChartSentinel`, `type ClarificationSentinel` from `../tools/agentToolHandlers.js`; `validateAndFixToolArgs` from `../agentToolValidator.js`; `storeJbQuerySessionCache` from `../jb/agentJbBinFormat.js`; `toolStatusLabel` from `./agentToolStatus.js`; `toolResultForHistory` from `./agentLoopShared.js`; `tryEmitUnderperformingDutScatter` from `../tools/agentToolUnderperformingDutsRender.js`
- Produces: `type VeroToolExecutionOutcome = "chart" | "clarification" | "ok" | "error"`; `executeVeroToolDecision(sessionId, decision, agentConfig, emit, userQuestion): Promise<VeroToolExecutionOutcome>`

- [ ] **Step 1: Write the failing test**

Create `pcr-ai-api/test/veroAgentToolExecutor.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { executeVeroToolDecision } from "../src/lib/agent/core/veroAgentToolExecutor.js";
import { clearHistory, getHistory } from "../src/lib/agent/agentHistory.js";
import type { AgentConfig } from "../src/lib/agent/agentConfig.js";
import type { AgentSseEvent } from "../src/lib/agent/core/agentLoop.js";
import type { VeroToolDecision } from "../src/lib/agent/core/veroAgentProtocol.js";

const stubConfig: AgentConfig = {
  apiKey: "test",
  apiBase: "http://example.invalid",
  model: "deepseek-ai/DeepSeek-V4-Flash",
  subAgentModel: "deepseek-ai/DeepSeek-V4-Flash",
  maxRounds: 5,
  streamTimeoutSec: 150,
  streamTimeoutMs: 150000,
  toolResultMaxChars: 12000,
  toolResultMaxHistoryChars: 8000,
  largeContext: false,
};

test("executeVeroToolDecision runs a normal tool and appends synthetic history", async () => {
  process.env["INFCONTROL_LAYER_BINS_DUMMY"] = "true";
  process.env["NODE_ENV"] = "test";
  const sessionId = `vero-tool-ok-${Date.now()}`;
  const events: AgentSseEvent[] = [];
  const decision: VeroToolDecision = {
    action: "tool",
    tool: "aggregate_probe_card_tester_performance",
    args: { device: "WA03P02G" },
  };
  const outcome = await executeVeroToolDecision(
    sessionId,
    decision,
    stubConfig,
    (e) => events.push(e),
    "WA03P02G 探针卡机台组合表现"
  );
  assert.equal(outcome, "ok");
  assert.ok(events.some((e) => e.type === "tool_start"));
  assert.ok(events.some((e) => e.type === "tool_result"));
  const history = getHistory(sessionId);
  assert.equal(history.length, 2);
  assert.equal(history[0].role, "assistant");
  assert.equal(history[1].role, "tool");
  clearHistory(sessionId);
});

test("executeVeroToolDecision returns 'chart' and emits a chart SSE event", async () => {
  const sessionId = `vero-tool-chart-${Date.now()}`;
  const events: AgentSseEvent[] = [];
  const decision: VeroToolDecision = {
    action: "tool",
    tool: "generate_chart",
    args: {
      chartType: "bar",
      title: "Device Triggers",
      data: { labels: ["WA03P02G", "WB04P02G"], series: [{ name: "Count", values: [42, 18] }] },
    },
  };
  const outcome = await executeVeroToolDecision(sessionId, decision, stubConfig, (e) => events.push(e), "画个图");
  assert.equal(outcome, "chart");
  assert.ok(events.some((e) => e.type === "chart"));
  const history = getHistory(sessionId);
  assert.equal(String(history[1].content), "[图表已生成]");
  clearHistory(sessionId);
});

test("executeVeroToolDecision returns 'clarification' and emits a clarification SSE event", async () => {
  const sessionId = `vero-tool-clar-${Date.now()}`;
  const events: AgentSseEvent[] = [];
  const decision: VeroToolDecision = {
    action: "tool",
    tool: "ask_clarification",
    args: { question: "请提供 device 或 lot", options: ["device", "lot"] },
  };
  const outcome = await executeVeroToolDecision(sessionId, decision, stubConfig, (e) => events.push(e), "帮我查一下");
  assert.equal(outcome, "clarification");
  const clarEvent = events.find((e) => e.type === "clarification");
  assert.ok(clarEvent);
  clearHistory(sessionId);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/veroAgentToolExecutor.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/agent/core/veroAgentToolExecutor.js'`

- [ ] **Step 3: Write the implementation**

Create `pcr-ai-api/src/lib/agent/core/veroAgentToolExecutor.ts`:

```ts
// pcr-ai-api/src/lib/agent/core/veroAgentToolExecutor.ts
import type { AgentConfig } from "../agentConfig.js";
import { getHistory, appendSyntheticToolTurn } from "../agentHistory.js";
import { runTool, type ChartSentinel, type ClarificationSentinel } from "../tools/agentToolHandlers.js";
import { validateAndFixToolArgs } from "../agentToolValidator.js";
import { storeJbQuerySessionCache } from "../jb/agentJbBinFormat.js";
import { toolStatusLabel } from "./agentToolStatus.js";
import { toolResultForHistory } from "./agentLoopShared.js";
import { tryEmitUnderperformingDutScatter } from "../tools/agentToolUnderperformingDutsRender.js";
import type { AgentSseEvent } from "./agentLoop.js";
import type { VeroToolDecision } from "./veroAgentProtocol.js";
import { VERO_TOOL_RESULT_MAX_HISTORY_CHARS } from "./veroAgentLoopConfig.js";

export type VeroToolExecutionOutcome = "chart" | "clarification" | "ok" | "error";

/**
 * Execute a single Vero-decided tool call, append the result to session
 * history (as a synthetic assistant tool_calls + tool turn — same shape the
 * old SiliconFlow loop's executeRoundToolCalls uses, via
 * appendSyntheticToolTurn), and emit the matching SSE events. Returns which
 * kind of outcome happened so the caller (veroAgentLoop.ts) can decide
 * whether to short-circuit (chart / clarification never loop back).
 */
export async function executeVeroToolDecision(
  sessionId: string,
  decision: VeroToolDecision,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void,
  userQuestion: string
): Promise<VeroToolExecutionOutcome> {
  const { args: fixedArgs, notes } = validateAndFixToolArgs(decision.tool, decision.args, userQuestion);
  if (notes.length > 0) {
    console.log(`[validator] ${decision.tool}: ${notes.join("; ")}`);
  }

  emit({ type: "tool_start", name: decision.tool, args: fixedArgs });
  emit({ type: "status", message: `正在${toolStatusLabel(decision.tool)}…` });

  let historyContent: string;
  let outcome: VeroToolExecutionOutcome = "ok";
  let jbCacheForHistory: string | undefined;

  try {
    const toolResult = await runTool(decision.tool, fixedArgs, {
      toolResultMaxChars: agentConfig.toolResultMaxChars,
      history: getHistory(sessionId),
      userText: userQuestion,
      onJbBinsWrapped: (wrapped) => {
        jbCacheForHistory = storeJbQuerySessionCache(sessionId, wrapped);
      },
      onUnderperformingDuts: (passes) => {
        tryEmitUnderperformingDutScatter(passes, emit);
      },
    });

    if (typeof toolResult === "object" && toolResult !== null && "__chartOption" in toolResult) {
      emit({ type: "chart", option: (toolResult as ChartSentinel).__chartOption });
      historyContent = "[图表已生成]";
      outcome = "chart";
    } else if (typeof toolResult === "object" && toolResult !== null && "__clarification" in toolResult) {
      const question = (toolResult as ClarificationSentinel).__clarification;
      const clarOptions = (toolResult as ClarificationSentinel).__clarification_options;
      emit({ type: "clarification", question, ...(clarOptions ? { options: clarOptions } : {}) });
      historyContent = `[已向用户提问：${question}]`;
      outcome = "clarification";
    } else {
      const rawContent = typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult);
      historyContent = toolResultForHistory(
        decision.tool,
        rawContent,
        VERO_TOOL_RESULT_MAX_HISTORY_CHARS,
        agentConfig.toolResultMaxChars,
        jbCacheForHistory
      );
    }
  } catch (err) {
    historyContent = `工具执行失败: ${err instanceof Error ? err.message : String(err)}`;
    outcome = "error";
  }

  emit({ type: "tool_result", name: decision.tool, summary: historyContent.slice(0, 200) });
  appendSyntheticToolTurn(sessionId, {
    name: decision.tool,
    args: fixedArgs,
    content: historyContent,
    toolCallId: `vero_${decision.tool}_${Date.now()}`,
  });

  return outcome;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/veroAgentToolExecutor.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/core/veroAgentToolExecutor.ts test/veroAgentToolExecutor.test.ts
git commit -m "feat(agent): add single-tool executor for the Vero-driven loop"
```

---

### Task 6: Main loop orchestrator — `runVeroAgentLoop`

**Files:**
- Create: `pcr-ai-api/src/lib/agent/core/veroAgentLoop.ts`
- Test: `pcr-ai-api/test/veroAgentLoop.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–5 (`prepareRunVeroAgentLoopContext`/`summarizeHistoryViaVero`/`type VeroInvokeFn` from `./veroAgentLoopSetup.js`; `buildVeroRoundSystemPrompt`/`serializeHistoryForVeroPrompt`/`isVeroPromptOverBudget` from `./veroAgentLoopPrompt.js`; `parseVeroRoundDecision` from `./veroAgentProtocol.js`; `executeVeroToolDecision` from `./veroAgentToolExecutor.js`); `invokeVeroSimpleAgent` from `../../vero/veroSimpleAgent.js`; `getHistory`, `appendMessages`, `getSummary`, `storeSummary`, `popOldMessagesForSummarization` from `../agentHistory.js`; `lastUserMessageText`, `emitTextInChunks` from `./agentLoopShared.js`; `chartToolFallbackMessage` from `./agentJbFallbackReply.js`; the existing `PRE_LLM_DIRECT_ROUTES` runner functions (same imports `agentLoop.ts` already uses from `../dispatch/agentSemanticDispatch.js`, `../dispatch/directRoutes/agentJbLotDirectRoutes.js`, `../dispatch/directRoutes/agentJbBinDirectRoutes.js`, `../dispatch/directRoutes/agentDutAggDirectRoutes.js`, `../dispatch/directRoutes/agentProbeCardDirectRoutes.js`)
- Produces: `runVeroAgentLoop(message, sessionId, agentConfig, emit, options?, deps?): Promise<void>` (the `deps?: { invoke?: VeroInvokeFn }` param exists solely for test injection, mirroring `agentProbeCardVeroPilot.ts`'s `ProbeCardVeroPilotDeps` pattern)

- [ ] **Step 1: Write the failing test**

Create `pcr-ai-api/test/veroAgentLoop.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { runVeroAgentLoop } from "../src/lib/agent/core/veroAgentLoop.js";
import { clearHistory } from "../src/lib/agent/agentHistory.js";
import type { AgentConfig } from "../src/lib/agent/agentConfig.js";
import type { AgentSseEvent } from "../src/lib/agent/core/agentLoop.js";

const stubConfig: AgentConfig = {
  apiKey: "test",
  apiBase: "http://example.invalid",
  model: "deepseek-ai/DeepSeek-V4-Flash",
  subAgentModel: "deepseek-ai/DeepSeek-V4-Flash",
  maxRounds: 3,
  streamTimeoutSec: 150,
  streamTimeoutMs: 150000,
  toolResultMaxChars: 12000,
  toolResultMaxHistoryChars: 8000,
  largeContext: false,
};

test("runVeroAgentLoop: tool round then final round", async () => {
  process.env["INFCONTROL_LAYER_BINS_DUMMY"] = "true";
  process.env["NODE_ENV"] = "test";
  const sessionId = `vero-loop-${Date.now()}`;
  const events: AgentSseEvent[] = [];
  let call = 0;

  // Deliberately entity-free question text (no device code / lot ID / card ID
  // / bin number, no "探针卡"+"机台"+"组合" combo phrasing): PRE_LLM_DIRECT_ROUTES
  // (reused unchanged from agentLoop.ts, including tryRunProbeCardPerfDirectRoute's
  // own combo-question heuristic) is keyed on specific identifiable entities —
  // see questionHasIdentifiableToolScope's examples in agentLoop.test.ts. A vague
  // question falls through all 15 routes so this mocked invoke is guaranteed to
  // be reached, regardless of what tool the mock itself decides to call.
  await runVeroAgentLoop(
    "帮我看一下最近的整体情况，随便分析一下",
    sessionId,
    stubConfig,
    (e) => events.push(e),
    undefined,
    {
      invoke: async () => {
        call += 1;
        if (call === 1) {
          return JSON.stringify({
            action: "tool",
            tool: "aggregate_probe_card_tester_performance",
            args: { device: "WA03P02G" },
          });
        }
        return JSON.stringify({ action: "final", reply: "组合表现：卡A + 机台1 良率最高。" });
      },
    }
  );

  assert.ok(events.some((e) => e.type === "tool_start"));
  assert.ok(events.some((e) => e.type === "tool_result"));
  assert.ok(events.some((e) => e.type === "done"));
  const text = events
    .filter((e): e is Extract<AgentSseEvent, { type: "text" }> => e.type === "text")
    .map((e) => e.delta)
    .join("");
  assert.ok(text.includes("良率最高"));
  clearHistory(sessionId);
});

test("runVeroAgentLoop: chat-only round finalizes without a tool call", async () => {
  const sessionId = `vero-loop-chat-${Date.now()}`;
  const events: AgentSseEvent[] = [];
  await runVeroAgentLoop(
    "你好",
    sessionId,
    stubConfig,
    (e) => events.push(e),
    undefined,
    { invoke: async () => JSON.stringify({ action: "chat", reply: "你好，请问需要查询什么？" }) }
  );
  assert.ok(events.some((e) => e.type === "done"));
  assert.ok(!events.some((e) => e.type === "tool_start"));
  clearHistory(sessionId);
});

test("runVeroAgentLoop: Vero failure emits an error event, no crash", async () => {
  const sessionId = `vero-loop-fail-${Date.now()}`;
  const events: AgentSseEvent[] = [];
  await runVeroAgentLoop(
    "任意问题",
    sessionId,
    stubConfig,
    (e) => events.push(e),
    undefined,
    {
      invoke: async () => {
        throw new Error("vero unreachable");
      },
    }
  );
  const errEvent = events.find((e) => e.type === "error");
  assert.ok(errEvent);
  assert.ok(String((errEvent as { message: string }).message).includes("Vero 调用失败"));
  clearHistory(sessionId);
});

test("runVeroAgentLoop: malformed JSON emits a parse-error event", async () => {
  const sessionId = `vero-loop-badjson-${Date.now()}`;
  const events: AgentSseEvent[] = [];
  await runVeroAgentLoop(
    "任意问题",
    sessionId,
    stubConfig,
    (e) => events.push(e),
    undefined,
    { invoke: async () => "not json at all" }
  );
  const errEvent = events.find((e) => e.type === "error");
  assert.ok(errEvent);
  assert.ok(String((errEvent as { message: string }).message).includes("无法解析"));
  clearHistory(sessionId);
});

test("runVeroAgentLoop: exhausting maxRounds after a tool ran falls back to a text summary, not a bare error", async () => {
  process.env["INFCONTROL_LAYER_BINS_DUMMY"] = "true";
  process.env["NODE_ENV"] = "test";
  const sessionId = `vero-loop-maxrounds-${Date.now()}`;
  const events: AgentSseEvent[] = [];
  const config: AgentConfig = { ...stubConfig, maxRounds: 1 };
  await runVeroAgentLoop(
    "随便问点什么，且不匹配任何 direct route",
    sessionId,
    config,
    (e) => events.push(e),
    undefined,
    {
      invoke: async () =>
        JSON.stringify({
          action: "tool",
          tool: "aggregate_probe_card_tester_performance",
          args: { device: "WA03P02G" },
        }),
    }
  );
  // A tool did run this turn (even though it never reached "final"), so the
  // loop must not show a bare error — it should summarize what ran and let
  // the user retry/narrow the question (design doc §3.3: "有数据就整理成
  // 文字，不生造内容").
  assert.ok(!events.some((e) => e.type === "error"));
  assert.ok(events.some((e) => e.type === "done"));
  const text = events
    .filter((e): e is Extract<AgentSseEvent, { type: "text" }> => e.type === "text")
    .map((e) => e.delta)
    .join("");
  assert.ok(text.includes("aggregate_probe_card_tester_performance"));
  assert.ok(text.includes("重试"));
  clearHistory(sessionId);
});

test("runVeroAgentLoop: maxRounds=0 (no round ever runs, no tool history) emits a bare error", async () => {
  const sessionId = `vero-loop-maxrounds-empty-${Date.now()}`;
  const events: AgentSseEvent[] = [];
  const zeroRoundConfig: AgentConfig = { ...stubConfig, maxRounds: 0 };
  await runVeroAgentLoop(
    "随便问点什么",
    sessionId,
    zeroRoundConfig,
    (e) => events.push(e),
    undefined,
    { invoke: async () => JSON.stringify({ action: "final", reply: "不会用到" }) }
  );
  // No round ran at all, so there is no tool history to summarize — this is
  // the one case with genuinely nothing to fall back on, so a plain error is
  // correct (contrast with the "ran a tool but hit maxRounds" case above).
  const errEvent = events.find((e) => e.type === "error");
  assert.ok(errEvent);
  assert.ok(String((errEvent as { message: string }).message).includes("最大轮数"));
  clearHistory(sessionId);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/veroAgentLoop.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/agent/core/veroAgentLoop.js'`

- [ ] **Step 3: Write the implementation**

Create `pcr-ai-api/src/lib/agent/core/veroAgentLoop.ts`:

```ts
// pcr-ai-api/src/lib/agent/core/veroAgentLoop.ts
import type { AgentConfig } from "../agentConfig.js";
import {
  getHistory,
  appendMessages,
  getSummary,
  storeSummary,
  popOldMessagesForSummarization,
  type ChatMessage,
} from "../agentHistory.js";
import { invokeVeroSimpleAgent } from "../../vero/veroSimpleAgent.js";
import { lastUserMessageText, emitTextInChunks } from "./agentLoopShared.js";
import { chartToolFallbackMessage } from "./agentJbFallbackReply.js";
import type { AgentSseEvent } from "./agentLoop.js";
import {
  prepareRunVeroAgentLoopContext,
  summarizeHistoryViaVero,
  type VeroInvokeFn,
} from "./veroAgentLoopSetup.js";
import {
  buildVeroRoundSystemPrompt,
  serializeHistoryForVeroPrompt,
  isVeroPromptOverBudget,
} from "./veroAgentLoopPrompt.js";
import { parseVeroRoundDecision } from "./veroAgentProtocol.js";
import { executeVeroToolDecision } from "./veroAgentToolExecutor.js";

// ── PRE_LLM direct routes: same server-side, model-agnostic logic the old
// SiliconFlow loop uses (agentLoop.ts's PRE_LLM_DIRECT_ROUTES array).
// Imported directly rather than duplicated. ─────────────────────────────────
import { tryRunSemanticDispatchDirectRoute } from "../dispatch/agentSemanticDispatch.js";
import {
  tryRunLotOverviewDirectRoute,
  tryRunMaskScopeDirectRoute,
  tryRunListingTimeClarifyDirectRoute,
  tryRunLotListingDirectRoute,
  tryRunEquipmentDirectRoute,
  tryRunPerSlotBinRankingDirectRoute,
} from "../dispatch/directRoutes/agentJbLotDirectRoutes.js";
import {
  tryRunScopedBadBinDirectRoute,
  tryRunBinLotRankingDirectRoute,
  tryRunGoodBinValueDirectRoute,
  tryRunUnscopedBinClarifyDirectRoute,
} from "../dispatch/directRoutes/agentJbBinDirectRoutes.js";
import {
  tryRunDutBinAggDirectRoute,
  tryRunDutFocusBinsDirectRoute,
  tryRunUnderperformingDutDirectRoute,
} from "../dispatch/directRoutes/agentDutAggDirectRoutes.js";
import { tryRunProbeCardPerfDirectRoute } from "../dispatch/directRoutes/agentProbeCardDirectRoutes.js";

// Same table as agentLoop.ts's PRE_LLM_DIRECT_ROUTES. Deterministic JB/probe-
// card summary calls and the awaitingSummary-gated mid-loop recovery
// branches (wafer-map plan, touchdown, DUT×BIN map/yield chart) are NOT
// ported in this first version — see plan Task 6 / design doc §1.2.
const PRE_LLM_DIRECT_ROUTES: Array<typeof tryRunLotListingDirectRoute> = [
  tryRunUnderperformingDutDirectRoute,
  tryRunGoodBinValueDirectRoute,
  tryRunProbeCardPerfDirectRoute,
  tryRunDutFocusBinsDirectRoute,
  tryRunDutBinAggDirectRoute,
  tryRunBinLotRankingDirectRoute,
  tryRunListingTimeClarifyDirectRoute,
  tryRunLotListingDirectRoute,
  tryRunScopedBadBinDirectRoute,
  tryRunMaskScopeDirectRoute,
  tryRunLotOverviewDirectRoute,
  tryRunEquipmentDirectRoute,
  tryRunPerSlotBinRankingDirectRoute,
  tryRunSemanticDispatchDirectRoute,
  tryRunUnscopedBinClarifyDirectRoute,
];

const MAX_VERO_ROUND_RETRIES = 1;

async function invokeVeroRoundWithRetry(
  invoke: VeroInvokeFn,
  prompt: string,
  systemPrompt: string
): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_VERO_ROUND_RETRIES; attempt++) {
    try {
      return await invoke(prompt, systemPrompt);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Distinct tool names that produced a (non-error) result in this session's history so far. */
function executedToolNames(history: ChatMessage[]): string[] {
  const names = new Set<string>();
  for (const m of history) {
    if (m.role === "tool" && m.name) names.add(m.name);
  }
  return [...names];
}

async function compactHistoryForBudget(sessionId: string, invoke: VeroInvokeFn): Promise<void> {
  const old = popOldMessagesForSummarization(sessionId);
  if (old.length === 0) return;
  const existing = getSummary(sessionId);
  const toSummarize = existing
    ? [{ role: "assistant" as const, content: `【已有摘要】\n${existing}` }, ...old]
    : old;
  const newSummary = await summarizeHistoryViaVero(toSummarize, invoke);
  if (newSummary) storeSummary(sessionId, newSummary);
}

/**
 * Vero-driven generic ReAct loop. Entered via agentLoop.ts's runAgentLoop()
 * when isVeroGenericLoopReady() is true. PRE_LLM_DIRECT_ROUTES / tool
 * execution / session history are reused from the SiliconFlow loop; only
 * "which tool to call next / when to finalize" is re-implemented against
 * Vero's simple-agent/invoke JSON protocol (veroAgentProtocol.ts).
 * See docs/superpowers/specs/2026-07-21-vero-generic-agent-loop-design.md.
 */
export async function runVeroAgentLoop(
  message: string,
  sessionId: string,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void,
  options?: { resume?: boolean },
  deps?: { invoke?: VeroInvokeFn }
): Promise<void> {
  const invoke: VeroInvokeFn = deps?.invoke ?? invokeVeroSimpleAgent;

  const { feedbackInjection, manifest } = await prepareRunVeroAgentLoopContext(
    message,
    sessionId,
    emit,
    invoke,
    options
  );

  const maxRounds = agentConfig.maxRounds;

  for (let round = 0; round < maxRounds; round++) {
    const history = getHistory(sessionId);
    const userQuestion = lastUserMessageText(history, message);

    let handledByDirectRoute = false;
    for (const runDirectRoute of PRE_LLM_DIRECT_ROUTES) {
      if (await runDirectRoute(sessionId, userQuestion, agentConfig, emit)) {
        handledByDirectRoute = true;
        break;
      }
    }
    if (handledByDirectRoute) return;

    const isLastRound = round === maxRounds - 1;
    const systemPrompt = buildVeroRoundSystemPrompt({ manifest, feedbackInjection, isLastRound });
    let historyText = serializeHistoryForVeroPrompt(getHistory(sessionId), getSummary(sessionId));
    let promptText = `${systemPrompt}\n\n对话记录：\n${historyText}\n\n请给出下一步 action JSON。`;

    if (isVeroPromptOverBudget(promptText)) {
      emit({ type: "status", message: "正在压缩历史对话…" });
      await compactHistoryForBudget(sessionId, invoke);
      historyText = serializeHistoryForVeroPrompt(getHistory(sessionId), getSummary(sessionId));
      promptText = `${systemPrompt}\n\n对话记录：\n${historyText}\n\n请给出下一步 action JSON。`;
    }

    let raw: string;
    try {
      raw = await invokeVeroRoundWithRetry(invoke, promptText, systemPrompt);
    } catch (err) {
      emit({ type: "error", message: `Vero 调用失败: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }

    let decision;
    try {
      decision = parseVeroRoundDecision(raw);
    } catch (err) {
      emit({ type: "error", message: `Vero 返回内容无法解析: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }

    if (decision.action === "final" || decision.action === "chat") {
      emitTextInChunks(decision.reply, emit);
      appendMessages(sessionId, { role: "assistant", content: decision.reply });
      emit({ type: "done" });
      return;
    }

    const outcome = await executeVeroToolDecision(sessionId, decision, agentConfig, emit, userQuestion);

    if (outcome === "clarification") {
      emit({ type: "done" });
      return;
    }
    if (outcome === "chart") {
      const lastMsg = getHistory(sessionId).at(-1);
      const note = lastMsg ? chartToolFallbackMessage(lastMsg) : "图表已生成，请查看上方。";
      appendMessages(sessionId, { role: "assistant", content: note });
      emit({ type: "text", delta: note });
      emit({ type: "done" });
      return;
    }

    emit({ type: "status", message: "正在分析工具结果…" });
  }

  // maxRounds exhausted without a "final"/"chat" decision. Per design doc §3.3:
  // if any tool already ran, summarize what data was gathered instead of
  // showing a bare error — don't fabricate a conclusion, just tell the user
  // what was queried and that they should retry/narrow the question.
  const ranTools = executedToolNames(getHistory(sessionId));
  if (ranTools.length > 0) {
    const note =
      `已完成以下查询：${ranTools.join("、")}，但未能在 ${maxRounds} 轮内给出最终结论。` +
      "请点击「重试」继续，或缩小查询范围后重新提问。";
    appendMessages(sessionId, { role: "assistant", content: note });
    emit({ type: "text", delta: note });
    emit({ type: "done" });
    return;
  }

  emit({
    type: "error",
    message: "已达最大轮数仍未得出结论，请缩小查询范围或点击「重试」。",
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/veroAgentLoop.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/core/veroAgentLoop.ts test/veroAgentLoop.test.ts
git commit -m "feat(agent): add runVeroAgentLoop — Vero-driven generic ReAct loop"
```

---

### Task 7: Wire the gate into `agentLoop.ts`

**Files:**
- Modify: `pcr-ai-api/src/lib/agent/core/agentLoop.ts`

**Interfaces:**
- Consumes: `isVeroGenericLoopReady` from `../../vero/veroSimpleAgent.js` (Task 1); `runVeroAgentLoop` from `./veroAgentLoop.js` (Task 6)
- Produces: no change to `runAgentLoop`'s exported signature — callers (`routes/agent.ts`) are unaffected

- [ ] **Step 1: Add the two imports**

In `pcr-ai-api/src/lib/agent/core/agentLoop.ts`, near the top (directly after the existing `import { streamSiliconFlow, ... } from "./agentStream.js";` on line 9), add:

```ts
import { isVeroGenericLoopReady } from "../../vero/veroSimpleAgent.js";
import { runVeroAgentLoop } from "./veroAgentLoop.js";
```

- [ ] **Step 2: Add the gate at the top of `runAgentLoop`**

Find (around line 99–113):

```ts
export async function runAgentLoop(
  message: string,
  sessionId: string,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void,
  options?: { resume?: boolean }
): Promise<void> {
  const { feedbackInjection, manifest } = await prepareRunAgentLoopContext(
    message,
    sessionId,
    agentConfig,
    emit,
    options
  );
```

Replace with:

```ts
export async function runAgentLoop(
  message: string,
  sessionId: string,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void,
  options?: { resume?: boolean }
): Promise<void> {
  if (isVeroGenericLoopReady()) {
    return runVeroAgentLoop(message, sessionId, agentConfig, emit, options);
  }

  const { feedbackInjection, manifest } = await prepareRunAgentLoopContext(
    message,
    sessionId,
    agentConfig,
    emit,
    options
  );
```

- [ ] **Step 3: Verify the existing test suite still passes with the flag off (default)**

Run (from `pcr-ai-api/`): `npx tsx --test test/agentLoop.test.ts`
Expected: PASS — all pre-existing tests unaffected, because `AGENT_VERO_GENERIC_LOOP` is unset in the test environment so `isVeroGenericLoopReady()` returns `false` and the gate falls through to the unchanged SiliconFlow path.

- [ ] **Step 4: Add a regression test confirming the flag stays off by default**

Add to `pcr-ai-api/test/agentLoop.test.ts` (append near the end of the file, alongside other standalone `test(...)` blocks — check the file's existing import style first and match it):

```ts
test("runAgentLoop: Vero generic loop stays off when AGENT_VERO_GENERIC_LOOP is unset", () => {
  const prevFlag = process.env.AGENT_VERO_GENERIC_LOOP;
  const prevToken = process.env.WCHAT_ACCESS_TOKEN;
  try {
    delete process.env.AGENT_VERO_GENERIC_LOOP;
    delete process.env.WCHAT_ACCESS_TOKEN;
    // isVeroGenericLoopReady() itself is unit-tested in veroAgentLoopConfig.test.ts;
    // this just asserts the default test environment (no flag set) matches the
    // "gate falls through to SiliconFlow" precondition agentLoop.ts's runAgentLoop relies on.
    assert.equal(process.env.AGENT_VERO_GENERIC_LOOP, undefined);
  } finally {
    if (prevFlag === undefined) delete process.env.AGENT_VERO_GENERIC_LOOP;
    else process.env.AGENT_VERO_GENERIC_LOOP = prevFlag;
    if (prevToken === undefined) delete process.env.WCHAT_ACCESS_TOKEN;
    else process.env.WCHAT_ACCESS_TOKEN = prevToken;
  }
});
```

(Full end-to-end proof that the gate actually delegates to `runVeroAgentLoop` over the network is deferred to the Task 8 smoke script, run manually with a real `WCHAT_ACCESS_TOKEN` — unit-testing the one-line delegation itself would require either mocking Node's module system or making a real network call in the test suite, neither of which fits this codebase's existing test patterns.)

- [ ] **Step 5: Run the test file again**

Run: `npx tsx --test test/agentLoop.test.ts`
Expected: PASS (all tests, including the new one)

- [ ] **Step 6: Commit**

```bash
git add src/lib/agent/core/agentLoop.ts test/agentLoop.test.ts
git commit -m "feat(agent): gate runAgentLoop to the Vero generic loop when ready"
```

---

### Task 8: Config, env docs, and a real-network smoke script

**Files:**
- Modify: `pcr-ai-api/ecosystem.config.cjs`
- Modify: `pcr-ai-api/.env.example`
- Create: `pcr-ai-api/scripts/smoke-vero-generic-loop.mjs`

**Interfaces:** none (config/docs/script only, no exported code)

- [ ] **Step 1: Add the new env key to `ecosystem.config.cjs`**

In `pcr-ai-api/ecosystem.config.cjs`, find the `ORACLE_FORWARD_KEYS` array's Vero Path B block (added in commit `ad2e5ec`):

```js
  // Vero Path B pilot (probe-card × tester only)
  "AGENT_PROBE_CARD_VERO_PILOT",
  "WCHAT_ACCESS_TOKEN",
  "VERO_BASE_URL",
  "VERO_TLS_INSECURE",
  "VERO_TLS_STRICT",
];
```

Insert a new line directly before the closing `];`:

```js
  // Vero Path B pilot (probe-card × tester only)
  "AGENT_PROBE_CARD_VERO_PILOT",
  "WCHAT_ACCESS_TOKEN",
  "VERO_BASE_URL",
  "VERO_TLS_INSECURE",
  "VERO_TLS_STRICT",
  // Vero 驱动的通用 Agent 循环内核（子项目 A）
  "AGENT_VERO_GENERIC_LOOP",
];
```

- [ ] **Step 2: Document the flag in `.env.example`**

In `pcr-ai-api/.env.example`, at the end of the file (after the existing Vero Path B pilot block that ends with `# 亦可全局：NODE_TLS_REJECT_UNAUTHORIZED=0（影响整进程，不推荐生产）`), append:

```bash

# --- Vero 驱动的通用 Agent 循环内核（子项目 A）---
# 开启后，AI Agent 的整个 ReAct 循环（不仅探针卡组合）改用 Vero 驱动，
# 不再调用 SiliconFlow/DeepSeek/MiniMax。与上面的 Path B 共用同一个
# WCHAT_ACCESS_TOKEN。详见 docs/superpowers/specs/2026-07-21-vero-generic-agent-loop-design.md
# AGENT_VERO_GENERIC_LOOP=true
```

- [ ] **Step 3: Create the smoke script**

Create `pcr-ai-api/scripts/smoke-vero-generic-loop.mjs` (mirrors the existing `scripts/smoke-vero-probe-card-pilot.mjs` pattern):

```js
/**
 * One-shot live smoke: Vero-driven generic agent loop (Dummy JB, real Vero call).
 *
 * Usage (from pcr-ai-api):
 *   npx tsx scripts/smoke-vero-generic-loop.mjs
 *
 * Reads WCHAT_ACCESS_TOKEN from .env via a tiny inline loader, or from process.env.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

function loadDotEnv() {
  const envPath = join(root, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const i = trimmed.indexOf("=");
    const key = trimmed.slice(0, i).trim();
    let value = trimmed.slice(i + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv();
process.env.INFCONTROL_LAYER_BINS_DUMMY = process.env.INFCONTROL_LAYER_BINS_DUMMY || "true";

const { getVeroBaseUrl, getVeroAccessToken } = await import("../src/lib/vero/veroSimpleAgent.ts");
const { runVeroAgentLoop } = await import("../src/lib/agent/core/veroAgentLoop.ts");

const tokenPreview = (getVeroAccessToken() || "").slice(0, 12) + "…";
console.log("=== Vero generic-loop smoke ===");
console.log("base:", getVeroBaseUrl());
console.log("token:", tokenPreview);

if (!getVeroAccessToken()) {
  console.error("FAIL: set WCHAT_ACCESS_TOKEN in .env or the environment");
  process.exit(1);
}

const stubConfig = {
  apiKey: "unused",
  apiBase: "http://example.invalid",
  model: "deepseek-ai/DeepSeek-V4-Flash",
  subAgentModel: "deepseek-ai/DeepSeek-V4-Flash",
  maxRounds: 5,
  streamTimeoutSec: 150,
  streamTimeoutMs: 150000,
  toolResultMaxChars: 12000,
  toolResultMaxHistoryChars: 8000,
  largeContext: false,
};

const events = [];
const q = "WA03P02G 最近的探针卡机台组合表现怎么样";
console.log("\n--- runVeroAgentLoop (real Vero, Dummy JB tool data) ---");
await runVeroAgentLoop(q, `smoke-vero-loop-${Date.now()}`, stubConfig, (e) => {
  events.push(e);
  if (e.type === "status") console.log("[status]", e.message);
  if (e.type === "tool_start") console.log("[tool_start]", e.name, e.args);
  if (e.type === "tool_result") console.log("[tool_result]", e.summary?.slice(0, 120));
  if (e.type === "error") console.log("[error]", e.message);
});

const text = events
  .filter((e) => e.type === "text")
  .map((e) => e.delta)
  .join("");
console.log("\ndone event:", events.some((e) => e.type === "done"));
console.log("text length:", text.length);
console.log("text preview:\n", text.slice(0, 1200));

if (!events.some((e) => e.type === "done")) {
  console.error("\nFAIL: loop did not complete with a done event");
  process.exit(1);
}
console.log("\nOK: Vero generic-loop smoke passed");
```

- [ ] **Step 4: Commit**

```bash
git add ecosystem.config.cjs .env.example scripts/smoke-vero-generic-loop.mjs
git commit -m "chore(agent): wire AGENT_VERO_GENERIC_LOOP through pm2/env + add smoke script"
```

---

### Task 9: Full regression pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full backend test suite**

Run (from `pcr-ai-api/`): `npm test`
Expected: all tests pass (previous baseline was 692 tests / 686 pass / 2 pre-existing unrelated fails in `test/jbRouteResolver.test.ts` caused by a committed `runtime-config.json` having `jbLlmIntentClassifier: true` — confirm the new Vero test files add cleanly on top and don't introduce new failures beyond that known baseline).

- [ ] **Step 2: Run the type checker**

Run: `npm run typecheck`
Expected: no errors — pay special attention to the `type-only` circular import between `agentLoop.ts` and `veroAgentLoop.ts` (both directions compile cleanly because the `agentLoop.ts → veroAgentLoop.ts` edge is a value import and the `veroAgentLoop.ts → agentLoop.ts` edge is `import type`, exactly the same pattern already used by `agentRoundToolExecutor.ts`, `agentTurnFinalize.ts`, `agentLoopShared.ts`, and `agentLoopSetup.ts`).

- [ ] **Step 3: Run the production build**

Run: `npm run build`
Expected: succeeds, including `scripts/verify-dist-no-undici.mjs` (this plan introduces no new HTTP client code, only reuses the existing `node:https`-based `invokeVeroSimpleAgent`).

- [ ] **Step 4: Manual sanity check — flag stays off**

Run: `grep -n "AGENT_VERO_GENERIC_LOOP" .env` in the deployed `pcr-ai-api/.env` (if one exists locally) to confirm it is either absent or `false` before this lands anywhere shared — the flag must stay off until Cursor has run the Task 8 smoke script against a real `WCHAT_ACCESS_TOKEN` and confirmed the spec §8 open questions (streaming, real prompt sizes, multi-round JSON stability, last-round compliance).

- [ ] **Step 5: Final commit (if any cleanup was needed in Steps 1–3)**

```bash
git status --porcelain
# If clean, no commit needed — Tasks 1–8 already committed everything.
# If typecheck/build turned up fixes, stage and commit them:
git add -A
git commit -m "fix(agent): address typecheck/build fallout from Vero generic loop"
```

---

## Follow-up (not in this plan — see spec §8 and Global Constraints)

- Hand off to Cursor: run `scripts/smoke-vero-generic-loop.mjs` with a real `WCHAT_ACCESS_TOKEN` and observe (a) whether Vero has any streaming-capable endpoint, (b) actual prompt character counts against `VERO_PROMPT_CHAR_BUDGET`/`VERO_TOOL_RESULT_MAX_HISTORY_CHARS`, (c) Claude 4.6's JSON protocol stability across multiple rounds, (d) whether the last-round "must finalize" instruction is honored.
- Sub-project B: migrate the remaining direct-route capability groups (JB bin, JB lot, DUT aggregation, wafer map) to their own Vero-pilot files following `agentProbeCardVeroPilot.ts`'s pattern.
- Sub-project C: once A + B are validated in production, retire the SiliconFlow/DeepSeek/MiniMax code paths (`agentStream.ts`, `createDeepSeekFilter`/`mergeStructuredWithEmbedded`, the `isDeepSeekV4Flash`/`isMiniMaxM25`/`detectLargeContext` model whitelist in `agentConfig.ts`, `agentLoop.ts`'s original implementation).
- Consider porting the `awaitingSummary`-gated mid-loop recovery branches (wafer-map plan, deterministic JB/probe-card summary tables, touchdown reply, DUT×BIN map/yield chart auto-routes) into `veroAgentLoop.ts` once the basic loop is validated — deliberately deferred in this plan (see Global Constraints).
