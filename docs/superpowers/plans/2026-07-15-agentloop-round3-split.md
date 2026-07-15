# agentLoop.ts Round 3 域拆分 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `pcr-ai-api/src/lib/agent/core/agentLoop.ts`（当前 3387 行）中除主循环骨架外的 ~55 个顶层函数，按职责纯移动式拆分到 `dispatch/directRoutes/` 与 `render/` 下的新文件，同时修复一个预先存在的循环值导入，并抽取 `runAgentLoop` 内部 4 段超长内联逻辑为私有函数。

**Architecture:** 12 个"移动一批函数到一个新文件 → 更新调用方 import → typecheck/test 绿 → 提交"的独立任务，严格按依赖顺序执行（叶子文件先行）。最后一个任务对 `core/agentLoop.ts` 做内部结构优化。全程零行为改变——测试基准就是现有 615 个测试，不新增测试。

**Tech Stack:** TypeScript (Node.js/Express, ESM, `.js` 扩展名的相对 import)，`tsx --test` 测试运行器。

## Global Constraints

- Pure move only：禁止在搬运过程中修改任何函数的逻辑、参数、返回值、命名（Task 12 的内部私有函数抽取除外，且抽取本身也不得改变行为）。
- 禁止 barrel/re-export 层——每个消费方直接从函数的新家 import，不经过中间转发文件。
- 每个新文件遵循项目现有 ~400-500 行软预算。
- 单个函数超过 ~80-100 行时应考虑拆（本计划的 Task 12 专门处理 `runAgentLoop` 里超标的内联逻辑块）。
- 每个任务完成后必须 `npm run typecheck && npm test` 全绿（现有 615 个测试为行为基准；已知 2 个测试历史性失败与本次改动无关，保持原样）。
- 不引入 `undici`（no-undici 规则，与本次改动无关但项目全局生效）。
- 不合并 `refactor/api-domain-split` 到 `main`。

**依赖关系（决定任务执行顺序，后面任务依赖前面任务已完成）：**

```
Task 1 agentLoopShared.ts        (叶子，零依赖)
Task 2 agentChartEmitters.ts     (叶子，零依赖)
Task 3 agentJbTablesReply.ts     依赖 Task 1, 2
Task 4 agentProbeCardPerfReply.ts 依赖 Task 1
Task 5 agentWaferMapDirectRoutes.ts 依赖 Task 1
Task 6 agentJbLotDirectRoutes.ts 依赖 Task 1, 3
Task 7 agentJbBinDirectRoutes.ts 依赖 Task 1, 3
Task 8 agentDutAggDirectRoutes.ts 依赖 Task 1, 2
Task 9 agentProbeCardDirectRoutes.ts 依赖 Task 1, 4
Task 10 修复 agentSemanticDispatch.ts 循环依赖 依赖 Task 1, 3
Task 11 瘦身 core/agentLoop.ts 依赖 Task 1-10 全部
Task 12 runAgentLoop 内部私有函数抽取 依赖 Task 11
Task 13 最终验证
```

**重要提示（给每个任务的实现者）：** 由于本文件在多个任务间被反复修改，**不要依赖本计划文档中给出的行号**——那些行号是撰写本计划时（Task 0 之前）的快照，执行到你的任务时源文件已被前面任务改动过。请用函数名（`grep -n "^function 函数名\|^export function 函数名\|^async function 函数名\|^export async function 函数名"`）在当前文件中定位目标函数的实际起止行。

---

### Task 1: 抽取叶子文件 `core/agentLoopShared.ts`

**Files:**
- Create: `pcr-ai-api/src/lib/agent/core/agentLoopShared.ts`
- Modify: `pcr-ai-api/src/lib/agent/core/agentLoop.ts`（删除 4 个函数体，改为 import）

**Interfaces:**
- Consumes: 无（这 4 个函数在原文件中互不依赖外部符号，是真正的叶子）
- Produces（后续所有任务都会从这里 import）：
  - `export function lastToolMessage(history: ChatMessage[]): ChatMessage | undefined`
  - `export function emitTextInChunks(text: string, emit: (event: AgentSseEvent) => void): void`
  - `cleanStreamErrorMessage(raw: string): string`（当前是模块私有，本次搬出后必须改为 `export`，因为 Task 3/4/6/7/8 都需要用它）
  - `toolResultForHistory(...)`（当前是 `export`，签名照抄原文件，具体参数/返回类型以原文件为准）

**Steps:**

- [ ] **Step 1: 定位并读取 4 个函数的当前完整定义**

```bash
cd pcr-ai-api
grep -n "^function lastToolMessage\|^export function lastToolMessage\|^function emitTextInChunks\|^export function emitTextInChunks\|^function cleanStreamErrorMessage\|^function toolResultForHistory\|^export function toolResultForHistory" src/lib/agent/core/agentLoop.ts
```

用 Read 工具读取这 4 段函数的完整源码（含函数体、JSDoc 如果有）。注意 `AgentSseEvent` 类型是 `emitTextInChunks` 的参数类型，来自同文件顶部的 `export type AgentSseEvent = ...`——新文件需要 `import type { AgentSseEvent } from "./agentLoop.js";`（类型导入，不构成运行时循环）。

