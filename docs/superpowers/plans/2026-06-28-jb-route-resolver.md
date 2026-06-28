# JB 路由收敛(resolveJbRoute)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 JB 确定性表的意图判定从"三套重叠正则 + 顺序敏感调度 + 一轮重算 3 次"收敛为"一轮一次的 `JbRouteDecision` + 声明式 dispatch 表 + 混合(正则快路 / LLM 兜底)"。

**Architecture:** 新增纯函数 `resolveJbRoute(q, history, payload?) → JbRouteDecision`,内部三段式:高置信度正则规则(0.0s)→ 便宜模型分类器兜底 → 失败降级 `generic`。agentLoop 调度、`emitDeterministicJbTablesReply`、`buildDeterministicJbTables` 都消费 `decision.mode`,不再各自重算。绞杀者迁移:先纯重构等价(阶段 0/1),再加 LLM 兜底(阶段 2,默认开关关),最后灰度(阶段 3)。

**Tech Stack:** Node.js + TypeScript;测试 `tsx --test`;eval 台 `pcr-ai-api/test/eval/`;LLM 经 `streamSiliconFlow` / `agentConfig.subAgentModel`。

## Global Constraints

- **不碰 SQL / WHERE / 响应形状** —— 纯路由层,**不触发 dummy-parity**。
- **禁止 `undici`**;SiliconFlow 出站用内置 `fetch` / `node:https`。
- **`oracledb` 锁 5.5.0**,不升级。
- **复用现有 16 个 `JbReplyMode` 枚举**,不新造:`lot_overview | single_slot | bin_trend | slot_pass_yield | interrupt_count | tester_machine | equipment | bad_bin_ranking | bin_card_attribution | card_yield_compare | lot_yield_ranking | lot_listing | per_slot_bin_ranking | card_test_overview | card_dut_question | generic`。
- 每个任务收尾必过:`cd pcr-ai-api && npm test && npm run typecheck`。
- 提交信息结尾:`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`;**不提交** `.claude/settings.local.json`。
- **范围外**(不收编,保留为 `resolveJbRoute` 之前的独立前置检查):wafermap 自动取 device、DUT-bin map、test-item-mapping、`classifyIntent`(prompt 段)、YM 侧。
- 分支:`feat/jb-route-resolver`(从当前分支切出)。

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `pcr-ai-api/src/lib/agent/jbRouteResolver.ts` | `JbRouteDecision` 类型、`JbRouteParams` 抽取、`resolveJbRoute`(阶段 0 纯正则;阶段 2 加 LLM 段) | 新建 |
| `pcr-ai-api/src/lib/agent/jbIntentClassifier.ts` | `callJbIntentClassifier`(LLM 兜底,阶段 2) | 新建 |
| `pcr-ai-api/src/lib/agent/agentJbDeterministicReply.ts` | `buildDeterministicJbTables` 增可选 `modeOverride`;`detectJbReplyMode` 保留 | 改 |
| `pcr-ai-api/src/lib/agent/agentLoop.ts` | dispatch 表 + 消费 `resolveJbRoute`;`emitDeterministicJbTablesReply` 吃 `decision` | 改 |
| `pcr-ai-api/test/jbRouteResolver.test.ts` | resolver 单测 + parity(新 vs 旧) | 新建 |
| `pcr-ai-api/test/jbIntentClassifier.test.ts` | 分类器(mock 上游)单测 | 新建 |
| `pcr-ai-api/test/eval/scenarios/routing.scenarios.ts` | 历史痛点回归锁(断言 `resolveJbRoute().mode`) | 改 |
| `pcr-ai-api/.env.example` | `JB_LLM_INTENT_CLASSIFIER` 开关说明 | 改 |

---

# 阶段 0:抽取纯正则 `resolveJbRoute`(行为等价,不接线)

交付物:一个新纯函数,`.mode` 对任意输入都等于现 `detectJbReplyMode`;并集中抽取 params。**此阶段不改 agentLoop**,零线上风险。

### Task 1: `JbRouteDecision` 类型 + params 抽取

**Files:**
- Create: `pcr-ai-api/src/lib/agent/jbRouteResolver.ts`
- Test: `pcr-ai-api/test/jbRouteResolver.test.ts`

