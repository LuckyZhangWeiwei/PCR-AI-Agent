# AI Agent 适配 MiniMax-M2.5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the AI Agent actually use either `DeepSeek-V4-Flash` or `MiniMax-M2.5` (both currently locked to DeepSeek by a hardcoded override), matched by model family rather than exact provider string so switching from SiliconFlow to another OpenAI-compatible provider (e.g. Qiniu Cloud) with the same two models keeps working; and give MiniMax-M2.5 the same large-context tuning GLM models get, since its 192K window is close enough to be worth it.

**Architecture:** All logic lives in one backend file, `pcr-ai-api/src/lib/agent/agentConfig.ts`. Add three pure string-matching helpers (`isDeepSeekV4Flash`, `isMiniMaxM25`, `isAllowedAgentModel`) that normalize a model-id string (lowercase, strip non-alphanumerics) and check for a family substring. Replace the hardcoded `model = ALLOWED_AGENT_MODEL` assignment in `resolveAgentConfig()` with a resolver that tries `override.model` → `env AGENT_MODEL` → default, validating each against `isAllowedAgentModel`. Extend `detectLargeContext()` with the same `isMiniMaxM25` check. Everything else (apiBase handling, the MiniMax embedded-tool-call parser in `agentLoop.ts`) is already provider-agnostic and untouched.

**Tech Stack:** TypeScript, Node's built-in `node:test` + `node:assert/strict` test runner (no Jest/Vitest in this repo), Express backend (`pcr-ai-api`), React/Vite frontend (`pcr-ai-report`, no test framework — verify via `tsc -b`/`npm run build`).

## Global Constraints

- Model family matching must be by normalized substring, NOT exact string equality — must tolerate a different vendor/org prefix for the same underlying model (spec: provider may change from SiliconFlow to Qiniu Cloud or others).
- Do not hardcode any specific non-SiliconFlow model ID string — the exact Qiniu Cloud IDs are unknown and not needed by the matching approach.
- Do not touch the MiniMax embedded-tool-call parsing already in `pcr-ai-api/src/lib/agent/agentLoop.ts` (`parseMinimaxInvokeBody`, `tryExtractFromMinimaxBuf`, the `"minimax"` tokenKind branch in `createDeepSeekFilter`) — it already works, only needs the model to actually be selectable.
- Keep `deepseek-ai/DeepSeek-V4-Flash` as the default when no model is specified or an unrecognized model is supplied (existing test `resolveAgentConfig({model:"my-model"})` must keep falling back to it).
- Every code change in `pcr-ai-api` must keep `npm test` and `npm run typecheck` green.
- Every code change in `pcr-ai-report` must keep `npm run build` (`tsc -b && vite build`) green.
- Follow this repo's doc convention: significant backend changes get a dated entry in `pcr-ai-api/CLAUDE.md` §11 and `docs/DEV_LOG.md` (newest entry at the top, `---` separator, `**完成内容：**` / `**测试：**` bullet format).

---

### Task 1: Model family matching + large-context detection in `agentConfig.ts`

**Files:**
- Modify: `pcr-ai-api/src/lib/agent/agentConfig.ts:24-31` (constants block), `:120-137` (`detectLargeContext`), `:166-212` (`resolveAgentConfig`)
- Test: `pcr-ai-api/test/agentConfig.test.ts`

**Interfaces:**
- Produces: `export function isDeepSeekV4Flash(model: string): boolean`, `export function isMiniMaxM25(model: string): boolean`, `export function isAllowedAgentModel(model: string): boolean` — importable from `../src/lib/agent/agentConfig.js` for later tasks/tests.
- Produces: `resolveAgentConfig(override?: Partial<AgentConfig>).model` / `.subAgentModel` now resolve to whichever allowed model was actually requested (previously always forced to `deepseek-ai/DeepSeek-V4-Flash`).
- Produces: `detectLargeContext(model: string, apiBase: string): boolean` now also returns `true` for any MiniMax-M2.5-family model name, independent of `apiBase`.
- Consumes: nothing new — `AgentConfig` interface, `sanitizeApiBase`, `clampMaxRounds` etc. are unchanged.