- [ ] **Step 2: 创建 `core/agentLoopShared.ts`**

文件内容 = 一行来源注释 + 必要的 `import type { AgentSseEvent } from "./agentLoop.js";` + 这 4 个函数的**逐字节原样拷贝**（`cleanStreamErrorMessage` 加上 `export` 关键字，其余保持原有可见性设定即 `export`）。不改变函数体任何一个字符。

- [ ] **Step 3: 从 `core/agentLoop.ts` 删除这 4 个函数体，改为 import**

删除这 4 段函数定义，在文件顶部 import 区块加入：

```ts
import {
  lastToolMessage,
  emitTextInChunks,
  cleanStreamErrorMessage,
  toolResultForHistory,
} from "./agentLoopShared.js";
```

（`lastToolMessage`/`toolResultForHistory` 原本是 `export` 且可能被其他文件引用——检查 Step 4。）

- [ ] **Step 4: 检查外部消费者**

```bash
grep -rn "agentLoop\.js" src | grep -v "core/agentLoop.ts:"
```

已知消费者（本计划撰写时确认过）：`agentEmbeddedToolParsing.ts`、`dispatch/agentSemanticDispatch.ts`、`tools/agentToolUnderperformingDutsRender.ts`、`sessionLogger.ts`、`routes/agent.ts` —— 除 `agentSemanticDispatch.ts`（Task 10 处理）外，其余只 import `type AgentSseEvent`（类型导入，留在 core，不受影响）。若本任务执行时发现新的运行时值消费者，同步更新其 import 来源为 `agentLoopShared.js`。

- [ ] **Step 5: typecheck + test**

```bash
npm run typecheck
npm test
```
Expected: 两者均无新增失败（与改动前的基线一致：615 个测试，609 通过，2 个已知历史失败，4 个 skip）。

- [ ] **Step 6: Commit**

```bash
git add src/lib/agent/core/agentLoopShared.ts src/lib/agent/core/agentLoop.ts
git commit -m "refactor(api): extract agentLoopShared.ts leaf utilities from agentLoop.ts"
```

---

### Task 2: 抽取 `render/agentChartEmitters.ts`

**Files:**
- Create: `pcr-ai-api/src/lib/agent/render/agentChartEmitters.ts`
- Modify: `pcr-ai-api/src/lib/agent/core/agentLoop.ts`

**Interfaces:**
- Consumes: 无跨新文件依赖（这 8 个函数只互相调用，不依赖 Task 1 的叶子文件）
- Produces（Task 3、Task 8 会用到）：
  - `tryEmitDutBinBarChart(...)` — Task 8 需要
  - `tryEmitTopBinBarChart(...)` — Task 3 需要
  - `computeDutTotalBadDieFromPasses(...)` — 仅本文件内部用（`tryEmitDutCrossLotComparisonTable`/`tryEmitCardDutBadDieChart` 调用），保持模块私有
  - `tryEmitWaferTotalBadDieChart(...)` — 仅本文件内部用（`tryEmitCardDutBadDieChart` 调用），保持模块私有
  - `tryEmitLotYieldTrendChart(...)` — 仅本文件内部用，保持模块私有
  - `tryEmitDutCrossLotComparisonTable(...)` — 仅本文件内部用，保持模块私有
  - `tryEmitCardDutBadDieChart(...)` — Task 3 需要
  - `buildDutBinAggMarkdown(...)` — Task 8 需要

**Steps:**

- [ ] **Step 1: 定位 8 个函数**

```bash
grep -n "^function tryEmitDutBinBarChart\|^function tryEmitTopBinBarChart\|^function computeDutTotalBadDieFromPasses\|^function tryEmitWaferTotalBadDieChart\|^function tryEmitLotYieldTrendChart\|^async function tryEmitDutCrossLotComparisonTable\|^async function tryEmitCardDutBadDieChart\|^function buildDutBinAggMarkdown" src/lib/agent/core/agentLoop.ts
```

Read 完整定义，同时记录它们各自用到的、来自原 `agentLoop.ts` 顶部 import 区块的外部符号（如 `runTool`、某些 `agentJb*` 系列格式化函数等）——这些 import 行要原样带到新文件。

- [ ] **Step 2: 创建 `render/agentChartEmitters.ts`**

来源注释 + 这 8 个函数用到的外部 import（原样照抄用到的那几行，不要整段照抄原文件的 import 区块）+ 8 个函数逐字节原样拷贝。除 `tryEmitDutBinBarChart`、`tryEmitTopBinBarChart`、`tryEmitCardDutBadDieChart`、`buildDutBinAggMarkdown` 需要 `export` 外，其余 4 个保持模块私有（不加 `export`）。

- [ ] **Step 3: 从 `core/agentLoop.ts` 删除这 8 个函数体，改为 import**

```ts
import {
  tryEmitDutBinBarChart,
  tryEmitTopBinBarChart,
  tryEmitCardDutBadDieChart,
  buildDutBinAggMarkdown,
} from "../render/agentChartEmitters.js";
```

只 import 当前 `agentLoop.ts` 剩余代码实际调用到的那几个（此刻 `emitDeterministicJbTablesReply`、`tryRunDutBinAggDirectRoute` 等尚未搬走，仍在本文件内，所以这一步全部 4 个 export 符号目前应该都还在用）。

