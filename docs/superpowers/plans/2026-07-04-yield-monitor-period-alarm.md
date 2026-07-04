# Yield Monitor 周/月报警统计 Section Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Yield Monitor 报表「每日触发量趋势」下方新增一个「Weekly/Monthly Yield Monitor Alarm」section:周/月切换 + 总触发次数/环比 KPI + tester/probe card/bin/DUT 四个 Top10 分类图表。

**Architecture:** 后端在现有 v3/v4 产量聚合基础设施（`YieldMonitorV3AggDim`）上新增两个从 `TRIGGER_LABEL` 正则派生的维度 `bin`、`dutNumber`（与已有 `probeCardType` 派生维度同一套模式：Oracle 用 `REGEXP_SUBSTR`，Dummy/v4 全量行聚合用 Node 正则）。前端在 `YieldMonitorReport.tsx` 新增一个独立的周期数据获取 `useEffect`（复用已生效筛选 + 周期开关决定的时间窗口，通过既有 `YIELD_AGGREGATE_PATH` 发起 5 个聚合请求），渲染为新的可拖拽顶层 section。

**Tech Stack:** Node.js + Express + TypeScript + oracledb 5.5（`pcr-ai-api`）；React 19 + TypeScript + Vite + ECharts（`pcr-ai-report`）；`node:test`（后端测试跑 `tsx --test test/*.test.ts`）。

## Global Constraints

- **Dummy/Oracle 双路径必须同步**：任何 WHERE/维度/聚合改动，Oracle 路径与 `src/lib/*Dummy*.ts` 必须同时修改并通过 `npm test`（`pcr-ai-api/CLAUDE.md` 硬规则）。
- **不升级 `oracledb`**，仍锁定 `5.5.0`（本计划不涉及该依赖）。
- **不引入 `undici`** 到 `pcr-ai-api`（本计划不涉及网络出站代码）。
- 改 `src/lib/apiV3ListSql.ts` 或产量 v3 聚合文档模板后需跑 `npm run docs:api-v3` 并提交 `docs/API_V3.md`。
- 前端改动后需 `cd pcr-ai-report && npm run build` 确认无 TypeScript 报错；`pcr-ai-report` 无自动化测试框架，纯函数改动靠人工核对 + 构建通过 + 浏览器手测。
- 新顶层 section 需要遵循 `pcr-ai-report/CLAUDE.md` §6 的可拖拽模板（`DraggableReportBlocks`/`DraggableReportSections`，新增模块 id 需同步 `defaultOrder`、`TOP_SECTION_LABELS`、`sections` 对象键）。
- 不要修改 Agent 聊天（`pcr-ai-api/src/lib/agent/*`）里对 `YieldMonitorV3AggDim` 的引用/工具 schema —— 那是本计划范围外的独立表面，类型联合扩展会自动透传但本计划不主动改动 Agent 工具描述文本。
- **`YieldMonitorV3AggDim` 是一个跨两个文件的穷尽性联合类型**：`yieldMonitorTriggerV3Aggregate.ts` 的 `dimSql()` 与 `yieldMonitorTriggerDummy.ts` 的 `valueForYieldV3Dimension()` 都用 `default: { const _e: never = d; ... }` 做穷尽检查。**必须在同一个任务内同时修改这两个文件**，否则中间状态编译不过（这是本计划把原本可拆分的 Oracle SQL 与 Dummy 逻辑合并进同一个任务的原因）。

---

### Task 1: 后端 — `TRIGGER_LABEL` 中 Bin# 解析工具函数

**Files:**
- Create: `pcr-ai-api/src/lib/yieldTriggerLabelBin.ts`
- Test: `pcr-ai-api/test/yieldTriggerLabelBin.test.ts`

**Interfaces:**
- Produces: `parseBinFromTriggerLabel(label: string | null | undefined): string | null` — 数字原样返回字符串；`goodbin`（大小写不敏感）归一化为小写 `"goodbin"`；无匹配或空输入返回 `null`。Task 2 会调用它。

- [ ] **Step 1: 写失败测试**

创建 `pcr-ai-api/test/yieldTriggerLabelBin.test.ts`：

```ts
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseBinFromTriggerLabel } from "../src/lib/yieldTriggerLabelBin.js";

describe("parseBinFromTriggerLabel（TRIGGER_LABEL 中 Bin# 片段）", () => {
  test("解析数字 Bin#", () => {
    assert.equal(
      parseBinFromTriggerLabel(
        "Bin# 1 on dut# 2 Yield: 58.72, Min Yield(Dut#2): 58.72 Max Yield(Dut#0): 98.15 Delta exceed Delta Limit 20."
      ),
      "1"
    );
    assert.equal(
      parseBinFromTriggerLabel(
        "Bin# 250 on dut# 23 Yield: 49.64, Min Yield(Dut#23): 49.64 Max Yield(Dut#17): 100.00 Delta exceed Delta Limit 50."
      ),
      "250"
    );
  });

  test("解析 Bin#N（数字紧跟 # 无空格）", () => {
    assert.equal(
      parseBinFromTriggerLabel("Bin#11 on dut#1 Conse_Count: 20 exceed limit 20  ."),
      "11"
    );
  });

  test("解析 goodbin，大小写不敏感并归一化为小写", () => {
    assert.equal(
      parseBinFromTriggerLabel(
        "Bin# goodbin on dut# 21 Yield: 29.69, Min Yield(Dut#21): 29.69 Max Yield(Dut#13): 100.00 Delta exceed Delta Limit 50."
      ),
      "goodbin"
    );
    assert.equal(parseBinFromTriggerLabel("BIN# GOODBIN on dut# 1"), "goodbin");
  });

  test("无 Bin# 片段 → null", () => {
    assert.equal(
      parseBinFromTriggerLabel("Totally no good die, exceed consecutive fail limit 100 ."),
      null
    );
  });

  test("空 / undefined / null → null", () => {
    assert.equal(parseBinFromTriggerLabel(undefined), null);
    assert.equal(parseBinFromTriggerLabel(null), null);
    assert.equal(parseBinFromTriggerLabel(""), null);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败（模块不存在）**

Run: `cd pcr-ai-api && npx tsx --test test/yieldTriggerLabelBin.test.ts`
Expected: 报错 `Cannot find module '../src/lib/yieldTriggerLabelBin.js'`（或等价的模块解析失败）

- [ ] **Step 3: 实现**

创建 `pcr-ai-api/src/lib/yieldTriggerLabelBin.ts`：

```ts
/**
 * `TRIGGER_LABEL` in delta-diff / `YMWEB_YIELDMONITORTRIGGER` always contains a
 * substring like `Bin# 1 on dut# 2 ...` or `Bin# goodbin on dut# 21 ...`.
 * See `docs/delta-diff.xlsx`; verified 152/152 TYPE=delta_diff sample rows parse.
 */
