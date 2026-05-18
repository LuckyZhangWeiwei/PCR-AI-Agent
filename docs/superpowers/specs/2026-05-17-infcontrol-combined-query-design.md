# InfcontrolReport 合并查询端点设计文档

**日期：** 2026-05-17
**范围：** `pcr-ai-api` 新增端点 + `pcr-ai-report` InfcontrolReport 改造
**目标：** 将 InfcontrolReport 初始加载从 6 次串行 Oracle 查询降为 1 次

---

## 1. 背景与动机

InfcontrolReport 初始加载时发出 6 次 Oracle 请求（串行，concurrency=1）：

| 请求 | 端点 | 说明 |
|---|---|---|
| 1 | `GET /api/v4/infcontrol-layer-bins/v4` | 列表（top N，快） |
| 2–6 | `GET /api/v3/infcontrol-layer-bins/v3/aggregate` ×5 | 聚合（Oracle 库内 UNPIVOT 255 列，慢） |

5 次聚合各触发一次 Oracle UNPIVOT（bin / probeCardType / slot / device / tree 维度组合），串行执行避免连接池耗尽（NJS-040）。这是页面加载慢的根本原因。

**解决方案：** 新建 `/v4/combined` 端点，一次 Oracle 查询（top N 行）同时满足列表展示与所有聚合需求。聚合在 Node 内存中完成，复用已有的 `aggregateInfcontrolLayerBinV3FromRows`。

---

## 2. 核心约束

1. **现有端点不变**：`/v4`（列表）、`/v3/aggregate`（聚合）路径、响应格式、错误码一字不改
2. **Dummy/Oracle 双路径**：新端点同样实现两条路径，与现有规则一致
3. **drill-down 不变**：用户点击下钻时仍走 `/v3/aggregate`，本次只优化初始加载
4. **语义变化（已知）**：`aggregates[x].totalRowsMatching` = 本次 top N 的行数，而非 Oracle 全量匹配行数；这是合理的——图表与列表基于同一批数据

---

## 3. 新端点

### 3.1 请求

```
GET /api/v4/infcontrol-layer-bins/v4/combined
```

**过滤参数**：与 `/v4` 列表端点完全相同（device、lot、slot、meslot、testerId、tstype、cardId、passId、testEndFrom/To 等）

**`limit`**：top N 行数（来自前端设置），同时作为聚合的数据源大小；默认 200，最大 `API_V3_LIST_LIMIT_MAX`

**`aggs`**：`|` 分隔的聚合规格列表，每项格式 `groupBy字符串:groupTop整数`

```
aggs=bin:30|probeCardType,bin:25|slot,bin:50|device,bin:30|lot,passId,probeCardType,cardId,bin:100
```

规则：
- `groupBy` 语义与现有 `/v3/aggregate` 的 `groupBy` 参数相同（逗号分隔多维度）
- `groupTop` 省略时默认 30
- 最多 10 个聚合规格；超出返回 `400 VALIDATION_ERROR`
- `aggs` 缺失或为空字符串时：`aggregates` 返回空对象 `{}`

### 3.2 响应

```json
{
  "meta": {
    "apiVersion": "4",
    "requestId": "...",
    "combinedPath": "infcontrol-layer-bins/v4/combined"
  },
  "limit": 300,
  "limitMax": 500,
  "orderBy": "TESTEND DESC NULLS LAST, SLOT, PASSID, PASSNUM",
  "filters": { "device": "WA03P02G", "limit": 300 },
  "count": 245,
  "rows": [ /* 同 /v4 列表端点的行结构，含 PROBECARDTYPE 等 enrich 字段 */ ],
  "aggregates": {
    "bin": {
      "groupBy": "bin",
      "groupTop": 30,
      "totalRowsMatching": 245,
      "groups": [ { "key": "5", "count": 120, "parts": { "bin": "5" } } ]
    },
    "probeCardType,bin": {
      "groupBy": "probeCardType,bin",
      "groupTop": 25,
      "totalRowsMatching": 245,
      "groups": [ ... ]
    }
  }
}
```

`aggregates` 以 `groupBy` 字符串为 key。`groups` 结构与 `/v3/aggregate` 完全相同（`key`、`count`、`parts`）。

### 3.3 错误

| 状态码 | code | 场景 |
|---|---|---|
| 400 | `VALIDATION_ERROR` | 过滤参数非法 或 aggs 规格超过 10 条 或 groupTop 非正整数 |
| 500 | `ORACLE_QUERY_FAILED` | Oracle 查询失败 |

**无 422**：本端点固定 top N，不触发 MEMORY_AGG_ORACLE_MAX_ROWS 限制。

---

## 4. 后端实现

### 4.1 新文件：`pcr-ai-api/src/lib/parseAggsParam.ts`

```typescript
export type AggSpec = { groupBy: string; groupTop: number };

export function parseAggsParam(
  raw: unknown,
  maxSpecs = 10
): { ok: true; specs: AggSpec[] } | { ok: false; error: string }
```

解析规则：
- `raw` 不是字符串或为空 → `{ ok: true, specs: [] }`
- 按 `|` 分割，过滤空项
- 每项按最后一个 `:` 分割（`groupBy` 可含逗号，`groupTop` 是末尾数字）
- `groupTop` 缺失 → 默认 30；非正整数 → 返回 `{ ok: false, error: ... }`
- 规格数 > maxSpecs → 返回 `{ ok: false, error: ... }`

### 4.2 路由：`pcr-ai-api/src/routes/infcontrolRoutes.ts`

新增路由 `infcontrolRouter.get("/infcontrol-layer-bins/v4/combined", ...)` 处理逻辑：

