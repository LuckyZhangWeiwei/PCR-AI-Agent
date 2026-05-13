# pcr-ai-api：AI Agent（Claude Code）集成指南

本文档供 **Claude Code**、Cursor Agent 或其他 HTTP 工具调用本服务时使用。所有业务接口均为 **只读 GET**，响应 **JSON**。

## 1. 推荐集成方式

1. **先拉取机器可读目录**：`GET {baseUrl}/api/v1/manifest`  
   服务端用同一数据源维护端点说明（见仓库 `src/lib/apiManifest.ts`）。Agent 应用该 JSON 做工具发现与 prompt 锚定。
2. **业务查询**：根据 manifest 中的 `path`、`queryParameters`、`example` 构造 URL；需要可复制运行的完整 URL、curl、PowerShell 时见 **§7**。
3. **排障**：失败时读取 HTTP 状态码与 JSON body 的 `code` / `detail`；需要链路追踪时带上 `X-Request-Id`。

## 2. 基础约定

| 项 | 说明 |
| --- | --- |
| **Base URL** | 部署地址根路径，例如 `http://localhost:30008`（未设置 `PORT` 时默认端口见 `src/server.ts`；也可用环境变量 `PORT` 覆盖） |
| **前缀** | 业务 API 均在 `/api/v1` 下 |
| **方法** | 仅 `GET`（除进程存活检测外） |
| **查询键** | **不区分大小写**（如 `device`、`Device` 等价） |
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

## 3. 端点一览

### 3.1 `GET /health`

- **用途**：进程存活，**不访问数据库**。
- **响应示例**：`{ "status": "ok", "service": "pcr-ai-api" }`

### 3.2 `GET /api/v1/manifest`

- **用途**：返回完整 API 目录（端点、查询参数、示例、错误形状、追踪说明）。
- **用途**：Agent 首次连接或版本校验时应调用；也可用于生成 OpenAPI/工具 schema。

### 3.3 `GET /api/v1/db/ping`

- **用途**：主 Oracle 连接池健康检查，`SELECT 1 FROM DUAL`。
- **成功**：`{ "meta": {...}, "ok": true, "dual": { ... } }`
- **失败**：Oracle 不可用时返回 500，body 见第 4 节。

### 3.4 `GET /api/v1/infcontrol-layer-bins`

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

### 3.4.1 `GET /api/v1/infcontrol-layer-bins/aggregate`（BIN 合计 Top N）

- **与列表 `bins.isGood` 无关**：聚合对**所有** BIN 列数值求和、排名；列表 **`isGood`** 恒为 false（§3.4）。
- **典型流程**：先用与 §3.4 **完全相同**的查询参数做 **AND 筛选**（如 `device`、`lot`、`slot`、`tstype`、`cardId`；`testEndFrom` / `testEndTo` 约束 **TESTEND** 等），在匹配到的**全部明细行**上，对 **BIN0…BIN255** 各列做 **UNPIVOT 后按组 SUM**，再取 **合计最大的 `groupTop` 个 BIN**（或复合分组，见下）。
- **`groupBy`**：**可省略** — 省略时视为 **`bin`**，即只按「第几个 BIN 列」排名（最符合「筛完看谁 bin(n) 最多」）。若传入，须**恰好包含一次** `bin`，并可与 `device`、`lot`、`slot`、`tstype`、`cardId` 等行级维度逗号复合（见 manifest）。
- **`groupTop`**：返回几组，默认 **10**，最大 **50**。
- **响应**：`groupBy`、`groupTop`、`totalRowsMatching`（筛选后的行数）、`groups[]`（每项 `count` 为该组 **SUM(BIN 单元格)**，**`parts.bin`** 为下标 `"0"`…`"255"`；展示请优先用 **`parts`**）。某 **BIN(n)** 在筛选结果中**始终为 NULL** 时**不会出现**在 `groups` 中（与 Oracle `UNPIVOT EXCLUDE NULLS` / dummy 跳过 null 一致）。**无明细或无聚合分组时仍为 HTTP 200**（**`totalRowsMatching`** 为 **0** 或 **`groups`** 为 **`[]`**）。

**示例（只筛条件、默认按 BIN 取 Top 10）：**

```http
GET /api/v1/infcontrol-layer-bins/aggregate?device=WA00P69K&lot=DR39000.1N&slot=1&tstype=CP&cardId=9400-01&testEndFrom=2026-01-01T00:00:00.000Z&testEndTo=2026-01-31T23:59:59.999Z&groupTop=10
```

### 3.5 `GET /api/v1/yield-monitor-triggers`

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