**Interfaces:**
- Consumes: `JbReplyMode`、`extractBinFromUserText`、`extractSlotFromUserText`、`extractLotFromUserText`、`detectJbReplyMode`(均 from `agentJbDeterministicReply.js`)。
- Produces:
  - `interface JbRouteParams { focusBin?: number; slot?: number; lot?: string; cardId?: string; passId?: number }`
  - `interface JbRouteDecision { mode: JbReplyMode; source: "regex"|"llm"|"default"; confidence: "high"|"low"; params: JbRouteParams; reason: string }`
  - `function extractJbRouteParams(q: string): JbRouteParams`

- [ ] **Step 1: 写失败测试**

```ts
// test/jbRouteResolver.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJbRouteParams } from "../src/lib/agent/jbRouteResolver.js";

test("extractJbRouteParams pulls focusBin and lot", () => {
  const p = extractJbRouteParams("NF13322.1J 哪片 bin79 最多");
  assert.equal(p.focusBin, 79);
  assert.equal(p.lot, "NF13322.1J");
});

test("extractJbRouteParams pulls slot", () => {
  const p = extractJbRouteParams("第3片的测试情况");
  assert.equal(p.slot, 3);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd pcr-ai-api && npx tsx --test test/jbRouteResolver.test.ts`
Expected: FAIL —— `extractJbRouteParams` 未导出 / 模块不存在。

- [ ] **Step 3: 最小实现**

```ts
// src/lib/agent/jbRouteResolver.ts
import {
  type JbReplyMode,
  detectJbReplyMode,
  extractBinFromUserText,
  extractSlotFromUserText,
} from "./agentJbDeterministicReply.js";
import { extractLotFromUserText } from "./agentInfWaferMapTool.js";

export interface JbRouteParams {
  focusBin?: number;
  slot?: number;
  lot?: string;
  cardId?: string;
  passId?: number;
}

export interface JbRouteDecision {
  mode: JbReplyMode;
  source: "regex" | "llm" | "default";
  confidence: "high" | "low";
  params: JbRouteParams;
  reason: string;
}

const CARD_ID_RE = /\b(\d{4}-\d{2,3})\b/;

export function extractJbRouteParams(q: string): JbRouteParams {
  const params: JbRouteParams = {};
  const bin = extractBinFromUserText(q);
  if (bin != null) params.focusBin = bin;
  const slot = extractSlotFromUserText(q);
  if (slot != null) params.slot = slot;
  const lot = extractLotFromUserText(q);
  if (lot) params.lot = lot;
  const card = CARD_ID_RE.exec(q)?.[1];
  if (card) params.cardId = card;
  if (/常温|sort\s*1|pass\s*1/i.test(q)) params.passId = 1;
  else if (/高温|sort\s*2|pass\s*3/i.test(q)) params.passId = 3;
  else if (/低温|sort\s*3|pass\s*5/i.test(q)) params.passId = 5;
  return params;
}
```

> 注:`extractBinFromUserText`(agentJbDeterministicReply.ts:456)、`extractSlotFromUserText`(:507)已导出;`extractLotFromUserText` 由 `agentInfWaferMapTool.ts` 导出(agentJbDeterministicReply.ts:22 已 import 之)。三者均现成,无需新增导出。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd pcr-ai-api && npx tsx --test test/jbRouteResolver.test.ts`
Expected: PASS（2 项）。

- [ ] **Step 5: 提交**

```bash
git add pcr-ai-api/src/lib/agent/jbRouteResolver.ts pcr-ai-api/test/jbRouteResolver.test.ts pcr-ai-api/src/lib/agent/agentJbDeterministicReply.ts
git commit -m "feat(agent): JbRouteDecision 类型 + 集中 params 抽取(阶段0)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 2: `resolveJbRoute` 纯正则版 + parity 测试

**Files:**
- Modify: `pcr-ai-api/src/lib/agent/jbRouteResolver.ts`
- Test: `pcr-ai-api/test/jbRouteResolver.test.ts`

**Interfaces:**
- Produces: `function resolveJbRoute(q: string, history?: unknown, payload?: Record<string, unknown>): JbRouteDecision`
- 阶段 0 契约:`resolveJbRoute(q).mode === detectJbReplyMode(q)` 恒成立(parity)。