- [ ] **Step 1: Write the failing tests**

Add these tests to the end of `pcr-ai-api/test/agentConfig.test.ts`, right before the final closing `});` of the `describe("resolveAgentConfig", ...)` block (i.e. as new `it(...)` blocks inside that same `describe`):

```ts
  it("accepts MiniMax-M2.5 as model via override (SiliconFlow ID)", async () => {
    const { resolveAgentConfig } = await import(
      "../src/lib/agent/agentConfig.js"
    );
    const cfg = resolveAgentConfig({ model: "Pro/MiniMaxAI/MiniMax-M2.5" });
    assert.equal(cfg.model, "Pro/MiniMaxAI/MiniMax-M2.5");
  });

  it("accepts a differently-prefixed MiniMax-M2.5 ID (simulating another provider)", async () => {
    const { resolveAgentConfig } = await import(
      "../src/lib/agent/agentConfig.js"
    );
    const cfg = resolveAgentConfig({ model: "MiniMaxAI/MiniMax-M2.5" });
    assert.equal(cfg.model, "MiniMaxAI/MiniMax-M2.5");
  });

  it("validates model and subAgentModel independently", async () => {
    const { resolveAgentConfig } = await import(
      "../src/lib/agent/agentConfig.js"
    );
    const cfg = resolveAgentConfig({
      model: "Pro/MiniMaxAI/MiniMax-M2.5",
      subAgentModel: "not-a-real-model",
    });
    assert.equal(cfg.model, "Pro/MiniMaxAI/MiniMax-M2.5");
    assert.equal(cfg.subAgentModel, "deepseek-ai/DeepSeek-V4-Flash");
  });

  it("still falls back to DeepSeek-V4-Flash for an unrecognized model", async () => {
    const { resolveAgentConfig } = await import(
      "../src/lib/agent/agentConfig.js"
    );
    const cfg = resolveAgentConfig({ model: "my-model" });
    assert.equal(cfg.model, "deepseek-ai/DeepSeek-V4-Flash");
  });

  it("reads AGENT_MODEL from env when override omitted", async () => {
    const saved = process.env.AGENT_MODEL;
    process.env.AGENT_MODEL = "Pro/MiniMaxAI/MiniMax-M2.5";
    try {
      const { resolveAgentConfig } = await import(
        "../src/lib/agent/agentConfig.js"
      );
      assert.equal(resolveAgentConfig({}).model, "Pro/MiniMaxAI/MiniMax-M2.5");
    } finally {
      if (saved !== undefined) process.env.AGENT_MODEL = saved;
      else delete process.env.AGENT_MODEL;
    }
  });
```

Also add a new top-level `describe` block in the same file, after the closing `});` of `describe("resolveAgentConfig", ...)`:

```ts
describe("isAllowedAgentModel / detectLargeContext (MiniMax-M2.5)", () => {
  it("isDeepSeekV4Flash matches regardless of vendor prefix/case", async () => {
    const { isDeepSeekV4Flash } = await import(
      "../src/lib/agent/agentConfig.js"
    );
    assert.equal(isDeepSeekV4Flash("deepseek-ai/DeepSeek-V4-Flash"), true);
    assert.equal(isDeepSeekV4Flash("DEEPSEEK-AI/deepseek-v4-flash"), true);
    assert.equal(isDeepSeekV4Flash("Pro/MiniMaxAI/MiniMax-M2.5"), false);
  });

  it("isMiniMaxM25 matches regardless of vendor prefix/case", async () => {
    const { isMiniMaxM25 } = await import("../src/lib/agent/agentConfig.js");
    assert.equal(isMiniMaxM25("Pro/MiniMaxAI/MiniMax-M2.5"), true);
    assert.equal(isMiniMaxM25("MiniMaxAI/MiniMax-M2.5"), true);
    assert.equal(isMiniMaxM25("minimax/minimax-m2.5"), true);
    assert.equal(isMiniMaxM25("deepseek-ai/DeepSeek-V4-Flash"), false);
  });

  it("detectLargeContext returns true for MiniMax-M2.5 regardless of apiBase", async () => {
    const { detectLargeContext } = await import(
      "../src/lib/agent/agentConfig.js"
    );
    assert.equal(
      detectLargeContext(
        "Pro/MiniMaxAI/MiniMax-M2.5",
        "https://api.siliconflow.cn/v1"
      ),
      true
    );
    assert.equal(
      detectLargeContext("MiniMaxAI/MiniMax-M2.5", "https://example-qiniu.com/v1"),
      true
    );
  });

  it("detectLargeContext still returns false for DeepSeek-V4-Flash on a normal apiBase", async () => {
    const { detectLargeContext } = await import(
      "../src/lib/agent/agentConfig.js"
    );
    assert.equal(
      detectLargeContext(
        "deepseek-ai/DeepSeek-V4-Flash",
        "https://api.siliconflow.cn/v1"
      ),
      false
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd pcr-ai-api && npx tsx --test test/agentConfig.test.ts`
Expected: FAIL — `isDeepSeekV4Flash`/`isMiniMaxM25` are not exported yet, and the MiniMax override/env tests fail because `model` is still forced to `deepseek-ai/DeepSeek-V4-Flash`.

- [ ] **Step 3: Implement the model-family helpers and rewrite model resolution**

Replace lines 24-31 of `pcr-ai-api/src/lib/agent/agentConfig.ts`:

```ts
const DEFAULT_API_BASE = "https://api.siliconflow.cn/v1";
const DEFAULT_MODEL = "deepseek-ai/DeepSeek-V4-Flash";
const DEFAULT_SUB_MODEL = "deepseek-ai/DeepSeek-V4-Flash";
/** 生产环境唯一允许的 Agent 主/子模型。 */
export const ALLOWED_AGENT_MODEL = DEFAULT_MODEL;
export const DEFAULT_MAX_ROUNDS = 8;
const MIN_MAX_ROUNDS = 1;
const MAX_MAX_ROUNDS = 20;
```

with:

```ts
const DEFAULT_API_BASE = "https://api.siliconflow.cn/v1";
const DEFAULT_MODEL = "deepseek-ai/DeepSeek-V4-Flash";
const DEFAULT_SUB_MODEL = "deepseek-ai/DeepSeek-V4-Flash";

/**
 * 允许的 Agent 主/子模型固定为两个模型族：DeepSeek-V4-Flash、MiniMax-M2.5。
 * 供应商（apiBase）可自由更换（硅基流动 / 七牛云等），不同供应商上同一模型的
 * ID 前缀/组织名可能不同，因此按"模型族"做归一化子串匹配，而非要求完整 ID
 * 字符串与某个供应商精确一致。
 */
function normalizeModelId(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function isDeepSeekV4Flash(model: string): boolean {
  return normalizeModelId(model).includes("deepseekv4flash");
}

export function isMiniMaxM25(model: string): boolean {
  return normalizeModelId(model).includes("minimaxm25");
}

export function isAllowedAgentModel(model: string): boolean {
  return isDeepSeekV4Flash(model) || isMiniMaxM25(model);
}

export const DEFAULT_MAX_ROUNDS = 8;
const MIN_MAX_ROUNDS = 1;
const MAX_MAX_ROUNDS = 20;
```

Then replace the `detectLargeContext` doc comment and body (originally lines 120-137):

```ts
/**
 * Returns true for models with ≥200K context window that support longer histories
 * and larger tool-result storage without triggering context overflow.
 *
 * Detection rules (either condition is sufficient):
 *  • apiBase is Zhipu AI BigModel (open.bigmodel.cn) — all models are ≥200K
 *  • Model name contains glm-4.7, glm-4.6, glm-5, glm-z1 (large-context GLM series)
 */
export function detectLargeContext(model: string, apiBase: string): boolean {
  if (apiBase.includes("bigmodel.cn")) return true;
  const m = model.toLowerCase();
  return (
    m.includes("glm-4.7") ||
    m.includes("glm-4.6") ||
    m.includes("glm-5") ||
    m.includes("glm-z1")
  );
}
```