- [ ] **Step 4: typecheck + test**

```bash
npm run typecheck
npm test
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/render/agentChartEmitters.ts src/lib/agent/core/agentLoop.ts
git commit -m "refactor(api): extract render/agentChartEmitters.ts from agentLoop.ts"
```

---

### Task 3: 抽取 `render/agentJbTablesReply.ts`

**Files:**
- Create: `pcr-ai-api/src/lib/agent/render/agentJbTablesReply.ts`
- Modify: `pcr-ai-api/src/lib/agent/core/agentLoop.ts`

**Interfaces:**
- Consumes:
  - `lastToolMessage`, `emitTextInChunks`, `cleanStreamErrorMessage` from `../core/agentLoopShared.js`（Task 1）
  - `tryEmitTopBinBarChart`, `tryEmitCardDutBadDieChart` from `../render/agentChartEmitters.js`（Task 2）
- Produces（Task 6、Task 7、Task 10 会用到）：
  - `export async function emitDeterministicJbTablesReply(...)`
  - `collectQueryJbBinsLotsThisTurn(...)` — 仅本文件内部用（只有 `emitDeterministicJbTablesReply` 调用），保持模块私有
  - `yieldMonitorNoteFromHistory(...)` — 仅本文件内部用，保持模块私有

**Steps:**

- [ ] **Step 1: 定位 3 个函数**

```bash
grep -n "^export async function emitDeterministicJbTablesReply\|^function collectQueryJbBinsLotsThisTurn\|^function yieldMonitorNoteFromHistory" src/lib/agent/core/agentLoop.ts
```

Read 完整定义（`emitDeterministicJbTablesReply` 约 200 行，是本次搬运中单个函数体量最大的一个，注意完整读取，不要漏尾部）。记录它用到的外部 import（`jb/agentJb*` 系列格式化函数、`agentJbSessionCache`、`agentJbPayloadResolve` 等一大批，原样照抄用到的那些 import 行）。

- [ ] **Step 2: 创建 `render/agentJbTablesReply.ts`**

来源注释 + `import { lastToolMessage, emitTextInChunks, cleanStreamErrorMessage } from "../core/agentLoopShared.js";` + `import { tryEmitTopBinBarChart, tryEmitCardDutBadDieChart } from "./agentChartEmitters.js";` + 该函数原本用到的其余外部 import + 3 个函数逐字节原样拷贝（只有 `emitDeterministicJbTablesReply` 加 `export`）。

- [ ] **Step 3: 从 `core/agentLoop.ts` 删除这 3 个函数体，改为 import**

```ts
import { emitDeterministicJbTablesReply } from "../render/agentJbTablesReply.js";
```

- [ ] **Step 4: typecheck + test**

```bash
npm run typecheck
npm test
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/render/agentJbTablesReply.ts src/lib/agent/core/agentLoop.ts
git commit -m "refactor(api): extract render/agentJbTablesReply.ts from agentLoop.ts"
```

---

### Task 4: 抽取 `render/agentProbeCardPerfReply.ts`

**Files:**
- Create: `pcr-ai-api/src/lib/agent/render/agentProbeCardPerfReply.ts`
- Modify: `pcr-ai-api/src/lib/agent/core/agentLoop.ts`

**Interfaces:**
- Consumes: `emitTextInChunks`, `cleanStreamErrorMessage` from `../core/agentLoopShared.js`（Task 1）
- Produces（Task 9 会用到）：`export async function emitDeterministicProbeCardPerfReply(...)`

**Steps:**

- [ ] **Step 1: 定位函数**

```bash
grep -n "^async function emitDeterministicProbeCardPerfReply" src/lib/agent/core/agentLoop.ts
```

Read 完整定义（约 100 行），记录其用到的外部 import（`probeCard/probeCardTesterPerformance.js` 的 `buildProbeCardPerfSummaryMarkdown`/`PassGroupResult` 等）。

- [ ] **Step 2: 创建 `render/agentProbeCardPerfReply.ts`**

来源注释 + `import { emitTextInChunks, cleanStreamErrorMessage } from "../core/agentLoopShared.js";` + 其余用到的外部 import + 函数体逐字节原样拷贝，加 `export`。

- [ ] **Step 3: 从 `core/agentLoop.ts` 删除函数体，改为 import**

```ts
import { emitDeterministicProbeCardPerfReply } from "../render/agentProbeCardPerfReply.js";
```

- [ ] **Step 4: typecheck + test**

```bash
npm run typecheck
npm test
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/render/agentProbeCardPerfReply.ts src/lib/agent/core/agentLoop.ts
git commit -m "refactor(api): extract render/agentProbeCardPerfReply.ts from agentLoop.ts"
```

---

### Task 5: 抽取 `dispatch/directRoutes/agentWaferMapDirectRoutes.ts`

**Files:**
- Create: `pcr-ai-api/src/lib/agent/dispatch/directRoutes/agentWaferMapDirectRoutes.ts`
- Modify: `pcr-ai-api/src/lib/agent/core/agentLoop.ts`

