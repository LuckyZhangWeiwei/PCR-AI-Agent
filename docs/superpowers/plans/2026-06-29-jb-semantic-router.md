# JB 语义路由彻底化(阶段一+二)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 JB 路由里散落的关键字分类器(`isMultiCardComparisonQuestion` / `isMultiLotComparisonQuestion` / `equipmentRouteDutLevelBail` / `detectJbReplyMode`)收敛进**单一语义决策** `classifyJbIntent`,并建立 eval 黄金集闸门,证明"混合路由 ≥ 纯正则 baseline、零回退"后才允许翻 flag 默认。

**Architecture:** 三段式决策——①高置信正则快路(有明确 lot/card 且 mode 无歧义,0 延迟)→ ②模糊时调 `subAgentModel` LLM 分类 → ③LLM 超时/失败退回正则。决策携带 `mode` + 三个 bool flag(multiCardCompare / multiLotCompare / dutLevel),下游 bail 全部改读这一个决策。全程藏 `JB_LLM_INTENT_CLASSIFIER` flag 后,默认 off;`test/eval/` 黄金集打分器锁正则 baseline。

**Tech Stack:** Node + TypeScript;测试 `tsx --test`;eval 自研 harness(`test/eval/`)。

## Global Constraints

- 纯路由层,**不碰 SQL / WHERE / 排序 / limit / 聚合维度 / 响应形状** —— 不触发 dummy-parity。
- **不动** `classifyIntent`(prompt 段注入)与 YM 侧路由。
- **不动** 任何 `*Dummy.ts`、`src/routes/`、Oracle SQL。
- `JB_LLM_INTENT_CLASSIFIER` **默认保持 off**;翻默认是闸门绿后的**独立** commit(本计划不翻)。
- 每个 Task 结束:`cd pcr-ai-api && npm run typecheck` 通过 + 该 Task 相关 `npm test` 子集通过。
- commit message 结尾:`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。
- 收编关键字函数时**保留其内部正则原样**作为快路实现,行为逐位一致(零回退前提)。
- 当前分支 `feat/jb-route-resolver`(非 main,无需另开)。

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/lib/agent/agentJbDeterministicReply.ts` | JB 判定谓词集中地 | 接收 `equipmentRouteDutLevelBail`;新增 `extractJbIntentFlags` |
| `src/lib/agent/jbRouteResolver.ts` | 单一语义决策 | `JbRouteDecision` 加 3 flag;`resolveJbRoute` 填 flag;`resolveJbRouteAsync`→`classifyJbIntent` 合并 LLM flag |
| `src/lib/agent/jbIntentClassifier.ts` | LLM 分类器 | SYSTEM + 解析扩成输出 3 flag |
| `src/lib/agent/agentLoop.ts` | 消费点 | 3 处 bail 改读 decision;`equipmentRouteDutLevelBail` 改为 re-export |
| `test/eval/scenarios/routing-golden.ts` | 黄金集数据 | 新建 |
| `test/eval/routingGoldenScore.ts` | 纯正则打分器 + baseline 闸门 | 新建 |
| `test/agentEval.test.ts` | total≥30 + baseline 零回退 + live 混合 | 加断言 |

---

### Task 1: 把 `equipmentRouteDutLevelBail` 挪到 `agentJbDeterministicReply.ts`(破环 + 集中谓词)

`jbRouteResolver.ts` 后续要消费 DUT 级判定,但该函数现在在 `agentLoop.ts`,而 `agentLoop` 已 import `jbRouteResolver` → 直接反向 import 会成循环依赖。先把它挪到 `agentJbDeterministicReply.ts`(已被 `jbRouteResolver` import,无环),`agentLoop` 改为 re-export 保持对外签名不变。

**Files:**
- Modify: `pcr-ai-api/src/lib/agent/agentJbDeterministicReply.ts`(在 `isMultiLotComparisonQuestion` 后 ~681 行处加函数)
- Modify: `pcr-ai-api/src/lib/agent/agentLoop.ts:1524-1526`(删定义,改 re-export)
- Test: `pcr-ai-api/test/agentJbDeterministicReply.test.ts`

**Interfaces:**
- Produces: `export function equipmentRouteDutLevelBail(text: string): boolean`(从 `agentJbDeterministicReply.ts` 导出,签名不变)

- [ ] **Step 1: 写失败测试**(`test/agentJbDeterministicReply.test.ts` 顶部 import 区加入 `equipmentRouteDutLevelBail`,文件内新增):

