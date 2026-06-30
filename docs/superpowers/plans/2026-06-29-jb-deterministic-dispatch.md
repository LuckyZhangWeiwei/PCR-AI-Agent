# 阶段三:决策驱动确定性派发 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给缺失的跨实体确定性 mode（`bin_card_attribution` / `lot_yield_ranking` / `card_yield_compare`）补 pre-LLM 直连路由,由 `classifyJbIntent` 高置信决策驱动、服务端直发查询、跳过 LLM 选工具,根治 turn1 选错工具——全部藏 `JB_DETERMINISTIC_DISPATCH`（默认 OFF）后。

**Architecture:** 新增纯声明式派发表模块 + 一条 `tryRunSemanticDispatchDirectRoute` 挂进现有 `PRE_LLM_DIRECT_ROUTES`（末位兜底）。路由内:flag 门控 → `classifyJbIntent` 高置信门控 → 查表取 {queryTool, args} → `runTool` 直发 → 渲染（aggregate 走 `renderAggregateJbBinsResult`;query 走 `emitDeterministicJbTablesReply`）。空/错 → `return false` 落回 LLM。

**Tech Stack:** Node + TypeScript;测试 `tsx --test`;eval harness（`test/eval/`）。

## Global Constraints

- 纯路由/派发层,**不碰 SQL / WHERE / 排序 / limit / 聚合维度 / 响应形状** —— 不触发 dummy-parity。
- **不动** `classifyIntent`（prompt 段）与 YM 侧;不动任何 `*Dummy.ts` / `src/routes/` / Oracle。
- **`JB_DETERMINISTIC_DISPATCH` 默认 OFF**;OFF 时新路由整体短路 `return false`,生产行为零变更。**本计划不翻默认**。
- **仅 `decision.confidence === "high"` 才确定性派发**;否则 `return false` 交 LLM。
- 查询空 / 渲染失败 → `return false`（落回 LLM,绝不 dead-end）。
- 每个 Task 结束:`cd pcr-ai-api && npm run typecheck` + 该 Task 相关 `npm test` 子集通过。
- **COMMIT HYGIENE**:仅以显式 `git add <path>` 暂存本 Task 文件;**禁用 `git commit -a`/`-am`**;不暂存 `.claude/settings*.json` 或 `.superpowers/`。
- commit message 结尾:`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。
- 当前分支 `feat/jb-route-resolver`。

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/lib/agent/agentSemanticDispatchTable.ts` | 纯声明式派发表 + 计划求解(无副作用,可单测) | 新建 |
| `src/lib/agent/agentLoop.ts` | `tryRunSemanticDispatchDirectRoute` + 注册进 `PRE_LLM_DIRECT_ROUTES` | 修改 |
| `pcr-ai-api/.env.example` | `JB_DETERMINISTIC_DISPATCH=false` + 注释 | 修改 |
| `test/eval/scenarios/routing-golden.ts` | 扩到 ≥80(跨实体变体) | 修改 |
| `test/eval/routingGoldenScore.ts` + `test/agentEval.test.ts` | 派发正确性 CI 测试 + 误分类率(live)断言 | 修改 |
| `test/agentSemanticDispatchTable.test.ts` | 派发表单测 | 新建 |

---

### Task 1: 派发表模块 `agentSemanticDispatchTable.ts`（纯逻辑）

把"mode → 查哪个工具 + 怎么构造 args"做成一张声明式表 + 一个求解函数,纯函数、可单测,与路由副作用解耦。

**Files:**
- Create: `pcr-ai-api/src/lib/agent/agentSemanticDispatchTable.ts`
- Test: `pcr-ai-api/test/agentSemanticDispatchTable.test.ts`

**Interfaces:**
- Consumes:
  - `JbRouteDecision`（`./jbRouteResolver.js`,含 `mode` / `confidence` / `params.focusBin` 等）
  - `buildJbScopeArgs(userQuestion, history, lastToolName)`（`./agentQueryScope.js`,返回 `Record<string,unknown>|null`,含 `device` 等）
  - `scopedBadBinAggregateArgsFromUser(userText, history)`（`./agentJbScopedBadBinRoute.js`,返回 `Record<string,unknown>|null`）
  - `ChatMessage`（`./agentHistory.js`）
