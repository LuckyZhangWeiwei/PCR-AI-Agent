# Site-Bin-ByLot Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the full P0–P2 checklist from `docs/SITE_BIN_BY_LOT_INTEGRATION.md`: `buildInfPath` utility, Agent `query_inf_site_bin_by_dut` tool + prompt, and `InfDutDistPanel` report component with two trigger points (drill-to-slot + detail-row click).

**Architecture:** Shared `buildInfPath(device, lot, slot)` utility in API package; Agent handler calls it → `runOutputSiteBinByLot`; frontend has its own `buildInfPath` mirror + new `InfDutDistPanel` React component wired into `InfcontrolReport` state. Path rule: `/data/INF/{DEVICE_UPPER}/{LOT_UPPER}/r_1-{SLOT}`.

**Tech Stack:** Node.js + TypeScript (api), React 19 + TypeScript + ECharts (report), node:test built-in test runner.

**Spec:** `docs/superpowers/specs/2026-05-20-site-bin-bylot-integration-design.md`

---

## File Map

| Action | File | Purpose |
|--------|------|---------|
| **Create** | `pcr-ai-api/src/lib/buildInfPath.ts` | Path builder: device+lot+slot → infPath string |
| **Modify** | `pcr-ai-api/.env.example` | Document `INF_STORAGE_ROOT` |
| **Modify** | `pcr-ai-api/src/lib/outputSiteBinByLotDummy.ts` | Extend dummy: in `NODE_ENV=test`, match any infPath |
| **Modify** | `pcr-ai-api/src/lib/agent/agentToolSchemas.ts` | Add `query_inf_site_bin_by_dut` schema |
| **Modify** | `pcr-ai-api/src/lib/agent/agentToolHandlers.ts` | Add handler calling buildInfPath + runOutputSiteBinByLot |
| **Modify** | `pcr-ai-api/src/lib/agent/agentPrompt.ts` | Add INF section, update tool list |
| **Create** | `pcr-ai-api/test/agentInfSiteBin.test.ts` | Tests: buildInfPath, handler validation, handler success |
| **Create** | `pcr-ai-report/src/utils/buildInfPath.ts` | Frontend path builder (mirrors API rule) |
| **Modify** | `pcr-ai-report/src/api/paths.ts` | Add `SITE_BIN_BY_LOT_PATH` constant |
| **Modify** | `pcr-ai-report/src/api/types.ts` | Add `SiteBinByLotResponse` + sub-types |
| **Modify** | `pcr-ai-report/src/components/DataTable.tsx` | Add `onRowClick` prop |
| **Create** | `pcr-ai-report/src/components/InfDutDistPanel.tsx` | Fetches & renders stacked-bar DUT distribution |
| **Modify** | `pcr-ai-report/src/reports/InfcontrolReport.tsx` | `infCtx` state, two trigger points, render panel |

---

## Task 1: Create feature branch

**Files:** (git only)

- [ ] **Step 1: Create and switch to feature branch**

```bash
cd d:\AI\PCR-AI-Agent
git checkout -b feature/site-bin-bylot-integration
```

Expected: `Switched to a new branch 'feature/site-bin-bylot-integration'`

---

## Task 2: `buildInfPath` backend utility + tests

**Files:**
- Create: `pcr-ai-api/src/lib/buildInfPath.ts`
- Modify: `pcr-ai-api/.env.example`
- Create: `pcr-ai-api/test/agentInfSiteBin.test.ts` (partial — extend in Task 4)

- [ ] **Step 1: Write the test first**

Create `pcr-ai-api/test/agentInfSiteBin.test.ts`:

```typescript
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { buildInfPath } from "../src/lib/buildInfPath.js";

describe("buildInfPath", () => {
  it("uppercases device and lot, appends slot", () => {
    assert.equal(
      buildInfPath("WA03P02G", "NF12551.1N", 3),
      "/data/INF/WA03P02G/NF12551.1N/r_1-3"
    );
  });

  it("uppercases lowercase inputs", () => {
    assert.equal(
      buildInfPath("wa03p02g", "nf12551.1n", 25),
      "/data/INF/WA03P02G/NF12551.1N/r_1-25"
    );
  });

  it("uses INF_STORAGE_ROOT env override", () => {
    const orig = process.env.INF_STORAGE_ROOT;
    process.env.INF_STORAGE_ROOT = "/mnt/data/inf";
    assert.equal(
      buildInfPath("DEV", "LOT", 1),
      "/mnt/data/inf/DEV/LOT/r_1-1"
    );
    if (orig === undefined) delete process.env.INF_STORAGE_ROOT;
    else process.env.INF_STORAGE_ROOT = orig;
  });

  it("strips trailing slash from INF_STORAGE_ROOT", () => {
    const orig = process.env.INF_STORAGE_ROOT;
    process.env.INF_STORAGE_ROOT = "/data/INF/";
    assert.equal(
      buildInfPath("D", "L", 5),
      "/data/INF/D/L/r_1-5"
    );
    if (orig === undefined) delete process.env.INF_STORAGE_ROOT;
    else process.env.INF_STORAGE_ROOT = orig;
  });
});
```