const BIN_FROM_TRIGGER_LABEL = /\bBin#\s*([0-9]+|goodbin)\b/i;

export function parseBinFromTriggerLabel(
  label: string | null | undefined
): string | null {
  if (label == null || label === "") return null;
  const m = String(label).match(BIN_FROM_TRIGGER_LABEL);
  if (!m) return null;
  return m[1].toLowerCase();
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd pcr-ai-api && npx tsx --test test/yieldTriggerLabelBin.test.ts`
Expected: 全部 `pass`，0 `fail`

- [ ] **Step 5: Commit**

```bash
git add pcr-ai-api/src/lib/yieldTriggerLabelBin.ts pcr-ai-api/test/yieldTriggerLabelBin.test.ts
git commit -m "feat(api): add parseBinFromTriggerLabel for TRIGGER_LABEL Bin# parsing"
```

---

### Task 2: 后端 — v3/v4 聚合新增 `bin`/`dutNumber` 维度（Oracle SQL + Dummy/v4 全量行聚合，同一任务内完成）

**Files:**
- Modify: `pcr-ai-api/src/lib/yieldMonitorTriggerV3Aggregate.ts`
- Modify: `pcr-ai-api/src/lib/yieldMonitorTriggerDummy.ts`
- Test: `pcr-ai-api/test/yieldMonitorTriggerV3Aggregate.test.ts`（新建）
- Modify: `pcr-ai-api/test/rest-api-v3-dummy.test.ts`

**Interfaces:**
- Consumes: `parseBinFromTriggerLabel`（Task 1，`./yieldTriggerLabelBin.js`）；已存在的 `parseDutNumberFromTriggerLabel`（`./yieldTriggerLabelDut.js`）。
- Produces: `YieldMonitorV3AggDim` 联合类型新增 `"bin" | "dutNumber"`；两个消费方（Oracle SQL 的 `dimSql()` 与 Dummy/v4 全量行聚合的 `valueForYieldV3Dimension()`）在本任务内同步覆盖，任务结束时 `npm run typecheck` 与 `npm test` 均为绿色。前端 Task 5 依赖 `dimensions=bin`/`dimensions=dutNumber` 这两个查询参数值可用。

**为什么两个文件必须在同一任务内改**：`YieldMonitorV3AggDim` 是一个跨文件的穷尽联合类型，`dimSql()`（Oracle SQL 侧）与 `valueForYieldV3Dimension()`（Dummy 侧，同时也是 v4 全量行聚合共用的函数）都用 `default: { const _e: never = d; return _e; }` 做穷尽性检查。只改其中一个文件会让另一个文件的 `switch` 不再穷尽，`npm run typecheck` 立即报错。

**背景说明（写给实现者）**：`yieldMonitorRoutes.ts` 里 `GET /yield-monitor-triggers/v3/aggregate` 与 `GET /yield-monitor-triggers/v4/aggregate` 在 **Dummy 模式**下都调用 `yieldMonitorTriggerDummy.ts` 里的函数（`aggregateYieldMonitorV3DummyRows` / `aggregateYieldMonitorV3FromRows`），因此 `valueForYieldV3Dimension()` 的改动会同时让 v3-dummy 与 v4（Dummy 与真实 Oracle 全量行两种情况）都支持新维度。真实 Oracle 的 v3 聚合走 `dimSql()` 生成的 SQL，本环境没有真实 Oracle 连接，只能靠 Step 4 的 SQL 字符串断言测试覆盖。

- [ ] **Step 1: 写失败测试（SQL 侧 + parse 侧）**

创建 `pcr-ai-api/test/yieldMonitorTriggerV3Aggregate.test.ts`：

```ts
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  parseYieldMonitorTriggerV3AggregateQuery,
  buildYieldMonitorTriggerV3AggregateSql,
} from "../src/lib/yieldMonitorTriggerV3Aggregate.js";

describe("yieldMonitorTriggerV3Aggregate — bin / dutNumber 维度", () => {
  test("parseYieldMonitorTriggerV3AggregateQuery 接受 dimensions=bin", () => {
    const r = parseYieldMonitorTriggerV3AggregateQuery({ dimensions: "bin" });
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.dimensions, ["bin"]);
  });

  test("parseYieldMonitorTriggerV3AggregateQuery 接受 dimensions=DutNumber（大小写不敏感）", () => {
    const r = parseYieldMonitorTriggerV3AggregateQuery({ dimensions: "DutNumber" });
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.dimensions, ["dutNumber"]);
  });

  test("buildYieldMonitorTriggerV3AggregateSql（bin）含 REGEXP_SUBSTR 提取表达式", () => {
    const sql = buildYieldMonitorTriggerV3AggregateSql("", ["bin"]);
    assert.ok(
      sql.includes(
        "REGEXP_SUBSTR(t.TRIGGER_LABEL, 'Bin#\\s*([0-9]+|goodbin)', 1, 1, 'i', 1)"
      )
    );
    assert.ok(sql.includes("GROUP BY"));
  });

  test("buildYieldMonitorTriggerV3AggregateSql（dutNumber）含 REGEXP_SUBSTR 提取表达式", () => {
    const sql = buildYieldMonitorTriggerV3AggregateSql("", ["dutNumber"]);
    assert.ok(
      sql.includes(
        "REGEXP_SUBSTR(t.TRIGGER_LABEL, 'on\\s+dut#\\s*([0-9]+)', 1, 1, 'i', 1)"
      )
    );
  });
});
```

在 `pcr-ai-api/test/rest-api-v3-dummy.test.ts` 里，紧跟在已有的 `test("GET /api/v3/yield-monitor-triggers/v3/aggregate dimensions 含 probeCardType（dummy）", ...)`（原第 436-449 行）之后插入：

```ts
    test("GET /api/v3/yield-monitor-triggers/v3/aggregate dimensions=bin（dummy，从 TRIGGER_LABEL 解析）", async () => {
      const qs = new URLSearchParams(yExampleQs);
      qs.set("dimensions", "bin");
      qs.set("groupTop", "50");
      const { status, body } = await getJson(
        `${API}/yield-monitor-triggers/v3/aggregate?${qs.toString()}`
      );
      assertOkJson(status, body);
      const b = body as {
        totalRowsMatching?: number;
        groups?: { count: number; parts?: Record<string, string> }[];
      };
      assert.ok(Array.isArray(b.groups));
      assert.ok(b.groups!.length > 0, "delta_diff 样本行应能解析出 bin");
      const sum = b.groups!.reduce((acc, g) => acc + g.count, 0);
      assert.equal(sum, b.totalRowsMatching);
      for (const g of b.groups!) {
        assert.ok("bin" in (g.parts ?? {}));
        assert.notEqual(g.parts!.bin, "");
      }
    });

    test("GET /api/v3/yield-monitor-triggers/v3/aggregate dimensions=dutNumber（dummy）", async () => {
      const qs = new URLSearchParams(yExampleQs);
      qs.set("dimensions", "dutNumber");
      qs.set("groupTop", "50");
      const { status, body } = await getJson(
        `${API}/yield-monitor-triggers/v3/aggregate?${qs.toString()}`
      );
      assertOkJson(status, body);
      const b = body as {
        totalRowsMatching?: number;
        groups?: { count: number; parts?: Record<string, string> }[];
      };
      assert.ok(Array.isArray(b.groups));
      if (b.groups!.length > 0) {
        assert.ok("dutNumber" in (b.groups![0].parts ?? {}));
      }
    });
