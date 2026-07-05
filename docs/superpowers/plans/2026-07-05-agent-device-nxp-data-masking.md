# Agent Device/NXP 数据脱敏 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 Settings 开关"是否数据脱敏"（默认关闭）；打开后，发送给第三方 LLM（SiliconFlow）的文本里，真实 device 产品代码和 "NXP" 会被替换为不可逆推的令牌；LLM 返回的流式文本与工具调用参数在到达我方工具执行逻辑 / 页面展示之前，自动还原为真实值。

**Architecture:** 全仓库对 SiliconFlow 的所有调用都唯一经过 `pcr-ai-api/src/lib/agent/agentStream.ts` 的 `streamSiliconFlow()`。脱敏（mask，出方向）和还原（unmask，入方向：流式文本 + 工具调用参数）完全封装在这一个文件里，`agentLoop.ts` 的数十条直连路由函数不需要任何改动。令牌方案是"一致性令牌替换"（同一真实值永远映射到同一令牌，基于 SHA-256 哈希，非真正加密），不是安全加密算法。

**Tech Stack:** Node.js + TypeScript（后端 `pcr-ai-api`），React 19 + TypeScript（前端 `pcr-ai-report`），`node:test` 测试。

## Global Constraints

- **Oracle/Dummy 双路径同步（硬规则）**：新增的全量 device distinct 查询必须同时实现 Oracle 路径（`YMWEB_YIELDMONITORTRIGGER` + `INFCONTROL` 两表 `DISTINCT DEVICE`）和 Dummy 路径（直接从 `getYieldMonitorTriggerDummyRows()` / `getInfcontrolLayerBinDummyRows()` 内存数组取 distinct），不能只实现一边。
- **禁止复用 `deviceMask` / `mask` 这个词** 作为本功能命名 —— `pcr-ai-api/src/lib/deviceMask.ts` 里的 `deviceMask`/`deviceBaseMask` 是 JB STAR 领域里"设备型号后缀"的既有概念，与本功能的"脱敏"完全无关。新模块命名为 `agentDataMasking.ts`。
- **默认关闭**：`dataMaskingEnabled` 默认 `false`，关闭时 `streamSiliconFlow` 零额外开销（不做字典构建、不做字符串扫描）。
- **只脱敏动态数据**：用户消息、历史消息、工具结果、系统提示词里动态插入的数据库快照片段（`agentPrompt.ts` 的 top device 列表）。系统提示词里固定的规则/说明文字不脱敏。
- **只脱敏 device 和 "NXP" 两类**，不动其它字段。
- **NXP 大小写不敏感**：`/nxp/gi` 匹配所有大小写变体，统一替换为固定占位符 `COMPANY_X`；还原时统一恢复为大写 `NXP`（不保留原始大小写变体）。
- **工具调用参数必须能直接查库**：LLM 返回的 `tool_calls` 参数中出现的令牌，必须在 `agentLoop.ts` 派发给 `runTool()` 执行数据库查询之前还原为真实值。
- **测试隔离**：任何读写 `runtime-config.json` 的测试必须使用 `RUNTIME_CONFIG_PATH` env override + 动态 `import()`（在设置该 env 之后）的既有约定，禁止操作 git 追踪的真实 `pcr-ai-api/runtime-config.json`。
- **`npm test` 下 `NODE_ENV=test` 时 `yieldMonitorTriggersUseDummy()` / `infcontrolLayerBinsUseDummy()` 恒为 `true`**（已有代码行为）——新的字典构建逻辑在测试中会自动走 Dummy 路径，不需要额外配置，也不会触发真实 Oracle 连接。

---

### Task 1: `runtimeConfig.ts` 新增 `dataMaskingEnabled` 字段

**Files:**
- Modify: `pcr-ai-api/src/lib/runtimeConfig.ts`
- Test: `pcr-ai-api/test/runtimeConfig.test.ts`

**Interfaces:**
- Produces: `RuntimeConfig.dataMaskingEnabled: boolean`（默认 `false`，读取顺序：文件值(boolean) → 默认值；无 env 兜底，纯新功能）；`getConfig()` 返回值包含该字段；`patchConfig({ dataMaskingEnabled: true })` 可持久化。

- [ ] **Step 1: 追加失败的测试**

在 `pcr-ai-api/test/runtimeConfig.test.ts` 的 `describe("runtimeConfig", () => { ... })` 块内、最后一个 `it(...)`（`jbLlmIntentClassifier defaults to false...`）之后，紧跟着追加：

```ts
  it("dataMaskingEnabled defaults to false and can be persisted", async () => {
    const { getConfig, patchConfig } = await import("../src/lib/runtimeConfig.js");
    assert.equal(getConfig().dataMaskingEnabled, false);
    const updated = patchConfig({ dataMaskingEnabled: true });
    assert.equal(updated.dataMaskingEnabled, true);
    assert.equal(getConfig().dataMaskingEnabled, true);
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd pcr-ai-api && npx tsx --test test/runtimeConfig.test.ts`
Expected: FAIL —— `getConfig().dataMaskingEnabled` 为 `undefined`，不等于 `false`（TypeScript 编译层面也会因 `RuntimeConfig` 尚无该字段而在 `patchConfig({ dataMaskingEnabled: true })` 处报类型错误，属预期的 RED 阶段）。

- [ ] **Step 3: 实现**

在 `pcr-ai-api/src/lib/runtimeConfig.ts` 里，`RuntimeConfig` 接口的 `jbLlmIntentClassifier: boolean;` 之后加一行：

```ts
  /** Agent 数据脱敏（device/NXP 令牌化）开关；见 agentDataMasking.ts / agentStream.ts。 */
  dataMaskingEnabled: boolean;
```

