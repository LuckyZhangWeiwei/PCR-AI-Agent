# JB/DUT Deterministic-Table Commentary → Vero Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route the "### 数据解读 / ### 专业建议" commentary step of JB deterministic-table replies and DUT×BIN focus replies through Vero (`invokeVeroSimpleAgent`) when `isVeroGenericLoopReady()` is true, falling back to the existing SiliconFlow path otherwise — extending sub-project A's default-on Vero migration to the deterministic-table direct routes that sub-project A itself did not touch.

**Architecture:** Extract the commentary-generation branch that already exists in `agentProbeCardPerfReply.ts`'s `invokeCommentary` option (Path B, already shipped) into one small shared helper, `emitBriefCommentaryOrFallback`, used by the three call sites that share `BRIEF_COMMENTARY_SYSTEM` (JB tables + two DUT×BIN focus routes). No new abstraction layer, no pluggable backend interface — one plain async function with the same branch shape Path B already proved in production, following the user's explicit direction to stay close to the existing code style rather than building the `agentLlmBackend.ts` interface proposed in `docs/HANDOFF_CURSOR_WCHAT_MIGRATION_OPTIMAL_2026-07-22.md` Phase 1.

**Tech Stack:** TypeScript, Node.js `node:test`, existing `invokeVeroSimpleAgent` / `streamSiliconFlow` clients (no new dependencies).

## Global Constraints

- **dummy-parity does not apply**: this only changes which LLM backend generates free-text commentary after the deterministic tables are already built server-side from Oracle/Dummy data; no SQL, WHERE clause, or aggregation logic changes.
- **no-undici**: reuses the existing `invokeVeroSimpleAgent` (`node:https`) and `streamSiliconFlow` clients as-is; do not introduce any new HTTP client.
- **oracledb@5.5**: untouched by this plan.
- **Never write `WCHAT_ACCESS_TOKEN` into source, tests, or docs.**
- Preserve exact current behavior when `isVeroGenericLoopReady()` is false (no token / flag explicitly off): identical SiliconFlow call, identical status/section-title/fallback text, byte-for-byte, so existing indirect test coverage of these routes does not regress.

---

## Task 1: Shared Vero-or-SiliconFlow commentary helper

**Files:**
- Create: `pcr-ai-api/src/lib/agent/render/agentBriefCommentary.ts`
- Test: `pcr-ai-api/test/agentBriefCommentary.test.ts`

**Interfaces:**
- Produces: `emitBriefCommentaryOrFallback(userQuestion: string, tablesMarkdown: string, context: BriefCommentaryContext, agentConfig: AgentConfig, emit: (event: AgentSseEvent) => void, options?: EmitBriefCommentaryOptions): Promise<string>` — emits the `status` + section-title + commentary/fallback SSE events, returns the final commentary-or-fallback text for the caller to append to session history.
- `BriefCommentaryContext = { engineeringContext?: string; yieldMonitorNote?: string }` — passed straight through to the existing `buildBriefCommentaryUserMessage`.
- `EmitBriefCommentaryOptions = { statusMessage?: string; invoke?: VeroInvokeFn }` — `invoke` is a test seam (default `invokeVeroSimpleAgent`), mirroring the `deps?.invoke` pattern already used in `veroAgentLoop.ts` / `veroAgentLoopSetup.ts`.

- [ ] **Step 1: Write the failing tests**

Create `pcr-ai-api/test/agentBriefCommentary.test.ts`:

```typescript
import assert from "node:assert/strict";
import test from "node:test";

import { emitBriefCommentaryOrFallback } from "../src/lib/agent/render/agentBriefCommentary.js";
import { resolveAgentConfig } from "../src/lib/agent/agentConfig.js";
import type { AgentSseEvent } from "../src/lib/agent/core/agentLoop.js";

const baseConfig = resolveAgentConfig({
  apiKey: "sk-test",
  apiBase: "https://api.siliconflow.cn/v1",
  model: "test-model",
  subAgentModel: "test-sub-model",
});

async function withVeroFlag<T>(
  enabled: boolean,
  token: string | undefined,
  fn: () => Promise<T>
): Promise<T> {
  const prevFlag = process.env.AGENT_VERO_GENERIC_LOOP;
  const prevToken = process.env.WCHAT_ACCESS_TOKEN;
  process.env.AGENT_VERO_GENERIC_LOOP = enabled ? "true" : "false";
  if (token === undefined) delete process.env.WCHAT_ACCESS_TOKEN;
  else process.env.WCHAT_ACCESS_TOKEN = token;
  try {
    return await fn();
  } finally {
    if (prevFlag === undefined) delete process.env.AGENT_VERO_GENERIC_LOOP;
    else process.env.AGENT_VERO_GENERIC_LOOP = prevFlag;
    if (prevToken === undefined) delete process.env.WCHAT_ACCESS_TOKEN;
    else process.env.WCHAT_ACCESS_TOKEN = prevToken;
  }
}

test("emitBriefCommentaryOrFallback: Vero ready + invoke returns text -> chunks it out, returns it, never touches SiliconFlow", async () => {
  await withVeroFlag(true, "tok", async () => {
    const events: AgentSseEvent[] = [];
    const result = await emitBriefCommentaryOrFallback(
      "问题",
      "| a | b |",
      { engineeringContext: "ctx" },
      baseConfig,
      (e) => events.push(e),
      { invoke: async () => "这是解读内容。" }
    );
    assert.equal(result, "这是解读内容。");
    assert.ok(events.some((e) => e.type === "status"));
    const text = events
      .filter((e): e is Extract<AgentSseEvent, { type: "text" }> => e.type === "text")
      .map((e) => e.delta)
      .join("");
    assert.ok(text.includes(`${"###"} 数据解读`) || text.includes("数据解读"));
    assert.ok(text.includes("这是解读内容。"));
  });
});

test("emitBriefCommentaryOrFallback: Vero ready + invoke throws -> returns failure fallback text, includes the error message", async () => {
  await withVeroFlag(true, "tok", async () => {
    const result = await emitBriefCommentaryOrFallback(
      "问题",
      "| a | b |",
      {},
      baseConfig,
      () => {},
      {
        invoke: async () => {
          throw new Error("vero down");
        },
      }
    );
    assert.ok(result.includes("解读生成失败"));
    assert.ok(result.includes("vero down"));
  });
});

test("emitBriefCommentaryOrFallback: Vero ready + invoke returns empty/whitespace -> returns empty fallback text", async () => {
  await withVeroFlag(true, "tok", async () => {
    const result = await emitBriefCommentaryOrFallback(
      "问题",
      "| a | b |",
      {},
      baseConfig,
      () => {},
      { invoke: async () => "   " }
    );
    assert.ok(result.includes("模型未返回解读"));
  });
});

test("emitBriefCommentaryOrFallback: Vero not ready -> never calls invoke, falls back to the SiliconFlow path", async () => {
  await withVeroFlag(false, undefined, async () => {
    let invokeCalled = false;
    const events: AgentSseEvent[] = [];
    // Point apiBase at an unroutable host with a short timeout so the
    // SiliconFlow branch resolves quickly through its own error handling
    // (the wire-level behavior of streamSiliconFlow itself is already
    // covered end-to-end by agentStream.test.ts) — this test only needs to
    // prove the Vero invoke path is never reached when the flag is off.
    const config = resolveAgentConfig({
      apiKey: "sk-test",
      apiBase: "https://127.0.0.1:1",
      model: "test-model",
      subAgentModel: "test-sub-model",
      streamTimeoutMs: 200,
    });
    const result = await emitBriefCommentaryOrFallback(
      "问题",
      "| a | b |",
      {},
      config,
      (e) => events.push(e),
      {
        invoke: async () => {
          invokeCalled = true;
          return "should not be called";
        },
      }
    );
    assert.equal(invokeCalled, false);
    assert.ok(result.length > 0);
    assert.ok(events.some((e) => e.type === "status"));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd pcr-ai-api && npx tsx --test test/agentBriefCommentary.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/agent/render/agentBriefCommentary.js'` (module does not exist yet).