with:

```ts
/**
 * Returns true for models with a large enough context window (≥190K) that they
 * support longer histories and larger tool-result storage without triggering
 * context overflow.
 *
 * Detection rules (either condition is sufficient):
 *  • apiBase is Zhipu AI BigModel (open.bigmodel.cn) — all models are ≥200K
 *  • Model name matches the MiniMax-M2.5 family (192K; see isMiniMaxM25) —
 *    deliberately included despite being just under the 200K line, per
 *    docs/superpowers/specs/2026-07-11-agent-minimax-m2.5-adaptation-design.md
 *  • Model name contains glm-4.7, glm-4.6, glm-5, glm-z1 (large-context GLM series)
 */
export function detectLargeContext(model: string, apiBase: string): boolean {
  if (apiBase.includes("bigmodel.cn")) return true;
  if (isMiniMaxM25(model)) return true;
  const m = model.toLowerCase();
  return (
    m.includes("glm-4.7") ||
    m.includes("glm-4.6") ||
    m.includes("glm-5") ||
    m.includes("glm-z1")
  );
}
```

Finally, add a `resolveAllowedModel` helper right before the `resolveAgentConfig` function (i.e. immediately above the `// Reads process.env lazily...` comment that currently precedes `export function resolveAgentConfig`), and use it inside `resolveAgentConfig` to replace the hardcoded assignment.

Add this helper just above `// Reads process.env lazily at call time — do not hoist env reads to module scope.`:

```ts
function resolveAllowedModel(
  overrideValue: string | undefined,
  envValue: string | undefined,
  fallback: string
): string {
  const fromOverride = overrideValue?.trim();
  if (fromOverride && isAllowedAgentModel(fromOverride)) return fromOverride;
  const fromEnv = envValue?.trim();
  if (fromEnv && isAllowedAgentModel(fromEnv)) return fromEnv;
  return fallback;
}
```

Then inside `resolveAgentConfig`, replace:

```ts
  const model =
    ALLOWED_AGENT_MODEL;
  const subAgentModel =
    ALLOWED_AGENT_MODEL;
```

with:

```ts
  const model = resolveAllowedModel(
    override?.model,
    process.env.AGENT_MODEL,
    DEFAULT_MODEL
  );
  const subAgentModel = resolveAllowedModel(
    override?.subAgentModel,
    process.env.AGENT_SUB_MODEL,
    DEFAULT_SUB_MODEL
  );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd pcr-ai-api && npx tsx --test test/agentConfig.test.ts`
Expected: PASS — all existing tests plus the new ones added in Step 1.

- [ ] **Step 5: Run the full backend test suite and typecheck to confirm no regressions**

Run: `cd pcr-ai-api && npm test`
Expected: PASS, 0 failures (same pass/skip count as before this task plus the new tests added here). Pay particular attention to `test/agentLoop.test.ts` — it already has MiniMax embedded-tool-call parsing tests that must remain green (this task does not touch `agentLoop.ts`, so they should be unaffected).

Run: `cd pcr-ai-api && npm run typecheck`
Expected: PASS, 0 type errors.

- [ ] **Step 6: Commit**