```ts
test("equipmentRouteDutLevelBail: DUT/嫌疑die 类问句为 true,纯卡问句为 false", () => {
  assert.equal(equipmentRouteDutLevelBail("这lot哪些die是嫌疑die"), true);
  assert.equal(equipmentRouteDutLevelBail("dut5 良率"), true);
  assert.equal(equipmentRouteDutLevelBail("DR44436.1W 用几号卡测试的"), false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd pcr-ai-api && npx tsx --test test/agentJbDeterministicReply.test.ts`
Expected: FAIL —— `equipmentRouteDutLevelBail` is not exported by agentJbDeterministicReply。

- [ ] **Step 3: 在 `agentJbDeterministicReply.ts`(~681 行,`isMultiLotComparisonQuestion` 函数之后)新增**

```ts
/** equipment 直连路由的 DUT 级 bail:问 dut/嫌疑die 时不走单 lot equipment 缓存表,交回 LLM。 */
export function equipmentRouteDutLevelBail(text: string): boolean {
  return /\bdut\b|嫌疑\s*die|哪些?\s*die/i.test(text);
}
```

- [ ] **Step 4: `agentLoop.ts:1524-1526` 删除原定义,改为 re-export**(在 `agentJbDeterministicReply.js` 的 import 块加入该名;在原定义处替换为转出)。把原 1524-1526 三行整体删除;在文件顶部对 `agentJbDeterministicReply.js` 的 import 列表里加上 `equipmentRouteDutLevelBail`;并在原位置附近加一行保持对外可见:

```ts
export { equipmentRouteDutLevelBail } from "./agentJbDeterministicReply.js";
```

> 注意:`agentLoop.ts:1557` 的调用点本 Task 不改(仍调同名函数,现在来自 re-export),保证编译通过、行为不变。

- [ ] **Step 5: 跑测试确认通过 + 类型**

Run: `cd pcr-ai-api && npx tsx --test test/agentJbDeterministicReply.test.ts test/agentLoop.test.ts && npm run typecheck`
Expected: PASS(含原有 `equipmentRouteDutLevelBail` 在 agentLoop.test 的断言仍绿)。

- [ ] **Step 6: 提交**