- Produces:
  - `export type DispatchRenderKind = "aggregate" | "emitTables";`
  - `export interface DispatchResult { queryTool: "aggregate_jb_bins" | "query_jb_bins"; args: Record<string, unknown>; renderKind: DispatchRenderKind; }`
  - `export function resolveDispatch(decision: JbRouteDecision, userQuestion: string, history: ChatMessage[]): DispatchResult | null`

- [ ] **Step 1: 写失败测试**（`test/agentSemanticDispatchTable.test.ts`）

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { resolveDispatch } from "../src/lib/agent/agentSemanticDispatchTable.js";
import type { JbRouteDecision } from "../src/lib/agent/jbRouteResolver.js";

function dec(over: Partial<JbRouteDecision>): JbRouteDecision {
  return {
    mode: "generic", source: "regex", confidence: "high",
    params: {}, reason: "test",
    isMultiCardCompare: false, isMultiLotCompare: false, isDutLevel: false,
    ...over,
  };
}

test("resolveDispatch: bin_card_attribution → aggregate_jb_bins groupBy bin,cardId", () => {
  const r = resolveDispatch(
    dec({ mode: "bin_card_attribution", params: { focusBin: 35 } }),
    "n55z 哪个卡测出bin35 多", []);
  assert.ok(r);
  assert.equal(r!.queryTool, "aggregate_jb_bins");
  assert.equal(r!.renderKind, "aggregate");
  assert.equal(r!.args["groupBy"], "bin,cardId");
});

test("resolveDispatch: 低置信 → null", () => {
  const r = resolveDispatch(
    dec({ mode: "bin_card_attribution", confidence: "low" }),
    "哪个卡 bin35 多", []);
  assert.equal(r, null);
});

test("resolveDispatch: 不在派发表的 mode → null", () => {
  const r = resolveDispatch(dec({ mode: "lot_overview" }), "DR44435.1C 概况", []);
  assert.equal(r, null);
});

test("resolveDispatch: lot_yield_ranking → query_jb_bins + emitTables", () => {
  const r = resolveDispatch(
    dec({ mode: "lot_yield_ranking" }),
    "WC13N55Z 各 lot 良率 top5", []);
  // device 解析依赖文本/历史;若解析不到 device 则 null(由 buildJbScopeArgs 决定)
  if (r) {
    assert.equal(r.queryTool, "query_jb_bins");
    assert.equal(r.renderKind, "emitTables");
  }
});
```

- [ ] **Step 2: 跑确认失败**

Run: `cd pcr-ai-api && npx tsx --test test/agentSemanticDispatchTable.test.ts`
Expected: FAIL —— 找不到 `agentSemanticDispatchTable.js`。

- [ ] **Step 3: 实现 `agentSemanticDispatchTable.ts`**

```ts
import type { JbRouteDecision } from "./jbRouteResolver.js";
import type { ChatMessage } from "./agentHistory.js";
import { buildJbScopeArgs } from "./agentQueryScope.js";
import { scopedBadBinAggregateArgsFromUser } from "./agentJbScopedBadBinRoute.js";

export type DispatchRenderKind = "aggregate" | "emitTables";

export interface DispatchResult {
  queryTool: "aggregate_jb_bins" | "query_jb_bins";
  args: Record<string, unknown>;
  renderKind: DispatchRenderKind;
}

/** 只对这三个跨实体 mode 做确定性派发(阶段三第一期 spec §4)。 */
function planFor(
  decision: JbRouteDecision,
  userQuestion: string,
  history: ChatMessage[]
): DispatchResult | null {
  switch (decision.mode) {
    case "bin_card_attribution": {
      // 复用 scopedBadBin 的 scope 解析(device/mask/tester/时间窗),再换成 bin,cardId 维度
      const base = scopedBadBinAggregateArgsFromUser(userQuestion, history);
      if (!base) return null;
      const args = { ...base, groupBy: "bin,cardId" };
      return { queryTool: "aggregate_jb_bins", args, renderKind: "aggregate" };
    }
    case "lot_yield_ranking":
    case "card_yield_compare": {
      const args = buildJbScopeArgs(userQuestion, history, "query_jb_bins");
      if (!args || !String(args["device"] ?? "").trim()) return null;
      return { queryTool: "query_jb_bins", args, renderKind: "emitTables" };
    }
    default:
      return null;
  }
}

