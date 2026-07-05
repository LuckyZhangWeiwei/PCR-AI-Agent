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

Because `runtimeConfig.ts` reads/writes the real
`pcr-ai-api/runtime-config.json` (no path injection today, and it's a
git-tracked file with real settings), the test suite must not leave it
mutated:

```ts
before(() => { backup = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, "utf-8") : null; });
after(() => {
  if (backup !== null) writeFileSync(CONFIG_PATH, backup);
  else if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
});
```

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