**Interfaces:**
- Consumes: `emitTextInChunks`, `toolResultForHistory`, `lastToolMessage` from `../../core/agentLoopShared.js`（Task 1；注意本文件在 `dispatch/directRoutes/` 下，比 Task 1-4 多一层目录，相对路径要多一个 `../`）
- Produces（Task 11 的 `runAgentLoop` 会直接调用这些）：
  - `export function finishWaferMapDraw(...)` — 仅本文件内部用（`applyWaferMapRoutePlan`、`tryRunWaferMapWithAutoDeviceLookup` 调用），可保持模块私有
  - `export function applyWaferMapRoutePlan(...)`
  - `export async function tryRunWaferMapWithAutoDeviceLookup(...)`
  - `export async function tryRunDutBinMapDirectRoute(...)`
  - `export async function tryRunDutYieldChartDirectRoute(...)`
  - `export function userWantsDutYieldChart(text: string): boolean`

**Steps:**

- [ ] **Step 1: 定位 6 个函数**

```bash
grep -n "^function finishWaferMapDraw\|^function applyWaferMapRoutePlan\|^async function tryRunWaferMapWithAutoDeviceLookup\|^async function tryRunDutBinMapDirectRoute\|^async function tryRunDutYieldChartDirectRoute\|^function userWantsDutYieldChart" src/lib/agent/core/agentLoop.ts
```

Read 完整定义，记录用到的外部 import（`agentWaferMapRoute.js` 的 `WaferMapRoutePlan` 类型等）。

- [ ] **Step 2: 创建目录与文件**

```bash
mkdir -p src/lib/agent/dispatch/directRoutes
```

来源注释 + `import { emitTextInChunks, toolResultForHistory, lastToolMessage } from "../../core/agentLoopShared.js";` + `import type { AgentSseEvent } from "../../core/agentLoop.js";`（类型导入）+ 其余用到的外部 import + 6 个函数逐字节原样拷贝，全部加 `export`（`finishWaferMapDraw` 虽只被本文件内部用，但为了让审查者一眼看清楚该文件的完整导出面，仍加 export——不强制，若实现者判断保持私有更清晰也可以，但要在 PR 描述里说明）。

- [ ] **Step 3: 从 `core/agentLoop.ts` 删除这 6 个函数体，改为 import**

```ts
import {
  applyWaferMapRoutePlan,
  tryRunWaferMapWithAutoDeviceLookup,
  tryRunDutBinMapDirectRoute,
  tryRunDutYieldChartDirectRoute,
  userWantsDutYieldChart,
} from "../dispatch/directRoutes/agentWaferMapDirectRoutes.js";
```

- [ ] **Step 4: typecheck + test**

```bash
npm run typecheck
npm test
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/dispatch/directRoutes/agentWaferMapDirectRoutes.ts src/lib/agent/core/agentLoop.ts
git commit -m "refactor(api): extract dispatch/directRoutes/agentWaferMapDirectRoutes.ts from agentLoop.ts"
```

---

### Task 6: 抽取 `dispatch/directRoutes/agentJbLotDirectRoutes.ts`

**Files:**
- Create: `pcr-ai-api/src/lib/agent/dispatch/directRoutes/agentJbLotDirectRoutes.ts`
- Modify: `pcr-ai-api/src/lib/agent/core/agentLoop.ts`

**Interfaces:**
- Consumes:
  - `toolResultForHistory` from `../../core/agentLoopShared.js`（Task 1）
  - `emitDeterministicJbTablesReply` from `../../render/agentJbTablesReply.js`（Task 3）
- Produces（Task 11 会直接调用）：
  - `export async function tryRunLotOverviewDirectRoute(...)`
  - `export async function tryRunMaskScopeDirectRoute(...)`
  - `export async function tryRunLotListingDirectRoute(...)`
  - `export async function tryRunEquipmentDirectRoute(...)`
  - `export async function tryRunPerSlotBinRankingDirectRoute(...)`

**Steps:**

- [ ] **Step 1: 定位 5 个函数**

```bash
grep -n "^async function tryRunLotOverviewDirectRoute\|^async function tryRunMaskScopeDirectRoute\|^async function tryRunLotListingDirectRoute\|^async function tryRunEquipmentDirectRoute\|^async function tryRunPerSlotBinRankingDirectRoute" src/lib/agent/core/agentLoop.ts
```

Read 完整定义，记录外部 import（`agentJbOverviewRoute.js`、`agentJbLotListingRoute.js`、`agentJbMaskScopeRoute.js` 等一批路由判断/参数构造函数）。

- [ ] **Step 2: 创建文件**

来源注释 + `import { toolResultForHistory } from "../../core/agentLoopShared.js";` + `import { emitDeterministicJbTablesReply } from "../../render/agentJbTablesReply.js";` + 其余外部 import + 5 个函数逐字节原样拷贝，全部 `export`。

- [ ] **Step 3: 从 `core/agentLoop.ts` 删除函数体，改为 import**

```ts
import {
  tryRunLotOverviewDirectRoute,
  tryRunMaskScopeDirectRoute,
  tryRunLotListingDirectRoute,
  tryRunEquipmentDirectRoute,
  tryRunPerSlotBinRankingDirectRoute,
} from "../dispatch/directRoutes/agentJbLotDirectRoutes.js";
```

- [ ] **Step 4: typecheck + test**