`RUNTIME_CONFIG_DEFAULTS` 里 `jbLlmIntentClassifier: false,` 之后加一行：

```ts
  dataMaskingEnabled: false,
```

`getConfig()` 函数体里 `jbLlmIntentClassifier: typeof f.jbLlmIntentClassifier === "boolean" ? f.jbLlmIntentClassifier : process.env.JB_LLM_INTENT_CLASSIFIER === "true",` 这行之后加：

```ts
    dataMaskingEnabled:
      typeof f.dataMaskingEnabled === "boolean"
        ? f.dataMaskingEnabled
        : D.dataMaskingEnabled,
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd pcr-ai-api && npx tsx --test test/runtimeConfig.test.ts`
Expected: PASS（全部用例，包括新增的一条）

- [ ] **Step 5: Commit**

```bash
git add pcr-ai-api/src/lib/runtimeConfig.ts pcr-ai-api/test/runtimeConfig.test.ts
git commit -m "feat(api): runtime config 新增 dataMaskingEnabled 开关"
```

---

### Task 2: `agentDataMasking.ts` — 字典构建 + mask/unmask + 流式还原器

**Files:**
- Create: `pcr-ai-api/src/lib/agent/agentDataMasking.ts`
- Test: `pcr-ai-api/test/agentDataMasking.test.ts`

**Interfaces:**
- Consumes: `withConnection`/`withProbeWebConnection`（`pcr-ai-api/src/oracle.ts`）；`oracleNonEmptyTrimmedColumn`（`../oracleStringSql.js`）；`yieldMonitorTriggersUseDummy`/`getYieldMonitorTriggerDummyRows`（`../yieldMonitorTriggerDummy.js`）；`infcontrolLayerBinsUseDummy`/`getInfcontrolLayerBinDummyRows`（`../infcontrolLayerBinDummy.js`）。
- Produces（Task 3 直接消费这些导出）：
  - `export interface MaskingDictionary { mask(text: string): string; unmask(text: string): string; }`
  - `export async function loadMaskingDictionary(): Promise<MaskingDictionary>` —— 懒加载 + 24 小时内存缓存；构建失败时返回一个"只替换 NXP、device 字典为空"的降级字典，不抛异常。
  - `export interface StreamUnmasker { push(delta: string): string; finalize(): string; }`
  - `export function createStreamUnmasker(dict: MaskingDictionary): StreamUnmasker` —— 带前瞻缓冲，避免令牌被流式分片截断。
  - `export function resetMaskingDictionaryCacheForTest(): void` —— 仅测试用，强制下次 `loadMaskingDictionary()` 重新构建。

- [ ] **Step 1: 写测试文件（先跑必然失败，因为模块还不存在）**

创建 `pcr-ai-api/test/agentDataMasking.test.ts`：

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  loadMaskingDictionary,
  createStreamUnmasker,
  resetMaskingDictionaryCacheForTest,
  type MaskingDictionary,
} from "../src/lib/agent/agentDataMasking.js";
import { getYieldMonitorTriggerDummyRows } from "../src/lib/yieldMonitorTriggerDummy.js";

