# pcr-ai-api：AI Agent（Claude Code）集成指南（v3 业务）

本文档供 **Claude Code**、Cursor Agent 或其他 HTTP 工具调用本服务时使用。**§7**、**§8** 中可复制的 URL 一律使用联调示例根 **`http://10.192.130.89:30008`** 与 URL 前缀 **`/api/v3`**（路径中不再出现 **`v1`**）。业务说明仅展开 **v3** 层控与产量路径；**health**、**manifest**、**db/ping**、**table-rows** 见 **§6** / **§8**。所有业务接口均为 **只读 GET**，响应 **JSON**。

**URL 与 manifest（务必对齐代码）**

| 项 | 说明 |
| --- | --- |
| **推荐前缀** | **`/api/v3`** — 与 **`/api/v1`** 挂载**同一** `apiRouter`（`src/app.ts`）。 |
| **`GET …/api/v3/manifest`** | 仅列出 v3 列表/聚合、**`db/ping`**、**`/health`**（不含 **`table-rows`** 等开发端点）；**`path` / `example`** 中业务与 Oracle ping 为 **`/api/v3/...`**，**`/health`** 仍为 **`/health`**；响应含 **`catalogScope":"v3-surfaces-only"`**。实现：**`buildManifestResponseJson`**（`src/lib/rebaseApiManifest.ts`）。 |
| **`GET …/api/v1/manifest`** | **全量**端点目录，**`path`** 仍为 **`/api/v1/...`**；**`catalogScope":"full"`**。旧集成兼容用。 |
| **业务路径里的 `/v3/`** | 表示 **v3 业务语义**（固定 SQL / `meta.apiVersion:"3"`），与 URL 前缀 **`/api/v3`** 不是同一概念。 |

**配套文档（给 Agent / 维护者）**

| 文档 | 用途 |
| --- | --- |
| **本页**（`docs/AI_AGENT_API.md`） | **§0** 地图 → **§1** 集成 → **§2** 约定 → **§3** 错误 → **§4** Dummy → **§5** Claude → **§6** manifest / 探活 → **§7** v3 通俗 → **§8** curl → **§9** 源码 |
| [**API_V3.md**](./API_V3.md) | **`/infcontrol-layer-bins/v3`** 与 **`/yield-monitor-triggers/v3`** 的**列表**完整 SQL（与 `npm run build` 后的 `dist` 一致）；**v3 聚合** SQL 见源码 **`yieldMonitorTriggerV3Aggregate.ts`**、**`infcontrolLayerBinV3Aggregate.ts`**（层控复用 **`infcontrolLayerBinAggregate.ts`**）。更新：`npm run docs:api-v3` |
| **`docs/JBStart.xlsx`**、**`docs/delta-diff.xlsx`** | 层控 / 产量样例行，便于理解库内**大小写与格式**（v3 字符串筛选为 `UPPER(TRIM)` 不区分大小写） |

## 0. 文档地图（怎么读不乱）

| 章节 | 适合谁 | 内容 |
| --- | --- | --- |
| **§1** | 首次对接 | **`GET /api/v3/manifest`** 优先、业务查询、排障、v3 SQL 文档入口 |
| **§2** | 所有人 | **站点根**与 **§2.0** 拼 URL（防 **`…/api/v3/api/v3/…`** 重复前缀）、查询键、`v3` 字符串 **`UPPER(TRIM)`**、`X-Request-Id`、`meta` |
| **§3** | 排障 | 错误 JSON、`code` 表；**§3.1** 文档有路由但线上 **404**（多为旧构建 / 反代） |
| **§4** | 本地 / 无库 / 发布对照 | **Dummy 唯一权威说明**（含 v3、**`dist` / production**、**`NODE_ENV=test`**） |
| **§5** | Claude Code | 可贴系统提示的要点清单 |
| **§6** | manifest / 探活 | **health**、**manifest**、**db/ping**、**table-rows**（开发）；其它已挂载路径以 **manifest** 为准 |
| **§7** | 理解 v3 | **§7.0** 两个 **v3 聚合**白话对照；**§7.2** 列表 vs 聚合；**§7.6 / §7.7** 为聚合详细说明与传参示例；**URL / curl** 见 **§8**；**列表 SQL** 见 **API_V3.md** |
| **§8** | 复制粘贴 | 联调示例根 **`http://10.192.130.89:30008`** 下的 **HTTP + curl**（语义 **§7**；探活 **§6**） |
| **§9** | 改代码 | 源码路径索引 |

**选用哪条 HTTP？** 见 **§8.1** 一览表（仅列本页详述的 **v3** 路径与探活端点）。

## 1. 推荐集成方式

1. **先拉取机器可读目录**：`GET http://10.192.130.89:30008/api/v3/manifest`  
   服务端用同一数据源维护端点说明（见仓库 `src/lib/apiManifest.ts`）。Agent 应用该 JSON 做工具发现与 prompt 锚定。
2. **业务查询**：根据 **`GET …/api/v3/manifest`** 返回的 **`path`**、**`queryParameters`**、**`example`** 构造 URL（**`path`** 以 **`/api/v3`** 开头；与**站点根**拼接见 **§2.0**）；可运行示例见 **§8**。
3. **排障**：失败时读取 HTTP 状态码与 JSON body 的 `code` / `detail`（**§3**）；需要链路追踪时带上 `X-Request-Id`。
4. **核对 v3 SQL**：列表 SQL 见 **`docs/API_V3.md`**（或 `npm run docs:api-v3`）；聚合 SQL 见 **§9** 表中 **`yieldMonitorTriggerV3Aggregate.ts`**、**`infcontrolLayerBinV3Aggregate.ts`**。

**推荐调用顺序（与 manifest 一致）**

1. `GET http://10.192.130.89:30008/api/v3/manifest`（或相对路径 **`GET /api/v3/manifest`**）取 `path`、`queryParameters`、`example`。
2. 按 **§8.1** 选 **v3** 端点；先读 **§7** 再调 **§8** 的示例 URL。
3. 构造 query 时用 **`encodeURIComponent`**，避免 **`&`**、**`+`**、空格破坏 URL。
4. 可选：`X-Request-Id: <uuid>`，与 **`meta.requestId`** 对齐日志。

## 2. 基础约定

| 项 | 说明 |
| --- | --- |
| **站点根（本文联调示例）** | **`http://10.192.130.89:30008`** — 仅 **协议 + 主机 + 端口**。**不要**写成 **`http://主机:端口/api/v3`** 再拼 manifest 里的 **`path`**（`path` 已以 **`/api/v3`** 开头），否则会出现 **`…/api/v3/api/v3/…`**。其它环境请替换为你的 **`http(s)://主机:端口`**。端口见 **`PORT`** / `src/server.ts`。 |
| **URL 前缀** | **推荐** **`/api/v3`**：与 **`/api/v1`** 挂载**同一路由器**；**`GET /api/v3/manifest`** 为 v3 专用目录（见文首表）。兼容旧客户端仍可用 **`/api/v1/...`**。 |
| **方法** | 仅 `GET`（除进程存活检测外） |
| **查询键** | **不区分大小写**（如 `device`、`Device`、`LIMIT` 与 `limit` 等价） |
| **v3 字符串筛选值** | 路径 **`/infcontrol-layer-bins/v3`**、**`/yield-monitor-triggers/v3`**（及各自 **`/v3/aggregate`**）中，字符串列与入参按 **`UPPER(TRIM(列)) = UPPER(:bind)`** 比较，**不区分大小写** |
| **Content-Type** | 成功响应 `application/json` |
| **数据库** | Oracle；部分端点走主连接池，产量监控触发器走 probeweb 连接池 |