```bash
git add pcr-ai-api/src/lib/agent/agentJbDeterministicReply.ts pcr-ai-api/src/lib/agent/agentLoop.ts pcr-ai-api/test/agentJbDeterministicReply.test.ts
git commit -m "refactor(agent): equipmentRouteDutLevelBail 迁至 agentJbDeterministicReply 破环

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `JbRouteDecision` 加三 flag + `extractJbIntentFlags` 集中谓词

把三个 bail 谓词集中成一个纯函数 `extractJbIntentFlags`,并让同步 `resolveJbRoute` 在返回的 `JbRouteDecision` 上携带它们。下游从此读 decision,不再各自调谓词。

**Files:**
- Modify: `pcr-ai-api/src/lib/agent/agentJbDeterministicReply.ts`(新增 `extractJbIntentFlags`)
- Modify: `pcr-ai-api/src/lib/agent/jbRouteResolver.ts:19-58`(`JbRouteDecision` 加字段;`resolveJbRoute` 填充)
- Test: `pcr-ai-api/test/jbRouteResolver.test.ts`

**Interfaces:**
- Consumes: `equipmentRouteDutLevelBail`(Task 1),`isMultiCardComparisonQuestion`/`isMultiLotComparisonQuestion`(已存在,同文件)
- Produces:
  - `export function extractJbIntentFlags(q: string): { isMultiCardCompare: boolean; isMultiLotCompare: boolean; isDutLevel: boolean }`(在 `agentJbDeterministicReply.ts`)
  - `JbRouteDecision` 新增三字段 `isMultiCardCompare: boolean; isMultiLotCompare: boolean; isDutLevel: boolean`

- [ ] **Step 1: 写失败测试**(`test/jbRouteResolver.test.ts` 新增)

```ts
test("resolveJbRoute 决策携带集中后的三 flag", () => {
  const d = resolveJbRoute("把这4张probecard的测试情况做对比");
  assert.equal(d.isMultiCardCompare, true);
  assert.equal(d.isMultiLotCompare, false);
  assert.equal(d.isDutLevel, false);

  const e = resolveJbRoute("这几个lot分别用什么卡");
  assert.equal(e.isMultiLotCompare, true);

  const f = resolveJbRoute("这lot哪些die是嫌疑die");
  assert.equal(f.isDutLevel, true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd pcr-ai-api && npx tsx --test test/jbRouteResolver.test.ts`
Expected: FAIL —— `isMultiCardCompare` 等属性不存在(undefined !== true)。

- [ ] **Step 3a: `agentJbDeterministicReply.ts` 新增 `extractJbIntentFlags`**(紧接 Task 1 的 `equipmentRouteDutLevelBail` 之后)

```ts
/** 把三个 bail 谓词集中成一个决策对象,供 jbRouteResolver 单点产出。 */
export function extractJbIntentFlags(q: string): {
  isMultiCardCompare: boolean;
  isMultiLotCompare: boolean;
  isDutLevel: boolean;
} {
  return {
    isMultiCardCompare: isMultiCardComparisonQuestion(q),
    isMultiLotCompare: isMultiLotComparisonQuestion(q),
    isDutLevel: equipmentRouteDutLevelBail(q),
  };
}
```

- [ ] **Step 3b: `jbRouteResolver.ts` 扩 `JbRouteDecision` 接口**(19-25 行)加三字段:

```ts
export interface JbRouteDecision {
  mode: JbReplyMode;
  source: "regex" | "llm" | "default";
  confidence: "high" | "low";
  params: JbRouteParams;
  reason: string;
  isMultiCardCompare: boolean;
  isMultiLotCompare: boolean;
  isDutLevel: boolean;
}
```

- [ ] **Step 3c: `jbRouteResolver.ts` 顶部 import 加 `extractJbIntentFlags`;`resolveJbRoute`(45-58 行)填充**

import 行改为:
```ts
import {
  type JbReplyMode,
  detectJbReplyMode,
  extractBinFromUserText,
  extractSlotFromUserText,
  extractJbIntentFlags,
} from "./agentJbDeterministicReply.js";
```

`resolveJbRoute` 返回体改为:
```ts
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
    ...extractJbIntentFlags(q),
  };
}
```

- [ ] **Step 4: 跑测试确认通过 + 类型**

Run: `cd pcr-ai-api && npx tsx --test test/jbRouteResolver.test.ts && npm run typecheck`
Expected: PASS。typecheck 会暴露 `resolveJbRouteAsync` 里构造 decision 缺三字段的地方 —— 若报错,在 Task 3 修;本 Task 若 typecheck 因 async 分支报缺字段,临时在 `resolveJbRouteAsync` 的两个 return 里补 `isMultiCardCompare: base.isMultiCardCompare` 等透传(下一 Task 正式重构)。

- [ ] **Step 5: 提交**

```bash
git add pcr-ai-api/src/lib/agent/agentJbDeterministicReply.ts pcr-ai-api/src/lib/agent/jbRouteResolver.ts pcr-ai-api/test/jbRouteResolver.test.ts
git commit -m "feat(agent): JbRouteDecision 携带集中后的多卡/多lot/DUT flag

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: LLM 分类器输出 flag + `resolveJbRouteAsync`→`classifyJbIntent`

让 LLM 分类器也产出三 flag;把 `resolveJbRouteAsync` 改名 `classifyJbIntent`(保留旧名 alias),LLM 命中时用 LLM 的 flag,否则继承正则 base 的 flag。

**Files:**
- Modify: `pcr-ai-api/src/lib/agent/jbIntentClassifier.ts`(SYSTEM + 解析)
- Modify: `pcr-ai-api/src/lib/agent/jbRouteResolver.ts:66-88`
- Test: `pcr-ai-api/test/jbRouteResolver.test.ts`(注入假 chat)

**Interfaces:**
- Consumes: `JbClassifierResult`(扩字段)
- Produces:
  - `JbClassifierResult` 新增可选 `flags?: { isMultiCardCompare: boolean; isMultiLotCompare: boolean; isDutLevel: boolean }`
  - `export async function classifyJbIntent(q, ctx, agentConfig, deps?, history?, payload?): Promise<JbRouteDecision>`
  - `export const resolveJbRouteAsync = classifyJbIntent`(向后兼容 alias)

- [ ] **Step 1: 写失败测试**(`test/jbRouteResolver.test.ts` 新增;用注入 chat 模拟 LLM,绕开真网络)

```ts
test("classifyJbIntent: LLM 命中时采用 LLM 的 mode 与 flag", async () => {
  const fakeChat = async () =>
    JSON.stringify({ mode: "generic", confidence: "high",
      isMultiCardCompare: true, isMultiLotCompare: false, isDutLevel: false });
  process.env.JB_LLM_INTENT_CLASSIFIER = "true";
  try {
    const d = await classifyJbIntent(
      "这几张卡最近咋样", {}, { subAgentModel: "x" } as any, { chat: fakeChat });
    assert.equal(d.source, "llm");
    assert.equal(d.isMultiCardCompare, true);
  } finally {
    delete process.env.JB_LLM_INTENT_CLASSIFIER;
  }
});

test("classifyJbIntent: flag off 时纯正则,flag 来自正则 base", async () => {
  const d = await classifyJbIntent(
    "把这4张probecard的测试情况做对比", {}, { subAgentModel: "x" } as any);
  assert.equal(d.source, "regex");
  assert.equal(d.isMultiCardCompare, true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd pcr-ai-api && npx tsx --test test/jbRouteResolver.test.ts`
Expected: FAIL —— `classifyJbIntent` 未定义。

- [ ] **Step 3a: `jbIntentClassifier.ts` SYSTEM 增 flag 字段**(21-22 行)

```ts
const SYSTEM = `你是测试数据问句的意图分类器。仅输出 JSON:{"mode":<枚举>,"confidence":"high|low","focusBin":<数字或null>,"lot":<字符串或null>,"cardId":<字符串或null>,"isMultiCardCompare":<bool>,"isMultiLotCompare":<bool>,"isDutLevel":<bool>}。mode 必须是以下之一:` +
  [...VALID_MODES].join(",") + `。多卡对比/模糊/跨实体一律 mode=generic。isMultiCardCompare:对比≥2张卡;isMultiLotCompare:对比/枚举多个lot;isDutLevel:问dut/嫌疑die。`;
```

- [ ] **Step 3b: `jbIntentClassifier.ts` `JbClassifierResult` 加字段 + 解析**(13-17 行接口加 `flags?`;64-73 解析)

接口:
```ts
export interface JbClassifierResult {
  mode: JbReplyMode;
  confidence: "high" | "low";
  params?: JbRouteParams;
  flags?: { isMultiCardCompare: boolean; isMultiLotCompare: boolean; isDutLevel: boolean };
}
```

解析(在 `return { mode, confidence, params }` 前组装 flags):
```ts
  const flags =
    typeof obj.isMultiCardCompare === "boolean"
      ? {
          isMultiCardCompare: !!obj.isMultiCardCompare,
          isMultiLotCompare: !!obj.isMultiLotCompare,
          isDutLevel: !!obj.isDutLevel,
        }
      : undefined;
  return {
    mode: obj.mode as JbReplyMode,
    confidence: obj.confidence === "high" ? "high" : "low",
    params,
    flags,
  };
```

- [ ] **Step 3c: `jbRouteResolver.ts` 重写 async 入口**(66-88 行整体替换)

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
  if (base.mode !== "generic" || !isAmbiguous(q)) return base; // 高置信快路
  const r = await callJbIntentClassifier(q, ctx, agentConfig, deps);
  if (!r) {
    return { ...base, source: "default", confidence: "low", reason: "LLM 分类失败,降级 generic" };
  }
  return {
    ...base,
    mode: r.mode,
    source: "llm",
    confidence: r.confidence,
    params: { ...base.params, ...r.params },
    reason: `LLM 分类 → ${r.mode}`,
    // LLM 返回 flag 则采用,否则继承正则 base
    isMultiCardCompare: r.flags?.isMultiCardCompare ?? base.isMultiCardCompare,
    isMultiLotCompare: r.flags?.isMultiLotCompare ?? base.isMultiLotCompare,
    isDutLevel: r.flags?.isDutLevel ?? base.isDutLevel,
  };
}

