# 单 Lot 良品 Bin 判定失效修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复单 lot 场景下"各 DUT 良率"/"DUT 集中度分析"两个功能因良品 bin 判定失败而恒报 0% 良率的 bug（`agentUnderperformingDutView.ts` 的"整体良率 0%…请核对 pass/bin 口径"警示）。

**Architecture:** 单 lot 场景下停止依赖为跨 lot 大数据量场景设计的 die 体积启发式（`goodBinNumbersFromSiteBinPasses`，`avg > 100` 绝对阈值在单 lot 每 DUT 仅几十颗 die 时永远不成立），改为直接信任 JB `PASSBIN` 字段（按 `-` 切分，每个数字都是良品 bin），并最终删除不再被调用的启发式函数。

**Tech Stack:** Node.js + TypeScript（`pcr-ai-api`），`node:test` 测试。

## Global Constraints

- **已知取舍（必须在代码注释里体现）**：本次移除的"PASSBIN 必须给出 BIN1 之外额外信号才采信"门槛，是之前专门为 NF12595.1A 那次历史 bug 加的保护（详见 `docs/superpowers/specs/2026-07-05-lot-underperforming-duts-goodbin-fix-design.md` 的"已知的取舍"一节）。本次移除后，若某设备 `PASSBIN` 恰好为空且真实良品 bin 非 BIN1，会重新出现类似问题——**该风险已与用户明确沟通并接受**，不是本计划的疏漏。每个改动点必须留下清晰注释说明这一点，供未来维护者理解。
- **不动 `compactSiteBinPasses`/`GOOD_BIN_AVG_THRESHOLD`**（`agentToolHandlers.ts`）：这是展示层压缩逻辑，不参与良率计算，与本次修复无关，禁止顺手改动。
- **Oracle/Dummy 双路径同步（项目硬规则）**：本计划复用已有的 `fetchJbTestRowsForLot`（已同时实现 Dummy 与 Oracle 两条路径），不新增 SQL，故无需额外的双路径工作，但任何测试都应验证 Dummy 路径下的行为。
- 运行测试统一用 `cd pcr-ai-api && npx tsx --test test/<file>.ts` 或 `npm test`（后者跑全量，运行时间较长，仅在每个任务末尾和计划完成后各跑一次）。

---

### Task 1: `buildGoodBinsByPassFromJbRows` 移除信号门槛 + 导出 `fetchJbTestRowsForLot`

**Files:**
- Modify: `pcr-ai-api/src/lib/lotUnderperformingDutsResolve.ts`
- Test: `pcr-ai-api/test/lotUnderperformingDuts.test.ts`

**Interfaces:**
- Produces: `export async function fetchJbTestRowsForLot(device: string, lot: string, passIds: number[]): Promise<Record<string, unknown>[]>`（原有函数，本任务只加 `export` 关键字，供 Task 3 复用）；`buildGoodBinsByPassFromJbRows` 的导出签名不变（`(rows) => Map<number, Set<number>>`），只改内部实现。

- [ ] **Step 1: 改写现有的冲突测试，反映新行为**

打开 `pcr-ai-api/test/lotUnderperformingDuts.test.ts`，找到这一段（第 145-156 行）：

```ts
  // 回归：PASSBIN 为空/未取到（无信息）时不应把 passId 计入 map（否则会被
  // resolveGoodBinsForPass 当成「JB 确认良品 bin 只有 BIN1」，跳过 INF 启发式回退，
  // 导致真实良品 bin 非 BIN1 的 lot 整体良率恒为 0%——NF12595.1A 类问题的根因）。
  test("passId with no PASSBIN signal on any row is omitted (caller falls back to INF heuristic)", () => {
    const map = buildGoodBinsByPassFromJbRows([
      { PASSID: 1, PASSBIN: null },
      { PASSID: 1, PASSBIN: "" },
      { PASSID: 3, PASSBIN: "1-55" },
    ]);
    assert.equal(map.has(1), false);
    assert.deepEqual([...map.get(3)!].sort((a, b) => a - b), [1, 55]);
  });
```

替换为（新行为：即使没有"额外信号"，只要有 JB 行数据就直接采信，恒含 BIN1）：

