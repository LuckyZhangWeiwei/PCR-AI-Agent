# pcr-ai-api：AI Agent（Claude Code）集成指南

本文档供 **Claude Code**、Cursor Agent 或其他 HTTP 工具调用本服务时使用。所有业务接口均为 **只读 GET**，响应 **JSON**。

**配套文档（给 Agent / 维护者）**

| 文档 | 用途 |
| --- | --- |
| **本页**（`docs/AI_AGENT_API.md`） | **§0** 地图 → **§1** 集成 → **§2** 约定 → **§3** 错误 → **§4** Dummy → **§5** Claude → **§6** v1 端点 → **§7** v3 通俗 → **§8** curl → **§9** 源码 |
| [**API_V3.md**](./API_V3.md) | **`/infcontrol-layer-bins/v3`** 与 **`/yield-monitor-triggers/v3`** 的**列表**完整 SQL（与 `npm run build` 后的 `dist` 一致）；**v3 聚合** SQL 见源码 **`yieldMonitorTriggerV3Aggregate.ts`**、**`infcontrolLayerBinV3Aggregate.ts`**（层控复用 **`infcontrolLayerBinAggregate.ts`**）。更新：`npm run docs:api-v3` |
| **`docs/JBStart.xlsx`**、**`docs/delta-diff.xlsx`** | 层控 / 产量样例行，便于理解库内**大小写与格式**（v3 字符串筛选为 `UPPER(TRIM)` 不区分大小写） |

## 0. 文档地图（怎么读不乱）

| 章节 | 适合谁 | 内容 |
| --- | --- | --- |
| **§1** | 首次对接 | manifest 优先、业务查询、排障、v3 SQL 文档入口 |
| **§2** | 所有人 | Base URL、查询键、`v3` 字符串 **`UPPER(TRIM)`**、`X-Request-Id`、`meta` |
| **§3** | 排障 | 错误 JSON 形状与常见 `code` |
| **§4** | 本地 / 无库 / 发布对照 | **Dummy 唯一权威说明**（含 v3、**`dist` / production**、**`NODE_ENV=test`**） |
| **§5** | Claude Code | 可贴系统提示的要点清单 |
| **§6** | 查 v1 与健康端点 | **非 v3**：health、manifest、ping、层控 v1、层控 BIN 聚合 v1、产量 v1、table-rows、废弃说明 |
| **§7** | 理解 v3 | 列表 vs 聚合；**§7.6 / §7.7** 为两个 **v3 聚合**的通俗说明与传参示例；**URL / curl** 见 **§8**；**列表 SQL** 见 **API_V3.md** |
| **§8** | 复制粘贴 | **`{baseUrl}`** 示例、一览表、各路径 **HTTP + curl**（语义细节回链 **§6** / **§7**） |
| **§9** | 改代码 | 源码路径索引 |

**选用哪条 HTTP？** 见 **§6.0** 表（层控 / 产量、列表 / 聚合、v1 / v2 / v3 对照）。

## 1. 推荐集成方式

1. **先拉取机器可读目录**：`GET {baseUrl}/api/v1/manifest`  
   服务端用同一数据源维护端点说明（见仓库 `src/lib/apiManifest.ts`）。Agent 应用该 JSON 做工具发现与 prompt 锚定。
2. **业务查询**：根据 manifest 中的 `path`、`queryParameters`、`example` 构造 URL；需要可复制运行的完整 URL、curl 时见 **§8**。
3. **排障**：失败时读取 HTTP 状态码与 JSON body 的 `code` / `detail`（**§3**）；需要链路追踪时带上 `X-Request-Id`。
4. **核对 v3 SQL**：列表 SQL 见 **`docs/API_V3.md`**（或 `npm run docs:api-v3`）；聚合 SQL 见 **§9** 表中 **`yieldMonitorTriggerV3Aggregate.ts`**、**`infcontrolLayerBinV3Aggregate.ts`**。

**推荐调用顺序（与 manifest 一致）**

1. `GET /api/v1/manifest` 取 `path`、`queryParameters`、`example`。
2. 按 **§6.0** 选端点；**v3** 先读 **§7** 再调 **§8** 的示例 URL。
3. 构造 query 时用 **`encodeURIComponent`**，避免 **`&`**、**`+`**、空格破坏 URL。
4. 可选：`X-Request-Id: <uuid>`，与 **`meta.requestId`** 对齐日志。

## 2. 基础约定

| 项 | 说明 |
| --- | --- |
| **Base URL** | 部署地址根路径，例如 `http://localhost:30008`（未设置 `PORT` 时默认端口见 `src/server.ts`；也可用环境变量 `PORT` 覆盖） |
| **前缀** | 业务 API 均在 `/api/v1` 下 |
| **方法** | 仅 `GET`（除进程存活检测外） |
| **查询键** | **不区分大小写**（如 `device`、`Device`、`LIMIT` 与 `limit` 等价） |
| **v3 字符串筛选值** | 路径 **`/infcontrol-layer-bins/v3`**、**`/yield-monitor-triggers/v3`** 中，字符串列与入参按 **`UPPER(TRIM(列)) = UPPER(:bind)`** 比较，**不区分大小写**；**v1 / v2 列表**仍为库端原样比较（区分大小写），见 **§6**、**§7** |
| **Content-Type** | 成功响应 `application/json` |
| **数据库** | Oracle；部分端点走主连接池，产量监控触发器走 probeweb 连接池 |

### 2.1 追踪头 `X-Request-Id`

- 请求可带：`X-Request-Id: <任意字符串>`（建议使用 UUID）。
- 响应会回显同一值；若未提供，服务端生成 UUID。
- 成功 JSON 中 `meta.requestId` 与响应头一致，便于日志对齐。

### 2.2 成功响应中的 `meta`

多数 JSON 成功体会包含：

```json
{ "meta": { "apiVersion": "1", "requestId": "..." } }
```

## 3. 错误响应约定

HTTP 状态码表示大类；body 统一形状：

```json
{
  "error": "人类可读说明",
  "code": "机器稳定枚举",
  "detail": "可选：额外上下文（如校验提示、Oracle 驱动提示）"
}
```

常见 `code`：