/** @deprecated 旧名,等价 classifyJbIntent。 */
export const resolveJbRouteAsync = classifyJbIntent;
```

- [ ] **Step 4: 跑测试确认通过 + 类型**

Run: `cd pcr-ai-api && npx tsx --test test/jbRouteResolver.test.ts test/agentLoop.test.ts && npm run typecheck`
Expected: PASS(`agentLoop.ts:932` 仍调 `resolveJbRouteAsync` alias,编译通过)。

- [ ] **Step 5: 提交**

```bash
git add pcr-ai-api/src/lib/agent/jbIntentClassifier.ts pcr-ai-api/src/lib/agent/jbRouteResolver.ts pcr-ai-api/test/jbRouteResolver.test.ts
git commit -m "feat(agent): classifyJbIntent 三段式产出含flag的单一决策(LLM 扩出flag)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: 消费点改读 decision(收口 bail)

`emitDeterministicJbTablesReply` 已在 932 行算出 `decision`;把 940/954 两处 inline 谓词改读 `decision.*`。equipment 路由 1557 改读 `resolveJbRoute(userQuestion).isDutLevel`(同步,行为不变,但谓词来源已集中)。

**Files:**
- Modify: `pcr-ai-api/src/lib/agent/agentLoop.ts:940,954,1557`
- Test: `pcr-ai-api/test/agentLoop.test.ts`(已有 multiCard/multiLot/equipment bail 回归覆盖)