describe("agentDataMasking", () => {
  it("masks a real device value to a DEV_ token and unmasks it back", async () => {
    resetMaskingDictionaryCacheForTest();
    const rows = getYieldMonitorTriggerDummyRows();
    const realDevice = String(rows[0]?.DEVICE ?? "").trim();
    assert.ok(realDevice.length > 0, "dummy rows must contain at least one DEVICE value");

    const dict = await loadMaskingDictionary();
    const text = `设备 ${realDevice} 良率偏低`;
    const masked = dict.mask(text);

    assert.ok(!masked.includes(realDevice), "masked text must not contain the real device value");
    assert.match(masked, /DEV_[0-9a-f]+/, "masked text must contain a DEV_ token");
    assert.equal(dict.unmask(masked), text, "unmask must restore the original text exactly");
  });

  it("maps the same real device value to the same token across a cache rebuild", async () => {
    resetMaskingDictionaryCacheForTest();
    const rows = getYieldMonitorTriggerDummyRows();
    const realDevice = String(rows[0]?.DEVICE ?? "").trim();

    const dictA = await loadMaskingDictionary();
    const maskedA = dictA.mask(realDevice);

    resetMaskingDictionaryCacheForTest();
    const dictB = await loadMaskingDictionary();
    const maskedB = dictB.mask(realDevice);

    assert.equal(maskedA, maskedB, "token for the same real device must be stable across rebuilds");
  });

  it("replaces NXP case-insensitively and restores it to canonical NXP", async () => {
    resetMaskingDictionaryCacheForTest();
    const dict = await loadMaskingDictionary();
    const text = "这是 NXP 的产品，Nxp 团队负责，nxp内部代号";
    const masked = dict.mask(text);

    assert.ok(!/nxp/i.test(masked), "masked text must not contain NXP in any case");
    assert.equal(
      dict.unmask(masked),
      "这是 NXP 的产品，NXP 团队负责，NXP内部代号",
      "unmask restores all NXP variants to canonical uppercase NXP"
    );
  });

  it("StreamUnmasker correctly restores a token split across streamed chunks", () => {
    const fakeDict: MaskingDictionary = {
      mask: (t: string) => t.replace(/FOO/g, "TOKEN_abcdefghij"),
      unmask: (t: string) => t.replace(/TOKEN_abcdefghij/g, "FOO"),
    };
    const unmasker = createStreamUnmasker(fakeDict);

    const padding = "x".repeat(50);
    const full = `${padding} before TOKEN_abcdefghij after ${padding}`;
    // Simulate network chunking: small pieces guarantee the 16-char token
    // straddles a chunk boundary at least once, and total length exceeds
    // any reasonable lookahead buffer so incremental flushing is exercised.
    const chunkSize = 7;
    let out = "";
    for (let i = 0; i < full.length; i += chunkSize) {
      out += unmasker.push(full.slice(i, i + chunkSize));
    }
    out += unmasker.finalize();

    assert.equal(out, `${padding} before FOO after ${padding}`);
    assert.ok(!out.includes("abcdefghij"), "no partial or full raw token fragment must leak");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd pcr-ai-api && npx tsx --test test/agentDataMasking.test.ts`
Expected: FAIL（找不到模块 `../src/lib/agent/agentDataMasking.js`）

- [ ] **Step 3: 实现模块**

创建 `pcr-ai-api/src/lib/agent/agentDataMasking.ts`：

```ts
// pcr-ai-api/src/lib/agent/agentDataMasking.ts
import { createHash } from "node:crypto";
import oracledb from "oracledb";
import { withConnection, withProbeWebConnection } from "../../oracle.js";
import { oracleNonEmptyTrimmedColumn } from "../oracleStringSql.js";
import {
  yieldMonitorTriggersUseDummy,
  getYieldMonitorTriggerDummyRows,
} from "../yieldMonitorTriggerDummy.js";
import {
  infcontrolLayerBinsUseDummy,
  getInfcontrolLayerBinDummyRows,
} from "../infcontrolLayerBinDummy.js";

const NXP_TOKEN = "COMPANY_X";
const NXP_RE = /nxp/gi;
const DEVICE_TOKEN_PREFIX = "DEV_";
const DICTIONARY_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_HASH_HEX_LEN = 64; // full SHA-256 hex length — collision-safe upper bound
const INITIAL_HASH_HEX_LEN = 10;
// Max possible token length (DEV_ + 64 hex) with generous safety margin, so the
// streaming lookahead buffer can never flush a partially-received token.
const UNMASK_LOOKAHEAD = DEVICE_TOKEN_PREFIX.length + MAX_HASH_HEX_LEN + 16;

export interface MaskingDictionary {
  /** Replace real device values / NXP with tokens in outbound text. */
  mask(text: string): string;
  /** Replace tokens back to real device values / NXP in inbound text (whole string, no streaming). */
  unmask(text: string): string;
}

interface DictionaryState {
  builtAt: number;
  realToToken: Map<string, string>;
  tokenToReal: Map<string, string>;
  matchRegex: RegExp | null; // matches any known real device value (longest-first)
  tokenRegex: RegExp | null; // matches any known device token (longest-first)
}

let cached: DictionaryState | undefined;
let buildingPromise: Promise<DictionaryState> | undefined;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hashToken(real: string, hexLen: number): string {
  const hex = createHash("sha256")
    .update(real)
    .digest("hex")
    .slice(0, Math.min(hexLen, MAX_HASH_HEX_LEN));
  return `${DEVICE_TOKEN_PREFIX}${hex}`;
}

/** Assign a stable token per real value; on hash collision, lengthen the hex
 * suffix for the colliding value until unique (capped at the full SHA-256 hex
 * length — a collision at that length is cryptographically infeasible). */
function assignTokens(realValues: string[]): {
  realToToken: Map<string, string>;
  tokenToReal: Map<string, string>;
} {
  const realToToken = new Map<string, string>();
  const tokenToReal = new Map<string, string>();
  for (const real of realValues) {
    let len = INITIAL_HASH_HEX_LEN;
    let token = hashToken(real, len);
    while (tokenToReal.has(token) && tokenToReal.get(token) !== real) {
      if (len >= MAX_HASH_HEX_LEN) break;
      len += 2;
      token = hashToken(real, len);
    }
    realToToken.set(real, token);
    tokenToReal.set(token, real);
  }
  return { realToToken, tokenToReal };
}

function buildAlternationRegex(values: string[]): RegExp | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => b.length - a.length);
  return new RegExp(sorted.map(escapeRegExp).join("|"), "g");
}

async function fetchDistinctDevicesOracle(): Promise<string[]> {
  const yieldSql = `SELECT DISTINCT DEVICE AS DEV FROM YMWEB_YIELDMONITORTRIGGER WHERE ${oracleNonEmptyTrimmedColumn("DEVICE")}`;
  const jbSql = `SELECT DISTINCT DEVICE AS DEV FROM INFCONTROL WHERE ${oracleNonEmptyTrimmedColumn("DEVICE")}`;
  const [yieldRows, jbRows] = await Promise.all([
    withProbeWebConnection(async (conn) => {
      const r = await conn.execute(yieldSql, {}, { outFormat: oracledb.OUT_FORMAT_OBJECT });
      return (r.rows ?? []) as Record<string, unknown>[];
    }),
    withConnection(async (conn) => {
      const r = await conn.execute(jbSql, {}, { outFormat: oracledb.OUT_FORMAT_OBJECT });
      return (r.rows ?? []) as Record<string, unknown>[];
    }),
  ]);
  const set = new Set<string>();
  for (const row of [...yieldRows, ...jbRows]) {
    const v = String(row["DEV"] ?? "").trim();
    if (v) set.add(v);
  }
  return [...set];
}

function fetchDistinctDevicesDummy(): string[] {
  const set = new Set<string>();
  for (const row of getYieldMonitorTriggerDummyRows()) {
    const v = String(row.DEVICE ?? "").trim();
    if (v) set.add(v);
  }
  for (const row of getInfcontrolLayerBinDummyRows()) {
    const v = String(row.DEVICE ?? "").trim();
    if (v) set.add(v);
  }
  return [...set];
}

async function buildDictionary(): Promise<DictionaryState> {
  let realValues: string[];
  try {
    realValues =
      yieldMonitorTriggersUseDummy() || infcontrolLayerBinsUseDummy()
        ? fetchDistinctDevicesDummy()
        : await fetchDistinctDevicesOracle();
  } catch (err) {
    console.error("[agentDataMasking] failed to build device dictionary:", err);
    realValues = [];
  }
  const { realToToken, tokenToReal } = assignTokens(realValues);
  return {
    builtAt: Date.now(),
    realToToken,
    tokenToReal,
    matchRegex: buildAlternationRegex(realValues),
    tokenRegex: buildAlternationRegex([...tokenToReal.keys()]),
  };
}

async function getDictionaryState(): Promise<DictionaryState> {
  if (cached && Date.now() - cached.builtAt < DICTIONARY_TTL_MS) return cached;
  if (buildingPromise) return buildingPromise;
  buildingPromise = buildDictionary().then((d) => {
    cached = d;
    buildingPromise = undefined;
    return d;
  });
  return buildingPromise;
}

/** Test-only: force the next loadMaskingDictionary() call to rebuild. */
export function resetMaskingDictionaryCacheForTest(): void {
  cached = undefined;
  buildingPromise = undefined;
}

function maskWithState(text: string, dict: DictionaryState): string {
  let out = text;
  if (dict.matchRegex) {
    out = out.replace(dict.matchRegex, (m) => dict.realToToken.get(m) ?? m);
  }
  out = out.replace(NXP_RE, NXP_TOKEN);
  return out;
}

function unmaskWithState(text: string, dict: DictionaryState): string {
  let out = text;
  if (dict.tokenRegex) {
    out = out.replace(dict.tokenRegex, (m) => dict.tokenToReal.get(m) ?? m);
  }
  return out.split(NXP_TOKEN).join("NXP");
}

export async function loadMaskingDictionary(): Promise<MaskingDictionary> {
  const dict = await getDictionaryState();
  return {
    mask: (text: string) => maskWithState(text, dict),
    unmask: (text: string) => unmaskWithState(text, dict),
  };
}

export interface StreamUnmasker {
  /** Feed a raw text delta; returns the portion that is now safe to emit (already unmasked). */
  push(delta: string): string;
  /** Call once after the stream ends — flushes any buffered remainder (unmasked). */
  finalize(): string;
}

export function createStreamUnmasker(dict: MaskingDictionary): StreamUnmasker {
  let pending = "";
  return {
    push(delta: string): string {
      pending += delta;
      const safeLen = Math.max(0, pending.length - UNMASK_LOOKAHEAD);
      if (safeLen === 0) return "";
      const safe = pending.slice(0, safeLen);
      pending = pending.slice(safeLen);
      return dict.unmask(safe);
    },
    finalize(): string {
      const rest = pending;
      pending = "";
      return dict.unmask(rest);
    },
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd pcr-ai-api && npx tsx --test test/agentDataMasking.test.ts`
Expected: PASS（全部 4 条用例）

- [ ] **Step 5: Commit**

```bash
git add pcr-ai-api/src/lib/agent/agentDataMasking.ts pcr-ai-api/test/agentDataMasking.test.ts
git commit -m "feat(api): 新增 agentDataMasking — device/NXP 令牌化字典与流式还原器"
```

---

### Task 3: 接入 `agentStream.ts`（唯一的 mask/unmask 拦截点）

**Files:**
- Modify: `pcr-ai-api/src/lib/agent/agentStream.ts`
- Test: `pcr-ai-api/test/agentStreamMasking.test.ts`（新建，独立于既有 `agentStream.test.ts`，因为需要 `RUNTIME_CONFIG_PATH` 隔离）

**Interfaces:**
- Consumes: Task 1 的 `getConfig().dataMaskingEnabled`；Task 2 的 `loadMaskingDictionary()` / `createStreamUnmasker()` / `MaskingDictionary`。
- Produces: `streamSiliconFlow()` 签名不变（仍是 `(request, config, onChunk) => Promise<void>`，只是内部实现从"同步函数体 + 立即 `new Promise`"变为 `async function`），对所有既有调用方（`agentLoop.ts` 的主循环、`summarizeHistory`、`emitDeterministicJbTablesReply`）透明。新增导出 `maskRequestMessages(messages, dict)`（供本文件内部使用，同时导出以便未来测试直接单测）。

- [ ] **Step 1: 写新测试文件（先跑必然失败——此时 agentStream.ts 还没有脱敏逻辑，NXP 会原样出现在请求体里）**

创建 `pcr-ai-api/test/agentStreamMasking.test.ts`：

```ts
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import https from "node:https";
import test from "node:test";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// RUNTIME_CONFIG_PATH is read once at module load time inside runtimeConfig.ts
// (transitively imported by agentStream.ts), so it must point at a file that
// already contains dataMaskingEnabled:true BEFORE the first (dynamic) import
// of agentStream.js in this test file's process. This keeps the test off the
// real, git-tracked pcr-ai-api/runtime-config.json entirely, matching the
// convention established in test/runtimeConfig.test.ts.
const TEST_CONFIG_PATH = join(
  tmpdir(),
  `pcr-ai-agent-stream-masking-test-${process.pid}-${Date.now()}.json`
);
process.env.RUNTIME_CONFIG_PATH = TEST_CONFIG_PATH;
writeFileSync(TEST_CONFIG_PATH, JSON.stringify({ dataMaskingEnabled: true }), "utf-8");

test.after(() => {
  delete process.env.RUNTIME_CONFIG_PATH;
  if (existsSync(TEST_CONFIG_PATH)) unlinkSync(TEST_CONFIG_PATH);
});

function mockStreamedResponse(sseBody: string) {
  const originalRequest = https.request;
  let capturedBody = "";

  const fakeReq = new EventEmitter() as EventEmitter & {
    setTimeout: (ms: number, cb: () => void) => typeof fakeReq;
    write: (body: string) => boolean;
    end: () => void;
    destroy: (err?: Error) => void;
  };
  fakeReq.setTimeout = () => fakeReq;
  fakeReq.write = (body: string) => {
    capturedBody += body;
    return true;
  };
  fakeReq.end = () => undefined;
  fakeReq.destroy = (err?: Error) => {
    fakeReq.emit("error", err ?? new Error("destroyed"));
  };

  (https as typeof https & { request: unknown }).request = (_options, cb) => {
    const res = new EventEmitter() as EventEmitter & { statusCode: number };
    res.statusCode = 200;
    process.nextTick(() => {
      (cb as (res: typeof res) => void)(res);
      process.nextTick(() => {
        res.emit("data", Buffer.from(sseBody));
        res.emit("end");
      });
    });
    return fakeReq;
  };

  return {
    getCapturedBody: () => capturedBody,
    restore: () => {
      (https as typeof https & { request: unknown }).request = originalRequest;
    },
  };
}

test("streamSiliconFlow masks NXP in the outbound request body when dataMaskingEnabled is true", async () => {
  const sse =
    `data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\n` +
    `data: [DONE]\n\n`;
  const mock = mockStreamedResponse(sse);
  try {
    const { streamSiliconFlow } = await import("../src/lib/agent/agentStream.js");
    const { resolveAgentConfig } = await import("../src/lib/agent/agentConfig.js");
    const config = resolveAgentConfig({
      apiKey: "sk-test",
      apiBase: "https://api.siliconflow.cn/v1",
      model: "test-model",
    });

    await streamSiliconFlow(
      {
        model: "test-model",
        messages: [{ role: "user", content: "NXP 的探针卡数据怎么样" }],
      },
      config,
      () => {}
    );

    const body = JSON.parse(mock.getCapturedBody()) as { messages: { content: string }[] };
    assert.ok(
      !/nxp/i.test(body.messages[0].content),
      "outbound request body must not contain NXP in any case"
    );
  } finally {
    mock.restore();
  }
});

test("streamSiliconFlow unmasks a COMPANY_X token back to NXP in streamed text before onChunk", async () => {
  const sse =
    `data: {"choices":[{"delta":{"content":"COMPANY_X 良率正常"},"finish_reason":null}]}\n\n` +
    `data: [DONE]\n\n`;
  const mock = mockStreamedResponse(sse);
  try {
    const { streamSiliconFlow } = await import("../src/lib/agent/agentStream.js");
    const { resolveAgentConfig } = await import("../src/lib/agent/agentConfig.js");
    const config = resolveAgentConfig({
      apiKey: "sk-test",
      apiBase: "https://api.siliconflow.cn/v1",
      model: "test-model",
    });

    const texts: string[] = [];
    await streamSiliconFlow(
      { model: "test-model", messages: [{ role: "user", content: "hi" }] },
      config,
      (chunk) => {
        if (chunk.type === "delta") texts.push(chunk.text);
      }
    );

    assert.equal(texts.join(""), "NXP 良率正常");
  } finally {
    mock.restore();
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd pcr-ai-api && npx tsx --test test/agentStreamMasking.test.ts`
Expected: FAIL —— 第一条测试里请求体仍包含 `"NXP"`（未脱敏）；第二条测试里 `texts.join("")` 等于 `"COMPANY_X 良率正常"` 而不是 `"NXP 良率正常"`（因为此时 `agentStream.ts` 还没接入 masking）。

- [ ] **Step 3: 实现 —— 用下面内容整体覆盖 `pcr-ai-api/src/lib/agent/agentStream.ts`**

```ts
// pcr-ai-api/src/lib/agent/agentStream.ts
import https from "node:https";
import type { AgentConfig } from "./agentConfig.js";
import { getConfig } from "../runtimeConfig.js";
import {
  loadMaskingDictionary,
  createStreamUnmasker,
  type MaskingDictionary,
  type StreamUnmasker,
} from "./agentDataMasking.js";

export type StreamChunk =
  | { type: "delta"; text: string }
  | { type: "tool_calls"; calls: CollectedToolCall[] }
  | { type: "finish"; reason: string }
  | { type: "error"; message: string };

export interface CollectedToolCall {
  index: number;
  id: string;
  name: string;
  args: string; // accumulated JSON string
}

interface RawToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

const DEFAULT_STREAM_TIMEOUT_MS = 150_000;

function getStreamTimeoutMs(config: AgentConfig): number {
  if (Number.isFinite(config.streamTimeoutMs) && config.streamTimeoutMs > 0) {
    return config.streamTimeoutMs;
  }
  if (Number.isFinite(config.streamTimeoutSec) && config.streamTimeoutSec > 0) {
    return config.streamTimeoutSec * 1000;
  }
  return DEFAULT_STREAM_TIMEOUT_MS;
}

function accumulateToolCalls(
  collected: CollectedToolCall[],
  deltas: RawToolCallDelta[]
): void {
  for (const d of deltas) {
    const idx = d.index ?? 0;
    if (!collected[idx]) {
      collected[idx] = { index: idx, id: "", name: "", args: "" };
    }
    if (d.id) collected[idx].id = d.id;
    if (d.function?.name) collected[idx].name = d.function.name;
    if (d.function?.arguments) collected[idx].args += d.function.arguments;
  }
}

export interface LlmRequest {
  model: string;
  messages: unknown[];
  tools?: unknown[];
  tool_choice?: string;
  max_tokens?: number;
}

interface MaskableMessage {
  role?: string;
  content?: string | null;
  tool_calls?: { function?: { arguments?: string } }[];
  [key: string]: unknown;
}

/**
 * Replace real device values / "NXP" in every message's content and tool_calls
 * arguments with stable tokens. Never mutates the original message objects —
 * they may be the same references stored in server-side session history
 * (agentHistory.ts), which must stay unmasked at rest.
 */
export function maskRequestMessages(
  messages: unknown[],
  dict: MaskingDictionary
): unknown[] {
  return messages.map((raw) => {
    const m = raw as MaskableMessage;
    const next: MaskableMessage = { ...m };
    if (typeof m.content === "string") {
      next.content = dict.mask(m.content);
    }
    if (Array.isArray(m.tool_calls)) {
      next.tool_calls = m.tool_calls.map((tc) => {
        if (!tc?.function?.arguments) return tc;
        return {
          ...tc,
          function: { ...tc.function, arguments: dict.mask(tc.function.arguments) },
        };
      });
    }
    return next;
  });
}

export async function streamSiliconFlow(
  request: LlmRequest,
  config: AgentConfig,
  onChunk: (chunk: StreamChunk) => void
): Promise<void> {
  const maskingEnabled = getConfig().dataMaskingEnabled;
  const dict: MaskingDictionary | null = maskingEnabled
    ? await loadMaskingDictionary()
    : null;
  const outboundMessages = dict
    ? maskRequestMessages(request.messages, dict)
    : request.messages;

  return new Promise((resolve, reject) => {
    const timeoutMs = getStreamTimeoutMs(config);
    const body = JSON.stringify({
      ...request,
      messages: outboundMessages,
      stream: true,
      stream_options: { include_usage: true },
    });

    let url: URL;
    try {
      url = new URL(`${config.apiBase}/chat/completions`);
    } catch {
      reject(new Error(`Invalid apiBase: ${config.apiBase}`));
      return;
    }

    const options: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Length": String(Buffer.byteLength(body)),
      },
      rejectUnauthorized: false, // matches siliconflowChat.ts pattern
    };

    let settled = false;
    let timeoutId: NodeJS.Timeout | undefined;
    const unmasker: StreamUnmasker | null = dict ? createStreamUnmasker(dict) : null;

    const flushUnmaskTail = () => {
      if (!unmasker) return;
      const tail = unmasker.finalize();
      if (tail) onChunk({ type: "delta", text: tail });
    };

    const clearRequestTimeout = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
    };

    const timeoutMessage = `Request timeout after ${timeoutMs}ms`;
    const handleTimeout = () => {
      if (settled) return;
      settled = true;
      clearRequestTimeout();
      flushUnmaskTail();
      onChunk({ type: "error", message: timeoutMessage });
      req.destroy(new Error(timeoutMessage));
      resolve();
    };

    const req = https.request(options, (res) => {
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        let errBody = "";
        res.on("data", (c: Buffer) => { errBody += c.toString(); });
        res.on("end", () => {
          if (settled) return;
          settled = true;
          onChunk({
            type: "error",
            message: `HTTP ${res.statusCode}: ${errBody.slice(0, 200)}`,
          });
          resolve();
        });
        return;
      }

      const collected: CollectedToolCall[] = [];
      let buffer = "";
      let finishReason = "stop";

      res.on("data", (chunk: Buffer) => {
        // Idle timeout: reset while bytes keep flowing (avoids dying mid-stream).
        clearRequestTimeout();
        timeoutId = setTimeout(handleTimeout, timeoutMs);

        buffer += chunk.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;
          const data = trimmed.slice(6);
          if (data === "[DONE]") continue;

          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }

          const p = parsed as {
            choices?: {
              delta?: {
                content?: string;
                tool_calls?: RawToolCallDelta[];
              };
              finish_reason?: string | null;
            }[];
          };

          const choice = p.choices?.[0];
          if (!choice) continue;

          const delta = choice.delta as {
            content?: string;
            reasoning_content?: string;
            tool_calls?: RawToolCallDelta[];
          } | undefined;

          // Reasoning belongs in reasoning_content; never forward to UI text stream.
          if (typeof delta?.content === "string" && delta.content.length > 0) {
            const text = unmasker ? unmasker.push(delta.content) : delta.content;
            if (text) onChunk({ type: "delta", text });
          }

          const toolCallDeltas = choice.delta?.tool_calls;
          if (Array.isArray(toolCallDeltas) && toolCallDeltas.length > 0) {
            accumulateToolCalls(collected, toolCallDeltas);
          }

          if (choice.finish_reason) {
            finishReason = choice.finish_reason;
          }
        }
      });

      res.on("end", () => {
        if (settled) return;
        settled = true;
        clearRequestTimeout();
        flushUnmaskTail();
        if (collected.length > 0) {
          const calls = collected
            .filter(Boolean)
            .map((c) => (dict ? { ...c, args: dict.unmask(c.args) } : c));
          onChunk({ type: "tool_calls", calls });
        }
        onChunk({ type: "finish", reason: finishReason });
        resolve();
      });

      res.on("error", (err) => {
        if (settled) return;
        settled = true;
        flushUnmaskTail();
        onChunk({ type: "error", message: err.message });
        resolve();
      });
    });

    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearRequestTimeout();
      reject(err);
    });

    timeoutId = setTimeout(handleTimeout, timeoutMs);

    req.write(body);
    req.end();
  });
}
```

- [ ] **Step 4: 运行测试确认通过（新旧两个测试文件都要跑）**

Run: `cd pcr-ai-api && npx tsx --test test/agentStreamMasking.test.ts test/agentStream.test.ts`
Expected: PASS —— 新文件 2 条用例通过；旧文件 `agentStream.test.ts` 原有 2 条用例（超时相关）不受影响，因为它们不设置 `RUNTIME_CONFIG_PATH`，`getConfig().dataMaskingEnabled` 读到真实 `runtime-config.json` 的默认值 `false`，`dict` 为 `null`，行为与改动前完全一致。

- [ ] **Step 5: 跑全量后端测试确认没有破坏其它用例**

Run: `cd pcr-ai-api && npm test`
Expected: 全部 PASS（新增 6 条：Task 1 一条 + Task 2 四条 + Task 3 两条；原有用例数量不变，全部仍 PASS）

- [ ] **Step 6: Commit**

```bash
git add pcr-ai-api/src/lib/agent/agentStream.ts pcr-ai-api/test/agentStreamMasking.test.ts
git commit -m "feat(api): agentStream 接入 device/NXP 脱敏与流式还原（单点拦截）"
```

---

### Task 4: Settings 页面新增"是否数据脱敏"开关

**Files:**
- Modify: `pcr-ai-report/src/hooks/useServerConfig.ts`
- Modify: `pcr-ai-report/src/App.tsx`

**Interfaces:**
- Consumes: Task 1 的后端字段名 `dataMaskingEnabled`（`GET/PATCH /api/v4/admin/config` 已是通用透传，`admin.ts` 不需要改动）。
- Produces: `ServerConfig.dataMaskingEnabled: boolean`，`SERVER_CONFIG_DEFAULTS.dataMaskingEnabled = false`。

这个任务没有可自动运行的单元测试（现有 `jbDeterministicDispatch`/`jbLlmIntentClassifier` 开关同样没有前端单测，属于纯 UI 接线，由人工在浏览器验证），按以下步骤手工核对。

- [ ] **Step 1: 修改 `pcr-ai-report/src/hooks/useServerConfig.ts`**

在 `ServerConfig` 接口里，`jbLlmIntentClassifier: boolean;` 那一行之后加：

```ts
  /** Agent 数据脱敏（device/NXP 令牌化）开关，跨客户端同步。 */
  dataMaskingEnabled: boolean;