| code | 典型 HTTP | 含义 |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | 查询参数或表名不合法 |
| `ORACLE_QUERY_FAILED` | 500 | Oracle 执行失败 |
| `ORACLE_PING_FAILED` | 500 | ping 失败 |
| `NOT_FOUND` | 404 | 路径不存在 |
| `INTERNAL_ERROR` | 500 | 未捕获异常 |
| `REQUEST_ERROR` | 4xx | 其他请求错误 |

Oracle 驱动错误（如 NJS-116）可能在 `detail` 中含 **Instant Client / Thick 模式** 部署提示。无 Oracle 时可开 **§4** Dummy 或配置 **`ORACLE_INSTANT_CLIENT_LIB_DIR`**（见 `.env.example`）。

## 4. Dummy 与 Oracle（环境与排障）

本节为 **Dummy 行为的唯一权威说明**；**§8** 中各 curl 小节不再重复。

以下环境变量为 **`1` / `true` / `yes`**（大小写不敏感）时，对应端点可返回**内存样本**（**不连库**）；成功响应 JSON **形状与真库路径一致**（详见 `.env.example`）：

| 变量 | 影响的端点（摘要） |
| --- | --- |
| `NODE_ENV=test` | 层控 / 产量 **v1 列表** dummy 均启用（无需再设下列变量） |
| `YIELD_MONITOR_TRIGGERS_DUMMY=true` | **`/api/v1/yield-monitor-triggers`** |
| `INFCONTROL_LAYER_BINS_DUMMY=true` | **`/api/v1/infcontrol-layer-bins`**、**`/infcontrol-layer-bins/aggregate`** |

**v3 四条路径**（**`/infcontrol-layer-bins/v3`**、**`/infcontrol-layer-bins/v3/aggregate`**、**`/yield-monitor-triggers/v3`**、**`/yield-monitor-triggers/v3/aggregate`**）：在对应 **`INFCONTROL_LAYER_BINS_DUMMY` / `YIELD_MONITOR_TRIGGERS_DUMMY`** 为真、且进程**非** `npm run build` 的 **`dist`**、且 **`NODE_ENV`≠`production`** 时，与上表一样走 **Excel 内存样本**（**`JBStart.xlsx`** / **`delta-diff.xlsx`**）；**`dist` 或 production** 下 **Dummy 关闭**，恒走 Oracle（见 **`src/lib/listDummyRuntime.ts`**）。

Dummy 下 **`includeProbeCardSummary`** 行为与真库一致（仍为可选）。**保证有命中的示例查询串**（与 manifest `example` 同源）：层控 **`INFCONTROL_DUMMY_EXAMPLE_QUERY`**（`infcontrolLayerBinDummy.ts`）；产量 **`YIELD_MONITOR_DUMMY_EXAMPLE_QUERY`**（`yieldMonitorTriggerDummy.ts`）。

## 5. Claude Code 使用建议

以下为可直接贴入 **系统提示**或团队模板的要点（与 manifest 一致）。本包根目录另有简短 **[`CLAUDE.md`](../CLAUDE.md)** 供 Claude Code 自动加载。

1. **Base URL 与发现**：写明部署根地址；要求 **首次会话先** `GET /api/v1/manifest`，用返回的 `path`、`queryParameters`、`example` 生成工具或构造 URL。
2. **只读与安全**：所有业务接口为 **GET**、只读；无 offset 分页，通过 **更窄的筛选 / 时间窗** 控制结果体量。
3. **工具封装**：每个 manifest `path` 对应一个 GET 工具；query 用对象序列化（键名大小写不敏感，建议 **camelCase** 与 manifest 一致）。
4. **时间参数**：统一 **ISO 8601**（建议 UTC，后缀 `Z`），见各端点 `timeStamp*` / `testEnd*` 说明。
5. **行数上限**：v1 产量 / 层控列表多为固定 **200**；**v2 层控列表**与 **两条 v3 列表** 支持 **`limit`**（默认 **200**，最大 **500**）。无 offset；勿假设分页游标。
6. **v3 何时用**：需要 **`meta.apiVersion":"3"`**、固定 **`FETCH FIRST :lim`**、或 **Dummy 联调**（见 **§4**）时，用 **`/infcontrol-layer-bins/v3`**、**`/yield-monitor-triggers/v3`**；需要 **全量 `GROUP BY` / BIN SUM** 时用 **`…/v3/aggregate`**（见 **§7**）。**`dist` 或 production** 下 v3 恒走 Oracle。需要 **v2 行形状**且可接受 v2 Dummy 时仍用 **`/infcontrol-layer-bins/v2`**。
7. **v3 大小写**：v3 字符串筛选 **值** 与库列 **`UPPER(TRIM)`** 比较（不区分大小写）；样例行见 **`docs/JBStart.xlsx`**、**`docs/delta-diff.xlsx`**。v1/v2 列表字符串仍 **区分大小写**。
8. **SQL 与排障**：v3 **列表** SQL 见 **`docs/API_V3.md`**（改 `apiV3ListSql.ts` 后 **`npm run docs:api-v3`**）。**v3 聚合** SQL 见 **`yieldMonitorTriggerV3Aggregate.ts`**、**`infcontrolLayerBinV3Aggregate.ts`**。Oracle 报错见 body `detail`。
9. **层控 BIN 聚合**：`/infcontrol-layer-bins/aggregate` 与 v1 列表 **同一套筛选**；省略 **`groupBy`** 时默认按 **BIN 列合计**取 Top N（**§6.5**）。**`/yield-monitor-triggers/aggregate`** 仍废弃（**§6.8**）。
10. **幂等与缓存**：全部为 GET，可安全重试；可按 `filters` + URL 做短期缓存以降低数据库负载。

## 6. 业务端点（v1 与健康）

**v3**：通俗与参数表见 **§7**；列表 SQL 见 [**API_V3.md**](./API_V3.md)；curl 见 **§8**；Dummy 见 **§4**。

### 6.0 产量监控与层控：列表与 BIN 聚合如何选用