**Interfaces:**
- Consumes: `JbRouteDecision`(Task 2/3),`resolveJbRoute`(已 import)

- [ ] **Step 1: 改 940 行**(多卡 bail)

把:
```ts
  if (isMultiCardComparisonQuestion(userQuestion)) {
```
改为:
```ts
  if (decision.isMultiCardCompare) {
```

- [ ] **Step 2: 改 954 行**(多 lot bail)

把:
```ts
    if (isMultiLotComparisonQuestion(userQuestion) || !lotNamedInQuestion) {
```
改为:
```ts
    if (decision.isMultiLotCompare || !lotNamedInQuestion) {
```

- [ ] **Step 3: 改 1557 行**(equipment DUT bail)

把:
```ts
  if (equipmentRouteDutLevelBail(userQuestion)) {
```
改为:
```ts
  if (resolveJbRoute(userQuestion).isDutLevel) {
```

> `resolveJbRoute` 已在 `agentLoop.ts` 顶部从 `jbRouteResolver.js` import(105 行)。若 `isMultiCardComparisonQuestion`/`isMultiLotComparisonQuestion`/`equipmentRouteDutLevelBail` 的 import 变为未使用,删除对应 import 名以过 lint/typecheck。

- [ ] **Step 4: 跑测试确认通过 + 类型**

Run: `cd pcr-ai-api && npx tsx --test test/agentLoop.test.ts && npm run typecheck`
Expected: PASS —— 原有 multiCard/multiLot/equipment 三类 bail 回归断言全绿(行为等价)。

- [ ] **Step 5: 提交**

```bash
git add pcr-ai-api/src/lib/agent/agentLoop.ts
git commit -m "refactor(agent): 三处 JB bail 收口到 decision,删除 inline 谓词调用

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: 黄金集 `routing-golden.ts`(种子自真实日志)

声明式标注表,问句取自真实 session 日志,正确答案由我们定义。

**Files:**
- Create: `pcr-ai-api/test/eval/scenarios/routing-golden.ts`
- Test: 自带断言通过 `allScenarios`(Task 6 挂入)

**Interfaces:**
- Produces: `export interface GoldenCase { question: string; expected: { mode: JbReplyMode; focusBin?: number; isMultiCardCompare: boolean; isMultiLotCompare: boolean; isDutLevel: boolean }; seed: string }`
- Produces: `export const routingGolden: GoldenCase[]`

- [ ] **Step 1: 新建文件,写入下列 ≥20 条(均来自真实日志/已知踩坑),并按同格式从 `桌面 New folder (3)` 的 md 与 `test/eval/scenarios/routing.scenarios.ts` 的 seed 补足至 ≥30 条**

```ts
import type { JbReplyMode } from "../../../src/lib/agent/agentJbDeterministicReply.js";

export interface GoldenCase {
  question: string;
  expected: {
    mode: JbReplyMode;
    focusBin?: number;
    isMultiCardCompare: boolean;
    isMultiLotCompare: boolean;
    isDutLevel: boolean;
  };
  seed: string;
}

const F = (over: Partial<GoldenCase["expected"]> & { mode: JbReplyMode }): GoldenCase["expected"] => ({
  isMultiCardCompare: false,
  isMultiLotCompare: false,
  isDutLevel: false,
  ...over,
});