```

在 `SERVER_CONFIG_DEFAULTS` 里，`jbLlmIntentClassifier: false,` 那一行之后加：

```ts
  dataMaskingEnabled: false,
```

- [ ] **Step 2: 修改 `pcr-ai-report/src/App.tsx`**

找到这一段（`子任务模型` 字段的 `field-hint` 之后、`{/* ── 推理行为 ── */}` 之前）：

```tsx
              <p className="field-hint">
                用于历史对话压缩与确定性表解读（不涉及工具选择和最终回答），可填轻量模型节省用量，如 <code>Qwen/Qwen3-8B</code>。留空时与主模型相同。
              </p>

              <hr className="settings-divider" />

              {/* ── 推理行为 ── */}
```

替换为（在原有 `<hr>` 和"推理行为"分组之间插入新分组，并新增一条 `<hr>` 把两个分组隔开）：

```tsx
              <p className="field-hint">
                用于历史对话压缩与确定性表解读（不涉及工具选择和最终回答），可填轻量模型节省用量，如 <code>Qwen/Qwen3-8B</code>。留空时与主模型相同。
              </p>

              <hr className="settings-divider" />

              {/* ── 数据安全 ── */}
              <p className="settings-group-title">数据安全</p>
              <div className="setting-toggle-row">
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={serverConfig.dataMaskingEnabled}
                    onChange={(e) =>
                      updateServerConfig({ dataMaskingEnabled: e.target.checked })
                    }
                  />
                  <span className="toggle-track" />
                  <span className="toggle-label-text">是否数据脱敏</span>
                </label>
                <p className="field-hint">
                  打开后，发给第三方 LLM 的内容中 device 编号与 "NXP"
                  会替换为不可逆推的令牌，返回结果在展示 / 执行查询前自动还原为真实值。
                  影响<strong>所有用户</strong>，立即生效无需重启。默认关闭。
                </p>
              </div>

              <hr className="settings-divider" />

              {/* ── 推理行为 ── */}