- [ ] **Step 2: Run test — expect failure (function not found)**

```bash
cd pcr-ai-api && npm test 2>&1 | grep -E "buildInfPath|FAIL|Error"
```

Expected: error like `Cannot find module '../src/lib/buildInfPath.js'`

- [ ] **Step 3: Create `pcr-ai-api/src/lib/buildInfPath.ts`**

```typescript
export function buildInfPath(device: string, lot: string, slot: number): string {
  const root = (process.env.INF_STORAGE_ROOT ?? "/data/INF").replace(/\/$/, "");
  return `${root}/${device.toUpperCase()}/${lot.toUpperCase()}/r_1-${slot}`;
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
cd pcr-ai-api && npm test 2>&1 | tail -20
```

Expected: `buildInfPath` suite passes, no other failures.

- [ ] **Step 5: Add `INF_STORAGE_ROOT` to `.env.example`**

In `pcr-ai-api/.env.example`, find the line with `INF_PATH_ALLOWED_ROOT` and add below it:

```
# INF_STORAGE_ROOT=/data/INF
# Root directory for INF files. buildInfPath() prepends this to {DEVICE}/{LOT}/r_1-{SLOT}.
# Default: /data/INF
```

- [ ] **Step 6: Typecheck**

```bash
cd pcr-ai-api && npm run typecheck
```

Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
cd pcr-ai-api
git add src/lib/buildInfPath.ts .env.example
git add ../pcr-ai-api/test/agentInfSiteBin.test.ts
git commit -m "feat(api): add buildInfPath utility with INF_STORAGE_ROOT support"
```

---

## Task 3: Extend dummy for test mode + Agent tool schema + handler + tests

**Files:**
- Modify: `pcr-ai-api/src/lib/outputSiteBinByLotDummy.ts`
- Modify: `pcr-ai-api/src/lib/agent/agentToolSchemas.ts`
- Modify: `pcr-ai-api/src/lib/agent/agentToolHandlers.ts`
- Modify: `pcr-ai-api/test/agentInfSiteBin.test.ts`

- [ ] **Step 1: Extend dummy to accept any infPath in `NODE_ENV=test`**

In `pcr-ai-api/src/lib/outputSiteBinByLotDummy.ts`, change `tryResolveSiteBinByLotDummy`:

Find:
```typescript
export function tryResolveSiteBinByLotDummy(
  infPath: string,
  passIds: number[]
): SiteBinByLotData | null {
  if (!siteBinByLotUseDummy()) return null;
  if (!infPathMatchesSiteBinByLotDummy(infPath)) return null;
  return buildSiteBinByLotDummyData(passIds);
}
```

Replace with:
```typescript
export function tryResolveSiteBinByLotDummy(
  infPath: string,
  passIds: number[]
): SiteBinByLotData | null {
  if (!siteBinByLotUseDummy()) return null;
  if (process.env.NODE_ENV !== "test" && !infPathMatchesSiteBinByLotDummy(infPath)) return null;
  return buildSiteBinByLotDummyData(passIds);
}
```

- [ ] **Step 2: Add `query_inf_site_bin_by_dut` schema to `agentToolSchemas.ts`**

In `pcr-ai-api/src/lib/agent/agentToolSchemas.ts`, before the closing `] as const;`, add:

```typescript
  {
    type: "function",
    function: {
      name: "query_inf_site_bin_by_dut",
      description:
        "读取该片 wafer 的 INF 文件（服务端由 device+lot+slot 自动拼路径），按 pass 统计各 bin 由哪个 DUT(site) 测得及 dieCount。数据来自磁盘 INF，非 Oracle JB；与 query_jb_bins 数据源不同。调用前须已通过 query_jb_bins 获得 device+lot+slot+CARDID。",
      parameters: {
        type: "object",
        properties: {
          device:   { type: "string", description: "产品代码，必填" },
          lot:      { type: "string", description: "批次 ID，含 '.' 后缀，必填" },
          slot:     { type: "number", description: "wafer 槽位 SLOT，必填" },
          passId:   { type: "number", description: "PASS_ID；sort1/2/3→1/3/5" },
          passIds:  { type: "array", items: { type: "number" }, description: "多 pass 对比" },
          focusBin: { type: "number", description: "结论聚焦某一 BIN" },
          cardId:   { type: "string", description: "探针卡 ID（来自 query_jb_bins 的 CARDID），用于结论描述卡号" },
        },
        required: ["device", "lot", "slot"],
      },
    },
  },