```bash
git add pcr-ai-api/src/lib/agent/agentConfig.ts pcr-ai-api/test/agentConfig.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): allow DeepSeek-V4-Flash and MiniMax-M2.5 via model-family matching

resolveAgentConfig() previously forced model/subAgentModel to a single
hardcoded value regardless of what was requested. Now validates against
two allowed model families (matched by normalized substring, not exact
provider ID) so MiniMax-M2.5 actually works, and stays provider-agnostic
if the backing API moves off SiliconFlow. detectLargeContext() now also
applies large-context tuning to MiniMax-M2.5 (192K).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Update `.env.example` model documentation

**Files:**
- Modify: `pcr-ai-api/.env.example:87-90`

**Interfaces:**
- Consumes: nothing (pure comment/documentation change, no code).
- Produces: nothing consumed by later tasks — purely for operators reading the file.

- [ ] **Step 1: Edit the comment block**

Replace these lines in `pcr-ai-api/.env.example` (currently lines 87-90):

```
# AGENT_API_BASE=https://api.siliconflow.cn/v1
# AGENT_MODEL=deepseek-ai/DeepSeek-V4-Flash
# AGENT_SUB_MODEL=deepseek-ai/DeepSeek-V4-Flash
# 生产推荐 Flash（真库 handoff/Pass B-C 验证）；勿用 DeepSeek-V4-Pro 作默认（易 250s 超时、分类器抢路由）
```

with:

```
# AGENT_API_BASE=https://api.siliconflow.cn/v1
# AGENT_MODEL=deepseek-ai/DeepSeek-V4-Flash
# AGENT_SUB_MODEL=deepseek-ai/DeepSeek-V4-Flash
# 生产推荐 Flash（真库 handoff/Pass B-C 验证）；勿用 DeepSeek-V4-Pro 作默认（易 250s 超时、分类器抢路由）
#
# 仅允许两个模型族（agentConfig.ts 的 isAllowedAgentModel，按归一化子串模糊匹配，
# 不要求与某个供应商的完整 ID 字符串精确一致）：
#   1) DeepSeek-V4-Flash — 如 deepseek-ai/DeepSeek-V4-Flash
#   2) MiniMax-M2.5      — 如 Pro/MiniMaxAI/MiniMax-M2.5（硅基流动）
# 供应商（AGENT_API_BASE）可换成其它 OpenAI 兼容平台（如七牛云）而无需改代码，
# 只要 AGENT_MODEL 的字符串里仍包含 "DeepSeek-V4-Flash" 或 "MiniMax-M2.5"
# （大小写、分隔符不敏感）。填其它不认识的模型名会静默回退到 DeepSeek-V4-Flash。
```

- [ ] **Step 2: Verify no drift from actual behavior**

Run: `cd pcr-ai-api && rg -n "isAllowedAgentModel|isMiniMaxM25|isDeepSeekV4Flash" src/lib/agent/agentConfig.ts`
Expected: shows the three functions from Task 1 — confirms the comment describes code that actually exists (Task 1 must be done first).

- [ ] **Step 3: Commit**

```bash
git add pcr-ai-api/.env.example
git commit -m "$(cat <<'EOF'
docs(agent): document the two allowed model families in .env.example

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Update frontend Settings model hint text

**Files:**
- Modify: `pcr-ai-report/src/App.tsx:369-397`

**Interfaces:**
- Consumes: nothing new (no prop/type changes — purely the static hint text under two existing `<input>` fields).
- Produces: nothing consumed elsewhere.

- [ ] **Step 1: Edit the hint text and placeholder**

Replace lines 369-383 of `pcr-ai-report/src/App.tsx`:

```tsx
              <label>
                <span>模型</span>
                <input
                  type="text"
                  value={agentModelInput}
                  onChange={(e) => setAgentModelInput(e.target.value)}
                  onBlur={(e) => updateServerConfig({ agentModel: e.target.value.trim() })}
                  spellCheck={false}
                  placeholder="deepseek-ai/DeepSeek-V3"
                />
              </label>
              <p className="field-hint">
                SiliconFlow 模型 ID，例如 <code>deepseek-ai/DeepSeek-V3</code>、
                <code>MiniMax/MiniMax-M1</code>。需支持 Function Calling。
              </p>
```

with:

