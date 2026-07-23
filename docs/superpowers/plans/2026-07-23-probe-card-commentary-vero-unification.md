# Probe-Card Commentary → Shared Vero-or-SiliconFlow Helper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Status:** Not started. Written up as a task ticket per user direction on 2026-07-22 ("探针卡回归开发充充规划单" — scope is fairly large, not urgent, write it up, don't start work). Not part of, and not blocking, the `2026-07-22-vero-loop-followups.md` plan it was queued alongside.

**Goal:** Route probe-card/tester-performance commentary (the "### 数据解读 / ### 专业建议" prose after the four deterministic tables) through the same `emitBriefCommentaryOrFallback` helper that JB table replies and DUT×BIN focus replies already use — so probe-card commentary picks up Vero automatically whenever `AGENT_VERO_GENERIC_LOOP` is ready, instead of only doing so under the separate, independently-gated `AGENT_PROBE_CARD_VERO_PILOT` Path B pilot.

**Architecture:** `emitDeterministicProbeCardPerfReply` (`agentProbeCardPerfReply.ts`) currently has three commentary branches: an injected `streamCommentary`, an injected `invokeCommentary` (used only by the Path B pilot, `agentProbeCardVeroPilot.ts`), and a default branch that unconditionally calls SiliconFlow — this default branch is what both `tryRunProbeCardPerfDirectRoute`'s regex fallback and `tryRunDeterministicProbeCardPerfSummary` (the summary-round re-render) hit, and it never checks `AGENT_VERO_GENERIC_LOOP` at all. Task 1 generalizes `emitBriefCommentaryOrFallback` with two new optional fields (a system-prompt override and an additional Vero-readiness predicate) — additive, so its 10 existing JB/DUT call sites need zero changes. Task 2 replaces the default branch's inline SiliconFlow call with a call to the generalized helper. Task 3 then also replaces the Path B pilot's hand-rolled `invokeCommentary` (which duplicates the same Vero-call shape `emitBriefCommentaryOrFallback` now covers) with the generalized helper, deleting the duplication once and for all.

**Tech Stack:** TypeScript, Node.js `node:test`. No new dependencies.

## Global Constraints

- **dummy-parity does not apply**: this only changes which LLM backend writes free-text commentary after the deterministic tables are already built server-side from Oracle/Dummy tool data; no SQL, WHERE-clause, or aggregation logic changes anywhere in this plan.
- **no-undici**: no new HTTP client. Reuses the existing `streamSiliconFlow` / `invokeVeroSimpleAgent` plumbing.
- **oracledb@5.5**: untouched.
- **Never write `WCHAT_ACCESS_TOKEN` into source, tests, or docs.**
- **Backward compatible by construction**: every change in Task 1 is an additional optional field, never a signature change to an existing required parameter. The 10 existing `emitBriefCommentaryOrFallback` call sites (8 in `agentJbTablesReply.ts`'s JB-table replies, 2 in `agentDutAggDirectRoutes.ts`'s DUT×BIN focus replies) must compile and behave identically without modification.
- **Two independently-toggleable flags stay independent, but compose for this one call site.** `AGENT_VERO_GENERIC_LOOP` (`isVeroGenericLoopReady()`) and `AGENT_PROBE_CARD_VERO_PILOT` (`isProbeCardVeroPilotReady()`) are and remain separate flags governing separate things (the former: the whole ReAct loop's tool-selection model; the latter: Path B's parameter-extraction step). This plan does **not** merge or deprecate either flag — it only makes probe-card *commentary specifically* available via Vero when **either** flag is ready, matching the fact both already share one `WCHAT_ACCESS_TOKEN`. A deployment running only `AGENT_PROBE_CARD_VERO_PILOT=true` (Path B shipped first, standalone) must see no change in behavior after this plan — its commentary already goes through Vero today via the hand-rolled path Task 3 removes, and must keep doing so via the generalized path.
- **Test-seam threading**: `test/veroProbeCardPilot.test.ts`'s `"tryRunProbeCardVeroPilot extract→tool→tables→commentary with mocks"` test injects a single `deps.invokeVero` mock used for *both* the parameter-extraction call and the commentary call (dispatched inside the mock by inspecting `systemPrompt`). Task 3 must keep this working by threading the pilot's already-resolved `invoke` function through to the commentary step — not by having the commentary step construct its own default `invokeVeroSimpleAgent` call that bypasses the injected mock.