export function resolveDispatch(
  decision: JbRouteDecision,
  userQuestion: string,
  history: ChatMessage[]
): DispatchResult | null {
  if (decision.confidence !== "high") return null; // 红线:不确定不抢
  return planFor(decision, userQuestion, history);
}
```

> 注:`scopedBadBinAggregateArgsFromUser` 默认产出 `groupBy:"bin"`;此处覆盖为 `"bin,cardId"`,其余 scope（device/tester/testEndFrom-To）保留。若它返回 `null`（无法解析 scope）→ `resolveDispatch` 返回 `null`，路由落回 LLM。

- [ ] **Step 4: 跑确认通过 + 类型**

Run: `cd pcr-ai-api && npx tsx --test test/agentSemanticDispatchTable.test.ts && npm run typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add pcr-ai-api/src/lib/agent/agentSemanticDispatchTable.ts pcr-ai-api/test/agentSemanticDispatchTable.test.ts
git commit -m "feat(agent): 阶段三派发表 resolveDispatch(纯逻辑,三跨实体 mode)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `tryRunSemanticDispatchDirectRoute` + 注册（agentLoop.ts）

路由置于 `agentLoop.ts`（需调用未导出的 `emitDeterministicJbTablesReply` 与已导出的 `renderAggregateJbBinsResult`,二者均在本文件,避免循环 import）。

**Files:**
- Modify: `pcr-ai-api/src/lib/agent/agentLoop.ts`（新增函数;`PRE_LLM_DIRECT_ROUTES` 末位追加;`.js` import 加 `resolveDispatch`）
- Modify: `pcr-ai-api/.env.example`
- Test: `pcr-ai-api/test/agentLoop.test.ts`

**Interfaces:**
- Consumes: `resolveDispatch`（Task 1）;`classifyJbIntent`（`jbRouteResolver.js`）;`renderAggregateJbBinsResult` / `emitDeterministicJbTablesReply` / `runTool` / `parseJbToolPayload` / `resolveJbToolPayload`（本文件已有,见模板 `tryRunScopedBadBinDirectRoute` `agentLoop.ts:1359`、`tryRunLotOverviewDirectRoute` `agentLoop.ts:1170`）
- Produces: `async function tryRunSemanticDispatchDirectRoute(sessionId, userQuestion, agentConfig, emit): Promise<boolean>`

- [ ] **Step 1: 写失败测试**（`test/agentLoop.test.ts` 新增;验证 flag-off 与低置信短路,不需真 LLM/DB）

```ts
test("tryRunSemanticDispatchDirectRoute: flag 未开时整体短路 return false", async () => {
  delete process.env.JB_DETERMINISTIC_DISPATCH;
  const { tryRunSemanticDispatchDirectRoute } = await import("../src/lib/agent/agentLoop.js");
  const sid = "t-flag-off-" + Date.now();
  const handled = await tryRunSemanticDispatchDirectRoute(
    sid, "n55z 哪个卡测出bin35 多", { } as any, () => {});
  assert.equal(handled, false);
});
```

- [ ] **Step 2: 跑确认失败**

Run: `cd pcr-ai-api && npx tsx --test test/agentLoop.test.ts`
Expected: FAIL —— `tryRunSemanticDispatchDirectRoute` 未导出。

- [ ] **Step 3: 在 `agentLoop.ts` 实现并导出函数**（放在 `tryRunPerSlotBinRankingDirectRoute` 之后;顶部 `./agentSemanticDispatchTable.js` import 加 `resolveDispatch`、type `DispatchResult`）

