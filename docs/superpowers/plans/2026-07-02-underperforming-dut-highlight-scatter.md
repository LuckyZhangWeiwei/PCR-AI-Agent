# 低良率 DUT 高亮 + 散点图 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 问 lot 时，让「低于 lot 平均 yield × 0.75」的 DUT 在良率表里 🔴 加粗醒目标出，并每 pass 出一张三色带散点图。

**Architecture:** 纯展示层。复用昨天 `computeUnderperformingDutsForPass` 已算好的 `passes[]`（含 `allDuts` / `baseline` / `underperformingDuts`）。新增一个纯函数视图模块（markdown + 散点 option）+ 一个路由模块（问句谓词）+ 在 `agentLoop.ts` 接线（A 路 PRE_LLM 直连 + LLM 工具路径出图）+ `emitDeterministicJbTablesReply` 里 B 路 best-effort 补 INF。

**Tech Stack:** Node + TypeScript + oracledb 5.5（不动）；ECharts option（后端只产纯 option 对象，前端 DarkChart 渲染）；测试 `node:test` via `npx tsx --test`。

## Global Constraints

- **不碰 SQL / Dummy / REST 响应字段语义**：`lotUnderperformingDuts.ts` 的 `formatUnderperformingDutsMarkdown` 与 REST 字段 `underperformingDutsMarkdown` 保持不变；新高亮函数是**独立新增**，仅 Agent 展示层用。
- **不翻任何 feature flag**，**不 merge main**（当前分支 `feat/jb-route-resolver`）。
- **不降现有回复质量**：A 路失败 `return false` 落回 LLM；B 路失败 try/catch 静默跳过，不阻塞主概况。
- **口径固定**：baseline = lot 整体良率（`baseline.yieldPct`）；阈值 = `baseline.thresholdPct`（= baseline × 0.75 默认）；低良率 = `yieldPct < thresholdPct`（严格小于，恰等于阈值不算低）。
- **提交 trailer**：`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。
- **禁止 `git commit -am`**；用显式 `git add <path>`（勿提交 `.claude/settings.local.json`）。
- 每个 Task 结束跑 `npm test`（期望 0 fail）+ `npm run typecheck`。

**类型参考（来自 `src/lib/lotUnderperformingDuts.ts`，勿改）：**
```ts
export type DutYieldEntry = { dut: number; goodDie: number; totalDie: number; yieldPct: number };
export type PassUnderperformingDutsResult = {
  passId: number; sortLabel: string; dutCount: number;
  lotGoodDie: number; lotTotalDie: number;
  baseline: { method: "lotOverall"; yieldPct: number; thresholdPct: number; thresholdRatio: number } | null;
  allDuts: DutYieldEntry[];
  underperformingDuts: Array<DutYieldEntry & { gapToThresholdPct: number }>;
};
```

**`runLotUnderperformingDuts` 返回（`src/lib/lotUnderperformingDutsResolve.ts`）：** `Promise<LotUnderperformingDutsResponse>`，含 `device: string`、`lot: string`、`passes: PassUnderperformingDutsResult[]`。

---

### Task 1: 视图模块 — 全 DUT 高亮表

**Files:**
- Create: `pcr-ai-api/src/lib/agent/agentUnderperformingDutView.ts`
- Test: `pcr-ai-api/test/agentUnderperformingDutView.test.ts`

**Interfaces:**
- Consumes: `PassUnderperformingDutsResult`（from `../lotUnderperformingDuts.js`）
- Produces: `formatAllDutsHighlightMarkdown(passResults: PassUnderperformingDutsResult[], lot: string, device: string): string`

- [ ] **Step 1: 写失败测试**

创建 `pcr-ai-api/test/agentUnderperformingDutView.test.ts`：
```ts
import assert from "node:assert/strict";
import test from "node:test";
import { formatAllDutsHighlightMarkdown } from "../src/lib/agent/agentUnderperformingDutView.js";
import type { PassUnderperformingDutsResult } from "../src/lib/lotUnderperformingDuts.js";

function pass(overrides: Partial<PassUnderperformingDutsResult> = {}): PassUnderperformingDutsResult {
  return {
    passId: 1,
    sortLabel: "常温 sort1",
    dutCount: 3,
    lotGoodDie: 900,
    lotTotalDie: 1000,
    baseline: { method: "lotOverall", yieldPct: 96.38, thresholdPct: 72.29, thresholdRatio: 0.75 },
    allDuts: [
      { dut: 3, goodDie: 402, totalDie: 410, yieldPct: 98.05 },
      { dut: 8, goodDie: 300, totalDie: 408, yieldPct: 73.53 },
      { dut: 12, goodDie: 250, totalDie: 408, yieldPct: 61.27 },
    ],
    underperformingDuts: [
      { dut: 12, goodDie: 250, totalDie: 408, yieldPct: 61.27, gapToThresholdPct: -11.02 },
    ],
    ...overrides,
  };
}