### 2.0 拼出完整 URL（必读）

- **`GET /api/v3/manifest`** 返回的 **`endpoints[].path`** 与 **`example`** 均以 **`/api/v3`** 开头（例如 **`/api/v3/yield-monitor-triggers/v3/aggregate`**）。
- **推荐写法**：**站点根**（本文 **`http://10.192.130.89:30008`**）与 **`path`** 直接拼接。  
  例：站点根 **`http://10.192.130.89:30008`** + **`/api/v3/yield-monitor-triggers/v3/aggregate?…`** → **`http://10.192.130.89:30008/api/v3/yield-monitor-triggers/v3/aggregate?…`**。
- **常见错误**：站点根写成 **`http://主机:端口/api/v3`**，再拼 **`/api/v3/...`** → **`…/api/v3/api/v3/…`**（**404**）。

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

### 3.1 `NOT_FOUND`（404）且 **`detail`** 为请求路径

当响应为 **`"code":"NOT_FOUND"`**、**`detail`** 等于你访问的 **`/api/v3/...`** 时，表示 **当前进程里没有挂载该路由**（参数写错通常是 **400** **`VALIDATION_ERROR`**，而不是这种 404）。

**文档里有、线上 404** 时，多数是：**服务器仍在跑旧版本**（尚未包含 **`…/v3/aggregate`** 等路由）。

**建议自检**：

1. **`GET http://10.192.130.89:30008/api/v3/manifest`**，在 **`endpoints`** 里查是否存在 **`path":"/api/v3/yield-monitor-triggers/v3/aggregate"`**（层控则查 **`…/infcontrol-layer-bins/v3/aggregate`**）。  
   - **没有**：在本仓库 **`npm ci`** → **`npm run build`** → **重启** PM2 / Node（确保加载的是新 **`dist`**）。  
   - **有**：检查 **反向代理** 是否把 **`/api/v3`**（或 **`/api/v1`**）原样转到本服务（避免 upstream 指错、或路径被改写）。

2. 在部署机上对 **`127.0.0.1:30008`** 直接 **`curl`** 同一 URL，排除网关或端口映射问题。

## 4. Dummy 与 Oracle（环境与排障）

本节为 **Dummy 行为的唯一权威说明**；**§8** 中各 curl 小节不再重复。

以下环境变量为 **`1` / `true` / `yes`**（大小写不敏感）时，在满足 **`src/lib/listDummyRuntime.ts`** 规则（**`dist` / `NODE_ENV=production`** 下恒走 Oracle）的前提下，**v3 层控 / 产量**可走 **Excel 内存样本**（**`JBStart.xlsx`** / **`delta-diff.xlsx`**），成功 JSON **形状与真库一致**（详见 `.env.example`）：

| 变量 | 影响的 v3 端点（摘要） |
| --- | --- |
| `INFCONTROL_LAYER_BINS_DUMMY=true` | **`/api/v3/infcontrol-layer-bins/v3`**、**`/api/v3/infcontrol-layer-bins/v3/aggregate`** |
| `YIELD_MONITOR_TRIGGERS_DUMMY=true` | **`/api/v3/yield-monitor-triggers/v3`**、**`/api/v3/yield-monitor-triggers/v3/aggregate`** |

此外 **`NODE_ENV=test`** 时，层控 Dummy 在代码中**默认视为开启**（便于单测与无库环境），仍以 **`listDummyRuntime`** 是否强制走库为准。

**Dummy 与 `dist` / production`**：上述四条 **v3** 路径在 **`INFCONTROL_LAYER_BINS_DUMMY` / `YIELD_MONITOR_TRIGGERS_DUMMY`** 为真、且进程**非** `npm run build` 的 **`dist`**、且 **`NODE_ENV`≠`production`** 时走内存样本；**`dist` 或 production** 下 **Dummy 关闭**，恒走 Oracle（见 **`src/lib/listDummyRuntime.ts`**）。

Dummy 下 **`includeProbeCardSummary`** 行为与真库一致（仍为可选）。**保证有命中的示例查询串**（与 manifest `example` 同源）：层控 **`INFCONTROL_DUMMY_EXAMPLE_QUERY`**（`infcontrolLayerBinDummy.ts`）；产量 **`YIELD_MONITOR_DUMMY_EXAMPLE_QUERY`**（`yieldMonitorTriggerDummy.ts`）。

**层控 v3 聚合（`…/infcontrol-layer-bins/v3/aggregate`）与 Dummy 对齐**：Oracle 路径使用 **`buildInfcontrolLayerBinAggregateSql(..., "v3-hyphen-tokens")`**（**`PASSBIN`** 按 **`-`** 整段 token 识别 **good bin**，**SUM 只累计坏 bin die**）。**`INFCONTROL_LAYER_BINS_DUMMY=true`** 时，**`JBStart.xlsx`** 内存路径在 **`infcontrolLayerBinDummy.ts`** 中通过 **`forEachBadBinDieContribution`** 与 **`/infcontrol-layer-bins/v2/top-bad-bins`** 的 dummy 累计规则**共用**（与 **`parsePassBinHyphenGoodBins`**、列表 **`bins[].isGoodBin`** 一致），勿与 v1 **`/infcontrol-layer-bins/aggregate`** 的 BIN1 / N-M 两端规则混淆。

## 5. Claude Code 使用建议

以下为可直接贴入 **系统提示**或团队模板的要点（与 manifest 一致）。**更完整的 Claude Code 交接**（命令、Dummy/Oracle 纪律、产量 v3 特殊约定、源码索引、检查清单）见包内 **[`CLAUDE.md`](../CLAUDE.md)**（与 `docs` 同级）。

1. **站点根与发现**：联调示例根为 **`http://10.192.130.89:30008`**（**不要**在末尾带 **`/api/v3`** 或 **`/api/v1`**）；**首次会话先** **`GET http://10.192.130.89:30008/api/v3/manifest`**，用返回的 **`path`**（以 **`/api/v3`** 开头）与 **`queryParameters`**、**`example`** 拼完整 URL（见 **§2.0**）。
2. **只读与安全**：所有业务接口为 **GET**、只读；无 offset 分页，通过 **更窄的筛选 / 时间窗** 控制结果体量。
3. **工具封装**：每个 manifest `path` 对应一个 GET 工具；query 用对象序列化（键名大小写不敏感，建议 **camelCase** 与 manifest 一致）。
4. **时间参数**：统一 **ISO 8601**（建议 UTC，后缀 `Z`），见各端点 `timeStamp*` / `testEnd*` 说明。
5. **行数上限**：**v3 列表** 支持 **`limit`**（默认 **200**，最大 **500**）。无 offset；勿假设分页游标。
6. **v3 HTTP 路径**：列表用 **`/api/v3/infcontrol-layer-bins/v3`**、**`/api/v3/yield-monitor-triggers/v3`**；全量聚合用 **`…/v3/aggregate`**（见 **§7**）。**`dist` 或 production** 下 v3 恒走 Oracle。
7. **v3 大小写**：v3 字符串筛选 **值** 与库列 **`UPPER(TRIM)`** 比较（不区分大小写）；样例行见 **`docs/JBStart.xlsx`**、**`docs/delta-diff.xlsx`**。
8. **SQL 与排障**：v3 **列表** SQL 见 **`docs/API_V3.md`**（改 `apiV3ListSql.ts` 后 **`npm run docs:api-v3`**）。**v3 聚合** SQL 见 **`yieldMonitorTriggerV3Aggregate.ts`**、**`infcontrolLayerBinV3Aggregate.ts`**。Oracle 报错见 body `detail`。
9. **层控 BIN 聚合**：仅使用 **`GET http://10.192.130.89:30008/api/v3/infcontrol-layer-bins/v3/aggregate`**（语义 **§7.6**、示例 **§8.5**）；**`/yield-monitor-triggers/aggregate`** 未挂载（**404**），产量全量计数只用 **`…/api/v3/yield-monitor-triggers/v3/aggregate`**。
10. **幂等与缓存**：全部为 GET，可安全重试；可按 `filters` + URL 做短期缓存以降低数据库负载。
11. **产量 v3 与 `TYPE`**：**`GET …/yield-monitor-triggers/v3`** 与 **`…/v3/aggregate`** 在 **WHERE** 中**固定** **`TYPE = delta_diff`**（Oracle **`UPPER(TRIM(t."TYPE"))`**；响应 **`filters.typeScope`** 恒为 **`delta_diff`**）。**不支持** **`type`** 查询参数（不可改范围），也**不要**在 **`dimensions`** 里写 **`type`**；库列 **`TYPE`** 仍在列表每行 JSON 中返回。