```ts
export async function tryRunSemanticDispatchDirectRoute(
  sessionId: string,
  userQuestion: string,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void
): Promise<boolean> {
  if (process.env.JB_DETERMINISTIC_DISPATCH !== "true") return false; // dark-launch
  const history = getHistory(sessionId);
  const lastToolName = lastToolMessage(history)?.name;
  const cachedLot =
    typeof getJbToolRawJson(sessionId) === "string" ? undefined : undefined; // 无需缓存 lot
  const decision = await resolveJbRouteAsync(
    userQuestion, { lastToolName, cachedLot }, agentConfig, undefined, history
  );
  const plan = resolveDispatch(decision, userQuestion, history);
  if (!plan) return false; // 低置信 / 不在派发表 → 交 LLM

  emit({ type: "status", message: "正在按意图直发查询…" });
  emit({ type: "tool_start", name: plan.queryTool, args: plan.args });
  let raw = "";
  let jbCache: string | undefined;
  try {
    const result = await runTool(plan.queryTool, plan.args, {
      toolResultMaxChars: agentConfig.toolResultMaxChars,
      history,
      onJbBinsWrapped: (wrapped) => { jbCache = storeJbQuerySessionCache(sessionId, wrapped); },
    });
    raw = typeof result === "string" ? result : JSON.stringify(result);
    emit({ type: "tool_result", name: plan.queryTool, summary: raw.slice(0, 200) });
    appendMessages(sessionId, {
      role: "tool", name: plan.queryTool,
      tool_call_id: `jb_dispatch_${Date.now()}`,
      content: raw.slice(0, agentConfig.toolResultMaxChars),
    });
  } catch {
    return false; // 查询失败 → 落回 LLM(不 dead-end)
  }

  if (plan.renderKind === "aggregate") {
    const scopeLabel = buildScopeLabelFromAggregateArgs(plan.args);
    const rendered = renderAggregateJbBinsResult(raw, userQuestion, scopeLabel);
    if (!rendered?.table?.trim()) return false; // 渲染空 → 落回 LLM
    const block =
      (rendered.withDataTitle ? `${DETERMINISTIC_DATA_SECTION_TITLE}\n\n` : "") +
      rendered.table +
      (rendered.commentaryNote
        ? `\n\n${DETERMINISTIC_COMMENTARY_SECTION_TITLE}\n\n${rendered.commentaryNote}`
        : "");
    emitTextInChunks(block, emit);
    appendMessages(sessionId, { role: "assistant", content: block });
    emit({ type: "done" });
    return true;
  }

  // renderKind === "emitTables": 解析 payload → 现成 mode 分发渲染
  const payload =
    (jbCache ? parseJbToolPayload(jbCache) : null) ??
    resolveJbToolPayload(sessionId, raw);
  if (!payload) return false;
  return emitDeterministicJbTablesReply(sessionId, userQuestion, payload, agentConfig, emit);
}
```

> 实现者:`storeJbQuerySessionCache` / `parseJbToolPayload` / `resolveJbToolPayload` / `buildScopeLabelFromAggregateArgs` / `DETERMINISTIC_DATA_SECTION_TITLE` / `DETERMINISTIC_COMMENTARY_SECTION_TITLE` / `emitTextInChunks` 均已在 agentLoop.ts 可见(被现有路由使用)。若 `cachedLot` 那两行因未用变量报错,直接删掉,`resolveJbRouteAsync` 的 ctx 用 `{ lastToolName }`。

- [ ] **Step 4: 注册进 `PRE_LLM_DIRECT_ROUTES`**（`agentLoop.ts:2715` 数组末位追加,作为兜底,在专用路由之后)

```ts
  const PRE_LLM_DIRECT_ROUTES: Array<typeof tryRunLotListingDirectRoute> = [
    tryRunLotListingDirectRoute,
    tryRunScopedBadBinDirectRoute,
    tryRunLotOverviewDirectRoute,
    tryRunEquipmentDirectRoute,
    tryRunPerSlotBinRankingDirectRoute,
    tryRunSemanticDispatchDirectRoute,
  ];
```

- [ ] **Step 5: `.env.example` 加 flag**（在 `JB_LLM_INTENT_CLASSIFIER=false` 附近,~150 行）