- [ ] **Step 3: Write the implementation**

Create `pcr-ai-api/src/lib/agent/render/agentBriefCommentary.ts`:

```typescript
// pcr-ai-api/src/lib/agent/render/agentBriefCommentary.ts
// Shared "数据解读/专业建议" LLM commentary step used by JB table replies
// (agentJbTablesReply.ts) and DUT×BIN focus replies
// (agentDutAggDirectRoutes.ts). Vero when AGENT_VERO_GENERIC_LOOP is ready
// (see veroSimpleAgent.ts's isVeroGenericLoopReady), else the existing
// SiliconFlow streaming path — same branch shape already shipped in
// agentProbeCardPerfReply.ts's invokeCommentary option (Path B), just DRYed
// across the call sites that share BRIEF_COMMENTARY_SYSTEM instead of the
// probe-card-specific system prompt.
import type { AgentConfig } from "../agentConfig.js";
import type { AgentSseEvent } from "../core/agentLoop.js";
import {
  cleanStreamErrorMessage,
  emitTextInChunks,
} from "../core/agentLoopShared.js";
import { createDeepSeekFilter } from "../core/agentEmbeddedToolParsing.js";
import { streamSiliconFlow } from "../core/agentStream.js";
import type { VeroInvokeFn } from "../core/veroAgentLoopSetup.js";
import {
  invokeVeroSimpleAgent,
  buildVeroChatMessageWithSystem,
  isVeroGenericLoopReady,
} from "../../vero/veroSimpleAgent.js";
import {
  BRIEF_COMMENTARY_SYSTEM,
  buildBriefCommentaryUserMessage,
  DETERMINISTIC_COMMENTARY_SECTION_TITLE,
} from "../jb/agentJbOverviewMarkdown.js";

export type BriefCommentaryContext = {
  engineeringContext?: string;
  yieldMonitorNote?: string;
};

export type EmitBriefCommentaryOptions = {
  /** SSE status line while generating (default: "正在生成数据解读…"). */
  statusMessage?: string;
  /** Test seam: override the Vero invoke function (default: invokeVeroSimpleAgent). */
  invoke?: VeroInvokeFn;
};

const VERO_COMMENTARY_SYSTEM_PLACEHOLDER =
  "You write brief Chinese engineering commentary only. No tools. No tables.";

/**
 * Emits the "### 数据解读 / ### 专业建议" section for a deterministic table
 * reply and returns the commentary-or-fallback text so the caller can
 * append it to session history.
 */
export async function emitBriefCommentaryOrFallback(
  userQuestion: string,
  tablesMarkdown: string,
  context: BriefCommentaryContext,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void,
  options?: EmitBriefCommentaryOptions
): Promise<string> {
  emit({
    type: "status",
    message: options?.statusMessage ?? "正在生成数据解读…",
  });
  emit({
    type: "text",
    delta: `\n\n${DETERMINISTIC_COMMENTARY_SECTION_TITLE}\n\n`,
  });

  if (isVeroGenericLoopReady()) {
    const invoke = options?.invoke ?? invokeVeroSimpleAgent;
    try {
      const message = buildVeroChatMessageWithSystem(
        BRIEF_COMMENTARY_SYSTEM,
        buildBriefCommentaryUserMessage(userQuestion, tablesMarkdown, context)
      );
      const text = (
        await invoke(message, VERO_COMMENTARY_SYSTEM_PLACEHOLDER)
      ).trim();
      if (text) {
        emitTextInChunks(text, emit);
        return text;
      }
      const emptyFallback = "*（模型未返回解读；以上实测数据表为准。）*";
      emit({ type: "text", delta: emptyFallback });
      return emptyFallback;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errFallback = `*（解读生成失败：${cleanStreamErrorMessage(msg)}；以上实测数据表为准。）*`;
      emit({ type: "text", delta: errFallback });
      return errFallback;
    }
  }

  const commFilter = createDeepSeekFilter(emit);
  let streamError: string | undefined;
  await streamSiliconFlow(
    {
      model: agentConfig.subAgentModel,
      messages: [
        { role: "system", content: BRIEF_COMMENTARY_SYSTEM },
        {
          role: "user",
          content: buildBriefCommentaryUserMessage(
            userQuestion,
            tablesMarkdown,
            context
          ),
        },
      ],
      max_tokens: 1024,
    },
    agentConfig,
    (chunk) => {
      if (chunk.type === "delta") commFilter.push(chunk.text);
      if (chunk.type === "error") streamError = chunk.message;
    }
  );
  commFilter.finalize();
  const commentary = commFilter.cleanText.trim();
  if (commentary) return commentary;

  const fallback = streamError
    ? `*（解读生成失败：${cleanStreamErrorMessage(streamError)}；以上实测数据表为准。）*`
    : `*（模型未返回解读；以上实测数据表为准。）*`;
  emit({ type: "text", delta: fallback });
  return fallback;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd pcr-ai-api && npx tsx --test test/agentBriefCommentary.test.ts`