## 6. manifest、探活与开发辅助

本页**只**展开 **v3** 层控 / 产量（**§7**、**§8.4** 起）。其它已挂载 **GET** 的 **`path`**、**`queryParameters`**、**`example`** 以 **`GET /api/v3/manifest`** 为准；已下线路由见返回体 **`deprecatedEndpoints`**。

### 6.1 `GET /health`

- **用途**：进程存活，**不访问数据库**。
- **响应示例**：`{ "status": "ok", "service": "pcr-ai-api" }`

### 6.2 `GET /api/v3/manifest`（推荐）与 **`GET /api/v1/manifest`**（全量）

- **`GET /api/v3/manifest`**（**推荐**）：返回 **`endpoints`**、**`deprecatedEndpoints`**、**`errorShape`**、**`tracing`**；**仅 v3 相关**端点 + **`db/ping`** + **`/health`**（不含 **`table-rows`**）；**`path` / `example`** 中业务与 ping 为 **`/api/v3/...`**，**`/health`** 仍为 **`/health`**；**`catalogScope`** 为 **`v3-surfaces-only`**。
- **`GET /api/v1/manifest`**：**全量**目录（含 v1/v2 等），**`path`** 为 **`/api/v1/...`**；**`catalogScope`** 为 **`full`**。仅在为旧客户端生成工具或对照历史 URL 时使用。
- **建议**：新对接、Agent 工具发现、希望 URL 中**不出现 `v1`** 时，**一律**先拉 **`/api/v3/manifest`**。

### 6.3 `GET /api/v3/db/ping`

- **用途**：主 Oracle 连接池健康检查，`SELECT 1 FROM DUAL`。
- **成功**：`{ "meta": {...}, "ok": true, "dual": { ... } }`
- **失败**：Oracle 不可用时返回 500，body 见 **§3**。

### 6.4 `GET /api/v3/table-rows`

- **用途**：开发/探测用——按 ROWNUM 读取某表前 N 行（兼容旧版 Oracle）。
- **查询参数**：**`table`**（可选；`TABLE` 或 **`OWNER.TABLE`**；未传则用 **`ORACLE_DEFAULT_TABLE`**）；**`limit`**（可选；默认 **50**，最大 **500**）。
- **响应**：`meta`、`table`（解析后的限定名）、`limit`、`rows`（含 `rnum` 等）。

仅在明确允许访问的模式下使用；生产 Agent 应优先使用 **§7** 中的 **v3** 业务端点。**curl** 见 **§8.9**。

## 7. v3 API（通俗说明；与 §8 对照阅读）

本节说明 **四条 v3 路径**在业务上解决什么问题。**§7.0** 用一张表把两个 **v3 聚合**讲清楚；**§7.6**、**§7.7** 是聚合的详细说明与可复制 URL。**每条路径的查询键、示例 URL、cURL** 集中在 **§8.4**、**§8.5**、**§8.6**、**§8.7**；**列表 SQL** 见 [**API_V3.md**](./API_V3.md)；**Dummy / `dist` / production** 见 **§4**；字段级权威定义仍以 **`GET /api/v3/manifest`** 为准。

### 7.0 v3 两个「聚合」白话对照（先看这张）

**「聚合」和「列表」差一句人话**：列表是「筛完以后，**只抽前 N 条**给我看」；聚合是「**同一套筛选**下，库里**所有**符合条件的行都拿来算总数 / 排名」，**不会**因为列表只返回 500 条就只统计那 500 条。

**v3 里只有两个聚合接口**（路径里都必须带 **`/v3/`** 这一段）：

| 接口 | 你在问系统什么？（白话） | 算的是什么数？ | 聚合专用参数 | 别和什么搞混 |
| --- | --- | --- | --- | --- |
| **`…/infcontrol-layer-bins/v3/aggregate`**（层控 BIN） | 这段时间 / 这批料 / 这台机……里，**哪些 BIN 上的「坏品 die」加起来最多**？也可以问「**每个料号下面**，哪个 BIN 合计最高？」 | 把每行里的 **BIN0～BIN255** 拆开，**只对坏 bin 做加法（SUM）**。**PASSBIN** 里用 **`-` 隔开的数字**表示「这些 bin 号算良品」，**那些列不加进合计**（和列表里 **`bins[].isGoodBin`** 一致） | **`groupBy`**（里面**必须出现一次** `bin`，可省略整个参数则等价「只按 BIN 排名」）、**`groupTop`**（前几名，默认 10） | 和 **v1** 的 **`…/infcontrol-layer-bins/aggregate`** **不是同一套规则**（v1 是 BIN1、N-M 那套老逻辑） |
| **`…/yield-monitor-triggers/v3/aggregate`**（产量触发） | 这段时间里，**在仅 `TYPE=delta_diff` 的触发记录上**，按机台、料号、探针卡、某一天……分桶，**每个桶里发生了多少次**？（**不按**库列 **`TYPE`** 再筛选或分组；**`type`** 查询参数不可用。） | **数条数**：满足条件的一行触发记录 = **COUNT 加 1** | **`dimensions`**（**必填**，1～5 个维度，逗号分隔；**不含** **`type`**）、**`groupTop`**（前几名，默认 25） | **不要**用列表的 **`limit`** 假装在做全量统计；没有 **`v3`** 的旧地址 **`…/yield-monitor-triggers/aggregate`** **没挂路由**，会 **404** |