```bash
# 阶段三:决策驱动确定性派发(默认 off)。on 时对高置信跨实体 mode
# (bin_card_attribution/lot_yield_ranking/card_yield_compare)在 LLM 前服务端直发查询。
# 翻 on 前须先在真库验证 LLM 误分类率达标(见 docs/superpowers/specs/2026-06-29-jb-deterministic-dispatch-design.md)。
JB_DETERMINISTIC_DISPATCH=false
```

- [ ] **Step 6: 跑确认通过 + 类型 + 全量**

Run: `cd pcr-ai-api && npx tsx --test test/agentLoop.test.ts && npm run typecheck && npm test`
Expected: PASS;新短路测试绿;全量不回退;`JB_DETERMINISTIC_DISPATCH` 默认未设 → 新路由零生效。

- [ ] **Step 7: 提交**

```bash
git add pcr-ai-api/src/lib/agent/agentLoop.ts pcr-ai-api/.env.example pcr-ai-api/test/agentLoop.test.ts
git commit -m "feat(agent): tryRunSemanticDispatchDirectRoute 决策驱动派发(dark-launch,默认off)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: 黄金集扩到 ≥80（跨实体变体）

**Files:**
- Modify: `pcr-ai-api/test/eval/scenarios/routing-golden.ts`
- Test: 经 `scoreRegexOnGolden`（`test/agentEval.test.ts` 已断言 total≥30,本 Task 把 total 推到 ≥80）

**Interfaces:**
- Consumes / Produces: 同现有 `GoldenCase` / `routingGolden`（追加条目,不改结构）

- [ ] **Step 1: 追加 ≥23 条新案例**（使现有 57 → ≥80）,聚焦三个入表 mode 的口语/同义变体,且**至少 10 条刻意覆盖正则发散**(待 LLM)。每条 `seed` 注明来源。示例(追加进 `routingGolden` 数组,沿用 `F()` helper):

```ts
  { question: "n55z 哪片卡 bin35 出得最多", expected: F({ mode: "bin_card_attribution", focusBin: 35 }), seed: "阶段三 哪片卡变体" },
  { question: "WC13N55Z 哪个探针卡 BIN12 颗数最高", expected: F({ mode: "bin_card_attribution", focusBin: 12 }), seed: "阶段三 探针卡变体" },
  { question: "各卡 bin8 分布对比一下", expected: F({ mode: "bin_card_attribution", focusBin: 8 }), seed: "阶段三 陈述式发散(正则未必命中)" },
  { question: "这个产品哪些 lot 良率最差", expected: F({ mode: "lot_yield_ranking" }), seed: "阶段三 lot_yield 口语" },
  { question: "WC13N55Z 各批次良率从低到高排", expected: F({ mode: "lot_yield_ranking" }), seed: "阶段三 lot_yield 排序" },
  { question: "近期哪几批良率掉得厉害", expected: F({ mode: "lot_yield_ranking" }), seed: "阶段三 lot_yield 发散" },
  { question: "这两张卡哪张良率更差", expected: F({ mode: "card_yield_compare" }), seed: "阶段三 card_yield 二选一" },
  { question: "比一下这几张卡的良率高低", expected: F({ mode: "card_yield_compare" }), seed: "阶段三 card_yield 发散" },
  // …继续补足至总数 ≥80,覆盖既有 16 mode 不失衡;每条 expected 由意图定义,不照抄正则。
```

> 标注权威同 Task 5(阶段一+二):标签是**我们定义的正确答案**;允许部分与当前正则发散(LLM 待覆盖集)。不要为凑正则命中改标签。

- [ ] **Step 2: 跑确认 total≥80 + 类型**

Run: `cd pcr-ai-api && npx tsx --test test/agentEval.test.ts && npm run typecheck`
Expected: PASS;`scoreRegexOnGolden().total ≥ 80`（把 `agentEval.test.ts` 里 `total >= 30` 断言改成 `>= 80`）。

- [ ] **Step 3: 提交**

```bash
git add pcr-ai-api/test/eval/scenarios/routing-golden.ts pcr-ai-api/test/agentEval.test.ts
git commit -m "test(agent): 黄金集扩至≥80(阶段三跨实体变体 + 发散覆盖)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: 派发正确性 CI 测试 + 误分类率(live)断言