```

不要把 `dataMaskingEnabled` 加进"↺ 恢复默认"按钮的 `updateServerConfig({...})` 补丁对象——与 `agentApiKey`、`jbDeterministicDispatch`、`jbLlmIntentClassifier` 同等对待（这些安全/灰度相关字段都不受"恢复默认"影响）。

- [ ] **Step 3: 类型检查**

Run: `cd pcr-ai-report && npm run build`
Expected: 通过（`tsc -b` 无报错，`vite build` 成功生成 `dist/`）

- [ ] **Step 4: 浏览器手工验证**

```bash
cd pcr-ai-api && npm run dev
```
另开一个终端：
```bash
cd pcr-ai-report && npm run dev
```
打开浏览器访问报表地址，进入"⚙ 设置" → 解锁 → 找到"AI Agent 配置"里新的"数据安全"分组，确认：
1. 开关默认关闭。
2. 打开后刷新页面/换一个浏览器标签页，开关状态保持打开（说明服务端共享生效）。
3. 关闭 Agent 后端 dev server 重启，开关状态不会回退回默认值（说明持久化到 `runtime-config.json`，不是纯内存态）。

- [ ] **Step 5: Commit**

```bash
git add pcr-ai-report/src/hooks/useServerConfig.ts pcr-ai-report/src/App.tsx
git commit -m "feat(report): Settings 新增「是否数据脱敏」开关"
```

---

### Task 5: 文档变更记录

**Files:**
- Modify: `pcr-ai-api/CLAUDE.md`
- Modify: `pcr-ai-report/CLAUDE.md`

**Interfaces:**
- Consumes: Task 1-4 的最终实现细节（文件名、导出名、字段名），用于写变更记录。
- Produces: 无代码产出，仅文档。

- [ ] **Step 1: `pcr-ai-api/CLAUDE.md` 追加变更记录**

找到编号列表里最后一项（`22. **AI Agent API Key + JB 灰度开关服务器端共享（2026-07-05）**：` 及其下属 5 个要点，以 `- **未纳入**：...本地 dev 有意义（本地改 .env 已经很轻量）。` 结尾），在其后紧接着追加新的一项（编号 `23`）：

```markdown
23. **Agent device/NXP 数据脱敏（2026-07-05）**：
   - **`src/lib/runtimeConfig.ts`**：`RuntimeConfig` 新增 **`dataMaskingEnabled`**（文件值 → `false`，无 env 兜底，纯新功能）。
   - **`src/lib/agent/agentDataMasking.ts`**（新）：全量 distinct device 字典（Oracle：`YMWEB_YIELDMONITORTRIGGER` + `INFCONTROL` 各一条 `SELECT DISTINCT DEVICE`；Dummy：直接取内存行 distinct，遵守双路径同步）+ 24 小时内存缓存 + 哈希令牌（`DEV_` + 真实值 SHA-256 前 10 位十六进制，冲突自动加长）+ NXP 固定映射（`/nxp/gi` ↔ `COMPANY_X`）+ `mask()`/`unmask()` + 带前瞻缓冲的 `createStreamUnmasker()`（避免令牌被流式分片截断）。
   - **`src/lib/agent/agentStream.ts`**：`streamSiliconFlow()` 是全仓库唯一的 SiliconFlow 出口（主循环、历史摘要、JB 表解读小模型调用均经过它），因此脱敏/还原**只改这一个文件**：请求体组装前对 `messages[].content` 与历史 `tool_calls[].function.arguments` 做 `mask()`；流式 `delta` 文本经 `StreamUnmasker` 逐步 `unmask()`；`tool_calls` 参数在流结束时整体 `unmask()` 后再交给 `agentLoop.ts` 派发给 `runTool()`——保证工具执行时用的是真实 device 值，能正常查库。仅当 **`getConfig().dataMaskingEnabled === true`** 时生效，默认关闭时零开销直通。
   - **前端**：Settings → AI Agent 配置 →「数据安全」分组新增「是否数据脱敏」开关，样式与既有 toggle 一致；详见 **`../pcr-ai-report/CLAUDE.md` §22**。
   - **未纳入**：系统提示词里固定的规则/说明文字不脱敏（只脱敏动态数据，含 `agentPrompt.ts` 里动态拼接的数据库快照 top device 列表）。