```bash
npm run typecheck
npm test
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/dispatch/directRoutes/agentJbLotDirectRoutes.ts src/lib/agent/core/agentLoop.ts
git commit -m "refactor(api): extract dispatch/directRoutes/agentJbLotDirectRoutes.ts from agentLoop.ts"
```

---

### Task 7: 抽取 `dispatch/directRoutes/agentJbBinDirectRoutes.ts`

**Files:**
- Create: `pcr-ai-api/src/lib/agent/dispatch/directRoutes/agentJbBinDirectRoutes.ts`
- Modify: `pcr-ai-api/src/lib/agent/core/agentLoop.ts`

**Interfaces:**
- Consumes:
  - `emitTextInChunks`, `toolResultForHistory`, `lastToolMessage` from `../../core/agentLoopShared.js`（Task 1）
  - `emitDeterministicJbTablesReply` from `../../render/agentJbTablesReply.js`（Task 3）
  - `findLastToolCallArgs` from `../../agentQueryScope.js`（已存在的外部依赖，原样照抄）
- Produces（Task 11 会直接调用）：
  - `export async function tryRunScopedBadBinDirectRoute(...)`
  - `export async function tryRunBinLotRankingDirectRoute(...)`
  - `export async function tryRunGoodBinValueDirectRoute(...)`
  - `export async function tryRunUnscopedBinClarifyDirectRoute(...)`
  - `export async function tryRunDeterministicJbSummary(...)`
  - `findLastAggregateJbBinsArgs(...)` — 仅本文件内部用（只有 `tryRunDeterministicJbSummary` 调用），保持模块私有

**Steps:**

- [ ] **Step 1: 定位 6 个函数**

```bash
grep -n "^async function tryRunScopedBadBinDirectRoute\|^async function tryRunBinLotRankingDirectRoute\|^async function tryRunGoodBinValueDirectRoute\|^async function tryRunUnscopedBinClarifyDirectRoute\|^async function tryRunDeterministicJbSummary\|^function findLastAggregateJbBinsArgs" src/lib/agent/core/agentLoop.ts
```

Read 完整定义，记录外部 import。

- [ ] **Step 2: 创建文件**

来源注释 + `import { emitTextInChunks, toolResultForHistory, lastToolMessage } from "../../core/agentLoopShared.js";` + `import { emitDeterministicJbTablesReply } from "../../render/agentJbTablesReply.js";` + 其余外部 import + 6 个函数逐字节原样拷贝（`findLastAggregateJbBinsArgs` 不加 export，其余 5 个加 export）。

- [ ] **Step 3: 从 `core/agentLoop.ts` 删除函数体，改为 import**

```ts
import {
  tryRunScopedBadBinDirectRoute,
  tryRunBinLotRankingDirectRoute,
  tryRunGoodBinValueDirectRoute,
  tryRunUnscopedBinClarifyDirectRoute,
  tryRunDeterministicJbSummary,
} from "../dispatch/directRoutes/agentJbBinDirectRoutes.js";
```

- [ ] **Step 4: typecheck + test**

```bash
npm run typecheck
npm test
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/dispatch/directRoutes/agentJbBinDirectRoutes.ts src/lib/agent/core/agentLoop.ts
git commit -m "refactor(api): extract dispatch/directRoutes/agentJbBinDirectRoutes.ts from agentLoop.ts"
```

---

### Task 8: 抽取 `dispatch/directRoutes/agentDutAggDirectRoutes.ts`

**Files:**
- Create: `pcr-ai-api/src/lib/agent/dispatch/directRoutes/agentDutAggDirectRoutes.ts`
- Modify: `pcr-ai-api/src/lib/agent/core/agentLoop.ts`

**Interfaces:**
- Consumes:
  - `emitTextInChunks`, `lastToolMessage`, `cleanStreamErrorMessage` from `../../core/agentLoopShared.js`（Task 1）
  - `tryEmitDutBinBarChart`, `buildDutBinAggMarkdown` from `../../render/agentChartEmitters.js`（Task 2）
  - `tryEmitUnderperformingDutScatter` from `../../tools/agentToolUnderperformingDutsRender.js`（已存在的外部依赖，原样照抄，不受本次拆分影响）
- Produces（Task 11 会直接调用）：
  - `export async function tryRunDutBinAggDirectRoute(...)`
  - `export async function tryRunDutBinAggAutoRoute(...)`
  - `export async function tryRunUnderperformingDutDirectRoute(...)`

**Steps:**

- [ ] **Step 1: 定位 3 个函数**

```bash
grep -n "^async function tryRunDutBinAggDirectRoute\|^async function tryRunDutBinAggAutoRoute\|^async function tryRunUnderperformingDutDirectRoute" src/lib/agent/core/agentLoop.ts
```

Read 完整定义（`tryRunDutBinAggAutoRoute` 约 100 行），记录外部 import。

- [ ] **Step 2: 创建文件**

来源注释 + `import { emitTextInChunks, lastToolMessage, cleanStreamErrorMessage } from "../../core/agentLoopShared.js";` + `import { tryEmitDutBinBarChart, buildDutBinAggMarkdown } from "../../render/agentChartEmitters.js";` + 其余外部 import（含 `tryEmitUnderperformingDutScatter`）+ 3 个函数逐字节原样拷贝，全部 `export`。