```

并在已有的 `test("GET /api/v4/yield-monitor-triggers/v4/aggregate（dummy）与 v3 聚合一致", ...)`（原第 510-524 行）之后追加一个新测试：

```ts
    test("GET /api/v4/yield-monitor-triggers/v4/aggregate dimensions=bin,dutNumber 与 v3 聚合一致", async () => {
      const qs = new URLSearchParams(yExampleQs);
      qs.set("dimensions", "bin,dutNumber");
      qs.set("groupTop", "50");
      const [v3r, v4r] = await Promise.all([
        getJson(`${API}/yield-monitor-triggers/v3/aggregate?${qs.toString()}`),
        getJson(`/api/v4/yield-monitor-triggers/v4/aggregate?${qs.toString()}`),
      ]);
      assertOkJson(v3r.status, v3r.body);
      assertOkJson(v4r.status, v4r.body);
      const v3b = v3r.body as { totalRowsMatching?: number; groups?: unknown[] };
      const v4b = v4r.body as { totalRowsMatching?: number; groups?: unknown[] };
      assert.equal(v3b.totalRowsMatching, v4b.totalRowsMatching);
      assert.deepEqual(v3b.groups, v4b.groups);
    });
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd pcr-ai-api && npx tsx --test test/yieldMonitorTriggerV3Aggregate.test.ts test/rest-api-v3-dummy.test.ts`
Expected: `parseYieldMonitorTriggerV3AggregateQuery` 相关测试因 `Invalid dimensions segment: bin` 而 `fail`；SQL 字符串测试因不匹配而 `fail`；REST `dimensions=bin`/`dimensions=dutNumber` 测试因 `parts.bin`/`parts.dutNumber` 不存在而 `fail`

- [ ] **Step 3: 实现 — Oracle SQL 侧（`yieldMonitorTriggerV3Aggregate.ts`）**

**3a. 联合类型新增两个维度**（原 17-28 行）：

```ts
export type YieldMonitorV3AggDim =
  | "device"
  | "hostname"
  | "lotId"
  | "wafer"
  | "probeCard"
  /** 与 v3 列表 **`PROBECARDTYPE`** 一致：**`PROBECARD`** 首个 **`-`** 前段（Oracle/Dummy 中空为 **''**） */
  | "probeCardType"
  | "pass"
  | "triggerLabel"
  | "timeDay"
  | "timeHour"
  /** 从 **`TRIGGER_LABEL`** 中 **`Bin#`** 片段派生（数字原样；`goodbin` 归一化为小写），空为 **''** */
  | "bin"
  /** 从 **`TRIGGER_LABEL`** 中 **`on dut#`** 片段派生（与列表 **`dutNumber`** 同源正则），空为 **''** */
  | "dutNumber";
```

**3b. `parseDimToken` 映射表新增两项**（原 59-74 行的 `map` 对象内）：

```ts
  const map: Record<string, YieldMonitorV3AggDim> = {
    device: "device",
    hostname: "hostname",
    lotid: "lotId",
    wafer: "wafer",
    probecard: "probeCard",
    probecardtype: "probeCardType",
    pass: "pass",
    triggerlabel: "triggerLabel",
    timeday: "timeDay",
    timehour: "timeHour",
    bin: "bin",
    dutnumber: "dutNumber",
  };
```

**3c. `dimSql()` 的 `switch` 新增两个 `case`**（紧接在 `case "probeCardType":` 分支之后、`case "pass":` 之前插入，原第 113 行之后）：

```ts
    case "bin":
      return {
        groupByExpr:
          "NVL(LOWER(REGEXP_SUBSTR(t.TRIGGER_LABEL, 'Bin#\\s*([0-9]+|goodbin)', 1, 1, 'i', 1)), '')",
        grpKeyFrag:
          "NVL(LOWER(REGEXP_SUBSTR(t.TRIGGER_LABEL, 'Bin#\\s*([0-9]+|goodbin)', 1, 1, 'i', 1)), '')",
      };
    case "dutNumber":
      return {
        groupByExpr:
          "NVL(REGEXP_SUBSTR(t.TRIGGER_LABEL, 'on\\s+dut#\\s*([0-9]+)', 1, 1, 'i', 1), '')",
        grpKeyFrag:
          "NVL(REGEXP_SUBSTR(t.TRIGGER_LABEL, 'on\\s+dut#\\s*([0-9]+)', 1, 1, 'i', 1), '')",
      };
```

**3d. 更新文档字符串与错误提示中的允许维度枚举**（原第 150-151 行的 JSDoc 与第 162 行的错误信息）：

```ts
 * **必填**：**`dimensions`**（逗号分隔，至少 1 项，至多 5 项），取值：
 * `device`, `hostname`, `lotId`, `wafer`, `probeCard`, `probeCardType`, `pass`, `triggerLabel`, `timeDay`, `timeHour`, `bin`, `dutNumber`。
```

```ts
      error:
        'Missing required "dimensions" (comma-separated: device, hostname, lotId, wafer, probeCard, probeCardType, pass, triggerLabel, timeDay, timeHour, bin, dutNumber)',
