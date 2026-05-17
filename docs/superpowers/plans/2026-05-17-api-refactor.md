# pcr-ai-api Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `lib/agent/agentTools.ts` (552 lines) and `routes/api.ts` (1590 lines) into focused single-responsibility files without changing any behaviour, HTTP paths, or response shapes.

**Architecture:** Phase 1 extracts system prompt, tool schemas, chart logic, and tool handlers out of `agentTools.ts` into four new files under `lib/agent/`; `agentLoop.ts` updates its import paths and `agentTools.ts` is deleted. Phase 2 creates `lib/routeHelpers.ts` for shared error-response helpers, then splits `routes/api.ts` into four domain routers (`infcontrolRoutes`, `yieldMonitorRoutes`, `manifestRoutes`, `siliconflowRoutes`); `api.ts` is reduced to a mounting-only file.

**Tech Stack:** Node.js 18, Express 4, TypeScript 5, `tsx` watch, `oracledb 5.5`, `npm test` = `tsx --test test/*.test.ts`

---

## File Map

### Phase 1 — lib/agent/

| File | Action | Responsibility |
|---|---|---|
| `lib/agent/agentChartTool.ts` | **Create** | `ChartData`, `ChartSentinel`, `ClarificationSentinel`, `buildChartOption()` |
| `lib/agent/agentToolSchemas.ts` | **Create** | `TOOL_SCHEMAS` constant |
| `lib/agent/agentPrompt.ts` | **Create** | `buildSystemPrompt()` |
| `lib/agent/agentToolHandlers.ts` | **Create** | `runTool()` + 4 private tool functions |
| `lib/agent/agentLoop.ts` | **Modify** | update 2 import lines |
| `lib/agent/agentTools.ts` | **Delete** | content moved to 4 new files |

### Phase 2 — routes/ + lib/

| File | Action | Responsibility |
|---|---|---|
| `lib/routeHelpers.ts` | **Create** | `reqId`, `sendValidationError`, `sendOracleError`, `sendMemoryLimitError` |
| `routes/manifestRoutes.ts` | **Create** | `/manifest`, `/db/ping`, `/table-rows` |
| `routes/siliconflowRoutes.ts` | **Create** | `/siliconflow/chat` |
| `routes/infcontrolRoutes.ts` | **Create** | all `/infcontrol-layer-bins/*` routes |
| `routes/yieldMonitorRoutes.ts` | **Create** | all `/yield-monitor-triggers/*` routes |
| `routes/api.ts` | **Modify** | mounting-only (5 lines) |

---

## Task 1: Create the refactor branch

**Files:** none

- [ ] **Step 1: Create and switch to branch**

```bash
cd pcr-ai-api
git checkout -b refactor/api-split
```

Expected: `Switched to a new branch 'refactor/api-split'`

---

## Task 2: Create `lib/agent/agentChartTool.ts`

**Files:**
- Create: `pcr-ai-api/src/lib/agent/agentChartTool.ts`

- [ ] **Step 1: Create the file**

Content is extracted verbatim from `agentTools.ts` lines 239–294 with a corrected import path comment:

```typescript
// pcr-ai-api/src/lib/agent/agentChartTool.ts

export interface ChartData {
  labels: string[];
  series: { name: string; values: number[] }[];
}

export interface ChartSentinel {
  __chartOption: object;
}

export interface ClarificationSentinel {
  __clarification: string;
}

export function buildChartOption(
  chartType: "bar" | "line" | "pie" | "scatter",
  title: string,
  data: ChartData
): object {
  if (chartType === "pie") {
    const pieData = data.labels.map((label, i) => ({
      name: label,
      value: data.series[0]?.values[i] ?? 0,
    }));
    return {
      title: { text: title, left: "center" },
      tooltip: { trigger: "item" },
      legend: { orient: "vertical", left: "left" },
      series: [{ type: "pie", radius: "50%", data: pieData }],
    };
  }

  const xAxis =
    chartType === "scatter"
      ? undefined
      : { type: "category", data: data.labels, axisLabel: { rotate: 30 } };

  const series = data.series.map((s) => {
    if (chartType === "scatter") {
      return {
        name: s.name,
        type: "scatter",
        data: data.labels.map((label, i) => [label, s.values[i] ?? 0]),
      };
    }
    return { name: s.name, type: chartType, data: s.values };
  });

  return {
    title: { text: title },
    tooltip: { trigger: "axis" },
    legend: { data: data.series.map((s) => s.name) },
    xAxis,
    yAxis: { type: "value" },
    series,
  };
}
```

---

## Task 3: Create `lib/agent/agentToolSchemas.ts`

**Files:**
- Create: `pcr-ai-api/src/lib/agent/agentToolSchemas.ts`

- [ ] **Step 1: Create the file**

Content is the `TOOL_SCHEMAS` constant from `agentTools.ts` lines 45–235, unchanged:

```typescript
// pcr-ai-api/src/lib/agent/agentToolSchemas.ts

export const TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: "query_yield_triggers",
      description:
        "查询 Yield Monitor 触发记录列表（delta_diff 类型）。返回最近触发的原始记录。",
      parameters: {
        type: "object",
        properties: {
          device: { type: "string", description: "产品代码，如 WA03P02G" },
          lotId: { type: "string", description: "批次 ID" },
          wafer: { type: "string", description: "晶圆编号" },
          hostname: { type: "string", description: "测试机名称" },
          probeCard: { type: "string", description: "探针卡 ID" },
          probeCardType: {
            type: "string",
            description: "探针卡类型（PROBECARD 第一段，- 之前）",
          },
          pass: { type: "number", description: "Pass 编号" },
          timeFrom: { type: "string", description: "开始时间 ISO 8601" },
          timeTo: { type: "string", description: "结束时间 ISO 8601" },
          limit: {
            type: "number",
            description: "返回行数，默认 50，最大 200",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "aggregate_yield_triggers",
      description: "对 Yield Monitor 触发记录按维度聚合统计触发次数。",
      parameters: {
        type: "object",
        properties: {
          dimensions: {
            type: "string",
            description:
              "逗号分隔的聚合维度，可选: device, hostname, lotId, wafer, probeCard, probeCardType, pass, timeDay",
          },
          groupTop: {
            type: "number",
            description: "返回 top N 组，默认 10，最大 25",
          },
          device: { type: "string" },
          lotId: { type: "string" },
          wafer: { type: "string" },
          hostname: { type: "string" },
          probeCard: { type: "string" },
          probeCardType: { type: "string" },
          pass: { type: "number" },
          timeFrom: { type: "string", description: "开始时间 ISO 8601" },
          timeTo: { type: "string", description: "结束时间 ISO 8601" },
        },
        required: ["dimensions"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "query_jb_bins",
      description:
        "查询 JB STAR Layer Bins 数据列表（INFCONTROL ⋈ INFLAYERBINLIST，PASSTYPE=TEST）。",
      parameters: {
        type: "object",
        properties: {
          device: { type: "string", description: "产品代码" },
          lot: { type: "string", description: "批次 ID" },
          slot: { type: "number", description: "晶圆槽位号" },
          cardId: { type: "string", description: "探针卡 ID（CARDID）" },
          probeCardType: { type: "string", description: "探针卡类型" },
          testerId: { type: "string", description: "测试机 ID" },
          passId: { type: "number", description: "Pass ID" },
          meslot: { type: "string", description: "MES 槽位" },
          testEndFrom: {
            type: "string",
            description: "测试结束时间起 ISO 8601",
          },
          testEndTo: {
            type: "string",
            description: "测试结束时间止 ISO 8601",
          },
          limit: {
            type: "number",
            description: "返回行数，默认 50，最大 200",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "aggregate_jb_bins",
      description:
        "对 JB STAR 数据按维度聚合统计 die 数量（UNPIVOT BIN0-BIN255，仅统计坏 bin）。bin 维度自动包含。",
      parameters: {
        type: "object",
        properties: {
          groupBy: {
            type: "string",
            description:
              "逗号分隔的分组维度，可选（bin 自动包含）: device, lot, slot, cardId, probeCardType, testerId, passId, layerName, passResume, passResult, meslot",
          },
          groupTop: {
            type: "number",
            description: "返回 top N 组，默认 10，最大 50",
          },
          device: { type: "string" },
          lot: { type: "string" },
          slot: { type: "number" },
          cardId: { type: "string" },
          probeCardType: { type: "string" },
          testerId: { type: "string" },
          passId: { type: "number" },
          meslot: { type: "string" },
          testEndFrom: { type: "string" },
          testEndTo: { type: "string" },
        },
        required: ["groupBy"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_chart",
      description:
        "根据数据生成 ECharts 图表配置。调用后图表会内嵌显示在对话中。",
      parameters: {
        type: "object",
        properties: {
          chartType: {
            type: "string",
            enum: ["bar", "line", "pie", "scatter"],
            description: "图表类型",
          },
          title: { type: "string", description: "图表标题" },
          data: {
            type: "object",
            description: "图表数据",
            properties: {
              labels: {
                type: "array",
                items: { type: "string" },
                description: "X 轴标签或 pie 分类",
              },
              series: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    values: { type: "array", items: { type: "number" } },
                  },
                  required: ["name", "values"],
                },
              },
            },
            required: ["labels", "series"],
          },
        },
        required: ["chartType", "title", "data"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_clarification",
      description:
        "当用户请求模糊或缺少关键信息时，调用此工具向用户提问。问题应简洁明确，每次只问一个问题。",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "向用户提出的澄清问题",
          },
        },
        required: ["question"],
      },
    },
  },
] as const;
```

---

## Task 4: Create `lib/agent/agentPrompt.ts`

**Files:**
- Create: `pcr-ai-api/src/lib/agent/agentPrompt.ts`

- [ ] **Step 1: Create the file**

Content is `buildSystemPrompt()` extracted from `agentLoop.ts` lines 21–77:

```typescript
// pcr-ai-api/src/lib/agent/agentPrompt.ts

export function buildSystemPrompt(): string {
  const today = new Date().toISOString().slice(0, 10);
  return `你是 NXP ATTJ WaferTest 数据分析助手。

**当前日期：${today}**
**语言要求：必须全程用中文回答，严禁使用英文。**

可用工具：query_yield_triggers, aggregate_yield_triggers, query_jb_bins, aggregate_jb_bins, generate_chart, ask_clarification。

## 决策优先级

面对用户请求时，按以下顺序判断：

1. **澄清优先** — 仅当 **device 产品代码完全未知** 时才调用 ask_clarification
   → 时间范围、批次号、晶圆号、测试机等均有 API 默认值，**不得以缺少这些参数为由询问用户**
   → 用户说"总体查一下"/"都查"/"概况"时，直接用默认参数查询，无需确认
   → 必须询问时合并为一次问题，禁止多轮追问

2. **规划其次** — 请求明确，但需要 3 步及以上的连续操作
   → 先输出 [PLAN]\\n1. 步骤一\\n2. 步骤二\\n[/PLAN]，等用户确认（"好的"/"确认"/"yes"/"ok"）后再执行
   → 确认前不调用任何数据工具

3. **反思兜底** — 工具执行失败，且换策略有可能成功
   → 在回复中嵌入 [REFLECT]需要换策略：<原因和新策略>[/REFLECT]，最多重试 2 次
   → 超过 2 次直接告知用户失败原因

4. **直接执行** — 请求明确，步骤简单（1~2 步）
   → 直接调用工具完成，无需规划

## 数据规则