```ts
  // 有意的取舍（2026-07-05）：曾经这道门槛专门防 NF12595.1A 那次历史 bug（PASSBIN 为空、
  // 真实良品 bin 非 BIN1 时误判）。现已移除——单 lot 场景下 INF 启发式回退本身被证实
  // 在小 die 量场景下必然失效（>100 avg/DUT 绝对阈值不适用于单 lot 每 DUT 仅几十颗 die
  // 的情况），与其保留"防旧 bug 但制造新 bug"的门槛，不如直接信任 JB 权威字段 PASSBIN。
  // 该取舍已与用户确认；若 PASSBIN 为空且真实良品 bin 非 BIN1，仍会误判为 0% 良率，
  // 需要另外的信号源解决，不在此次修复范围内。
  test("passId is always included once it has JB rows, even with no signal beyond BIN1", () => {
    const map = buildGoodBinsByPassFromJbRows([
      { PASSID: 1, PASSBIN: null },
      { PASSID: 1, PASSBIN: "" },
      { PASSID: 3, PASSBIN: "1-55" },
    ]);
    assert.deepEqual([...map.get(1)!].sort((a, b) => a - b), [1]);
    assert.deepEqual([...map.get(3)!].sort((a, b) => a - b), [1, 55]);
  });
```

- [ ] **Step 2: 新增复现本次 bug 场景的回归测试**

紧接着上面那个测试之后（仍在 `describe("buildGoodBinsByPassFromJbRows", ...)` 块内），新增：

```ts
  test("single-lot small-die-count scenario: PASSBIN gives only BIN1, goodBins is {1} not empty", () => {
    // 复现 WA01N39W/DR41803.1Y 场景：每 DUT total die 数远低于 100（旧 INF 启发式的
    // 绝对阈值），PASSBIN 只解析出 BIN1（无「额外」信号）。修复前 map 会缺失该 passId，
    // resolveGoodBinsForPass 退回 INF 启发式，>100 绝对阈值在此规模下必然返回空集合，
    // 导致良品 bin 判定为空、良率恒为 0%。
    const map = buildGoodBinsByPassFromJbRows([
      { PASSID: 1, PASSBIN: "1" },
      { PASSID: 1, PASSBIN: "1" },
    ]);
    assert.ok(map.has(1), "passId 1 must be present even though PASSBIN only ever said BIN1");
    assert.deepEqual([...map.get(1)!], [1]);
  });
```

- [ ] **Step 3: 运行测试确认失败（此时实现还没改，第一条改写的测试会失败）**

Run: `cd pcr-ai-api && npx tsx --test test/lotUnderperformingDuts.test.ts`
Expected: FAIL —— `"passId is always included once it has JB rows, even with no signal beyond BIN1"` 失败，因为 `map.get(1)` 当前为 `undefined`（旧逻辑仍会把它剔除）。

- [ ] **Step 4: 实现 —— 移除信号门槛，导出 `fetchJbTestRowsForLot`**

打开 `pcr-ai-api/src/lib/lotUnderperformingDutsResolve.ts`，找到顶部的 import（第 10 行）：

```ts
import { goodBinIndicesForJbRow, jbRowHasExtraGoodBinSignal } from "./jbYieldCalc.js";
```

替换为（`jbRowHasExtraGoodBinSignal` 不再需要）：

```ts
import { goodBinIndicesForJbRow } from "./jbYieldCalc.js";
```

找到这一整段（第 91-124 行）：

```ts
/**
 * 合并 lot 内各 wafer JB 行的良品 bin（PASSBIN 段 + isGoodBin），按 passId 分组。
 *
 * 仅当某 passId 至少一行提供了「BIN1 之外」的良品 bin 信号（见
 * `jbRowHasExtraGoodBinSignal`）时，才把该 passId 计入返回结果；否则不计入，
 * 交由 `resolveGoodBinsForPass` 回退 INF 启发式。
 *
 * 原因：`goodBinIndicesForJbRow` 恒会硬编码加入 BIN1，若直接按「结果集合非空」判定
 * 「JB 已给出良品 bin」，会把「PASSBIN 为空/未取到（无信息）」误判为「JB 确认良品 bin
 * 只有 BIN1」——当该 lot 真实良品 bin 并非 BIN1 时（如 PASSBIN 字段为 null），会导致
 * 整 pass 良率恒为 0% 且不再尝试 INF 启发式。
 */
export function buildGoodBinsByPassFromJbRows(
  rows: ReadonlyArray<Record<string, unknown>>
): Map<number, Set<number>> {
  const byPass = new Map<number, Set<number>>();
  const hasSignalByPass = new Set<number>();
  for (const row of rows) {
    const passId = Number(row.PASSID ?? row.passId);
    if (!Number.isInteger(passId)) continue;
    const good = goodBinIndicesForJbRow(row);
    let set = byPass.get(passId);
    if (!set) {
      set = new Set<number>();
      byPass.set(passId, set);
    }
    for (const n of good) set.add(n);
    if (jbRowHasExtraGoodBinSignal(row)) hasSignalByPass.add(passId);
  }
  for (const passId of [...byPass.keys()]) {
    if (!hasSignalByPass.has(passId)) byPass.delete(passId);
  }
  return byPass;
}
```

替换为：