**返回 JSON 里和「数」有关的三个词**（两个聚合都有，意思接近）：

- **`groups`**：排行榜——每一行是一种「维度组合」（例如「BIN=5」或「某一天 + 某机台」）。
- **`groups[].count`**：这一格里的**汇总值**——层控是 **坏 bin die 的合计**，产量是 **触发次数**。
- **`totalRowsMatching`**：满足你筛选条件的**原始明细有多少行**（层控是层测合并行数，产量是触发器表行数）。它**不是**把上面每个 `count` 再加一遍（因为一行明细可能贡献多个 bin 或只进一个分组桶）。

### 7.1 v3 是什么

- 成功响应 **`meta.apiVersion` 为 `"3"`**。
- **层控 + 层 BIN**：`INFCONTROL` ⋈ `INFLAYERBINLIST`（`KEYNUMBER`），且 **`PASSTYPE='TEST'`**；主库 Oracle（Dummy 时 **JBStart** 样本，**§4**）。
- **产量触发器**：表 **`YMWEB_YIELDMONITORTRIGGER`**，v3 列表为 **`SELECT *`**；**固定** **`TYPE = delta_diff`**（与 delta-diff 样本一致）；probeweb（Dummy 时 **delta-diff** 样本，**§4**）。
- **调用侧牢记**：(1) 字符串筛选 **`UPPER(TRIM)`** 不区分大小写；(2) 列表用 **`FETCH FIRST :lim`**；(3) 全量统计必须用 **`…/v3/aggregate`**，勿用 **`limit`** 代替。

### 7.2 列表与聚合差在哪

| 类型 | 行为 | 类比 |
| --- | --- | --- |
| **v3 列表** | 筛选 → 排序 → 最多 **500** 条明细 | 账本里按时间只复印最新 N 页 |
| **v3 聚合** | **同一筛选** 下对**全部匹配行**汇总（层控 **SUM(BIN)**；产量 **COUNT**） | 把符合条件页全部统计 |

### 7.3 推荐步骤

1. **`GET /api/v3/manifest`**。2. 用 **§8.1** 选 **v3** 路径。3. **`encodeURIComponent`** 拼 URL。4. 可选 **`X-Request-Id`**。5. 读 **`rows`** / **`groups`** / **`totalRowsMatching`**。6. 无数据多为 **HTTP 200**、空数组。

### 7.4 层控 v3 在答什么

**`/infcontrol-layer-bins/v3`**：层控 ⋈ 层 BIN 明细，行内含 **`bins`** enrich，另含 **`PROBECARDTYPE`**（**`CARDID`** 在首个 **`-`** 前的段，见 **`probeCardTypeLeadingSegment`**），适合按行排查。**`/infcontrol-layer-bins/v3/aggregate`**：与 **同路径下 v3 列表**同一套 **WHERE**，对全量行 **UNPIVOT + SUM**；**`groupBy`** 须**恰好含一个 `bin`**。**SUM 仅累计坏 bin 的 die**：**`PASSBIN`** 按 **`-`** 拆成的整段下标视为 **good**（与列表 **`bins[].isGoodBin`**、与 **`/infcontrol-layer-bins/v2/top-bad-bins`** 的 token 规则一致），这些列不计入；**不同于** **`GET …/infcontrol-layer-bins/aggregate`**（v1：BIN1 恒排除 + 仅 **N-M** 两端排除）。聚合 URL **必须**含路径段 **`/v3/`**。

### 7.5 产量 v3 在答什么

**`/yield-monitor-triggers/v3`**：全列、**仅 `TYPE = delta_diff`**、时间降序、**`FETCH FIRST`**；**不支持** **`type`** 查询参数（**`filters.typeScope`** 恒 **`delta_diff`**）；每行另含 **`dutNumber`**（**`TRIGGER_LABEL`**）与 **`PROBECARDTYPE`**（**`PROBECARD`** 在首个 **`-`** 前的段）。**`/yield-monitor-triggers/v3/aggregate`**：**必填 `dimensions`**（1～5 维；**不允许**含 **`type`**），**`timeDay`** 与 **`timeHour`** 勿同现。旧路径 **`GET …/yield-monitor-triggers/aggregate`**（无 **`v3`**）**未挂载**，返回 **404**；全量计数只用 **`…/v3/aggregate`**（manifest **`deprecatedEndpoints`** 有说明）。

### 7.6 `GET /api/v3/infcontrol-layer-bins/v3/aggregate`：作用、通俗理解、传参示例

**白话概要**：见 **§7.0** 对照表中「层控 BIN」一行。

**路径**：须为 **`http://10.192.130.89:30008/api/v3/infcontrol-layer-bins/v3/aggregate`**（**不得省略** **`/v3/`** 段）。

**作用（官方一句话）**：与 **`GET …/infcontrol-layer-bins/v3` 列表**使用**同一套 v3 筛选**（`PASSTYPE='TEST'` + v3 的 AND；字符串 **`UPPER(TRIM)`**），在**全部匹配明细行**上把 **BIN0…BIN255** 先 **UNPIVOT** 再按 **`groupBy`** 维度 **SUM**，按合计降序取前 **`groupTop`** 组。**计入 SUM 的仅为坏 bin**：**`PASSBIN`** 中 **`-`** 分隔的整段下标（**0…255**）为 **good bin**（与列表 **`bins[].isGoodBin`**、**`/infcontrol-layer-bins/v2/top-bad-bins`** 一致），对应列 die **不计入**；**不是** v1 **`/infcontrol-layer-bins/aggregate`** 的「BIN1 恒排除 + 仅 **N-M** 两端」规则。响应里的 **`groups[].count`** 是 **SUM（坏 bin die 累计）**；**`totalRowsMatching`** 是满足筛选的**明细行数**。

**通俗理解**：先把「某 device / lot / 时间窗里所有层测行」圈出来，再把每一行里**非 good**的各个 BIN 列上的数字拆平后加总，最后回答「**哪一个（或哪一组 device+BIN）坏 bin 合计 die 最多**」。若只关心「哪个 BIN 号合计最高」，用 **`groupBy=bin`**（或**省略** **`groupBy`**，服务端默认等价 **`bin`**）；若关心「**每个 device 各自**哪些 BIN 最高」，用 **`groupBy=device,bin`**；若要与产量侧命名对齐、按 **探针卡标识（库列 `PROBE`）** 分桶，用 **`groupBy=probeCard,bin`**（与 **`probe,bin`** 二选一）。

**聚合专用参数**

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| **`groupBy`** | 否 | 逗号分隔，**须恰好出现一次** **`bin`**。可**整体省略**，省略时服务端等价 **`bin`**。可与 **`device`**、**`lot`**、**`slot`**、**`tstype`**、**`cardId`**、**`testerId`**、**`probe`**、**`probeCard`**（二者对应同一列 **`PROBE`**，**不可同一条请求里同时出现**）等复合（维度名与组合上限以 manifest **`…/v3/aggregate`** 的 **`queryParameters`** 为准；**WHERE** 走 **`parseInfcontrolLayerBinsV3Query`**）。 |
| **`groupTop`** | 否 | 返回多少组，默认 **10**，最大 **50**。 |

**实现与 Dummy（须与 Oracle 一致）**