| 场景 | 端点 | 说明 |
| --- | --- | --- |
| 产量监控触发器明细（按时间） | `GET /api/v1/yield-monitor-triggers` | 最多 **200** 条，`TIME_STAMP` **降序**；可选 **`probeCardSummary`**（全量筛选下按 PROBECARD 计数降序）。详见 **§6.6**。 |
| 产量监控 v3（全列、`FETCH FIRST`） | `GET /api/v1/yield-monitor-triggers/v3` | **`meta.apiVersion":"3"`**；见 **§7**。 |
| 产量监控 v3 **聚合** | `GET /api/v1/yield-monitor-triggers/v3/aggregate` | **必填 `dimensions`**；见 **§7**。 |
| 层控 / BIN **明细行** | `GET /api/v1/infcontrol-layer-bins` | 最多 **200** 条，`TESTEND` **降序**。详见 **§6.4**。 |
| 层控 v2 明细（`bins[]`、`limit`≤500） | `GET /api/v1/infcontrol-layer-bins/v2` | 与 v1 类似筛选；Dummy 见 **§4**。 |
| 层控 v3 | `GET /api/v1/infcontrol-layer-bins/v3` | 与 v2 同行形状、字符串 **`UPPER(TRIM)`**；见 **§7**。 |
| 层控 v3 **BIN 聚合** | `GET /api/v1/infcontrol-layer-bins/v3/aggregate` | **`groupBy`** 须含 **`bin`**；见 **§7**。 |
| 层控 v1：**筛选后哪些 BIN 合计最多** | `GET /api/v1/infcontrol-layer-bins/aggregate` | 与 v1 列表 **同一套筛选**；**`groups[].count`** 为 **SUM**。详见 **§6.5**。 |

产量废弃 HTTP 聚合见 **§6.8**；**PROBECARD** 频次见 **§6.6** 的 **`probeCardSummary`**。

### 6.1 `GET /health`

- **用途**：进程存活，**不访问数据库**。
- **响应示例**：`{ "status": "ok", "service": "pcr-ai-api" }`

### 6.2 `GET /api/v1/manifest`

- **用途**：返回完整 API 目录（端点、查询参数、示例、错误形状、追踪说明）。
- **用途**：Agent 首次连接或版本校验时应调用；也可用于生成 OpenAPI/工具 schema。

### 6.3 `GET /api/v1/db/ping`

- **用途**：主 Oracle 连接池健康检查，`SELECT 1 FROM DUAL`。
- **成功**：`{ "meta": {...}, "ok": true, "dual": { ... } }`
- **失败**：Oracle 不可用时返回 500，body 见 **§3**。

### 6.4 `GET /api/v1/infcontrol-layer-bins`

- **数据**：`INFCONTROL` 与 `INFLAYERBINLIST` 按 `KEYNUMBER` 关联；条件之间为 **AND**。
- **上限**：固定最多 **200** 行。
- **排序**：**`TESTEND` 降序**（新于旧）；**`TESTEND` 相同**时按 **`KEYNUMBER` 降序**。响应 `orderBy` 字段与之一致。
- **查询参数**（均可选）：完整列表以 manifest 为准，主要包括：
  - 通用：`keynumber`
  - INFCONTROL：`device`, `lot`, `slot`, `pdpw`, `meslot`
  - INFLAYERBINLIST：`testerId`, `tstype`, `cardId`, `pibId`, `probe`, `grossDie`, `passId`, `sessionNumber`, `passNum`, `layerName`, `passResume`, `passResult`, `passType`, `passBin`
  - 时间（**ISO 8601**）：`testStartFrom` / `testStartTo`，`testEndFrom` / `testEndTo`
  - BIN：`bin0` … `bin255`，值为 **逗号分隔整数**，表示对应 BIN 列 `IN (...)`，例如 `bin5=1,3,5`
- **响应字段**：`limit`（恒为 200）、`orderBy`、`filters`（实际生效的筛选）、`count`、`rows`（行对象；Oracle 列名通常为 **大写**，但 **`BIN0`…`BIN255` 不单独占顶层字段**）。内部排序用的 `RNUM` 不会出现在 `rows` 中。**不返回** `PASSBINTABLE`、`INKBINTABLE`。**筛选无命中时仍为 HTTP 200**，**`count` 为 0**、**`rows` 为 `[]`**。
- **PASSBIN 与 bins**：若 **`PASSBIN`** 为 **`N-M`**（减号分隔，如 **`1-55`**），则 **`N`**、**`M`** 即字符串两侧的**两个整数**（例：**1** 与 **55**）。响应 **`passBinPair`**：**`[N, M]`** 或 **`null`**（无法解析时）。**`bins[k].isGood`**：**恒为 `false`**（产品决策：不在接口输出 PASSBIN「两端 good bin」语义）。**`bins`**：键为 **`"0"`…`"255"`**，值为 **`{ value, isGood }`**（仅 **非 null 且非 0** 的 BIN 有条目）。若无任何非零 BIN，**`bins`** 为 **`{}`**。

**示例 URL：**

```http
GET /api/v1/infcontrol-layer-bins?device=WA00P69K&lot=DR39000.1N&slot=1&tstype=CP&cardId=9400-01&testEndFrom=2026-01-01T00:00:00.000Z&testEndTo=2026-01-31T23:59:59.999Z
```

（**Dummy** 模式下上述组合 **必有命中行**，与 `INFCONTROL_DUMMY_EXAMPLE_QUERY` / manifest `example` 一致；自编参数无命中时仍返回 **200**，**`count`** 为 **0**。）

### 6.5 `GET /api/v1/infcontrol-layer-bins/aggregate`（BIN 合计 Top N）

- **与列表 `bins.isGood` 无关**：聚合对**所有** BIN 列数值求和、排名；列表 **`isGood`** 恒为 false（**§6.4**）。
- **典型流程**：先用与 **§6.4** **完全相同**的查询参数做 **AND 筛选**（如 `device`、`lot`、`slot`、`tstype`、`cardId`；`testEndFrom` / `testEndTo` 约束 **TESTEND** 等），在匹配到的**全部明细行**上，对 **BIN0…BIN255** 各列做 **UNPIVOT 后按组 SUM**，再取 **合计最大的 `groupTop` 个 BIN**（或复合分组，见下）。
- **`groupBy`**：**可省略** — 省略时视为 **`bin`**，即只按「第几个 BIN 列」排名（最符合「筛完看谁 bin(n) 最多」）。若传入，须**恰好包含一次** `bin`，并可与 `device`、`lot`、`slot`、`tstype`、`cardId` 等行级维度逗号复合（见 manifest）。
- **`groupTop`**：返回几组，默认 **10**，最大 **50**。
- **响应**：`groupBy`、`groupTop`、`totalRowsMatching`（筛选后的行数）、`groups[]`（每项 `count` 为该组 **SUM(BIN 单元格)**，**`parts.bin`** 为下标 `"0"`…`"255"`；展示请优先用 **`parts`**）。某 **BIN(n)** 在筛选结果中**始终为 NULL** 时**不会出现**在 `groups` 中（与 Oracle `UNPIVOT EXCLUDE NULLS` / dummy 跳过 null 一致）。**无明细或无聚合分组时仍为 HTTP 200**（**`totalRowsMatching`** 为 **0** 或 **`groups`** 为 **`[]`**）。