```tsx
              <label>
                <span>模型</span>
                <input
                  type="text"
                  value={agentModelInput}
                  onChange={(e) => setAgentModelInput(e.target.value)}
                  onBlur={(e) => updateServerConfig({ agentModel: e.target.value.trim() })}
                  spellCheck={false}
                  placeholder="deepseek-ai/DeepSeek-V4-Flash"
                />
              </label>
              <p className="field-hint">
                仅支持两个模型族：<code>DeepSeek-V4-Flash</code>（如{" "}
                <code>deepseek-ai/DeepSeek-V4-Flash</code>）或{" "}
                <code>MiniMax-M2.5</code>（如{" "}
                <code>Pro/MiniMaxAI/MiniMax-M2.5</code>）。只要模型名里包含这两个
                名字之一即可生效（大小写、供应商前缀不敏感），可配合「API 地址」换成
                硅基流动以外的 OpenAI 兼容平台；填其它模型名会静默回退到
                DeepSeek-V4-Flash。
              </p>
```

- [ ] **Step 2: Verify the frontend still builds**

Run: `cd pcr-ai-report && npm run build`
Expected: PASS, 0 TypeScript errors, Vite build completes.

- [ ] **Step 3: Commit**

```bash
git add pcr-ai-report/src/App.tsx
git commit -m "$(cat <<'EOF'
docs(report): correct AI Agent model hint text to the two allowed families

The old hint listed deepseek-ai/DeepSeek-V3 and MiniMax/MiniMax-M1 as
examples, neither of which is in the actual backend whitelist. Updated
to describe the real allowed families and the fuzzy-match / provider
override behavior from agentConfig.ts.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Doc trail — `CLAUDE.md` §11 + `DEV_LOG.md`, final full verification

**Files:**
- Modify: `pcr-ai-api/CLAUDE.md` (append to the numbered list in §11, after item 23)
- Modify: `docs/DEV_LOG.md` (insert new entry at the very top, after the `# WaferMind 开发日志` / `---` header, before the existing `## 2026-07-05` entry)

**Interfaces:**
- Consumes: nothing (documentation only).
- Produces: nothing consumed by later tasks — this is the last task in the plan.

- [ ] **Step 1: Append to `pcr-ai-api/CLAUDE.md` §11**

At the end of the numbered list in section "## 11. 近期变更纪要（2026-05-16，交接备忘）" (immediately after item `23. **Agent device/NXP 数据脱敏（2026-07-05）**` and its bullet content, before the `---` that follows), add:

```markdown
24. **Agent 多模型白名单：MiniMax-M2.5（2026-07-11）**：
   - **`src/lib/agent/agentConfig.ts`**：`resolveAgentConfig()` 此前把 `model`/`subAgentModel` 硬编码为单一值（`ALLOWED_AGENT_MODEL`），忽略 `override.model` 与 `AGENT_MODEL`/`AGENT_SUB_MODEL` env。改为 **`isAllowedAgentModel`**（内部 **`isDeepSeekV4Flash`** / **`isMiniMaxM25`**）按归一化子串（去大小写、去分隔符）匹配"模型族"而非精确字符串，解析顺序 **`override.model` → `env AGENT_MODEL` → 默认 DeepSeek-V4-Flash**（`subAgentModel` 同理独立解析）。这样换供应商（硅基流动 → 七牛云等）时，即使模型 ID 前缀/组织名不同，只要模型名仍含 "DeepSeek-V4-Flash" 或 "MiniMax-M2.5" 即可生效，不需要为每个供应商单独硬编码 ID。
   - **`detectLargeContext()`**：新增 **`isMiniMaxM25`** 分支，MiniMax-M2.5（192K）与 GLM 大模型同档：`summarize` 阈值 80、`max_tokens` 16384、`toolResultMaxHistoryChars` 20000。
   - **不改动**：**`agentLoop.ts`** 里 2026-05-27/29 已实现的 MiniMax `<minimax:tool_call>` 嵌入式工具调用解析（`parseMinimaxInvokeBody`、`tryExtractFromMinimaxBuf` 等）——此前因模型被锁死在 DeepSeek 而从未实际运行，本次改动后才真正生效，代码本身未改。
   - **交接 spec**：[`../docs/superpowers/specs/2026-07-11-agent-minimax-m2.5-adaptation-design.md`](../docs/superpowers/specs/2026-07-11-agent-minimax-m2.5-adaptation-design.md)。回归 **`test/agentConfig.test.ts`**（新增 MiniMax / 跨供应商前缀 / env 覆盖用例）。
```