| 项 | 说明 |
| --- | --- |
| **Oracle** | **`buildInfcontrolLayerBinAggregateSql(where, groupBy, "v3-hyphen-tokens")`**（`src/lib/infcontrolLayerBinAggregate.ts`）：UNPIVOT 后按 **`TRIM(PASSBIN)`** 做与 **`/infcontrol-layer-bins/v2/top-bad-bins`** 相同的 **整段 token** 匹配（拼接 **`bin_idx`** 至正则，见源码），命中则该 die **不计入 SUM**。 |
| **Dummy（JBStart）** | **`aggregateInfcontrolLayerBinV3DummyRows`** 内 **`forEachBadBinDieContribution`**（`src/lib/infcontrolLayerBinDummy.ts`）：与 **`parsePassBinHyphenGoodBins`**、**`/v2/top-bad-bins`** 的 dummy 累计**同一套**循环；**die 为 0** 的列不参与加总。 |
| **列表对照** | v3 列表行内 **`bins[].isGoodBin`** 由同一 **`PASSBIN`** 分段规则得出（`passBinSemantics.ts` → **`enrichInfcontrolLayerBinRowV2`**）。 |

**与 v3 列表相同的筛选（节选）**：**`device`**、**`lot`**、**`slot`**、**`meslot`**、**`testerId`**、**`tstype`**、**`cardId`**、**`passId`**；**`testEndBegin` / `testEndEnd`**（或 **`testEndFrom` / `testEndTo`**，与 v3 解析器别名兼容）；**`testStart*`** 等同理。全部 **AND**；时间用 **ISO 8601**（建议 UTC + **`Z`**）。

**传参示例**（以下为当前联调环境可直接复制的 URL）

下面每条都保持「**标题 → 人话拆解 → `GET …`**」：**人话**说明这条 URL 在业务上问什么、**各 query 起什么作用**；复制时整行即可。

1. **只按 BIN 排名**（显式 **`groupBy=bin`**），与常见联调 URL 一致：

- **人话**：在料号 **`WB10N57U`**、**`TESTEND` 落在 2026-05-13 这一天的 UTC 时间窗** 内，把所有命中行的**坏 bin die** 按 **BIN 号**跨行加总，返回 **合计最高的 10 个 BIN**（`groupTop=10`）。**`groupBy=bin`** 表示分组键里**只有 BIN**，不区分 lot / slot 等——「全局在这批数据里，哪几个 BIN 最糟」。
- **参数**：**`device`** 收窄料号；**`testEndBegin` / `testEndEnd`** 收窄测试结束时间；**`groupBy=bin`** 按 BIN 聚合；**`groupTop`** 控制排行榜长度。

```http
GET http://10.192.130.89:30008/api/v3/infcontrol-layer-bins/v3/aggregate?device=WB10N57U&testEndBegin=2026-05-13T00:00:00.000Z&testEndEnd=2026-05-13T23:59:59.999Z&groupBy=bin&groupTop=10
```

2. **复合维度**：按 **device + BIN** 看「每个料号下各 BIN 合计」，仍取合计最高的 5 组：

- **人话**：分组键是 **「料号 + BIN 号」** 一对（**`groupBy=device,bin`**）。本例仍写了 **`device=WB10N57U`**，所以在数据上多半等价于「**这个料号里**合计最高的 5 个 BIN」，但响应里 **每一组会同时带 `device` 与 `bin` 字段**——当你**去掉**固定 `device`、一次查多料号时，可以直接读出「**哪个料号的哪个 BIN**」在榜上，而不用猜。
- **参数**：时间窗同上；**`groupBy=device,bin`** 决定「桶」的粒度；**`groupTop=5`** 只保留合计最高的 5 个桶。

```http
GET http://10.192.130.89:30008/api/v3/infcontrol-layer-bins/v3/aggregate?device=WB10N57U&testEndBegin=2026-05-13T00:00:00.000Z&testEndEnd=2026-05-13T23:59:59.999Z&groupBy=device,bin&groupTop=5
```

3. **更窄圈选**：叠加 **lot / slot / tstype / cardId**（与 **v3 列表**相同键名），再按 BIN Top 10：

- **人话**：在示例 1 的「料号 + 日」基础上，再用 **批号 lot、槽位 slot、测试类型 tstype、卡号 cardId** 把范围缩到**更小的一撮测试**，再问「这撮里坏 bin die 合计最高的 10 个 BIN」。适合已经知道「**就是这条 lot、这张卡、这类 CP**」时的 drill-down。
- **参数**：**`lot` / `slot` / `tstype` / `cardId`** 与列表接口含义相同（字符串 **`UPPER(TRIM)`** 匹配）；与 **`device` + 时间窗** 一起 **AND**；**`groupBy=bin`** 仍表示只按 BIN 排名。

```http
GET http://10.192.130.89:30008/api/v3/infcontrol-layer-bins/v3/aggregate?device=WB10N57U&lot=NF12615.1X&slot=1&tstype=CP&cardId=9400-01&testEndBegin=2026-05-13T00:00:00.000Z&testEndEnd=2026-05-13T23:59:59.999Z&groupBy=bin&groupTop=10
```

更多 **HTTP / curl** 见 **§8.5**。

### 7.7 `GET /api/v3/yield-monitor-triggers/v3/aggregate`：作用、通俗理解、传参示例

**白话概要**：见 **§7.0** 对照表中「产量触发」一行。

**路径**：须为 **`http://10.192.130.89:30008/api/v3/yield-monitor-triggers/v3/aggregate`**（**含** **`/v3/`**）。无 **`v3`** 的旧聚合路径未挂载（**404**），见 **§7.5**。

**作用**：与 **`GET …/yield-monitor-triggers/v3` 列表**使用**同一套 v3 WHERE**（**固定 `TYPE = delta_diff`**；字符串 **`UPPER(TRIM)`**；**`timeStampBegin`/`End`** 或 **`From`/`To`** 等），在**全部匹配行**上做 **`COUNT(*)`** + **`GROUP BY dimensions`**，按计数降序取前 **`groupTop`** 组。响应 **`groups[].count`** 为**该维度组合下的触发条数**；**`totalRowsMatching`** 为筛选后的**总行数**。

**通俗理解**：先在「某段时间、某台机台 / 某批料号」里圈出 **delta_diff** 触发记录，再按你选的 **`dimensions`** 做「**每个桶里有多少条**」——例如 **`device,hostname`** 看各料号在各机台上各触发多少次；**`timeDay`** 看**自然日**趋势；**`hostname`** 看哪台机触发最多。**v3 不提供**按库列 **`TYPE`** 的 **`type`** 查询参数，也**不能**把 **`type`** 写进 **`dimensions`**。列表每行仍含 **`TYPE`** 列；因服务端固定筛选，这些行在语义上均为 **delta_diff**。

**聚合专用参数**

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| **`dimensions`** | **是** | 逗号分隔 **1–5** 项。允许取值：`device`、`hostname`、`lotId`、`wafer`、`probeCard`、`probeCardType`（**`PROBECARD`** 首个 **`-`** 前段，与列表 **`PROBECARDTYPE`** 一致）、`pass`、`triggerLabel`、**`timeDay`**（按日历日）、**`timeHour`**（按整点）。**`timeDay` 与 `timeHour` 不得同时出现**。 |
| **`groupTop`** | 否 | 返回多少组，默认 **25**，最大 **100**。 |