**示例（只筛条件、默认按 BIN 取 Top 10）：**

```http
GET /api/v1/infcontrol-layer-bins/aggregate?device=WA00P69K&lot=DR39000.1N&slot=1&tstype=CP&cardId=9400-01&testEndFrom=2026-01-01T00:00:00.000Z&testEndTo=2026-01-31T23:59:59.999Z&groupTop=10
```

### 6.6 `GET /api/v1/yield-monitor-triggers`

- **数据**：表 `YMWEB_YIELDMONITORTRIGGER`（probeweb 账号）。
- **上限**：最多 **200** 行。
- **排序**：`TIME_STAMP DESC NULLS LAST`。
- **查询参数**（均可选）：`hostname`, `device`, `lotId`, `wafer`, `type`, `triggerLabel`, `probeCard`, `pass`, `id`，以及时间 `timeStampFrom` / `timeStampTo`（**ISO 8601**）；`includeProbeCardSummary`（默认 **true**，传 `false` / `0` / `no` 可省略服务端对 PROBECARD 的二次聚合）。
- **响应**：`limit`、`orderBy`、`filters`、`count`、`rows`；在默认开启聚合时另有 **`probeCardSummary`**（按 **同一套筛选** 对**全量匹配行**按 `PROBECARD` 分组计数，按次数从高到低）与 **`probeCardSummaryOrderBy`**。**无命中时仍为 HTTP 200**，**`count` 为 0**、**`rows` 为 `[]`**（若开启 **`probeCardSummary`**，可能为空数组）。

**示例 URL：**

```http
GET /api/v1/yield-monitor-triggers?device=D1&timeStampFrom=2026-01-01T00:00:00.000Z
```

（**Dummy** 下 **必有命中行**（含 `DEVICE=D1` 的锚点行）；常量 **`YIELD_MONITOR_DUMMY_EXAMPLE_QUERY`** 与 manifest `example` 一致。）

### 6.7 `GET /api/v1/table-rows`

- **用途**：开发/探测用——按 ROWNUM 读取某表前 N 行（兼容旧版 Oracle）。
- **查询参数**：
  - `table`：可选；格式为 `TABLE` 或 `OWNER.TABLE`。未传时使用环境变量 `ORACLE_DEFAULT_TABLE`。
  - `limit`：可选；默认 **50**，最大 **500**。
- **响应**：`meta`、`table`（解析后的限定名）、`limit`、`rows`（含 `rnum` 等）。

仅在明确允许访问的模式下使用；生产 Agent 应优先使用专用业务端点。

### 6.8 已废弃：`GET /api/v1/yield-monitor-triggers/aggregate`

该路径 **未挂载**（访问 **404**）。产量监控需要 **按维度全量计数** 时，请使用 **`/yield-monitor-triggers/v3/aggregate`**（见 **§7**）；需要 **PROBECARD 分布**且可接受 v1 列表行为时，仍可用 **§6.6** 的 **`probeCardSummary`**。实现模块仍保留在 `yieldMonitorTriggerAggregate.ts` 等；**manifest** 的 **`deprecatedEndpoints`** 中有说明。

层控 BIN 聚合：v1 用 **§6.5**；**v3 筛选** 用 **`/infcontrol-layer-bins/v3/aggregate`**（**§7**）；Dummy 见 **§4**。

## 7. v3 API（通俗说明；与 §8 对照阅读）

本节说明 **四条 v3 路径**在业务上解决什么问题；**两个聚合**的详细通俗说明与传参示例见 **§7.6**、**§7.7**。**每条路径的查询键、示例 URL、cURL** 集中在 **§8.4.1**、**§8.4.2**、**§8.6.1**、**§8.6.2**；**列表 SQL** 见 [**API_V3.md**](./API_V3.md)；**Dummy / `dist` / production** 见 **§4**；字段级权威定义仍以 **`GET /api/v1/manifest`** 为准。

### 7.1 v3 是什么（与 v1/v2 的差别）

- 成功响应 **`meta.apiVersion` 为 `"3"`**。
- **层控 + 层 BIN**：`INFCONTROL` ⋈ `INFLAYERBINLIST`（`KEYNUMBER`），且 **`PASSTYPE='TEST'`**；主库 Oracle（Dummy 时 **JBStart** 样本，**§4**）。
- **产量触发器**：表 **`YMWEB_YIELDMONITORTRIGGER`**，v3 列表为 **`SELECT *`**；probeweb（Dummy 时 **delta-diff** 样本，**§4**）。
- **调用侧牢记**：(1) 字符串筛选 **`UPPER(TRIM)`** 不区分大小写；(2) 列表用 **`FETCH FIRST :lim`**；(3) 全量统计必须用 **`…/v3/aggregate`**，勿用 **`limit`** 代替。

### 7.2 列表与聚合差在哪

| 类型 | 行为 | 类比 |
| --- | --- | --- |
| **v3 列表** | 筛选 → 排序 → 最多 **500** 条明细 | 账本里按时间只复印最新 N 页 |
| **v3 聚合** | **同一筛选** 下对**全部匹配行**汇总（层控 **SUM(BIN)**；产量 **COUNT**） | 把符合条件页全部统计 |

### 7.3 推荐步骤

1. **`GET /api/v1/manifest`**。2. 用 **§6.0** 选路径。3. **`encodeURIComponent`** 拼 URL。4. 可选 **`X-Request-Id`**。5. 读 **`rows`** / **`groups`** / **`totalRowsMatching`**。6. 无数据多为 **HTTP 200**、空数组。

### 7.4 层控 v3 在答什么

**`/infcontrol-layer-bins/v3`**：与 v2 同行形状（**`bins`** enrich），适合明细。**`/infcontrol-layer-bins/v3/aggregate`**：与列表同一套 **WHERE**，对全量行 **UNPIVOT + SUM**；**`groupBy`** 须**恰好含一个 `bin`**。与 v1 **`/infcontrol-layer-bins/aggregate`** 的筛选/大小写规则不同，勿混用。

