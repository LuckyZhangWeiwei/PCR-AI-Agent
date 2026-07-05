# Shared AI Agent API Key Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the AI Agent's API Key setting — plus two JB routing dark-launch flags discovered mid-review (`JB_DETERMINISTIC_DISPATCH`, `JB_LLM_INTENT_CLASSIFIER`) — from per-browser `localStorage` / `.env`-only into the existing server-side shared config (`runtime-config.json` / `GET|PATCH /api/v4/admin/config`), so a change on one client takes effect on every other client immediately, with no pm2 reload/restart — exactly like every other Agent setting already works.

**Architecture:** Add `agentApiKey: string`, `jbDeterministicDispatch: boolean`, and `jbLlmIntentClassifier: boolean` to the existing `RuntimeConfig` (backend) and `ServerConfig` (frontend) types that already flow through the generic admin-config GET/PATCH mechanism. Rewire the two call sites that currently read `process.env.JB_*` directly to read the shared config instead, so those flags actually take effect without a restart. Wire the Settings page API Key input and two new toggle switches to `useServerConfig`'s `updateServerConfig`. Add a one-time migration that lifts a user's existing localStorage API key up to the server the first time the app loads post-upgrade. Give `runtimeConfig.ts` an env-overridable config file path so its new test can run against an isolated temp file instead of the real git-tracked `runtime-config.json` — required once Task 2 makes other tests (`jbRouteResolver.test.ts`, `agentLoop.test.ts`) indirectly depend on `getConfig()`, to avoid file-mutation races between concurrently-running test files.

**Tech Stack:** Node.js/Express/TypeScript (`pcr-ai-api`), React 19/TypeScript/Vite (`pcr-ai-report`), `node:test` + `node:assert/strict` for backend tests.

## Global Constraints

- `GET /api/v4/admin/config` returns the API key unmasked, same as every other field — no masking, no new auth added to admin endpoints (explicit user decision).
- `pcr-ai-api/runtime-config.json` stays git-tracked as-is — do not add it to `.gitignore` or untrack it (explicit user decision).
- Only `JB_DETERMINISTIC_DISPATCH` and `JB_LLM_INTENT_CLASSIFIER` move into shared config. `YIELD_MONITOR_TRIGGERS_DUMMY` / `INFCONTROL_LAYER_BINS_DUMMY` do **not** — they're forced off in `dist`/production regardless of the env var (`listDummyRuntime.ts`), so shared-config toggles for them would have no effect where it matters (explicit user decision).
- Both new JB flags get visible toggle switches on the Settings page, using the same `toggle-switch` markup pattern already used for `agentEnabled` (explicit user decision).
- No test may mutate the real, git-tracked `pcr-ai-api/runtime-config.json`. Use the `RUNTIME_CONFIG_PATH` env override (Task 1) to redirect `runtimeConfig.test.ts` to an isolated temp file.
- `pcr-ai-report` has no configured test runner for React hooks/components (`package.json` only has `dev`/`build`/`lint`/`preview`) — frontend verification for this plan is `npm run build` (typecheck) + manual browser steps, matching existing project convention.

---

### Task 1: Backend — `agentApiKey` + JB dark-launch flags in `runtimeConfig.ts`

**Files:**
- Modify: `pcr-ai-api/src/lib/runtimeConfig.ts`
- Test: `pcr-ai-api/test/runtimeConfig.test.ts` (new)

**Interfaces:**
- Produces: `RuntimeConfig.agentApiKey: string` (file → `AGENT_API_KEY` env → `SILICONFLOW_API_KEY` env → `""`), `RuntimeConfig.jbDeterministicDispatch: boolean` (file → `JB_DETERMINISTIC_DISPATCH === "true"` → `false`), `RuntimeConfig.jbLlmIntentClassifier: boolean` (file → `JB_LLM_INTENT_CLASSIFIER === "true"` → `false`); all three settable via `patchConfig({...})`.
- Produces: `RUNTIME_CONFIG_PATH` env var — when set, `runtimeConfig.ts` reads/writes that path instead of `<cwd>/runtime-config.json`. Read once at module load time (top-level `const`), so callers must set the env var before the module's first import (dynamic `import()` after setting `process.env`, matching the existing pattern in `test/agentConfig.test.ts`).

- [ ] **Step 1: Write the failing test**

Create `pcr-ai-api/test/runtimeConfig.test.ts`:

```ts
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// RUNTIME_CONFIG_PATH is read once at module load time inside runtimeConfig.ts,
// so it must be set before that module's first import in this process. Every
// test below dynamically imports the module (after this line has already run)
// instead of using a static top-level import, which ESM would hoist above this
// assignment. This keeps the test off the real, git-tracked runtime-config.json
// entirely — required because Task 2 makes other test files read the real file
// via getConfig(), and node's test runner runs test files concurrently.
const TEST_CONFIG_PATH = join(
  tmpdir(),
  `pcr-ai-runtime-config-test-${process.pid}-${Date.now()}.json`
);
process.env.RUNTIME_CONFIG_PATH = TEST_CONFIG_PATH;

describe("runtimeConfig", () => {
  after(() => {
    delete process.env.RUNTIME_CONFIG_PATH;
    if (existsSync(TEST_CONFIG_PATH)) unlinkSync(TEST_CONFIG_PATH);
  });

  it("agentApiKey defaults to empty string when nothing configured", async () => {
    const { getConfig } = await import("../src/lib/runtimeConfig.js");
    assert.equal(getConfig().agentApiKey, "");
  });

  it("reads AGENT_API_KEY from env when file has no value", async () => {
    const saved = process.env.AGENT_API_KEY;
    process.env.AGENT_API_KEY = "sk-from-env";
    try {
      const { getConfig } = await import("../src/lib/runtimeConfig.js");
      assert.equal(getConfig().agentApiKey, "sk-from-env");
    } finally {
      if (saved === undefined) delete process.env.AGENT_API_KEY;
      else process.env.AGENT_API_KEY = saved;
    }
  });

  it("falls back to SILICONFLOW_API_KEY when AGENT_API_KEY is unset", async () => {
    const savedAgent = process.env.AGENT_API_KEY;
    const savedSilicon = process.env.SILICONFLOW_API_KEY;
    delete process.env.AGENT_API_KEY;
    process.env.SILICONFLOW_API_KEY = "sk-from-siliconflow";
    try {
      const { getConfig } = await import("../src/lib/runtimeConfig.js");
      assert.equal(getConfig().agentApiKey, "sk-from-siliconflow");
    } finally {
      if (savedAgent === undefined) delete process.env.AGENT_API_KEY;
      else process.env.AGENT_API_KEY = savedAgent;
      if (savedSilicon === undefined) delete process.env.SILICONFLOW_API_KEY;
      else process.env.SILICONFLOW_API_KEY = savedSilicon;
    }
  });

  it("persists agentApiKey via patchConfig and prefers it over env", async () => {
    const saved = process.env.AGENT_API_KEY;
    process.env.AGENT_API_KEY = "sk-from-env";
    try {
      const { getConfig, patchConfig } = await import("../src/lib/runtimeConfig.js");
      const updated = patchConfig({ agentApiKey: "sk-from-file" });
      assert.equal(updated.agentApiKey, "sk-from-file");
      assert.equal(getConfig().agentApiKey, "sk-from-file");
    } finally {
      if (saved === undefined) delete process.env.AGENT_API_KEY;
      else process.env.AGENT_API_KEY = saved;
    }
  });

  it("jbDeterministicDispatch defaults to false, reads env, and can be persisted", async () => {
    const saved = process.env.JB_DETERMINISTIC_DISPATCH;
    delete process.env.JB_DETERMINISTIC_DISPATCH;
    try {
      const { getConfig, patchConfig } = await import("../src/lib/runtimeConfig.js");
      assert.equal(getConfig().jbDeterministicDispatch, false);
      process.env.JB_DETERMINISTIC_DISPATCH = "true";
      assert.equal(getConfig().jbDeterministicDispatch, true);
      delete process.env.JB_DETERMINISTIC_DISPATCH;
      const updated = patchConfig({ jbDeterministicDispatch: true });
      assert.equal(updated.jbDeterministicDispatch, true);
      assert.equal(getConfig().jbDeterministicDispatch, true);
    } finally {
      if (saved === undefined) delete process.env.JB_DETERMINISTIC_DISPATCH;
      else process.env.JB_DETERMINISTIC_DISPATCH = saved;
    }
  });

  it("jbLlmIntentClassifier defaults to false, reads env, and can be persisted", async () => {
    const saved = process.env.JB_LLM_INTENT_CLASSIFIER;
    delete process.env.JB_LLM_INTENT_CLASSIFIER;
    try {
      const { getConfig, patchConfig } = await import("../src/lib/runtimeConfig.js");
      assert.equal(getConfig().jbLlmIntentClassifier, false);
      process.env.JB_LLM_INTENT_CLASSIFIER = "true";
      assert.equal(getConfig().jbLlmIntentClassifier, true);
      delete process.env.JB_LLM_INTENT_CLASSIFIER;
      const updated = patchConfig({ jbLlmIntentClassifier: true });
      assert.equal(updated.jbLlmIntentClassifier, true);
      assert.equal(getConfig().jbLlmIntentClassifier, true);
    } finally {
      if (saved === undefined) delete process.env.JB_LLM_INTENT_CLASSIFIER;
      else process.env.JB_LLM_INTENT_CLASSIFIER = saved;
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `pcr-ai-api/`): `npm test -- test/runtimeConfig.test.ts`
Expected: FAIL — `agentApiKey`/`jbDeterministicDispatch`/`jbLlmIntentClassifier` are `undefined` on the returned config (properties don't exist yet).

- [ ] **Step 3: Implement `RUNTIME_CONFIG_PATH` override, `agentApiKey`, and the two JB flags in `runtimeConfig.ts`**

In `pcr-ai-api/src/lib/runtimeConfig.ts`, change the `CONFIG_PATH` constant:

```ts
const CONFIG_PATH = resolve(
  process.cwd(),
  process.env.RUNTIME_CONFIG_PATH?.trim() || "runtime-config.json"
);
```

Add to the interface (after `agentSubModel`):

```ts
export interface RuntimeConfig {
  agentEnabled: boolean;
  agentApiBase: string;
  agentModel: string;
  /** 子任务模型：用于历史压缩 + 确定性表解读（不涉及工具选择/最终回答）。空字符串 = 与 agentModel 相同。 */
  agentSubModel: string;
  /** OpenAI 兼容接口密钥，服务器端共享——任一客户端修改后所有客户端立即生效，无需重启。 */
  agentApiKey: string;
  /** JB 决策驱动确定性派发 dark-launch 开关（见 agentLoop.ts）。 */
  jbDeterministicDispatch: boolean;
  /** JB 路由 LLM 意图分类器 dark-launch 开关（见 jbRouteResolver.ts）。 */
  jbLlmIntentClassifier: boolean;
  maxRounds: number;
  streamTimeoutSec: number;
  clientTimeoutSec: number;
  toolResultMaxChars: number;
  toolResultMaxHistoryChars: number;
  listDefaultLimit: number;
  listMaxLimit: number;
}
```

Add the defaults (after `agentSubModel: ""`):

```ts
export const RUNTIME_CONFIG_DEFAULTS: RuntimeConfig = {
  agentEnabled: true,
  agentApiBase: "https://api.siliconflow.cn/v1",
  agentModel: "deepseek-ai/DeepSeek-V3",
  agentSubModel: "",
  agentApiKey: "",
  jbDeterministicDispatch: false,
  jbLlmIntentClassifier: false,
  maxRounds: 5,
  streamTimeoutSec: 150,
  clientTimeoutSec: 180,
  toolResultMaxChars: 12000,
  toolResultMaxHistoryChars: 12000,
  listDefaultLimit: 300,
  listMaxLimit: 1000,
};
```

In `getConfig()`, add resolution logic right after the existing `agentSubModel` block and before `maxRounds`:

```ts
    agentSubModel:
      (typeof f.agentSubModel === "string" ? f.agentSubModel : undefined) ??
      process.env.AGENT_SUB_MODEL?.trim() ??
      D.agentSubModel,
    agentApiKey:
      (typeof f.agentApiKey === "string" && f.agentApiKey) ||
      process.env.AGENT_API_KEY?.trim() ||
      process.env.SILICONFLOW_API_KEY?.trim() ||
      D.agentApiKey,
    jbDeterministicDispatch:
      typeof f.jbDeterministicDispatch === "boolean"
        ? f.jbDeterministicDispatch
        : process.env.JB_DETERMINISTIC_DISPATCH === "true",
    jbLlmIntentClassifier:
      typeof f.jbLlmIntentClassifier === "boolean"
        ? f.jbLlmIntentClassifier
        : process.env.JB_LLM_INTENT_CLASSIFIER === "true",
    maxRounds: num(
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `pcr-ai-api/`): `npm test -- test/runtimeConfig.test.ts`
Expected: PASS, all 6 cases green.