**与 v3 列表相同的筛选（节选）**：**固定 `TYPE = delta_diff`**（**`filters.typeScope`**）；**`hostname`**、**`device`**、**`lotId`**、**`wafer`**、**`probeCard`**、**`pass`**；**`timeStampBegin` / `timeStampEnd`**（或 **`timeStampFrom` / `timeStampTo`**）。全部 **AND**。**不支持** **`type`** 查询参数（传入 **`type=…`** 会得到 **400** **`VALIDATION_ERROR`**）。

**传参示例**（以下为当前联调环境可直接复制的 URL）

同样采用「**标题 → 人话拆解 → `GET …`**」：**`dimensions`** 决定「按什么维度分桶数条数」；**`groupTop`** 决定返回前几名桶；时间与其它键先 **WHERE 收窄**，再 **GROUP BY**。

1. **按料号 + 机台**看分布（同一天 UTC 窗）：

- **人话**：在 **2026-05-13 整日** 的触发记录里，按 **「料号 device + 机台 hostname」** 两个字段一起分桶，**每个桶里数有多少条触发**（`COUNT(*)`），返回 **触发次数最多的 20 个 (device, hostname) 组合**。用来回答「**这天里，哪几个料在哪些机台上报得最多**」。
- **参数**：**`dimensions=device,hostname`** 就是分组维度；**`timeStampBegin` / `timeStampEnd`** 圈时间；**`groupTop=20`** 控制榜单长度。

```http
GET http://10.192.130.89:30008/api/v3/yield-monitor-triggers/v3/aggregate?dimensions=device,hostname&timeStampBegin=2026-05-13T00:00:00.000Z&timeStampEnd=2026-05-13T23:59:59.999Z&groupTop=20
```

2. **按机台**看谁触发最多：

- **人话**：同一天窗内，只按 **机台 hostname** 分桶，**每台机器有多少条触发**，取前 **15** 台。用来回答「**是不是某几台机特别爱报**」。
- **参数**：**`dimensions=hostname`** 只有一维；未传 `device`/`lotId` 等，表示**不额外收窄**（除非你在别处加了筛选键）。

```http
GET http://10.192.130.89:30008/api/v3/yield-monitor-triggers/v3/aggregate?dimensions=hostname&timeStampBegin=2026-05-13T00:00:00.000Z&timeStampEnd=2026-05-13T23:59:59.999Z&groupTop=15
```

3. **按自然日 + 机台**看趋势（不要与 **`timeHour`** 同用）：

- **人话**：先看 **`device=WA03P02G`** 这一条料，在 **2026-05 整月** 内，按 **「日历日 + 机台」** 分桶：每个桶是「**某一天 + 某一 hostname**」，**`count`** 是当天该机台的触发条数；取合计最高的 **30** 个桶。用来回答「**这个月里，哪一天、哪台机冒得最凶**」（注意：**`timeDay` 与 `timeHour` 不能同一条 URL 里一起用**）。
- **参数**：**`device`** 属于与列表相同的筛选键（先缩小行集）；**`dimensions=timeDay,hostname`** 决定怎么分组；**`groupTop=30`** 限制返回组数。

```http
GET http://10.192.130.89:30008/api/v3/yield-monitor-triggers/v3/aggregate?dimensions=timeDay,hostname&device=WA03P02G&timeStampBegin=2026-05-01T00:00:00.000Z&timeStampEnd=2026-05-31T23:59:59.999Z&groupTop=30
```

4. **先收窄再聚合**：例如某 **lotId** 下各 **探针卡 probeCard** 计数：

- **人话**：先用 **`lotId=DR31388.1N`** 把数据限定到这一批 wafer/lot，再在 **2026-01 整月** 内只按 **probeCard** 分桶——每个桶一张探针卡，**`count`** 是该 lot 下该卡的触发条数，取前 **10**。典型用法：**已经锁定 lot**，想看「**这批里主要是哪几张卡在刷屏**」。
- **参数**：**`lotId`** 与列表一致，参与 **WHERE**；**`dimensions=probeCard`** 表示分组只有一维；时间窗同上。

```http
GET http://10.192.130.89:30008/api/v3/yield-monitor-triggers/v3/aggregate?dimensions=probeCard&lotId=DR31388.1N&timeStampBegin=2026-01-01T00:00:00.000Z&timeStampEnd=2026-01-31T23:59:59.999Z&groupTop=10
```

更多 **HTTP / curl** 见 **§8.7**。

### 7.8 文档与源码分工

- **`docs/API_V3.md`**：v3 **列表** SQL（`npm run docs:api-v3` 再生）。
- **聚合**：**`yieldMonitorTriggerV3Aggregate.ts`**、**`infcontrolLayerBinV3Aggregate.ts`**（层控 UNPIVOT 与 **`infcontrolLayerBinAggregate.ts`** 共用 SQL 片段）。

---

## 8. URL 与 curl 快速参考

**联调示例根**：**`http://10.192.130.89:30008`**（全文 **`GET`** / **`curl`** 均基于此根，可直接复制到浏览器或终端测试）。**v3** 业务语义见 **§7**；探活与 manifest 见 **§6**。**Dummy** 一律以 **§4** 为准。

**不要**在站点根末尾加 **`/api/v3`** 或 **`/api/v1`**（见 **§2.0**，避免 **`/api/v3/api/v3/...`**）。所有路径均为 **GET**；查询参数键名 **大小写不敏感**。

**Postman**：地址栏填完整 URL（例如 **`http://10.192.130.89:30008/api/v3/yield-monitor-triggers/v3/aggregate?dimensions=device,hostname&...`**），不要写 `GET http://...` 前缀。**curl / PowerShell**：整条命令可复制运行。

### 8.1 一览表

| # | 路径 | 用途 | 查询参数 |
| --- | --- | --- | --- |
| 1 | `/health` | 进程存活，不连库 | 无 |
| 2 | `/api/v3/manifest` | **推荐**：v3 专用目录（**`catalogScope`**: **`v3-surfaces-only`**） | 无 |
| — | `/api/v1/manifest` | 全量目录（兼容旧版；**`catalogScope`**: **`full`**） | 无 |
| 3 | `/api/v3/infcontrol-layer-bins/v3` | v3 层控 ⋈ 层 BIN 列表 | 见 **§8.4** |
| 4 | `/api/v3/infcontrol-layer-bins/v3/aggregate` | v3 层控 BIN 全量聚合 | **groupBy**、**groupTop** + 与 **§8.4** 同款筛选；见 **§8.5** |
| 5 | `/api/v3/yield-monitor-triggers/v3` | v3 产量触发器列表 | 见 **§8.6** |
| 6 | `/api/v3/yield-monitor-triggers/v3/aggregate` | v3 产量 `COUNT` 聚合 | **dimensions**、**groupTop** + **§8.6** 同款筛选；见 **§8.7** |
| 7 | `/api/v3/db/ping` | 主 Oracle：`SELECT 1 FROM DUAL` | 无 |
| 8 | `/api/v3/table-rows` | 开发用：表前 N 行 | **table**、**limit** |

