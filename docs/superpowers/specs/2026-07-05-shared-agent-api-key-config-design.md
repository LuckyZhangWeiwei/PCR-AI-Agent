# Shared AI Agent API Key config — design

## Problem

Every AI Agent setting in the report's Settings tab already lives in server-side
shared config (`pcr-ai-api/runtime-config.json`, exposed via
`GET/PATCH /api/v4/admin/config`, consumed by the frontend's `useServerConfig`
hook). Any client that edits `agentModel`, `maxRounds`, `toolResultMaxChars`,
etc. changes it for every other client immediately — `getConfig()` re-reads
the file on every call, so there is no restart/reload step.

The one exception is the **API Key**: it is stored per-browser in
`localStorage` (`pcr-ai-report.agent.apikey.v1`, via `usePersistedApiKey`) and
sent as `agentConfig.apiKey` on every `POST /api/v4/agent/chat` call. One
client changing it has no effect on any other client.

Goal: fold `apiKey` into the same shared-config mechanism as every other
setting, so a change on one client takes effect for all clients with no
restart.

## Decisions (confirmed with user)

- `GET /api/v4/admin/config` returns the API key **unmasked**, exactly like
  every other field. The admin endpoints have no auth today (settings-page
  password is a UI gate only, not enforced server-side) and the user
  explicitly chose not to add masking or auth as part of this change — that
  tracks with the existing security posture of every other field on this
  endpoint.