- [ ] **Step 3: 从 `core/agentLoop.ts` 删除函数体，改为 import**

```ts
import {
  tryRunDutBinAggDirectRoute,
  tryRunDutBinAggAutoRoute,
  tryRunUnderperformingDutDirectRoute,
} from "../dispatch/directRoutes/agentDutAggDirectRoutes.js";
```

- [ ] **Step 4: typecheck + test**

```bash
npm run typecheck
npm test
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/dispatch/directRoutes/agentDutAggDirectRoutes.ts src/lib/agent/core/agentLoop.ts
git commit -m "refactor(api): extract dispatch/directRoutes/agentDutAggDirectRoutes.ts from agentLoop.ts"
```

---

### Task 9: 抽取 `dispatch/directRoutes/agentProbeCardDirectRoutes.ts`

**Files:**
- Create: `pcr-ai-api/src/lib/agent/dispatch/directRoutes/agentProbeCardDirectRoutes.ts`
- Modify: `pcr-ai-api/src/lib/agent/core/agentLoop.ts`

**Interfaces:**
- Consumes:
  - `lastToolMessage` from `../../core/agentLoopShared.js`（Task 1）
  - `emitDeterministicProbeCardPerfReply` from `../../render/agentProbeCardPerfReply.js`（Task 4）
- Produces（Task 11 会直接调用）：
  - `export async function tryRunProbeCardPerfDirectRoute(...)`
  - `export async function tryRunDeterministicProbeCardPerfSummary(...)`

**Steps:**

- [ ] **Step 1: 定位 2 个函数**

```bash
grep -n "^async function tryRunProbeCardPerfDirectRoute\|^async function tryRunDeterministicProbeCardPerfSummary" src/lib/agent/core/agentLoop.ts
```

Read 完整定义。

- [ ] **Step 2: 创建文件**

来源注释 + `import { lastToolMessage } from "../../core/agentLoopShared.js";` + `import { emitDeterministicProbeCardPerfReply } from "../../render/agentProbeCardPerfReply.js";` + 其余外部 import + 2 个函数逐字节原样拷贝，全部 `export`。

- [ ] **Step 3: 从 `core/agentLoop.ts` 删除函数体，改为 import**

```ts
import {
  tryRunProbeCardPerfDirectRoute,
  tryRunDeterministicProbeCardPerfSummary,
} from "../dispatch/directRoutes/agentProbeCardDirectRoutes.js";
```

- [ ] **Step 4: typecheck + test**

```bash
npm run typecheck
npm test
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/dispatch/directRoutes/agentProbeCardDirectRoutes.ts src/lib/agent/core/agentLoop.ts
git commit -m "refactor(api): extract dispatch/directRoutes/agentProbeCardDirectRoutes.ts from agentLoop.ts"
```

---

### Task 10: 修复 `agentSemanticDispatch.ts` 的历史循环依赖

**Files:**
- Modify: `pcr-ai-api/src/lib/agent/dispatch/agentSemanticDispatch.ts`

**Interfaces:**
- Consumes: `lastToolMessage`, `emitTextInChunks`, `toolResultForHistory` from `../core/agentLoopShared.js`（Task 1）；`emitDeterministicJbTablesReply` from `../render/agentJbTablesReply.js`（Task 3）
- Produces: 无新导出，仅修正 import 来源

**Steps:**

- [ ] **Step 1: 读取当前 import 块**

```bash
grep -n "^import" src/lib/agent/dispatch/agentSemanticDispatch.ts | head -30
```

确认当前第 19-24 行左右是：
```ts
import {
  lastToolMessage,
  emitTextInChunks,
  emitDeterministicJbTablesReply,
  toolResultForHistory,
} from "../core/agentLoop.js";
```

- [ ] **Step 2: 拆成两条 import，指向新家**

```ts
import {
  lastToolMessage,
  emitTextInChunks,
  toolResultForHistory,
} from "../core/agentLoopShared.js";
import { emitDeterministicJbTablesReply } from "../render/agentJbTablesReply.js";
```

保留原有 `import type { AgentSseEvent } from "../core/agentLoop.js";`（类型导入不变）。

- [ ] **Step 3: 确认 core → dispatch 单向依赖已成立**

```bash
grep -n "agentSemanticDispatch" src/lib/agent/core/agentLoop.ts
```

`core/agentLoop.ts` 仍然 import `tryRunSemanticDispatchDirectRoute` from `../dispatch/agentSemanticDispatch.js`（这条边保留，方向是 core → dispatch，不是循环）；而 `agentSemanticDispatch.ts` 不再反向 import 任何 core 的运行时值——循环消除。

- [ ] **Step 4: typecheck + test**

```bash
npm run typecheck
npm test
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/dispatch/agentSemanticDispatch.ts
git commit -m "fix(api): break circular value-import between agentLoop.ts and agentSemanticDispatch.ts"
```

---

### Task 11: 瘦身 `core/agentLoop.ts`，接好 `runAgentLoop` 对所有搬走函数的引用

**Files:**
- Modify: `pcr-ai-api/src/lib/agent/core/agentLoop.ts`