```

- [ ] **Step 4: 实现 — Dummy / v4 全量行聚合侧（`yieldMonitorTriggerDummy.ts`）**

在文件顶部导入区（原第 1-14 行）新增两行导入：

```ts
import { parseBinFromTriggerLabel } from "./yieldTriggerLabelBin.js";
import { parseDutNumberFromTriggerLabel } from "./yieldTriggerLabelDut.js";
```

在 `valueForYieldV3Dimension()` 的 `switch` 中（原第 264-303 行），于 `case "probeCardType":` 分支之后、`case "pass":` 之前插入：

```ts
    case "bin":
      return parseBinFromTriggerLabel(row.TRIGGER_LABEL) ?? "";
    case "dutNumber": {
      const n = parseDutNumberFromTriggerLabel(row.TRIGGER_LABEL);
      return n === null ? "" : String(n);
    }
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `cd pcr-ai-api && npx tsx --test test/yieldMonitorTriggerV3Aggregate.test.ts test/rest-api-v3-dummy.test.ts`
Expected: 全部 `pass`

- [ ] **Step 6: typecheck + 全量测试**

Run: `cd pcr-ai-api && npm run typecheck && npm test`
Expected: `typecheck` 无报错（`dimSql` 与 `valueForYieldV3Dimension` 两个 `switch` 均已穷尽覆盖 `YieldMonitorV3AggDim`）；`npm test` 全部 `pass`（含新增文件与既有全部测试，确认未破坏其它维度/路由）

- [ ] **Step 7: Commit**

```bash
git add pcr-ai-api/src/lib/yieldMonitorTriggerV3Aggregate.ts pcr-ai-api/src/lib/yieldMonitorTriggerDummy.ts pcr-ai-api/test/yieldMonitorTriggerV3Aggregate.test.ts pcr-ai-api/test/rest-api-v3-dummy.test.ts
git commit -m "feat(api): add bin/dutNumber dimensions to yield monitor v3/v4 aggregate (Oracle SQL + Dummy)"
```

---

### Task 3: 后端 — 重新生成 `docs/API_V3.md`

**Files:**
- Modify: `pcr-ai-api/docs/API_V3.md`（由脚本生成，不手写）

**Interfaces:**
- Consumes: Task 2 落地后的 `YIELD_MONITOR_V3_AGGREGATE_DOCUMENTATION` 与维度枚举文本。
- Produces: 无（纯文档产出，无下游任务依赖其具体内容）。

- [ ] **Step 1: 构建并重新生成文档**

Run:
```bash
cd pcr-ai-api && npm run build && npm run docs:api-v3
```
Expected: 命令成功退出（exit code 0），`docs/API_V3.md` 被覆盖写入

- [ ] **Step 2: 核对 diff**

Run: `cd pcr-ai-api && git diff docs/API_V3.md`
Expected: diff 中出现 `bin`、`dutNumber` 相关的维度枚举/文档字符串更新；不应出现无关章节的大范围改动（若出现，说明生成脚本对其它模块也有非预期改动，需要停下核查而不是直接提交）

- [ ] **Step 3: Commit**

```bash
git add pcr-ai-api/docs/API_V3.md
git commit -m "docs(api): regenerate API_V3.md with bin/dutNumber yield monitor dimensions"
```

---

### Task 4: 前端 — 周期窗口与 Bin 标签格式化纯函数

**Files:**
- Modify: `pcr-ai-report/src/utils/yieldCalc.ts`

**Interfaces:**
- Produces:
  - `export type PeriodKey = "week" | "month"`
  - `export function periodWindow(period: PeriodKey, now?: Date): { start: Date; end: Date; prevStart: Date; prevEnd: Date }`
  - `export function formatBinLabel(bin: string): string`
- 供 Task 5 使用。

**背景**：`pcr-ai-report` 没有配置测试框架（`package.json` 无 `test` script），本任务用人工核对代替自动化测试，随后在 Task 5 完成后统一用 `npm run build` + 浏览器验证。

- [ ] **Step 1: 在 `yieldCalc.ts` 末尾（日期快捷方式之后）新增代码**

在 `pcr-ai-report/src/utils/yieldCalc.ts` 文件末尾（`dateShortcutThisMonth` 函数之后）追加：

```ts
// ── Period window (周/月报警统计) ────────────────────────────────────────

export type PeriodKey = "week" | "month";

/**
 * 当前周期窗口 + 等长的紧邻前一周期窗口（用于环比）。
 * 本周 = 最近 7 天；本月 = 自然月 1 日至今。
 * 环比窗口取与当前窗口等长的紧邻前段，使"本月至今 N 天" vs "上月同样 N 天"公平对比。
 */
export function periodWindow(
  period: PeriodKey,
  now: Date = new Date()
): { start: Date; end: Date; prevStart: Date; prevEnd: Date } {
  const end = now;
  const start =
    period === "week"
      ? new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
      : new Date(now.getFullYear(), now.getMonth(), 1);
  const durationMs = end.getTime() - start.getTime();
  const prevEnd = start;
  const prevStart = new Date(start.getTime() - durationMs);
  return { start, end, prevStart, prevEnd };
}

/** 派生聚合维度 `bin` 的展示格式：数字 → `BIN n`；`goodbin` → `GOODBIN`；空 → `(未知)`。 */
export function formatBinLabel(bin: string): string {
  const v = bin.trim();
  if (v === "") return "(未知)";
  if (v.toLowerCase() === "goodbin") return "GOODBIN";
  return `BIN ${v}`;
}
```

- [ ] **Step 2: 人工核对（无自动化测试框架，手动验证下列断言）**

Run（PowerShell，脚本不入库，仅本地验证）：
```powershell
cd D:\AI\PCR-AI-Agent\pcr-ai-report
& "C:\Program Files\nodejs\node.exe" -e "
function periodWindow(period, now) {
  const end = now;
  const start = period === 'week'
    ? new Date(now.getTime() - 7*24*60*60*1000)
    : new Date(now.getFullYear(), now.getMonth(), 1);
  const durationMs = end.getTime() - start.getTime();
  const prevEnd = start;
  const prevStart = new Date(start.getTime() - durationMs);
  return { start, end, prevStart, prevEnd };
}
const now = new Date('2026-07-15T10:00:00Z');
console.log('week', periodWindow('week', now));
console.log('month', periodWindow('month', now));
"
```
Expected:
- `week`：`start` = `2026-07-08T10:00:00.000Z`，`prevStart` = `2026-07-01T10:00:00.000Z`，`prevEnd` = `start`
- `month`：`start` = 本地时区 `2026-07-01T00:00:00`（本机时区，非 UTC），`durationMs` ≈ 14.4 天，`prevStart` 落在 6 月中旬，`prevEnd` = `start`

- [ ] **Step 3: Commit**

```bash
git add pcr-ai-report/src/utils/yieldCalc.ts
git commit -m "feat(report): add periodWindow + formatBinLabel utils for weekly/monthly alarm section"
```