- [ ] **Step 1: 写失败测试(含 parity 语料)**

```ts
import { resolveJbRoute } from "../src/lib/agent/jbRouteResolver.js";
import { detectJbReplyMode } from "../src/lib/agent/agentJbDeterministicReply.js";

const PARITY_CORPUS = [
  "DR44436.1W 用几号卡测试的",
  "NF13322.1J 哪片 bin79 最多",
  "这4张probecard的测试情况做对比",
  "都测试了什么lot",
  "NF12316.1X 中 bin7 的趋势",
  "DR45459.1A 各片中断多少次",
  "9416 卡的测试情况",
  "第二片的测试情况",
  "这批主要的fail bin有哪些",
  "N55Z bin35 是集中到哪张卡上的",
];

test("resolveJbRoute mode matches detectJbReplyMode (parity)", () => {
  for (const q of PARITY_CORPUS) {
    assert.equal(resolveJbRoute(q).mode, detectJbReplyMode(q), `parity fail: ${q}`);
  }
});

test("resolveJbRoute carries source=regex and params", () => {
  const d = resolveJbRoute("NF13322.1J 哪片 bin79 最多");
  assert.equal(d.source, "regex");
  assert.equal(d.params.focusBin, 79);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd pcr-ai-api && npx tsx --test test/jbRouteResolver.test.ts`
Expected: FAIL —— `resolveJbRoute` 未定义。

- [ ] **Step 3: 最小实现(阶段 0:直接委托 detectJbReplyMode)**

```ts
// 追加到 jbRouteResolver.ts
export function resolveJbRoute(
  q: string,
  _history?: unknown,
  _payload?: Record<string, unknown>
): JbRouteDecision {
  const mode = detectJbReplyMode(q);
  return {
    mode,
    source: "regex",
    confidence: "high",
    params: extractJbRouteParams(q),
    reason: `detectJbReplyMode → ${mode}`,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd pcr-ai-api && npx tsx --test test/jbRouteResolver.test.ts`
Expected: PASS。

- [ ] **Step 5: 全量回归 + 提交**