- [ ] **Step 2: Insert entry at the top of `docs/DEV_LOG.md`**

Immediately after line 3 (`---`) and before line 5 (`## 2026-07-05 — 灰色小字对比度 + 字号微调（全局可读性）`), insert:

```markdown
## 2026-07-11 — AI Agent 适配 MiniMax-M2.5（多模型白名单 + 大上下文档位）

**完成内容：**
- `pcr-ai-api/src/lib/agent/agentConfig.ts`：`resolveAgentConfig()` 的 `model`/`subAgentModel` 此前被硬编码强制为 `deepseek-ai/DeepSeek-V4-Flash`，忽略前端 Settings 与 env 传入的值。改为按模型族模糊匹配的白名单：新增 `isDeepSeekV4Flash` / `isMiniMaxM25` / `isAllowedAgentModel`（归一化后子串匹配，不要求与某个供应商的完整 ID 一致），解析顺序 `override.model → env AGENT_MODEL → 默认值`；`subAgentModel` 独立解析。目的是同时支持硅基流动与未来可能更换的供应商（如七牛云）上的同名模型，不需要为每个供应商硬编码 ID。
- `detectLargeContext()`：MiniMax-M2.5（192K 上下文）纳入大上下文档位（与 GLM 系列同档：summarize 阈值 80、max_tokens 16384、toolResultMaxHistoryChars 20000），目的是减少历史截断、提升长对话回答质量。
- `pcr-ai-api/.env.example`、`pcr-ai-report/src/App.tsx`：同步更新模型相关注释与 Settings 页「模型」输入框的提示文案，改为准确描述实际允许的两个模型族（此前的示例值 `deepseek-ai/DeepSeek-V3`、`MiniMax/MiniMax-M1` 均不在实际白名单内）。
- 未改动 `agentLoop.ts` 中已有的 MiniMax `<minimax:tool_call>` 嵌入式工具调用解析逻辑（2026-05-27/29 实现）——此前因模型被锁死从未真正运行，本次是让它第一次生效，代码本身无需改动。
- Spec：`docs/superpowers/specs/2026-07-11-agent-minimax-m2.5-adaptation-design.md`。

**测试：** `pcr-ai-api` `npm test` 全量通过（新增 agentConfig.test.ts 用例覆盖 MiniMax 直接生效、跨供应商前缀变体、env 覆盖、大上下文检测；`agentLoop.test.ts` 既有 MiniMax 解析用例保持绿）；`npm run typecheck` 通过；`pcr-ai-report` `npm run build` 通过。

---

```

- [ ] **Step 3: Final full verification across both packages**

Run: `cd pcr-ai-api && npm test`
Expected: PASS, 0 failures.

Run: `cd pcr-ai-api && npm run typecheck`
Expected: PASS, 0 errors.

Run: `cd pcr-ai-report && npm run build`
Expected: PASS, build completes with 0 TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add pcr-ai-api/CLAUDE.md docs/DEV_LOG.md
git commit -m "$(cat <<'EOF'
docs(agent): record MiniMax-M2.5 model-whitelist change in handoff docs

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review Notes

- **Spec coverage:** §1 (model whitelist/matching) → Task 1. §2 (large-context detection) → Task 1 (same file, tested together). §3 (.env.example) → Task 2. §4 (frontend hint) → Task 3. §5 (agentLoop.ts untouched) → explicitly called out as a Global Constraint and reiterated in Task 1/4 doc text, no code task needed. Tests → Task 1 Step 1. Docs → Task 4. All spec sections covered.
- **Placeholder scan:** no TBD/TODO; every step shows exact code/commands.
- **Type consistency:** `isDeepSeekV4Flash`, `isMiniMaxM25`, `isAllowedAgentModel`, `resolveAllowedModel`, `detectLargeContext`, `resolveAgentConfig` names and signatures are identical across Task 1's steps and the tests that consume them.