```ts
/**
 * 合并 lot 内各 wafer JB 行的良品 bin（PASSBIN 段 + isGoodBin），按 passId 分组。
 * `goodBinIndicesForJbRow` 恒含 BIN1 硬编码，外加 PASSBIN 按 `-` 切分出的每个数字。
 *
 * 有意的取舍（2026-07-05）：曾经这里有道门槛——只有某 passId 至少一行给出「BIN1 之外」
 * 的额外良品 bin 信号才采信 PASSBIN，否则交由 resolveGoodBinsForPass 回退 INF 启发式
 * （`goodBinNumbersFromSiteBinPasses`，avg die/DUT > 100 才算良品 bin）。该门槛是专门为
 * NF12595.1A 那次历史 bug 加的：PASSBIN 为空时，若直接信任「无信息 = 良品 bin 只有
 * BIN1」，真实良品 bin 非 BIN1 的 lot 良率会恒为 0%。
 *
 * 现已移除该门槛：单 lot 场景（本模块的唯一使用场景）下，INF 启发式回退本身被证实必然
 * 失效——它的 >100 绝对阈值是为跨 lot 聚合场景（每 DUT 数千颗 die）设计的，单 lot 每
 * DUT 通常仅几十颗，任何 BIN 都不可能超过该阈值，导致良品 bin 恒被判定为空集合、良率
 * 恒为 0%（WA01N39W/DR41803.1Y 场景）。与其保留「防旧 bug 但制造新 bug」的门槛，不如
 * 直接信任 JB 权威字段 PASSBIN。若未来某设备 PASSBIN 恰好为空且真实良品 bin 非 BIN1，
 * 仍会重现 NF12595.1A 那类问题——该风险已与用户明确沟通并接受，需要时另外处理。
 */
export function buildGoodBinsByPassFromJbRows(
  rows: ReadonlyArray<Record<string, unknown>>
): Map<number, Set<number>> {
  const byPass = new Map<number, Set<number>>();
  for (const row of rows) {
    const passId = Number(row.PASSID ?? row.passId);
    if (!Number.isInteger(passId)) continue;
    const good = goodBinIndicesForJbRow(row);
    let set = byPass.get(passId);
    if (!set) {
      set = new Set<number>();
      byPass.set(passId, set);
    }
    for (const n of good) set.add(n);
  }
  return byPass;
}
```

Then find (around line 126):

```ts
async function fetchJbTestRowsForLot(
```

Replace with:

```ts
export async function fetchJbTestRowsForLot(
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd pcr-ai-api && npx tsx --test test/lotUnderperformingDuts.test.ts`
Expected: PASS（全部用例，包括改写的和新增的）

- [ ] **Step 6: Commit**

```bash
git add pcr-ai-api/src/lib/lotUnderperformingDutsResolve.ts pcr-ai-api/test/lotUnderperformingDuts.test.ts
git commit -m "fix(api): 单lot良品bin判定不再要求PASSBIN额外信号，导出fetchJbTestRowsForLot"
```

---

### Task 2: `resolveGoodBinsForPass` 最终回退简化为固定 BIN1