已移除路由（勿调用）：`GET /api/v3/yield-monitor-triggers/aggregate`（见 manifest **`deprecatedEndpoints`**）。

---

### 8.2 `GET /health`

| 项 | 说明 |
| --- | --- |
| **用途** | 负载均衡 / 探活；**不访问 Oracle**。 |
| **查询参数** | 无 |
| **成功响应** | `{"status":"ok","service":"pcr-ai-api"}` |

```http
GET http://10.192.130.89:30008/health
```

```bash
curl -sS "http://10.192.130.89:30008/health"
```

```powershell
Invoke-RestMethod -Uri "http://10.192.130.89:30008/health"
```

---

### 8.3 `GET /api/v3/manifest`（与 **`GET /api/v1/manifest`**）

| 项 | 说明 |
| --- | --- |
| **用途** | **`/api/v3/manifest`**：v3 专用目录（见文首表）。**`/api/v1/manifest`**：全量目录，**`path`** 仍为 **`/api/v1/...`**。 |
| **查询参数** | 无 |

#### 推荐：`GET /api/v3/manifest`

```http
GET http://10.192.130.89:30008/api/v3/manifest
```

```bash
curl -sS "http://10.192.130.89:30008/api/v3/manifest"
```

#### 兼容：`GET /api/v1/manifest`（全量）

```http
GET http://10.192.130.89:30008/api/v1/manifest
```

```bash
curl -sS "http://10.192.130.89:30008/api/v1/manifest"
```

---

### 8.4 `GET /api/v3/infcontrol-layer-bins/v3`（v3 · 列表）

**说明**：与 **§7** 层控 v3 说明一致；**数据源与 Dummy** 见 **§4**。查询键名与字符串筛选值均**不区分大小写**（`UPPER(TRIM)`）。完整 **SQL 模板与 BIN 展开**见 [**API_V3.md**](./API_V3.md) 与 **`src/lib/apiV3ListSql.ts`**。响应 **`rows[]`** 在 **`bins`** enrich 之外另含 **`PROBECARDTYPE`**（**`CARDID`** 首个 **`-`** 前段；**`null`** 表示空或无前段），Oracle 与 Dummy 同源实现见 **`probeCardTypeLeadingSegment`**（**`src/lib/probeCardTypeLeadingSegment.ts`**）与 **`src/routes/api.ts`**；Dummy 在 **`filterInfcontrolLayerBinV3DummyRowsMatching`** 写入该字段，**`filterInfcontrolLayerBinV3DummyRows`** 仅排序截断。**若请求未带任一 `testStart*` / `testEnd*` 键**，服务端追加 **`t2.TESTEND`** 默认在 **UTC 当前起向前一个日历年**内（**`filters`** 回显 **`testEndBegin` / `testEndEnd`**），与 **§8.5** 聚合一致。

| 参数 | 含义 |
| --- | --- |
| `limit` | 默认 **200**，最大 **500**（参数名 **`Limit` / `LIMIT`** 等亦可） |
| `device`, `lot`, `slot`, `meslot`, `testerId`, `tstype`, `cardId`, `passId` | 见 **§7** 与 **API_V3.md** 层控 v3 表 |
| `testStartBegin` / `testStartEnd`（或 `testStartFrom` / `testStartTo`） | **TESTSTART** 时间窗 |
| `testEndBegin` / `testEndEnd`（或 `testEndFrom` / `testEndTo`） | **TESTEND** 时间窗 |

```http
GET http://10.192.130.89:30008/api/v3/infcontrol-layer-bins/v3?device=WB10N57U&lot=NF12615.1X&testEndBegin=2026-05-13T00:00:00.000Z&testEndEnd=2026-05-13T23:59:59.999Z&limit=200
```

```bash
curl -sS "http://10.192.130.89:30008/api/v3/infcontrol-layer-bins/v3?device=WB10N57U&limit=200"
```

---

### 8.5 `GET /api/v3/infcontrol-layer-bins/v3/aggregate`（v3 · 聚合）

**说明**：与 **§7.6**（作用、通俗、传参示例）一致；**`documentation`** 为固定中文说明（与响应体 **`documentation`** 字段同源摘要）。筛选参数与 **§8.4** 相同，另须 **`groupBy`**（须含 **`bin`** 一次）、**`groupTop`**。**SUM 仅计坏 bin**（**`PASSBIN`** **`-`** 分隔的 good 下标不计入，与 v3 列表 **`isGoodBin`** 一致；**§7.6** 表列 Oracle / Dummy 实现）。**`/api/v3/`** 为全局前缀；路径须含 **`/infcontrol-layer-bins/v3/aggregate`**。

```http
GET http://10.192.130.89:30008/api/v3/infcontrol-layer-bins/v3/aggregate?device=WB10N57U&testEndBegin=2026-05-13T00:00:00.000Z&testEndEnd=2026-05-13T23:59:59.999Z&groupBy=bin&groupTop=10
```

```bash
curl -sS "http://10.192.130.89:30008/api/v3/infcontrol-layer-bins/v3/aggregate?device=WB10N57U&groupBy=device,bin&groupTop=5&testEndBegin=2026-05-13T00:00:00.000Z&testEndEnd=2026-05-13T23:59:59.999Z"
```

**带「人话」逐条拆解的 HTTP 示例**见 **§7.6**（与上表同一批 URL，便于对照参数含义）。

---

### 8.6 `GET /api/v3/yield-monitor-triggers/v3`（v3 · 列表）

**说明**：与 **§7** 产量 v3 说明一致；**数据源与 Dummy** 见 **§4**。服务端**恒** **`WHERE TYPE = delta_diff`**（与 **`filters.typeScope`** 一致）。查询键名与字符串筛选值均**不区分大小写**。SQL 模板见 [**API_V3.md**](./API_V3.md) 与 **`buildYieldMonitorTriggersV3Sql`**。响应 **`rows[]`** 另含 **`dutNumber`**（**`TRIGGER_LABEL`**）与 **`PROBECARDTYPE`**（**`PROBECARD`** 首个 **`-`** 前段；**`null`** 表示空或无前段），见 **`src/lib/yieldTriggerLabelDut.ts`**、**`src/lib/probeCardTypeLeadingSegment.ts`**、**`src/routes/api.ts`**；Dummy 在 **`filterYieldMonitorDummyRowsMatchingV3`** 写入 **`PROBECARDTYPE`**，**`filterYieldMonitorDummyRowsV3`** 仅排序截断。**若请求未带任一 `timeStamp*` 键**，服务端追加 **`TIME_STAMP`** 默认在 **UTC 当前起向前一个日历年**内（**`filters`** 回显 **`timeStampBegin` / `timeStampEnd`**），与 **§8.7** 聚合一致。

| 参数 | 含义 |
| --- | --- |
| `limit` | 默认 **200**，最大 **500**（参数名 **`Limit` / `LIMIT`** 等亦可） |
| `hostname`, `device`, `lotId`, `pass`, `wafer`, `probeCard` | 字符串列 **`UPPER(TRIM)`** 与入参比较；**`pass`** 仍为数值全等；**不支持** **`type`** 查询参数 |
| `timeStampBegin` / `timeStampEnd`（或 `timeStampFrom` / `timeStampTo`） | **TIME_STAMP** 时间窗 |