### 3.6 `GET /api/v1/table-rows`

- **用途**：开发/探测用——按 ROWNUM 读取某表前 N 行（兼容旧版 Oracle）。
- **查询参数**：
  - `table`：可选；格式为 `TABLE` 或 `OWNER.TABLE`。未传时使用环境变量 `ORACLE_DEFAULT_TABLE`。
  - `limit`：可选；默认 **50**，最大 **500**。
- **响应**：`meta`、`table`（解析后的限定名）、`limit`、`rows`（含 `rnum` 等）。

仅在明确允许访问的模式下使用；生产 Agent 应优先使用专用业务端点。

### 3.7 已废弃：`GET /api/v1/yield-monitor-triggers/aggregate`

该路径 **未挂载**（访问 **404**）。产量监控若需 **PROBECARD** 出现次数分布，请使用 **§3.5** 响应中的 **`probeCardSummary`**（全量筛选结果上的分组）；其它维度仍可基于 **`rows`** 自行汇总。实现模块仍保留在 `yieldMonitorTriggerAggregate.ts` 等；**manifest** 的 **`deprecatedEndpoints`** 中有说明。

层控 BIN 的聚合请使用 **§3.4.1** `/infcontrol-layer-bins/aggregate`。

## 4. 错误响应约定

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

Oracle 驱动错误（如 NJS-116）可能在 `detail` 中含 **Instant Client / Thick 模式** 部署提示。

## 5. Claude Code 使用建议

1. **系统提示或 CLAUDE.md**：写入 base URL、说明「先 GET `/api/v1/manifest`」、强调只读与 200 行上限。
2. **工具封装**：每个 manifest 中的 `path` 映射为一个 GET 工具；查询参数用对象序列化为 query string（键名大小写不敏感，建议沿用 manifest 里的 camelCase）。
3. **时间参数**：统一使用 **ISO 8601** 字符串（示例中带 `Z` 的 UTC）。
4. **分页**：当前列表接口为固定 Top 200；Agent 应用更窄的时间窗或过滤条件缩小结果集，而非假设 offset 分页。
5. **层控 BIN 聚合**：`/infcontrol-layer-bins/aggregate` 与列表 **同一套筛选**；省略 **`groupBy`** 时默认按 **BIN 列合计**取 Top N（§3.4.1）。**`/yield-monitor-triggers/aggregate`** 仍废弃（§3.7）。
6. **幂等与缓存**：全部为 GET，可安全重试；可按 `filters` + URL 做短期缓存以降低数据库负载。

## 6. 详细使用说明

本节约定：**查询串键名**与 manifest 一致时用 **camelCase**（如 `timeStampFrom`）；服务端匹配时 **不区分大小写**，`Device` 与 `device` 等价。所有 **日期时间** 参数均为 **ISO 8601** 字符串（建议 UTC，后缀 `Z`），例如 `2026-01-31T00:00:00.000Z`。

### 6.1 推荐调用顺序

1. `GET /api/v1/manifest` 获取当前部署支持的 `path`、`queryParameters`、`example`。
2. 按业务选择端点；需要人类可读说明时以本文档 §3 与下表为准。
3. 构造 URL 时对 query 做 **百分号编码**（例如 `encodeURIComponent`）；`&`、`=`、`+`、空格等必须编码，避免手工拼接出错。
4. 可选请求头：`X-Request-Id: <uuid>`，便于与日志、`meta.requestId` 对齐。

### 6.2 产量监控与层控：列表与 BIN 聚合如何选用

| 场景 | 端点 | 说明 |
| --- | --- | --- |
| 产量监控触发器明细（按时间） | `GET /api/v1/yield-monitor-triggers` | 最多 **200** 条，`TIME_STAMP` **降序**；可选 **`probeCardSummary`**（全量筛选下按 PROBECARD 计数降序）。 |
| 层控 / BIN **明细行**（按测试结束时间） | `GET /api/v1/infcontrol-layer-bins` | 最多 **200** 条，`TESTEND` **降序**。 |
| 层控：先按 device/lot/slot/tstype/cardId/testEnd… **筛选**，再看 **哪些 BIN(n) 合计最多**（Top N） | `GET /api/v1/infcontrol-layer-bins/aggregate` | 与列表 **同一套筛选**；默认 **`groupBy=bin`**（可省略参数）；`groups[].count` 为 **SUM**，不是行数。 |

产量监控聚合 HTTP 仍废弃；**PROBECARD** 频次见 §6.3 的 **`probeCardSummary`**；其它维度可对 `rows` 客户端汇总。

### 6.3 `GET /api/v1/yield-monitor-triggers`