- No auth is added to `/api/v4/admin/config`. Out of scope for this change.
- `pcr-ai-api/runtime-config.json` stays git-tracked as-is (private repo,
  user's explicit call). No `.gitignore` change.

## Backend changes

### `pcr-ai-api/src/lib/runtimeConfig.ts`

- Add `agentApiKey: string` to the `RuntimeConfig` interface.
- Add `agentApiKey: ""` to `RUNTIME_CONFIG_DEFAULTS`.
- In `getConfig()`, resolve in this order (mirrors the existing `agentApiBase`
  pattern exactly):
  1. `f.agentApiKey` (value from `runtime-config.json`, if a non-empty string)
  2. `process.env.AGENT_API_KEY`
  3. `process.env.SILICONFLOW_API_KEY`
  4. `""` (default)

### `pcr-ai-api/src/routes/admin.ts`

No code change. `GET`/`PATCH /config` already round-trip whatever fields exist
on `RuntimeConfig` — the new field appears automatically.

### `pcr-ai-api/src/routes/agent.ts` / `src/lib/agent/agentConfig.ts`

No code change. `resolveAgentConfig()` already prefers
`override.apiKey` (from the request body's `agentConfig`) over the
`AGENT_API_KEY`/`SILICONFLOW_API_KEY` env vars. Once the frontend sends
`serverConfig.agentApiKey` instead of a localStorage value, the existing
resolution chain behaves correctly with zero changes here.

## Frontend changes

### `pcr-ai-report/src/hooks/useServerConfig.ts`

- Add `agentApiKey: string` to `ServerConfig`, default `""` in
  `SERVER_CONFIG_DEFAULTS`.
- Add a `loaded: boolean` value to the hook's return tuple (becomes
  `[config, updateConfig, fetchConfig, loaded]`), set to `true` once the
  first `fetchConfig()` attempt (success or failure) has completed. Needed so
  the one-time migration (below) doesn't fire before the real server value has
  been read.

### `pcr-ai-report/src/hooks/usePersistedAgentConfig.ts`

- Remove the `usePersistedApiKey` hook — API key is no longer stored in
  localStorage going forward.
- Add a one-shot helper:

  ```ts
  const LEGACY_API_KEY_STORAGE_KEY = "pcr-ai-report.agent.apikey.v1";

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

- Keep the `AgentConfig` interface (still the shape sent to
  `POST /agent/chat`).

### `pcr-ai-report/src/App.tsx`

- Destructure `loaded` from `useServerConfig`.
- Add `agentApiKeyInput` local buffer state (mirrors `agentApiBaseInput` /
  `agentModelInput`): synced from `serverConfig.agentApiKey` via `useEffect`,
  committed to server via `onBlur={() => updateServerConfig({ agentApiKey: agentApiKeyInput.trim() })}`.
- `agentConfig.apiKey` (passed to `<AiAgentReport>`) becomes
  `serverConfig.agentApiKey` instead of the old local `apiKey` state.
- The existing 👁/🙈 show-hide toggle keeps working unchanged — it just
  toggles the input's `type`, independent of where the value is sourced from.
- One-time migration effect, gated by a `useRef` so it runs at most once per
  mount:

  ```ts
  const migratedApiKeyRef = useRef(false);
  useEffect(() => {
    if (!loaded || migratedApiKeyRef.current) return;
    migratedApiKeyRef.current = true;
    if (!serverConfig.agentApiKey) {
      const legacy = takeLegacyApiKey();
      if (legacy) updateServerConfig({ agentApiKey: legacy });
    }
  }, [loaded, serverConfig.agentApiKey, updateServerConfig]);
  ```

  This only fires once server config is confirmed loaded and confirmed empty,
  so it can never stomp a real value that just hasn't finished loading yet,
  and it never re-migrates after a user deliberately clears the key.

## Testing

### New: `pcr-ai-api/test/runtimeConfig.test.ts`

`runtimeConfig.ts` reads/writes `pcr-ai-api/runtime-config.json` by
default — a git-tracked file with real settings. Rather than
backing up/restoring that file around the test, `runtimeConfig.ts` gains
a `RUNTIME_CONFIG_PATH` env override (read once at module load time) so
the test can point it at an isolated temp file instead. This also sidesteps
a real hazard introduced by the JB-flags addendum below: once `agentLoop.ts`
/ `jbRouteResolver.ts` read `getConfig()` too, those tests run concurrently
with this one (Node's test runner runs test files in parallel), so any
approach that touches the real shared file risks cross-file races. The test
sets `process.env.RUNTIME_CONFIG_PATH` to an `os.tmpdir()` path before
dynamically importing `runtimeConfig.ts` (static imports are hoisted above
the assignment in ESM, so this needs the same "dynamic import after env
manipulation" pattern `test/agentConfig.test.ts` already uses).

Cases:
- `patchConfig({ agentApiKey: "sk-test" })` then `getConfig().agentApiKey === "sk-test"`.
- With no file value and no env vars set, `getConfig().agentApiKey === ""`.
- With `AGENT_API_KEY` env set and no file value, `getConfig().agentApiKey` reads the env value.
- File value takes precedence over env vars when both are present.

### Manual verification (no automated frontend test for this change)

1. `npm run dev` in both packages.
2. Open Settings in browser A, confirm API Key field is empty (or shows an
   existing localStorage value that gets migrated up).
3. Set an API Key in browser A, blur the field.
4. Open Settings in browser B (fresh profile / incognito), confirm the same
   key appears without any reload of the API process.
5. Send a chat message from browser B and confirm the agent call succeeds
   using the shared key.
6. Clear the key from browser A, confirm browser B sees it cleared (after
   `probe()`/settings reload triggers `fetchConfig`, or a fresh page load).

## Non-goals

- No masking of the API key in `GET /admin/config`.
- No auth added to `/api/v4/admin/config`.
- No change to `.gitignore` / git tracking of `runtime-config.json`.
- No change to how `apiBase`(报表自身服务器地址, `usePersistedApiBase`) is
  stored — that one must stay per-client since it's how each browser finds
  the API in the first place.

## Addendum (added mid-plan, before any task was dispatched): JB dark-launch flags

While reviewing the design, the user pointed out two more settings that
today require an `.env` edit + process restart to change:
`JB_DETERMINISTIC_DISPATCH` and `JB_LLM_INTENT_CLASSIFIER` (both read via
`process.env.X` inline, at call time, in `agentLoop.ts` /
`jbRouteResolver.ts` — never hoisted to module scope, so they resolve the
same way `AGENT_API_KEY` etc. already do). Two related flags,
`YIELD_MONITOR_TRIGGERS_DUMMY` / `INFCONTROL_LAYER_BINS_DUMMY`, were
considered and explicitly rejected for this change: `listDummyRuntime.ts`
forces Dummy off in `dist`/production regardless of these env vars, so
adding them to shared runtime config would have no effect where it matters
and would only add confusing controls for local dev (where an `.env` edit
is already cheap).

**Decisions (confirmed with user):**
- Only `JB_DETERMINISTIC_DISPATCH` and `JB_LLM_INTENT_CLASSIFIER` are added.
- Both get visible toggle switches on the Settings page (not just a
  backend-only field reachable via PATCH) — same `toggle-switch` pattern
  already used for `agentEnabled`.

### Backend: `pcr-ai-api/src/lib/runtimeConfig.ts`

Add two more booleans, resolved the same way `agentEnabled` already is
(file value, else env var truthy-string check, else default `false`):

- `jbDeterministicDispatch: boolean` — file → `process.env.JB_DETERMINISTIC_DISPATCH === "true"` → `false`.
- `jbLlmIntentClassifier: boolean` — file → `process.env.JB_LLM_INTENT_CLASSIFIER === "true"` → `false`.

### Backend: call sites read from shared config instead of `process.env` directly

- `pcr-ai-api/src/lib/agent/agentLoop.ts:2015` — `tryRunSemanticDispatchDirectRoute` currently does
  `if (process.env.JB_DETERMINISTIC_DISPATCH !== "true") return false;`. Change to read
  `getConfig().jbDeterministicDispatch` (import `getConfig` from `../runtimeConfig.js`) and
  `if (!getConfig().jbDeterministicDispatch) return false;` — this is what makes the flag
  toggle live without a restart; leaving the `process.env` read in place would keep requiring one.
- `pcr-ai-api/src/lib/agent/jbRouteResolver.ts:82` — `classifyJbIntent` currently does
  `if (process.env.JB_LLM_INTENT_CLASSIFIER !== "true") return base;`. Change to
  `if (!getConfig().jbLlmIntentClassifier) return base;` (same import).

### Frontend

- `useServerConfig.ts`: add `jbDeterministicDispatch: boolean` and
  `jbLlmIntentClassifier: boolean` to `ServerConfig`, default `false` in
  `SERVER_CONFIG_DEFAULTS`.
- `App.tsx`: add two more `setting-toggle-row` blocks in the AI Agent
  settings section (same markup pattern as the existing `agentEnabled`
  toggle), each calling `updateServerConfig({ jbDeterministicDispatch: next })`
  / `updateServerConfig({ jbLlmIntentClassifier: next })` directly on
  change (booleans need no local input-buffer/blur pattern, same as
  `agentEnabled`). Label copy makes clear these are internal routing
  behavior switches, not everyday settings.

### Testing

`runtimeConfig.test.ts` (Task 1) gains two more cases per flag (file value,
env fallback, default) alongside the `agentApiKey` cases — same
`RUNTIME_CONFIG_PATH`-isolated test file, no new test file needed.
