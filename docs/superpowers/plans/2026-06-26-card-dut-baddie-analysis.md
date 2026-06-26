# 卡↔DUT↔坏die 关系检测（Phase 1：DUT 集中度）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 Agent 增加「DUT 集中度」检测——判别某坏 BIN 的坏 die 是集中在少数 DUT（探针卡针点问题）还是分散（工艺问题），并关联 CARDID。

**Architecture:** 沿用现有 `clusteredBadBinAlerts` 模式：确定性纯函数检测器（吃 INF `SiteBinPass[]` → 结构化 Insight + 预计算 markdown）→ 由智能触发决定何时拉 INF → 注入确定性 JB 总结，模型只叙述。数字全部服务端算，防幻觉。

**Tech Stack:** Node.js + TypeScript（ESM，`.js` 导入后缀）；测试 `tsx --test` + 评测台 `npm run agent:eval`。

## Global Constraints

- 包目录 `pcr-ai-api/`；所有命令在该目录下执行。
- ESM：模块内相对导入必须带 `.js` 后缀（如 `../outputSiteBinByLot.js`）。
- 复用现有类型：`SiteBinPass` / `SiteBinEntry` / `SiteBinDutEntry`（`src/lib/outputSiteBinByLot.ts`）、`CardByPassIdEntry`（`src/lib/agent/agentJbHistoryCompact.ts`）、`passIdSortLabel`（`src/lib/jbYieldCalc.ts`）。
- **不得在用户可见输出（含 markdown 表头）暴露内部函数/字段名**（query_*/aggregate_*/*Markdown/cardByPassId 等）；评测台已有回归场景。
- 判别阈值：top-DUT 累计占比 **≥ 0.70** → 探针卡；`minTotalDie` 默认 **8**。
- INF 数据慢：仅在触发时拉取，不无脑全跑。
- 改 INF/JB 输出或筛选语义须遵守 dummy-parity（本计划只新增只读检测，不改查询语义）。

---

### Task 1: DUT 集中度检测器（核心纯函数）

**Files:**
- Create: `src/lib/agent/agentDutConcentration.ts`
- Test: `src/lib/agent/agentDutConcentration.ts` 通过 Task 6 的 eval 场景覆盖；本任务用一次性单测文件 `test/agentDutConcentration.test.ts`

**Interfaces:**
- Consumes: `SiteBinPass[]`（`{ passId:number, bins:[{ bin:string, duts:[{dut:number|"single", dieCount:number}] }] }`）；`CardByPassIdEntry[]`（`{ passId:number, cardIds:string[], hasCardChange:boolean }`）。
- Produces:
  - `type DutConcentrationVerdict = "probe_card" | "process" | "inconclusive"`
  - `type DutConcentrationInsight = { bin:number; passId:number; sortLabel:string; cardId:string|null; totalDie:number; topDuts:Array<{dut:number;dieCount:number;share:number}>; topShare:number; verdict:DutConcentrationVerdict; detail:string }`
  - `function buildDutConcentrationInsights(passes: SiteBinPass[], cardByPassId: CardByPassIdEntry[], opts?: { topShareThreshold?:number; minTotalDie?:number; focusBins?:number[] }): DutConcentrationInsight[]`

- [ ] **Step 1: Write the failing test**

`test/agentDutConcentration.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { buildDutConcentrationInsights } from "../src/lib/agent/agentDutConcentration.js";
import type { SiteBinPass } from "../src/lib/outputSiteBinByLot.js";

function pass(passId: number, bin: string, duts: Array<[number, number]>): SiteBinPass {
  return { passId, bins: [{ bin, duts: duts.map(([dut, dieCount]) => ({ dut, dieCount })) }] };
}

test("concentrated bad die on few DUTs => probe_card", () => {
  const passes = [pass(1, "bin11", [[3, 45], [7, 40], [1, 5], [2, 5], [4, 5]])];
  const [ins] = buildDutConcentrationInsights(passes, [{ passId: 1, cardIds: ["7804-02"], hasCardChange: false }]);
  assert.equal(ins.bin, 11);
  assert.equal(ins.verdict, "probe_card");
  assert.equal(ins.cardId, "7804-02");
  assert.ok(ins.topShare >= 0.7);
});

test("uniform spread across many DUTs => process", () => {
  const duts = Array.from({ length: 10 }, (_, i) => [i + 1, 10] as [number, number]);
  const [ins] = buildDutConcentrationInsights([pass(1, "bin11", duts)], []);
  assert.equal(ins.verdict, "process");
  assert.equal(ins.cardId, null);
});

test("total below minTotalDie => no insight", () => {
  const out = buildDutConcentrationInsights([pass(1, "bin11", [[1, 3], [2, 2]])], []);
  assert.equal(out.length, 0);
});

test("fewer than 3 DUTs => inconclusive", () => {
  const [ins] = buildDutConcentrationInsights([pass(1, "bin11", [[1, 6], [2, 5]])], []);
  assert.equal(ins.verdict, "inconclusive");
});

test("focusBins limits which bins are analyzed", () => {
  const passes = [{ passId: 1, bins: [
    { bin: "bin11", duts: [{ dut: 1, dieCount: 90 }, { dut: 2, dieCount: 10 }] },
    { bin: "bin66", duts: [{ dut: 1, dieCount: 90 }, { dut: 2, dieCount: 10 }] },
  ] }];
  const out = buildDutConcentrationInsights(passes, [], { focusBins: [11] });
  assert.equal(out.length, 1);
  assert.equal(out[0].bin, 11);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/agentDutConcentration.test.ts`
Expected: FAIL（`buildDutConcentrationInsights` 未定义 / 模块不存在）。

- [ ] **Step 3: Write minimal implementation**

`src/lib/agent/agentDutConcentration.ts`:

```ts
/** DUT 集中度检测：坏 die 集中在少数 DUT（探针卡）vs 分散（工艺）。 */
import type { SiteBinPass } from "../outputSiteBinByLot.js";
import type { CardByPassIdEntry } from "./agentJbHistoryCompact.js";
import { passIdSortLabel } from "../jbYieldCalc.js";