- 查询结果为空（totalRowsMatching=0 或 groups 为空数组）时，立即用中文回答"没有找到符合条件的数据"，不要继续调用其他工具或生成图表
- 用中文回答，数字结论要具体（给出具体数字）
- 时间范围未指定时，API 默认查最近 1 年数据，无需额外说明
- Yield Monitor 数据来自 YMWEB_YIELDMONITORTRIGGER 表（delta_diff 类型），使用 query_yield_triggers / aggregate_yield_triggers
- JB STAR 数据来自 INFCONTROL ⋈ INFLAYERBINLIST（PASSTYPE=TEST），使用 query_jb_bins / aggregate_jb_bins

## 回复顺序（严格遵守）

**必须先输出文字结论，再按条件决定是否生成图表。** 流程如下：

1. 调用数据工具获取结果
2. 用文字回答用户问题（总结关键数字、结论、排名等），至少 2~3 句话
3. 仅满足以下任一条件时才调用 generate_chart：
   - 聚合结果 **groups 数量 ≥ 3**（有足够数据点值得可视化）
   - 用户明确提到"图"、"趋势"、"排名"、"分布"、"可视化"等词
   - 时序数据（timeDay 维度）
4. 以下情况**不要**生成图表：
   - 结果只有 1~2 个数据点（文字描述更清晰）
   - 用户只问"有没有"、"多少"等简单事实性问题
   - 查询结果为空

图表类型：bar 适合计数对比，line 适合时序趋势，pie 适合占比

❌ 禁止：数据工具执行完直接调用 generate_chart，不输出任何文字
✅ 正确：先写结论段落，再按上述条件决定是否生成图表`;
}
```

---

## Task 5: Create `lib/agent/agentToolHandlers.ts`

**Files:**
- Create: `pcr-ai-api/src/lib/agent/agentToolHandlers.ts`

- [ ] **Step 1: Create the file**

Content is the bottom half of `agentTools.ts` (lines 1–42 imports + lines 297–551 implementation), with import paths updated to reference the new `agentChartTool.ts`:

```typescript
// pcr-ai-api/src/lib/agent/agentToolHandlers.ts
import { withConnection, withProbeWebConnection } from "../../oracle.js";
import oracledb from "oracledb";
import {
  parseYieldMonitorTriggerV3Query,
} from "../yieldMonitorTriggerFilters.js";
import {
  parseYieldMonitorTriggerV3AggregateQuery,
  buildYieldMonitorTriggerV3AggregateSql,
  buildYieldMonitorTriggerV3AggregateTotalSql,
  buildYieldMonitorV3AggregateGroupParts,
  type YieldMonitorV3AggDim,
} from "../yieldMonitorTriggerV3Aggregate.js";
import {
  yieldMonitorTriggersUseDummy,
  filterYieldMonitorDummyRowsV3,
  aggregateYieldMonitorV3DummyRows,
} from "../yieldMonitorTriggerDummy.js";
import {
  parseInfcontrolLayerBinsV3Query,
} from "../infcontrolLayerBinFilters.js";
import {
  parseInfcontrolLayerBinsV3AggregateQuery,
} from "../infcontrolLayerBinV3Aggregate.js";
import {
  buildInfcontrolLayerBinAggregateSql,
  buildInfcontrolLayerBinMatchingCountSql,
  type InfcontrolLayerBinGroupBy,
} from "../infcontrolLayerBinAggregate.js";
import {
  infcontrolLayerBinsUseDummy,
  filterInfcontrolLayerBinV3DummyRows,
  aggregateInfcontrolLayerBinV3DummyRows,
} from "../infcontrolLayerBinDummy.js";
import {
  buildYieldMonitorTriggersV3Sql,
  buildInfcontrolLayerBinsV3Sql,
} from "../apiV3ListSql.js";
import { probeCardTypeLeadingSegment } from "../probeCardTypeLeadingSegment.js";
import { addDutNumberToYieldMonitorV3Row } from "../yieldTriggerLabelDut.js";
import { enrichInfcontrolLayerBinRowV2 } from "../passBinSemantics.js";
import {
  buildChartOption,
  type ChartData,
  type ChartSentinel,
  type ClarificationSentinel,
} from "./agentChartTool.js";

export type { ChartSentinel, ClarificationSentinel };

const TOOL_LIST_LIMIT = 50;
const TOOL_LIST_LIMIT_MAX = 200;
const TOOL_RESULT_TRUNCATE = 3000;

function clampLimit(raw: unknown, defaultVal: number, max: number): number {
  const n = typeof raw === "number" ? raw : defaultVal;
  return Math.min(Math.max(1, Math.round(n)), max);
}

function truncateResult(obj: unknown): string {
  try {
    const s = JSON.stringify(obj);
    return s.length > TOOL_RESULT_TRUNCATE
      ? s.slice(0, TOOL_RESULT_TRUNCATE) + "…(truncated)"
      : s;
  } catch {
    return "(结果序列化失败)";
  }
}

function enrichYieldRow(row: Record<string, unknown>): Record<string, unknown> {
  const base = addDutNumberToYieldMonitorV3Row(row);
  return {
    ...base,
    PROBECARDTYPE: probeCardTypeLeadingSegment(
      base["PROBECARD"] ?? base["probecard"]
    ),
  };
}

function enrichJbRow(row: Record<string, unknown>): Record<string, unknown> {
  const e = enrichInfcontrolLayerBinRowV2(row);
  return {
    ...e,
    PROBECARDTYPE: probeCardTypeLeadingSegment(e["CARDID"] ?? e["cardid"]),
  };
}

async function toolQueryYieldTriggers(
  args: Record<string, unknown>
): Promise<string> {
  const limit = clampLimit(args["limit"], TOOL_LIST_LIMIT, TOOL_LIST_LIMIT_MAX);
  const params: Record<string, unknown> = { ...args, limit };
  if (args["timeFrom"]) params["timeStampFrom"] = args["timeFrom"];
  if (args["timeTo"]) params["timeStampTo"] = args["timeTo"];

  const parsed = parseYieldMonitorTriggerV3Query(params);
  if (!parsed.ok) return `查询参数错误: ${parsed.error}`;

  if (yieldMonitorTriggersUseDummy()) {
    const rows = filterYieldMonitorDummyRowsV3(parsed.applied, limit).map(
      (r) => enrichYieldRow(r as Record<string, unknown>)
    );
    return truncateResult({ count: rows.length, rows });
  }

  const sql = buildYieldMonitorTriggersV3Sql(parsed.whereSql);
  const rows = await withProbeWebConnection(async (conn) => {
    const result = await conn.execute(sql, { ...parsed.binds, lim: limit }, {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
    });
    return (result.rows ?? []) as Record<string, unknown>[];
  });
  const enriched = rows.map(enrichYieldRow);
  return truncateResult({ count: enriched.length, rows: enriched });
}

async function toolAggregateYieldTriggers(
  args: Record<string, unknown>
): Promise<string> {
  const dimensionsRaw = String(args["dimensions"] ?? "device");
  const groupTop = clampLimit(args["groupTop"], 10, 25);
  const params: Record<string, unknown> = {
    ...args,
    dimensions: dimensionsRaw,
    groupTop,
  };
  if (args["timeFrom"]) params["timeStampFrom"] = args["timeFrom"];
  if (args["timeTo"]) params["timeStampTo"] = args["timeTo"];

  const parsed = parseYieldMonitorTriggerV3AggregateQuery(params);
  if (!parsed.ok) return `查询参数错误: ${parsed.error}`;

  if (yieldMonitorTriggersUseDummy()) {
    const result = aggregateYieldMonitorV3DummyRows(
      parsed.applied,
      parsed.dimensions as YieldMonitorV3AggDim[],
      parsed.groupTop
    );
    return truncateResult(result);
  }

  const sql = buildYieldMonitorTriggerV3AggregateSql(
    parsed.whereSql,
    parsed.dimensions as YieldMonitorV3AggDim[]
  );
  const totalSql = buildYieldMonitorTriggerV3AggregateTotalSql(parsed.whereSql);

  const { groups, total } = await withProbeWebConnection(async (conn) => {
    const aggResult = await conn.execute(
      sql,
      { ...parsed.binds, agg_lim: parsed.groupTop },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const totalResult = await conn.execute(totalSql, parsed.binds, {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
    });
    const totalRows = (totalResult.rows ?? []) as Record<string, unknown>[];
    const totalCount =
      typeof totalRows[0]?.["TOTAL_MATCHING"] === "number"
        ? (totalRows[0]["TOTAL_MATCHING"] as number)
        : 0;
    const rawGroups = (aggResult.rows ?? []) as Record<string, unknown>[];
    const builtGroups = rawGroups.map((grpRow) => {
      const grpKey = String(grpRow["GRP_KEY"] ?? "");
      const cnt = Number(grpRow["CNT"] ?? 0);
      return {
        ...buildYieldMonitorV3AggregateGroupParts(
          parsed.dimensions as YieldMonitorV3AggDim[],
          grpKey
        ),
        count: cnt,
      };
    });
    return { groups: builtGroups, total: totalCount };
  });

  return truncateResult({ totalRowsMatching: total, groups });
}

async function toolQueryJbBins(
  args: Record<string, unknown>
): Promise<string> {
  const limit = clampLimit(args["limit"], TOOL_LIST_LIMIT, TOOL_LIST_LIMIT_MAX);
  const parsed = parseInfcontrolLayerBinsV3Query({ ...args, limit });
  if (!parsed.ok) return `查询参数错误: ${parsed.error}`;

  if (infcontrolLayerBinsUseDummy()) {
    const rows = filterInfcontrolLayerBinV3DummyRows(parsed.applied, limit).map(
      (r) => enrichJbRow(r as Record<string, unknown>)
    );
    return truncateResult({ count: rows.length, rows });
  }

  const sql = buildInfcontrolLayerBinsV3Sql(parsed.whereAndSql);
  const rows = await withConnection(async (conn) => {
    const result = await conn.execute(
      sql,
      { ...parsed.binds, lim: limit },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    return (result.rows ?? []) as Record<string, unknown>[];
  });
  const enriched = rows.map(enrichJbRow);
  return truncateResult({ count: enriched.length, rows: enriched });
}

async function toolAggregateJbBins(
  args: Record<string, unknown>
): Promise<string> {
  const groupByRaw = String(args["groupBy"] ?? "bin");
  const groupTop = clampLimit(args["groupTop"], 10, 50);

  const parts = groupByRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.includes("bin")) parts.unshift("bin");
  const groupByStr = parts.join(",");

  const params: Record<string, unknown> = {
    ...args,
    groupBy: groupByStr,
    groupTop,
  };
  const parsed = parseInfcontrolLayerBinsV3AggregateQuery(params);
  if (!parsed.ok) return `查询参数错误: ${parsed.error}`;

  if (infcontrolLayerBinsUseDummy()) {
    const result = aggregateInfcontrolLayerBinV3DummyRows(
      parsed.applied,
      parsed.groupBy as InfcontrolLayerBinGroupBy[],
      parsed.groupTop
    );
    return truncateResult(result);
  }

  const sql = buildInfcontrolLayerBinAggregateSql(
    parsed.whereSql,
    parsed.groupBy as InfcontrolLayerBinGroupBy[],
    "v3-hyphen-tokens"
  );
  const totalSql = buildInfcontrolLayerBinMatchingCountSql(parsed.whereSql);

  const { groups, total } = await withConnection(async (conn) => {
    const aggResult = await conn.execute(
      sql,
      { ...parsed.binds, agg_lim: parsed.groupTop },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const totalResult = await conn.execute(totalSql, parsed.binds, {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
    });
    const totalRows = (totalResult.rows ?? []) as Record<string, unknown>[];
    const totalCount =
      typeof totalRows[0]?.["TOTAL_MATCHING"] === "number"
        ? (totalRows[0]["TOTAL_MATCHING"] as number)
        : 0;
    return {
      groups: (aggResult.rows ?? []) as Record<string, unknown>[],
      total: totalCount,
    };
  });

  return truncateResult({ totalRowsMatching: total, groups });
}

export async function runTool(
  name: string,
  args: Record<string, unknown>
): Promise<string | ChartSentinel | ClarificationSentinel> {
  switch (name) {
    case "query_yield_triggers":
      return toolQueryYieldTriggers(args);
    case "aggregate_yield_triggers":
      return toolAggregateYieldTriggers(args);
    case "query_jb_bins":
      return toolQueryJbBins(args);
    case "aggregate_jb_bins":
      return toolAggregateJbBins(args);
    case "generate_chart": {
      try {
        const chartType = args["chartType"] as "bar" | "line" | "pie" | "scatter";
        const title = String(args["title"] ?? "");
        const data = args["data"] as ChartData;
        const option = buildChartOption(chartType, title, data);
        return { __chartOption: option };
      } catch (err) {
        return `生成图表失败: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    case "ask_clarification": {
      const question = String(args["question"] ?? "").trim();
      if (!question) return "ask_clarification 参数错误: question 不能为空";
      return { __clarification: question };
    }
    default:
      return `未知工具: ${name}`;
  }
}
```

---

## Task 6: Update `agentLoop.ts` imports and delete `agentTools.ts`

**Files:**
- Modify: `pcr-ai-api/src/lib/agent/agentLoop.ts`
- Delete: `pcr-ai-api/src/lib/agent/agentTools.ts`

- [ ] **Step 1: Replace the import block in `agentLoop.ts`**

Replace lines 9–10 (the `agentTools.js` import):

```typescript
// OLD (line 9 in agentLoop.ts):
import { TOOL_SCHEMAS, runTool, type ChartSentinel, type ClarificationSentinel } from "./agentTools.js";