export const routingGolden: GoldenCase[] = [
  { question: "n55z 哪个卡测出bin35 多", expected: F({ mode: "bin_card_attribution", focusBin: 35 }), seed: "log mqygf9mq turn1 所答非所问" },
  { question: "BIN35 集中在哪张卡", expected: F({ mode: "bin_card_attribution", focusBin: 35 }), seed: "SEC_BIN_ON_CARD" },
  { question: "各探针卡 BIN35 颗数对比", expected: F({ mode: "bin_card_attribution", focusBin: 35 }), seed: "SEC_BIN_ON_CARD" },
  { question: "DR44436.1W 用几号卡测试的", expected: F({ mode: "equipment" }), seed: "routing.scenarios route-equipment-single-lot" },
  { question: "都测试了什么lot", expected: F({ mode: "lot_listing" }), seed: "P-B routing.scenarios" },
  { question: "9416-04 最近两个月测试的lot 列出来", expected: F({ mode: "lot_listing" }), seed: "log mqygf9mq turn3" },
  { question: "每片坏die情况", expected: F({ mode: "per_slot_bin_ranking" }), seed: "routing.scenarios route-per-slot-bin" },
  { question: "把这4张probecard的测试情况做对比", expected: F({ mode: "generic", isMultiCardCompare: true }), seed: "P-C 多卡对比" },
  { question: "这几个lot分别用什么卡", expected: F({ mode: "generic", isMultiLotCompare: true }), seed: "多lot bail" },
  { question: "这lot哪些die是嫌疑die", expected: F({ mode: "equipment", isDutLevel: true }), seed: "equipment DUT bail" },
  { question: "DR44435.1C 各片良率", expected: F({ mode: "slot_pass_yield" }), seed: "log mqygf9mq turn1 单lot良率" },
  { question: "DR44435.1C 这批用的什么机台", expected: F({ mode: "tester_machine" }), seed: "tester_machine" },
  { question: "DR44435.1C BIN7 按片趋势", expected: F({ mode: "bin_trend", focusBin: 7 }), seed: "bin_trend" },
  { question: "DR44435.1C 测试中断了几次", expected: F({ mode: "interrupt_count" }), seed: "interrupt_count" },
  { question: "DR44435.1C 概况", expected: F({ mode: "lot_overview" }), seed: "lot_overview" },
  { question: "DR44435.1C 第3片wafer坏bin", expected: F({ mode: "single_slot" }), seed: "single_slot" },
  { question: "N55Z device 各 lot 良率 top5", expected: F({ mode: "lot_yield_ranking" }), seed: "lot_yield_ranking" },
  { question: "哪张卡良率最低", expected: F({ mode: "card_yield_compare" }), seed: "card_yield_compare" },
  { question: "9416-03 9416-04 两张卡对比坏die", expected: F({ mode: "generic", isMultiCardCompare: true }), seed: "≥2 卡号" },
  { question: "如果两张卡都偏低下一步怎么排查", expected: F({ mode: "generic" }), seed: "条件性推理→generic" },
];
```

> 标注权威:遇到 mode 取值不确定时,以 `detectJbReplyMode` 当前对该问句的**期望正确**行为为准(由人定义),并在 `seed` 注明依据;不要照抄日志里的错误回答。

- [ ] **Step 2: 类型自检**

Run: `cd pcr-ai-api && npm run typecheck`
Expected: PASS(纯数据,无逻辑)。

- [ ] **Step 3: 提交**

```bash
git add pcr-ai-api/test/eval/scenarios/routing-golden.ts
git commit -m "test(agent): JB 路由黄金集(真实日志种子,≥30条标注)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: 纯正则打分器 `routingGoldenScore.ts`(不挂 allScenarios)

对黄金集跑纯正则,产出 `{ total, passed, failures }` 与逐条 diff,供 Task 7 的 baseline 闸门消费。

> **关键(计划修正 2026-06-29):** **不**把 58 条逐条断言挂进 `allScenarios`。黄金集**刻意含「正则不命中、待 LLM 覆盖」的发散条目**(见 Task 5),而 [`agentEval.test.ts`](../../../pcr-ai-api/test/agentEval.test.ts) 对 allScenarios 断言 `failures===0` —— 挂进去会让发散条目直接把 `npm test` 搞红。CI 对黄金集的硬约束只有两条:**`total≥30`**(本 Task)+ **baseline 零回退**(Task 7);发散条目由 Task 7 的 `live` 混合测试覆盖。

**Files:**
- Create: `pcr-ai-api/test/eval/routingGoldenScore.ts`
- Test: `pcr-ai-api/test/agentEval.test.ts`

**Interfaces:**
- Consumes: `routingGolden`(Task 5),`resolveJbRoute`(Task 2)
- Produces:
  - `export function scoreRegexOnGolden(): { total: number; passed: number; failures: { question: string; got: string; want: string }[] }`

- [ ] **Step 1: 写失败测试**(`test/agentEval.test.ts` 新增)

```ts
test("黄金集:纯正则打分可用且无崩溃", async () => {
  const { scoreRegexOnGolden } = await import("./eval/routingGoldenScore.js");
  const r = scoreRegexOnGolden();
  assert.ok(r.total >= 30, `黄金集应≥30条,实际 ${r.total}`);
});
```

- [ ] **Step 2: 跑确认失败**

Run: `cd pcr-ai-api && npx tsx --test test/agentEval.test.ts`
Expected: FAIL —— 找不到 `./eval/routingGoldenScore.js`。

- [ ] **Step 3: 新建 `test/eval/routingGoldenScore.ts`**