```http
GET http://10.192.130.89:30008/api/v3/yield-monitor-triggers/v3?device=WA03P02G&timeStampBegin=2026-05-13T00:00:00.000Z&timeStampEnd=2026-05-13T23:59:59.999Z&limit=200
```

```bash
curl -sS "http://10.192.130.89:30008/api/v3/yield-monitor-triggers/v3?limit=100"
```

---

### 8.7 `GET /api/v3/yield-monitor-triggers/v3/aggregate`（v3 · 聚合）

**说明**：与 **§7.7**（作用、通俗、传参示例）一致；**WHERE** 含固定 **`TYPE = delta_diff`**；**必填 `dimensions`**（**不得**含 **`type`**）；**`documentation`** 为固定中文说明。时间窗等筛选与 **§8.6** 相同。

```http
GET http://10.192.130.89:30008/api/v3/yield-monitor-triggers/v3/aggregate?dimensions=device,hostname&timeStampBegin=2026-05-13T00:00:00.000Z&timeStampEnd=2026-05-13T23:59:59.999Z&groupTop=20
```

```bash
curl -sS "http://10.192.130.89:30008/api/v3/yield-monitor-triggers/v3/aggregate?dimensions=hostname&timeStampBegin=2026-05-13T00:00:00.000Z&timeStampEnd=2026-05-13T23:59:59.999Z"
```

**带「人话」逐条拆解的 HTTP 示例**见 **§7.7**。

---

### 8.8 `GET /api/v3/db/ping`

| 项 | 说明 |
| --- | --- |
| **用途** | 检查**主 Oracle 连接池**；失败时 **500**，**`code`** 常为 **`ORACLE_PING_FAILED`**。 |
| **查询参数** | 无 |

```http
GET http://10.192.130.89:30008/api/v3/db/ping
```

```bash
curl -sS "http://10.192.130.89:30008/api/v3/db/ping"
```

---

### 8.9 `GET /api/v3/table-rows`

| 参数 | 说明 |
| --- | --- |
| `table` | 可选；`TABLE` 或 **`OWNER.TABLE`**；不传则用环境变量 **`ORACLE_DEFAULT_TABLE`** |
| `limit` | 可选；默认 **50**，最大 **500** |

```http
GET http://10.192.130.89:30008/api/v3/table-rows?table=MY_TABLE&limit=50
```

```http
GET http://10.192.130.89:30008/api/v3/table-rows?table=SCHEMA.MY_TABLE&limit=100
```

```bash
curl -sS "http://10.192.130.89:30008/api/v3/table-rows?limit=20"
```

---

### 8.10 Dummy 与 Oracle（已迁移）

**Dummy、v3 与 `dist` / production 的完整规则**已统一写在 **§4**。本节不再维护重复表格；排障请直接打开 **§4**。

---

## 9. 与仓库源码的对应关系

| 文档概念 | 源码位置 |
| --- | --- |
| **Claude Code 入口索引** | 仓库根 **`CLAUDE.md`**（指向本页与 `API_V3.md`） |
| 路由挂载 | `src/app.ts`：**`/api/v1`** 与 **`/api/v3`** → 同一 **`apiRouter`** |
| Manifest 静态定义 | `src/lib/apiManifest.ts`（**`GET …/manifest`** 响应由 **`buildManifestResponseJson`** 按挂载前缀改写 **`path`** / **`example`**） |
| **`/api/v3` manifest 改写** | `src/lib/rebaseApiManifest.ts` |
| 各 GET 实现 | `src/routes/api.ts` |
| **v3 默认一年 `TESTEND` / `TIME_STAMP`（无时间查询键时）** | `src/lib/v3DefaultOneYearWindow.ts`；`parseInfcontrolLayerBinsV3Query`、`parseYieldMonitorTriggerV3Query` |
| **v3 列表 `PROBECARDTYPE`（非 SQL 列）** | `src/lib/probeCardTypeLeadingSegment.ts`；`api.ts` 中 **`enrichInfcontrolLayerBinV3ListRow`** / **`enrichYieldMonitorTriggerV3ListRow`**；Dummy 写入：**`filterInfcontrolLayerBinV3DummyRowsMatching`**、**`filterYieldMonitorDummyRowsMatchingV3`**；列表截断：**`filterInfcontrolLayerBinV3DummyRows`**、**`filterYieldMonitorDummyRowsV3`** |
| **v3 产量 SQL 模板** | `src/lib/apiV3ListSql.ts`（`buildYieldMonitorTriggersV3Sql`） |
| **v3 产量筛选解析** | `src/lib/yieldMonitorTriggerFilters.ts`（`parseYieldMonitorTriggerV3Query`） |
| **v3 产量 `COUNT` 聚合** | `src/lib/yieldMonitorTriggerV3Aggregate.ts` |
| **v3 层控 SQL 模板** | `src/lib/apiV3ListSql.ts`（`buildInfcontrolLayerBinsV3Sql`） |
| **v3 层控筛选解析** | `src/lib/infcontrolLayerBinFilters.ts`（`parseInfcontrolLayerBinsV3Query`） |
| **v3 列表 `limit` 键名（不区分大小写）** | `src/lib/sqlIdent.ts`（`clampLimitFromQuery`） |
| **v3 层控 BIN 聚合（WHERE 适配）** | `src/lib/infcontrolLayerBinV3Aggregate.ts` |
| **层控 BIN UNPIVOT + SUM（v1 聚合 / v3 聚合共用）** | `src/lib/infcontrolLayerBinAggregate.ts`（v3 路由传第三参 **`"v3-hyphen-tokens"`** 时 SUM 仅坏 bin） |
| infcontrol dummy（含 **v3** 列表/聚合内存路径） | `src/lib/infcontrolLayerBinDummy.ts`（**`forEachBadBinDieContribution`** 与 **`/v2/top-bad-bins`** dummy 共用坏 bin die 规则；**`aggregateInfcontrolLayerBinV3DummyRows`**） |
| 产量监控 dummy（含 **v3** 列表/聚合内存路径） | `src/lib/yieldMonitorTriggerDummy.ts`（`filterYieldMonitorDummyRowsMatchingV3`、`aggregateYieldMonitorV3DummyRows`） |
| **Dummy 与 `dist`/production 强制走库** | `src/lib/listDummyRuntime.ts` |
| **PASSBIN** 分段 good（v3 列表 **`isGoodBin`** / v3 聚合 / v2 top-bad dummy） | `src/lib/passBinSemantics.ts`（**`parsePassBinHyphenGoodBins`**）；v1 列表 **`passBinPair` / `bins[].isGood`** 另见同文件 **`parsePassBinPair`**、**`enrichInfcontrolLayerBinRow`** |
| 错误 JSON | `src/lib/agentResponse.ts` |
| Request ID | `src/middleware/requestId.ts` |

部署与环境变量示例见仓库根目录 `.env.example`；**正式环境 PM2 发布（`npm ci`、`npm run build`、`pm2 start/reload` 等）见 [`docs/DEPLOY_PM2.md`](./DEPLOY_PM2.md)。

**快速跳转**：全部 URL 示例与 curl 见 **§8**。