**Files:**
- Modify: `pcr-ai-api/test/eval/routingGoldenScore.ts`（加派发正确性纯函数 + 误分类率计算）
- Modify: `pcr-ai-api/test/agentEval.test.ts`（CI 派发断言 + live 误分类率断言）

**Interfaces:**
- Consumes: `routingGolden`、`resolveJbRoute`、`resolveDispatch`（Task 1）、`scoreHybridOnGolden`（阶段一+二）
- Produces:
  - `export function scoreDispatchOnGolden(): { total: number; dispatched: number; failures: {question:string; reason:string}[] }`（纯正则路径:对三个入表 mode 的黄金条目,断言 `resolveJbRoute` 给 high + 正确 mode,且 `resolveDispatch` 产出非空、queryTool/groupBy 正确)
  - `export function hybridMisclassRate(report:{regressions:string[]}, total:number): number`（误分类率 = regressions/total）

- [ ] **Step 1: 写失败测试**（`test/agentEval.test.ts`）

```ts
test("阶段三:派发正确性(纯正则,CI)", async () => {
  const { scoreDispatchOnGolden } = await import("./eval/routingGoldenScore.js");
  const r = scoreDispatchOnGolden();
  // 对高置信入表条目,resolveDispatch 必须产出正确 queryTool;失败清单为空
  assert.deepEqual(r.failures, [], `派发不正确:\n${r.failures.map(f=>f.question+": "+f.reason).join("\n")}`);
});
```

- [ ] **Step 2: 跑确认失败**

Run: `cd pcr-ai-api && npx tsx --test test/agentEval.test.ts`
Expected: FAIL —— `scoreDispatchOnGolden` 未定义。

- [ ] **Step 3: 实现 `scoreDispatchOnGolden` + `hybridMisclassRate`**（`routingGoldenScore.ts` 追加）

```ts
import { resolveDispatch } from "../../src/lib/agent/agentSemanticDispatchTable.js";

const DISPATCH_MODES = new Set(["bin_card_attribution","lot_yield_ranking","card_yield_compare"]);

export function scoreDispatchOnGolden(): {
  total: number; dispatched: number; failures: { question: string; reason: string }[];
} {
  const failures: { question: string; reason: string }[] = [];
  let dispatched = 0;
  for (const c of routingGolden) {
    if (!DISPATCH_MODES.has(c.expected.mode)) continue;
    const d = resolveJbRoute(c.question); // 纯正则;源为 "regex" 视为 high
    if (d.mode !== c.expected.mode) continue; // 正则未命中=已知发散,留 LLM,不算派发失败
    const plan = resolveDispatch(d, c.question, []);
    if (!plan) { failures.push({ question: c.question, reason: "高置信却 resolveDispatch 返 null" }); continue; }
    if (c.expected.mode === "bin_card_attribution" && plan.args["groupBy"] !== "bin,cardId") {
      failures.push({ question: c.question, reason: `groupBy=${plan.args["groupBy"]}≠bin,cardId` }); continue;
    }
    dispatched++;
  }
  return { total: routingGolden.filter(c=>DISPATCH_MODES.has(c.expected.mode)).length, dispatched, failures };
}

export function hybridMisclassRate(report: { regressions: string[] }, total: number): number {
  return total === 0 ? 0 : report.regressions.length / total;
}
```

> 注:`resolveJbRoute` 返回的 `confidence` 恒为 `"high"`（纯正则源）;CI 测试只对"正则已命中正确 mode"的条目验派发,正则未命中的发散条目不在 CI 范围(由 live 误分类率覆盖)。

- [ ] **Step 4: 加 live 误分类率断言**（`test/agentEval.test.ts`,默认 skip）