### 7.5 产量 v3 在答什么

**`/yield-monitor-triggers/v3`**：全列、时间降序、**`FETCH FIRST`**。**`/yield-monitor-triggers/v3/aggregate`**：**必填 `dimensions`**（1–5 维），**`timeDay`** 与 **`timeHour`** 勿同现。

### 7.6 `GET /api/v1/infcontrol-layer-bins/v3/aggregate`：作用、通俗理解、传参示例

**作用（官方一句话）**：与 **`/infcontrol-layer-bins/v3` 列表**使用**同一套筛选**（`PASSTYPE='TEST'` + v3 的 AND；字符串 **`UPPER(TRIM)`**），在**全部匹配明细行**上把 **BIN0…BIN255** 先 **UNPIVOT** 再按 **`groupBy`** 维度 **SUM**，按合计降序取前 **`groupTop`** 组。响应里的 **`groups[].count`** 是 **SUM（die 累计）**，不是行数；**`totalRowsMatching`** 是满足筛选的**明细行数**。

**通俗理解**：先把「某 device / lot / 时间窗里所有层测行」圈出来，再把每一行里各个 BIN 列上的数字拆平后加总，最后回答「**哪一个（或哪一组 device+BIN）合计 die 最多**」。若只关心「哪个 BIN 号全库合计最高」，用 **`groupBy=bin`**（或省略 **`groupBy`**，与 v1 聚合一样默认按 BIN）；若关心「**每个 device 各自**哪些 BIN 最高」，用 **`groupBy=device,bin`**。

**聚合专用参数**

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| **`groupBy`** | 否 | 逗号分隔，**须恰好出现一次** **`bin`**。可**整体省略**，省略时服务端等价 **`bin`**。可与 **`device`**、**`lot`**、**`slot`**、**`tstype`**、**`cardId`**、**`testerId`** 等复合（与 v1 **`/infcontrol-layer-bins/aggregate`** 规则一致，最多 8 维；详见 manifest）。 |
| **`groupTop`** | 否 | 返回多少组，默认 **10**，最大 **50**。 |

**与列表相同的筛选（节选）**：**`device`**、**`lot`**、**`slot`**、**`meslot`**、**`testerId`**、**`tstype`**、**`cardId`**、**`passId`**；**`testEndBegin` / `testEndEnd`**（或 **`testEndFrom` / `testEndTo`**）；**`testStart*`** 等同理。全部 **AND**；时间用 **ISO 8601**（建议 UTC + **`Z`**）。

**传参示例**

1. **默认：只按 BIN 排名**（不写 **`groupBy`** 或写 **`groupBy=bin`**），看这一批料里 BIN 合计 Top 10：

```http
GET /api/v1/infcontrol-layer-bins/v3/aggregate?device=WB10N57U&testEndBegin=2026-05-13T00:00:00.000Z&testEndEnd=2026-05-13T23:59:59.999Z&groupTop=10
```

2. **复合维度**：按 **device + BIN** 看「每个料号下各 BIN 合计」，仍取合计最高的 5 组：

```http
GET /api/v1/infcontrol-layer-bins/v3/aggregate?device=WB10N57U&testEndBegin=2026-05-13T00:00:00.000Z&testEndEnd=2026-05-13T23:59:59.999Z&groupBy=device,bin&groupTop=5
```

3. **更窄圈选**：叠加 **lot / slot / tstype / cardId**（与 v3 列表相同键名），再按 BIN Top 10：

```http
GET /api/v1/infcontrol-layer-bins/v3/aggregate?device=WB10N57U&lot=NF12615.1X&slot=1&tstype=CP&cardId=9400-01&testEndBegin=2026-05-13T00:00:00.000Z&testEndEnd=2026-05-13T23:59:59.999Z&groupBy=bin&groupTop=10
```

更多 **HTTP / curl** 见 **§8.4.2**。

### 7.7 `GET /api/v1/yield-monitor-triggers/v3/aggregate`：作用、通俗理解、传参示例

**作用**：与 **`/yield-monitor-triggers/v3` 列表**使用**同一套 WHERE**（字符串 **`UPPER(TRIM)`**、**`timeStampBegin`/`End`** 或 **`From`/`To`** 等），在**全部匹配行**上做 **`COUNT(*)`** + **`GROUP BY dimensions`**，按计数降序取前 **`groupTop`** 组。响应 **`groups[].count`** 为**该维度组合下的触发条数**；**`totalRowsMatching`** 为筛选后的**总行数**。

**通俗理解**：先在「某段时间、某台机台 / 某类 type」里圈出所有触发记录，再按你选的 **`dimensions`** 做「**每个桶里有多少条**」——例如 **`type,device`** 看各类型在各料号上各触发多少次；**`timeDay`** 看**自然日**趋势；**`hostname`** 看哪台机触发最多。

**聚合专用参数**

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| **`dimensions`** | **是** | 逗号分隔 **1–5** 项。允许取值：`type`、`device`、`hostname`、`lotId`、`wafer`、`probeCard`、`pass`、`triggerLabel`、**`timeDay`**（按日历日）、**`timeHour`**（按整点）。**`timeDay` 与 `timeHour` 不得同时出现**。 |
| **`groupTop`** | 否 | 返回多少组，默认 **25**，最大 **100**。 |

**与列表相同的筛选（节选）**：**`hostname`**、**`device`**、**`lotId`**、**`wafer`**、**`type`**、**`probeCard`**、**`pass`**；**`timeStampBegin` / `timeStampEnd`**（或 **`timeStampFrom` / `timeStampTo`**）。全部 **AND**。

**传参示例**

1. **按异常类型 + 料号**看分布（同一天 UTC 窗）：

```http
GET /api/v1/yield-monitor-triggers/v3/aggregate?dimensions=type,device&timeStampBegin=2026-05-13T00:00:00.000Z&timeStampEnd=2026-05-13T23:59:59.999Z&groupTop=20
```

2. **按机台**看谁触发最多：

```http
GET /api/v1/yield-monitor-triggers/v3/aggregate?dimensions=hostname&timeStampBegin=2026-05-13T00:00:00.000Z&timeStampEnd=2026-05-13T23:59:59.999Z&groupTop=15
```