```

- [ ] **Step 3: Write the handler tests before implementing the handler**

**First**, add this import to the **top** of `pcr-ai-api/test/agentInfSiteBin.test.ts` (alongside existing imports):

The top of the file should now read:
```typescript
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { buildInfPath } from "../src/lib/buildInfPath.js";
import { runTool } from "../src/lib/agent/agentToolHandlers.js";
```

**Then**, append the following `describe` block to the bottom of the file:

```typescript
describe("toolQueryInfSiteBinByDut", () => {
  before(() => {
    // NODE_ENV=test activates Dummy mode so Perl is never called
    process.env.NODE_ENV = "test";
  });

  it("returns error string when device is missing", async () => {
    const result = await runTool("query_inf_site_bin_by_dut", { lot: "NF12551.1N", slot: 3 });
    assert.ok(typeof result === "string");
    assert.ok((result as string).includes("device"));
  });

  it("returns error string when lot is missing", async () => {
    const result = await runTool("query_inf_site_bin_by_dut", { device: "WA03P02G", slot: 3 });
    assert.ok(typeof result === "string");
    assert.ok((result as string).includes("lot"));
  });

  it("returns error string when slot is missing", async () => {
    const result = await runTool("query_inf_site_bin_by_dut", { device: "WA03P02G", lot: "NF12551.1N" });
    assert.ok(typeof result === "string");
    assert.ok((result as string).includes("slot"));
  });

  it("returns JSON with passes, bin, dieCount using dummy mode", async () => {
    const result = await runTool("query_inf_site_bin_by_dut", {
      device: "WA03P02G",
      lot: "NF12551.1N",
      slot: 1,
      passId: 1,
      cardId: "9440-001",
    });
    assert.ok(typeof result === "string");
    const parsed = JSON.parse(result as string) as {
      passes: Array<{ passId: number; bins: Array<{ bin: string; duts: Array<{ dut: unknown; dieCount: number }> }> }>;
      cardId?: string;
    };
    assert.ok(Array.isArray(parsed.passes));
    assert.equal(parsed.cardId, "9440-001");
    if (parsed.passes.length > 0) {
      const firstPass = parsed.passes[0];
      assert.ok(Array.isArray(firstPass.bins));
      if (firstPass.bins.length > 0) {
        const firstBin = firstPass.bins[0];
        assert.ok(typeof firstBin.bin === "string");
        assert.ok(/^bin\d+$/i.test(firstBin.bin));
        assert.ok(Array.isArray(firstBin.duts));
        if (firstBin.duts.length > 0) {
          const d = firstBin.duts[0];
          assert.ok(typeof d.dieCount === "number");
          assert.ok(d.dieCount >= 0);
        }
      }
    }
  });
});
```

- [ ] **Step 4: Run tests — expect failure (handler not implemented yet)**

```bash
cd pcr-ai-api && npm test 2>&1 | grep -E "query_inf_site_bin_by_dut|未知工具"
```

Expected: `"未知工具: query_inf_site_bin_by_dut"` or similar failure.

- [ ] **Step 5: Implement the handler in `agentToolHandlers.ts`**

Add import at top of file:
```typescript
import { buildInfPath } from "../buildInfPath.js";
import {
  runOutputSiteBinByLot,
  parseSiteBinByLotJson,
} from "../outputSiteBinByLot.js";
import { tryResolveSiteBinByLotDummy } from "../outputSiteBinByLotDummy.js";
```

Add the handler function before `runTool`:
```typescript
async function toolQueryInfSiteBinByDut(
  args: Record<string, unknown>
): Promise<string> {
  const device = typeof args["device"] === "string" ? args["device"].trim() : "";
  const lot    = typeof args["lot"]    === "string" ? args["lot"].trim()    : "";
  const slotRaw = args["slot"];
  const slot = typeof slotRaw === "number" ? Math.round(slotRaw) : NaN;
  const cardId = typeof args["cardId"] === "string" ? args["cardId"].trim() : undefined;

  if (!device) return "query_inf_site_bin_by_dut 参数错误: device 不能为空";
  if (!lot)    return "query_inf_site_bin_by_dut 参数错误: lot 不能为空";
  if (!Number.isFinite(slot)) return "query_inf_site_bin_by_dut 参数错误: slot 必须是整数";

  const passIds: number[] = [];
  if (typeof args["passId"] === "number") passIds.push(Math.round(args["passId"]));
  if (Array.isArray(args["passIds"])) {
    for (const p of args["passIds"]) {
      if (typeof p === "number") passIds.push(Math.round(p));
    }
  }
  if (passIds.length === 0) passIds.push(1, 3, 5);

  const infPath = buildInfPath(device, lot, slot);

  const dummy = tryResolveSiteBinByLotDummy(infPath, passIds);
  if (dummy) {
    const result = { cardId, device, lot, slot, infPath, passes: dummy.passes };
    return truncateResult(result);
  }

  const { stdout, stderr, exitCode } = await runOutputSiteBinByLot(infPath, passIds);
  if (exitCode !== 0) {
    return truncateResult({
      error: "INF/Perl 失败",
      stderr: stderr.slice(0, 500),
      hint: "检查 INF_STORAGE_ROOT 及 infPath 在 API 主机上是否可读",
    });
  }
  try {
    const data = parseSiteBinByLotJson(stdout);
    return truncateResult({ cardId, device, lot, slot, infPath, passes: data.passes });
  } catch (e) {
    return `INF 解析失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}
```

In `runTool` switch, add before `default`:
```typescript
    case "query_inf_site_bin_by_dut":
      return toolQueryInfSiteBinByDut(args);
```

- [ ] **Step 6: Run tests — expect all pass**

```bash
cd pcr-ai-api && npm test 2>&1 | tail -30
```

Expected: all suites pass including `toolQueryInfSiteBinByDut`.

- [ ] **Step 7: Typecheck**

```bash
cd pcr-ai-api && npm run typecheck
```

Expected: 0 errors.

- [ ] **Step 8: Commit**

```bash
git add pcr-ai-api/src/lib/outputSiteBinByLotDummy.ts \
        pcr-ai-api/src/lib/agent/agentToolSchemas.ts \
        pcr-ai-api/src/lib/agent/agentToolHandlers.ts \
        pcr-ai-api/test/agentInfSiteBin.test.ts
git commit -m "feat(agent): add query_inf_site_bin_by_dut tool with buildInfPath + dummy support"
```

---

## Task 4: Agent prompt update

**Files:**
- Modify: `pcr-ai-api/src/lib/agent/agentPrompt.ts`

- [ ] **Step 1: Update the tool list line**

In `agentPrompt.ts`, find:
```
可用工具：query_yield_triggers, aggregate_yield_triggers, query_jb_bins, aggregate_jb_bins, generate_chart, ask_clarification, get_filter_values。
```

Replace with:
```
可用工具：query_yield_triggers, aggregate_yield_triggers, query_jb_bins, aggregate_jb_bins, query_inf_site_bin_by_dut, generate_chart, ask_clarification, get_filter_values。
```

- [ ] **Step 2: Add INF section and two-DUT disambiguation table**

In `agentPrompt.ts`, find the `## 数据规则` section and insert the following block **before** it:

```typescript
// Insert this string block before the ## 数据规则 line:
```

In `buildSystemPrompt`, add the following content after the `### Pass ID（测试层）与"sort"用语映射` section and before `## 数据规则`:

```
### INF Wafer Map · DUT 分布（query_inf_site_bin_by_dut）

**业务含义：一片 wafer、某一个测试 pass 上，wafer map 上每个测试结果 bin 是由 probe 卡上哪个 DUT（测试 site）测出来的，以及该 bin×DUT 的 die 颗数。**

- 数据来源：服务器磁盘 INF 文件（非 Oracle）。路径由服务端根据 **device + lot + slot** 自动拼接，**禁止**向用户索要 infPath，**禁止**在工具参数中传入路径。
- 与 JB STAR：JB 回答坏 bin 总量；INF 回答 bin 落在哪些 map site——是下钻补充，不替代 query_jb_bins。
- 与 Yield Monitor：Yield 的 dut# 是报警位；INF 的 dut 是 map site。名称相似，**不可混用**。

**调用前置（须同时满足）：**
1. 先调 query_jb_bins 获取 device、lot、slot、CARDID、PASSID。
2. 将 cardId 传入 query_inf_site_bin_by_dut，结论中必须写明卡号。
3. passId：sort1/2/3 → 1/3/5；或直接用 JB 行 PASSID。
4. **禁止**在仅 device / 仅 lot / 仅 probeCardType 级调用。

**推荐顺序：** query_jb_bins → query_inf_site_bin_by_dut →（可选）generate_chart 堆叠 bar。

**字段：** bin=BIN编号，dieCount=颗数，dut=site编号；禁止「DUT37 有 8 颗 bin5」类对调。

**失败：** INF/Perl 失败时用 [REFLECT] 说明，勿用 aggregate 猜 DUT 分布。

### 两种 DUT 必须区分

| 来源 | 含义 |
|---|---|
| Yield TRIGGER_LABEL | 良率不均衡报警 DUT（探针卡健康状态） |
| query_inf_site_bin_by_dut 的 dut 字段 | 该片该 pass wafer map 上测出该 bin 的 site# |

| 用户意图 | 做法 |
|---|---|
| 哪个 site/DUT 测出坏 bin、是否偏位 | JB 取 slot+pass+CARDID → INF 工具 |
| 哪种卡/哪个 lot 坏 bin 多 | 仅 JB 聚合，**不调** INF |
| 对比报警 dut# 与 map site | Yield + JB 定位 wafer → INF；分三源写结论 |
```

The exact insertion point in the file is after the line `| sort3 / 低温 | 5 | 低温（Low Temperature） |` (the last row of the Pass ID table) and before `## 数据规则`.

- [ ] **Step 3: Typecheck and test**

```bash
cd pcr-ai-api && npm run typecheck && npm test 2>&1 | tail -10
```

Expected: 0 errors, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add pcr-ai-api/src/lib/agent/agentPrompt.ts
git commit -m "feat(agent): add INF DUT distribution section and two-DUT disambiguation to system prompt"
```

---

## Task 5: Frontend buildInfPath + API constants + types

**Files:**
- Create: `pcr-ai-report/src/utils/buildInfPath.ts`
- Modify: `pcr-ai-report/src/api/paths.ts`
- Modify: `pcr-ai-report/src/api/types.ts`

- [ ] **Step 1: Create `pcr-ai-report/src/utils/buildInfPath.ts`**

```typescript
export function buildInfPath(device: string, lot: string, slot: number): string {
  const root = ((import.meta.env as Record<string, string | undefined>)["VITE_INF_STORAGE_ROOT"] ?? "/data/INF").replace(/\/$/, "");
  return `${root}/${device.toUpperCase()}/${lot.toUpperCase()}/r_1-${slot}`;
}
```

- [ ] **Step 2: Add `SITE_BIN_BY_LOT_PATH` to `pcr-ai-report/src/api/paths.ts`**

Append to the file:
```typescript
/** INF wafer pass × bin × DUT distribution — uses v1 path (stable across API_PREFIX changes) */
export const SITE_BIN_BY_LOT_PATH = "/api/v1/inf-analysis/site-bin-bylot";
```

- [ ] **Step 3: Add response types to `pcr-ai-report/src/api/types.ts`**

Append to the file:
```typescript
export type SiteBinDutEntry = {
  dut: number | "single";
  dieCount: number;
};

export type SiteBinEntry = {
  bin: string;
  duts: SiteBinDutEntry[];
};

export type SiteBinPass = {
  passId: number;
  bins: SiteBinEntry[];
};

export type SiteBinByLotResponse = {
  meta: { apiVersion: string; requestId: string; summary: string };
  infPath: string;
  passIds: number[];
  passes: SiteBinPass[];
};
```

- [ ] **Step 4: Typecheck frontend**

```bash
cd pcr-ai-report && npm run build 2>&1 | grep -E "error TS|✓"
```

Expected: build succeeds (✓).

- [ ] **Step 5: Commit**

```bash
git add pcr-ai-report/src/utils/buildInfPath.ts \
        pcr-ai-report/src/api/paths.ts \
        pcr-ai-report/src/api/types.ts
git commit -m "feat(report): add frontend buildInfPath, SITE_BIN_BY_LOT_PATH, and SiteBinByLotResponse types"
```

---

## Task 6: DataTable `onRowClick` support

**Files:**
- Modify: `pcr-ai-report/src/components/DataTable.tsx`

- [ ] **Step 1: Add `onRowClick` prop to DataTable**

In `pcr-ai-report/src/components/DataTable.tsx`, find the Props type:

```typescript
type Props = {
  rows: Record<string, unknown>[];
  /** Optional preferred column order */
  columnOrder?: string[];
  /** Keys to hide (e.g. heavy nested blobs) */
  omitKeys?: string[];
  maxHeight?: number;
};
```

Replace with:
```typescript
type Props = {
  rows: Record<string, unknown>[];
  /** Optional preferred column order */
  columnOrder?: string[];
  /** Keys to hide (e.g. heavy nested blobs) */
  omitKeys?: string[];
  maxHeight?: number;
  /** Called when user clicks a row. Receives the full row object. */
  onRowClick?: (row: Record<string, unknown>) => void;
};
```

Then find the data row `<tr>` at line 116:

```tsx
            <tr key={i}>
```

Replace with:

```tsx
            <tr
              key={i}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              style={onRowClick ? { cursor: "pointer" } : undefined}
            >
```

- [ ] **Step 2: Typecheck**

```bash
cd pcr-ai-report && npm run build 2>&1 | grep -E "error TS|✓"
```

Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add pcr-ai-report/src/components/DataTable.tsx
git commit -m "feat(report): add onRowClick prop to DataTable"
```

---

## Task 7: `InfDutDistPanel` component

**Files:**
- Create: `pcr-ai-report/src/components/InfDutDistPanel.tsx`

- [ ] **Step 1: Create the component**

Create `pcr-ai-report/src/components/InfDutDistPanel.tsx`:

```tsx
import { useEffect, useState } from "react";
import ReactECharts from "echarts-for-react";
import type { EChartsOption } from "echarts";
import { apiGetJson } from "../api/client";
import { SITE_BIN_BY_LOT_PATH } from "../api/paths";
import type { SiteBinByLotResponse, SiteBinPass } from "../api/types";
import { buildInfPath } from "../utils/buildInfPath";
import {
  baseChartOption,
  chartAxisColor,
  chartTextColor,
} from "../theme/chartTheme";

type Props = {
  device: string;
  lot: string;
  slot: number;
  passIds: number[];
  cardId?: string;
  focusBin?: string;
  apiBase: string;
  onClose: () => void;
};

function passLabel(passId: number): string {
  if (passId === 1) return "Pass 1 (sort1 · 常温)";
  if (passId === 3) return "Pass 3 (sort2 · 高温)";
  if (passId === 5) return "Pass 5 (sort3 · 低温)";
  return `Pass ${passId}`;
}

function buildDutChartOption(
  pass: SiteBinPass,
  focusBin: string | undefined
): EChartsOption {
  const bins = pass.bins.map((b) => b.bin);
  const dutSet = new Set<string>();
  for (const b of pass.bins) {
    for (const d of b.duts) dutSet.add(String(d.dut));
  }
  const duts = [...dutSet].sort((a, b) => {
    if (a === "single") return 1;
    if (b === "single") return -1;
    return Number(a) - Number(b);
  });

  const series: EChartsOption["series"] = duts.map((dut) => ({
    name: dut === "single" ? "Single" : `DUT ${dut}`,
    type: "bar",
    stack: "total",
    data: bins.map((bin) => {
      const binEntry = pass.bins.find((b) => b.bin === bin);
      const dutEntry = binEntry?.duts.find((d) => String(d.dut) === dut);
      const val = dutEntry?.dieCount ?? 0;
      const dimmed = focusBin !== undefined && bin !== focusBin;
      return {
        value: val,
        itemStyle: dimmed ? { opacity: 0.3 } : undefined,
      };
    }),
    emphasis: { focus: "series" },
  }));

  return {
    ...baseChartOption(),
    xAxis: {
      type: "category",
      data: bins,
      axisLabel: { color: chartAxisColor, rotate: bins.length > 8 ? 30 : 0 },
    },
    yAxis: {
      type: "value",
      name: "die count",
      nameTextStyle: { color: chartAxisColor },
      axisLabel: { color: chartAxisColor },
    },
    legend: { textStyle: { color: chartTextColor }, top: 0 },
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    series,
  };
}

export function InfDutDistPanel({
  device,
  lot,
  slot,
  passIds,
  cardId,
  focusBin,
  apiBase,
  onClose,
}: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<SiteBinByLotResponse | null>(null);

  const infPath = buildInfPath(device, lot, slot);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);

    const params: Record<string, string | number | boolean | undefined | null> = {
      infPath,
      passId: passIds.join(","),
    };

    apiGetJson<SiteBinByLotResponse>(apiBase, SITE_BIN_BY_LOT_PATH, params)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [apiBase, infPath, passIds.join(",")]);

  const title = `INF · DUT 分布 — LOT ${lot} · Slot ${slot}${cardId ? ` · 卡 ${cardId}` : ""}`;

  return (
    <div
      style={{
        background: "#0d1117",
        border: "1px solid rgba(240,246,252,0.1)",
        borderRadius: 8,
        padding: 16,
        marginTop: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 12,
        }}
      >
        <span style={{ fontSize: 13, color: "#8b949e", fontWeight: 600 }}>
          {title}
        </span>
        <button
          type="button"
          onClick={onClose}
          style={{
            background: "none",
            border: "none",
            color: "#8b949e",
            cursor: "pointer",
            fontSize: 16,
            lineHeight: 1,
            padding: "0 4px",
          }}
          aria-label="关闭"
        >
          ✕
        </button>
      </div>

      {loading && (
        <div
          style={{
            height: 160,
            background: "rgba(240,246,252,0.04)",
            borderRadius: 4,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#6e7681",
            fontSize: 13,
          }}
        >
          加载中…
        </div>
      )}

      {!loading && error && (
        <div style={{ color: "#f85149", fontSize: 13 }}>
          <div>读取失败：{error}</div>
          <div style={{ marginTop: 4, fontSize: 11, color: "#6e7681" }}>
            路径：{infPath}
          </div>
        </div>
      )}

      {!loading && !error && data && (
        <div>
          {data.passes.length === 0 && (
            <div style={{ color: "#8b949e", fontSize: 13 }}>
              未找到匹配的 pass 数据（infPath: {infPath}）
            </div>
          )}
          {data.passes.map((pass) => (
            <div key={pass.passId} style={{ marginBottom: 16 }}>
              <div
                style={{ fontSize: 12, color: "#8b949e", marginBottom: 6 }}
              >
                {passLabel(pass.passId)}
              </div>
              {pass.bins.length === 0 ? (
                <div style={{ color: "#6e7681", fontSize: 12 }}>
                  此 pass 无 bin 数据
                </div>
              ) : (
                <ReactECharts
                  option={buildDutChartOption(pass, focusBin)}
                  style={{
                    height: Math.max(200, pass.bins.length * 20 + 80),
                    width: "100%",
                  }}
                  opts={{ renderer: "canvas" }}
                  notMerge
                  lazyUpdate
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Build check**

```bash
cd pcr-ai-report && npm run build 2>&1 | grep -E "error TS|✓"
```

Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add pcr-ai-report/src/components/InfDutDistPanel.tsx
git commit -m "feat(report): add InfDutDistPanel component for INF × bin × DUT stacked bar"
```

---

## Task 8: Wire `InfDutDistPanel` into `InfcontrolReport`

**Files:**
- Modify: `pcr-ai-report/src/reports/InfcontrolReport.tsx`

This task has the most changes. Work methodically section by section.

- [ ] **Step 1: Add `InfCtx` type and `infCtx` state**

After the existing `useState` imports at the top of `InfcontrolReport.tsx`, add the import:

```typescript
import { InfDutDistPanel } from "../components/InfDutDistPanel";
```

After `const [selectedDevice, setSelectedDevice] = useState<string | null>(null);` (around line 341), add:

```typescript
type InfCtx = {
  device: string;
  lot: string;
  slot: number;
  passIds: number[];
  cardId?: string;
  focusBin?: string;
} | null;

const [infCtx, setInfCtx] = useState<InfCtx>(null);
```

- [ ] **Step 2: Clear `infCtx` on new query**

In the `query` callback (starts around line 513), add `setInfCtx(null);` alongside the other state resets — after `setSelectedDevice(null);`:

```typescript
    setSelectedDevice(null);
    setInfCtx(null);  // ← add this line
```

- [ ] **Step 3: Add `resolveInfCtxFromDrill` helper**

Add this helper function just before `export function InfcontrolReport(...)`:

```typescript
function resolveInfCtxFromDrill(
  parentDimKey: string,
  parentDimVal: string,
  subDim: string,
  clickedKey: string,
  form: FormState
): InfCtx {
  if (subDim !== "slot") return null;
  const slot = parseInt(clickedKey, 10);
  if (!Number.isFinite(slot)) return null;

  const device = parentDimKey === "device" ? parentDimVal : form.device;
  const lot    = parentDimKey === "lot"    ? parentDimVal : form.lot;
  if (!device || !lot) return null;

  const passIds = form.passId ? [Number(form.passId)] : [1, 3, 5];
  const cardId  = form.cardId || undefined;
  return { device, lot, slot, passIds, cardId };
}
```

> Note: `InfCtx` is used as a return type here; TypeScript infers it from the state declaration above.

- [ ] **Step 4: Wire `onBarClick` on all DrillDownPanels that can show slot**

There are five `DrillDownPanel` usages in `jbReportSections`. Add `onBarClick` to each one. For each DrillDownPanel, add:

```tsx
onBarClick={(key) => {
  const d = drills["PARENT_DIM_KEY"]!;
  const ctx = resolveInfCtxFromDrill(d.parentDimKey, d.parentDimVal, d.subDim, key, form);
  if (ctx) setInfCtx(ctx);
}}
```

The five panels with their `PARENT_DIM_KEY` values:
- `drills["lot"]` panel → `"lot"`
- `drills["device"]` panel → `"device"`
- `drills["bin"]` panel → `"bin"`
- `drills["cardType"]` panel → `"cardType"`
- `drills["slot"]` panel → `"slot"`

Example for the `drills["lot"]` panel (around line 990):
```tsx
<DrillDownPanel
  title={`LOT: ${drills["lot"]!.parentDimVal} · 下钻：按 ${drills["lot"]!.subDim}`}
  groups={drills["lot"]!.groups}
  loading={drills["lot"]!.loading}
  error={drills["lot"]!.error}
  activeSubDim={drills["lot"]!.subDim}
  subDimOptions={DRILL_FROM_LOT}
  onSubDimChange={(d) =>
    fetchDrill("lot", drills["lot"]!.parentDimVal, d, form)
  }
  onBarClick={(key) => {
    const d = drills["lot"]!;
    const ctx = resolveInfCtxFromDrill(d.parentDimKey, d.parentDimVal, d.subDim, key, form);
    if (ctx) setInfCtx(ctx);
  }}
  onClose={() => {
    setSelectedLotLabel(null);
    setDrills((prev) => { const n = { ...prev }; delete n["lot"]; return n; });
  }}
/>
```

Apply the same `onBarClick` pattern to `drills["device"]`, `drills["bin"]`, `drills["cardType"]`, and `drills["slot"]` panels.

- [ ] **Step 5: Wire `onRowClick` on the detail DataTable**

Find the detail section's `DataTable` (around line 1351):

```tsx
{showDetail && <DataTable rows={detailRows} maxHeight={400} />}
```

Replace with:

```tsx
{showDetail && (
  <DataTable
    rows={detailRows}
    maxHeight={400}
    onRowClick={(row) => {
      const device = String(row["DEVICE"] ?? "").trim();
      const lot    = String(row["LOT"]    ?? "").trim();
      const slot   = parseInt(String(row["SLOT"]   ?? ""), 10);
      const passId = parseInt(String(row["PASSID"] ?? ""), 10);
      const cardId = String(row["CARDID"] ?? "").trim() || undefined;
      if (device && lot && Number.isFinite(slot)) {
        setInfCtx({
          device,
          lot,
          slot,
          passIds: Number.isFinite(passId) ? [passId] : [1, 3, 5],
          cardId,
        });
      }
    }}
  />
)}
```

- [ ] **Step 6: Render `InfDutDistPanel` in the component return**

Find the component return statement (after the last `<DraggableReportSections ... />` closing tag). Add the `InfDutDistPanel` render:

The return currently ends with something like:
```tsx
      )}
    </>
  );
```

Before the closing `</>`, add:
```tsx
      {infCtx && (
        <InfDutDistPanel
          device={infCtx.device}
          lot={infCtx.lot}
          slot={infCtx.slot}
          passIds={infCtx.passIds}
          cardId={infCtx.cardId}
          focusBin={infCtx.focusBin}
          apiBase={apiBase}
          onClose={() => setInfCtx(null)}
        />
      )}
```

- [ ] **Step 7: Build check**

```bash
cd pcr-ai-report && npm run build 2>&1 | grep -E "error TS|✓"
```

Expected: build succeeds (0 TypeScript errors).

- [ ] **Step 8: Commit**

```bash
git add pcr-ai-report/src/reports/InfcontrolReport.tsx
git commit -m "feat(report): wire InfDutDistPanel into InfcontrolReport — drill-to-slot + detail-row triggers"
```

---

## Task 9: Final verification

- [ ] **Step 1: Run all backend tests**

```bash
cd pcr-ai-api && npm test 2>&1 | tail -20
```

Expected: all pass, 0 failures.

- [ ] **Step 2: Run backend typecheck**

```bash
cd pcr-ai-api && npm run typecheck
```

Expected: 0 errors.

- [ ] **Step 3: Run frontend build**

```bash
cd pcr-ai-report && npm run build 2>&1 | tail -10
```

Expected: `✓ built in ...`

- [ ] **Step 4: Verify acceptance criteria**

Manually confirm with Dummy mode:
- `buildInfPath("WA03P02G", "NF12551.1N", 3)` → `/data/INF/WA03P02G/NF12551.1N/r_1-3`
- Agent returns tool `query_inf_site_bin_by_dut` in schema list
- InfDutDistPanel renders (can check with Storybook or by mounting with hardcoded props)
- Detail table row click visible (cursor changes to pointer)
- Close button dismisses the panel

- [ ] **Step 5: Final summary commit**

```bash
git log --oneline feature/site-bin-bylot-integration..HEAD
```

Verify all commits are on the feature branch. If everything looks good, the branch is ready for review.

---

## Acceptance checklist (from spec)

- [ ] `buildInfPath("WA03P02G", "NF12551.1N", 3)` → `/data/INF/WA03P02G/NF12551.1N/r_1-3`
- [ ] Agent tool `query_inf_site_bin_by_dut` returns correct bin/dieCount/dut (not swapped)
- [ ] Agent prompt contains INF section and updated tool list
- [ ] `npm test` (pcr-ai-api) passes including `agentInfSiteBin.test.ts`
- [ ] `npm run typecheck` (pcr-ai-api) passes
- [ ] `InfDutDistPanel` renders stacked bar; loading placeholder visible during fetch
- [ ] Drill to slot in JB Star report → INF panel appears
- [ ] Click detail row with DEVICE+LOT+SLOT+PASSID → INF panel appears
- [ ] Close button dismisses the panel
- [ ] `npm run build` (pcr-ai-report) passes