```ts
import { routingGolden } from "./scenarios/routing-golden.js";
import { resolveJbRoute } from "../../src/lib/agent/jbRouteResolver.js";

function regexDecisionMatches(q: string, want: (typeof routingGolden)[number]["expected"]) {
  const d = resolveJbRoute(q);
  const got = {
    mode: d.mode,
    isMultiCardCompare: d.isMultiCardCompare,
    isMultiLotCompare: d.isMultiLotCompare,
    isDutLevel: d.isDutLevel,
  };
  const okMode = got.mode === want.mode;
  const okFlags =
    got.isMultiCardCompare === want.isMultiCardCompare &&
    got.isMultiLotCompare === want.isMultiLotCompare &&
    got.isDutLevel === want.isDutLevel;
  return { pass: okMode && okFlags, got, };
}

export function scoreRegexOnGolden(): {
  total: number;
  passed: number;
  failures: { question: string; got: string; want: string }[];
} {
  const failures: { question: string; got: string; want: string }[] = [];
  let passed = 0;
  for (const c of routingGolden) {
    const r = regexDecisionMatches(c.question, c.expected);
    if (r.pass) passed++;
    else failures.push({ question: c.question, got: JSON.stringify(r.got), want: JSON.stringify(c.expected) });
  }
  return { total: routingGolden.length, passed, failures };
}
```

> 注意:**不导出** `goldenRegexScenarios`、**不 import** `EvalScenario`/`ok`/`fail` —— 本文件只做纯打分,不向 allScenarios 注入逐条断言(理由见本 Task 顶部"关键"框)。

- [ ] **Step 4: 跑确认通过**

Run: `cd pcr-ai-api && npx tsx --test test/agentEval.test.ts`
Expected: PASS(`total≥30` 断言绿)。可临时 `console.log(scoreRegexOnGolden().passed)` 看纯正则在黄金集上的当前命中数 —— 命中数 < total 是**预期**的:差额就是"正则覆盖不到、待 LLM 兜底"的发散集。**不改正则去硬凑这些条目**;它们由 Task 7 `live` 混合测试覆盖。看完删掉临时 log。

- [ ] **Step 5: 提交**

```bash
git add pcr-ai-api/test/eval/routingGoldenScore.ts pcr-ai-api/test/agentEval.test.ts
git commit -m "test(agent): 黄金集纯正则打分器(scoreRegexOnGolden)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: 闸门 —— 锁 baseline 零回退 + live 混合对比

把"纯正则当前在黄金集上的通过集"固化为 baseline 快照;CI 断言纯正则**不低于**该快照(防后续改动悄悄回退);`live` 断言混合路由在 baseline 已过条目上零回退。

**Files:**
- Modify: `pcr-ai-api/test/agentEval.test.ts`
- Modify: `pcr-ai-api/test/eval/routingGoldenScore.ts`(加 baseline 常量 + live 比较器)

**Interfaces:**
- Consumes: `scoreRegexOnGolden`(Task 6),`classifyJbIntent`(Task 3)
- Produces: `export const REGEX_BASELINE_PASS_IDS: string[]`(锁定快照);`export async function scoreHybridOnGolden(agentConfig): Promise<{ regressions: string[] }>`

- [ ] **Step 1: 先跑一次取当前纯正则通过的 question 列表,写入 baseline 常量**

Run(打印当前纯正则**通过**的问句原文 = 全集去掉 failures):
```bash
cd pcr-ai-api && npx tsx -e "Promise.all([import('./test/eval/routingGoldenScore.js'),import('./test/eval/scenarios/routing-golden.js')]).then(([s,g])=>{const fail=new Set(s.scoreRegexOnGolden().failures.map(f=>f.question));console.log(JSON.stringify(g.routingGolden.map(c=>c.question).filter(q=>!fail.has(q)),null,2))})"
```

> 把打印出的**当前通过**的 `question` 原文数组,逐条粘进 `routingGoldenScore.ts`:

```ts
/** 锁定:这些问句纯正则当前已正确命中,任何后续改动不得使其回退。 */
export const REGEX_BASELINE_PASS_QUESTIONS: string[] = [
  // ← 粘入 Step 1 跑出的、当前 pass 的 question 原文(逐条)
];
```

- [ ] **Step 2: 加 baseline 守卫测试**(`test/agentEval.test.ts`)

```ts
test("闸门:纯正则在 baseline 问句上零回退", async () => {
  const { scoreRegexOnGolden, REGEX_BASELINE_PASS_QUESTIONS } = await import("./eval/routingGoldenScore.js");
  const failingNow = new Set(scoreRegexOnGolden().failures.map((f) => f.question));
  const regressed = REGEX_BASELINE_PASS_QUESTIONS.filter((q) => failingNow.has(q));
  assert.deepEqual(regressed, [], `baseline 问句回退: ${regressed.join(" | ")}`);
});
```

- [ ] **Step 3: 加 live 混合对比器**(`routingGoldenScore.ts`)

```ts
import { classifyJbIntent } from "../../src/lib/agent/jbRouteResolver.js";
import type { AgentConfig } from "../../src/lib/agent/agentConfig.js";