```

- [ ] **Step 2: `pcr-ai-report/CLAUDE.md` 追加变更记录**

找到这一段（第 277-281 行左右）：

```markdown
5. **未变**：`GET /api/v4/admin/config` 仍无鉴权、字段仍明文直返——与其它字段安全等级一致，未额外加固。`YIELD_MONITOR_TRIGGERS_DUMMY` / `INFCONTROL_LAYER_BINS_DUMMY` 未纳入共享配置（生产环境下这两个 flag 被 `listDummyRuntime.ts` 强制忽略，纳入也不起作用）。

---

## 12. 与 API 联调速查
```

替换为（在结束 `---` 和 `## 12.` 之间插入新的一节，自带首尾 `---`）：

```markdown
5. **未变**：`GET /api/v4/admin/config` 仍无鉴权、字段仍明文直返——与其它字段安全等级一致，未额外加固。`YIELD_MONITOR_TRIGGERS_DUMMY` / `INFCONTROL_LAYER_BINS_DUMMY` 未纳入共享配置（生产环境下这两个 flag 被 `listDummyRuntime.ts` 强制忽略，纳入也不起作用）。

---

## 22. 近期变更纪要（2026-07-05，Agent Device/NXP 数据脱敏）

1. **`useServerConfig.ts`**：`ServerConfig` 新增 **`dataMaskingEnabled: boolean`**（默认 `false`），走既有 `GET/PATCH /api/v4/admin/config` 共享配置机制。
2. **`App.tsx`**：Settings → AI Agent 配置，「接入配置」分组之后新增「数据安全」分组，一个 toggle「是否数据脱敏」，样式复用 `.setting-toggle-row` / `toggle-switch`（与 `jbDeterministicDispatch` 等一致）；未纳入「↺ 恢复默认」按钮（与 API Key / JB 灰度开关同等对待）。
3. **后端实现**：详见 **`../pcr-ai-api/CLAUDE.md`** 同日条目 23（`agentDataMasking.ts` + `agentStream.ts` 单点拦截）。

---
```

原文件里紧跟其后的 `## 12. 与 API 联调速查` 保持不变——新的一节连同上面这行 `---` 一起插在两者之间。

- [ ] **Step 3: Commit**

```bash
git add pcr-ai-api/CLAUDE.md pcr-ai-report/CLAUDE.md
git commit -m "docs: 记录 Agent device/NXP 数据脱敏交接"
```

---

## 完成后整体验证

- [ ] `cd pcr-ai-api && npm test` 全绿
- [ ] `cd pcr-ai-api && npm run build` 通过（`tsc` + `verify-dist-no-undici`）
- [ ] `cd pcr-ai-report && npm run build` 通过
- [ ] 浏览器手工验证 Task 4 Step 4 的三条勾选项