---

### Task 5: 前端 — `YieldMonitorReport.tsx` 新增周期报警 section

**Files:**
- Modify: `pcr-ai-report/src/reports/YieldMonitorReport.tsx`
- Modify: `pcr-ai-report/src/components/DraggableReportSections.tsx`
- Modify: `pcr-ai-report/src/index.css`

**Interfaces:**
- Consumes: `periodWindow`、`formatBinLabel`、`PeriodKey`（Task 4，`../utils/yieldCalc`）；后端 `dimensions=hostname|probeCard|bin|dutNumber`（Task 2 落地后 `YIELD_AGGREGATE_PATH` 已支持）。
- Produces: 新顶层可拖拽 section `periodAlarm`，无下游任务依赖。

#### Step 1: 新增 import 与常量

在 `pcr-ai-report/src/reports/YieldMonitorReport.tsx` 顶部 import 区，找到：

```ts
import {
  buildTree,
  dateShortcutLast7Days,
  dateShortcutThisMonth,
  dateShortcutToday,
  parseDutNumber,
  tallyDutNumbers,
} from "../utils/yieldCalc";
```

改为：

```ts
import {
  buildTree,
  dateShortcutLast7Days,
  dateShortcutThisMonth,
  dateShortcutToday,
  formatBinLabel,
  parseDutNumber,
  periodWindow,
  tallyDutNumbers,
  type PeriodKey,
} from "../utils/yieldCalc";
```

再找到：

```ts
import { KpiCard } from "../components/KpiCard";
```

改为：

```ts
import { KpiCard, type KpiColor } from "../components/KpiCard";
```

（`selectionTierColors`、`horizontalBarChartBase`、`horizontalBarCategoryAxisLabel`、`rankBarChartHeight` 均已从 `../theme/chartTheme` 导入，无需改动。）

- [ ] 执行以上 2 处 import 修改

#### Step 2: 新增顶层 section 常量 + block 顺序常量

找到（原第 136-151 行）：

```ts
const YIELD_REPORT_SECTION_ORDER = [
  "kpi",
  "timeTrend",
  "chartsGrid",
  "tree",
  "detail",
] as const;

const YIELD_KPI_BLOCK_ORDER = [
  "kpiTrig",
  "kpiLots",
  "kpiWorstPct",
  "kpiSelPc",
] as const;

const YIELD_CHART_BLOCK_ORDER = ["chPcType", "chDevice", "chLot"] as const;
```

改为：

```ts
const YIELD_REPORT_SECTION_ORDER = [
  "kpi",
  "timeTrend",
  "periodAlarm",
  "chartsGrid",
  "tree",
  "detail",
] as const;

const YIELD_KPI_BLOCK_ORDER = [
  "kpiTrig",
  "kpiLots",
  "kpiWorstPct",
  "kpiSelPc",
] as const;

const YIELD_CHART_BLOCK_ORDER = ["chPcType", "chDevice", "chLot"] as const;

const YIELD_ALARM_KPI_BLOCK_ORDER = ["kpiAlarmTotal", "kpiAlarmRatio"] as const;

const YIELD_ALARM_CHART_BLOCK_ORDER = [
  "chAlarmTester",
  "chAlarmCard",
  "chAlarmBin",
  "chAlarmDut",
] as const;
```

- [ ] 执行以上修改

#### Step 3: 新增纯函数 `buildRankBarOption`（模块级，组件外）

找到 `filterYieldDrillGroupsForProbeCardType` 函数结尾（原第 304-318 行，函数体以 `}` 结束，紧接 `export function YieldMonitorReport(...)`）。在这两者之间插入：

```ts
/** 周期报警统计 4 图共用的横向 Top10 条形图 option 构建（DRY，避免 4 份近乎重复的 useMemo）。 */
function buildRankBarOption(
  theme: "light" | "dark",
  groups: AggregateGroup[],
  dimKey: string,
  color: string,
  formatLabel: (raw: string) => string = (v) => v
): EChartsOption {
  const palette = getChartPalette(theme);
  const sorted = [...groups].sort((a, b) => a.count - b.count).slice(-10);
  return {
    ...horizontalBarChartBase(theme),
    xAxis: {
      type: "value",
      axisLabel: { color: palette.axisColor },
      splitLine: { lineStyle: { color: palette.splitLine } },
    },
    yAxis: {
      type: "category",
      data: sorted.map((g) => formatLabel(g.parts[dimKey] ?? g.key)),
      axisLabel: { ...horizontalBarCategoryAxisLabel, color: palette.axisColor },
    },
    series: [
      {
        type: "bar",
        data: sorted.map((g) => g.count),
        itemStyle: { color, borderRadius: [0, 4, 4, 0] as unknown as number },
        label: { show: true, position: "right", color: palette.axisColor, fontSize: 10 },
        animationDuration: 600,
      },
    ],
  };
}
```

- [ ] 执行以上插入（`AggregateGroup`、`EChartsOption` 均已在文件顶部 import）

#### Step 4: 新增周期报警相关 state

在组件内找到（原第 351 行附近）：

```ts
  const [layoutEpoch, setLayoutEpoch] = useState(0);
```

在其后插入：

```ts
  const [period, setPeriod] = useState<PeriodKey>("week");
  const [appliedCoreParams, setAppliedCoreParams] = useState<
    Record<string, string | number | undefined>
  >(() => buildCoreParams(initialForm));
  const [periodTotal, setPeriodTotal] = useState<number | null>(null);
  const [periodPrevTotal, setPeriodPrevTotal] = useState<number | null>(null);
  const [periodByTester, setPeriodByTester] = useState<YieldMonitorV3AggregateResponse | null>(null);
  const [periodByCard, setPeriodByCard] = useState<YieldMonitorV3AggregateResponse | null>(null);
  const [periodByBin, setPeriodByBin] = useState<YieldMonitorV3AggregateResponse | null>(null);
  const [periodByDut, setPeriodByDut] = useState<YieldMonitorV3AggregateResponse | null>(null);
  const [loadingPeriod, setLoadingPeriod] = useState(false);
  const [errorPeriod, setErrorPeriod] = useState<string | null>(null);
```

- [ ] 执行以上插入

#### Step 5: 在 `query()` 里快照已生效筛选

找到（原第 548-560 行）：

```ts
  const query = useCallback(async () => {
    setLoadingList(true);
    setLoadingAgg(true);
    setErrorList(null);
    setErrorAgg(null);
    setDrills({});
    drillCacheRef.current = {};
    setSelectedProbeCard(null);
    setSelectedCardTypeName(null);
    setSelectedLotId(null);
    setSelectedDevice(null);
    setAggDevice(null);
    const core = buildCoreParams(form);
```