3. **按自然日**看趋势（不要与 **`timeHour`** 同用）：

```http
GET /api/v1/yield-monitor-triggers/v3/aggregate?dimensions=timeDay,type&device=WA03P02G&timeStampBegin=2026-05-01T00:00:00.000Z&timeStampEnd=2026-05-31T23:59:59.999Z&groupTop=30
```

4. **先收窄再聚合**：例如只要某 **lotId** 下各 **type** 计数：

```http
GET /api/v1/yield-monitor-triggers/v3/aggregate?dimensions=type&lotId=DR31388.1N&timeStampBegin=2026-01-01T00:00:00.000Z&timeStampEnd=2026-01-31T23:59:59.999Z&groupTop=10
```

更多 **HTTP / curl** 见 **§8.6.2**。

### 7.8 文档与源码分工

- **`docs/API_V3.md`**：v3 **列表** SQL（`npm run docs:api-v3` 再生）。
- **聚合**：**`yieldMonitorTriggerV3Aggregate.ts`**、**`infcontrolLayerBinV3Aggregate.ts`**（UNPIVOT 复用 **`infcontrolLayerBinAggregate.ts`**）。

---

## 8. URL 与 curl 快速参考

以下为 **`{baseUrl}`** 下可直接复制的 **HTTP** 与 **curl**；各路径的**业务语义、筛选含义、响应字段**见 **§6**（v1）或 **§7**（v3）。**Dummy** 一律以 **§4** 为准。

**`{baseUrl}`** 示例默认为 `http://localhost:30008`，部署时请替换。所有路径均为 **GET**；查询参数键名 **大小写不敏感**。

**Postman**：地址栏只填 `http://...`，不要写 `GET http://...`。**curl / PowerShell**：整条命令可复制运行。

### 8.1 一览表

| # | 路径 | 用途 | 查询参数 |
| --- | --- | --- | --- |
| 1 | `/health` | 进程存活，不连库 | 无 |
| 2 | `/api/v1/manifest` | 机器可读 API 目录 | 无 |
| 3 | `/api/v1/db/ping` | 主 Oracle：`SELECT 1 FROM DUAL` | 无 |
| 4 | `/api/v1/infcontrol-layer-bins` | 层控 ⋈ 层 BIN 明细，最多 200 行 | 见 §8.4 |
| 5 | `/api/v1/infcontrol-layer-bins/aggregate` | 同上筛选 + BIN 列 SUM，Top N 组 | **groupBy**、**groupTop** + 与 §8.4 相同筛选 |
| 6 | `/api/v1/yield-monitor-triggers` | 产量监控触发器，最多 200 行 | 见 §8.6 |
| 7 | `/api/v1/infcontrol-layer-bins/v3` | v3：固定 SQL + 筛选，主库 | 见 §8.4.1 |
| 8 | `/api/v1/infcontrol-layer-bins/v3/aggregate` | v3：同筛选下 BIN 全量聚合 | **groupBy**、**groupTop** + §8.4.1 同款筛选；见 §8.4.2 |
| 9 | `/api/v1/yield-monitor-triggers/v3` | v3：全表 + 筛选，probeweb | 见 §8.6.1 |
| 10 | `/api/v1/yield-monitor-triggers/v3/aggregate` | v3：同筛选下 `COUNT` 聚合 | **dimensions**、**groupTop** + §8.6.1 同款筛选；见 §8.6.2 |
| 11 | `/api/v1/table-rows` | 开发用：表前 N 行 | **table**、**limit** |

已移除路由（勿调用）：`GET /api/v1/yield-monitor-triggers/aggregate`（见 manifest **`deprecatedEndpoints`**）。

---

### 8.2 `GET /health`

| 项 | 说明 |
| --- | --- |
| **用途** | 负载均衡 / 探活；**不访问 Oracle**。 |
| **查询参数** | 无 |
| **成功响应** | `{"status":"ok","service":"pcr-ai-api"}` |

```http
GET {baseUrl}/health
```

```bash
curl -sS "{baseUrl}/health"
```

```powershell
Invoke-RestMethod -Uri "{baseUrl}/health"
```

---

### 8.3 `GET /api/v1/manifest`

| 项 | 说明 |
| --- | --- |
| **用途** | 返回 **`endpoints`**（path、queryParameters、example）、**`deprecatedEndpoints`**、**`errorShape`**、**`tracing`**；Agent 工具发现与版本对齐。 |
| **查询参数** | 无 |

```http
GET {baseUrl}/api/v1/manifest
```

```bash
curl -sS "{baseUrl}/api/v1/manifest"
```

---

### 8.4 `GET /api/v1/infcontrol-layer-bins`

**筛选**：条件之间 **AND**；均为可选。

| 参数 | 类型 | 含义 |
| --- | --- | --- |
| `keynumber` | 数字 | `KEYNUMBER` |
| `device`, `lot`, `slot`, `pdpw`, `meslot` | 字符串/数字 | INFCONTROL 列 |
| `testerId`, `tstype`, `cardId`, `pibId`, `probe`, `grossDie`, `passId`, `sessionNumber`, `passNum`, `layerName`, `passResume`, `passResult`, `passType`, `passBin` | 各类 | INFLAYERBINLIST 列 |
| `testStartFrom`, `testStartTo`, `testEndFrom`, `testEndTo` | ISO 8601 | `TESTSTART` / `TESTEND` 闭区间侧 |
| `bin0` … `bin255` | 逗号分隔整数 | 对应 **`BINk`** 列 `IN (...)`，如 `bin5=1,3,5` |

**响应**：**`limit`**（200）、**`orderBy`**、**`filters`**、**`count`**、**`rows`**；每行含 **`passBinPair`**、**`bins`**（见 **§6.4**）。无命中：**HTTP 200**，**`count`: 0**。

**Dummy 保证有数据的示例**（与 **`INFCONTROL_DUMMY_EXAMPLE_QUERY`** / manifest **example** 一致）：

```http
GET {baseUrl}/api/v1/infcontrol-layer-bins?device=WA00P69K&lot=DR39000.1N&slot=1&tstype=CP&cardId=9400-01&testEndFrom=2026-01-01T00:00:00.000Z&testEndTo=2026-01-31T23:59:59.999Z
```

**最小示例**（仅 device + 时间一端，可按库调整）：