/** live:对 baseline 已过的问句,断言混合路由(开 flag)mode 仍命中,产出回退清单。 */
export async function scoreHybridOnGolden(agentConfig: AgentConfig): Promise<{ regressions: string[] }> {
  process.env.JB_LLM_INTENT_CLASSIFIER = "true";
  const regressions: string[] = [];
  try {
    for (const c of routingGolden) {
      const d = await classifyJbIntent(c.question, {}, agentConfig);
      if (d.mode !== c.expected.mode) regressions.push(`${c.question} → ${d.mode}≠${c.expected.mode}`);
    }
  } finally {
    delete process.env.JB_LLM_INTENT_CLASSIFIER;
  }
  return { regressions };
}
```

- [ ] **Step 4: 加 live 闸门测试**(默认 skip,`AGENT_EVAL_LIVE=1` 才跑)

```ts
test("闸门[live]:混合路由对黄金集零 mode 回退", { skip: process.env.AGENT_EVAL_LIVE !== "1" }, async () => {
  const { scoreHybridOnGolden } = await import("./eval/routingGoldenScore.js");
  const cfg = { subAgentModel: process.env.AGENT_SUBAGENT_MODEL, apiKey: process.env.AGENT_API_KEY } as any;
  const { regressions } = await scoreHybridOnGolden(cfg);
  assert.deepEqual(regressions, [], `混合路由回退: ${regressions.join(" | ")}`);
});
```

- [ ] **Step 5: 跑确认通过(CI 部分)**

Run: `cd pcr-ai-api && npx tsx --test test/agentEval.test.ts && npm run typecheck`
Expected: PASS(live 测试 skip;baseline 守卫绿)。

- [ ] **Step 6: 全量回归**

Run: `cd pcr-ai-api && npm test`
Expected: 全绿,现有 routing/summary/factcheck/empty/insight scenario 不回退;`JB_LLM_INTENT_CLASSIFIER` 默认仍 off。

- [ ] **Step 7: 更新 DEV_LOG / TODO 并提交**(commit-with-docs)

在 `docs/DEV_LOG.md` 顶部加本期条目(阶段一+二:单一语义决策 + 黄金集闸门,文件清单,测试数);`docs/TODO.md` 标 ✅ 并登记 Phase 2(阶段三)待办。

```bash
git add pcr-ai-api/test/agentEval.test.ts pcr-ai-api/test/eval/routingGoldenScore.ts docs/DEV_LOG.md docs/TODO.md
git commit -m "test(agent): 黄金集闸门(锁正则baseline零回退 + live混合对比)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## 收尾(非 Task,人工决策)

- 闸门长期绿 + 真库观察无回退后,**单独一个 commit** 把 `classifyJbIntent` 里 `process.env.JB_LLM_INTENT_CLASSIFIER !== "true"` 的默认翻为开启(或在部署 env 设),可秒回退。本计划**不翻**。
- Phase 2(阶段三:决策驱动服务端确定性发查询,根治 turn1 选错工具)另开 spec,前置:黄金集 ≥80 条且混合误分类率 < 阈值。

---

## 自审记录

- **Spec 覆盖**:阶段一(`classifyJbIntent` 单一决策=Task 2/3)、阶段二(三处 bail 收口=Task 4)、黄金集(Task 5)、打分器+闸门(Task 6/7)、flag 默认 off(全程)、不碰 SQL/dummy(Global Constraints)、Phase 2 边界(收尾段)——均有对应。
- **占位扫描**:无 TBD;Task 5/Task 7 Step 1 的"补足至≥30/粘入 baseline"为针对**具名文件**的确定性操作,非占位。
- **类型一致**:`JbRouteDecision` 三字段名 `isMultiCardCompare/isMultiLotCompare/isDutLevel` 在 Task 2/3/4/6 一致;`classifyJbIntent` 签名在 Task 3 定义、Task 7 消费一致;`extractJbIntentFlags` 返回键与 decision 字段同名。