**Oracle 路径：**
1. `parseInfcontrolLayerBinsV3Query(req.query)` — 过滤参数解析（与 v4 列表相同）
2. `parseAggsParam(req.query.aggs)` — 聚合规格解析
3. `clampLimitFromQuery(req.query, 200, API_V3_LIST_LIMIT_MAX)` — limit 解析
4. 一次 Oracle 查询：`buildInfcontrolLayerBinsV3Sql(parsed.whereAndSql)` + `FETCH FIRST limit`
5. `normalizeDbRowKeysUpper(row)` — 统一列名大写（供聚合使用）
6. 对每个 `AggSpec`：`aggregateInfcontrolLayerBinV3FromRows(normalizedRows, spec.groupBy, spec.groupTop)`
7. `enrichInfcontrolLayerBinV3ListRow(normalizedRow)` — 添加 PROBECARDTYPE 等展示字段
8. 返回合并响应

**Dummy 路径（完全对称）：**
1. `filterInfcontrolLayerBinV3DummyRows(parsed.applied, limit)` — 获取 top N 行
2. 对每个 `AggSpec`：`aggregateInfcontrolLayerBinV3FromRows(dummyRows, spec.groupBy, spec.groupTop)`
3. `enrichInfcontrolLayerBinV3ListRow(row)` — 枚举展示字段
4. 返回合并响应

**聚合与展示行的关系**：
- 聚合输入：`normalizedRows`（原始大写列，BIN0…BIN255 完整）
- 展示输出：`enrichedRows`（带 PROBECARDTYPE、passBinPair 等）
- 两者来自同一批 Oracle 结果，分两步处理

### 4.3 不改动的文件

- `src/lib/infcontrolLayerBinDummy.ts` — 复用现有函数
- `src/lib/infcontrolLayerBinAggregate.ts` — 复用 `aggregateInfcontrolLayerBinV3FromRows`
- `src/lib/apiV3ListSql.ts` — 复用 `buildInfcontrolLayerBinsV3Sql`
- 所有现有路由 — 不改动

---

## 5. 前端实现

### 5.1 `pcr-ai-report/src/api/paths.ts`

新增：
```typescript
export const INFCONTROL_COMBINED_PATH = "/api/v4/infcontrol-layer-bins/v4/combined";
```

`INFCONTROL_AGGREGATE_PATH` 保留（drill-down 仍用）。

### 5.2 `pcr-ai-report/src/api/types.ts`

新增两个接口：
```typescript
export interface InfcontrolAggregateBlock {
  groupBy: string;
  groupTop: number;
  totalRowsMatching: number;
  groups: AggregateGroup[];
}

export interface InfcontrolCombinedResponse extends InfcontrolLayerBinsV3Response {
  aggregates: Record<string, InfcontrolAggregateBlock>;
}
```

### 5.3 `pcr-ai-report/src/reports/InfcontrolReport.tsx`

`handleQuery` 函数改动：

**改前（6 次串行 Oracle 请求）：**
```
Phase 1: list call (v4)
Phase 2: 5× aggregate calls (v3, concurrency=1)
```

**改后（1 次请求）：**
```typescript
const res = await apiGetJson<InfcontrolCombinedResponse>(
  apiBase,
  INFCONTROL_COMBINED_PATH,
  {
    ...buildListParams(form, listLimits),
    aggs: [
      `${jbAggregateGroupBy("bin")}:30`,
      `${jbAggregateGroupBy("probeCardType")}:25`,
      `${jbAggregateGroupBy("slot")}:50`,
      `${jbAggregateGroupBy("device")}:30`,
      `${jbAggregateGroupBy("lot", "passId", "probeCardType", "cardId")}:100`,
    ].join("|"),
  }
);
// 解构并 setState
setBinRes(res.aggregates[jbAggregateGroupBy("bin")]);
setCardTypeRes(res.aggregates[jbAggregateGroupBy("probeCardType", "bin")]);
// ...
```

**drill-down 聚合**（`fetchDrillAgg`、`fetchFreeAgg`）不变，仍走 `INFCONTROL_AGGREGATE_PATH`。

---

## 6. 改动文件汇总

| 文件 | 改动类型 | 说明 |
|---|---|---|
| `pcr-ai-api/src/lib/parseAggsParam.ts` | **新建** | aggs 参数解析与验证 |
| `pcr-ai-api/src/routes/infcontrolRoutes.ts` | **修改** | 新增 `/v4/combined` 路由 |
| `pcr-ai-report/src/api/paths.ts` | **修改** | 新增 `INFCONTROL_COMBINED_PATH` |
| `pcr-ai-report/src/api/types.ts` | **修改** | 新增 2 个接口 |
| `pcr-ai-report/src/reports/InfcontrolReport.tsx` | **修改** | 改 `handleQuery` |

---

## 7. 测试策略

```bash
# 后端
cd pcr-ai-api
npm run typecheck
npm test        # 现有测试全部通过；新增 parseAggsParam 单测
npm run build

# 前端
cd pcr-ai-report
npm run build
```

新增测试：
- `test/parseAggsParam.test.ts`：正常解析、默认 groupTop、超限、非法 groupTop、空 aggs
- 手动验证：InfcontrolReport 查询后 Network 面板只有 1 个 combined 请求（而非原来 6 个）

---

## 8. 不在本次范围内

- YieldMonitorReport 类似改造（后续独立任务）
- drill-down 聚合的性能优化
- MEMORY_AGG_ORACLE_MAX_ROWS 相关逻辑（本端点无此限制）
- 新增任何 UI 功能

---

*文档版本：2026-05-17。如实现与本文冲突，以源码为准并更新本文。*