- [ ] **Step 5: Run the full backend test suite to confirm no regressions**

Run (from `pcr-ai-api/`): `npm test`
Expected: PASS (existing suites unaffected — nothing else references `RUNTIME_CONFIG_PATH` or the new fields yet; that's Task 2).

- [ ] **Step 6: Commit**

```bash
git add pcr-ai-api/src/lib/runtimeConfig.ts pcr-ai-api/test/runtimeConfig.test.ts
git commit -m "$(cat <<'EOF'
feat(api): add agentApiKey and JB dark-launch flags to shared runtime config

Folds the AI Agent API Key, JB_DETERMINISTIC_DISPATCH, and
JB_LLM_INTENT_CLASSIFIER into the existing runtime-config.json /
admin/config mechanism, resolving file value, then the matching env
var, then a default — same pattern every other agent setting already
uses. Adds a RUNTIME_CONFIG_PATH env override so tests can point at an
isolated file instead of the real git-tracked runtime-config.json.
EOF
)"
```

---

### Task 2: Backend — wire JB dark-launch flags to shared config at their call sites

**Files:**
- Modify: `pcr-ai-api/src/lib/agent/agentLoop.ts`
- Modify: `pcr-ai-api/src/lib/agent/jbRouteResolver.ts`

**Interfaces:**
- Consumes: `getConfig()` from `../runtimeConfig.js` (Task 1), specifically `.jbDeterministicDispatch` and `.jbLlmIntentClassifier`.
- Produces: no new exports — same function signatures (`tryRunSemanticDispatchDirectRoute`, `classifyJbIntent`), just a different flag source.

Today both flags are read directly via `process.env.X` at call time. That means flipping them requires an `.env` edit + restart. Since `getConfig()` re-reads `runtime-config.json` on every call (falling back to the same env vars when the file has no override), swapping the read site to `getConfig()` is what actually makes the flags toggle live from the Settings page — Task 1 alone only adds the storage, this task makes it take effect.

- [ ] **Step 1: Update `agentLoop.ts`**

Add the import (near the top, alongside the other relative imports — e.g. right after the `import type { AgentConfig } from "./agentConfig.js";` line):

```ts
import { getConfig } from "../runtimeConfig.js";
```

Find this block (currently around line 2015):

```ts
export async function tryRunSemanticDispatchDirectRoute(
  sessionId: string,
  userQuestion: string,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void
): Promise<boolean> {
  if (process.env.JB_DETERMINISTIC_DISPATCH !== "true") return false; // dark-launch
```

Change the guard line to:

```ts
  if (!getConfig().jbDeterministicDispatch) return false; // dark-launch
```

- [ ] **Step 2: Update `jbRouteResolver.ts`**

Add the import (alongside the existing `import type { AgentConfig } from "./agentConfig.js";` line):

```ts
import { getConfig } from "../runtimeConfig.js";
```

Find this block (currently around line 81-82):

```ts
export async function classifyJbIntent(
  q: string,
  ctx: { lastToolName?: string; cachedLot?: string },
  agentConfig: AgentConfig,
  deps?: { chat?: ChatFn },
  history?: unknown,
  payload?: Record<string, unknown>
): Promise<JbRouteDecision> {
  const base = resolveJbRoute(q, history, payload);
  if (process.env.JB_LLM_INTENT_CLASSIFIER !== "true") return base;
```

Change the guard line to:

```ts
  if (!getConfig().jbLlmIntentClassifier) return base;
```

- [ ] **Step 3: Run the tests that already exercise these two flags**

Run (from `pcr-ai-api/`): `npm test -- test/jbRouteResolver.test.ts test/agentLoop.test.ts`
Expected: PASS. These tests set `process.env.JB_LLM_INTENT_CLASSIFIER` / `process.env.JB_DETERMINISTIC_DISPATCH` directly and never set `RUNTIME_CONFIG_PATH`, so `getConfig()` reads the real (unmodified) `runtime-config.json` — which has no `jbLlmIntentClassifier`/`jbDeterministicDispatch` keys — and falls through to the same env var check as before. No test changes needed.

- [ ] **Step 4: Run the full backend test suite to confirm no regressions**

Run (from `pcr-ai-api/`): `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pcr-ai-api/src/lib/agent/agentLoop.ts pcr-ai-api/src/lib/agent/jbRouteResolver.ts
git commit -m "$(cat <<'EOF'
feat(api): read JB dark-launch flags from shared config, not process.env

tryRunSemanticDispatchDirectRoute and classifyJbIntent now call
getConfig() instead of reading process.env.JB_DETERMINISTIC_DISPATCH /
JB_LLM_INTENT_CLASSIFIER directly, so toggling them via
PATCH /api/v4/admin/config takes effect immediately instead of
requiring an .env edit and restart.
EOF
)"
```

---

### Task 3: Frontend — shared-config hooks

**Files:**
- Modify: `pcr-ai-report/src/hooks/useServerConfig.ts`
- Modify: `pcr-ai-report/src/hooks/usePersistedAgentConfig.ts`

**Interfaces:**
- Consumes: none (pure hook-layer change).
- Produces: `ServerConfig.agentApiKey: string`, `ServerConfig.jbDeterministicDispatch: boolean`, `ServerConfig.jbLlmIntentClassifier: boolean`; `useServerConfig(apiBase)` now returns a 4-tuple `[config, updateConfig, fetchConfig, loaded]` where `loaded: boolean` becomes `true` once the first `fetchConfig()` attempt (success or failure) has completed. `takeLegacyApiKey(): string` reads-and-clears the old localStorage key `pcr-ai-report.agent.apikey.v1`. The `usePersistedApiKey` hook is removed.

- [ ] **Step 1: Update `useServerConfig.ts`**

Full replacement of `pcr-ai-report/src/hooks/useServerConfig.ts`:

```ts
import { useState, useEffect, useCallback } from "react";

export interface ServerConfig {
  agentEnabled: boolean;
  agentApiBase: string;
  agentModel: string;
  /** 子任务模型（历史压缩 + 表解读）。默认 DeepSeek-V4-Flash。 */
  agentSubModel: string;
  /** OpenAI 兼容接口密钥，服务器端共享，跨客户端同步。 */
  agentApiKey: string;
  /** JB 决策驱动确定性派发 dark-launch 开关。 */
  jbDeterministicDispatch: boolean;
  /** JB 路由 LLM 意图分类器 dark-launch 开关。 */
  jbLlmIntentClassifier: boolean;
  maxRounds: number;
  streamTimeoutSec: number;
  clientTimeoutSec: number;
  toolResultMaxChars: number;
  toolResultMaxHistoryChars: number;
  listDefaultLimit: number;
  listMaxLimit: number;
}

export const SERVER_CONFIG_DEFAULTS: ServerConfig = {
  agentEnabled: true,
  agentApiBase: "https://api.siliconflow.cn/v1",
  agentModel: "deepseek-ai/DeepSeek-V4-Pro",
  agentSubModel: "deepseek-ai/DeepSeek-V4-Flash",
  agentApiKey: "",
  jbDeterministicDispatch: false,
  jbLlmIntentClassifier: false,
  maxRounds: 8,
  streamTimeoutSec: 150,
  clientTimeoutSec: 240,
  toolResultMaxChars: 20000,
  toolResultMaxHistoryChars: 8000,
  listDefaultLimit: 300,
  listMaxLimit: 1000,
};

function resolveBase(apiBase: string): string {
  return apiBase.replace(/\/$/, "") || window.location.origin;
}

export function useServerConfig(apiBase: string): [
  ServerConfig,
  (patch: Partial<ServerConfig>) => Promise<void>,
  () => Promise<void>,
  boolean,
] {
  const [config, setConfig] = useState<ServerConfig>(SERVER_CONFIG_DEFAULTS);
  const [loaded, setLoaded] = useState(false);

  const fetchConfig = useCallback(async () => {
    try {
      const res = await fetch(`${resolveBase(apiBase)}/api/v4/admin/config`, {
        cache: "no-store",
      });
      if (res.ok) {
        const data = (await res.json()) as Partial<ServerConfig>;
        setConfig((prev) => ({ ...prev, ...data }));
      }
    } catch {
      // keep current state
    } finally {
      setLoaded(true);
    }
  }, [apiBase]);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  const updateConfig = useCallback(
    async (patch: Partial<ServerConfig>) => {
      setConfig((prev) => ({ ...prev, ...patch })); // optimistic
      try {
        const res = await fetch(
          `${resolveBase(apiBase)}/api/v4/admin/config`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch),
          }
        );
        if (res.ok) {
          const updated = (await res.json()) as Partial<ServerConfig>;
          setConfig((prev) => ({ ...prev, ...updated }));
        } else {
          await fetchConfig(); // revert
        }
      } catch {
        await fetchConfig(); // revert
      }
    },
    [apiBase, fetchConfig]
  );

  return [config, updateConfig, fetchConfig, loaded];
}
```

- [ ] **Step 2: Update `usePersistedAgentConfig.ts`**

Full replacement of `pcr-ai-report/src/hooks/usePersistedAgentConfig.ts`:

```ts
// pcr-ai-report/src/hooks/usePersistedAgentConfig.ts
// All settings including apiKey are now stored server-side (useServerConfig).

/** Shape sent in every POST /api/v4/agent/chat request body */
export interface AgentConfig {
  apiKey: string;
  apiBase: string;
  model: string;
  /** 子任务模型（历史压缩 + 表解读）。等于 model 时无差异。 */
  subAgentModel: string;
  maxRounds: number;
  streamTimeoutSec: number;
  clientTimeoutSec: number;
  toolResultMaxChars: number;
  toolResultMaxHistoryChars: number;
}

const LEGACY_API_KEY_STORAGE_KEY = "pcr-ai-report.agent.apikey.v1";

/**
 * One-time migration helper: reads the pre-server-config API key (if any)
 * left over from before apiKey moved to shared server config, and removes
 * it from localStorage so it is only ever consumed once.
 */
export function takeLegacyApiKey(): string {
  try {
    const v = localStorage.getItem(LEGACY_API_KEY_STORAGE_KEY) ?? "";
    if (v) localStorage.removeItem(LEGACY_API_KEY_STORAGE_KEY);
    return v;
  } catch {
    return "";
  }
}
```

- [ ] **Step 3: Typecheck**

Run (from `pcr-ai-report/`): `npm run build`
Expected: FAILS at this point with errors in `App.tsx` (`usePersistedApiKey` no longer exported, `apiKey`/`setApiKey` unused/undefined, `useServerConfig` tuple now has 4 elements). This is expected — `App.tsx` is fixed in Task 4. Confirm the *only* errors reported are in `App.tsx` (none in the two files just changed).

- [ ] **Step 4: Commit**

```bash
git add pcr-ai-report/src/hooks/useServerConfig.ts pcr-ai-report/src/hooks/usePersistedAgentConfig.ts
git commit -m "$(cat <<'EOF'
feat(report): add agentApiKey + JB flags to server config hook, drop localStorage hook

useServerConfig now tracks agentApiKey, jbDeterministicDispatch, and
jbLlmIntentClassifier like every other agent setting, and exposes a
`loaded` flag so callers can tell when the first fetch has completed.
usePersistedApiKey is replaced by a one-shot takeLegacyApiKey()
migration helper. App.tsx wiring follows in the next commit — this
commit alone leaves the frontend build broken by design.
EOF
)"
```

---

### Task 4: Frontend — wire `App.tsx` to the shared API Key and JB flag toggles

**Files:**
- Modify: `pcr-ai-report/src/App.tsx`

**Interfaces:**
- Consumes: `useServerConfig` 4-tuple (Task 3), `takeLegacyApiKey()` (Task 3).
- Produces: working Settings page API Key field backed by server config; two new visible toggle switches for `jbDeterministicDispatch` / `jbLlmIntentClassifier`; `agentConfig.apiKey` sourced from `serverConfig.agentApiKey`.

- [ ] **Step 1: Update imports**

In `pcr-ai-report/src/App.tsx`, change:

```ts
import { useCallback, useEffect, useLayoutEffect, useState } from "react";
```
to:
```ts
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
```

and change:
```ts
import { type AgentConfig, usePersistedApiKey } from "./hooks/usePersistedAgentConfig.js";
```
to:
```ts
import { type AgentConfig, takeLegacyApiKey } from "./hooks/usePersistedAgentConfig.js";
```

- [ ] **Step 2: Update `useServerConfig` destructuring and remove the old apiKey hook**

Change:
```ts
  const [serverConfig, updateServerConfig, fetchServerConfig] = useServerConfig(apiBase);
  const [apiKey, setApiKey] = usePersistedApiKey();
  const [agentApiKeyVisible, setAgentApiKeyVisible] = useState(false);
```
to:
```ts
  const [serverConfig, updateServerConfig, fetchServerConfig, serverConfigLoaded] = useServerConfig(apiBase);
  const [agentApiKeyVisible, setAgentApiKeyVisible] = useState(false);
```

- [ ] **Step 3: Point `agentConfig.apiKey` at server config**

Change:
```ts
  const agentConfig: AgentConfig = {
    apiKey,
    apiBase: serverConfig.agentApiBase,
```
to:
```ts
  const agentConfig: AgentConfig = {
    apiKey: serverConfig.agentApiKey,
    apiBase: serverConfig.agentApiBase,
```

- [ ] **Step 4: Add the input buffer, its sync effect, and the one-time migration effect**

Change:
```ts
  // Local buffers for text inputs — only PATCH server on blur
  const [agentApiBaseInput, setAgentApiBaseInput] = useState(serverConfig.agentApiBase);
  const [agentModelInput, setAgentModelInput] = useState(serverConfig.agentModel);
  const [agentSubModelInput, setAgentSubModelInput] = useState(serverConfig.agentSubModel);

  // Sync text buffers when server config loads/resets
  useEffect(() => { setAgentApiBaseInput(serverConfig.agentApiBase); }, [serverConfig.agentApiBase]);
  useEffect(() => { setAgentModelInput(serverConfig.agentModel); }, [serverConfig.agentModel]);
  useEffect(() => { setAgentSubModelInput(serverConfig.agentSubModel); }, [serverConfig.agentSubModel]);
```
to:
```ts
  // Local buffers for text inputs — only PATCH server on blur
  const [agentApiBaseInput, setAgentApiBaseInput] = useState(serverConfig.agentApiBase);
  const [agentModelInput, setAgentModelInput] = useState(serverConfig.agentModel);
  const [agentSubModelInput, setAgentSubModelInput] = useState(serverConfig.agentSubModel);
  const [agentApiKeyInput, setAgentApiKeyInput] = useState(serverConfig.agentApiKey);

  // Sync text buffers when server config loads/resets
  useEffect(() => { setAgentApiBaseInput(serverConfig.agentApiBase); }, [serverConfig.agentApiBase]);
  useEffect(() => { setAgentModelInput(serverConfig.agentModel); }, [serverConfig.agentModel]);
  useEffect(() => { setAgentSubModelInput(serverConfig.agentSubModel); }, [serverConfig.agentSubModel]);
  useEffect(() => { setAgentApiKeyInput(serverConfig.agentApiKey); }, [serverConfig.agentApiKey]);

  // One-time migration: lift a pre-existing localStorage API key up to the
  // shared server config, the first time we've confirmed the server has none.
  const migratedApiKeyRef = useRef(false);
  useEffect(() => {
    if (!serverConfigLoaded || migratedApiKeyRef.current) return;
    migratedApiKeyRef.current = true;
    if (!serverConfig.agentApiKey) {
      const legacy = takeLegacyApiKey();
      if (legacy) updateServerConfig({ agentApiKey: legacy });
    }
  }, [serverConfigLoaded, serverConfig.agentApiKey, updateServerConfig]);
```

- [ ] **Step 5: Update the API Key form field**

Change:
```tsx
              <label>
                <span>API Key</span>
                <div className="api-panel-key-row">
                  <input
                    type={agentApiKeyVisible ? "text" : "password"}
                    value={apiKey}
                    placeholder="sk-..."
                    onChange={(e) => setApiKey(e.target.value)}
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    className="btn ghost"
                    onClick={() => setAgentApiKeyVisible((v) => !v)}
                    title={agentApiKeyVisible ? "隐藏" : "显示"}
                  >
                    {agentApiKeyVisible ? "🙈" : "👁"}
                  </button>
                </div>
              </label>
              <p className="field-hint">
                SiliconFlow / OpenAI 兼容接口的密钥。留空时后端读取服务器环境变量
                <code>AGENT_API_KEY</code>；若两处均无则返回 400。
              </p>
```
to:
```tsx
              <label>
                <span>API Key</span>
                <div className="api-panel-key-row">
                  <input
                    type={agentApiKeyVisible ? "text" : "password"}
                    value={agentApiKeyInput}
                    placeholder="sk-..."
                    onChange={(e) => setAgentApiKeyInput(e.target.value)}
                    onBlur={(e) => updateServerConfig({ agentApiKey: e.target.value.trim() })}
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    className="btn ghost"
                    onClick={() => setAgentApiKeyVisible((v) => !v)}
                    title={agentApiKeyVisible ? "隐藏" : "显示"}
                  >
                    {agentApiKeyVisible ? "🙈" : "👁"}
                  </button>
                </div>
              </label>
              <p className="field-hint">
                SiliconFlow / OpenAI 兼容接口的密钥。<strong>服务器端共享配置</strong>——任一客户端修改后，其他所有客户端立即生效，无需重启。留空时后端读取服务器环境变量
                <code>AGENT_API_KEY</code>；若两处均无则返回 400。
              </p>
```

- [ ] **Step 6: Add the two JB dark-launch flag toggles**

Find the closing of the timeouts group and the reset-defaults button (the `<hr className="settings-divider" />` immediately before `{/* ── 超时 ── */}` marks the previous group's end; the block below comes right after the 「浏览器请求超时」 `<p className="field-hint">` and right before the `<div className="api-panel-actions">` reset-defaults button). Insert a new group between them:

```tsx
              <hr className="settings-divider" />

              {/* ── JB 路由（内部灰度开关） ── */}
              <p className="settings-group-title">JB 路由（内部灰度开关）</p>
              <div className="setting-toggle-row">
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={serverConfig.jbDeterministicDispatch}
                    onChange={(e) =>
                      updateServerConfig({ jbDeterministicDispatch: e.target.checked })
                    }
                  />
                  <span className="toggle-track" />
                  <span className="toggle-label-text">决策驱动确定性派发（dark-launch）</span>
                </label>
                <p className="field-hint">
                  内部路由灰度开关，非日常设置。影响<strong>所有用户</strong>，立即生效无需重启。
                </p>
              </div>
              <div className="setting-toggle-row">
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={serverConfig.jbLlmIntentClassifier}
                    onChange={(e) =>
                      updateServerConfig({ jbLlmIntentClassifier: e.target.checked })
                    }
                  />
                  <span className="toggle-track" />
                  <span className="toggle-label-text">JB 路由 LLM 意图分类器（dark-launch）</span>
                </label>
                <p className="field-hint">
                  内部路由灰度开关，非日常设置。影响<strong>所有用户</strong>，立即生效无需重启。
                </p>
              </div>
```

Do **not** add these two fields to the existing 「↺ 恢复默认」 button's patch object — that button restores the everyday tunables (`agentApiBase`, `agentModel`, `maxRounds`, timeouts, `toolResultMaxChars`, `toolResultMaxHistoryChars`); the JB flags are internal routing switches, not defaults a user should casually "reset."

- [ ] **Step 7: Typecheck**

Run (from `pcr-ai-report/`): `npm run build`
Expected: PASS with no TypeScript errors.

- [ ] **Step 8: Commit**

```bash
git add pcr-ai-report/src/App.tsx
git commit -m "$(cat <<'EOF'
feat(report): source AI Agent API Key + JB flags from shared server config

Settings page API Key field now reads/writes serverConfig.agentApiKey
via updateServerConfig, same pattern as apiBase/model/subModel. A
one-time migration lifts any pre-existing localStorage key up to the
server the first time serverConfig confirms there isn't one already,
then clears the old localStorage entry. Adds two toggle switches for
the JB dark-launch routing flags (jbDeterministicDispatch,
jbLlmIntentClassifier), same markup pattern as the existing
agentEnabled toggle.
EOF
)"
```

---

### Task 5: Update handoff docs

**Files:**
- Modify: `pcr-ai-report/CLAUDE.md`
- Modify: `pcr-ai-api/CLAUDE.md`

**Interfaces:** none (documentation only).

- [ ] **Step 1: Add changelog entry to `pcr-ai-report/CLAUDE.md`**

Insert a new section after `## 20. 近期变更纪要（2026-05-27，Agent JB 逐片 BIN + 工具结果体积）` (i.e. immediately before the `## 12. 与 API 联调速查` section at the end of the file):

```markdown
## 21. 近期变更纪要（2026-07-05，AI Agent API Key + JB 灰度开关服务器端共享）

1. **API Key 不再是 per-browser 设置**：`usePersistedApiKey`（`localStorage` 键 `pcr-ai-report.agent.apikey.v1`）已删除。`serverConfig.agentApiKey` 现在和 `agentApiBase` / `agentModel` 等字段一样，走 `useServerConfig` 的 `GET/PATCH /api/v4/admin/config`——任一客户端在 Settings 页改动 API Key，其他所有客户端立即生效，无需重启 API。
2. **一次性迁移**：`App.tsx` 里 `migratedApiKeyRef` 守卫的 `useEffect`，在 `useServerConfig` 首次确认拉取完成（新增的 `loaded` 返回值）且服务器尚无 key 时，读取旧 `localStorage` 键并 `updateServerConfig({ agentApiKey })` 一次，随后清掉该 `localStorage` 项。之后即使用户主动清空 key，也不会被旧值复活。
3. **`useServerConfig` 签名变化**：返回值从 3 元组变为 4 元组 `[config, updateConfig, fetchConfig, loaded]`，新增的 `loaded: boolean` 在首次 `fetchConfig()`（成功或失败）完成后置 `true`。改动此 hook 的调用方需同步更新解构。
4. **JB 灰度开关也纳入共享配置**：`serverConfig.jbDeterministicDispatch` / `jbLlmIntentClassifier` 对应后端 `JB_DETERMINISTIC_DISPATCH` / `JB_LLM_INTENT_CLASSIFIER`（见 `../pcr-ai-api/CLAUDE.md` 同日条目）。Settings 页「JB 路由（内部灰度开关）」分组新增两个 toggle，样式与既有 `agentEnabled` toggle 一致；这两个是内部路由行为开关，未纳入「↺ 恢复默认」按钮。
5. **未变**：`GET /api/v4/admin/config` 仍无鉴权、字段仍明文直返——与其它字段安全等级一致，未额外加固。`YIELD_MONITOR_TRIGGERS_DUMMY` / `INFCONTROL_LAYER_BINS_DUMMY` 未纳入共享配置（生产环境下这两个 flag 被 `listDummyRuntime.ts` 强制忽略，纳入也不起作用）。
```

- [ ] **Step 2: Add changelog entry to `pcr-ai-api/CLAUDE.md`**

Insert a new section `22.` after item `21. Agent lot 列表直出 + YM 自动补 JB（2026-06-23）` in `## 11. 近期变更纪要`:

```markdown
22. **AI Agent API Key + JB 灰度开关服务器端共享（2026-07-05）**：
   - **`src/lib/runtimeConfig.ts`**：`RuntimeConfig` 新增 **`agentApiKey`**（解析顺序与 **`agentApiBase`** 一致：文件值 → **`AGENT_API_KEY`** env → **`SILICONFLOW_API_KEY`** env → **空串**）、**`jbDeterministicDispatch`** / **`jbLlmIntentClassifier`**（文件值 → 对应 env 变量 `=== "true"` → **`false`**）。新增 **`RUNTIME_CONFIG_PATH`** env override，供测试指向隔离临时文件，避免污染被 git 追踪的真实 `runtime-config.json`。**`admin.ts`** 无需改动（通用透传）。
   - **JB flag 调用点改读共享配置**：**`agentLoop.ts`** 的 **`tryRunSemanticDispatchDirectRoute`**、**`jbRouteResolver.ts`** 的 **`classifyJbIntent`**，原先直接读 **`process.env.JB_DETERMINISTIC_DISPATCH`** / **`process.env.JB_LLM_INTENT_CLASSIFIER`**，现改读 **`getConfig().jbDeterministicDispatch`** / **`getConfig().jbLlmIntentClassifier`**——这是让这两个 flag 真正**无需重启**即可切换的关键（仅在 `runtimeConfig.ts` 加字段不会让它们生效，必须同步改调用点）。**`test/jbRouteResolver.test.ts`**、**`test/agentLoop.test.ts`** 无需改动：这两个测试文件不设置 **`RUNTIME_CONFIG_PATH`**，`getConfig()` 读到的真实 `runtime-config.json` 没有这两个键，照样落回它们直接设置的 **`process.env`**。
   - **前端**：`pcr-ai-report` 的 API Key 输入从 `localStorage`（`usePersistedApiKey`）迁移到 **`serverConfig.agentApiKey`**（`useServerConfig`）；JB 两个 flag 在 Settings 页新增可见 toggle。任一客户端修改后所有客户端立即生效，无需重启；详见 **`../pcr-ai-report/CLAUDE.md` §21**。
   - **`resolveAgentConfig()`（`agentConfig.ts`）无需改动**：前端仍在每次 `/agent/chat` 请求体的 `agentConfig.apiKey` 里带上（现在是服务器共享值），沿用既有的 override 优先解析链。
   - **未纳入**：`YIELD_MONITOR_TRIGGERS_DUMMY` / `INFCONTROL_LAYER_BINS_DUMMY`——`listDummyRuntime.ts` 在 `dist`/生产下强制忽略这两个 env var，纳入共享配置在生产环境不会有任何效果，仅本地 dev 有意义（本地改 `.env` 已经很轻量）。
   - **安全边界未变**：**`GET/PATCH /api/v4/admin/config`** 依旧无鉴权，`agentApiKey` 和其它字段一样明文直返——本次改动刻意未加掩码或鉴权（用户明确决定），部署时仍需靠内网/防火墙隔离。
   - 回归 **`test/runtimeConfig.test.ts`**（新增）、**`test/jbRouteResolver.test.ts`**、**`test/agentLoop.test.ts`**（无改动，确认未回归）。
```

- [ ] **Step 3: Commit**

```bash
git add pcr-ai-report/CLAUDE.md pcr-ai-api/CLAUDE.md
git commit -m "docs: record AI Agent API Key + JB flag server-side sharing in handoff docs"
```

---

### Task 6: Manual end-to-end verification

**Files:** none (verification only, no commit).

- [ ] **Step 1: Start both dev servers**

```bash
cd pcr-ai-api && npm run dev
```
```bash
cd pcr-ai-report && npm run dev
```

- [ ] **Step 2: Confirm existing localStorage key gets migrated**

If you have a browser profile with an old API key already saved (`localStorage` key `pcr-ai-report.agent.apikey.v1`), open the app's Settings page (`?settings=true`), unlock it, and confirm the API Key field shows that value automatically. Reload — confirm `localStorage.getItem("pcr-ai-report.agent.apikey.v1")` in devtools now returns `null`.

- [ ] **Step 3: Confirm cross-client sharing of the API Key**

In browser A's Settings page, set a new API Key value and click elsewhere to blur the field. In browser B (a different browser or an incognito window, same `apiBase`), open Settings and confirm the same key appears — no API restart involved.

- [ ] **Step 4: Confirm the agent chat still works end-to-end**

From browser B, open the AI Agent tab and send a test message. Confirm the request succeeds (no `CONFIG_ERROR` about a missing API Key).

- [ ] **Step 5: Confirm clearing the API Key propagates and doesn't get re-migrated**

In browser A, clear the API Key field and blur it. In browser B, reload Settings and confirm the field is now empty. Reload browser A again — confirm the key stays empty (the one-time migration guard does not resurrect the old localStorage value, since it was already cleared in Step 2).

- [ ] **Step 6: Confirm the two JB toggles are visible, cross-client, and take effect without restart**

In browser A's Settings page, find the new 「JB 路由（内部灰度开关）」 group. Toggle 「决策驱动确定性派发」 on. In browser B, reload Settings and confirm the toggle shows on — no API restart. Toggle it back off from browser B; confirm browser A reflects the change on next reload. Repeat for 「JB 路由 LLM 意图分类器」.

---

## Self-Review Notes

- **Spec coverage:** Backend `agentApiKey` + JB flags + `RUNTIME_CONFIG_PATH` (Task 1), JB flag call-site rewiring (Task 2), `admin.ts`/`agent.ts` no-change confirmation (documented, not a task since nothing to do there), frontend `ServerConfig`/`loaded` (Task 3), `usePersistedAgentConfig` migration helper (Task 3), `App.tsx` wiring + migration effect + two toggles (Task 4), test plan incl. isolated temp-file config (Task 1) and no-regression checks for existing JB flag tests (Task 2), manual verification incl. JB toggles (Task 6), CLAUDE.md updates for both the API-key change and the JB-flag change (Task 5). All spec + addendum sections covered.
- **Placeholder scan:** No TBD/TODO; every step has literal code or exact commands.
- **Type consistency:** `ServerConfig.agentApiKey: string` / `jbDeterministicDispatch: boolean` / `jbLlmIntentClassifier: boolean` (Task 3) match `RuntimeConfig`'s same-named fields (Task 1) match the JSON shape returned by `GET/PATCH /api/v4/admin/config`, and match the `serverConfig.*` reads in `App.tsx` (Task 4). `useServerConfig` 4-tuple shape (`[config, updateConfig, fetchConfig, loaded]`) is identical between its definition (Task 3 Step 1) and its destructuring in `App.tsx` (Task 4 Step 2). `takeLegacyApiKey()` defined in Task 3 Step 2, imported and called in Task 4 Step 1/4 with matching name and zero-arg signature. `getConfig` imported and called identically in both Task 2 call sites, matching its export from Task 1's `runtimeConfig.ts` (already exported before this plan; Task 1 doesn't change its signature).