```http
GET {baseUrl}/api/v1/infcontrol-layer-bins?device=WA00P69K&testEndFrom=2026-01-01T00:00:00.000Z
```

```bash
curl -sS -H "X-Request-Id: trace-1" \
  "{baseUrl}/api/v1/infcontrol-layer-bins?device=WA00P69K&lot=DR39000.1N&slot=1&tstype=CP&cardId=9400-01&testEndFrom=2026-01-01T00:00:00.000Z&testEndTo=2026-01-31T23:59:59.999Z"
```

---

### 8.4.1 `GET /api/v1/infcontrol-layer-bins/v3`（v3）

**说明**：与 **§7** 层控 v3 说明一致；**数据源与 Dummy** 见 **§4**。查询键名与字符串筛选值均**不区分大小写**（`UPPER(TRIM)`）。完整 **SQL 模板与 BIN 展开**见 [**API_V3.md**](./API_V3.md) 与 **`src/lib/apiV3ListSql.ts`**。

| 参数 | 含义 |
| --- | --- |
| `limit` | 默认 **200**，最大 **500**（参数名 **`Limit` / `LIMIT`** 等亦可） |
| `device`, `lot`, `slot`, `meslot`, `testerId`, `tstype`, `cardId`, `passId` | 见 **§7** 与 **API_V3.md** 层控 v3 表 |
| `testStartBegin` / `testStartEnd`（或 `testStartFrom` / `testStartTo`） | **TESTSTART** 时间窗 |
| `testEndBegin` / `testEndEnd`（或 `testEndFrom` / `testEndTo`） | **TESTEND** 时间窗 |

```http
GET {baseUrl}/api/v1/infcontrol-layer-bins/v3?device=WB10N57U&lot=NF12615.1X&testEndBegin=2026-05-13T00:00:00.000Z&testEndEnd=2026-05-13T23:59:59.999Z&limit=200
```

```bash
curl -sS "{baseUrl}/api/v1/infcontrol-layer-bins/v3?device=WB10N57U&limit=200"
```

---

### 8.4.2 `GET /api/v1/infcontrol-layer-bins/v3/aggregate`（v3 · 聚合）

**说明**：与 **§7.6**（作用、通俗、传参示例）一致；**`documentation`** 为固定中文说明。筛选参数与 **§8.4.1** 相同，另须 **`groupBy`**（须含 **`bin`** 一次）、**`groupTop`**。

```http
GET {baseUrl}/api/v1/infcontrol-layer-bins/v3/aggregate?device=WB10N57U&testEndBegin=2026-05-13T00:00:00.000Z&testEndEnd=2026-05-13T23:59:59.999Z&groupBy=bin&groupTop=10
```

```bash
curl -sS "{baseUrl}/api/v1/infcontrol-layer-bins/v3/aggregate?device=WB10N57U&groupBy=device,bin&groupTop=5&testEndBegin=2026-05-13T00:00:00.000Z&testEndEnd=2026-05-13T23:59:59.999Z"
```

---

### 8.5 `GET /api/v1/infcontrol-layer-bins/aggregate`

在 §8.4 **同一套筛选**上，对 BIN0…BIN255 **UNPIVOT 后 SUM**，按合计取 Top **`groupTop`**（默认 **10**，最大 **50**）。

| 参数 | 说明 |
| --- | --- |
| `groupBy` | **可选**。省略等价 **`bin`**。传入时为逗号分隔维度，**必须含一次** `bin`，如 **`device,bin`**、`testerId,cardId,lot,bin` |
| `groupTop` | 返回组数上限 |

**Dummy 示例（manifest example）**：

```http
GET {baseUrl}/api/v1/infcontrol-layer-bins/aggregate?device=WA00P69K&lot=DR39000.1N&slot=1&tstype=CP&cardId=9400-01&testEndFrom=2026-01-01T00:00:00.000Z&testEndTo=2026-01-31T23:59:59.999Z&groupTop=10
```

**复合分组示例**（按 device + BIN 列合计）：

```http
GET {baseUrl}/api/v1/infcontrol-layer-bins/aggregate?device=WA00P69K&groupBy=device,bin&groupTop=5&testEndFrom=2026-01-01T00:00:00.000Z&testEndTo=2026-01-31T23:59:59.999Z
```

```bash
curl -sS "{baseUrl}/api/v1/infcontrol-layer-bins/aggregate?device=WA00P69K&lot=DR39000.1N&slot=1&tstype=CP&cardId=9400-01&testEndFrom=2026-01-01T00:00:00.000Z&testEndTo=2026-01-31T23:59:59.999Z&groupTop=10"
```

---

### 8.6 `GET /api/v1/yield-monitor-triggers`

| 参数 | 含义 |
| --- | --- |
| `hostname`, `device`, `lotId`, `wafer`, `type`, `triggerLabel`, `probeCard` | 字符串全等 |
| `pass`, `id` | 数字 |
| `timeStampFrom`, `timeStampTo` | ISO 8601；若二者都有需 **from ≤ to** |
| `includeProbeCardSummary` | 默认 **true**；**false** / **0** / **no** 时不返回 **`probeCardSummary`**（少一次聚合查询） |

**Dummy 保证有数据的示例**（与 **`YIELD_MONITOR_DUMMY_EXAMPLE_QUERY`** / manifest **example** 一致）：

```http
GET {baseUrl}/api/v1/yield-monitor-triggers?device=D1&timeStampFrom=2026-01-01T00:00:00.000Z
```

**多条件 + 时间范围 + 关闭 PROBECARD 汇总**：

```http
GET {baseUrl}/api/v1/yield-monitor-triggers?hostname=b3ps1601&device=WA00P69K&lotId=DR31388.1N&timeStampFrom=2026-01-01T00:00:00.000Z&timeStampTo=2026-01-31T23:59:59.999Z&includeProbeCardSummary=false
```

```bash
curl -sS -H "X-Request-Id: trace-2" \
  "{baseUrl}/api/v1/yield-monitor-triggers?device=D1&timeStampFrom=2026-01-01T00:00:00.000Z"
```

---

### 8.6.1 `GET /api/v1/yield-monitor-triggers/v3`（v3）

**说明**：与 **§7** 产量 v3 说明一致；**数据源与 Dummy** 见 **§4**。查询键名与字符串筛选值均**不区分大小写**。SQL 模板见 [**API_V3.md**](./API_V3.md) 与 **`buildYieldMonitorTriggersV3Sql`**。