**数据源**：Oracle 表 `YMWEB_YIELDMONITORTRIGGER`（**probeweb** 连接池，见 `.env.example` 中 `ORACLE_PROBEWEB_*`）。

**查询参数**（均可选；组合时为 **AND**）：

| 参数 | 类型 | 含义（SQL 侧） |
| --- | --- | --- |
| `hostname` | 字符串 | `HOSTNAME` 等于该值 |
| `device` | 字符串 | `DEVICE` 等于该值 |
| `lotId` | 字符串 | `LOTID` 等于该值 |
| `wafer` | 字符串 | `WAFER` 等于该值 |
| `type` | 字符串 | `TYPE` 等于该值 |
| `triggerLabel` | 字符串 | `TRIGGER_LABEL` **全等**（精确匹配，非模糊搜索） |
| `probeCard` | 字符串 | `PROBECARD` 等于该值 |
| `pass` | 数字 | `PASS` 等于该值 |
| `id` | 数字 | `ID` 等于该值 |
| `timeStampFrom` | 日期时间 | `TIME_STAMP >=` 该时刻 |
| `timeStampTo` | 日期时间 | `TIME_STAMP <=` 该时刻 |
| `includeProbeCardSummary` | 布尔 | 默认 **true**；为 **false** 时不请求 **`probeCardSummary`**（少一次 `GROUP BY`） |

**时间范围**：若同时提供 `timeStampFrom` 与 `timeStampTo`，必须满足 **from ≤ to**，否则返回 **400** `VALIDATION_ERROR`。

**成功响应字段**：

| 字段 | 含义 |
| --- | --- |
| `limit` | 固定 **200**（最多返回行数上限） |
| `orderBy` | 固定为按时间戳降序的说明字符串 |
| `filters` | 服务端**实际参与筛选**的参数对象（含标准化后的时间 ISO 字符串） |
| `count` | 本次响应中 **`rows` 的长度**（不超过 200） |
| `rows` | 明细数组；列名与 Oracle 一致，一般为 **大写**（如 `HOSTNAME`, `TIME_STAMP`, …） |
| `probeCardSummary` | （默认包含）对象数组 `{ probeCard, count }`：在**与 `rows` 相同 WHERE** 下对**全部匹配行**按 `PROBECARD` 分组后的行数，按 **`count` 降序**（`probeCardSummaryOrderBy` 为 `COUNT(*) DESC NULLS LAST`） |
| `probeCardSummaryOrderBy` | 与 `probeCardSummary` 同时出现；说明聚合排序 |

**行对象常见列**（以库表为准）：`HOSTNAME`, `DEVICE`, `LOTID`, `PASS`, `WAFER`, `TYPE`, `TRIGGER_LABEL`, `TIME_STAMP`, `ID`, `PROBECARD`。

### 6.4 ~~`GET /api/v1/yield-monitor-triggers/aggregate`~~（已废弃）

路由已移除；详见 §3.7。

### 6.5 `GET /api/v1/infcontrol-layer-bins`

**数据源**：主 Oracle 池；`INFCONTROL` **内连接** `INFLAYERBINLIST`，连接键 `KEYNUMBER`。

**查询参数**（均可选；**AND**）：数值列传数字字符串即可；**BIN 列** `bin0`…`bin255` 的值为 **逗号分隔整数**，表示对应 `BINk` 列落在 `IN (...)` 列表中（详见 manifest）。

**时间与排序**：

- `testStartFrom` / `testStartTo`：筛选 `TESTSTART` 闭区间侧（`>=` / `<=`）。
- `testEndFrom` / `testEndTo`：筛选 `TESTEND`。
- 若同一轴上的 from/to 均存在，需 **from ≤ to**，否则 **400**。

**结果**：最多 **200** 行，**先按 `TESTEND` 降序，再按 `KEYNUMBER` 降序**（与 Oracle / dummy 一致）。响应 **`rows`** 中**不包含** `PASSBINTABLE`、`INKBINTABLE`（接口侧已从 SELECT 剔除）。各 BIN 计数放在 **`bins`** 对象中（见 §3.4）；**`bins[k].isGood` 恒为 `false`**；**值为 null 或 0 的 BIN 列不占条目**。

**PASSBIN**：值为 **`N-M`**（如 `1-55`）时，**`passBinPair`** 为 **`[N, M]`**。非 `N-M` 格式时 **`passBinPair` 为 null**。**`bins[k].isGood`** 恒为 **`false`**。

### 6.5.1 `GET /api/v1/infcontrol-layer-bins/aggregate`