---

## Task 1: Generalize `emitBriefCommentaryOrFallback` with a system-prompt override and an additional readiness predicate

**Files:**
- Modify: `pcr-ai-api/src/lib/agent/render/agentBriefCommentary.ts`
- Test: `pcr-ai-api/test/agentBriefCommentary.test.ts`

**Interfaces:**
- Produces: `EmitBriefCommentaryOptions` gains two new optional fields: `systemPrompt?: string` (defaults to `BRIEF_COMMENTARY_SYSTEM`, used for **both** the Vero and the SiliconFlow branch) and `alsoReadyWhen?: () => boolean` (when it returns `true`, the Vero branch runs even if `isVeroGenericLoopReady()` is `false`).
- Consumes: nothing new — reuses `BRIEF_COMMENTARY_SYSTEM`, `buildVeroChatMessageWithSystem`, `isVeroGenericLoopReady`, `streamSiliconFlow`, all already imported in this file.

Currently (`agentBriefCommentary.ts:50-130`), `emitBriefCommentaryOrFallback` hardcodes `BRIEF_COMMENTARY_SYSTEM` in both its Vero branch (line 71) and its SiliconFlow branch (line 99), and its Vero/SiliconFlow branch choice is a single unconditional `if (isVeroGenericLoopReady())` (line 67).

- [ ] **Step 1: Write the failing tests**

Add to `pcr-ai-api/test/agentBriefCommentary.test.ts` (append after the existing four tests):