**Interfaces:**
- Consumes: Task 1-9 产出的全部 export 符号（`agentLoopShared.js`、`render/agentChartEmitters.js`、`render/agentJbTablesReply.js`、`render/agentProbeCardPerfReply.js`、`dispatch/directRoutes/*.ts` 五个文件）
- Produces: `core/agentLoop.ts` 精简后仍导出 `runAgentLoop`、`type AgentSseEvent`、`lastUserMessageText`（如果外部有用到则保持原可见性，否则不强制改）

**Steps:**

- [ ] **Step 1: 确认此刻文件里剩余的顶层函数清单**

```bash
grep -n "^export function \|^export async function \|^function \|^async function " src/lib/agent/core/agentLoop.ts
```

预期只剩：`summarizeHistory`、`lastUserMessageText`、`isTouchdownQuestion`、`isTestItemMappingQuestion`、`chartToolFallbackMessage`、`jbBinsYieldFallbackMessage`、`finishWithJbServerTablesFallback`、`parseToolCallArgs`、`toolCallArgsUsable`、`mergeStructuredWithEmbedded`、`selectToolSchemas`、`getToolResourceGroup`、`getRecentSummaryToolNames`、`getSummaryContext`、`executeRoundToolCalls`、`runTouchdownSummaryReply`、`buildSummaryUserNudge`、`prepareRunAgentLoopContext`、`runAgentLoop`（如果 Task 1-9 已按计划把其余全部移走，这里应该正好剩这 19 个 + `AgentSseEvent` 类型定义）。

- [ ] **Step 2: 检查顶部 import 区块，清理不再使用的 import**

Task 1-9 依次删除函数体后，原本只被那些函数使用的 import（比如 `agentJbOverviewRoute.js` 里的几个符号，若只被 `tryRunLotOverviewDirectRoute` 用，现在该函数已搬到 Task 6 的新文件里）会变成未使用 import。用 `npm run typecheck` 的 TS6133（unused variable，如果项目 tsconfig 开了 `noUnusedLocals`）或手动检查每个 import 符号是否仍被文件内代码引用来清理。

```bash
grep -n "noUnusedLocals\|noUnusedParameters" tsconfig.json
```

如果没开这两个编译选项，typecheck 不会报未使用 import，需要手动逐个核对（每个 import 符号在文件内 grep 一次确认还有没有被引用）。

- [ ] **Step 3: 确认 `runAgentLoop` 内部对已搬移函数的调用点改为从新文件 import 的符号**

`runAgentLoop` 主体不改变任何调用逻辑，只是这些被调用的函数名现在来自 import 而非本文件内定义——因为 Task 1-9 已经在各自任务里把对应 import 语句加好了，这一步是**核对**而非新增：

```bash
grep -n "^import" src/lib/agent/core/agentLoop.ts | wc -l
```

确认 Task 1、2、3、4、5、6、7、8、9 各自加入的 import 语句都还在（没有被中途误删）。

- [ ] **Step 4: typecheck + test**

```bash
npm run typecheck
npm test
```

Expected: 全绿，与基线一致。

- [ ] **Step 5: 行数核对**

```bash
wc -l src/lib/agent/core/agentLoop.ts
```

Expected: 约 1600-1700 行（含 `runAgentLoop` 自身 ~523 行）。若明显偏离（比如仍有 2500+ 行），说明 Task 1-9 中有函数体没删干净，回头检查。

- [ ] **Step 6: Commit**

```bash
git add src/lib/agent/core/agentLoop.ts
git commit -m "refactor(api): slim core/agentLoop.ts after Round 3 direct-route/render extraction"
```

---

### Task 12: `runAgentLoop` 内部 4 段内联逻辑抽成私有函数

**Files:**
- Modify: `pcr-ai-api/src/lib/agent/core/agentLoop.ts`

**Interfaces:**
- Consumes: 无新外部依赖（这是同文件内的纯内部重构）
- Produces: 4 个新增的模块私有函数（不导出，仅 `runAgentLoop` 内部调用）：
  - `buildRoundSystemPrompt(...)` — system prompt / nudge 拼装逻辑
  - `applySummaryRoundToolCallGuard(...)` — summary-round 工具调用过滤逻辑
  - 一个处理 pending-query 的私有函数（命名由实现者根据实际逻辑决定，例如 `runPendingQueryFollowUp`）
  - 一个处理 post-stream 收尾的私有函数（命名由实现者根据实际逻辑决定，例如 `finalizeStreamedTurn`）

**Steps:**

- [ ] **Step 1: 定位 `runAgentLoop` 当前完整边界**

```bash
grep -n "^export async function runAgentLoop" src/lib/agent/core/agentLoop.ts
```

Read 完整函数体（Task 11 完成后应该在文件末尾，约 523 行）。

- [ ] **Step 2: 识别 4 段内联逻辑块的确切起止行**

在 spec 撰写时（Round 3 设计阶段）识别到的 4 段大致特征（重新执行时用 grep 关键字定位准确行号，行号会因 Task 1-11 的改动而漂移）：
  - **system prompt / nudge 拼装**：包含 `waferJbNudge`、`dutBinNudge`、`dutYieldChartNudge`、`lotOverviewNudge`、`summarySuffix`、`announcementNudge` 等局部变量，最终拼接进 `systemContent`
  - **summary-round 工具调用过滤**：区分 conclusion tools（`generate_chart`/`ask_clarification`）vs data-fetch tools，过滤 `toolCalls`/`embeddedCalls`
  - **pending-query 处理**：调用 `detectPendingQuery` 后自动追加一次工具调用的逻辑
  - **post-stream 收尾**：`announcementNudge` 重试、空 `textBuffer` 兜底、fact-check、`assistant` 消息 append、chart-only-round 快捷路径