**数据源与连接**：与 §6.5 列表相同（主 Oracle 池，`INFCONTROL` ⋈ `INFLAYERBINLIST`）。

**与 `bins.isGood`**：本接口**不按**列表中的 `isGood` 筛选 BIN（且列表 **`isGood` 恒为 false**）；对明细行中各 BIN 列**全部参与** SUM（与 §3.4.1 一致）。

**筛选**：与 **§6.5** 列表 **完全一致**（`device`、`lot`、`slot`、`tstype`、`cardId`、`testEndFrom`、`testEndTo`、…），全部为 **AND**。

**聚合参数**：

| 参数 | 说明 |
| --- | --- |
| `groupBy` | **可选**。省略则等价 **`bin`**（按 BIN0…255 各列在全集上的 **SUM** 排名）。若填写，须含 **`bin`** 一次，可与 `device`、`lot` 等复合。 |
| `groupTop` | 默认 **10**，最大 **50**。 |

**响应**：`totalRowsMatching` 为满足 WHERE 的**明细行数**；`groups[].count` 为对应分组下 BIN 列 **数值之和**（**非**行数）；**`parts.bin`** 为 BIN 下标字符串。

### 6.6 本地与测试：Dummy 模式（无 Oracle）

以下环境变量为 **`1` / `true` / `yes`**（大小写不敏感）时，对应端点返回**内存样本**，**不连接数据库**；传参与成功响应 JSON **形状与正式环境一致**（详见仓库 `.env.example`）：

| 变量 | 影响的端点 |
| --- | --- |
| `NODE_ENV=test` | 两处列表 dummy **均**启用（无需再设下列变量） |
| `YIELD_MONITOR_TRIGGERS_DUMMY=true` | `/api/v1/yield-monitor-triggers` |
| `INFCONTROL_LAYER_BINS_DUMMY=true` | `/api/v1/infcontrol-layer-bins` 与 **`/infcontrol-layer-bins/aggregate`** |

Dummy 下列表与 infcontrol 聚合均走内存样本，筛选与聚合语义与 Oracle 路径一致。样本量有限，仅供联调。

**保证能拉出数据的示例查询串（与 manifest `example` 同源）**：层控 **`INFCONTROL_DUMMY_EXAMPLE_QUERY`**（`src/lib/infcontrolLayerBinDummy.ts`）；产量监控 **`YIELD_MONITOR_DUMMY_EXAMPLE_QUERY`**（`src/lib/yieldMonitorTriggerDummy.ts`）。层控 **第 0 条**样本已对齐 **device/lot/slot/tstype/cardId + 一月 TESTEND**；产量监控 **首条**为 **device=D1** 锚点。

### 6.7 完整示例（curl）

**列表（某日 UTC 全天）**：

```bash
curl -sS -H "X-Request-Id: my-trace-id" \
  "http://localhost:30008/api/v1/yield-monitor-triggers?timeStampFrom=2026-01-31T00:00:00.000Z&timeStampTo=2026-01-31T23:59:59.999Z"
```

**层控：筛选后 BIN 合计 Top 10（可不写 groupBy，默认按 bin）：**

```bash
curl -sS \
  "http://localhost:30008/api/v1/infcontrol-layer-bins/aggregate?device=WA00P69K&lot=DR39000.1N&slot=1&tstype=CP&cardId=9400-01&testEndFrom=2026-01-01T00:00:00.000Z&testEndTo=2026-01-31T23:59:59.999Z&groupTop=10"
```

将 `localhost:30008` 换成实际 **Base URL**；端口以部署为准（未设置 `PORT` 时见 `src/server.ts`）。

更完整的端点说明、参数表与多组示例见 **§7**。

## 7. 全部 API 实例与用法

以下 **`{baseUrl}`** 默认为 `http://localhost:30008`，部署时请替换。所有路径均为 **GET**；查询参数键名 **大小写不敏感**。

**Postman**：地址栏只填 `http://...`，不要写 `GET http://...`。**curl / PowerShell**：整条命令可复制运行。

### 7.1 一览表

| # | 路径 | 用途 | 查询参数 |
| --- | --- | --- | --- |
| 1 | `/health` | 进程存活，不连库 | 无 |
| 2 | `/api/v1/manifest` | 机器可读 API 目录 | 无 |
| 3 | `/api/v1/db/ping` | 主 Oracle：`SELECT 1 FROM DUAL` | 无 |
| 4 | `/api/v1/infcontrol-layer-bins` | 层控 ⋈ 层 BIN 明细，最多 200 行 | 见 §7.4 |
| 5 | `/api/v1/infcontrol-layer-bins/aggregate` | 同上筛选 + BIN 列 SUM，Top N 组 | **groupBy**、**groupTop** + 与 §7.4 相同筛选 |
| 6 | `/api/v1/yield-monitor-triggers` | 产量监控触发器，最多 200 行 | 见 §7.6 |
| 7 | `/api/v1/table-rows` | 开发用：表前 N 行 | **table**、**limit** |