```bash
cd pcr-ai-api && npm test && npm run typecheck
git add pcr-ai-api/src/lib/agent/jbRouteResolver.ts pcr-ai-api/test/jbRouteResolver.test.ts
git commit -m "feat(agent): resolveJbRoute 纯正则版 + parity 测试(阶段0)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

# 阶段 1:接管调度(仍纯正则,行为等价)

把"三处重算"改为"一次透传"。先改最内层(表生成),再改外层(调度),每步 parity 兜底。

### Task 3: `buildDeterministicJbTables` 接受 `modeOverride`

**Files:**
- Modify: `pcr-ai-api/src/lib/agent/agentJbDeterministicReply.ts:1260-1265`
- Test: `pcr-ai-api/test/agentJbDeterministicReply.test.ts`

**Interfaces:**
- Produces: `buildDeterministicJbTables(userMessage, toolPayload, listingCtx?, modeOverride?: JbReplyMode)` —— 不传 `modeOverride` 时行为与今天**完全一致**(内部仍 `detectJbReplyMode`)。

- [ ] **Step 1: 写失败测试**

```ts
// 追加到 test/agentJbDeterministicReply.test.ts
it("buildDeterministicJbTables 用 modeOverride 时不再自行 detect", () => {
  const payload = { lot: "NF13322.1J", slotBadBinsCompact: [
    { slot: 1, passId: 1, cardId: "9416-03", badBins: [{ bin: 35, dieCount: 418 }] },
  ] };
  // override 成 bad_bin_ranking,即使问句像 lot_overview
  const md = buildDeterministicJbTables("NF13322.1J 整体测试情况", payload as any, undefined, "bad_bin_ranking");
  assert.ok(md && md.length > 0);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd pcr-ai-api && npx tsx --test test/agentJbDeterministicReply.test.ts`
Expected: FAIL —— 第 4 参数不被接受 / 类型错误。

- [ ] **Step 3: 实现(改签名,默认行为不变)**

```ts
export function buildDeterministicJbTables(
  userMessage: string,
  toolPayload: Record<string, unknown>,
  listingCtx?: Partial<LotListingContext>,
  modeOverride?: JbReplyMode
): string | null {
  const mode = modeOverride ?? detectJbReplyMode(userMessage);
  // ...(其余函数体不变)
```

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `cd pcr-ai-api && npm test && npm run typecheck`
Expected: PASS（含既有 detectJbReplyMode 用例不回归)。

- [ ] **Step 5: 提交**

```bash
git add pcr-ai-api/src/lib/agent/agentJbDeterministicReply.ts pcr-ai-api/test/agentJbDeterministicReply.test.ts
git commit -m "feat(agent): buildDeterministicJbTables 支持 modeOverride(阶段1)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 4: `emitDeterministicJbTablesReply` 消费 `decision`

**Files:**
- Modify: `pcr-ai-api/src/lib/agent/agentLoop.ts:916-958`(函数签名 + 内部 `detectJbReplyMode` 调用)
- Test: `pcr-ai-api/test/agentLoop.test.ts`

**Interfaces:**
- Consumes: `resolveJbRoute`、`JbRouteDecision`(from `jbRouteResolver.js`)。
- 行为:`emitDeterministicJbTablesReply` 内部 `const decision = resolveJbRoute(userQuestion, history, payload)`,用 `decision.mode` 替代两处重算(line 944 `detectJbReplyMode` 与 `buildDeterministicJbTables` 内部),并把多卡守卫改为 `if (decision.mode === "generic") return false`(等价:多卡对比 detectJbReplyMode 本就回 generic)。

- [ ] **Step 1: 写失败测试(多卡对比仍 bail)**

```ts
// test/agentLoop.test.ts —— 复用现有 emit 收集模式;若无导出则断言 resolveJbRoute 行为
import { resolveJbRoute } from "../src/lib/agent/jbRouteResolver.js";
test("多卡对比 → mode generic(收口守卫等价)", () => {
  assert.equal(resolveJbRoute("把这4张probecard的测试情况做对比").mode, "generic");
});
```

- [ ] **Step 2: 跑测试确认失败/通过基线**

Run: `cd pcr-ai-api && npx tsx --test test/agentLoop.test.ts`
Expected: 该断言 PASS(parity 已保证);若引用未编译则先补 import。

- [ ] **Step 3: 实现 —— 替换收口点的重算与守卫**

在 `emitDeterministicJbTablesReply`(agentLoop.ts:916)开头,把现有多卡守卫(`5df7c9a` 加的 `if (isMultiCardComparisonQuestion(userQuestion)) return false;`)替换为:

```ts
const decision = resolveJbRoute(userQuestion, getHistory(sessionId), payload);
if (decision.mode === "generic") {
  console.warn(`[jbDeterministic/routeGeneric] mode=generic 交回 LLM:「${userQuestion.slice(0,50)}」(${decision.reason})`);
  return false;
}
```

并把 line 944 `const mode = detectJbReplyMode(userQuestion);` 改为 `const mode = decision.mode;`,把 `buildDeterministicJbTables(userQuestion, payload, listingCtx)` 改为 `buildDeterministicJbTables(userQuestion, payload, listingCtx, decision.mode)`。

- [ ] **Step 4: 全量回归**

Run: `cd pcr-ai-api && npm test && npm run typecheck`
Expected: PASS；行为等价(多卡 generic、其余 mode 不变)。

- [ ] **Step 5: 提交**

```bash
git add pcr-ai-api/src/lib/agent/agentLoop.ts pcr-ai-api/test/agentLoop.test.ts
git commit -m "refactor(agent): emitDeterministicJbTablesReply 消费 resolveJbRoute(阶段1)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 5: 历史痛点回归锁(eval routing 场景)

**Files:**
- Modify: `pcr-ai-api/test/eval/scenarios/routing.scenarios.ts`

**Interfaces:**
- Consumes: `resolveJbRoute`(from `jbRouteResolver.js`)、`expectEqual`(from `evalTypes.js`)。

- [ ] **Step 1: 加回归锁场景(地鼠墓碑)**

```ts
import { resolveJbRoute } from "../../../src/lib/agent/jbRouteResolver.js";

// 追加进 routingScenarios 数组:
{
  id: "route-multi-card-compare-generic",
  category: "routing",
  title: "多卡对比 → generic(交回 LLM,不出单 lot 卡表)",
  seed: "P-C 真因",
  run: () => expectEqual(resolveJbRoute("把这4张probecard的测试情况做对比").mode, "generic", "mode"),
},
{
  id: "route-equipment-single-lot",
  category: "routing",
  title: "单 lot 用卡问 → equipment",
  run: () => expectEqual(resolveJbRoute("DR44436.1W 用几号卡测试的").mode, "equipment", "mode"),
},
{
  id: "route-lot-listing-colloquial",
  category: "routing",
  title: "「都测试了什么lot」→ lot_listing",
  seed: "P-B",
  run: () => expectEqual(resolveJbRoute("都测试了什么lot").mode, "lot_listing", "mode"),
},
{
  id: "route-per-slot-bin",
  category: "routing",
  title: "「哪片 binNN 最多」→ per_slot_bin_ranking",
  run: () => expectEqual(resolveJbRoute("NF13322.1J 哪片 bin79 最多").mode, "per_slot_bin_ranking", "mode"),
},
```

- [ ] **Step 2: 跑 eval 确认全绿**

Run: `cd pcr-ai-api && npx tsx test/eval/runEval.ts`
Expected: routing 类全 PASS(含新增 4 锁)。

- [ ] **Step 3: 全量回归 + 提交**

```bash
cd pcr-ai-api && npm test && npm run typecheck
git add pcr-ai-api/test/eval/scenarios/routing.scenarios.ts
git commit -m "test(agent): 历史痛点路由回归锁(P-B/P-C/equipment/per-slot)(阶段1)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

# 阶段 2:加 LLM 兜底(开关默认关)

### Task 6: `callJbIntentClassifier`(LLM 分类器,mock 可测)

**Files:**
- Create: `pcr-ai-api/src/lib/agent/jbIntentClassifier.ts`
- Test: `pcr-ai-api/test/jbIntentClassifier.test.ts`

**Interfaces:**
- Consumes: `streamSiliconFlow`(from `agentStream.js`)、`AgentConfig`、`JbReplyMode`。
- Produces:
  - `interface JbClassifierResult { mode: JbReplyMode; confidence: "high"|"low"; params?: JbRouteParams }`
  - `async function callJbIntentClassifier(q: string, ctx: { lastToolName?: string; cachedLot?: string }, agentConfig: AgentConfig, deps?: { chat?: ChatFn }): Promise<JbClassifierResult | null>`
  - 失败/超时/非法 JSON/未知 mode → 返回 `null`。
- `ChatFn` = 注入式上游(测试传 mock,生产默认走 `streamSiliconFlow`)。

- [ ] **Step 1: 写失败测试(mock 上游)**

```ts
// test/jbIntentClassifier.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { callJbIntentClassifier } from "../src/lib/agent/jbIntentClassifier.js";

const cfg: any = { subAgentModel: "x", apiKey: "k" };

test("解析合法 JSON → mode+params", async () => {
  const chat = async () => '{"mode":"equipment","confidence":"high","focusBin":null}';
  const r = await callJbIntentClassifier("这片用啥卡", {}, cfg, { chat });
  assert.equal(r?.mode, "equipment");
});

test("未知 mode → null", async () => {
  const chat = async () => '{"mode":"nonsense"}';
  const r = await callJbIntentClassifier("x", {}, cfg, { chat });
  assert.equal(r, null);
});

test("非法 JSON → null", async () => {
  const chat = async () => "not json";
  const r = await callJbIntentClassifier("x", {}, cfg, { chat });
  assert.equal(r, null);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd pcr-ai-api && npx tsx --test test/jbIntentClassifier.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

```ts
// src/lib/agent/jbIntentClassifier.ts
import type { AgentConfig } from "./agentConfig.js";
import { type JbReplyMode } from "./agentJbDeterministicReply.js";
import { type JbRouteParams } from "./jbRouteResolver.js";

const VALID_MODES: ReadonlySet<string> = new Set([
  "lot_overview","single_slot","bin_trend","slot_pass_yield","interrupt_count",
  "tester_machine","equipment","bad_bin_ranking","bin_card_attribution",
  "card_yield_compare","lot_yield_ranking","lot_listing","per_slot_bin_ranking",
  "card_test_overview","card_dut_question","generic",
]);

export interface JbClassifierResult {
  mode: JbReplyMode;
  confidence: "high" | "low";
  params?: JbRouteParams;
}

export type ChatFn = (prompt: string, agentConfig: AgentConfig) => Promise<string>;

const SYSTEM = `你是测试数据问句的意图分类器。仅输出 JSON:{"mode":<枚举>,"confidence":"high|low","focusBin":<数字或null>,"lot":<字符串或null>,"cardId":<字符串或null>}。mode 必须是以下之一:` +
  [...VALID_MODES].join(",") + `。多卡对比/模糊/跨实体一律 mode=generic。`;

async function defaultChat(prompt: string, agentConfig: AgentConfig): Promise<string> {
  const { streamSiliconFlow } = await import("./agentStream.js");
  let out = "";
  await streamSiliconFlow(
    { model: agentConfig.subAgentModel, messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: prompt },
    ], max_tokens: 120 },
    agentConfig,
    (c: any) => { if (c.type === "delta") out += c.text; }
  );
  return out;
}

export async function callJbIntentClassifier(
  q: string,
  ctx: { lastToolName?: string; cachedLot?: string },
  agentConfig: AgentConfig,
  deps?: { chat?: ChatFn }
): Promise<JbClassifierResult | null> {
  const chat = deps?.chat ?? defaultChat;
  const prompt = `问题:${q}\n上一工具:${ctx.lastToolName ?? "无"}\n缓存lot:${ctx.cachedLot ?? "无"}`;
  let raw: string;
  try {
    raw = await Promise.race([
      chat(prompt, agentConfig),
      new Promise<string>((_, rej) => setTimeout(() => rej(new Error("timeout")), 4000)),
    ]);
  } catch {
    return null;
  }
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj: any;
  try { obj = JSON.parse(m[0]); } catch { return null; }
  if (!obj || !VALID_MODES.has(obj.mode)) return null;
  const params: JbRouteParams = {};
  if (typeof obj.focusBin === "number") params.focusBin = obj.focusBin;
  if (typeof obj.lot === "string" && obj.lot) params.lot = obj.lot;
  if (typeof obj.cardId === "string" && obj.cardId) params.cardId = obj.cardId;
  return {
    mode: obj.mode as JbReplyMode,
    confidence: obj.confidence === "high" ? "high" : "low",
    params,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd pcr-ai-api && npx tsx --test test/jbIntentClassifier.test.ts`
Expected: PASS（3 项）。

- [ ] **Step 5: 提交**

```bash
git add pcr-ai-api/src/lib/agent/jbIntentClassifier.ts pcr-ai-api/test/jbIntentClassifier.test.ts
git commit -m "feat(agent): callJbIntentClassifier LLM 意图分类器(mock 可测)(阶段2)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 7: `resolveJbRoute` 接入 LLM 兜底 + 开关 + 降级

**Files:**
- Modify: `pcr-ai-api/src/lib/agent/jbRouteResolver.ts`
- Modify: `pcr-ai-api/.env.example`
- Test: `pcr-ai-api/test/jbRouteResolver.test.ts`

**Interfaces:**
- `resolveJbRoute` 增 async 重载:`resolveJbRouteAsync(q, ctx, agentConfig, deps?) → Promise<JbRouteDecision>`。同步 `resolveJbRoute` 保留(纯正则,阶段 0/1 调用点不变)。
- 仅当 `process.env.JB_LLM_INTENT_CLASSIFIER === "true"` 且同步版判出 `generic` 且**问句模糊**(无 lot 锚点)时,才调分类器;否则返回同步结果。
- 分类器返回 `null` → 保持 `generic`(降级)。

- [ ] **Step 1: 写失败测试**

```ts
import { resolveJbRouteAsync } from "../src/lib/agent/jbRouteResolver.js";

test("开关关 → 不调分类器,等于同步结果", async () => {
  delete process.env.JB_LLM_INTENT_CLASSIFIER;
  const chat = async () => '{"mode":"equipment"}';
  const d = await resolveJbRouteAsync("这几张卡咋样", {}, { subAgentModel: "x" } as any, { chat });
  assert.equal(d.source, "regex");          // 未走 LLM
});

test("开关开 + 同步 generic + 模糊 → 用分类器结果", async () => {
  process.env.JB_LLM_INTENT_CLASSIFIER = "true";
  const chat = async () => '{"mode":"card_test_overview","confidence":"high"}';
  const d = await resolveJbRouteAsync("这几张卡最近咋样", {}, { subAgentModel: "x" } as any, { chat });
  assert.equal(d.mode, "card_test_overview");
  assert.equal(d.source, "llm");
  delete process.env.JB_LLM_INTENT_CLASSIFIER;
});

test("开关开 + 分类器 null → 降级 generic", async () => {
  process.env.JB_LLM_INTENT_CLASSIFIER = "true";
  const chat = async () => "garbage";
  const d = await resolveJbRouteAsync("这几张卡最近咋样", {}, { subAgentModel: "x" } as any, { chat });
  assert.equal(d.mode, "generic");
  assert.equal(d.source, "default");
  delete process.env.JB_LLM_INTENT_CLASSIFIER;
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd pcr-ai-api && npx tsx --test test/jbRouteResolver.test.ts`
Expected: FAIL —— `resolveJbRouteAsync` 未定义。

- [ ] **Step 3: 实现**

```ts
// 追加到 jbRouteResolver.ts
import { callJbIntentClassifier, type ChatFn } from "./jbIntentClassifier.js";
import type { AgentConfig } from "./agentConfig.js";

function isAmbiguous(q: string): boolean {
  // 无 lot 锚点 + 短/口语 → 模糊;有明确 lot 号的不进 LLM(同步已足够)
  return !/[A-Z]{2}\d{4,}\.\d?[A-Z]?/i.test(q);
}

export async function resolveJbRouteAsync(
  q: string,
  ctx: { lastToolName?: string; cachedLot?: string },
  agentConfig: AgentConfig,
  deps?: { chat?: ChatFn },
  history?: unknown,
  payload?: Record<string, unknown>
): Promise<JbRouteDecision> {
  const base = resolveJbRoute(q, history, payload);
  if (process.env.JB_LLM_INTENT_CLASSIFIER !== "true") return base;
  if (base.mode !== "generic" || !isAmbiguous(q)) return base;
  const r = await callJbIntentClassifier(q, ctx, agentConfig, deps);
  if (!r) {
    return { ...base, source: "default", confidence: "low", reason: "LLM 分类失败,降级 generic" };
  }
  return {
    mode: r.mode,
    source: "llm",
    confidence: r.confidence,
    params: { ...base.params, ...r.params },
    reason: `LLM 分类 → ${r.mode}`,
  };
}
```

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `cd pcr-ai-api && npm test && npm run typecheck`
Expected: PASS。

- [ ] **Step 5: 加开关文档 + 提交**

在 `.env.example` 加:
```
# JB 路由 LLM 兜底分类器(模糊问句走便宜模型判意图);默认关,关闭=纯正则路由
JB_LLM_INTENT_CLASSIFIER=false
```

```bash
git add pcr-ai-api/src/lib/agent/jbRouteResolver.ts pcr-ai-api/test/jbRouteResolver.test.ts pcr-ai-api/.env.example
git commit -m "feat(agent): resolveJbRouteAsync 接入 LLM 兜底 + 开关 + 安全降级(阶段2)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 8: agentLoop 收口点改用 async 兜底(开关生效)

**Files:**
- Modify: `pcr-ai-api/src/lib/agent/agentLoop.ts`(Task 4 改的 `emitDeterministicJbTablesReply` 处)
- Test: 复用 `test/agentLoop.test.ts`

**Interfaces:**
- Consumes: `resolveJbRouteAsync`。
- `emitDeterministicJbTablesReply` 把 Task 4 的同步 `resolveJbRoute` 换成 `await resolveJbRouteAsync(userQuestion, { lastToolName, cachedLot }, agentConfig, undefined, history, payload)`。`lastToolName`/`cachedLot` 从既有 `lastToolMessage(history)` / `resolveJbToolPayload` 取。

- [ ] **Step 1: 实现替换**

把 Task 4 引入的 `const decision = resolveJbRoute(...)` 改为:
```ts
const lastToolName = lastToolMessage(history)?.name;
const cachedLot = typeof payload["lot"] === "string" ? (payload["lot"] as string) : undefined;
const decision = await resolveJbRouteAsync(userQuestion, { lastToolName, cachedLot }, agentConfig, undefined, history, payload);
```

- [ ] **Step 2: 全量回归(开关默认关 → 行为同阶段 1)**

Run: `cd pcr-ai-api && npm test && npm run typecheck`
Expected: PASS;开关关时 `resolveJbRouteAsync` 等于同步,行为不变。

- [ ] **Step 3: 提交**

```bash
git add pcr-ai-api/src/lib/agent/agentLoop.ts
git commit -m "feat(agent): 收口点接 resolveJbRouteAsync,开关控 LLM 兜底(阶段2)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

# 阶段 3:灰度验证(真库 / live,非纯代码)

### Task 9: live eval 场景 + 验证脚本说明

**Files:**
- Modify: `pcr-ai-api/test/eval/scenarios/routing.scenarios.ts`(加 `live: true` 模糊问句场景)
- Modify: `docs/NEXT_STEPS_FOR_CURSOR_2026-06-27.md`(加"阶段3 灰度复验"清单)

- [ ] **Step 1: 加 live 场景(开关开时跑)**

```ts
{
  id: "route-llm-fallback-colloquial",
  category: "routing",
  title: "[live] 口语模糊「这几张卡最近咋样」→ 非单 lot 误答",
  live: true,
  run: async () => {
    process.env.JB_LLM_INTENT_CLASSIFIER = "true";
    const { resolveJbRouteAsync } = await import("../../../src/lib/agent/jbRouteResolver.js");
    const d = await resolveJbRouteAsync("这几张卡最近咋样", {}, { subAgentModel: process.env.AGENT_SUBAGENT_MODEL } as any);
    return d.mode === "lot_overview"
      ? { pass: false, detail: "模糊多卡问被判 lot_overview(应 generic/card_test_overview)" }
      : { pass: true };
  },
},
```

- [ ] **Step 2: 文档加灰度复验清单**

在 `docs/NEXT_STEPS_FOR_CURSOR_2026-06-27.md` 顶部加一节"阶段3:JB 路由灰度":部署后设 `JB_LLM_INTENT_CLASSIFIER=true` + pm2 reload;`AGENT_EVAL_LIVE=1 npx tsx test/eval/runEval.ts`;真库 curl 对比开/关两版对一批口语问句的回答;确认 403 时降级回 generic 不报错。

- [ ] **Step 3: 提交**

```bash
git add pcr-ai-api/test/eval/scenarios/routing.scenarios.ts docs/NEXT_STEPS_FOR_CURSOR_2026-06-27.md
git commit -m "test(agent): live 兜底 eval 场景 + 阶段3 灰度复验清单(阶段3)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 10: 收尾文档(DEV_LOG / TODO)

**Files:**
- Modify: `docs/DEV_LOG.md`、`docs/TODO.md`

- [ ] **Step 1: DEV_LOG 顶部加条目**(日期、四阶段完成内容、测试数)。
- [ ] **Step 2: TODO 勾掉"打地鼠收口"项,加"阶段3 灰度后默认开启开关"待办。**
- [ ] **Step 3: 提交**

```bash
git add docs/DEV_LOG.md docs/TODO.md
git commit -m "docs(agent): JB 路由收敛四阶段收尾(DEV_LOG/TODO)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## 验证总览(每阶段门槛)

| 阶段 | 门槛 |
|---|---|
| 0 | `resolveJbRoute(q).mode === detectJbReplyMode(q)` parity 全绿;`npm test` 398+ 全过 |
| 1 | agentLoop 接线后 `npm test` + eval routing 全绿;行为等价 |
| 2 | 开关**关**时行为同阶段 1;开关开 + mock 分类器单测全绿;降级路径覆盖 |
| 3 | 真库 `AGENT_EVAL_LIVE=1` + curl 比对;403 降级不报错 |

## 风险回退

任何阶段 eval 掉点 → `git revert` 该阶段提交,停在上一阶段(每阶段独立提交即为此)。阶段 0/1 纯正则等价,可安全停留;阶段 2 开关默认关,线上零影响,可长期观察后再灰度。