改为（仅在末尾新增一行 `setAppliedCoreParams(core);`）：

```ts
  const query = useCallback(async () => {
    setLoadingList(true);
    setLoadingAgg(true);
    setErrorList(null);
    setErrorAgg(null);
    setDrills({});
    drillCacheRef.current = {};
    setSelectedProbeCard(null);
    setSelectedCardTypeName(null);
    setSelectedLotId(null);
    setSelectedDevice(null);
    setAggDevice(null);
    const core = buildCoreParams(form);
    setAppliedCoreParams(core);
```

- [ ] 执行以上修改

#### Step 6: 新增周期报警数据获取 `useEffect`

找到 `dutProbeCardTarget` 相关 `useEffect` 的结尾（原第 642-680 行，以 `}, [dutProbeCardTarget, apiBase, form, listLimits, list]);` 结束）。在其后插入一个新的 `useEffect`：

```ts
  useEffect(() => {
    let cancelled = false;
    const { start, end, prevStart, prevEnd } = periodWindow(period);
    const periodParams = {
      ...appliedCoreParams,
      timeStampFrom: start.toISOString(),
      timeStampTo: end.toISOString(),
    };
    const prevParams = {
      ...appliedCoreParams,
      timeStampFrom: prevStart.toISOString(),
      timeStampTo: prevEnd.toISOString(),
    };
    setLoadingPeriod(true);
    setErrorPeriod(null);

    (async () => {
      const settled = await allSettledWithConcurrency(
        [
          () =>
            apiGetJson<YieldMonitorV3AggregateResponse>(apiBase, YIELD_AGGREGATE_PATH, {
              ...periodParams,
              dimensions: "hostname",
              groupTop: 10,
            }),
          () =>
            apiGetJson<YieldMonitorV3AggregateResponse>(apiBase, YIELD_AGGREGATE_PATH, {
              ...periodParams,
              dimensions: "probeCard",
              groupTop: 10,
            }),
          () =>
            apiGetJson<YieldMonitorV3AggregateResponse>(apiBase, YIELD_AGGREGATE_PATH, {
              ...periodParams,
              dimensions: "bin",
              groupTop: 10,
            }),
          () =>
            apiGetJson<YieldMonitorV3AggregateResponse>(apiBase, YIELD_AGGREGATE_PATH, {
              ...periodParams,
              dimensions: "dutNumber",
              groupTop: 10,
            }),
          () =>
            apiGetJson<YieldMonitorV3AggregateResponse>(apiBase, YIELD_AGGREGATE_PATH, {
              ...prevParams,
              dimensions: "hostname",
              groupTop: 1,
            }),
        ],
        REPORT_ORACLE_FANOUT_CONCURRENCY
      );
      if (cancelled) return;
      const [testerRes, cardRes, binRes, dutRes, prevRes] = settled as [
        PromiseSettledResult<YieldMonitorV3AggregateResponse>,
        PromiseSettledResult<YieldMonitorV3AggregateResponse>,
        PromiseSettledResult<YieldMonitorV3AggregateResponse>,
        PromiseSettledResult<YieldMonitorV3AggregateResponse>,
        PromiseSettledResult<YieldMonitorV3AggregateResponse>,
      ];
      setLoadingPeriod(false);

      if (testerRes.status === "fulfilled") {
        setPeriodByTester(testerRes.value);
        setPeriodTotal(testerRes.value.totalRowsMatching ?? null);
      } else {
        setErrorPeriod(
          testerRes.reason instanceof Error
            ? testerRes.reason.message
            : String(testerRes.reason)
        );
      }
      if (cardRes.status === "fulfilled") setPeriodByCard(cardRes.value);
      if (binRes.status === "fulfilled") setPeriodByBin(binRes.value);
      if (dutRes.status === "fulfilled") setPeriodByDut(dutRes.value);
      if (prevRes.status === "fulfilled") {
        setPeriodPrevTotal(prevRes.value.totalRowsMatching ?? null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [apiBase, appliedCoreParams, period]);
```

- [ ] 执行以上插入

#### Step 7: 新增周期报警的图表 option 与环比派生值（`useMemo`）

找到 `dutOption` 的 `useMemo` 结尾（原第 808-838 行，以 `}, [dutTally, theme]);` 结束）。在其后插入：

```ts
  const periodTesterOption = useMemo(
    () => buildRankBarOption(theme, periodByTester?.groups ?? [], "hostname", chartPalette.accent),
    [periodByTester, theme, chartPalette.accent]
  );
  const periodCardOption = useMemo(
    () => buildRankBarOption(theme, periodByCard?.groups ?? [], "probeCard", chartPalette.accent2),
    [periodByCard, theme, chartPalette.accent2]
  );
  const periodBinOption = useMemo(
    () =>
      buildRankBarOption(theme, periodByBin?.groups ?? [], "bin", chartPalette.accent3, formatBinLabel),
    [periodByBin, theme, chartPalette.accent3]
  );
  const periodDutOption = useMemo(
    () =>
      buildRankBarOption(
        theme,
        periodByDut?.groups ?? [],
        "dutNumber",
        selectionTierColors(theme, "orange").base,
        (v) => `dut#${v}`
      ),
    [periodByDut, theme]
  );

  const periodRatioPct = useMemo(() => {
    if (periodTotal === null || periodPrevTotal === null) return null;
    if (periodPrevTotal === 0) return periodTotal > 0 ? Infinity : 0;
    return ((periodTotal - periodPrevTotal) / periodPrevTotal) * 100;
  }, [periodTotal, periodPrevTotal]);

  const periodRatioLabel = useMemo(() => {
    if (periodRatioPct === null) return "—";
    if (periodRatioPct === Infinity) return "新增";
    if (periodRatioPct === 0) return "0%";
    const sign = periodRatioPct > 0 ? "↑" : "↓";
    return `${sign}${Math.abs(periodRatioPct).toFixed(1)}%`;
  }, [periodRatioPct]);

  const periodRatioColor: KpiColor = useMemo(() => {
    if (periodRatioPct === null || periodRatioPct === 0) return "white";
    return periodRatioPct === Infinity || periodRatioPct > 0 ? "red" : "green";
  }, [periodRatioPct]);