**Files:**
- Modify: `pcr-ai-api/src/lib/lotUnderperformingDuts.ts`
- Test: `pcr-ai-api/test/lotUnderperformingDuts.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `buildGoodBinsByPassFromJbRows`（不直接调用，但本任务改的 `resolveGoodBinsForPass` 是它的下游消费者：`opts.goodBinsByPassId` 参数由调用方用 Task 1 的函数构建后传入）。
- Produces: `resolveGoodBinsForPass` 保持内部（不导出）函数，行为变化：`opts.goodBinsByPassId` 里完全没有该 passId 的 key 时，返回 `new Set([HARD_GOOD_BIN])` 而不是走 INF 启发式。

这个改动只影响"JB 行查询压根没覆盖到这个 passId"这种边界情况（Task 1 之后，只要该 passId 有 JB 行数据，map 就必有该 key；只有 JB 行查询没查到任何该 passId 的行时才会走到这个最终回退）。

- [ ] **Step 1: 写覆盖这个边界情况的失败测试**

打开 `pcr-ai-api/test/lotUnderperformingDuts.test.ts`，在 `describe("lotUnderperformingDuts compute", ...)` 块内、`"goodBinsByPassId: BIN55 good die counts when BIN1 empty..."` 测试（第 93-105 行）之后，新增：

```ts
  test("resolveGoodBinsForPass falls back to {BIN1} when goodBinsByPassId lacks this passId entirely", () => {
    // 边界情况：goodBinsByPassId 这个 Map 本身存在，但完全没有当前 passId 的 key
    // （例如 JB 行查询没覆盖到这个 pass）。修复前会退回 INF 启发式（goodBinNumbersFromSiteBinPasses，
    // >100 avg/DUT 绝对阈值），单 lot 小 die 量场景下必然返回空集合、良率恒为 0%。
    // 修复后应直接兜底为 {HARD_GOOD_BIN}（=1），不再依赖已被证实有缺陷的启发式。
    const p = pass(1, [
      { bin: "bin1", duts: [{ dut: 1, dieCount: 20 }, { dut: 2, dieCount: 20 }] },
      { bin: "bin11", duts: [{ dut: 1, dieCount: 5 }, { dut: 2, dieCount: 5 }] },
    ]);
    const result = computeUnderperformingDutsForPass(p, {
      goodBinsByPassId: new Map(), // passId 1 不在其中
    });
    assert.ok(result.baseline, "baseline must not be null — BIN1 must be recognized as good");
    assert.equal(result.baseline!.yieldPct, 80);
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd pcr-ai-api && npx tsx --test test/lotUnderperformingDuts.test.ts`
Expected: FAIL —— 当前实现走 `buildGoodBinsFromInfHeuristic([pass])`，`avg` 每 DUT 只有 10~20 颗，远低于 100，两个 bin 都判不上良品 bin，`baseline!.yieldPct` 会是 `0` 而不是期望的 `80`。

- [ ] **Step 3: 实现 —— 简化最终回退，删除死代码**

打开 `pcr-ai-api/src/lib/lotUnderperformingDuts.ts`，删除顶部这一行 import：

```ts
import { goodBinNumbersFromSiteBinPasses } from "./agent/agentDutConcentration.js";
```

删除这个函数（第 61-65 行）：

```ts
function buildGoodBinsFromInfHeuristic(passes: SiteBinPass[]): Set<number> {
  const good = goodBinNumbersFromSiteBinPasses(passes);
  good.add(HARD_GOOD_BIN);
  return good;
}
```

找到 `resolveGoodBinsForPass`（第 67-75 行）：

```ts
function resolveGoodBinsForPass(
  pass: SiteBinPass,
  opts: LotUnderperformingDutsOptions
): Set<number> {
  if (opts.goodBins) return opts.goodBins;
  const fromJb = opts.goodBinsByPassId?.get(pass.passId);
  if (fromJb && fromJb.size > 0) return fromJb;
  return buildGoodBinsFromInfHeuristic([pass]);
}
```

替换为：

```ts
/**
 * 有意的取舍（2026-07-05）：这里曾经在 opts.goodBinsByPassId 未覆盖当前 passId 时，
 * 回退到 buildGoodBinsFromInfHeuristic（跨 lot 聚合场景设计的 die 体积启发式，
 * avg die/DUT > 100 才算良品 bin）。该启发式已被证实在单 lot 场景（本模块的唯一使用
 * 场景，每 DUT 通常仅几十颗 die）下必然失效——任何 BIN 都不可能超过 100 的绝对阈值，
 * 导致良品 bin 恒判定为空集合、良率恒为 0%（WA01N39W/DR41803.1Y 场景的根因）。
 * 现直接兜底为 {HARD_GOOD_BIN}（=1），与 goodBinIndicesForJbRow 的硬编码假设一致。
 * 若真实良品 bin 非 BIN1 且 JB 数据完全没覆盖该 passId，仍会误判——该残余风险已与
 * 用户确认并接受，不在本次修复范围内。
 */
function resolveGoodBinsForPass(
  pass: SiteBinPass,
  opts: LotUnderperformingDutsOptions
): Set<number> {
  if (opts.goodBins) return opts.goodBins;
  const fromJb = opts.goodBinsByPassId?.get(pass.passId);
  if (fromJb && fromJb.size > 0) return fromJb;
  return new Set([HARD_GOOD_BIN]);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd pcr-ai-api && npx tsx --test test/lotUnderperformingDuts.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: Commit**

```bash
git add pcr-ai-api/src/lib/lotUnderperformingDuts.ts pcr-ai-api/test/lotUnderperformingDuts.test.ts
git commit -m "fix(api): resolveGoodBinsForPass 最终回退改为固定BIN1，不再依赖INF体积启发式"
```

---

### Task 3: `agentToolHandlers.ts` 的 `lotDutConcentrationOpts` 改用 PASSBIN

**Files:**
- Modify: `pcr-ai-api/src/lib/agent/agentToolHandlers.ts`
- Test: `pcr-ai-api/test/agentDutBinAggInsight.test.ts`（跑现有测试确认无回归，不需要新增用例——这些测试本就针对 dummy lot DR43782.1A 跑真实端到端流程，Task 3 改的是它内部良品 bin 的取数方式，端到端断言不变）

**Interfaces:**
- Consumes: Task 1 导出的 `fetchJbTestRowsForLot(device, lot, passIds)` 和 `buildGoodBinsByPassFromJbRows(rows)`（均从 `../lotUnderperformingDutsResolve.js` 导入）。
- Produces: `lotDutConcentrationOpts` 签名从 `(rawPasses: SiteBinPass[], focusBinNum: number) => Parameters<typeof buildDutConcentrationInsights>[2]` 改为 `async (device: string, lot: string, passIds: number[], focusBinNum: number) => Promise<Parameters<typeof buildDutConcentrationInsights>[2]>`——4 个调用点（`toolQueryLotDutBinAgg` 内）需要同步改为 `await` 并传入 `device`/`lot`/`passIds`。

- [ ] **Step 1: 实现 —— 改 import**

打开 `pcr-ai-api/src/lib/agent/agentToolHandlers.ts`，找到（第 77 行附近）：

```ts
import { runLotUnderperformingDuts } from "../lotUnderperformingDutsResolve.js";
```

替换为：

```ts
import {
  runLotUnderperformingDuts,
  fetchJbTestRowsForLot,
  buildGoodBinsByPassFromJbRows,
} from "../lotUnderperformingDutsResolve.js";
```

找到（第 92-96 行附近）：

```ts
import {
  buildDutConcentrationInsights,
  formatDutConcentrationMarkdown,
  goodBinNumbersFromSiteBinPasses,
} from "./agentDutConcentration.js";
```

替换为（`goodBinNumbersFromSiteBinPasses` 即将被删除，这里先去掉这个 import）：

```ts
import {
  buildDutConcentrationInsights,
  formatDutConcentrationMarkdown,
} from "./agentDutConcentration.js";
```

- [ ] **Step 2: 实现 —— 改 `lotDutConcentrationOpts`**

找到（第 545-554 行）：

```ts
function lotDutConcentrationOpts(
  rawPasses: SiteBinPass[],
  focusBinNum: number
): Parameters<typeof buildDutConcentrationInsights>[2] {
  const opts: Parameters<typeof buildDutConcentrationInsights>[2] = {
    goodBins: goodBinNumbersFromSiteBinPasses(rawPasses),
  };
  if (Number.isFinite(focusBinNum)) opts.focusBins = [focusBinNum];
  return opts;
}
```

替换为：

```ts
/**
 * 单 lot DUT 集中度分析的良品 bin 判定：直接查该 lot/device/passIds 的 JB PASSBIN
 * 字段（与 lotUnderperformingDutsResolve.ts 的 runLotUnderperformingDuts 同一套逻辑），
 * 不再用 die 体积启发式（该启发式在单 lot 小 die 量场景下必然失效，见
 * docs/superpowers/specs/2026-07-05-lot-underperforming-duts-goodbin-fix-design.md）。
 * goodBins 是跨所有 passId 的单一 flat Set（buildDutConcentrationInsights 的既有接口
 * 形状，不区分 passId），故这里把各 passId 的良品 bin 取并集。
 */
async function lotDutConcentrationOpts(
  device: string,
  lot: string,
  passIds: number[],
  focusBinNum: number
): Promise<Parameters<typeof buildDutConcentrationInsights>[2]> {
  const jbRows = await fetchJbTestRowsForLot(device, lot, passIds);
  const goodBinsByPassId = buildGoodBinsByPassFromJbRows(jbRows);
  const goodBins = new Set<number>();
  for (const set of goodBinsByPassId.values()) {
    for (const n of set) goodBins.add(n);
  }
  const opts: Parameters<typeof buildDutConcentrationInsights>[2] = { goodBins };
  if (Number.isFinite(focusBinNum)) opts.focusBins = [focusBinNum];
  return opts;
}
```

- [ ] **Step 3: 实现 —— 更新 4 个调用点**

在 `toolQueryLotDutBinAgg` 函数内（第 632-712 行区间），有 4 处调用 `lotDutConcentrationOpts(rawPasses, focusBinNum)`，其中 2 组文本各自完全相同（同一个 3 行片段在 `probeCardType` 分支和无 `probeCardType` 的 `else` 分支里各出现一次）。**用 Edit 工具替换时必须带上下面给出的完整周边行，不能只用那 3 行本身**，否则 old_string 会匹配到两处、替换失败或替换错位置。

**第 1 处**（`probeCardType` 分支、dummy 子路径，约第 635-654 行）：

```ts
      const dummy = tryResolveSiteBinByLotDummyForLot(
        device, lot, probeCardType, passIds, testEndWindow
      );
      if (dummy !== null) {
        const rawPasses = dummy.passes;
        const dutMd = formatDutConcentrationMarkdown(
          buildDutConcentrationInsights(rawPasses, [], lotDutConcentrationOpts(rawPasses, focusBinNum))
        );
        const passes = compactSiteBinPasses(rawPasses);
        const focusBinDuts = focusBinKey ? extractFocusBinDuts(passes, focusBinKey) : undefined;
        const body = truncateResult(
          {
            ...(focusBinDuts?.length ? { focusBin: focusBinKey, focusBinDuts } : {}),
            device, lot, probeCardType: dummy.probeCardType ?? probeCardType,
            waferCount: dummy.waferCount, waferSlots: dummy.waferSlots,
            passes,
          },
          maxChars
        );
        return (dutMd ? dutMd + "\n\n" : "") + body;
      }
```

替换为（只改中间那 3 行，其余原样保留）：

```ts
      const dummy = tryResolveSiteBinByLotDummyForLot(
        device, lot, probeCardType, passIds, testEndWindow
      );
      if (dummy !== null) {
        const rawPasses = dummy.passes;
        const dutMd = formatDutConcentrationMarkdown(
          buildDutConcentrationInsights(
            rawPasses,
            [],
            await lotDutConcentrationOpts(device, lot, passIds, focusBinNum)
          )
        );
        const passes = compactSiteBinPasses(rawPasses);
        const focusBinDuts = focusBinKey ? extractFocusBinDuts(passes, focusBinKey) : undefined;
        const body = truncateResult(
          {
            ...(focusBinDuts?.length ? { focusBin: focusBinKey, focusBinDuts } : {}),
            device, lot, probeCardType: dummy.probeCardType ?? probeCardType,
            waferCount: dummy.waferCount, waferSlots: dummy.waferSlots,
            passes,
          },
          maxChars
        );
        return (dutMd ? dutMd + "\n\n" : "") + body;
      }
```

**第 2 处**（`probeCardType` 分支、Oracle 子路径，紧接第 1 处之后，约第 656-676 行）：

```ts
      const res = await runOutputSiteBinByLotForLot(
        device, lot, probeCardType, passIds, testEndWindow
      );
      const rawPasses = res.data.passes;
      const dutMd = formatDutConcentrationMarkdown(
        buildDutConcentrationInsights(rawPasses, [], lotDutConcentrationOpts(rawPasses, focusBinNum))
      );
      const passes = compactSiteBinPasses(rawPasses);
      const focusBinDuts = focusBinKey ? extractFocusBinDuts(passes, focusBinKey) : undefined;
      const body = truncateResult(
        {
          ...(focusBinDuts?.length ? { focusBin: focusBinKey, focusBinDuts } : {}),
          device, lot, probeCardType: res.probeCardType ?? probeCardType,
          waferCount: res.waferCount, waferSlots: res.waferSlots,
          passes,
          ...(res.skippedInfPaths.length > 0 ? { skippedWafers: res.skippedInfPaths.length } : {}),
        },
        maxChars
      );
      return (dutMd ? dutMd + "\n\n" : "") + body;
    } else {
```

替换为：

```ts
      const res = await runOutputSiteBinByLotForLot(
        device, lot, probeCardType, passIds, testEndWindow
      );
      const rawPasses = res.data.passes;
      const dutMd = formatDutConcentrationMarkdown(
        buildDutConcentrationInsights(
          rawPasses,
          [],
          await lotDutConcentrationOpts(device, lot, passIds, focusBinNum)
        )
      );
      const passes = compactSiteBinPasses(rawPasses);
      const focusBinDuts = focusBinKey ? extractFocusBinDuts(passes, focusBinKey) : undefined;
      const body = truncateResult(
        {
          ...(focusBinDuts?.length ? { focusBin: focusBinKey, focusBinDuts } : {}),
          device, lot, probeCardType: res.probeCardType ?? probeCardType,
          waferCount: res.waferCount, waferSlots: res.waferSlots,
          passes,
          ...(res.skippedInfPaths.length > 0 ? { skippedWafers: res.skippedInfPaths.length } : {}),
        },
        maxChars
      );
      return (dutMd ? dutMd + "\n\n" : "") + body;
    } else {
```

**第 3 处**（无 `probeCardType` 的 `else` 分支、dummy 子路径，约第 677-695 行）：

```ts
      const dummy = tryResolveSiteBinByLotDummyForLotByDirectory(device, lot, passIds);
      if (dummy !== null) {
        const rawPasses = dummy.passes;
        const dutMd = formatDutConcentrationMarkdown(
          buildDutConcentrationInsights(rawPasses, [], lotDutConcentrationOpts(rawPasses, focusBinNum))
        );
        const passes = compactSiteBinPasses(rawPasses);
        const focusBinDuts = focusBinKey ? extractFocusBinDuts(passes, focusBinKey) : undefined;
        const body = truncateResult(
          {
            ...(focusBinDuts?.length ? { focusBin: focusBinKey, focusBinDuts } : {}),
            device, lot,
            waferCount: dummy.waferCount, waferSlots: dummy.waferSlots,
            passes,
          },
          maxChars
        );
        return (dutMd ? dutMd + "\n\n" : "") + body;
      }
```

替换为：

```ts
      const dummy = tryResolveSiteBinByLotDummyForLotByDirectory(device, lot, passIds);
      if (dummy !== null) {
        const rawPasses = dummy.passes;
        const dutMd = formatDutConcentrationMarkdown(
          buildDutConcentrationInsights(
            rawPasses,
            [],
            await lotDutConcentrationOpts(device, lot, passIds, focusBinNum)
          )
        );
        const passes = compactSiteBinPasses(rawPasses);
        const focusBinDuts = focusBinKey ? extractFocusBinDuts(passes, focusBinKey) : undefined;
        const body = truncateResult(
          {
            ...(focusBinDuts?.length ? { focusBin: focusBinKey, focusBinDuts } : {}),
            device, lot,
            waferCount: dummy.waferCount, waferSlots: dummy.waferSlots,
            passes,
          },
          maxChars
        );
        return (dutMd ? dutMd + "\n\n" : "") + body;
      }
```

**第 4 处**（无 `probeCardType` 的 `else` 分支、Oracle 子路径，紧接第 3 处之后，约第 696-710 行）：

```ts
      const res = await runOutputSiteBinByLotForLotByDirectory(device, lot, passIds);
      const rawPasses = res.data.passes;
      const dutMd = formatDutConcentrationMarkdown(
        buildDutConcentrationInsights(rawPasses, [], lotDutConcentrationOpts(rawPasses, focusBinNum))
      );
      const passes = compactSiteBinPasses(rawPasses);
      const focusBinDuts = focusBinKey ? extractFocusBinDuts(passes, focusBinKey) : undefined;
      const body = truncateResult(
        {
          ...(focusBinDuts?.length ? { focusBin: focusBinKey, focusBinDuts } : {}),
          device, lot,
          waferCount: res.waferCount, waferSlots: res.waferSlots,
          passes,
```

替换为：

```ts
      const res = await runOutputSiteBinByLotForLotByDirectory(device, lot, passIds);
      const rawPasses = res.data.passes;
      const dutMd = formatDutConcentrationMarkdown(
        buildDutConcentrationInsights(
          rawPasses,
          [],
          await lotDutConcentrationOpts(device, lot, passIds, focusBinNum)
        )
      );
      const passes = compactSiteBinPasses(rawPasses);
      const focusBinDuts = focusBinKey ? extractFocusBinDuts(passes, focusBinKey) : undefined;
      const body = truncateResult(
        {
          ...(focusBinDuts?.length ? { focusBin: focusBinKey, focusBinDuts } : {}),
          device, lot,
          waferCount: res.waferCount, waferSlots: res.waferSlots,
          passes,
```

`device`、`lot`、`passIds` 均已是 `toolQueryLotDutBinAgg` 函数顶部（第 610-623 行）已解析好的局部变量，4 处调用点都在同一个函数体内，直接可用，无需额外传参改造。若替换后某处的周边行与本步骤给出的不完全一致（比如行号有微小偏差），以实际文件内容为准，用 Read 工具核对该函数当前内容后再定位。

- [ ] **Step 4: 类型检查 + 运行受影响测试确认无回归**

Run: `cd pcr-ai-api && npm run typecheck`
Expected: 无报错（确认 4 处调用点的 `await` 和参数类型都对得上）

Run: `cd pcr-ai-api && npx tsx --test test/agentDutBinAggInsight.test.ts`
Expected: PASS（全部既有用例，验证端到端行为无回归——这些测试跑的是 dummy lot DR43782.1A 的真实端到端流程）

- [ ] **Step 5: Commit**

```bash
git add pcr-ai-api/src/lib/agent/agentToolHandlers.ts
git commit -m "fix(api): query_lot_dut_bin_agg 的良品bin判定改用PASSBIN，不再用体积启发式"
```

---

### Task 4: 删除死代码 `goodBinNumbersFromSiteBinPasses`

**Files:**
- Modify: `pcr-ai-api/src/lib/agent/agentDutConcentration.ts`
- Modify: `pcr-ai-api/test/agentDutConcentration.test.ts`

**Interfaces:**
- Consumes: 无（本任务确认 Task 1-3 完成后，`goodBinNumbersFromSiteBinPasses` 在生产代码里已无调用点）。
- Produces: 无新接口，纯删除。

- [ ] **Step 1: 确认无生产代码调用点**

Run: `cd pcr-ai-api && grep -rn "goodBinNumbersFromSiteBinPasses" src/`
Expected: 只剩 `src/lib/agent/agentDutConcentration.ts` 里函数自身的定义这一行，`src/` 下没有其它调用点（Task 1-3 已经把所有生产调用点改掉）。

- [ ] **Step 2: 改写测试文件，去掉对该函数的依赖**

打开 `pcr-ai-api/test/agentDutConcentration.test.ts`，找到（第 3 行）：

```ts
import { buildDutConcentrationInsights, goodBinNumbersFromSiteBinPasses } from "../src/lib/agent/agentDutConcentration.js";
```

替换为：

```ts
import { buildDutConcentrationInsights } from "../src/lib/agent/agentDutConcentration.js";
```

找到这个测试（第 36-51 行）：

```ts
test("goodBins excludes passing bins from concentration table", () => {
  const passes = [
    {
      passId: 1,
      bins: [
        { bin: "bin1", duts: Array.from({ length: 78 }, (_, i) => ({ dut: i + 1, dieCount: 2000 })) },
        { bin: "bin79", duts: [{ dut: 1, dieCount: 90 }, { dut: 2, dieCount: 10 }] },
      ],
    },
  ];
  const goodBins = goodBinNumbersFromSiteBinPasses(passes);
  assert.ok(goodBins.has(1));
  const out = buildDutConcentrationInsights(passes, [], { goodBins, focusBins: [79] });
  assert.equal(out.length, 1);
  assert.equal(out[0]?.bin, 79);
});
```

替换为（测试目的不变——验证 `goodBins` 选项能把良品 bin 排除在坏 die 集中度表之外；只是不再用已删除的启发式函数来"发现" goodBins，而是像其它测试一样直接构造）：

```ts
test("goodBins excludes passing bins from concentration table", () => {
  const passes = [
    {
      passId: 1,
      bins: [
        { bin: "bin1", duts: Array.from({ length: 78 }, (_, i) => ({ dut: i + 1, dieCount: 2000 })) },
        { bin: "bin79", duts: [{ dut: 1, dieCount: 90 }, { dut: 2, dieCount: 10 }] },
      ],
    },
  ];
  const goodBins = new Set([1]);
  const out = buildDutConcentrationInsights(passes, [], { goodBins, focusBins: [79] });
  assert.equal(out.length, 1);
  assert.equal(out[0]?.bin, 79);
});
```

- [ ] **Step 3: 运行测试确认通过**

Run: `cd pcr-ai-api && npx tsx --test test/agentDutConcentration.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 4: 实现 —— 删除函数本体**

打开 `pcr-ai-api/src/lib/agent/agentDutConcentration.ts`，删除（第 28-43 行）：

```ts
/** Same heuristic as compactSiteBinPasses (avg die per DUT > 100 ≈ good bin). */
export function goodBinNumbersFromSiteBinPasses(passes: SiteBinPass[]): Set<number> {
  const good = new Set<number>();
  for (const pass of passes) {
    for (const entry of pass.bins) {
      const total = entry.duts.reduce((s, d) => s + d.dieCount, 0);
      if (total === 0) continue;
      const dutCount = entry.duts.length;
      const avg = dutCount > 0 ? total / dutCount : 0;
      if (avg <= 100) continue;
      const bin = parseBinNumber(entry.bin);
      if (bin !== null) good.add(bin);
    }
  }
  return good;
}

```

（紧接着的 `parseBinNumber` 函数、`cardIdForPass`、`buildDutConcentrationInsights` 等其余内容全部保留不动，只删除上面这一整块。）

- [ ] **Step 5: 类型检查 + 运行测试确认通过**

Run: `cd pcr-ai-api && npm run typecheck`
Expected: 无报错

Run: `cd pcr-ai-api && npx tsx --test test/agentDutConcentration.test.ts test/lotUnderperformingDuts.test.ts test/agentDutBinAggInsight.test.ts`
Expected: PASS（三个受影响的测试文件全部通过）

- [ ] **Step 6: Commit**

```bash
git add pcr-ai-api/src/lib/agent/agentDutConcentration.ts pcr-ai-api/test/agentDutConcentration.test.ts
git commit -m "refactor(api): 删除已无调用点的die体积良品bin启发式goodBinNumbersFromSiteBinPasses"
```

---

## 完成后整体验证

- [ ] `cd pcr-ai-api && npm test` 全绿
- [ ] `cd pcr-ai-api && npm run build`（`tsc` + `verify-dist-no-undici`）通过
- [ ] 人工核对：`git log --oneline` 里 4 个 commit 的 diff 是否都带有本计划要求的"已知取舍"注释（Task 1/2/3 的 code comment 是否都完整写入，未被简化/省略）