// NEW — replace with these two lines:
import { TOOL_SCHEMAS } from "./agentToolSchemas.js";
import { runTool, type ChartSentinel, type ClarificationSentinel } from "./agentToolHandlers.js";
```

Also replace line 21 (the inline `buildSystemPrompt`) — add an import at the top and remove the function body:

```typescript
// Add after the agentHistory import (around line 8):
import { buildSystemPrompt } from "./agentPrompt.js";
```

Then **delete** lines 21–77 (the entire `function buildSystemPrompt(): string { ... }` block) from `agentLoop.ts`.

- [ ] **Step 2: Delete `agentTools.ts`**

```bash
rm pcr-ai-api/src/lib/agent/agentTools.ts
```

---

## Task 7: Verify agent phase and commit

**Files:** none (verification only)

- [ ] **Step 1: Run typecheck**

```bash
cd pcr-ai-api
npm run typecheck
```

Expected: exits 0, no errors.

- [ ] **Step 2: Run tests**

```bash
npm test
```

Expected: all tests pass (agentRoute, agentStream, agentHistory, agentConfig, REST dummy).

- [ ] **Step 3: Commit**

```bash
git add src/lib/agent/
git commit -m "refactor(agent): split agentTools.ts into agentPrompt, agentToolSchemas, agentChartTool, agentToolHandlers"
```

---

## Task 8: Create `lib/routeHelpers.ts`

**Files:**
- Create: `pcr-ai-api/src/lib/routeHelpers.ts`

- [ ] **Step 1: Create the file**

```typescript
// pcr-ai-api/src/lib/routeHelpers.ts
import type { Request, Response } from "express";
import { sendAgentError, enrichOracleDriverDetail } from "./agentResponse.js";

export function reqId(req: Request): string | undefined {
  return (req as Request & { requestId?: string }).requestId;
}

export function sendValidationError(
  res: Response,
  error: string,
  hint?: string
): void {
  sendAgentError(res, 400, "VALIDATION_ERROR", error, hint);
}

export function sendOracleError(res: Response, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  sendAgentError(
    res,
    500,
    "ORACLE_QUERY_FAILED",
    "Oracle query failed",
    enrichOracleDriverDetail(message)
  );
}

export function sendMemoryLimitError(
  res: Response,
  count: number,
  max: number,
  narrowHint: string
): void {
  sendAgentError(
    res,
    422,
    "QUERY_TOO_LARGE",
    `Matching rows (${count}) exceed MEMORY_AGG_ORACLE_MAX_ROWS (${max}). ${narrowHint}`,
    "See .env.example MEMORY_AGG_ORACLE_MAX_ROWS."
  );
}
```

---

## Task 9: Create `routes/manifestRoutes.ts`

**Files:**
- Create: `pcr-ai-api/src/routes/manifestRoutes.ts`

Content covers `/manifest`, `/db/ping`, `/table-rows` from `api.ts` lines 127–130, 1503–1590.

- [ ] **Step 1: Create the file**

```typescript
// pcr-ai-api/src/routes/manifestRoutes.ts
import { Router } from "express";
import oracledb from "oracledb";
import { buildManifestResponseJson } from "../lib/rebaseApiManifest.js";
import { sendAgentError, enrichOracleDriverDetail } from "../lib/agentResponse.js";
import { withConnection } from "../oracle.js";
import { clampLimit, parseQualifiedTable } from "../lib/sqlIdent.js";
import { reqId, sendValidationError, sendOracleError } from "../lib/routeHelpers.js";

export const manifestRouter = Router();

/** AI agent 工具发现：参数说明、示例与错误格式约定 */
manifestRouter.get("/manifest", (req, res) => {
  res.json(buildManifestResponseJson(req.baseUrl || "/api/v1"));
});