Expected: PASS — 4/4 tests green.

- [ ] **Step 5: Typecheck**

Run: `cd pcr-ai-api && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
cd pcr-ai-api
git add src/lib/agent/render/agentBriefCommentary.ts test/agentBriefCommentary.test.ts
git commit -m "feat(agent): add shared Vero-or-SiliconFlow brief-commentary helper"
```

---

## Task 2: Wire the helper into JB deterministic-table replies

**Files:**
- Modify: `pcr-ai-api/src/lib/agent/render/agentJbTablesReply.ts`

**Interfaces:**
- Consumes: `emitBriefCommentaryOrFallback` from Task 1 (`../render/agentBriefCommentary.js` relative to this file's own directory is `./agentBriefCommentary.js`).

This function (`emitDeterministicJbTablesReply`) is the single renderer behind 8 call sites across `agentJbBinDirectRoutes.ts`, `agentJbLotDirectRoutes.ts`, and `agentSemanticDispatch.ts` — none of those callers need to change; they all call this function with no 5th `options` argument already, so this task's change applies to every one of them automatically.

- [ ] **Step 1: Replace the import block**

In `pcr-ai-api/src/lib/agent/render/agentJbTablesReply.ts`, find:

```typescript
import {
  BRIEF_COMMENTARY_SYSTEM,
  buildBriefCommentaryUserMessage,
  buildDeterministicJbTables,
  buildEngineeringContextFromPayload,
  DETERMINISTIC_DATA_SECTION_TITLE,
  DETERMINISTIC_COMMENTARY_SECTION_TITLE,
  stampFirstTestNote,
  buildDeterministicLotOverviewCommentary,
} from "../jb/agentJbOverviewMarkdown.js";
import {
  shouldAppendUnderperformingDutYield,
} from "../jb/agentJbPayloadResolve.js";
import { jbListingScopeLabel, resolveJbListingScope } from "../agentQueryScope.js";
import { tryAppendUnderperformingDutSection } from "../tools/agentToolUnderperformingDutsRender.js";
import { createDeepSeekFilter } from "../core/agentEmbeddedToolParsing.js";
import { streamSiliconFlow } from "../core/agentStream.js";
```

Replace with:

```typescript
import {
  buildDeterministicJbTables,
  buildEngineeringContextFromPayload,
  DETERMINISTIC_DATA_SECTION_TITLE,
  DETERMINISTIC_COMMENTARY_SECTION_TITLE,
  stampFirstTestNote,
  buildDeterministicLotOverviewCommentary,
} from "../jb/agentJbOverviewMarkdown.js";
import {
  shouldAppendUnderperformingDutYield,
} from "../jb/agentJbPayloadResolve.js";
import { jbListingScopeLabel, resolveJbListingScope } from "../agentQueryScope.js";
import { tryAppendUnderperformingDutSection } from "../tools/agentToolUnderperformingDutsRender.js";
import { emitBriefCommentaryOrFallback } from "./agentBriefCommentary.js";
```

Also find (near the top of the same import block):

```typescript
import {
  lastToolMessage,
  emitTextInChunks,
  cleanStreamErrorMessage,
} from "../core/agentLoopShared.js";
```

Replace with (this file's own `emitTextInChunks` calls for the tables block remain; `cleanStreamErrorMessage` is no longer used directly here — it moved into `agentBriefCommentary.ts`):

```typescript
import {
  lastToolMessage,
  emitTextInChunks,
} from "../core/agentLoopShared.js";
```

- [ ] **Step 2: Replace the inline commentary block**

Find:

```typescript
  emit({ type: "status", message: "正在生成数据解读与专业建议…" });
  // 先推送分段标题，避免解读文字与上方表格落在同一 Markdown 块里被 GFM 当成表尾行
  emit({
    type: "text",
    delta: `\n\n${DETERMINISTIC_COMMENTARY_SECTION_TITLE}\n\n`,
  });

  const commFilter = createDeepSeekFilter(emit);
  let streamError: string | undefined;

  await streamSiliconFlow(
    {
      model: agentConfig.subAgentModel, // 表解读：结构化输入/有界输出，sub-agent 模型即可
      messages: [
        { role: "system", content: BRIEF_COMMENTARY_SYSTEM },
        {
          role: "user",
          content: buildBriefCommentaryUserMessage(userQuestion, tables, {
            engineeringContext: buildEngineeringContextFromPayload(payload),
            yieldMonitorNote: yieldMonitorNoteFromHistory(history),
          }),
        },
      ],
      // No tool schemas: commentary is text-only (数据解读 + 专业建议 ≈ 300-600 tokens)
      max_tokens: 1024,
    },
    agentConfig,
    (chunk) => {
      switch (chunk.type) {
        case "delta":
          commFilter.push(chunk.text);
          break;
        case "error":
          streamError = chunk.message;
          break;
        default:
          break;
      }
    }
  );

  commFilter.finalize();
  const commentary = commFilter.cleanText.trim();

  // 标题已 SSE 流出；若解读为空则 emit fallback，保持用户所见与 history 一致
  let commentaryOrFallback: string;
  if (commentary) {
    commentaryOrFallback = commentary;
  } else {
    commentaryOrFallback = streamError
      ? `*（解读生成失败：${cleanStreamErrorMessage(streamError)}；以上实测数据表为准。）*`
      : `*（模型未返回解读；以上实测数据表为准。）*`;
    emit({ type: "text", delta: commentaryOrFallback });
  }
```

Replace with:

```typescript
  const commentaryOrFallback = await emitBriefCommentaryOrFallback(
    userQuestion,
    tables,
    {
      engineeringContext: buildEngineeringContextFromPayload(payload),
      yieldMonitorNote: yieldMonitorNoteFromHistory(history),
    },
    agentConfig,
    emit,
    { statusMessage: "正在生成数据解读与专业建议…" }
  );
```

- [ ] **Step 3: Typecheck**

Run: `cd pcr-ai-api && npx tsc --noEmit`
Expected: no errors (confirms no other code in the file still referenced the removed imports).

- [ ] **Step 4: Run the full test suite**

Run: `cd pcr-ai-api && npm test`
Expected: same pass/fail counts as before this task (721 pass / 2 known pre-existing `jbRouteResolver.test.ts` failures / 4 skipped) — this task is a behavior-preserving refactor when Vero is not ready, so nothing that exercises these 8 JB call sites should change.

- [ ] **Step 5: Commit**

```bash
cd pcr-ai-api
git add src/lib/agent/render/agentJbTablesReply.ts
git commit -m "refactor(agent): route JB table commentary through emitBriefCommentaryOrFallback"
```

---

## Task 3: Wire the helper into the two DUT×BIN focus commentary call sites

**Files:**
- Modify: `pcr-ai-api/src/lib/agent/dispatch/directRoutes/agentDutAggDirectRoutes.ts`

**Interfaces:**
- Consumes: `emitBriefCommentaryOrFallback` from Task 1 (`../../render/agentBriefCommentary.js` relative to this file's directory).

Two call sites in this file: `emitFocusDutBinsReply` (private helper behind `tryRunDutFocusBinsDirectRoute`) and the inline block inside `tryRunDutBinAggDirectRoute` (the `query_lot_dut_bin_agg` route). Both currently duplicate the same SiliconFlow-calling block that Task 1's helper now replaces.

- [ ] **Step 1: Replace the import block**

Find:

```typescript
import {
  emitTextInChunks,
  lastToolMessage,
  cleanStreamErrorMessage,
} from "../../core/agentLoopShared.js";
import type { AgentSseEvent } from "../../core/agentLoop.js";
import { streamSiliconFlow } from "../../core/agentStream.js";
import { createDeepSeekFilter } from "../../core/agentEmbeddedToolParsing.js";
import {
  tryEmitDutBinBarChart,
  buildDutBinAggMarkdown,
} from "../../render/agentChartEmitters.js";
```

Replace with:

```typescript
import {
  emitTextInChunks,
  lastToolMessage,
} from "../../core/agentLoopShared.js";
import type { AgentSseEvent } from "../../core/agentLoop.js";
import {
  tryEmitDutBinBarChart,
  buildDutBinAggMarkdown,
} from "../../render/agentChartEmitters.js";
import { emitBriefCommentaryOrFallback } from "../../render/agentBriefCommentary.js";
```

Also find:

```typescript
import {
  BRIEF_COMMENTARY_SYSTEM,
  buildBriefCommentaryUserMessage,
  buildEngineeringContextFromPayload,
  DETERMINISTIC_DATA_SECTION_TITLE,
  DETERMINISTIC_COMMENTARY_SECTION_TITLE,
  stampFirstTestNote,
} from "../../jb/agentJbOverviewMarkdown.js";
```

Replace with:

```typescript
import {
  buildEngineeringContextFromPayload,
  DETERMINISTIC_DATA_SECTION_TITLE,
  DETERMINISTIC_COMMENTARY_SECTION_TITLE,
  stampFirstTestNote,
} from "../../jb/agentJbOverviewMarkdown.js";
```

- [ ] **Step 2: Replace the first call site (`emitFocusDutBinsReply`)**

Find:

```typescript
  emitTextInChunks(tablesBlock, emit);
  emit({ type: "status", message: "正在生成数据解读…" });
  emit({ type: "text", delta: `\n\n${DETERMINISTIC_COMMENTARY_SECTION_TITLE}\n\n` });

  const commFilter = createDeepSeekFilter(emit);
  let streamError: string | undefined;
  await streamSiliconFlow(
    {
      model: agentConfig.subAgentModel,
      messages: [
        { role: "system", content: BRIEF_COMMENTARY_SYSTEM },
        {
          role: "user",
          content: buildBriefCommentaryUserMessage(userQuestion, tableMd, {
            engineeringContext: opts.commentaryPayload
              ? buildEngineeringContextFromPayload(opts.commentaryPayload)
              : undefined,
          }),
        },
      ],
      max_tokens: 1024,
    },
    agentConfig,
    (chunk) => {
      if (chunk.type === "delta") commFilter.push(chunk.text);
      if (chunk.type === "error") streamError = chunk.message;
    }
  );
  commFilter.finalize();
  const commentary = commFilter.cleanText.trim();
  let commentaryOrFallback: string;
  if (commentary) {
    commentaryOrFallback = commentary;
  } else {
    commentaryOrFallback = streamError
      ? `*（解读生成失败：${cleanStreamErrorMessage(streamError)}；以上实测数据表为准。）*`
      : `*（模型未返回解读；以上实测数据表为准。）*`;
    emit({ type: "text", delta: commentaryOrFallback });
  }

  const full =
    tablesBlock +
    `\n\n${DETERMINISTIC_COMMENTARY_SECTION_TITLE}\n\n` +
    commentaryOrFallback;
  appendMessages(sessionId, { role: "assistant", content: full });
  emit({ type: "done" });
  return true;
}

/**
 * 「第N片 pass1 DUT12 哪个坏 bin 最多 / 都测出了什么坏 bin」：
```

Replace with:

```typescript
  emitTextInChunks(tablesBlock, emit);

  const commentaryOrFallback = await emitBriefCommentaryOrFallback(
    userQuestion,
    tableMd,
    {
      engineeringContext: opts.commentaryPayload
        ? buildEngineeringContextFromPayload(opts.commentaryPayload)
        : undefined,
    },
    agentConfig,
    emit
  );

  const full =
    tablesBlock +
    `\n\n${DETERMINISTIC_COMMENTARY_SECTION_TITLE}\n\n` +
    commentaryOrFallback;
  appendMessages(sessionId, { role: "assistant", content: full });
  emit({ type: "done" });
  return true;
}

/**
 * 「第N片 pass1 DUT12 哪个坏 bin 最多 / 都测出了什么坏 bin」：
```

- [ ] **Step 3: Replace the second call site (`tryRunDutBinAggDirectRoute`)**

Find:

```typescript
  emit({ type: "status", message: "正在生成数据解读…" });
  emit({ type: "text", delta: `\n\n${DETERMINISTIC_COMMENTARY_SECTION_TITLE}\n\n` });

  const commFilter = createDeepSeekFilter(emit);
  let streamError: string | undefined;
  await streamSiliconFlow(
    {
      model: agentConfig.subAgentModel,
      messages: [
        { role: "system", content: BRIEF_COMMENTARY_SYSTEM },
        {
          role: "user",
          content: buildBriefCommentaryUserMessage(userQuestion, tableMd, {
            engineeringContext: buildEngineeringContextFromPayload(payload),
          }),
        },
      ],
      max_tokens: 1024,
    },
    agentConfig,
    (chunk) => {
      if (chunk.type === "delta") commFilter.push(chunk.text);
      if (chunk.type === "error") streamError = chunk.message;
    }
  );
  commFilter.finalize();
  const commentary = commFilter.cleanText.trim();

  let commentaryOrFallback: string;
  if (commentary) {
    commentaryOrFallback = commentary;
  } else {
    commentaryOrFallback = streamError
      ? `*（解读生成失败：${cleanStreamErrorMessage(streamError)}；以上实测数据表为准。）*`
      : `*（模型未返回解读；以上实测数据表为准。）*`;
    emit({ type: "text", delta: commentaryOrFallback });
  }

  const full =
    tablesBlock +
    `\n\n${DETERMINISTIC_COMMENTARY_SECTION_TITLE}\n\n` +
    commentaryOrFallback;
  appendMessages(sessionId, { role: "assistant", content: full });
  emit({ type: "done" });
  return true;
}
```

Replace with:

```typescript
  const commentaryOrFallback = await emitBriefCommentaryOrFallback(
    userQuestion,
    tableMd,
    { engineeringContext: buildEngineeringContextFromPayload(payload) },
    agentConfig,
    emit
  );

  const full =
    tablesBlock +
    `\n\n${DETERMINISTIC_COMMENTARY_SECTION_TITLE}\n\n` +
    commentaryOrFallback;
  appendMessages(sessionId, { role: "assistant", content: full });
  emit({ type: "done" });
  return true;
}
```

**Note for whoever applies this:** both call sites in this file have near-identical surrounding text (`emit({ type: "status", message: "正在生成数据解读…" });` etc. appears twice). Use enough surrounding context (the preceding `tryEmitDutBinBarChart(...)` line for the second site, and the preceding `emitTextInChunks(tablesBlock, emit);` immediately followed by the JSDoc comment for the first site, both shown above) so the edit tool matches the correct occurrence — do not use `replace_all`.

- [ ] **Step 4: Typecheck**

Run: `cd pcr-ai-api && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Run the full test suite**

Run: `cd pcr-ai-api && npm test`
Expected: same pass/fail counts as before this task (721 pass / 2 known pre-existing failures / 4 skipped).

- [ ] **Step 6: Build**

Run: `cd pcr-ai-api && npm run build`
Expected: succeeds; `verify-dist-no-undici` passes.

- [ ] **Step 7: Commit**

```bash
cd pcr-ai-api
git add src/lib/agent/dispatch/directRoutes/agentDutAggDirectRoutes.ts
git commit -m "refactor(agent): route DUT-focus-bins commentary through emitBriefCommentaryOrFallback"
```

---

## Task 4: Document the extended Vero coverage

**Files:**
- Modify: `pcr-ai-api/CLAUDE.md` (§11 Agent loop section, or nearest existing note about the Vero migration)
- Modify: root `CLAUDE.md` (the sub-project A index line added on 2026-07-22)

- [ ] **Step 1: Update root `CLAUDE.md`**

Find the line (added 2026-07-22, starts with `> **Vero 驱动通用 Agent 循环内核`):

```
> **Vero 驱动通用 Agent 循环内核（2026-07-21 设计/实现 · 2026-07-22 真连验证+合入，子项目 A）：** ...与上一条"WChat 最优方案"（未内置可插拔 backend 抽象，按现有代码风格保留双循环并存）为互补关系，非重复。
```

Append a new line directly after it:

```
> **子项目 A 延伸（2026-07-22 · JB/DUT 确定性表解读迁 Vero）：** `emitBriefCommentaryOrFallback`（`pcr-ai-api/src/lib/agent/render/agentBriefCommentary.ts`）—`isVeroGenericLoopReady()` 为真时 JB 表解读（8 处调用 `emitDeterministicJbTablesReply`）与 DUT×BIN 聚焦解读（2 处）都改走 Vero，同一 `AGENT_VERO_GENERIC_LOOP` 开关，不新增 flag；未就绪时行为与之前逐字节一致。探针卡组合（Path B）仍用独立的 `AGENT_PROBE_CARD_VERO_PILOT` 开关，不受影响。
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude-md): note JB/DUT commentary now also routes through Vero when ready"
```

---

## Self-Review Notes (already applied above)

- **Spec coverage:** Task 1 builds the shared helper with full Vero-success / Vero-error / Vero-empty / Vero-not-ready coverage. Tasks 2–3 wire all 10 known `BRIEF_COMMENTARY_SYSTEM` call sites (8 via the single `emitDeterministicJbTablesReply` renderer + 2 in `agentDutAggDirectRoutes.ts`). Probe-card commentary (Path B) is explicitly out of scope — already migrated, uses its own flag.
- **Type consistency:** `emitBriefCommentaryOrFallback`'s signature is identical across Task 1's definition and Tasks 2–3's call sites (`userQuestion, tablesMarkdown, context, agentConfig, emit, options?`).
- **No placeholders:** every step above contains complete, compilable code — no "add error handling" or "similar to Task N" shortcuts.