```

- [ ] 执行以上插入

#### Step 8: 构建 `periodAlarmSection` JSX 并接入 `yieldReportSections`

找到（原第 1010-1012 行）：

```ts
  const yieldReportSections = useMemo(() => {
    if (!hasData) return {};

    const kpiSection = (
```

改为：

```ts
  const yieldReportSections = useMemo(() => {
    const periodAlarmSection = (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="preset-chips">
          {(["week", "month"] as const).map((p) => (
            <button
              key={p}
              type="button"
              className={`chip${period === p ? " chip--active" : ""}`}
              onClick={() => setPeriod(p)}
            >
              {p === "week" ? "本周" : "本月"}
            </button>
          ))}
        </div>
        <DraggableReportBlocks
          storageKey="pcr-ai-report:yield-monitor-alarm-kpi-blocks"
          defaultOrder={YIELD_ALARM_KPI_BLOCK_ORDER}
          layoutEpoch={layoutEpoch}
          axis="x"
          groupClassName="report-reorder-group--kpis"
          labels={{
            kpiAlarmTotal: "总触发次数",
            kpiAlarmRatio: "环比变化率",
          }}
          sections={{
            kpiAlarmTotal: (
              <KpiCard
                label="总触发次数"
                value={periodTotal}
                color="blue"
                subtext={periodPrevTotal !== null ? `上一周期 ${periodPrevTotal} 次` : undefined}
                showLabel={false}
              />
            ),
            kpiAlarmRatio: (
              <KpiCard
                label="环比变化率"
                value={periodRatioLabel}
                color={periodRatioColor}
                subtext="vs 上一周期"
                showLabel={false}
              />
            ),
          }}
        />
        {errorPeriod && (
          <div style={{ color: "var(--red-text)", fontSize: 12 }}>{errorPeriod}</div>
        )}
        <DraggableReportBlocks
          storageKey="pcr-ai-report:yield-monitor-alarm-chart-blocks"
          defaultOrder={YIELD_ALARM_CHART_BLOCK_ORDER}
          layoutEpoch={layoutEpoch}
          axis="grid"
          groupClassName="report-reorder-group--chartgrid"
          labels={{
            chAlarmTester: "Tester 分布",
            chAlarmCard: "Probe Card 分布",
            chAlarmBin: "Bin 分布",
            chAlarmDut: "DUT 分布",
          }}
          sections={{
            chAlarmTester: (
              <div className="report-chart-panel chart-no-drill">
                {loadingPeriod ? (
                  <div style={{ color: "var(--muted)", fontSize: 12, padding: "8px 0" }}>加载中…</div>
                ) : (periodByTester?.groups.length ?? 0) === 0 ? (
                  <div style={{ color: "var(--muted)", fontSize: 12, padding: "8px 0" }}>该周期无触发记录</div>
                ) : (
                  <DarkChart
                    option={periodTesterOption}
                    height={rankBarChartHeight(periodByTester?.groups.length ?? 0, 10)}
                  />
                )}
              </div>
            ),
            chAlarmCard: (
              <div className="report-chart-panel chart-no-drill">
                {loadingPeriod ? (
                  <div style={{ color: "var(--muted)", fontSize: 12, padding: "8px 0" }}>加载中…</div>
                ) : (periodByCard?.groups.length ?? 0) === 0 ? (
                  <div style={{ color: "var(--muted)", fontSize: 12, padding: "8px 0" }}>该周期无触发记录</div>
                ) : (
                  <DarkChart
                    option={periodCardOption}
                    height={rankBarChartHeight(periodByCard?.groups.length ?? 0, 10)}
                  />
                )}
              </div>
            ),
            chAlarmBin: (
              <div className="report-chart-panel chart-no-drill">
                {loadingPeriod ? (
                  <div style={{ color: "var(--muted)", fontSize: 12, padding: "8px 0" }}>加载中…</div>
                ) : (periodByBin?.groups.length ?? 0) === 0 ? (
                  <div style={{ color: "var(--muted)", fontSize: 12, padding: "8px 0" }}>该周期无触发记录</div>
                ) : (
                  <DarkChart
                    option={periodBinOption}
                    height={rankBarChartHeight(periodByBin?.groups.length ?? 0, 10)}
                  />
                )}
              </div>
            ),
            chAlarmDut: (
              <div className="report-chart-panel chart-no-drill">
                {loadingPeriod ? (
                  <div style={{ color: "var(--muted)", fontSize: 12, padding: "8px 0" }}>加载中…</div>
                ) : (periodByDut?.groups.length ?? 0) === 0 ? (
                  <div style={{ color: "var(--muted)", fontSize: 12, padding: "8px 0" }}>该周期无触发记录</div>
                ) : (
                  <DarkChart
                    option={periodDutOption}
                    height={rankBarChartHeight(periodByDut?.groups.length ?? 0, 10)}
                  />
                )}
              </div>
            ),
          }}
        />
      </div>
    );

    if (!hasData) return { periodAlarm: periodAlarmSection };

    const kpiSection = (
```

然后找到该 `useMemo` 的 `return` 语句与依赖数组（原第 1289-1323 行）：

```ts
    return {
      kpi: kpiSection,
      timeTrend: timeTrendSection,
      chartsGrid: chartsGridSection,
      tree: treeSection,
      detail: detailSection,
    };
  }, [
    hasData,
    totalTriggers,
    uniqueLots,
    worstCardType,
    selectedProbeCard,
    aggTime,
    timeTrendOption,
    aggCardType,
    cardTypeOption,
    drills,
    aggDevice,
    deviceOption,
    selectedDevice,
    form,
    fetchDrill,
    probeCardDutFooter,
    loadingDut,
    dutRows,
    aggLot,
    lotOption,
    treeRoots,
    showTree,
    detailRows,
    list,
    showDetail,
    layoutEpoch,
  ]);
```

改为：

```ts
    return {
      kpi: kpiSection,
      timeTrend: timeTrendSection,
      periodAlarm: periodAlarmSection,
      chartsGrid: chartsGridSection,
      tree: treeSection,
      detail: detailSection,
    };
  }, [
    hasData,
    totalTriggers,
    uniqueLots,
    worstCardType,
    selectedProbeCard,
    aggTime,
    timeTrendOption,
    aggCardType,
    cardTypeOption,
    drills,
    aggDevice,
    deviceOption,
    selectedDevice,
    form,
    fetchDrill,
    probeCardDutFooter,
    loadingDut,
    dutRows,
    aggLot,
    lotOption,
    treeRoots,
    showTree,
    detailRows,
    list,
    showDetail,
    layoutEpoch,
    period,
    periodTotal,
    periodPrevTotal,
    periodRatioLabel,
    periodRatioColor,
    periodByTester,
    periodByCard,
    periodByBin,
    periodByDut,
    periodTesterOption,
    periodCardOption,
    periodBinOption,
    periodDutOption,
    loadingPeriod,
    errorPeriod,
  ]);
```

- [ ] 执行以上两处修改

#### Step 9: `DraggableReportSections.tsx` 新增 section 标签

在 `pcr-ai-report/src/components/DraggableReportSections.tsx` 找到（原第 498-510 行）：

```ts
const TOP_SECTION_LABELS: Record<string, string> = {
  binDist: "坏 Bin 全局分布",
  kpi: "关键指标",
  funnel: "多级钻取漏斗",
  device: "Device 不良分析",
  pcType: "ProbeCard Type 不良对比",
  timeTrend: "每日触发量趋势",
  underperformingDuts: "低良率 DUT",
  chartsGrid: "图表矩阵",
  tree: "分组汇总",
  detail: "明细表",
  infDut: "INF · DUT 分布（仅不良 bin）",
};
```

改为（新增一行 `periodAlarm`）：

```ts
const TOP_SECTION_LABELS: Record<string, string> = {
  binDist: "坏 Bin 全局分布",
  kpi: "关键指标",
  funnel: "多级钻取漏斗",
  device: "Device 不良分析",
  pcType: "ProbeCard Type 不良对比",
  timeTrend: "每日触发量趋势",
  periodAlarm: "周期报警统计",
  underperformingDuts: "低良率 DUT",
  chartsGrid: "图表矩阵",
  tree: "分组汇总",
  detail: "明细表",
  infDut: "INF · DUT 分布（仅不良 bin）",
};
```

- [ ] 执行以上修改

#### Step 10: `index.css` 新增周期切换按钮的激活态样式

在 `pcr-ai-report/src/index.css` 找到（原第 597-602 行）：

```css
button.chip:hover {
  color: var(--text);
  border-color: rgba(var(--accent-2-rgb),0.45);
  background: rgba(var(--accent-2-rgb),0.06);
}
```

在其后新增：

```css
button.chip.chip--active {
  color: var(--bg);
  background: var(--accent);
  border-color: var(--accent);
}
button.chip.chip--active:hover {
  color: var(--bg);
  background: var(--accent);
}
```

- [ ] 执行以上插入

#### Step 11: typecheck + build

Run: `cd pcr-ai-report && npm run build`
Expected: `tsc -b && vite build` 成功退出，无 TypeScript 报错（重点检查：`buildRankBarOption` 参数类型、`YIELD_ALARM_KPI_BLOCK_ORDER`/`YIELD_ALARM_CHART_BLOCK_ORDER` 与 `DraggableReportBlocks` 的 `defaultOrder` 类型是否匹配、`periodByTester?.groups.length` 这类可选链——`groups` 字段本身非可选，`?.` 短路语义下无需再加一层 `?.`，若 TS 仍报错再补一层 `?.groups?.length`）

- [ ] **Step 12: Commit**

```bash
git add pcr-ai-report/src/reports/YieldMonitorReport.tsx pcr-ai-report/src/components/DraggableReportSections.tsx pcr-ai-report/src/index.css
git commit -m "feat(report): add Weekly/Monthly Yield Monitor Alarm section (KPI + tester/card/bin/dut charts)"
```

---

### Task 6: 端到端验证

**Files:** 无代码改动，仅验证

- [ ] **Step 1: 后端全量测试 + typecheck**

Run: `cd pcr-ai-api && npm run typecheck && npm test`
Expected: 两者均无失败项

- [ ] **Step 2: 前端构建**

Run: `cd pcr-ai-report && npm run build`
Expected: 构建成功

- [ ] **Step 3: 本地起服务，浏览器手测**

Run（分别在两个终端）：
```bash
cd pcr-ai-api && npm run dev
```
```bash
cd pcr-ai-report && npm run dev
```
打开报表 Yield Monitor tab，确认：
1. 页面加载后（无需点「查询」）「周期报警统计」区域即显示「本周」数据（默认使用 Dummy 样本，`YIELD_MONITOR_TRIGGERS_DUMMY` 在 `npm run dev` 下默认为 `true`）。
2. 点击「本月」切换，KPI 与 4 图立即刷新，无需重新点击「查询」。
3. 4 个分类图表（Tester / Probe Card / Bin / DUT）都渲染出条形图，Bin 图的 y 轴标签形如 `BIN 1`、`GOODBIN`；DUT 图形如 `dut#21`。
4. 在查询表单里填一个 `Device` 筛选值并点击「查询」，「周期报警统计」的数字随之收窄（与其它图表联动一致）。
5. 「本周」/「本月」按钮点击后能正确高亮（激活态样式生效）。
6. 通过设置页的 ⚙ → 「还原布局」测试新 section 的拖拽/隐藏能正常工作，不与其它 section 顺序冲突。

Expected: 以上 6 点全部符合；若浏览器 console 有报错或图表空白，回退检查 Task 5 的对应 Step。

- [ ] **Step 4: 记录验证结果（无需 commit，若发现问题回退到对应 Task 修复）**

---

## Self-Review 记录

- **spec 覆盖**：设计文档中的「位置与交互」「KPI 卡片」「四个分类图表」「后端改动」「数据获取」5 个部分分别对应 Task 5（交互/KPI/图表 UI + 数据获取 `useEffect`）与 Task 1-3（后端）。「不做的事」（无下钻、仅周/月两档、不重复卡型分布）均未在计划中引入对应功能，保持一致。
- **占位符扫描**：无 TBD/TODO；所有 Step 均含完整可运行代码或精确 shell 命令。
- **类型一致性**：`YieldMonitorV3AggDim`（Task 2 定义 `"bin" | "dutNumber"`，Oracle SQL 与 Dummy 两处 switch 在同一任务内一起补全，避免中间态编译失败）→ Task 5 使用的维度字符串字面量 `"bin"`/`"dutNumber"`/`"hostname"`/`"probeCard"` 与后端 `parseDimToken` 接受的 token 完全一致（后端对 token 做 `toLowerCase()` 匹配 `dutnumber`，前端字面量 `"dutNumber"` 小写化后一致）。`PeriodKey`（Task 4 定义）→ Task 5 `useState<PeriodKey>("week")` 引用一致。`KpiColor`（已存在于 `KpiCard.tsx`）→ Task 5 `periodRatioColor: KpiColor` 一致。
- **任务边界修正**：初稿曾把 Oracle SQL 侧与 Dummy 侧拆成两个任务，自查时发现两者共享同一个穷尽联合类型 `YieldMonitorV3AggDim`，拆开会导致第一个任务提交后代码编译不过，已合并为 Task 2 并在 Global Constraints 中记录这条约束。