| 参数 | 含义 |
| --- | --- |
| `limit` | 默认 **200**，最大 **500**（参数名 **`Limit` / `LIMIT`** 等亦可） |
| `hostname`, `device`, `lotId`, `pass`, `wafer`, `type`, `probeCard` | 字符串列 **`UPPER(TRIM)`** 与入参比较；**`pass`** 仍为数值全等 |
| `timeStampBegin` / `timeStampEnd`（或 `timeStampFrom` / `timeStampTo`） | **TIME_STAMP** 时间窗 |

```http
GET {baseUrl}/api/v1/yield-monitor-triggers/v3?device=WA03P02G&timeStampBegin=2026-05-13T00:00:00.000Z&timeStampEnd=2026-05-13T23:59:59.999Z&limit=200
```

```bash
curl -sS "{baseUrl}/api/v1/yield-monitor-triggers/v3?limit=100"
```

---

### 8.6.2 `GET /api/v1/yield-monitor-triggers/v3/aggregate`（v3 · 聚合）

**说明**：与 **§7.7**（作用、通俗、传参示例）一致；**必填 `dimensions`**；**`documentation`** 为固定中文说明。时间窗等筛选与 **§8.6.1** 相同。

```http
GET {baseUrl}/api/v1/yield-monitor-triggers/v3/aggregate?dimensions=type,device&timeStampBegin=2026-05-13T00:00:00.000Z&timeStampEnd=2026-05-13T23:59:59.999Z&groupTop=20
```

```bash
curl -sS "{baseUrl}/api/v1/yield-monitor-triggers/v3/aggregate?dimensions=hostname&timeStampBegin=2026-05-13T00:00:00.000Z&timeStampEnd=2026-05-13T23:59:59.999Z"
```

---

### 8.7 `GET /api/v1/db/ping`

| 项 | 说明 |
| --- | --- |
| **用途** | 检查**主 Oracle 连接池**；失败时 **500**，**`code`** 常为 **`ORACLE_PING_FAILED`**。 |
| **查询参数** | 无 |

```http
GET {baseUrl}/api/v1/db/ping
```

```bash
curl -sS "{baseUrl}/api/v1/db/ping"
```

---

### 8.8 `GET /api/v1/table-rows`

| 参数 | 说明 |
| --- | --- |
| `table` | 可选；`TABLE` 或 **`OWNER.TABLE`**；不传则用环境变量 **`ORACLE_DEFAULT_TABLE`** |
| `limit` | 可选；默认 **50**，最大 **500** |

```http
GET {baseUrl}/api/v1/table-rows?table=MY_TABLE&limit=50
```

```http
GET {baseUrl}/api/v1/table-rows?table=SCHEMA.MY_TABLE&limit=100
```

```bash
curl -sS "{baseUrl}/api/v1/table-rows?limit=20"
```

---

### 8.9 Dummy 与 Oracle（已迁移）

**Dummy、v3 与 `dist` / production 的完整规则**已统一写在 **§4**。本节不再维护重复表格；排障请直接打开 **§4**。

---

## 9. 与仓库源码的对应关系

| 文档概念 | 源码位置 |
| --- | --- |
| **Claude Code 入口索引** | 仓库根 **`CLAUDE.md`**（指向本页与 `API_V3.md`） |
| 路由挂载 | `src/app.ts`：`/api/v1` → `apiRouter` |
| Manifest 内容 | `src/lib/apiManifest.ts` |
| 各 GET 实现 | `src/routes/api.ts` |
| 产量监控筛选 / Top 200 | `src/lib/yieldMonitorTriggerFilters.ts`、`yieldMonitorTriggerSql.ts` |
| **v3 产量 SQL 模板** | `src/lib/apiV3ListSql.ts`（`buildYieldMonitorTriggersV3Sql`） |
| **v3 产量筛选解析** | `src/lib/yieldMonitorTriggerFilters.ts`（`parseYieldMonitorTriggerV3Query`） |
| **v3 产量 `COUNT` 聚合** | `src/lib/yieldMonitorTriggerV3Aggregate.ts` |
| 产量监控聚合（仅库模块；路由已关） | `src/lib/yieldMonitorTriggerAggregate.ts` |
| infcontrol 筛选 / Top 200 SQL | `src/lib/infcontrolLayerBinFilters.ts`、`infcontrolLayerBinSql.ts` |
| **v3 层控 SQL 模板** | `src/lib/apiV3ListSql.ts`（`buildInfcontrolLayerBinsV3Sql`） |
| **v3 层控筛选解析** | `src/lib/infcontrolLayerBinFilters.ts`（`parseInfcontrolLayerBinsV3Query`） |
| **v3 列表 `limit` 键名（不区分大小写）** | `src/lib/sqlIdent.ts`（`clampLimitFromQuery`） |
| **v3 层控 BIN 聚合（WHERE 适配）** | `src/lib/infcontrolLayerBinV3Aggregate.ts` |
| infcontrol BIN 聚合（UNPIVOT SQL） | `src/lib/infcontrolLayerBinAggregate.ts` |
| infcontrol dummy（含 **v3** 列表/聚合内存路径） | `src/lib/infcontrolLayerBinDummy.ts`（`filterInfcontrolLayerBinV3DummyRows*`、`aggregateInfcontrolLayerBinV3DummyRows`） |
| 产量监控 dummy（含 **v3** 列表/聚合内存路径） | `src/lib/yieldMonitorTriggerDummy.ts`（`filterYieldMonitorDummyRowsMatchingV3`、`aggregateYieldMonitorV3DummyRows`） |
| **Dummy 与 `dist`/production 强制走库** | `src/lib/listDummyRuntime.ts` |
| PASSBIN → **`passBinPair`**；**`bins[].isGood`** 恒 false | `src/lib/passBinSemantics.ts` |
| 错误 JSON | `src/lib/agentResponse.ts` |
| Request ID | `src/middleware/requestId.ts` |

部署与环境变量示例见仓库根目录 `.env.example`；**正式环境 PM2 发布（`npm ci`、`npm run build`、`pm2 start/reload` 等）见 [`docs/DEPLOY_PM2.md`](./DEPLOY_PM2.md)。

**快速跳转**：全部 URL 示例与 curl 见 **§8**。