已移除路由（勿调用）：`GET /api/v1/yield-monitor-triggers/aggregate`（见 manifest **`deprecatedEndpoints`**）。

---

### 7.2 `GET /health`

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

### 7.3 `GET /api/v1/manifest`

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

### 7.4 `GET /api/v1/infcontrol-layer-bins`

**筛选**：条件之间 **AND**；均为可选。

| 参数 | 类型 | 含义 |
| --- | --- | --- |
| `keynumber` | 数字 | `KEYNUMBER` |
| `device`, `lot`, `slot`, `pdpw`, `meslot` | 字符串/数字 | INFCONTROL 列 |
| `testerId`, `tstype`, `cardId`, `pibId`, `probe`, `grossDie`, `passId`, `sessionNumber`, `passNum`, `layerName`, `passResume`, `passResult`, `passType`, `passBin` | 各类 | INFLAYERBINLIST 列 |
| `testStartFrom`, `testStartTo`, `testEndFrom`, `testEndTo` | ISO 8601 | `TESTSTART` / `TESTEND` 闭区间侧 |
| `bin0` … `bin255` | 逗号分隔整数 | 对应 **`BINk`** 列 `IN (...)`，如 `bin5=1,3,5` |

**响应**：**`limit`**（200）、**`orderBy`**、**`filters`**、**`count`**、**`rows`**；每行含 **`passBinPair`**、**`bins`**（见 §3.4）。无命中：**HTTP 200**，**`count`: 0**。

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

### 7.5 `GET /api/v1/infcontrol-layer-bins/aggregate`

在 §7.4 **同一套筛选**上，对 BIN0…BIN255 **UNPIVOT 后 SUM**，按合计取 Top **`groupTop`**（默认 **10**，最大 **50**）。

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

### 7.6 `GET /api/v1/yield-monitor-triggers`

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

### 7.7 `GET /api/v1/db/ping`

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

### 7.8 `GET /api/v1/table-rows`

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

### 7.9 Dummy 与 Oracle（排障）

| 变量（`.env`） | 作用 |
| --- | --- |
| `INFCONTROL_LAYER_BINS_DUMMY=true` | §7.4、§7.5 走内存样本，不连主库 |
| `YIELD_MONITOR_TRIGGERS_DUMMY=true` | §7.6 走内存样本，不连 probeweb |

Dummy 下 **`includeProbeCardSummary`** 行为与真库一致（仍为可选）。未装 Instant Client 时出现 **NJS-116**：可开启上述 Dummy，或配置 **`ORACLE_INSTANT_CLIENT_LIB_DIR`**（见 `.env.example`）。

---

## 8. 与仓库源码的对应关系

| 文档概念 | 源码位置 |
| --- | --- |
| 路由挂载 | `src/app.ts`：`/api/v1` → `apiRouter` |
| Manifest 内容 | `src/lib/apiManifest.ts` |
| 各 GET 实现 | `src/routes/api.ts` |
| 产量监控筛选 / Top 200 | `src/lib/yieldMonitorTriggerFilters.ts`、`yieldMonitorTriggerSql.ts` |
| 产量监控聚合（仅库模块；路由已关） | `src/lib/yieldMonitorTriggerAggregate.ts` |
| 产量监控 dummy | `src/lib/yieldMonitorTriggerDummy.ts` |
| infcontrol 筛选 / Top 200 SQL | `src/lib/infcontrolLayerBinFilters.ts`、`infcontrolLayerBinSql.ts` |
| infcontrol BIN 聚合 | `src/lib/infcontrolLayerBinAggregate.ts` |
| infcontrol dummy | `src/lib/infcontrolLayerBinDummy.ts` |
| PASSBIN → **`passBinPair`**；**`bins[].isGood`** 恒 false | `src/lib/passBinSemantics.ts` |
| 错误 JSON | `src/lib/agentResponse.ts` |
| Request ID | `src/middleware/requestId.ts` |

部署与环境变量示例见仓库根目录 `.env.example`；**正式环境 PM2 发布（`npm ci`、`npm run build`、`pm2 start/reload` 等）见 [`docs/DEPLOY_PM2.md`](./DEPLOY_PM2.md)。

**快速跳转**：全部 URL 示例与 curl 见 **§7**。