export type DutConcentrationVerdict = "probe_card" | "process" | "inconclusive";

export type DutConcentrationInsight = {
  bin: number;
  passId: number;
  sortLabel: string;
  cardId: string | null;
  totalDie: number;
  topDuts: Array<{ dut: number; dieCount: number; share: number }>;
  topShare: number;
  verdict: DutConcentrationVerdict;
  detail: string;
};

export type DutConcentrationOptions = {
  topShareThreshold?: number;
  minTotalDie?: number;
  focusBins?: number[];
};

function parseBinNumber(bin: string): number | null {
  const m = /(\d+)/.exec(bin);
  return m ? Number(m[1]) : null;
}

function cardIdForPass(cardByPassId: CardByPassIdEntry[], passId: number): string | null {
  const e = cardByPassId.find((c) => c.passId === passId);
  if (!e || e.cardIds.length === 0) return null;
  return e.cardIds.join(", ");
}

export function buildDutConcentrationInsights(
  passes: SiteBinPass[],
  cardByPassId: CardByPassIdEntry[] = [],
  opts: DutConcentrationOptions = {}
): DutConcentrationInsight[] {
  const threshold = opts.topShareThreshold ?? 0.7;
  const minTotalDie = opts.minTotalDie ?? 8;
  const focus = opts.focusBins && opts.focusBins.length ? new Set(opts.focusBins) : null;

  const insights: DutConcentrationInsight[] = [];
  for (const pass of passes) {
    const cardId = cardIdForPass(cardByPassId, pass.passId);
    for (const entry of pass.bins) {
      const bin = parseBinNumber(entry.bin);
      if (bin === null) continue;
      if (focus && !focus.has(bin)) continue;

      const numeric = entry.duts.filter(
        (d): d is { dut: number; dieCount: number } => typeof d.dut === "number"
      );
      const total = numeric.reduce((s, d) => s + d.dieCount, 0);
      if (numeric.length === 0 || total < minTotalDie) continue;

      const sorted = [...numeric].sort((a, b) => b.dieCount - a.dieCount);
      const k = Math.min(3, sorted.length);
      const topSum = sorted.slice(0, k).reduce((s, d) => s + d.dieCount, 0);
      const topShare = topSum / total;
      const topDuts = sorted.slice(0, k).map((d) => ({
        dut: d.dut,
        dieCount: d.dieCount,
        share: d.dieCount / total,
      }));
      const sortLabel = passIdSortLabel(pass.passId);

      let verdict: DutConcentrationVerdict;
      if (sorted.length < 3) verdict = "inconclusive";
      else if (topShare >= threshold) verdict = "probe_card";
      else verdict = "process";

      const pct = (n: number) => `${Math.round(n * 100)}%`;
      const dutList = topDuts.map((d) => `DUT${d.dut}`).join("/");
      const cardLabel = cardId ? `卡 ${cardId}` : "该 pass 探针卡";
      const detail =
        verdict === "probe_card"
          ? `BIN${bin} ${sortLabel} 坏 die ${total} 颗，${pct(topShare)} 集中在 ${dutList}（${cardLabel}）→ 疑探针卡针点/接触问题`
          : verdict === "process"
          ? `BIN${bin} ${sortLabel} 坏 die ${total} 颗，分散在 ${sorted.length} 个 DUT（最高 ${pct(topShare)}）→ 疑工艺/批次问题`
          : `BIN${bin} ${sortLabel} 坏 die ${total} 颗，仅 ${sorted.length} 个 DUT，样本不足以判别卡/工艺`;

      insights.push({ bin, passId: pass.passId, sortLabel, cardId, totalDie: total, topDuts, topShare, verdict, detail });
    }
  }
  insights.sort((a, b) => b.totalDie - a.totalDie);
  return insights;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/agentDutConcentration.test.ts`
Expected: PASS（5 个测试全过）。

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/agentDutConcentration.ts test/agentDutConcentration.test.ts
git commit -m "feat(agent): DUT 集中度检测器（卡 vs 工艺判别）"
```

---

### Task 2: 集中度 markdown + 判别口径 GUIDE

**Files:**
- Modify: `src/lib/agent/agentDutConcentration.ts`（追加 format 函数与 GUIDE 常量）
- Test: `test/agentDutConcentration.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 的 `DutConcentrationInsight[]`。
- Produces:
  - `function formatDutConcentrationMarkdown(insights: DutConcentrationInsight[]): string`
  - `const DUT_CONCENTRATION_GUIDE: string`

- [ ] **Step 1: Write the failing test**（追加到测试文件末尾）

```ts
import { formatDutConcentrationMarkdown, DUT_CONCENTRATION_GUIDE } from "../src/lib/agent/agentDutConcentration.js";

test("markdown renders verdict labels and hides internal identifiers", () => {
  const md = formatDutConcentrationMarkdown([
    { bin: 11, passId: 1, sortLabel: "pass1", cardId: "7804-02", totalDie: 100,
      topDuts: [{ dut: 3, dieCount: 45, share: 0.45 }], topShare: 0.9, verdict: "probe_card", detail: "x" },
  ]);
  assert.ok(md.includes("BIN11"));
  assert.ok(md.includes("疑探针卡"));
  for (const id of ["cardByPassId", "query_lot_dut_bin_agg", "Markdown", "topShare"]) {
    assert.ok(!md.includes(id), `markdown 不应含内部标识符 ${id}`);
  }
});

test("empty insights => empty string", () => {
  assert.equal(formatDutConcentrationMarkdown([]), "");
  assert.ok(DUT_CONCENTRATION_GUIDE.length > 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/agentDutConcentration.test.ts`
Expected: FAIL（`formatDutConcentrationMarkdown` 未导出）。

- [ ] **Step 3: Write minimal implementation**（追加到 `agentDutConcentration.ts`）

```ts
const VERDICT_LABEL: Record<DutConcentrationVerdict, string> = {
  probe_card: "疑探针卡",
  process: "疑工艺/批次",
  inconclusive: "样本不足",
};

export function formatDutConcentrationMarkdown(insights: DutConcentrationInsight[]): string {
  if (!insights.length) return "";
  const lines = [
    "**坏 die 的 DUT 集中度（卡 vs 工艺判别）**",
    "",
    "| BIN | 测试层 | 卡号 | 总坏die | 主要 DUT(占比) | 判别 |",
    "|---:|---|---|---:|---|---|",
  ];
  for (const i of insights) {
    const dutCol = i.topDuts.map((d) => `DUT${d.dut}(${Math.round(d.share * 100)}%)`).join("、");
    lines.push(
      `| BIN${i.bin} | ${i.sortLabel} | ${i.cardId ?? "—"} | ${i.totalDie} | ${dutCol} | ${VERDICT_LABEL[i.verdict]} |`
    );
  }
  return lines.join("\n");
}

export const DUT_CONCENTRATION_GUIDE =
  "DUT 集中度判别：某坏 BIN 的坏 die 若集中在少数 DUT（top 占比 ≥70%）→ 优先怀疑探针卡针点/接触" +
  "（查该卡对应 DUT 的 INF map、安排针尖检查/清针）；若分散在多数 DUT → 优先怀疑工艺/批次" +
  "（对比同期其它 lot、查工艺参数）。叙述时引用上方判别表，禁止自行估算占比。";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/agentDutConcentration.test.ts`
Expected: PASS（全部）。

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/agentDutConcentration.ts test/agentDutConcentration.test.ts
git commit -m "feat(agent): DUT 集中度 markdown + 判别口径 GUIDE"
```

---

### Task 3: 智能触发判别

**Files:**
- Create: `src/lib/agent/agentDutInsightTrigger.ts`
- Test: `test/agentDutInsightTrigger.test.ts`

**Interfaces:**
- Consumes: `userText: string`；`jbPayload: Record<string, unknown>`（JB 工具结果对象，含可选 `clusteredBadBinAlerts`）。
- Produces: `function shouldRunDutAnalysis(userText: string, jbPayload: Record<string, unknown>): boolean`

- [ ] **Step 1: Write the failing test**

`test/agentDutInsightTrigger.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { shouldRunDutAnalysis } from "../src/lib/agent/agentDutInsightTrigger.js";

test("user asking card-vs-process triggers", () => {
  assert.equal(shouldRunDutAnalysis("BIN11 是卡的问题还是工艺问题", {}), true);
});
test("user asking about DUT triggers", () => {
  assert.equal(shouldRunDutAnalysis("坏 die 集中在哪个 DUT", {}), true);
});
test("clustered bad bin alerts in payload triggers", () => {
  assert.equal(shouldRunDutAnalysis("DR43782.1A 测试情况", { clusteredBadBinAlerts: [{ bin: 11 }] }), true);
});
test("plain yield question with no alerts does not trigger", () => {
  assert.equal(shouldRunDutAnalysis("DR43782.1A 良率多少", { clusteredBadBinAlerts: [] }), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/agentDutInsightTrigger.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: Write minimal implementation**

`src/lib/agent/agentDutInsightTrigger.ts`:

```ts
/** 智能触发：何时跑 DUT 集中度分析（拉 INF）。 */
const CARD_DUT_INTENT_RE =
  /\bdut\b|触点|\bsite\b|针点|是.*卡.*还是.*工艺|卡.*(问题|缺陷)|工艺.*问题|集中在哪|哪个\s*dut|哪些\s*dut/i;

export function shouldRunDutAnalysis(
  userText: string,
  jbPayload: Record<string, unknown>
): boolean {
  if (CARD_DUT_INTENT_RE.test(userText)) return true;
  const alerts = jbPayload["clusteredBadBinAlerts"];
  return Array.isArray(alerts) && alerts.length > 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/agentDutInsightTrigger.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/agentDutInsightTrigger.ts test/agentDutInsightTrigger.test.ts
git commit -m "feat(agent): DUT 分析智能触发判别"
```

---

### Task 4: 增强 query_lot_dut_bin_agg 工具结果（用户问 DUT 的端到端路径）

**Files:**
- Modify: `src/lib/agent/agentToolHandlers.ts`（`toolQueryLotDutBinAgg` 内，在 `compactSiteBinPasses(passes)` 序列化前，用已解析的 `SiteBinPass[]` 计算集中度，并把 markdown 前置到结果）
- Test: 复用现有 `test/` 中 query_lot_dut_bin_agg 的 dummy 路径（若无独立测试，则在 `test/agentDutConcentration.test.ts` 已覆盖纯函数；本任务加一条断言其被调用）

**Interfaces:**
- Consumes: Task 1 `buildDutConcentrationInsights`、Task 2 `formatDutConcentrationMarkdown`。
- Produces: `query_lot_dut_bin_agg` 工具结果字符串**首部**新增「坏 die 的 DUT 集中度」表（当有 probe_card/process 判别时）。

- [ ] **Step 1: 定位插入点**

Run: `grep -n "compactSiteBinPasses(passes)\|const passes" src/lib/agent/agentToolHandlers.ts`
确认 `toolQueryLotDutBinAgg` 中解析出 `passes: SiteBinPass[]`（Dummy 与真库两分支）后、序列化结果前的位置。

- [ ] **Step 2: Write the failing test**

`test/agentDutBinAggInsight.test.ts`（dummy INF）:

```ts
import test from "node:test";
import assert from "node:assert/strict";
process.env["INFCONTROL_LAYER_BINS_DUMMY"] = "true";
process.env["SITE_BIN_BY_LOT_DUMMY"] = "true";
import { runTool } from "../src/lib/agent/agentToolHandlers.js";

test("query_lot_dut_bin_agg result includes DUT concentration table when applicable", async () => {
  const out = await runTool("query_lot_dut_bin_agg", { device: "WA10P29E", lot: "DR43782.1A" });
  assert.equal(typeof out, "string");
  // 含集中度判别表或在无显著坏 bin 时不含（二者其一，且绝不报错）
  assert.ok(!(out as string).startsWith("query_lot_dut_bin_agg 参数错误"));
});
```

> 说明：dummy 数据若无坏 bin 满足 minTotalDie，表可为空——断言重点是**不报错且不暴露内部名**。实际坏 bin 充足的 dummy lot 由实现者从 `docs/JBStart.xlsx` / INF dummy 中选取并在断言中替换为含 `疑探针卡`/`疑工艺` 的 lot。

- [ ] **Step 3: Run test to verify it fails (or passes trivially), then wire insight**

Run: `npx tsx --test test/agentDutBinAggInsight.test.ts`
在 `toolQueryLotDutBinAgg` 内，序列化前插入：

```ts
import {
  buildDutConcentrationInsights,
  formatDutConcentrationMarkdown,
} from "./agentDutConcentration.js";
// ... 解析出 passes: SiteBinPass[] 之后：
const dutInsights = buildDutConcentrationInsights(passes, []);
const dutMd = formatDutConcentrationMarkdown(dutInsights);
// 把 dutMd 前置到最终返回字符串（在 compact JSON 之前，避免被 maxChars 截断）：
//   return (dutMd ? dutMd + "\n\n" : "") + <原序列化结果>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/agentDutBinAggInsight.test.ts`
Expected: PASS（不报错；含坏 bin 的 lot 输出含判别表）。

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/agentToolHandlers.ts test/agentDutBinAggInsight.test.ts
git commit -m "feat(agent): query_lot_dut_bin_agg 结果附 DUT 集中度判别表"
```

---

### Task 5: 智能触发自动注入 lot 总结 + prompt 专节

**Files:**
- Modify: `src/lib/agent/agentToolHandlers.ts`（JB lot 查询路径：检出可疑坏 bin 时，按 `shouldRunDutAnalysis` 拉 INF 并把 `dutConcentrationMarkdown` 挂到 JB payload）
- Modify: `src/lib/agent/agentJbDeterministicReply.ts`（总结读取 `toolPayload["dutConcentrationMarkdown"]` 并在数据解读前输出）
- Modify: `src/lib/agent/agentPrompt.ts`（新增「DUT 集中度：卡 vs 工艺判别」专节，引用 GUIDE 要点）

**Interfaces:**
- Consumes: Task 3 `shouldRunDutAnalysis`、Task 1/2 检测器、现有 `query_lot_dut_bin_agg` 取数路径。
- Produces: JB lot payload 新增字段 `dutConcentrationMarkdown: string`；确定性总结在「### 数据解读」前渲染该表。

- [ ] **Step 1: 定位 JB lot payload 组装点与总结渲染点**

Run: `grep -n "clusteredBadBinAlertsMarkdown\|clusteredBadBinAlerts" src/lib/agent/agentToolHandlers.ts src/lib/agent/agentJbDeterministicReply.ts`
照搬 `clusteredBadBinAlertsMarkdown` 的「计算→挂 payload→总结读取」三处对应位置。

- [ ] **Step 2: Write the failing test**

在 `test/agentDutBinAggInsight.test.ts` 追加：当 JB lot payload 含可疑坏 bin 且 `shouldRunDutAnalysis` 为真时，payload 出现 `dutConcentrationMarkdown` 字段（用一个直接构造 payload + 调用注入函数的单测；若注入逻辑封装为 `attachDutConcentrationToJbPayload(payload, userText)` 则直接测它）：

```ts
import { attachDutConcentrationToJbPayload } from "../src/lib/agent/agentToolHandlers.js";

test("clustered alerts cause DUT concentration to be attached", async () => {
  const payload: Record<string, unknown> = {
    device: "WA10P29E", lot: "DR43782.1A",
    clusteredBadBinAlerts: [{ bin: 11, passId: 1 }],
  };
  await attachDutConcentrationToJbPayload(payload, "DR43782.1A 测试情况");
  assert.equal(typeof payload["dutConcentrationMarkdown"], "string");
});
```

> 实现者将拉 INF 的逻辑抽成 `export async function attachDutConcentrationToJbPayload(payload, userText)`：内部调用 `shouldRunDutAnalysis`，为真则取 `device`/`lot`、拉 `SiteBinPass[]`（复用 Task 4 的取数）、`focusBins` 取自 `clusteredBadBinAlerts[].bin`，算 insight 并写 `payload.dutConcentrationMarkdown`。INF 失败时静默跳过（不抛、不阻断）。

- [ ] **Step 3: Run test to verify it fails**

Run: `npx tsx --test test/agentDutBinAggInsight.test.ts`
Expected: FAIL（`attachDutConcentrationToJbPayload` 未导出）。

- [ ] **Step 4: 实现注入 + 总结渲染 + prompt 专节**

- `agentToolHandlers.ts`：实现 `attachDutConcentrationToJbPayload`，并在 JB lot 查询结果组装后调用（与 `clusteredBadBinAlerts` 同处）。
- `agentJbDeterministicReply.ts`：在渲染 `clusteredBadBinAlertsMarkdown` 之后、`### 数据解读` 之前，若 `toolPayload["dutConcentrationMarkdown"]` 非空则 `lines.push(it)`。
- `agentPrompt.ts`：新增专节（精简）：

```
## DUT 集中度：卡 vs 工艺判别
工具结果含「坏 die 的 DUT 集中度」表时，数据解读须据此点明各可疑 BIN 属
「疑探针卡」还是「疑工艺/批次」，并在专业建议中给对应方向（探针卡→针检/清针；
工艺→对比同期 lot/查工艺）。占比数字只引用表内值，禁止自估。
```

- [ ] **Step 5: Run test + 全量回归**

Run: `npx tsx --test test/agentDutBinAggInsight.test.ts && npm test 2>&1 | grep -E "^# (pass|fail)"`
Expected: 目标测试 PASS；`# fail 0`。

- [ ] **Step 6: Commit**

```bash
git add src/lib/agent/agentToolHandlers.ts src/lib/agent/agentJbDeterministicReply.ts src/lib/agent/agentPrompt.ts test/agentDutBinAggInsight.test.ts
git commit -m "feat(agent): 可疑坏 bin 自动附 DUT 集中度判别 + prompt 专节"
```

---

### Task 6: 评测台场景（新 insight 类别）

**Files:**
- Modify: `test/eval/evalTypes.ts`（`EvalCategory` 加 `"insight"`；`EVAL_CATEGORY_LABELS` 加标签）
- Modify: `test/eval/evalRunner.ts`（`CATEGORY_ORDER` 加 `"insight"`）
- Create: `test/eval/scenarios/insight.scenarios.ts`
- Modify: `test/eval/allScenarios.ts`（汇入）

**Interfaces:**
- Consumes: Task 1/2/3 的导出函数。
- Produces: 评分台新增「DUT 关系/规律」类别。

- [ ] **Step 1: 加类别**

`evalTypes.ts`：`EvalCategory` 联合类型追加 `| "insight"`；`EVAL_CATEGORY_LABELS` 追加 `insight: "DUT 关系/隐性规律"`。
`evalRunner.ts`：`CATEGORY_ORDER` 数组追加 `"insight"`。

- [ ] **Step 2: 写场景**

`test/eval/scenarios/insight.scenarios.ts`:

```ts
import { buildDutConcentrationInsights, formatDutConcentrationMarkdown } from "../../../src/lib/agent/agentDutConcentration.js";
import { shouldRunDutAnalysis } from "../../../src/lib/agent/agentDutInsightTrigger.js";
import { expectEqual, expectTrue, expectExcludesAll, type EvalScenario } from "../evalTypes.js";

const p = (bin: string, duts: Array<[number, number]>) => ({
  passId: 1, bins: [{ bin, duts: duts.map(([dut, dieCount]) => ({ dut, dieCount })) }],
});

export const insightScenarios: EvalScenario[] = [
  {
    id: "dut-concentrated-probe-card",
    category: "insight",
    title: "坏 die 集中在少数 DUT → 判探针卡",
    seed: "用户需求:卡/DUT/坏die 关系",
    run: () => {
      const [i] = buildDutConcentrationInsights([p("bin11", [[3, 45], [7, 40], [1, 5], [2, 5], [4, 5]])], []);
      return expectEqual(i?.verdict, "probe_card", "verdict");
    },
  },
  {
    id: "dut-spread-process",
    category: "insight",
    title: "坏 die 分散在多数 DUT → 判工艺",
    run: () => {
      const duts = Array.from({ length: 10 }, (_, k) => [k + 1, 10] as [number, number]);
      const [i] = buildDutConcentrationInsights([p("bin11", duts)], []);
      return expectEqual(i?.verdict, "process", "verdict");
    },
  },
  {
    id: "dut-trigger-card-vs-process",
    category: "insight",
    title: "「是卡还是工艺」问题触发 DUT 分析",
    run: () => expectTrue(shouldRunDutAnalysis("BIN11 是卡还是工艺问题", {}), "shouldRunDutAnalysis"),
  },
  {
    id: "dut-markdown-no-internal-id",
    category: "insight",
    title: "集中度 markdown 不暴露内部标识符",
    run: () => {
      const md = formatDutConcentrationMarkdown(
        buildDutConcentrationInsights([p("bin11", [[3, 90], [1, 10]])], [{ passId: 1, cardIds: ["7804-02"], hasCardChange: false }])
      );
      return expectExcludesAll(md, ["cardByPassId", "query_lot_dut_bin_agg", "Markdown", "topShare"]);
    },
  },
];
```

`allScenarios.ts`：`import { insightScenarios }` 并加入展开数组。

- [ ] **Step 3: Run eval + regression**

Run: `npm run agent:eval 2>&1 | grep -v oracledb && npm test 2>&1 | grep -E "^# (pass|fail)"`
Expected: 评分表出现「DUT 关系/隐性规律 4/4 100%」；`# fail 0`。

- [ ] **Step 4: typecheck**

Run: `npm run typecheck`
Expected: EXIT 0。

- [ ] **Step 5: Commit**

```bash
git add test/eval/ src/
git commit -m "test(agent): 评测台新增 DUT 关系/隐性规律类别（4 场景）"
```

---

## Self-Review

**Spec coverage:**
- §4 DUT 集中度检测 → Task 1/2 ✓
- §5 智能触发编排 → Task 3（判别）+ Task 5（自动注入）✓
- §4.3 输出结构 / CARDID 关联 → Task 1 ✓
- §4.4 判别口径 GUIDE → Task 2 + Task 5 prompt 专节 ✓
- §6 集成点（确定性总结 / handlers / prompt）→ Task 4/5 ✓
- §7 测试 → Task 1/2/3/4/6 ✓
- §8 错误处理（INF 失败静默、cardId null）→ Task 1（cardId null）+ Task 5（INF 失败跳过）✓
- §9 范围边界：Phase 2（系统性 DUT/换卡前后）不在本计划 ✓

**Placeholder scan:** 无 TBD/TODO；Task 4 Step 2 的 dummy lot 选取已明确交代由实现者从 dummy 数据选含坏 bin 的 lot 并替换断言——非占位，是数据依赖说明。

**Type consistency:** `DutConcentrationInsight` 字段在 Task 1 定义、Task 2/6 使用一致；`buildDutConcentrationInsights` / `formatDutConcentrationMarkdown` / `shouldRunDutAnalysis` / `attachDutConcentrationToJbPayload` 命名跨任务一致；复用 `SiteBinPass` / `CardByPassIdEntry` / `passIdSortLabel` 与现有定义一致。
