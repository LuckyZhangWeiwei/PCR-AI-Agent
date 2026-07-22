# Vero Generic Loop Follow-Ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close three non-blocking follow-ups from the Vero generic loop's code review and Cursor's real-network test: (1) deduplicate the `PRE_LLM_DIRECT_ROUTES` array that's currently maintained identically in two files, (2) make the "last round must return final" constraint actually enforced instead of merely hinted, and (3) fix the smoke script's default question so it exercises the generic multi-round loop instead of being silently answered by the Path B probe-card pilot.

**Architecture:** Task 1 extracts the existing declarative direct-route table into one shared module both loops import. Task 2 adds a single forced-retry call (stronger system prompt, one extra Vero round) when the model ignores the last-round instruction, falling back to the existing deterministic summary if the retry also fails — no new mechanism beyond "try once more, then give up gracefully," consistent with the loop's existing philosophy of never fabricating a conclusion. Task 3 only touches a real-network smoke script (not part of `npm test`).

**Tech Stack:** TypeScript, Node.js `node:test`.

## Global Constraints

- **dummy-parity does not apply**: no SQL/aggregation/WHERE-clause changes anywhere in this plan.
- **no-undici**: no new HTTP client; Task 2 reuses the existing `invoke`/`invokeVeroRoundWithRetry` plumbing.
- **oracledb@5.5**: untouched.
- **Never write `WCHAT_ACCESS_TOKEN` into source, tests, or docs.**
- Task 1 must not change `PRE_LLM_DIRECT_ROUTES`'s runtime behavior in either loop — same functions, same order, same self-gating semantics. This is a pure extraction.
- Task 2 must not execute a tool on the last round when the model's decision is still `action:"tool"` after both the initial attempt and the forced retry — the whole point is to stop wasting a tool execution on a round that's about to be discarded (see design doc §3.3's existing philosophy: "有数据就整理成文字，不生造内容").

---

## Task 1: Extract the shared `PRE_LLM_DIRECT_ROUTES` table

**Files:**
- Create: `pcr-ai-api/src/lib/agent/core/agentPreLlmDirectRoutes.ts`
- Modify: `pcr-ai-api/src/lib/agent/core/veroAgentLoop.ts`
- Modify: `pcr-ai-api/src/lib/agent/core/agentLoop.ts`

**Interfaces:**
- Produces: `PRE_LLM_DIRECT_ROUTES: Array<typeof tryRunLotListingDirectRoute>` — a module-level constant, same 15-entry array, same order, that was previously duplicated verbatim in both `agentLoop.ts` and `veroAgentLoop.ts`.

`agentLoop.ts` imports many of these 15 route functions for uses *beyond* this array too (three of them — `tryRunLotListingDirectRoute`, `tryRunScopedBadBinDirectRoute`, `tryRunLotOverviewDirectRoute` — are also called directly inside `agentLoop.ts`'s `awaitingSummary`-gated mid-loop recovery branches). Leave every existing named import in `agentLoop.ts` exactly as-is — do not remove or prune any of them, even the ones that become technically unused by this array's removal (this project's `tsconfig.json` does not set `noUnusedLocals`, so this causes no compile error, and pruning them file-by-file across four multi-name import blocks is unnecessary risk for a task whose only goal is preventing the *array itself* from drifting out of sync between the two loops).

- [ ] **Step 1: Create the shared route-table module**

Create `pcr-ai-api/src/lib/agent/core/agentPreLlmDirectRoutes.ts`:

```typescript
// pcr-ai-api/src/lib/agent/core/agentPreLlmDirectRoutes.ts
// Shared declarative direct-route dispatch table used by both the
// SiliconFlow loop (agentLoop.ts) and the Vero-driven loop
// (veroAgentLoop.ts). Runners self-gate; order is priority — see the
// comment at each usage site for the gating rule (PRE_LLM_DIRECT_ROUTES
// only runs before any tool has executed this turn).
//
// Previously duplicated verbatim in both files, which risked the two
// loops' "what gets handled deterministically" sets silently diverging if
// a new direct route was added to one array and not the other (flagged in
// code review of the Vero generic loop). Add new pre-LLM direct routes
// here once; both loops pick it up automatically.
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

export const PRE_LLM_DIRECT_ROUTES: Array<typeof tryRunLotListingDirectRoute> = [
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
```

- [ ] **Step 2: Update `veroAgentLoop.ts` to import the shared table**

Find (the entire "PRE_LLM direct routes" import block plus the local array definition):

```typescript
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
```

Replace with:

```typescript
// PRE_LLM direct routes: same server-side, model-agnostic logic the old
// SiliconFlow loop uses. Extracted to a shared module (agentPreLlmDirectRoutes.ts)
// so this array can't drift out of sync with agentLoop.ts's copy. Deterministic
// JB/probe-card summary calls and the awaitingSummary-gated mid-loop recovery
// branches (wafer-map plan, touchdown, DUT×BIN map/yield chart) are NOT ported
// in this first version — see plan Task 6 / design doc §1.2.
import { PRE_LLM_DIRECT_ROUTES } from "./agentPreLlmDirectRoutes.js";
```

- [ ] **Step 3: Update `agentLoop.ts` to import the shared table instead of declaring its own**

Find (the local array declaration, inside `runAgentLoop`'s function body):

```typescript
  // 声明式有序直连调度表(范围 B / spec §4.2):取代原 5 条顺序 if。各 runner 内部 self-gate,
  // 顺序即优先级,与旧 if 链按构造等价(同序、同 runner、同门槛)。新增 pre-LLM 直连只需加进此数组。
  // 注:不按 detectJbReplyMode 的 mode 建表——mode 与 canRunXxx 门槛非 1:1(mode 更宽),
  // 按 mode 路由会把门槛不满足的问句误路由;有序 runner 列表才是真正等价的声明式形式。
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

  const maxRounds = agentConfig.maxRounds;
```

Replace with (the array is now imported at module scope, not re-declared locally — the usage site later in the function, `for (const runDirectRoute of PRE_LLM_DIRECT_ROUTES)`, needs no change since the name is identical):

```typescript
  // 声明式有序直连调度表(范围 B / spec §4.2):取代原 5 条顺序 if。各 runner 内部 self-gate,
  // 顺序即优先级,与旧 if 链按构造等价(同序、同 runner、同门槛)。新增 pre-LLM 直连只需加进
  // agentPreLlmDirectRoutes.ts 一处,两套循环(本文件 + veroAgentLoop.ts)自动同步。
  // 注:不按 detectJbReplyMode 的 mode 建表——mode 与 canRunXxx 门槛非 1:1(mode 更宽),
  // 按 mode 路由会把门槛不满足的问句误路由;有序 runner 列表才是真正等价的声明式形式。

  const maxRounds = agentConfig.maxRounds;
```

Then add the import. Find this line near the top of `agentLoop.ts` (right after the last of the existing direct-route import blocks, before the "Round 4 split" comment):

```typescript
import {
  tryRunProbeCardPerfDirectRoute,
  tryRunDeterministicProbeCardPerfSummary,
} from "../dispatch/directRoutes/agentProbeCardDirectRoutes.js";
// ── Round 4 split: setup / prompt / tool-call / guard / finalize helpers ──────
```

Replace with:

```typescript
import {
  tryRunProbeCardPerfDirectRoute,
  tryRunDeterministicProbeCardPerfSummary,
} from "../dispatch/directRoutes/agentProbeCardDirectRoutes.js";
import { PRE_LLM_DIRECT_ROUTES } from "./agentPreLlmDirectRoutes.js";
// ── Round 4 split: setup / prompt / tool-call / guard / finalize helpers ──────
```

- [ ] **Step 4: Typecheck**

Run: `cd pcr-ai-api && npx tsc --noEmit`
Expected: no errors. (This is the real verification that nothing in `agentLoop.ts` actually needed the removed local declaration, and that the three still-used-elsewhere functions — `tryRunLotListingDirectRoute`, `tryRunScopedBadBinDirectRoute`, `tryRunLotOverviewDirectRoute` — still resolve via their existing untouched imports.)

- [ ] **Step 5: Run the full test suite**

Run: `cd pcr-ai-api && npm test`
Expected: identical pass/fail/skip counts to before this task (731 tests / 725 pass / 2 known pre-existing failures in `jbRouteResolver.test.ts` / 4 skipped) — this is a pure refactor, no behavior change in either loop.

- [ ] **Step 6: Commit**

```bash
cd pcr-ai-api
git add src/lib/agent/core/agentPreLlmDirectRoutes.ts src/lib/agent/core/veroAgentLoop.ts src/lib/agent/core/agentLoop.ts
git commit -m "refactor(agent): extract shared PRE_LLM_DIRECT_ROUTES table"
```

---

## Task 2: Enforce (not just hint) the last-round final constraint

**Files:**
- Modify: `pcr-ai-api/src/lib/agent/core/veroAgentLoopPrompt.ts`
- Modify: `pcr-ai-api/src/lib/agent/core/veroAgentLoop.ts`
- Modify: `pcr-ai-api/test/veroAgentLoop.test.ts`

**Interfaces:**
- Produces: `buildVeroForceFinalSystemPrompt(params: { manifest: DataManifest | undefined; feedbackInjection: string }): string` in `veroAgentLoopPrompt.ts`.
- Consumes (in `veroAgentLoop.ts`): the above, plus the existing `invoke: VeroInvokeFn`, `invokeVeroRoundWithRetry`, `parseVeroRoundDecision`, `isVeroReplyDecision`, `VeroReplyDecision` type — all already present in the file from Task 1's untouched imports.

Cursor's real-network test (`docs/HANDOFF_CURSOR_VERO_GENERIC_LOOP_TEST_RESULTS.md` §3.6) found the model does not reliably obey the existing `isLastRound` hint in the system prompt — it returned `action:"tool"` on the last round in the one live test that exercised this path. Currently the loop still executes that tool anyway (wasting a full tool execution + Vero round-trip on a round that's about to be discarded), then falls to the deterministic "已完成以下查询…" summary regardless. This task adds one forced-final retry — a stronger prompt, one more Vero call — before giving up; if the model still won't comply, the tool is never executed and the loop falls straight to the existing deterministic summary (using whatever tools ran in *earlier* rounds, if any).

- [ ] **Step 1: Write the failing tests**

Add to `pcr-ai-api/test/veroAgentLoop.test.ts` (append after the existing `"runVeroAgentLoop: exhausting maxRounds after a tool ran falls back to a text summary, not a bare error"` test, before the `"runVeroAgentLoop: maxRounds=0..."` test):

```typescript
test("runVeroAgentLoop: last round returns tool, forced retry returns final -> uses the forced final reply, never executes the tool", async () => {
  const sessionId = `vero-loop-force-final-ok-${Date.now()}`;
  const events: AgentSseEvent[] = [];
  const config: AgentConfig = { ...stubConfig, maxRounds: 1 };
  let call = 0;
  await runVeroAgentLoop(
    "随便问点什么，且不匹配任何 direct route",
    sessionId,
    config,
    (e) => events.push(e),
    undefined,
    {
      invoke: async () => {
        call += 1;
        if (call === 1) {
          // Regular (non-forced) attempt on the only/last round: model
          // ignores the isLastRound hint and still wants a tool.
          return JSON.stringify({
            action: "tool",
            tool: "aggregate_probe_card_tester_performance",
            args: { device: "WA03P02G" },
          });
        }
        // Forced retry: model complies this time.
        return JSON.stringify({ action: "final", reply: "强制收尾后的结论。" });
      },
    }
  );

  assert.equal(call, 2, "must make exactly one forced-retry call after the last round's initial tool decision");
  assert.ok(!events.some((e) => e.type === "tool_start"), "the tool from the non-compliant first attempt must never execute");
  assert.ok(!events.some((e) => e.type === "error"));
  assert.ok(events.some((e) => e.type === "done"));
  const text = events
    .filter((e): e is Extract<AgentSseEvent, { type: "text" }> => e.type === "text")
    .map((e) => e.delta)
    .join("");
  assert.ok(text.includes("强制收尾后的结论"));
  clearHistory(sessionId);
});

test("runVeroAgentLoop: last round returns tool, forced retry also returns tool -> falls back to deterministic summary of earlier-round tools, still never executes the last-round tool", async () => {
  process.env["INFCONTROL_LAYER_BINS_DUMMY"] = "true";
  process.env["NODE_ENV"] = "test";
  const sessionId = `vero-loop-force-final-fail-${Date.now()}`;
  const events: AgentSseEvent[] = [];
  const config: AgentConfig = { ...stubConfig, maxRounds: 2 };
  let call = 0;
  await runVeroAgentLoop(
    "随便问点什么，且不匹配任何 direct route",
    sessionId,
    config,
    (e) => events.push(e),
    undefined,
    {
      invoke: async () => {
        call += 1;
        if (call === 1) {
          // Round 0 (not last): a real tool call that succeeds normally.
          return JSON.stringify({
            action: "tool",
            tool: "aggregate_probe_card_tester_performance",
            args: { device: "WA03P02G" },
          });
        }
        // Round 1 (last, calls 2 and 3: the regular attempt and the forced
        // retry): model never complies, keeps asking for a tool.
        return JSON.stringify({
          action: "tool",
          tool: "query_jb_bins",
          args: { lot: "SHOULD_NOT_RUN" },
        });
      },
    }
  );

  assert.equal(call, 3, "round 0's real call, round 1's regular attempt, and round 1's forced retry");
  const toolStarts = events.filter((e) => e.type === "tool_start");
  assert.equal(toolStarts.length, 1, "only round 0's tool should have executed — the last round's tool must never run, even after the failed forced retry");
  assert.equal(
    (toolStarts[0] as Extract<AgentSseEvent, { type: "tool_start" }>).name,
    "aggregate_probe_card_tester_performance"
  );
  assert.ok(!events.some((e) => e.type === "error"));
  const text = events
    .filter((e): e is Extract<AgentSseEvent, { type: "text" }> => e.type === "text")
    .map((e) => e.delta)
    .join("");
  assert.ok(text.includes("aggregate_probe_card_tester_performance"));
  assert.ok(text.includes("重试"));
  clearHistory(sessionId);
});

test("runVeroAgentLoop: last round returns tool, forced retry call itself throws -> falls back gracefully, not a hard error", async () => {
  process.env["INFCONTROL_LAYER_BINS_DUMMY"] = "true";
  process.env["NODE_ENV"] = "test";
  const sessionId = `vero-loop-force-final-throws-${Date.now()}`;
  const events: AgentSseEvent[] = [];
  const config: AgentConfig = { ...stubConfig, maxRounds: 1 };
  let call = 0;
  await runVeroAgentLoop(
    "随便问点什么，且不匹配任何 direct route",
    sessionId,
    config,
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
        throw new Error("vero unreachable on forced retry");
      },
    }
  );

  // maxRounds=1 with the only round's tool never executed (rejected pre-
  // forced-retry, forced retry itself failed) means there is genuinely
  // nothing gathered this turn — same "nothing to fall back on" case as the
  // existing maxRounds=0 test, so a plain error is correct here, not a
  // silent success.
  assert.equal(call, 2);
  assert.ok(!events.some((e) => e.type === "tool_start"));
  const errEvent = events.find((e) => e.type === "error");
  assert.ok(errEvent);
  assert.ok(String((errEvent as { message: string }).message).includes("最大轮数"));
  clearHistory(sessionId);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd pcr-ai-api && npx tsx --test test/veroAgentLoop.test.ts`
Expected: the three new tests FAIL (the current code always calls `executeVeroToolDecision` regardless of round, so `call` will be 1 in the first two new tests instead of the expected 2/3, and `tool_start` events will appear for the rejected last-round tool).

- [ ] **Step 3: Add `buildVeroForceFinalSystemPrompt` to `veroAgentLoopPrompt.ts`**

Find (the end of `buildVeroRoundSystemPrompt`, just before `serializeHistoryForVeroPrompt`):

```typescript
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
```

Replace with:

```typescript
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
 * Even more forceful variant of the last-round prompt, used for the single
 * forced-final retry when the model still returned action:"tool" on the
 * actual last round despite buildVeroRoundSystemPrompt's isLastRound hint
 * (see runVeroAgentLoop). Cursor's real-network test found the model does
 * not reliably obey that hint alone (see
 * docs/HANDOFF_CURSOR_VERO_GENERIC_LOOP_TEST_RESULTS.md §3.6) — this is the
 * one additional nudge before the loop falls back to the deterministic
 * "已完成以下查询…" summary without ever executing the rejected tool.
 */
export function buildVeroForceFinalSystemPrompt(params: {
  manifest: DataManifest | undefined;
  feedbackInjection: string;
}): string {
  const base = buildVeroRoundSystemPrompt({ ...params, isLastRound: true });
  return (
    base +
    "\n\n【强制收尾】你刚才仍然试图调用工具，但轮次已经用尽，系统不会再执行任何工具调用。" +
    "现在必须且只能返回 {\"action\":\"final\",\"reply\":\"...\"} 或 {\"action\":\"chat\",\"reply\":\"...\"}，" +
    "基于已经拿到的数据给出简短结论；再返回 action:tool 会被直接丢弃，对用户没有任何帮助。"
  );
}

/**
 * Serialize recent history + rolling summary into plain text for a single
```

- [ ] **Step 4: Wire the forced retry into `veroAgentLoop.ts`**

Find the import from `./veroAgentLoopPrompt.js`:

```typescript
import {
  buildVeroRoundSystemPrompt,
  serializeHistoryForVeroPrompt,
  isVeroPromptOverBudget,
} from "./veroAgentLoopPrompt.js";
```

Replace with:

```typescript
import {
  buildVeroRoundSystemPrompt,
  buildVeroForceFinalSystemPrompt,
  serializeHistoryForVeroPrompt,
  isVeroPromptOverBudget,
} from "./veroAgentLoopPrompt.js";
import type { DataManifest } from "../agentManifest.js";
```

Find the `invokeVeroRoundWithRetry` function definition and add the new helper immediately after it:

```typescript
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
```

Replace with:

```typescript
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

/**
 * One forced-final retry for the last round, used when the model returned
 * action:"tool" despite the last-round instruction. Returns the reply
 * decision if the model now complies, or null if it still won't (or the
 * retry call itself fails) — callers must not execute a tool in either
 * null case, since the round is about to be discarded regardless.
 */
async function tryForceLastRoundFinal(
  invoke: VeroInvokeFn,
  manifest: DataManifest | undefined,
  feedbackInjection: string,
  historyText: string
): Promise<VeroReplyDecision | null> {
  const forcedSystemPrompt = buildVeroForceFinalSystemPrompt({ manifest, feedbackInjection });
  const forcedPrompt = `${forcedSystemPrompt}\n\n对话记录：\n${historyText}\n\n请给出下一步 action JSON。`;
  try {
    const raw = await invokeVeroRoundWithRetry(invoke, forcedPrompt, forcedSystemPrompt);
    const decision = parseVeroRoundDecision(raw);
    return isVeroReplyDecision(decision) ? decision : null;
  } catch {
    return null;
  }
}
```

Find the decision-handling block in the main loop:

```typescript
    let decision: VeroRoundDecision;
    try {
      decision = parseVeroRoundDecision(raw);
    } catch (err) {
      emit({ type: "error", message: `Vero 返回内容无法解析: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }

    if (isVeroReplyDecision(decision)) {
      emitTextInChunks(decision.reply, emit);
      appendMessages(sessionId, { role: "assistant", content: decision.reply });
      emit({ type: "done" });
      return;
    }

    const outcome = await executeVeroToolDecision(sessionId, decision, agentConfig, emit, userQuestion);
```

Replace with:

```typescript
    let decision: VeroRoundDecision;
    try {
      decision = parseVeroRoundDecision(raw);
    } catch (err) {
      emit({ type: "error", message: `Vero 返回内容无法解析: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }

    if (isLastRound && !isVeroReplyDecision(decision)) {
      // Model ignored the last-round instruction in the system prompt and
      // still wants a tool. Give it one forced-final retry with a stronger
      // prompt instead of executing a tool on a round that's about to be
      // discarded either way.
      const forced = await tryForceLastRoundFinal(invoke, manifest, feedbackInjection, historyText);
      if (forced) {
        decision = forced;
      } else {
        break;
      }
    }

    if (isVeroReplyDecision(decision)) {
      emitTextInChunks(decision.reply, emit);
      appendMessages(sessionId, { role: "assistant", content: decision.reply });
      emit({ type: "done" });
      return;
    }

    const outcome = await executeVeroToolDecision(sessionId, decision, agentConfig, emit, userQuestion);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd pcr-ai-api && npx tsx --test test/veroAgentLoop.test.ts`
Expected: PASS — all tests in this file green, including the three new ones.

- [ ] **Step 6: Typecheck**

Run: `cd pcr-ai-api && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Run the full test suite**

Run: `cd pcr-ai-api && npm test`
Expected: 3 more passing tests than Task 1's baseline (734 tests / 728 pass / 2 known pre-existing failures / 4 skipped) — no other file's tests should change, since this only touches behavior on the last round when the model returns `action:"tool"`, a path no other existing test exercises.

- [ ] **Step 8: Commit**

```bash
cd pcr-ai-api
git add src/lib/agent/core/veroAgentLoopPrompt.ts src/lib/agent/core/veroAgentLoop.ts test/veroAgentLoop.test.ts
git commit -m "feat(agent): enforce last-round final with one forced retry instead of a hint-only prompt"
```

---

## Task 3: Fix the smoke script's default question

**Files:**
- Modify: `pcr-ai-api/scripts/smoke-vero-generic-loop.mjs`

This script is not part of `npm test` (it requires a real `WCHAT_ACCESS_TOKEN` and network access — Cursor runs it, not the local dev environment). Cursor's real-network test (`docs/HANDOFF_CURSOR_VERO_GENERIC_LOOP_TEST_RESULTS.md` §3.1) confirmed the script's default question, `"WA03P02G 最近的探针卡机台组合表现怎么样"`, matches `isProbeCardTesterPerformanceQuestion` and gets answered by the Path B pilot before Vero's generic multi-round protocol is ever exercised — the smoke test was only proving "the flag doesn't crash," not "the generic loop works."

- [ ] **Step 1: Replace the question and add a hijack-detection warning**

Find:

```javascript
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

Replace with:

```javascript
const events = [];
// Entity-free question (no device/lot/card code, no "探针卡"+"机台"+"组合"
// phrasing) so none of the 15 PRE_LLM_DIRECT_ROUTES runners match and this
// smoke test actually exercises Vero's multi-round tool-selection protocol
// instead of being silently answered by a direct route before Vero is ever
// called. The previous question, "WA03P02G 最近的探针卡机台组合表现怎么样",
// matched the Path B probe-card pilot and never reached the generic loop —
// see docs/HANDOFF_CURSOR_VERO_GENERIC_LOOP_TEST_RESULTS.md §3.1.
const q = "帮我看一下最近的整体情况，随便分析一下";
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

const toolStartCount = events.filter((e) => e.type === "tool_start").length;
console.log("tool_start count:", toolStartCount);

const hitPathBPilot = events.some(
  (e) => e.type === "status" && typeof e.message === "string" && e.message.includes("Vero 试点")
);
if (hitPathBPilot) {
  console.warn(
    "\nWARN: this run was answered by the Path B probe-card pilot (a status " +
      'message contained "Vero 试点"), not the generic multi-round loop — ' +
      "the question matched a PRE_LLM direct route. This smoke run did not " +
      "actually exercise the generic loop's multi-round Vero protocol; " +
      "pick a different entity-free question."
  );
}

if (!events.some((e) => e.type === "done")) {
  console.error("\nFAIL: loop did not complete with a done event");
  process.exit(1);
}
console.log("\nOK: Vero generic-loop smoke passed");
```

- [ ] **Step 2: Verify the script's syntax is valid**

This script cannot be run without a real `WCHAT_ACCESS_TOKEN` and network access (not available in this environment). Verify only that the edit is syntactically valid JavaScript:

Run: `cd pcr-ai-api && node --check scripts/smoke-vero-generic-loop.mjs`
Expected: no output (silent success means valid syntax).

- [ ] **Step 3: Commit**

```bash
cd pcr-ai-api
git add scripts/smoke-vero-generic-loop.mjs
git commit -m "fix(agent): smoke script's default question no longer hijacked by Path B pilot"
```

---

## Self-Review Notes (already applied above)

- **Spec coverage:** Task 1 removes the duplication risk the code review flagged, without touching either loop's runtime behavior. Task 2 replaces the hint-only last-round constraint with one enforced forced-retry, matching the design doc's existing "never fabricate, always have a deterministic escape hatch" philosophy rather than inventing a new mechanism. Task 3 fixes exactly the gap Cursor's own test report identified.
- **Type consistency:** `tryForceLastRoundFinal`'s return type (`VeroReplyDecision | null`) and its call site's handling (`if (forced) { decision = forced; } else { break; }`) are consistent between Task 2's Step 4 code blocks.
- **No placeholders:** every step contains complete, compilable code.