/** 从 dual 探测数据库连通性 */
manifestRouter.get("/db/ping", async (req, res) => {
  try {
    const row = await withConnection(async (conn) => {
      const r = await conn.execute(
        "SELECT 1 AS ok FROM DUAL",
        {},
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      return r.rows?.[0] ?? null;
    });
    return res.json({
      meta: { apiVersion: "1", requestId: reqId(req) },
      ok: true,
      dual: row,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return sendAgentError(
      res,
      500,
      "ORACLE_PING_FAILED",
      "Oracle ping failed",
      enrichOracleDriverDetail(message)
    );
  }
});

/**
 * 只读查询表前 N 行（ROWNUM，兼容旧版 Oracle）
 * GET /api/v1/table-rows?table=MY_TABLE&limit=50
 */
manifestRouter.get("/table-rows", async (req, res) => {
  const fromEnv = process.env.ORACLE_DEFAULT_TABLE;
  const tableRaw = req.query.table ?? fromEnv;
  const parsed = parseQualifiedTable(tableRaw);
  if ("error" in parsed) {
    return sendValidationError(
      res,
      parsed.error,
      "Set ?table=SCHEMA.MY_TABLE or ORACLE_DEFAULT_TABLE in .env"
    );
  }

  const limit = clampLimit(req.query.limit, 50, 500);
  const fromClause =
    parsed.schema == null
      ? parsed.table
      : `${parsed.schema}.${parsed.table}`;

  const sql = `
    SELECT * FROM (
      SELECT inner_q.*, ROWNUM AS rnum
      FROM (SELECT * FROM ${fromClause}) inner_q
      WHERE ROWNUM <= :lim
    )
    WHERE rnum >= 1
  `;

  try {
    const rows = await withConnection(async (conn) => {
      const result = await conn.execute(
        sql,
        { lim: limit },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      return result.rows || [];
    });
    return res.json({
      meta: { apiVersion: "1", requestId: reqId(req) },
      table: parsed.schema ? `${parsed.schema}.${parsed.table}` : parsed.table,
      limit,
      rows,
    });
  } catch (err) {
    return sendOracleError(res, err);
  }
});
```

---

## Task 10: Create `routes/siliconflowRoutes.ts`

**Files:**
- Create: `pcr-ai-api/src/routes/siliconflowRoutes.ts`

Content is the `/siliconflow/chat` handler from `api.ts` lines 132–200.

- [ ] **Step 1: Create the file**

```typescript
// pcr-ai-api/src/routes/siliconflowRoutes.ts
import { Router } from "express";
import { sendAgentError } from "../lib/agentResponse.js";
import {
  callSiliconflowChat,
  getSiliconflowConfig,
} from "../lib/siliconflowChat.js";

export const siliconflowRouter = Router();

/** 硅基流动 OpenAI 兼容 Chat Completions：仅查询参数 `message`（UTF-8）；密钥见 `siliconflowChat.ts`。 */
siliconflowRouter.get("/siliconflow/chat", async (req, res) => {
  const raw = req.query.message;
  const message =
    typeof raw === "string"
      ? raw.trim()
      : Array.isArray(raw) && typeof raw[0] === "string"
        ? raw[0].trim()
        : "";
  if (!message) {
    return sendAgentError(
      res,
      400,
      "VALIDATION_ERROR",
      "Missing or empty query parameter: message"
    );
  }
  const maxLen = 100_000;
  if (message.length > maxLen) {
    return sendAgentError(
      res,
      400,
      "VALIDATION_ERROR",
      `message exceeds ${maxLen} characters`
    );
  }

  const cfg = getSiliconflowConfig();

  try {
    const out = await callSiliconflowChat(cfg, message);
    if (!out.ok) {
      const detail =
        typeof out.body === "string"
          ? out.body
          : JSON.stringify(out.body).slice(0, 4000);
      const status =
        out.status >= 400 && out.status < 600 ? out.status : 502;
      const isNetwork = out.kind === "network";
      return sendAgentError(
        res,
        status,
        isNetwork ? "SILICONFLOW_FETCH_FAILED" : "SILICONFLOW_ERROR",
        isNetwork
          ? "Failed to reach SiliconFlow"
          : "SiliconFlow API returned an error",
        detail
      );
    }
    const body: Record<string, unknown> = {
      message,
      reply: out.reply,
      model: out.model,
    };
    if (out.reasoningContent != null && out.reasoningContent !== "") {
      body.reasoningContent = out.reasoningContent;
    }
    res.json(body);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return sendAgentError(
      res,
      502,
      "SILICONFLOW_FETCH_FAILED",
      "Failed to reach SiliconFlow",
      detail
    );
  }
});
```

---

## Task 11: Create `routes/infcontrolRoutes.ts`

**Files:**
- Create: `pcr-ai-api/src/routes/infcontrolRoutes.ts`

This file consolidates all `/infcontrol-layer-bins/*` routes from `api.ts`.

- [ ] **Step 1: Create the file**

The file consists of:
1. Imports (all infcontrol-related libs used in `api.ts` lines 6–54, 85–98)
2. The `enrichInfcontrolLayerBinV3ListRow` helper (currently `api.ts` lines 107–115)
3. All six infcontrol route handlers (currently `api.ts` lines 213–754, 1101–1294)

```typescript
// pcr-ai-api/src/routes/infcontrolRoutes.ts
import { Router } from "express";
import oracledb, { type BindParameters } from "oracledb";
import {
  INFCONTROL_LAYER_BIN_TOP,
  parseInfcontrolLayerBinQuery,
  parseInfcontrolLayerBinsV3Query,
} from "../lib/infcontrolLayerBinFilters.js";
import {
  INFCONTROL_LAYER_BIN_V2_BAD_RANK_MAX,
  INFCONTROL_LAYER_BIN_V2_BAD_RANK_MIN,
  INFCONTROL_LAYER_BIN_V2_MAX_TOP,
  parseInfcontrolLayerBinV2BadBinsQuery,
  parseInfcontrolLayerBinV2Query,
} from "../lib/infcontrolLayerBinV2Filters.js";
import {
  buildInfcontrolLayerBinV2BadBinTotalsSql,
  rankBadBinTotalsFromAggregateRow,
} from "../lib/infcontrolLayerBinV2BadBinsSql.js";
import { buildInfcontrolLayerBinV2TopSql } from "../lib/infcontrolLayerBinV2Sql.js";
import {
  API_V3_LIST_LIMIT_MAX,
  buildInfcontrolLayerBinsV3Sql,
  buildInfcontrolLayerBinsV3SqlFullMatching,
} from "../lib/apiV3ListSql.js";
import {
  aggregateInfcontrolLayerBinDummyRows,
  aggregateInfcontrolLayerBinV2BadBinsDummy,
  aggregateInfcontrolLayerBinV3DummyRows,
  aggregateInfcontrolLayerBinV3FromRows,
  filterInfcontrolLayerBinV2DummyRows,
  filterInfcontrolLayerBinV3DummyRows,
  filterInfcontrolLayerBinV3DummyRowsMatching,
  filterInfcontrolLayerDummyRows,
  infcontrolLayerBinsUseDummy,
} from "../lib/infcontrolLayerBinDummy.js";
import type { InfcontrolLayerBinDummyRow } from "../lib/infcontrolLayerBinDummy.js";
import {
  buildInfcontrolLayerBinAggregateGroupParts,
  buildInfcontrolLayerBinAggregateSql,
  buildInfcontrolLayerBinMatchingCountSql,
  parseInfcontrolLayerBinAggregateQuery,
} from "../lib/infcontrolLayerBinAggregate.js";
import {
  INFCONTROL_V3_AGGREGATE_DOCUMENTATION,
  parseInfcontrolLayerBinsV3AggregateQuery,
} from "../lib/infcontrolLayerBinV3Aggregate.js";
import {
  enrichInfcontrolLayerBinRow,
  enrichInfcontrolLayerBinRowV2,
} from "../lib/passBinSemantics.js";
import { buildInfcontrolLayerBinTopSql } from "../lib/infcontrolLayerBinSql.js";
import { INFCONTROL_V4_AGGREGATE_DOCUMENTATION } from "../lib/apiV4Docs.js";
import { normalizeDbRowKeysUpper } from "../lib/dbRowKeyUpper.js";
import { readMemoryAggregateOracleMaxRows } from "../lib/memoryAggregateOracleLimits.js";
import { probeCardTypeLeadingSegment } from "../lib/probeCardTypeLeadingSegment.js";
import { clampLimitFromQuery } from "../lib/sqlIdent.js";
import { withConnection } from "../oracle.js";
import {
  reqId,
  sendValidationError,
  sendOracleError,
  sendMemoryLimitError,
} from "../lib/routeHelpers.js";

export const infcontrolRouter = Router();

function enrichInfcontrolLayerBinV3ListRow(
  row: Record<string, unknown>
): Record<string, unknown> {
  const e = enrichInfcontrolLayerBinRowV2(row);
  return {
    ...e,
    PROBECARDTYPE: probeCardTypeLeadingSegment(e.CARDID ?? e.cardid),
  };
}
```

Then append the route handlers verbatim from `api.ts`:
- Lines 213–286: `GET /infcontrol-layer-bins` (v1)
- Lines 293–371: `GET /infcontrol-layer-bins/v2`
- Lines 379–453: `GET /infcontrol-layer-bins/v3`
- Lines 459–568: `GET /infcontrol-layer-bins/v3/aggregate`
- Lines 574–643: `GET /infcontrol-layer-bins/v2/top-bad-bins`
- Lines 650–754: `GET /infcontrol-layer-bins/aggregate`
- Lines 1101–1175: `GET /infcontrol-layer-bins/v4`
- Lines 1180–1294: `GET /infcontrol-layer-bins/v4/aggregate`

**Two changes to make in the pasted handlers:**
1. Replace every `apiRouter.get(` → `infcontrolRouter.get(`
2. Replace `sendAgentError(res, 400, "VALIDATION_ERROR", parsed.error, ...)` with `sendValidationError(res, parsed.error, ...)`
3. Replace `sendAgentError(res, 500, "ORACLE_QUERY_FAILED", ...)` with `sendOracleError(res, err)`
4. Replace the four inline 422 blocks in `/v4/aggregate` with `sendMemoryLimitError(res, count, max, "Narrow filters (device, lot, testEnd*, etc.).")`

---

## Task 12: Create `routes/yieldMonitorRoutes.ts`

**Files:**
- Create: `pcr-ai-api/src/routes/yieldMonitorRoutes.ts`

This file consolidates all `/yield-monitor-triggers/*` routes from `api.ts`.

- [ ] **Step 1: Create the file**

```typescript
// pcr-ai-api/src/routes/yieldMonitorRoutes.ts
import { Router } from "express";
import oracledb, { type BindParameters } from "oracledb";
import {
  API_V3_LIST_LIMIT_MAX,
  buildYieldMonitorTriggersV3Sql,
  buildYieldMonitorTriggersV3SqlFullMatching,
} from "../lib/apiV3ListSql.js";
import {
  YIELD_MONITOR_TRIGGER_TOP,
  parseYieldMonitorTriggerQuery,
  parseYieldMonitorTriggerV3Query,
} from "../lib/yieldMonitorTriggerFilters.js";
import {
  YIELD_MONITOR_V3_AGGREGATE_DOCUMENTATION,
  buildYieldMonitorTriggerV3AggregateSql,
  buildYieldMonitorTriggerV3AggregateTotalSql,
  buildYieldMonitorV3AggregateGroupParts,
  parseYieldMonitorTriggerV3AggregateQuery,
} from "../lib/yieldMonitorTriggerV3Aggregate.js";
import { buildYieldMonitorTriggerMatchingCountSql } from "../lib/yieldMonitorTriggerAggregate.js";
import {
  buildYieldMonitorHostnameSummarySql,
  buildYieldMonitorProbeCardSummarySql,
  buildYieldMonitorTriggerTopSql,
} from "../lib/yieldMonitorTriggerSql.js";
import {
  aggregateYieldMonitorV3DummyRows,
  aggregateYieldMonitorV3FromRows,
  buildYieldMonitorHostnameSummaryDummy,
  buildYieldMonitorProbeCardSummaryDummy,
  filterYieldMonitorDummyRows,
  filterYieldMonitorDummyRowsMatchingV3,
  filterYieldMonitorDummyRowsV3,
  yieldMonitorTriggersUseDummy,
} from "../lib/yieldMonitorTriggerDummy.js";
import type { YieldMonitorTriggerDummyRow } from "../lib/yieldMonitorTriggerDummy.js";
import { YIELD_MONITOR_V4_AGGREGATE_DOCUMENTATION } from "../lib/apiV4Docs.js";
import { normalizeDbRowKeysUpper } from "../lib/dbRowKeyUpper.js";
import { readMemoryAggregateOracleMaxRows } from "../lib/memoryAggregateOracleLimits.js";
import { probeCardTypeLeadingSegment } from "../lib/probeCardTypeLeadingSegment.js";
import { addDutNumberToYieldMonitorV3Row } from "../lib/yieldTriggerLabelDut.js";
import { clampLimitFromQuery } from "../lib/sqlIdent.js";
import { withProbeWebConnection } from "../oracle.js";
import {
  reqId,
  sendValidationError,
  sendOracleError,
  sendMemoryLimitError,
} from "../lib/routeHelpers.js";

export const yieldMonitorRouter = Router();

function enrichYieldMonitorTriggerV3ListRow(
  row: Record<string, unknown>
): Record<string, unknown> {
  const base = addDutNumberToYieldMonitorV3Row(row);
  return {
    ...base,
    PROBECARDTYPE: probeCardTypeLeadingSegment(base.PROBECARD ?? base.probecard),
  };
}
```

Then append the route handlers verbatim from `api.ts`:
- Lines 764–904: `GET /yield-monitor-triggers` (v1)
- Lines 910–987: `GET /yield-monitor-triggers/v3`
- Lines 988–1096: `GET /yield-monitor-triggers/v3/aggregate`
- Lines 1299–1372: `GET /yield-monitor-triggers/v4`
- Lines 1377–1501: `GET /yield-monitor-triggers/v4/aggregate`

**Two changes to make in the pasted handlers:**
1. Replace every `apiRouter.get(` → `yieldMonitorRouter.get(`
2. Replace `sendAgentError(res, 400, "VALIDATION_ERROR", parsed.error, ...)` with `sendValidationError(res, parsed.error, ...)`
3. Replace `sendAgentError(res, 500, "ORACLE_QUERY_FAILED", ...)` with `sendOracleError(res, err)` (in the catch blocks that use the standard pattern)
4. Replace the four inline 422 blocks in `/v4/aggregate` with `sendMemoryLimitError(res, count, max, "Narrow filters (device, timeStamp*, etc.).")`

---

## Task 13: Slim down `routes/api.ts` to mounting-only

**Files:**
- Modify: `pcr-ai-api/src/routes/api.ts`

- [ ] **Step 1: Replace the entire file content**

```typescript
// pcr-ai-api/src/routes/api.ts
import { Router } from "express";
import { manifestRouter } from "./manifestRoutes.js";
import { siliconflowRouter } from "./siliconflowRoutes.js";
import { infcontrolRouter } from "./infcontrolRoutes.js";
import { yieldMonitorRouter } from "./yieldMonitorRoutes.js";

export const apiRouter = Router();

apiRouter.use(manifestRouter);
apiRouter.use(siliconflowRouter);
apiRouter.use(infcontrolRouter);
apiRouter.use(yieldMonitorRouter);
```

---

## Task 14: Final verification and commit

**Files:** none (verification only)

- [ ] **Step 1: Run typecheck**

```bash
cd pcr-ai-api
npm run typecheck
```

Expected: exits 0, no errors.

- [ ] **Step 2: Run all tests**

```bash
npm test
```

Expected: all tests pass — agentRoute, agentStream, agentHistory, agentConfig, REST dummy (v3 + v4).

- [ ] **Step 3: Build and verify no undici**

```bash
npm run build
```

Expected: exits 0. `dist/lib/siliconflowChat.js` must not contain `import 'undici'` (verified by `verify-dist-no-undici` script run during build).

- [ ] **Step 4: Commit routes phase**

```bash
git add src/lib/routeHelpers.ts src/routes/
git commit -m "refactor(routes): split api.ts into domain routers + routeHelpers"
```

---

## Self-Review Notes

**Spec coverage:** ✅ All three goals addressed — agent file split (Tasks 2–7), route split (Tasks 9–13), shared error helpers (Task 8).

**Placeholder check:** Tasks 11–12 reference exact `api.ts` line ranges for the verbatim copy; no TBDs.

**Type consistency:**
- `ChartSentinel` and `ClarificationSentinel` are defined in `agentChartTool.ts` and re-exported from `agentToolHandlers.ts` — `agentLoop.ts` imports them from `agentToolHandlers.js`, which is where it currently imports them.
- `sendValidationError` / `sendOracleError` / `sendMemoryLimitError` defined in Task 8 and used in Tasks 9–12 — signatures match.
- `reqId` defined in Task 8 and used in Tasks 9–12 — signature matches current `api.ts` local function.

**Scope:** `lib/` directory structure (outside `lib/agent/`) unchanged. Frontend untouched.