```typescript
test("emitBriefCommentaryOrFallback: systemPrompt override is used in the Vero branch instead of BRIEF_COMMENTARY_SYSTEM", async () => {
  await withVeroFlag(true, "tok", async () => {
    let sawCustomSystemInMessage = false;
    await emitBriefCommentaryOrFallback(
      "问题",
      "| a | b |",
      {},
      baseConfig,
      () => {},
      {
        systemPrompt: "CUSTOM_PROBE_CARD_SYSTEM_MARKER",
        invoke: async (message) => {
          sawCustomSystemInMessage = message.includes("CUSTOM_PROBE_CARD_SYSTEM_MARKER");
          return "解读文本。";
        },
      }
    );
    assert.ok(sawCustomSystemInMessage, "systemPrompt override must reach the Vero invoke call");
  });
});

test("emitBriefCommentaryOrFallback: alsoReadyWhen()=true routes to Vero even when AGENT_VERO_GENERIC_LOOP is off", async () => {
  await withVeroFlag(false, "tok", async () => {
    let invokeCalled = false;
    const result = await emitBriefCommentaryOrFallback(
      "问题",
      "| a | b |",
      {},
      baseConfig,
      () => {},
      {
        alsoReadyWhen: () => true,
        invoke: async () => {
          invokeCalled = true;
          return "解读文本。";
        },
      }
    );
    assert.equal(invokeCalled, true, "alsoReadyWhen()=true must force the Vero branch");
    assert.equal(result, "解读文本。");
  });
});

test("emitBriefCommentaryOrFallback: alsoReadyWhen()=false and AGENT_VERO_GENERIC_LOOP off -> still falls back to SiliconFlow", async () => {
  await withVeroFlag(false, undefined, async () => {
    let invokeCalled = false;
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
      () => {},
      {
        alsoReadyWhen: () => false,
        invoke: async () => {
          invokeCalled = true;
          return "should not be called";
        },
      }
    );
    assert.equal(invokeCalled, false);
    assert.ok(result.length > 0);
  });
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `cd pcr-ai-api && npx tsx --test test/agentBriefCommentary.test.ts`
Expected: the 3 new tests FAIL (`systemPrompt` and `alsoReadyWhen` do not exist on `EmitBriefCommentaryOptions` yet — TypeScript compile error surfaces as a test run failure under `tsx`).

- [ ] **Step 3: Add the two new fields and wire them in**

Find (`agentBriefCommentary.ts:35-40`):

```typescript
export type EmitBriefCommentaryOptions = {
  /** SSE status line while generating (default: "正在生成数据解读…"). */
  statusMessage?: string;
  /** Test seam: override the Vero invoke function (default: invokeVeroSimpleAgent). */
  invoke?: VeroInvokeFn;
};
```

Replace with:

```typescript
export type EmitBriefCommentaryOptions = {
  /** SSE status line while generating (default: "正在生成数据解读…"). */
  statusMessage?: string;
  /** Test seam: override the Vero invoke function (default: invokeVeroSimpleAgent). */
  invoke?: VeroInvokeFn;
  /**
   * System prompt for both the Vero and the SiliconFlow branch (default:
   * BRIEF_COMMENTARY_SYSTEM). Callers with a domain-specific commentary
   * system prompt (e.g. probe-card's PROBE_CARD_PERF_COMMENTARY_SYSTEM) pass
   * it here instead of duplicating this function's branch logic.
   */
  systemPrompt?: string;
  /**
   * Additional Vero-readiness check, OR'd with isVeroGenericLoopReady().
   * Lets a caller with its own independently-gated Vero pilot flag (e.g.
   * probe-card's AGENT_PROBE_CARD_VERO_PILOT / isProbeCardVeroPilotReady)
   * route through Vero here too, without this function knowing about that
   * flag by name.
   */
  alsoReadyWhen?: () => boolean;
};
```

Find (`agentBriefCommentary.ts:57-90`):

```typescript
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
```

Replace with:

```typescript
  const systemPrompt = options?.systemPrompt ?? BRIEF_COMMENTARY_SYSTEM;

  if (isVeroGenericLoopReady() || options?.alsoReadyWhen?.()) {
    const invoke = options?.invoke ?? invokeVeroSimpleAgent;
    try {
      const message = buildVeroChatMessageWithSystem(
        systemPrompt,
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
```

Find (`agentBriefCommentary.ts:92-108`, the SiliconFlow branch's `messages` array):

```typescript
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
```

Replace with:

```typescript
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: buildBriefCommentaryUserMessage(
            userQuestion,
            tablesMarkdown,
            context
          ),
        },
      ],
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd pcr-ai-api && npx tsx --test test/agentBriefCommentary.test.ts`
Expected: PASS — all 7 tests in this file green (4 original + 3 new).

- [ ] **Step 5: Typecheck**

Run: `cd pcr-ai-api && npx tsc --noEmit`
Expected: no errors — confirms the 10 existing JB/DUT call sites still compile unchanged.

- [ ] **Step 6: Run the full test suite**

Run: `cd pcr-ai-api && npm test`
Expected: 3 more passing tests than the pre-task baseline, no other file's results change (this is purely additive to one shared helper's options).

- [ ] **Step 7: Commit**

```bash
cd pcr-ai-api
git add src/lib/agent/render/agentBriefCommentary.ts test/agentBriefCommentary.test.ts
git commit -m "feat(agent): let emitBriefCommentaryOrFallback take a system-prompt override and an extra readiness check"
```

---

## Task 2: Route `emitDeterministicProbeCardPerfReply`'s default branch through the generalized helper

**Files:**
- Modify: `pcr-ai-api/src/lib/agent/render/agentProbeCardPerfReply.ts`
- Test: create `pcr-ai-api/test/agentProbeCardPerfReply.test.ts` (this file does not exist yet — today the only coverage of `emitDeterministicProbeCardPerfReply` is indirect, via `test/veroProbeCardPilot.test.ts`'s pilot-level tests)

**Interfaces:**
- Consumes: `emitBriefCommentaryOrFallback` from Task 1 (`systemPrompt`, `alsoReadyWhen`, `invoke` options), `isProbeCardVeroPilotReady` from `../../vero/veroSimpleAgent.js` (not yet imported in this file).
- Produces: `EmitProbeCardPerfReplyOptions` gains one new optional field: `veroInvoke?: VeroInvokeFn` — a test/pilot seam, threaded straight to `emitBriefCommentaryOrFallback`'s `invoke` option when the default (no `invokeCommentary`/`streamCommentary`) branch runs.

This task only touches the default branch (`agentProbeCardPerfReply.ts:141-182`, the final `else` in the three-way `if (options?.streamCommentary) {...} else if (options?.invokeCommentary) {...} else {...}`) — the `streamCommentary` and `invokeCommentary` branches are untouched by this task (Task 3 removes the pilot's *use* of `invokeCommentary`, not the branch itself, since another future caller could still supply one).

- [ ] **Step 1: Write the failing test**

Create `pcr-ai-api/test/agentProbeCardPerfReply.test.ts`:

```typescript
import assert from "node:assert/strict";
import test from "node:test";

import { emitDeterministicProbeCardPerfReply } from "../src/lib/agent/render/agentProbeCardPerfReply.js";
import { resolveAgentConfig } from "../src/lib/agent/agentConfig.js";
import type { AgentSseEvent } from "../src/lib/agent/core/agentLoop.js";

const baseConfig = resolveAgentConfig({
  apiKey: "sk-test",
  apiBase: "https://api.siliconflow.cn/v1",
  model: "test-model",
  subAgentModel: "test-sub-model",
});

async function withEnv<T>(
  vars: Record<string, string | undefined>,
  fn: () => Promise<T>
): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const samplePayload = {
  device: "WA03P02G",
  groups: [
    {
      passId: 1,
      comboRanking: [],
      cardRanking: [],
      comboRankingMarkdown: "| combo | yield |\n|---|---|\n| A | 99% |",
    },
  ],
};

test("emitDeterministicProbeCardPerfReply: default branch (no invokeCommentary/streamCommentary) uses Vero when AGENT_VERO_GENERIC_LOOP is ready, via veroInvoke seam", async () => {
  await withEnv(
    { AGENT_VERO_GENERIC_LOOP: "true", WCHAT_ACCESS_TOKEN: "tok", AGENT_PROBE_CARD_VERO_PILOT: undefined },
    async () => {
      const events: AgentSseEvent[] = [];
      let veroInvokeCalled = false;
      const ok = await emitDeterministicProbeCardPerfReply(
        `probe-card-perf-reply-${Date.now()}`,
        "WA03P02G 最好的探针卡+机台组合",
        samplePayload,
        baseConfig,
        (e) => events.push(e),
        {
          veroInvoke: async () => {
            veroInvokeCalled = true;
            return "探针卡组合表现稳定。";
          },
        }
      );
      assert.equal(ok, true);
      assert.equal(veroInvokeCalled, true, "default branch must route through Vero via the veroInvoke seam when the generic loop is ready");
      const text = events
        .filter((e): e is Extract<AgentSseEvent, { type: "text" }> => e.type === "text")
        .map((e) => e.delta)
        .join("");
      assert.ok(text.includes("探针卡组合表现稳定"));
    }
  );
});

test("emitDeterministicProbeCardPerfReply: default branch uses Vero when only AGENT_PROBE_CARD_VERO_PILOT is ready (AGENT_VERO_GENERIC_LOOP off)", async () => {
  await withEnv(
    { AGENT_VERO_GENERIC_LOOP: "false", AGENT_PROBE_CARD_VERO_PILOT: "true", WCHAT_ACCESS_TOKEN: "tok" },
    async () => {
      const events: AgentSseEvent[] = [];
      let veroInvokeCalled = false;
      const ok = await emitDeterministicProbeCardPerfReply(
        `probe-card-perf-reply-${Date.now()}`,
        "WA03P02G 最好的探针卡+机台组合",
        samplePayload,
        baseConfig,
        (e) => events.push(e),
        {
          veroInvoke: async () => {
            veroInvokeCalled = true;
            return "探针卡组合表现稳定。";
          },
        }
      );
      assert.equal(ok, true);
      assert.equal(
        veroInvokeCalled,
        true,
        "AGENT_PROBE_CARD_VERO_PILOT=true alone must be enough to route commentary through Vero, even with AGENT_VERO_GENERIC_LOOP off — no regression for Path-B-only deployments"
      );
    }
  );
});

test("emitDeterministicProbeCardPerfReply: neither flag ready -> falls back to SiliconFlow, never calls veroInvoke", async () => {
  await withEnv(
    { AGENT_VERO_GENERIC_LOOP: "false", AGENT_PROBE_CARD_VERO_PILOT: undefined, WCHAT_ACCESS_TOKEN: undefined },
    async () => {
      const events: AgentSseEvent[] = [];
      let veroInvokeCalled = false;
      const config = resolveAgentConfig({
        apiKey: "sk-test",
        apiBase: "https://127.0.0.1:1",
        model: "test-model",
        subAgentModel: "test-sub-model",
        streamTimeoutMs: 200,
      });
      const ok = await emitDeterministicProbeCardPerfReply(
        `probe-card-perf-reply-${Date.now()}`,
        "WA03P02G 最好的探针卡+机台组合",
        samplePayload,
        config,
        (e) => events.push(e),
        {
          veroInvoke: async () => {
            veroInvokeCalled = true;
            return "should not be called";
          },
        }
      );
      assert.equal(ok, true);
      assert.equal(veroInvokeCalled, false);
    }
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd pcr-ai-api && npx tsx --test test/agentProbeCardPerfReply.test.ts`
Expected: FAIL — `veroInvoke` does not exist on `EmitProbeCardPerfReplyOptions` yet, and the default branch does not check either Vero flag yet (first test's `veroInvokeCalled` stays `false`).

- [ ] **Step 3: Wire the generalized helper into the default branch**

Find (`agentProbeCardPerfReply.ts:1-21`, the imports):

```typescript
import type { AgentConfig } from "../agentConfig.js";
import type { AgentSseEvent } from "../core/agentLoop.js";
import { appendMessages } from "../agentHistory.js";
import {
  emitTextInChunks,
  cleanStreamErrorMessage,
} from "../core/agentLoopShared.js";
import { createDeepSeekFilter } from "../core/agentEmbeddedToolParsing.js";
import { streamSiliconFlow } from "../core/agentStream.js";
import {
  buildProbeCardPerfSummaryMarkdown,
  type PassGroupResult,
} from "../../probeCard/probeCardTesterPerformance.js";
import {
  PROBE_CARD_PERF_COMMENTARY_SYSTEM,
  buildBriefCommentaryUserMessage,
  DETERMINISTIC_DATA_SECTION_TITLE,
  DETERMINISTIC_COMMENTARY_SECTION_TITLE,
} from "../jb/agentJbOverviewMarkdown.js";
```

Replace with:

```typescript
import type { AgentConfig } from "../agentConfig.js";
import type { AgentSseEvent } from "../core/agentLoop.js";
import { appendMessages } from "../agentHistory.js";
import {
  emitTextInChunks,
  cleanStreamErrorMessage,
} from "../core/agentLoopShared.js";
import {
  buildProbeCardPerfSummaryMarkdown,
  type PassGroupResult,
} from "../../probeCard/probeCardTesterPerformance.js";
import {
  PROBE_CARD_PERF_COMMENTARY_SYSTEM,
  DETERMINISTIC_DATA_SECTION_TITLE,
  DETERMINISTIC_COMMENTARY_SECTION_TITLE,
} from "../jb/agentJbOverviewMarkdown.js";
import { isProbeCardVeroPilotReady } from "../../vero/veroSimpleAgent.js";
import {
  emitBriefCommentaryOrFallback,
  type EmitBriefCommentaryOptions,
} from "./agentBriefCommentary.js";
```

`cleanStreamErrorMessage` stays — the `streamCommentary` and `invokeCommentary` branches (untouched by this task) still use it in their own `catch` blocks. Only `createDeepSeekFilter`, `streamSiliconFlow`, and `buildBriefCommentaryUserMessage` were exclusively used by the inline default branch this task removes, so drop those three imports.

Find (`agentProbeCardPerfReply.ts:36-43`, `EmitProbeCardPerfReplyOptions`):

```typescript
export type EmitProbeCardPerfReplyOptions = {
  /** One-shot commentary (emitted in chunks after completion). */
  invokeCommentary?: ProbeCardCommentaryInvoker;
  /** Preferred for WChat: true SSE token streaming into the UI. */
  streamCommentary?: ProbeCardCommentaryStreamer;
  /** Status line while generating commentary (default: SiliconFlow wording). */
  commentaryStatusMessage?: string;
};
```

Replace with:

```typescript
export type EmitProbeCardPerfReplyOptions = {
  /** One-shot commentary (emitted in chunks after completion). */
  invokeCommentary?: ProbeCardCommentaryInvoker;
  /** Preferred for WChat: true SSE token streaming into the UI. */
  streamCommentary?: ProbeCardCommentaryStreamer;
  /** Status line while generating commentary (default: SiliconFlow wording). */
  commentaryStatusMessage?: string;
  /**
   * Test/pilot seam for the default branch's Vero call (passed straight to
   * emitBriefCommentaryOrFallback's `invoke` option). Only used when neither
   * invokeCommentary nor streamCommentary is given.
   */
  veroInvoke?: EmitBriefCommentaryOptions["invoke"];
};
```

`emitBriefCommentaryOrFallback` emits its own `status` event and its own `## 分析结论` text header (`DETERMINISTIC_COMMENTARY_SECTION_TITLE`) before generating commentary. Today those two emits happen once, shared above the three-way branch (`agentProbeCardPerfReply.ts:93-104`) — after this task, only the `streamCommentary`/`invokeCommentary` branches (which don't emit their own header) may keep relying on that shared emission; the new default branch must not double-emit it. Find the entire block from the shared emits through the end of the three-way `if` (`agentProbeCardPerfReply.ts:93-182`):

```typescript
  emit({
    type: "status",
    message:
      options?.commentaryStatusMessage ?? "正在生成数据解读与专业建议…",
  });
  emit({
    type: "text",
    delta: `\n\n${DETERMINISTIC_COMMENTARY_SECTION_TITLE}\n\n`,
  });

  let commentaryOrFallback: string;
  let streamError: string | undefined;

  if (options?.streamCommentary) {
    try {
      const text = (
        await options.streamCommentary(userQuestion, tables, (delta) => {
          if (delta) emit({ type: "text", delta });
        })
      ).trim();
      if (text) {
        commentaryOrFallback = text;
      } else {
        commentaryOrFallback =
          "*（模型未返回解读；以上实测数据表为准。）*";
        emit({ type: "text", delta: commentaryOrFallback });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      commentaryOrFallback = `*（解读生成失败：${cleanStreamErrorMessage(msg)}；以上实测数据表为准。）*`;
      emit({ type: "text", delta: commentaryOrFallback });
    }
  } else if (options?.invokeCommentary) {
    try {
      const text = (await options.invokeCommentary(userQuestion, tables)).trim();
      if (text) {
        commentaryOrFallback = text;
        emitTextInChunks(text, emit);
      } else {
        commentaryOrFallback =
          "*（模型未返回解读；以上实测数据表为准。）*";
        emit({ type: "text", delta: commentaryOrFallback });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      commentaryOrFallback = `*（解读生成失败：${cleanStreamErrorMessage(msg)}；以上实测数据表为准。）*`;
      emit({ type: "text", delta: commentaryOrFallback });
    }
  } else {
    const commFilter = createDeepSeekFilter(emit);

    await streamSiliconFlow(
      {
        model: agentConfig.subAgentModel,
        messages: [
          { role: "system", content: PROBE_CARD_PERF_COMMENTARY_SYSTEM },
          {
            role: "user",
            content: buildBriefCommentaryUserMessage(userQuestion, tables),
          },
        ],
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

    if (commentary) {
      commentaryOrFallback = commentary;
    } else {
      commentaryOrFallback = streamError
        ? `*（解读生成失败：${cleanStreamErrorMessage(streamError)}；以上实测数据表为准。）*`
        : `*（模型未返回解读；以上实测数据表为准。）*`;
      emit({ type: "text", delta: commentaryOrFallback });
    }
  }
```

Replace with:

```typescript
  let commentaryOrFallback: string;

  if (options?.streamCommentary) {
    emit({
      type: "status",
      message:
        options?.commentaryStatusMessage ?? "正在生成数据解读与专业建议…",
    });
    emit({
      type: "text",
      delta: `\n\n${DETERMINISTIC_COMMENTARY_SECTION_TITLE}\n\n`,
    });
    try {
      const text = (
        await options.streamCommentary(userQuestion, tables, (delta) => {
          if (delta) emit({ type: "text", delta });
        })
      ).trim();
      if (text) {
        commentaryOrFallback = text;
      } else {
        commentaryOrFallback =
          "*（模型未返回解读；以上实测数据表为准。）*";
        emit({ type: "text", delta: commentaryOrFallback });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      commentaryOrFallback = `*（解读生成失败：${cleanStreamErrorMessage(msg)}；以上实测数据表为准。）*`;
      emit({ type: "text", delta: commentaryOrFallback });
    }
  } else if (options?.invokeCommentary) {
    emit({
      type: "status",
      message:
        options?.commentaryStatusMessage ?? "正在生成数据解读与专业建议…",
    });
    emit({
      type: "text",
      delta: `\n\n${DETERMINISTIC_COMMENTARY_SECTION_TITLE}\n\n`,
    });
    try {
      const text = (await options.invokeCommentary(userQuestion, tables)).trim();
      if (text) {
        commentaryOrFallback = text;
        emitTextInChunks(text, emit);
      } else {
        commentaryOrFallback =
          "*（模型未返回解读；以上实测数据表为准。）*";
        emit({ type: "text", delta: commentaryOrFallback });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      commentaryOrFallback = `*（解读生成失败：${cleanStreamErrorMessage(msg)}；以上实测数据表为准。）*`;
      emit({ type: "text", delta: commentaryOrFallback });
    }
  } else {
    // emitBriefCommentaryOrFallback emits its own status + section-header
    // events, so the default branch does not emit them itself.
    commentaryOrFallback = await emitBriefCommentaryOrFallback(
      userQuestion,
      tables,
      {},
      agentConfig,
      emit,
      {
        statusMessage: options?.commentaryStatusMessage,
        systemPrompt: PROBE_CARD_PERF_COMMENTARY_SYSTEM,
        alsoReadyWhen: isProbeCardVeroPilotReady,
        invoke: options?.veroInvoke,
      }
    );
  }
```

This also removes the now-dead `streamError` variable (only the deleted default branch ever assigned to it) and passes `options?.commentaryStatusMessage` through to `emitBriefCommentaryOrFallback`'s own `statusMessage` field so the default branch's status line stays configurable exactly as it was before this task.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd pcr-ai-api && npx tsx --test test/agentProbeCardPerfReply.test.ts`
Expected: PASS — all 3 new tests green.

- [ ] **Step 5: Typecheck**

Run: `cd pcr-ai-api && npx tsc --noEmit`
Expected: no errors — confirms no other file constructs `EmitProbeCardPerfReplyOptions` in a way that breaks, and that removing the now-unused imports (`cleanStreamErrorMessage`, `createDeepSeekFilter`, `streamSiliconFlow`, `buildBriefCommentaryUserMessage`) doesn't leave any other reference in this file dangling.

- [ ] **Step 6: Run the full test suite**

Run: `cd pcr-ai-api && npm test`
Expected: 3 more passing tests than Task 1's post-task count. `test/veroProbeCardPilot.test.ts` must still show identical pass/fail counts to before this task — this task does not touch `agentProbeCardVeroPilot.ts` (that's Task 3), so the pilot's own `invokeCommentary` option still short-circuits before reaching the branch this task changed.

- [ ] **Step 7: Commit**

```bash
cd pcr-ai-api
git add src/lib/agent/render/agentProbeCardPerfReply.ts test/agentProbeCardPerfReply.test.ts
git commit -m "feat(agent): probe-card commentary default branch routes through Vero when either Vero flag is ready"
```

---

## Task 3: Remove the Path B pilot's now-duplicated hand-rolled commentary call

**Files:**
- Modify: `pcr-ai-api/src/lib/agent/dispatch/directRoutes/agentProbeCardVeroPilot.ts`

**Interfaces:**
- Consumes: `EmitProbeCardPerfReplyOptions.veroInvoke` from Task 2.

This task only changes `tryRunProbeCardVeroPilot`'s single call to `emitDeterministicProbeCardPerfReply` (`agentProbeCardVeroPilot.ts:271-290`). No new test file — the existing `test/veroProbeCardPilot.test.ts` (in particular `"tryRunProbeCardVeroPilot extract→tool→tables→commentary with mocks"`, which injects `deps.invokeVero` and expects it to be called for *both* extraction and commentary) is the regression check; it must keep passing unmodified.

- [ ] **Step 1: Confirm the existing pilot test currently passes (pre-change baseline)**

Run: `cd pcr-ai-api && npx tsx --test test/veroProbeCardPilot.test.ts`
Expected: PASS — all existing tests green, including `commentaryCalls === 1` in the extract→tool→tables→commentary test. Record this as the baseline the next step must not break.

- [ ] **Step 2: Replace the hand-rolled `invokeCommentary` with the `veroInvoke` seam**

Find (`agentProbeCardVeroPilot.ts:271-290`):

```typescript
  // Tables from server; commentary via simple-agent (no MCP / no double agent turn).
  return emitDeterministicProbeCardPerfReply(
    sessionId,
    userQuestion,
    payload,
    agentConfig,
    emit,
    {
      commentaryStatusMessage:
        "Vero 试点：正在生成数据解读与专业建议…",
      invokeCommentary: async (q, tables) => {
        const message = buildVeroChatMessageWithSystem(
          PROBE_CARD_PERF_COMMENTARY_SYSTEM,
          buildBriefCommentaryUserMessage(q, tables)
        );
        // system_prompt empty: instructions already folded into message.
        return invoke(message, "You write brief Chinese engineering commentary only. No tools. No tables.");
      },
    }
  );
```

Replace with:

```typescript
  // Tables from server; commentary via the shared Vero-or-SiliconFlow helper
  // (agentBriefCommentary.ts), using this pilot's already-resolved `invoke`
  // (real invokeVeroSimpleAgent, or the test-injected deps.invokeVero) as the
  // veroInvoke seam — same message shape this pilot used to build inline,
  // now deduplicated with the JB/DUT/probe-card-default commentary path.
  return emitDeterministicProbeCardPerfReply(
    sessionId,
    userQuestion,
    payload,
    agentConfig,
    emit,
    {
      commentaryStatusMessage:
        "Vero 试点：正在生成数据解读与专业建议…",
      veroInvoke: invoke,
    }
  );
```

Since `buildVeroChatMessageWithSystem` and `PROBE_CARD_PERF_COMMENTARY_SYSTEM` are no longer used directly in this file after this change (the generalized helper builds the message itself using the `systemPrompt` it was given inside `agentProbeCardPerfReply.ts`), remove their imports. Find (`agentProbeCardVeroPilot.ts:22-31`):

```typescript
import {
  invokeVeroSimpleAgent,
  parseJsonLoose,
  isProbeCardVeroPilotReady,
  buildVeroChatMessageWithSystem,
} from "../../../vero/veroSimpleAgent.js";
import {
  PROBE_CARD_PERF_COMMENTARY_SYSTEM,
  buildBriefCommentaryUserMessage,
} from "../../jb/agentJbOverviewMarkdown.js";
```

Replace with:

```typescript
import {
  invokeVeroSimpleAgent,
  parseJsonLoose,
  isProbeCardVeroPilotReady,
} from "../../../vero/veroSimpleAgent.js";
```

Check with `grep -n "buildVeroChatMessageWithSystem\|PROBE_CARD_PERF_COMMENTARY_SYSTEM\|buildBriefCommentaryUserMessage" pcr-ai-api/src/lib/agent/dispatch/directRoutes/agentProbeCardVeroPilot.ts` after this edit — expect no matches (confirms nothing else in this file still needs them).

- [ ] **Step 3: Run the pilot test to confirm no regression**

Run: `cd pcr-ai-api && npx tsx --test test/veroProbeCardPilot.test.ts`
Expected: PASS — identical to Step 1's baseline, including `commentaryCalls === 1` (now driven by `emitBriefCommentaryOrFallback`'s Vero branch calling the same injected `invoke` mock via the `veroInvoke` seam, instead of the pilot's own removed inline call).

- [ ] **Step 4: Typecheck**

Run: `cd pcr-ai-api && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Run the full test suite**

Run: `cd pcr-ai-api && npm test`
Expected: same total test count as after Task 2 (this task removes code, adds no new tests, and must not change any test's pass/fail outcome — `test/veroProbeCardPilot.test.ts` in particular must show identical results to its pre-task baseline from Step 1).

- [ ] **Step 6: Commit**

```bash
cd pcr-ai-api
git add src/lib/agent/dispatch/directRoutes/agentProbeCardVeroPilot.ts
git commit -m "refactor(agent): probe-card Vero pilot reuses the shared commentary helper instead of its own hand-rolled Vero call"
```

---

## Self-Review Notes (already applied above)

- **Spec coverage:** Task 1 generalizes the shared helper without touching its 10 existing call sites' behavior. Task 2 gets the two SiliconFlow-only call sites (`tryRunProbeCardPerfDirectRoute`'s regex fallback, `tryRunDeterministicProbeCardPerfSummary`) onto Vero-when-ready, honoring both flags per the Global Constraints' composition rule. Task 3 removes the resulting duplication in the Path B pilot, the original trigger for this ticket.
- **No regression for either flag combination:** Task 2's three new tests directly assert the three flag combinations named in the Global Constraints (`AGENT_VERO_GENERIC_LOOP` only, `AGENT_PROBE_CARD_VERO_PILOT` only, neither) each produce the correct branch.
- **Test-seam continuity:** Task 3's plan explicitly names the one existing test (`veroProbeCardPilot.test.ts`'s extract→tool→tables→commentary test) that would silently break if the `veroInvoke` seam were wired incorrectly, and makes verifying it pass unchanged an explicit step (Step 3), not an assumption.
- **No placeholders:** every step contains complete, compilable code taken from the actual current file contents (read directly from the repository while writing this plan, not reconstructed from memory).