test("formatAllDutsHighlightMarkdown: 低于阈值行 🔴+加粗，达标行不标", () => {
  const md = formatAllDutsHighlightMarkdown([pass()], "DR43782.1A", "WA03P02G");
  assert.match(md, /🔴 \*\*DUT12\*\*/); // 61.27 < 72.29 → 高亮
  assert.doesNotMatch(md, /🔴 \*\*DUT3\*\*/); // 98.05 达标
  assert.match(md, /lot 整体 96\.38% · 阈值 72\.29%/);
  assert.match(md, /DR43782\.1A（WA03P02G）/);
});

test("formatAllDutsHighlightMarkdown: 恰等于阈值不高亮（严格小于）", () => {
  const p = pass({
    allDuts: [{ dut: 5, goodDie: 1, totalDie: 1, yieldPct: 72.29 }],
    underperformingDuts: [],
  });
  const md = formatAllDutsHighlightMarkdown([p], "L", "D");
  assert.doesNotMatch(md, /🔴/);
});

test("formatAllDutsHighlightMarkdown: baseline=null 或空 DUT 跳过；全空返回空串", () => {
  const p = pass({ baseline: null, allDuts: [] });
  assert.equal(formatAllDutsHighlightMarkdown([p], "L", "D"), "");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd pcr-ai-api && npx tsx --test test/agentUnderperformingDutView.test.ts`
Expected: FAIL（`Cannot find module '.../agentUnderperformingDutView.js'`）

- [ ] **Step 3: 写实现**

创建 `pcr-ai-api/src/lib/agent/agentUnderperformingDutView.ts`：
```ts
/**
 * 低良率 DUT 展示层（纯函数，无副作用）：给 Agent 回复生成
 * ① 全 DUT 良率高亮表（低于 lot平均×阈值比 的 DUT 用 🔴+加粗标注）
 * ② 每 pass 一张散点 option（见同文件 buildUnderperformingDutScatterOptions，Task 2）。
 * 数据来自昨天的 computeUnderperformingDutsForPass；本模块不取数、不碰 SQL/Dummy/REST。
 */

import type { PassUnderperformingDutsResult } from "../lotUnderperformingDuts.js";

const RED_DOT = "🔴";

export function formatAllDutsHighlightMarkdown(
  passResults: PassUnderperformingDutsResult[],
  lot: string,
  device: string
): string {
  const blocks: string[] = [];
  for (const pass of passResults) {
    if (!pass.baseline || pass.allDuts.length === 0) continue;
    const avg = pass.baseline.yieldPct;
    const threshold = pass.baseline.thresholdPct;
    const rows = [...pass.allDuts].sort(
      (a, b) => a.yieldPct - b.yieldPct || a.dut - b.dut
    );
    const lines = [
      `### ${pass.sortLabel} — lot 整体 ${avg}% · 阈值 ${threshold}%（低于阈值 ${RED_DOT} 标注）`,
      "",
      "| DUT | 良率% | good/total | 状态 |",
      "|:--|---:|---:|:--|",
    ];
    for (const d of rows) {
      if (d.yieldPct < threshold) {
        lines.push(
          `| ${RED_DOT} **DUT${d.dut}** | **${d.yieldPct}** | **${d.goodDie}/${d.totalDie}** | **低于阈值** |`
        );
      } else {
        lines.push(`| DUT${d.dut} | ${d.yieldPct} | ${d.goodDie}/${d.totalDie} |  |`);
      }
    }
    blocks.push(lines.join("\n"));
  }
  if (blocks.length === 0) return "";
  return `**Lot ${lot}（${device}）各 DUT 良率**\n\n${blocks.join("\n\n")}`;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd pcr-ai-api && npx tsx --test test/agentUnderperformingDutView.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: typecheck + 提交**

```bash
cd pcr-ai-api && npm run typecheck
cd /d/AI/PCR-AI-Agent
git add pcr-ai-api/src/lib/agent/agentUnderperformingDutView.ts pcr-ai-api/test/agentUnderperformingDutView.test.ts
git commit -m "feat(agent): 全 DUT 良率高亮表（低于阈值 🔴+加粗）

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: 视图模块 — 每 pass 散点 option

**Files:**
- Modify: `pcr-ai-api/src/lib/agent/agentUnderperformingDutView.ts`（追加）
- Test: `pcr-ai-api/test/agentUnderperformingDutView.test.ts`（追加）

**Interfaces:**
- Produces:
  - `type PassScatterOption = { passId: number; sortLabel: string; option: object }`
  - `buildUnderperformingDutScatterOptions(passResults: PassUnderperformingDutsResult[]): PassScatterOption[]`

- [ ] **Step 1: 写失败测试**（追加到 `test/agentUnderperformingDutView.test.ts` 末尾）

```ts
import { buildUnderperformingDutScatterOptions } from "../src/lib/agent/agentUnderperformingDutView.js";

test("buildUnderperformingDutScatterOptions: 三色带 + 平均/阈值 markLine", () => {
  const opts = buildUnderperformingDutScatterOptions([pass()]);
  assert.equal(opts.length, 1);
  const series = (opts[0].option as any).series[0];
  const colors = series.data.map((p: any) => p.itemStyle.color);
  // DUT3=98.05(≥96.38 绿) DUT8=73.53(72.29~96.38 黄) DUT12=61.27(<72.29 红)
  // data 按 dut 升序：3,8,12
  assert.equal(colors[0], "#4caf50");
  assert.equal(colors[1], "#f0a020");
  assert.equal(colors[2], "#e15b64");
  const markYs = series.markLine.data.map((m: any) => m.yAxis).sort((a: number, b: number) => a - b);
  assert.deepEqual(markYs, [72.29, 96.38]);
});

test("buildUnderperformingDutScatterOptions: baseline=null / 空 DUT 跳过", () => {
  const p = pass({ baseline: null, allDuts: [] });
  assert.equal(buildUnderperformingDutScatterOptions([p]).length, 0);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd pcr-ai-api && npx tsx --test test/agentUnderperformingDutView.test.ts`
Expected: FAIL（`buildUnderperformingDutScatterOptions is not a function`）

- [ ] **Step 3: 写实现**（追加到 `agentUnderperformingDutView.ts`）

```ts
/** 良率相对 lot 平均 / 阈值 的色带：绿≥平均、黄平均~阈值、红<阈值。 */
function dutBandColor(yieldPct: number, avg: number, threshold: number): string {
  if (yieldPct < threshold) return "#e15b64"; // 红：低于阈值
  if (yieldPct < avg) return "#f0a020"; // 黄：低于平均但达标
  return "#4caf50"; // 绿：高于/等于平均
}

export type PassScatterOption = { passId: number; sortLabel: string; option: object };

export function buildUnderperformingDutScatterOptions(
  passResults: PassUnderperformingDutsResult[]
): PassScatterOption[] {
  const out: PassScatterOption[] = [];
  for (const pass of passResults) {
    if (!pass.baseline || pass.allDuts.length === 0) continue;
    const avg = pass.baseline.yieldPct;
    const threshold = pass.baseline.thresholdPct;
    const duts = [...pass.allDuts].sort((a, b) => a.dut - b.dut);
    const option = {
      title: { text: `${pass.sortLabel} 各 DUT 良率分布` },
      tooltip: { trigger: "item" },
      xAxis: { type: "category", data: duts.map((d) => `DUT${d.dut}`), name: "DUT" },
      yAxis: { type: "value", name: "良率%", min: 0, max: 100 },
      series: [
        {
          type: "scatter",
          symbolSize: 12,
          data: duts.map((d) => ({
            value: [`DUT${d.dut}`, d.yieldPct],
            itemStyle: { color: dutBandColor(d.yieldPct, avg, threshold) },
          })),
          markLine: {
            silent: true,
            symbol: "none",
            data: [
              {
                yAxis: avg,
                label: { formatter: `lot平均 ${avg}%` },
                lineStyle: { color: "#4a90d9", type: "dashed" },
              },
              {
                yAxis: threshold,
                label: { formatter: `阈值 ${threshold}%` },
                lineStyle: { color: "#e15b64", type: "dashed" },
              },
            ],
          },
        },
      ],
    };
    out.push({ passId: pass.passId, sortLabel: pass.sortLabel, option });
  }
  return out;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd pcr-ai-api && npx tsx --test test/agentUnderperformingDutView.test.ts`
Expected: PASS（5 tests）

- [ ] **Step 5: typecheck + 提交**

```bash
cd pcr-ai-api && npm run typecheck
cd /d/AI/PCR-AI-Agent
git add pcr-ai-api/src/lib/agent/agentUnderperformingDutView.ts pcr-ai-api/test/agentUnderperformingDutView.test.ts
git commit -m "feat(agent): 低良率 DUT 散点 option（三色带+平均/阈值线）

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: 路由模块 — 问句谓词 + 参数

**Files:**
- Create: `pcr-ai-api/src/lib/agent/agentUnderperformingDutRoute.ts`
- Test: `pcr-ai-api/test/agentUnderperformingDutRoute.test.ts`

**Interfaces:**
- Consumes: `extractLotFromUserText`（`./agentInfWaferMapTool.js`）、`inferDeviceFromText`/`inferDeviceFromHistory`/`inferLotFromHistory`（`./agentQueryScope.js`）、`ChatMessage`（`./agentHistory.js`）
- Produces:
  - `isLotUnderperformingDutQuestion(text: string): boolean`
  - `canRunUnderperformingDutDirectRoute(userText: string, history?: ChatMessage[]): boolean`
  - `underperformingDutArgsFromText(userText: string, history?: ChatMessage[]): { lot: string; device?: string } | null`

- [ ] **Step 1: 写失败测试**

创建 `pcr-ai-api/test/agentUnderperformingDutRoute.test.ts`：
```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  canRunUnderperformingDutDirectRoute,
  isLotUnderperformingDutQuestion,
  underperformingDutArgsFromText,
} from "../src/lib/agent/agentUnderperformingDutRoute.js";
import type { ChatMessage } from "../src/lib/agent/agentHistory.js";

test("isLotUnderperformingDutQuestion: DUT 低良率意图命中；卡/概况不命中", () => {
  assert.ok(isLotUnderperformingDutQuestion("DR43782.1A 哪些 DUT 偏低"));
  assert.ok(isLotUnderperformingDutQuestion("这个 lot 哪些 dut 良率低"));
  assert.ok(isLotUnderperformingDutQuestion("低良率的 DUT 有哪些"));
  assert.equal(isLotUnderperformingDutQuestion("哪张卡良率最低"), false); // 卡，非 DUT
  assert.equal(isLotUnderperformingDutQuestion("DR43782.1A 概况"), false);
});

test("canRunUnderperformingDutDirectRoute: 需 DUT 低良率意图 + lot（句或 history）", () => {
  assert.ok(canRunUnderperformingDutDirectRoute("DR43782.1A 哪些 DUT 偏低"));
  assert.equal(canRunUnderperformingDutDirectRoute("哪些 DUT 偏低"), false); // 无 lot
  const hist: ChatMessage[] = [
    { role: "user", content: "DR43782.1A 概况" },
    { role: "tool", name: "query_jb_bins", content: JSON.stringify({ lot: "DR43782.1A", device: "WA03P02G" }) } as ChatMessage,
  ];
  assert.ok(canRunUnderperformingDutDirectRoute("哪些 DUT 偏低", hist));
});

test("underperformingDutArgsFromText: 解析 lot + device", () => {
  assert.deepEqual(
    underperformingDutArgsFromText("DR43782.1A 哪些 DUT 偏低"),
    { lot: "DR43782.1A", device: undefined }
  );
  assert.equal(underperformingDutArgsFromText("哪些 DUT 偏低"), null);
});
```

> 注：`extractLotFromUserText` 对 `DR43782.1A` 应能解析（`[A-Z]{2}\d{4,5}\.\d[A-Z]` 形态）。若测试失败提示 lot 未解析，改用一个确认可解析的 lot（参照 `test/agentQueryScope.test.ts` 里用过的 lot 格式）。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd pcr-ai-api && npx tsx --test test/agentUnderperformingDutRoute.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写实现**

创建 `pcr-ai-api/src/lib/agent/agentUnderperformingDutRoute.ts`：
```ts
/**
 * A 路谓词/参数：识别「lot 内哪些 DUT 良率偏低」类问句，供 PRE_LLM 直连路由
 * tryRunUnderperformingDutDirectRoute 使用。必须有 DUT 级低良率意图 + 可解析 lot。
 */

import type { ChatMessage } from "./agentHistory.js";
import { extractLotFromUserText } from "./agentInfWaferMapTool.js";
import {
  inferDeviceFromHistory,
  inferDeviceFromText,
  inferLotFromHistory,
} from "./agentQueryScope.js";

export function isLotUnderperformingDutQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // 必须是 DUT / 探针 / 触点 / site 级（"哪张卡良率最低" 是卡级，不在此列）
  if (!/dut|探针|触点|\bsite\b/i.test(t)) return false;
  // 低良率 / 偏低 / 低于平均 意图
  return /低良率|良率\s*(低|差|偏低)|偏低|低于\s*(平均|阈值|均值)|拖后腿|表现\s*差|underperform/i.test(t);
}

export function canRunUnderperformingDutDirectRoute(
  userText: string,
  history: ChatMessage[] = []
): boolean {
  if (!isLotUnderperformingDutQuestion(userText)) return false;
  const lot = extractLotFromUserText(userText) || inferLotFromHistory(history);
  return Boolean(lot);
}

export function underperformingDutArgsFromText(
  userText: string,
  history: ChatMessage[] = []
): { lot: string; device?: string } | null {
  const lot = extractLotFromUserText(userText) || inferLotFromHistory(history);
  if (!lot) return null;
  const device =
    inferDeviceFromText(userText) || inferDeviceFromHistory(history) || undefined;
  return { lot, device };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd pcr-ai-api && npx tsx --test test/agentUnderperformingDutRoute.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: typecheck + 提交**

```bash
cd pcr-ai-api && npm run typecheck
cd /d/AI/PCR-AI-Agent
git add pcr-ai-api/src/lib/agent/agentUnderperformingDutRoute.ts pcr-ai-api/test/agentUnderperformingDutRoute.test.ts
git commit -m "feat(agent): 低良率 DUT 问句谓词 + 参数解析

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: A 路接线 — PRE_LLM 直连路由 + LLM 工具路径出图

**Files:**
- Modify: `pcr-ai-api/src/lib/agent/agentLoop.ts`（import + 新 `tryRunUnderperformingDutDirectRoute` + 注册 `PRE_LLM_DIRECT_ROUTES` + LLM 工具路径 emit 散点）
- Modify: `pcr-ai-api/src/lib/agent/agentToolHandlers.ts`（`RunToolOptions` 加 `onUnderperformingDuts`；`toolQueryLotUnderperformingDuts` 回调 + 内部串换高亮表）
- Test: `pcr-ai-api/test/agentLoop.test.ts`（追加：谓词未命中直连返回 false 的门测；散点 emit helper）

**Interfaces:**
- Consumes: Task 1/2 的 `formatAllDutsHighlightMarkdown` / `buildUnderperformingDutScatterOptions` / `PassScatterOption`；Task 3 的 `canRunUnderperformingDutDirectRoute` / `underperformingDutArgsFromText`；`runLotUnderperformingDuts`（`../lotUnderperformingDutsResolve.js`）
- Produces: `tryRunUnderperformingDutDirectRoute`（内部）；`tryEmitUnderperformingDutScatter(passes, emit)`（导出供测试）

- [ ] **Step 1: 写失败测试**（追加到 `test/agentLoop.test.ts` 末尾）

先在文件顶部 import 区加：
```ts
import { tryEmitUnderperformingDutScatter } from "../src/lib/agent/agentLoop.js";
```
再追加：
```ts
test("tryEmitUnderperformingDutScatter: 每个有 baseline 的 pass emit 一个 chart 事件", () => {
  const events: any[] = [];
  const passes: any[] = [
    {
      passId: 1, sortLabel: "常温 sort1", dutCount: 1, lotGoodDie: 1, lotTotalDie: 1,
      baseline: { method: "lotOverall", yieldPct: 90, thresholdPct: 67.5, thresholdRatio: 0.75 },
      allDuts: [{ dut: 1, goodDie: 5, totalDie: 10, yieldPct: 50 }],
      underperformingDuts: [{ dut: 1, goodDie: 5, totalDie: 10, yieldPct: 50, gapToThresholdPct: -17.5 }],
    },
    {
      passId: 3, sortLabel: "高温 sort3", dutCount: 0, lotGoodDie: 0, lotTotalDie: 0,
      baseline: null, allDuts: [], underperformingDuts: [],
    },
  ];
  tryEmitUnderperformingDutScatter(passes, (e) => events.push(e));
  const charts = events.filter((e) => e.type === "chart");
  assert.equal(charts.length, 1); // pass3 baseline=null 跳过
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd pcr-ai-api && npx tsx --test test/agentLoop.test.ts`
Expected: FAIL（`tryEmitUnderperformingDutScatter` 未导出）

- [ ] **Step 3a: agentLoop.ts 加 import**

在 agentLoop.ts 现有 route import 区（`agentJbUnscopedBinRoute.js` import 之后）追加：
```ts
import {
  canRunUnderperformingDutDirectRoute,
  underperformingDutArgsFromText,
} from "./agentUnderperformingDutRoute.js";
import {
  buildUnderperformingDutScatterOptions,
  formatAllDutsHighlightMarkdown,
} from "./agentUnderperformingDutView.js";
import type { PassUnderperformingDutsResult } from "../lotUnderperformingDuts.js";
import { runLotUnderperformingDuts } from "../lotUnderperformingDutsResolve.js";
```

- [ ] **Step 3b: agentLoop.ts 加 emit helper + 直连路由**

在 `tryRunUnscopedBinClarifyDirectRoute` 定义之后（`tryEmitDutBinBarChart` 之前）追加：
```ts
/** 每个有 baseline 的 pass emit 一张 DUT 良率散点图（供直连路由与 LLM 工具路径复用）。 */
export function tryEmitUnderperformingDutScatter(
  passes: PassUnderperformingDutsResult[],
  emit: (event: AgentSseEvent) => void
): void {
  for (const s of buildUnderperformingDutScatterOptions(passes)) {
    emit({ type: "chart", option: s.option });
  }
}

/**
 * A 路：用户问「lot 内哪些 DUT 良率偏低」→ 直接 runLotUnderperformingDuts，
 * 确定性出全 DUT 高亮表 + 每 pass 散点图，跳过 LLM。失败落回 LLM（return false）。
 */
async function tryRunUnderperformingDutDirectRoute(
  sessionId: string,
  userQuestion: string,
  _agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void
): Promise<boolean> {
  const history = getHistory(sessionId);
  if (!canRunUnderperformingDutDirectRoute(userQuestion, history)) return false;
  const args = underperformingDutArgsFromText(userQuestion, history);
  if (!args) return false;

  emit({ type: "status", message: "正在分析各 DUT 良率（含 INF 取数，稍慢）…" });
  emit({ type: "tool_start", name: "query_lot_underperforming_duts", args });

  let resp;
  try {
    resp = await runLotUnderperformingDuts({ lot: args.lot, device: args.device });
  } catch {
    return false; // INF 失败 → 落回 LLM，不 dead-end
  }
  const passes = resp.passes ?? [];
  const md = formatAllDutsHighlightMarkdown(passes, resp.lot, resp.device);
  if (!md.trim()) return false;

  emit({ type: "tool_result", name: "query_lot_underperforming_duts", summary: md.slice(0, 200) });
  const block = `${DETERMINISTIC_DATA_SECTION_TITLE}\n\n${md}`;
  emitTextInChunks(block, emit);
  tryEmitUnderperformingDutScatter(passes, emit);
  appendMessages(sessionId, { role: "assistant", content: block });
  emit({ type: "done" });
  return true;
}
```

- [ ] **Step 3c: 注册进 PRE_LLM_DIRECT_ROUTES**

把 `tryRunUnderperformingDutDirectRoute` 加到 `PRE_LLM_DIRECT_ROUTES` 数组**首位**（它需要 lot+DUT低良率意图，与其它路由不重叠；置前保证确定性优先）：
```ts
  const PRE_LLM_DIRECT_ROUTES: Array<typeof tryRunLotListingDirectRoute> = [
    tryRunUnderperformingDutDirectRoute,
    tryRunDutBinAggDirectRoute,
    tryRunBinLotRankingDirectRoute,
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

- [ ] **Step 3d: LLM 工具路径 emit 散点**

在 agentLoop.ts LLM 工具执行段（`runTool(tc.name, fixedArgs, {...})` 调用处，约 3790 行），给 options 加 `onUnderperformingDuts` 回调：
```ts
            const toolResult = await runTool(tc.name, fixedArgs, {
              toolResultMaxChars: agentConfig.toolResultMaxChars,
              history: getHistory(sessionId),
              onJbBinsWrapped: (wrapped) => {
                jbCacheForHistory = storeJbQuerySessionCache(sessionId, wrapped);
              },
              onUnderperformingDuts: (passes) => {
                tryEmitUnderperformingDutScatter(passes, emit);
              },
            });
```

- [ ] **Step 3e: agentToolHandlers.ts — 加回调 + 内部串换高亮表**

`RunToolOptions`（约 100 行）追加字段：
```ts
  /** query_lot_underperforming_duts：算出 passes 后回传，供直连出散点图。 */
  onUnderperformingDuts?: (passes: import("../lotUnderperformingDuts.js").PassUnderperformingDutsResult[]) => void;
```
① 文件顶部加 import：
```ts
import { formatAllDutsHighlightMarkdown } from "./agentUnderperformingDutView.js";
```
② `toolQueryLotUnderperformingDuts` 函数签名加第三参 `options`（与同文件 `toolQueryJbBins(args, maxChars, options?)` 一致）：
```ts
async function toolQueryLotUnderperformingDuts(
  args: Record<string, unknown>,
  maxChars: number,
  options?: RunToolOptions
): Promise<string> {
```
③ `try {}` 块内 `runLotUnderperformingDuts` 之后替换构造串逻辑（**注意参数顺序 `(passes, lot, device)`**）：
```ts
    const result = await runLotUnderperformingDuts({
      lot,
      device: device || undefined,
      passIds: passIds.length > 0 ? passIds : undefined,
      thresholdRatio,
      includeMarkdown: true,
    });
    options?.onUnderperformingDuts?.(result.passes ?? []);
    // 内部工具结果串：用全 DUT 高亮表（非 REST 字段，不违反非破坏约束）
    const md =
      formatAllDutsHighlightMarkdown(result.passes ?? [], result.lot, result.device) ||
      (result.underperformingDutsMarkdown ?? "");
    const { underperformingDutsMarkdown: _md, ...payload } = result;
    void _md;
    const body = truncateResult(payload, maxChars);
    return (md ? md + "\n\n" : "") + body;
```
④ 分发点（`case "query_lot_underperforming_duts":` 第 878 行）把 `options` 透传：
```ts
    case "query_lot_underperforming_duts":
      return toolQueryLotUnderperformingDuts(args, maxChars, options);
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd pcr-ai-api && npx tsx --test test/agentLoop.test.ts`
Expected: PASS（含新 `tryEmitUnderperformingDutScatter` 测试）

- [ ] **Step 5: 全量测试 + typecheck + 提交**

```bash
cd pcr-ai-api && npm test && npm run typecheck
cd /d/AI/PCR-AI-Agent
git add pcr-ai-api/src/lib/agent/agentLoop.ts pcr-ai-api/src/lib/agent/agentToolHandlers.ts pcr-ai-api/test/agentLoop.test.ts
git commit -m "feat(agent): A 路低良率 DUT 直连路由 + LLM 工具路径散点图

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: B 路接线 — JB 概况 best-effort 补 DUT 良率

> **对 spec §3.3 的偏差说明：** spec 原写「并入 `### 🔍 警示 / 规律识别` 节」。该节由**同步**字符串构造器 `formatAlertsAndPatternsSection` 生成，而 DUT 良率需**异步** INF 取数——强行并入需把整条同步链 async 化（跨多调用点大改）。故实现改为在 `emitDeterministicJbTablesReply` 的 **emit 层**（async 上下文）追加一个独立子节 `### 🔬 各 DUT 良率`，紧跟主表之后、分析结论之前。功能等价（同在 lot 概况回复内），风险更低。

**Files:**
- Modify: `pcr-ai-api/src/lib/agent/agentLoop.ts`（`emitDeterministicJbTablesReply` 内新增 `tryAppendUnderperformingDutSection` best-effort 块 + 两处持久化拼接）
- Test: `pcr-ai-api/test/agentLoop.test.ts`（追加：`tryAppendUnderperformingDutSection` payload 无 lot/device 时返回 ""）

**Interfaces:**
- Consumes: Task 1/2/4 的 helper；`runLotUnderperformingDuts`
- Produces: `tryAppendUnderperformingDutSection(payload, emit): Promise<string>`（导出供测试；返回追加的 markdown 供持久化，失败/无数据返回 ""）

- [ ] **Step 1: 写失败测试**（追加到 `test/agentLoop.test.ts`）

顶部 import 追加 `tryAppendUnderperformingDutSection`：
```ts
import { tryAppendUnderperformingDutSection } from "../src/lib/agent/agentLoop.js";
```
测试：
```ts
test("tryAppendUnderperformingDutSection: payload 缺 lot/device 时返回空串、不 emit", async () => {
  const events: any[] = [];
  const out = await tryAppendUnderperformingDutSection({}, (e) => events.push(e));
  assert.equal(out, "");
  assert.equal(events.length, 0);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd pcr-ai-api && npx tsx --test test/agentLoop.test.ts`
Expected: FAIL（未导出）

- [ ] **Step 3a: 加 `tryAppendUnderperformingDutSection`**

在 `tryRunUnderperformingDutDirectRoute` 之后追加：
```ts
/**
 * B 路：JB lot 概况末尾 best-effort 补「各 DUT 良率」高亮表 + 散点图。
 * payload 缺 lot/device 或 INF 失败 → 返回 "" 静默跳过（不阻塞主概况）。
 * 返回追加的 markdown（供调用方并入持久化的 assistant 内容）。
 */
export async function tryAppendUnderperformingDutSection(
  payload: Record<string, unknown>,
  emit: (event: AgentSseEvent) => void
): Promise<string> {
  const lot = String(payload["lot"] ?? "").trim();
  const device = String(payload["device"] ?? "").trim();
  if (!lot || !device) return "";

  emit({ type: "status", message: "正在补充各 DUT 良率分析（较慢）…" });
  let resp;
  try {
    resp = await runLotUnderperformingDuts({ lot, device });
  } catch {
    return ""; // best-effort：失败静默跳过
  }
  const passes = resp.passes ?? [];
  const md = formatAllDutsHighlightMarkdown(passes, resp.lot, resp.device);
  if (!md.trim()) return "";

  const section = `\n\n### 🔬 各 DUT 良率（低于阈值 🔴）\n\n${md}`;
  emit({ type: "text", delta: section });
  tryEmitUnderperformingDutScatter(passes, emit);
  return section;
}
```

- [ ] **Step 3b: 在 `emitDeterministicJbTablesReply` 调用 + 拼接持久化**

在 `emitDeterministicJbTablesReply` 里，`generic`/`lot_overview` 图表块之后（现有 `await tryEmitCardDutBadDieChart(...)` 之后、`if (!withCommentary)` 之前）插入：
```ts
  let dutYieldSection = "";
  if (mode === "generic" || mode === "lot_overview") {
    dutYieldSection = await tryAppendUnderperformingDutSection(payload, emit);
  }
```
然后两处持久化都并入 `dutYieldSection`：

no-commentary 分支（现 `const full = tablesBlock + tableOnlyNote;`）改为：
```ts
    const full = tablesBlock + dutYieldSection + tableOnlyNote;
```
commentary 分支（现 `const full = tablesBlock + "\n\n## 分析结论..." + commentaryOrFallback;`）改为：
```ts
  const full =
    tablesBlock +
    dutYieldSection +
    `\n\n${DETERMINISTIC_COMMENTARY_SECTION_TITLE}\n\n` +
    commentaryOrFallback;
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd pcr-ai-api && npx tsx --test test/agentLoop.test.ts`
Expected: PASS

- [ ] **Step 5: 全量测试 + typecheck + build + 提交**

```bash
cd pcr-ai-api && npm test && npm run typecheck && npm run build
cd /d/AI/PCR-AI-Agent
git add pcr-ai-api/src/lib/agent/agentLoop.ts pcr-ai-api/test/agentLoop.test.ts
git commit -m "feat(agent): B 路 JB 概况 best-effort 补低良率 DUT 表+散点

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: 文档 + 交接

**Files:**
- Modify: `docs/DEV_LOG.md`（顶部新条目）、`docs/TODO.md`（标记完成）
- Create: `docs/HANDOFF_UNDERPERFORMING_DUT_HIGHLIGHT_2026-07-02.md`（给 Cursor 真库/真 INF 复验）

- [ ] **Step 1: 写 DEV_LOG 顶部条目**（date 2026-07-02，标题「低良率 DUT 高亮 + 散点图」，列 5 个 Task 交付 + 测试数）
- [ ] **Step 2: TODO.md 加已完成条目**（✅ … — 2026-07-02 完成；注明真库复验待 Cursor）
- [ ] **Step 3: 写交接 doc**：A 路问句样例（"DR… 哪些 DUT 偏低"）应出高亮表+每 pass 散点；B 路 lot 概况末尾应见「🔬 各 DUT 良率」节（较慢）；真库/真 INF 耗时 + 是否有 lot 触发 device 反查失败需 Cursor 观测。
- [ ] **Step 4: 提交**

```bash
cd /d/AI/PCR-AI-Agent
git add docs/DEV_LOG.md docs/TODO.md docs/HANDOFF_UNDERPERFORMING_DUT_HIGHLIGHT_2026-07-02.md
git commit -m "docs: 低良率 DUT 高亮+散点 DEV_LOG/TODO/交接

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 5: push**

```bash
git push origin feat/jb-route-resolver
```

---

## 备注：无法在沙箱验证的部分

- A 路 / B 路的**真库/真 INF 端到端**（`runLotUnderperformingDuts` 走 Perl `output_site_bin_bylot.pl`）：沙箱无真 INF，只能 Dummy（`INFCONTROL_LAYER_BINS_DUMMY=true`）跑通。真库耗时、device 反查、散点在前端 DarkChart 的实际渲染，交 Cursor 部署后复验（见 Task 6 交接 doc）。
- 前端 `DarkChart` 对 `markLine` / 逐点 `itemStyle.color` 的渲染沿用 ECharts 标准，无需改前端；如实测色带/参考线不显示，回退到交接 doc 记录，再定是否需前端适配。