```ts
test("阶段三[live]:混合路由误分类率 ≤ 2%", { skip: process.env.AGENT_EVAL_LIVE !== "1" }, async () => {
  const { scoreHybridOnGolden, hybridMisclassRate } = await import("./eval/routingGoldenScore.js");
  const cfg = { subAgentModel: process.env.AGENT_SUBAGENT_MODEL, apiKey: process.env.AGENT_API_KEY } as any;
  const report = await scoreHybridOnGolden(cfg);
  const { routingGolden } = await import("./eval/scenarios/routing-golden.js");
  const rate = hybridMisclassRate(report, routingGolden.length);
  assert.ok(rate <= 0.02, `误分类率 ${(rate*100).toFixed(1)}% > 2%:\n${report.regressions.join("\n")}`);
});
```

- [ ] **Step 5: 跑确认通过(CI 部分)+ 全量**

Run: `cd pcr-ai-api && npx tsx --test test/agentEval.test.ts && npm run typecheck && npm test`
Expected: PASS;派发正确性绿;live 误分类率 skip;全量不回退。

- [ ] **Step 6: 提交**

```bash
git add pcr-ai-api/test/eval/routingGoldenScore.ts pcr-ai-api/test/agentEval.test.ts
git commit -m "test(agent): 派发正确性 CI 闸门 + 误分类率≤2% live 断言

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: 收尾 —— DEV_LOG / TODO + flag 默认 OFF 回归确认

**Files:**
- Modify: `docs/DEV_LOG.md`、`docs/TODO.md`

- [ ] **Step 1: 确认 flag 默认 OFF 行为零变更**

Run: `cd pcr-ai-api && npm test`（不设 `JB_DETERMINISTIC_DISPATCH`）
Expected: 全量绿;阶段一+二 既有测试 + 新短路测试全过。在报告记录全量 pass/fail 计数。

- [ ] **Step 2: 更新 DEV_LOG / TODO**

`docs/DEV_LOG.md` 顶部加阶段三条目(决策驱动派发、三入表 mode、dark-launch JB_DETERMINISTIC_DISPATCH 默认 OFF、黄金集≥80、派发正确性 + 误分类率闸门、文件清单、测试数)。`docs/TODO.md` 标 ✅ 阶段三 BUILD 完成;登记 **FLIP 待办**(用户真库实测误分类率≤2% 后翻默认,Claude 不翻)。

- [ ] **Step 3: 提交**

```bash
git add docs/DEV_LOG.md docs/TODO.md
git commit -m "docs(agent): 阶段三收尾 DEV_LOG/TODO(BUILD 完成,FLIP 留真库验证)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## 收尾(非 Task,人工决策)

- **FLIP**:用户在 Cursor 真库环境跑 `AGENT_EVAL_LIVE=1` 测得误分类率 ≤2% 后,单独 commit 把 `.env` / 默认置 `JB_DETERMINISTIC_DISPATCH=true`。**本计划不翻**。
- card_dut_question / INF 多步派发、单 lot 模式确定性派发:后续另立。

---

## 自审记录

- **Spec 覆盖**:派发表+路由(Task 1/2=spec §3)、三入表 mode(§4)、confidence 高置信门控(Task 1 resolveDispatch)、flag dark-launch 默认 OFF(Task 2 + Global Constraints)、空/错兜底(Task 2)、黄金集≥80(Task 3=§5)、派发正确性 + 误分类率≤2% 闸门(Task 4=§5)、FLIP 留用户(Task 5 + 收尾段=§2)——均有对应。门控统一(§3.2)按 spec §7「flag OFF 不改旧路由门控」,本期仅新增兜底路由、不改 5 条旧路由的 canRunXxx,故不单列 Task(已在 spec 标为 ON 时行为,BUILD 期不动)。
- **占位扫描**:无 TBD;Task 3 的"补足至≥80"为针对具名文件的确定性追加(给了样例 + 标注规则)。
- **类型一致**:`DispatchResult`/`resolveDispatch` 在 Task 1 定义、Task 2/4 消费一致;`queryTool` 取值 `"aggregate_jb_bins"|"query_jb_bins"` 全程一致;`renderKind` `"aggregate"|"emitTables"` 一致;`tryRunSemanticDispatchDirectRoute` 签名与 `PRE_LLM_DIRECT_ROUTES` 元素类型一致。