```bash
grep -n "waferJbNudge\|detectPendingQuery\|announcementNudge" src/lib/agent/core/agentLoop.ts
```

- [ ] **Step 3: 逐段抽取为私有函数**

对每一段：
1. 确定该段读取哪些外部局部变量（闭包捕获的 `history`、`config`、`emit`、循环计数器等）——这些成为新私有函数的参数
2. 确定该段修改/返回哪些值——这些成为新私有函数的返回值（如果原来是就地修改多个局部变量，返回一个对象包装它们）
3. 把该段代码原样搬进新的私有函数体（**不改变任何一行逻辑判断**，只改变变量的传入传出方式）
4. 在 `runAgentLoop` 原位置替换为对新私有函数的调用，赋值回原来的局部变量名

抽取顺序建议：先抽 `buildRoundSystemPrompt`（最独立，纯计算无副作用），每抽完一个就跑一次 typecheck+test 再抽下一个，避免一次性改动过大难以定位问题。

- [ ] **Step 4: 每抽取一个私有函数后跑一次 typecheck + test**

```bash
npm run typecheck
npm test
```

Expected: 每次都全绿。如果某一步 test 失败，说明该段抽取时遗漏了某个闭包变量的传递，回退该步骤重新分析依赖。

- [ ] **Step 5: 全部 4 段抽取完成后，确认 `runAgentLoop` 主体行数明显缩短**

```bash
grep -n "^export async function runAgentLoop" src/lib/agent/core/agentLoop.ts
wc -l src/lib/agent/core/agentLoop.ts
```

Expected: `runAgentLoop` 主体（不含新抽出的 4 个私有函数）应降到 ~280-320 行左右（523 减去约 240 行被抽走的内联逻辑，实际抽出后会略多于原始行数因为要加函数签名/参数传递样板）。

- [ ] **Step 6: Commit**

```bash
git add src/lib/agent/core/agentLoop.ts
git commit -m "refactor(api): extract 4 inline logic blocks from runAgentLoop into private helpers"
```

---

### Task 13: 最终验证

**Files:** 无新增/修改，只运行验证命令并更新 ledger。

**Steps:**

- [ ] **Step 1: 全量验证三件套**

```bash
cd pcr-ai-api
npm run typecheck
npm test
npm run build
```

Expected: typecheck 干净；test 615 项，609 通过、2 个已知历史失败、4 个 skip（与本轮改动前基线一致）；build 干净（含 `verify-dist-no-undici`）。

- [ ] **Step 2: 文件行数审计**

```bash
find src -name "*.ts" | xargs wc -l | sort -n | tail -25
```

确认 `core/agentLoop.ts` 不再出现在超标名单里；新增的 9 个文件（`agentLoopShared.ts`、`agentChartEmitters.ts`、`agentJbTablesReply.ts`、`agentProbeCardPerfReply.ts`、5 个 `directRoutes/*.ts`）均在 ~400-500 行软预算以内。

- [ ] **Step 3: 依赖图人工核验**

```bash
grep -rn "from \"\.\./core/agentLoop\.js\"\|from \"\.\./\.\./core/agentLoop\.js\"\|from \"\./agentLoop\.js\"" src
```

确认所有运行时值导入（非 `import type`）都不再反向指向 `core/agentLoop.ts`（除了 `routes/agent.ts` 里对 `runAgentLoop` 的正常入口调用）。

- [ ] **Step 4: 更新 `.superpowers/sdd/progress.md`**

追加 Round 3（Task 1-13）完成记录：每个任务的目标文件、commit SHA、审查结论；总结行注明分支仍未与 `main` 合并。

- [ ] **Step 5: Commit（仅 ledger）**

```bash
git add .superpowers/sdd/progress.md
git commit -m "docs: record Round 3 (agentLoop.ts split) completion in SDD ledger"
```

---

## Self-Review Notes

- **Spec 覆盖检查**：spec 中的 9 个目标文件（1 叶子 + 3 render + 5 dispatch）分别对应 Task 1-9；循环依赖修复对应 Task 10；core 瘦身对应 Task 11；`runAgentLoop` 内部抽取对应 Task 12；验证对应 Task 13。spec 的"范围外"条款（不做结构性去重、不动 `tools/` 目录、不合并 main）在 Global Constraints 与各任务步骤中均未触碰，符合。
- **依赖顺序检查**：已按"谁被谁用"重新排序（叶子文件优先，`render/agentJbTablesReply.ts` 排在依赖它的 3 个 `dispatch/directRoutes` 文件之前），与设计文档的依赖图一致。
- **符号一致性检查**：各任务的 Interfaces 块里 Consumes/Produces 的函数名前后一致（如 `emitDeterministicJbTablesReply` 在 Task 3 产出、Task 6/7/10 消费，命名和路径全程一致）。
