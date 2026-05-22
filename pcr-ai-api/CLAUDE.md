# Claude Code 交接说明（pcr-ai-api）

本文档供 **Claude Code**、Cursor Agent 或其它自动化在**接手本包**时快速对齐上下文。更细的 HTTP 语义、Dummy 规则、可复制 URL 以 **[`docs/AI_AGENT_API.md`](docs/AI_AGENT_API.md)** 为准（文内 **§5** 另有「可贴系统提示」的短清单）。

---

## 1. 本包是什么

- **只读 REST**：业务接口均为 **GET**，返回 **JSON**。
- **数据源**：默认 **Oracle**（主库连接池 + **probeweb** 连接池，产量触发器走 probeweb）。
- **联调 / 无库**：在符合规则时可走 **Excel 内存样本**（与真库响应**形状**一致），见 **§3**。

---

## 2. 必读文档（优先级）

| 顺序 | 文件 | 用途 |
| --- | --- | --- |
| 1 | [`docs/AI_AGENT_API.md`](docs/AI_AGENT_API.md) | **主手册**：manifest、Dummy、v3 通俗说明、§8 curl、错误码、§9 源码索引 |
| 1b | [`docs/SITE_BIN_BY_LOT_API.md`](docs/SITE_BIN_BY_LOT_API.md) | **site-bin-bylot 用法**：curl / Dummy URL / `fetch` 示例 |
| 1c | [`../docs/SITE_BIN_BY_LOT_INTEGRATION.md`](../docs/SITE_BIN_BY_LOT_INTEGRATION.md) | **INF map × bin × DUT**：`buildInfPath`、报表下钻、Agent 工具/prompt（UI/Agent 待做） |
| 2 | [`docs/API_V3.md`](docs/API_V3.md) | **v3 列表**完整 SQL（由 `npm run docs:api-v3` 从 `dist` 再生） |
| 3 | [`.env.example`](.env.example) | 环境变量与 Dummy 开关说明 |
| 4 | [`.cursor/rules/dummy-parity.mdc`](.cursor/rules/dummy-parity.mdc) | **Oracle 与 Dummy 双路径必须同步**（改筛选/WHERE/响应形状时必读） |

部署与进程管理见 [`docs/DEPLOY_PM2.md`](docs/DEPLOY_PM2.md)。

---

## 3. Dummy 与 Oracle（一句话 + 变量）

- **`dist` 构建产物**或 **`NODE_ENV=production`** 时：**不启用** Dummy，v3 恒走 Oracle（见 `src/lib/listDummyRuntime.ts`）。
- 开发 / 测试：可通过环境变量让 **v3 层控**、**v3 产量**走内存表：

| 变量 | 影响的典型路径 |
| --- | --- |
| `INFCONTROL_LAYER_BINS_DUMMY=true` | `/api/v3/infcontrol-layer-bins/v3`、`…/v3/aggregate`；**`/api/v4/…/v4`、`…/v4/aggregate`**（样本 `docs/JBStart.xlsx`） |
| `YIELD_MONITOR_TRIGGERS_DUMMY=true` | `/api/v3/yield-monitor-triggers/v3`、`…/v3/aggregate`；**`/api/v4/…/v4`、`…/v4/aggregate`**（样本 `docs/delta-diff.xlsx`） |

**v4（与 v3 并行）**：**`app.ts`** 将同一 **`apiRouter`** 挂在 **`/api/v4`**。**`GET /api/v4/manifest`** 为 v4 精简目录（**`rebaseApiManifest.ts`** → **`V4_CATALOG_CANONICAL_PATHS`**）。

- **v4 列表**：与 **v3 列表**同源（**`parseInfcontrolLayerBinsV3Query`** / **`parseYieldMonitorTriggerV3Query`**、Dummy **`filterInfcontrolLayerBinV3DummyRows`** / **`filterYieldMonitorDummyRowsV3`**、SQL **`buildInfcontrolLayerBinsV3Sql`** / **`buildYieldMonitorTriggersV3Sql`**）；仅 **`meta.apiVersion`** 为 **`"4"`**。

- **v3 `/…/v3/aggregate`**：**Oracle** 库内聚合（层控 **`buildInfcontrolLayerBinAggregateSql(..., "v3-hyphen-tokens")`**；产量 **`buildYieldMonitorTriggerV3AggregateSql`**）；**Dummy** 在 Node（**`aggregateInfcontrolLayerBinV3DummyRows`** / **`aggregateYieldMonitorV3DummyRows`**）。**不使用** **`MEMORY_AGG_ORACLE_MAX_ROWS`**。

- **v4 `/…/v4/aggregate`**：**Oracle 与 Dummy 均在 Node** 对全量匹配行 **`aggregateInfcontrolLayerBinV3FromRows`** / **`aggregateYieldMonitorV3FromRows`**。Oracle 先 **COUNT**（**`buildInfcontrolLayerBinMatchingCountSql`** / **`buildYieldMonitorTriggerMatchingCountSql`**）再 **`buildInfcontrolLayerBinsV3SqlFullMatching`** / **`buildYieldMonitorTriggersV3SqlFullMatching`**；**Dummy 与 Oracle** 若匹配行数 **>** **`MEMORY_AGG_ORACLE_MAX_ROWS`**（**`memoryAggregateOracleLimits.ts`**，见 **`.env.example`**）均 **422**。Oracle 明细行进 **`aggregate*FromRows`** 前经 **`normalizeDbRowKeysUpper`**（**`dbRowKeyUpper.ts`**）统一列名大写。层控解析仍用 **`parseInfcontrolLayerBinsV3AggregateQuery`**（**`listWhereAndSql`**）。

**硬规则**：凡改 v3 的 **WHERE 语义、筛选解析、排序、limit、聚合维度、响应字段**，必须同时改 **Oracle** 与 **`src/lib/*Dummy*.ts`**；涉及 **v4** 时还须检查 **全量 SQL**、**`api.ts` v4 路由**、**`normalizeDbRowKeysUpper`**。**dummy-parity** 仍适用。

**`NODE_ENV=test`** 下单测里 Dummy 行为见 `test/rest-api-v3-dummy.test.ts` 的 `before` 钩子（含 v3 与 v4 断言）。

---

## 4. 产量 v3 当前约定（易漏）

以下已在 **`parseYieldMonitorTriggerV3Query`**（`src/lib/yieldMonitorTriggerFilters.ts`）与 Dummy 的 **`filterYieldMonitorDummyRowsMatchingV3`**（`src/lib/yieldMonitorTriggerDummy.ts`）对齐：

1. **固定 `TYPE = delta_diff`**  
   - SQL：`UPPER(TRIM(t."TYPE")) = UPPER(:v3_type_scope)`，绑定 `delta_diff`。  
   - 响应 **`filters.typeScope`** 恒为 **`delta_diff`**（列表与产量 v3 聚合均继承 `applied`）。  
   - **v1** `GET /yield-monitor-triggers` **不**加此限制，仍可看到 xlsx 中其它 `TYPE`。

2. **禁止查询参数 `type`**  
   - v3 列表 / v3 产量聚合传入 `type=…` → **400** `VALIDATION_ERROR`（与「固定 TYPE 范围」不重复提供）。

3. **`dutNumber`（仅 v3 列表）**  
   - 由 **`TRIGGER_LABEL`** 中 **`on dut# <n>`** 解析（`src/lib/yieldTriggerLabelDut.ts`）；无匹配则为 **`null`**。  
   - Oracle 与 Dummy 均在 **`src/routes/api.ts`** 返回前对行做统一 enrich。

4. **联调示例 URL**  
   - 产量 Dummy 的示例 query 由 **`getYieldMonitorDummyExampleQuery()`** 生成，优先选 **`TYPE=delta_diff`** 行，避免示例时间窗内零命中。

5. **`PROBECARDTYPE`（两条 v3 列表）**  
   - **`GET …/infcontrol-layer-bins/v3`**：由 **`CARDID`** 取**首个 `-` 之前**一段（trim；空 / 无前段则为 **`null`**）。  
   - **`GET …/yield-monitor-triggers/v3`**：由 **`PROBECARD`** 同上。  
   - 实现：**`src/lib/probeCardTypeLeadingSegment.ts`**；路由 **`enrichInfcontrolLayerBinV3ListRow` / `enrichYieldMonitorTriggerV3ListRow`**（**`src/routes/api.ts`**）。Dummy 与 Oracle 同源：**`filterInfcontrolLayerBinV3DummyRowsMatching`**、**`filterYieldMonitorDummyRowsMatchingV3`**（各自 **`src/lib/*Dummy.ts`**）在**筛选全集**上 **`map`** 写入 **`PROBECARDTYPE`**；v3 列表 **`filterInfcontrolLayerBinV3DummyRows`** / **`filterYieldMonitorDummyRowsV3`** 仅排序 + **`limit`** 截断；v3 聚合 Dummy 复用 matching 行，维度 **`probeCardType`** 读行上 **`PROBECARDTYPE`**（空则 **`''`**，对齐 Oracle **`NVL`**）。

6. **v3 默认一年时间窗（列表 + 聚合）**  
   - **层控**：请求**未出现**任一 **testStart\*** / **testEnd\***（共 8 个查询键）时，**`parseInfcontrolLayerBinsV3Query`** 追加 **`t2.TESTEND`** ∈ **[UTC 现在 − 1 日历年, UTC 现在]**（**`src/lib/v3DefaultOneYearWindow.ts`**）。  
   - **产量**：请求**未出现**任一 **timeStamp\***（4 个键）时，**`parseYieldMonitorTriggerV3Query`** 追加 **`t.TIME_STAMP`** 同上。  
   - **v3 aggregate** 复用上述解析器，与列表一致。Dummy 侧读 **`filters`** 中回显的 ISO 时间串，与 Oracle 语义对齐。

7. **LOT 前缀排除（全路径固定 WHERE，2026-05-17）**  
   - 所有 v3/v4 查询（列表、聚合、combined、full-matching）均排除以 **`kk`、`gg`、`c`（忽略大小写）开头**的 LOT，这些属于内部测试批次。  
   - **Oracle**：  
     - 产量：`parseYieldMonitorTriggerV3Query` 追加 `NOT REGEXP_LIKE(t.LOTID, '^(kk|gg|c)', 'i')`  
     - 层控：`parseInfcontrolLayerBinsV3Query` 追加 `NOT REGEXP_LIKE(t1.LOT, '^(kk|gg|c)', 'i')`  
   - 两个聚合 parser（`parseYieldMonitorTriggerV3AggregateQuery` / `parseInfcontrolLayerBinsV3AggregateQuery`）内部调用各自的列表 parser，**自动继承**此过滤；full-matching SQL 同理。  
   - **Dummy**：  
     - `filterYieldMonitorDummyRowsMatchingV3`：过滤 `LOTID` 起始前缀  
     - `filterInfcontrolLayerBinV3DummyRowsMatching`：过滤 `LOT` 起始前缀  
   - **改动此规则时**：必须同步改 Oracle filter 与对应 Dummy matching 函数（dummy-parity 原则）。

---

## 5. 常用命令

```bash
npm ci                 # 依赖
npm run dev            # tsx watch 开发
npm run build          # tsc → dist
npm start              # node dist/server.js
npm run typecheck      # tsc --noEmit
npm test               # tsx --test test/*.test.ts（全部后端测试）
npm run docs:api-v3    # build + 重写 docs/API_V3.md（改 apiV3ListSql / yield 解析与 doc 脚本后跑）
```

改 **`src/lib/apiV3ListSql.ts`** 或 **`scripts/write-api-v3-doc.mjs`** 中与产量 v3 文档相关的模板后，应执行 **`npm run docs:api-v3`** 并提交 **`docs/API_V3.md`**。

---

## 6. 源码速查（改功能从哪进）

| 领域 | 入口 / 说明 |
| --- | --- |
| HTTP 路由 | `src/routes/api.ts`（`apiRouter`；v3/v4 层控与产量列表+聚合、`manifest`、**`GET …/siliconflow/chat`**、**`GET …/inf-analysis/site-bin-bylot`** 等） |
| **INF wafer pass × bin × probe DUT** | **`GET /api/v1/inf-analysis/site-bin-bylot`**（亦挂载 `/api/v3`、`/api/v4`）：**`src/routes/infAnalysisRoutes.ts`** → **`outputSiteBinByLot.ts`** / **`outputSiteBinByLotDummy.ts`**（Dummy 时固定路径走 **`docs/site-bin-bylot-dummy-r_1-1.passes.json`**）→ 否则 **`output_site_bin_bylot.pl --json`**（Perl 内 **`PASS_TYPE='TEST'`** 过滤，与 JB **`PASSTYPE=TEST`** 对齐；跳过 INTERRUPT pass）。Dummy 开关：**`SITE_BIN_BY_LOT_DUMMY`** 或 **`INFCONTROL_LAYER_BINS_DUMMY`**（`dist`/production 恒关）。测试 **`test/outputSiteBinByLot.test.ts`**。集成设计 **[`../docs/SITE_BIN_BY_LOT_INTEGRATION.md`](../docs/SITE_BIN_BY_LOT_INTEGRATION.md)**。 |
| 硅基流动（旧直连 Chat Completions） | **`src/lib/siliconflowChat.ts`**（`callSiliconflowChat`）；路由见 **`api.ts`** **`GET /siliconflow/chat`**；**不依赖 npm 包 `undici`**（严格 TLS 用全局 **`fetch`**，宽松 TLS 用 **`node:https`**） |
| AI Agent（报表聊天页） | **`src/routes/agent.ts`** 挂在 **`POST /api/v4/agent/chat`**，SSE 输出；请求体 **`agentConfig.maxRounds`**（1–20，默认 5；服务端回退 **`AGENT_MAX_ROUNDS`**）；**`retry: true`** 时 **`runAgentLoop(..., { resume: true })`** 从 session 续跑、不重复追加 user 消息。系统提示 **`agentPrompt.ts`**；核心 loop **`agentLoop.ts`**（**工具结果回传后**见 **`historyAwaitingToolSummary`** → **`tool_choice: "none"`** 强制中文总结，见 §11 条目 11）；流式上游 **`agentStream.ts`**（**idle 超时**：有 SSE 字节则重置 **`AGENT_STREAM_TIMEOUT_MS`** 计时，默认 **150000ms**）。SSE 断开须监听 **`res.close`**，勿用 **`req.close`**。 |
| 浏览器 CORS | **`src/lib/corsConfig.ts`** → **`wideOpenCorsMiddleware`**；**`app.ts`** 中于 **`requestIdMiddleware`** 之后挂载；已移除 **`cors` npm 包** |
| v4 聚合行上限（Dummy + Oracle） | **`src/lib/memoryAggregateOracleLimits.ts`**；路由 **`api.ts`** **`…/v4/aggregate`** |
| Oracle 列名大写化（v4 聚合进 FromRows） | **`src/lib/dbRowKeyUpper.ts`** → **`normalizeDbRowKeysUpper`** |
| v4 聚合说明 JSON | `src/lib/apiV4Docs.ts` |
| v3 产量筛选 + 固定 TYPE | `src/lib/yieldMonitorTriggerFilters.ts` → `parseYieldMonitorTriggerV3Query`；常量 `YIELD_MONITOR_V3_TYPE_SCOPE` |
| v3 产量聚合解析 / SQL | `src/lib/yieldMonitorTriggerV3Aggregate.ts`（**`dimensions`** 含 **`probeCardType`** 等） |
| v3 层控 BIN 聚合 **`groupBy`**（含 **`probeCardType`**）/ UNPIVOT SQL | `src/lib/infcontrolLayerBinAggregate.ts`（v3 路由传 **`v3-hyphen-tokens`**） |
| v3 列表 SQL 模板 | `src/lib/apiV3ListSql.ts` → `buildYieldMonitorTriggersV3Sql` |
| 产量 Dummy 加载与筛选 | `src/lib/yieldMonitorTriggerDummy.ts`、`src/lib/dummyRowsFromExcel.ts` |
| 层控 v3 | `src/lib/infcontrolLayerBinFilters.ts`、`infcontrolLayerBinDummy.ts`、`infcontrolLayerBinV3Aggregate.ts` |
| v3 默认一年 **`TESTEND` / `TIME_STAMP`** | **`src/lib/v3DefaultOneYearWindow.ts`**；**`parseInfcontrolLayerBinsV3Query`**、**`parseYieldMonitorTriggerV3Query`**（**`infcontrolLayerBinFilters.ts`**、**`yieldMonitorTriggerFilters.ts`**） |
| v3 列表 **PROBECARDTYPE** | **`src/lib/probeCardTypeLeadingSegment.ts`**；**`src/routes/api.ts`**（**`enrichInfcontrolLayerBinV3ListRow`**、**`enrichYieldMonitorTriggerV3ListRow`**）；Dummy 写入：**`filterInfcontrolLayerBinV3DummyRowsMatching`**、**`filterYieldMonitorDummyRowsMatchingV3`**；列表截断：**`filterInfcontrolLayerBinV3DummyRows`**、**`filterYieldMonitorDummyRowsV3`** |
| manifest 静态定义 | `src/lib/apiManifest.ts`；`/api/v3/manifest` 前缀改写 `src/lib/rebaseApiManifest.ts` |
| Oracle 连接 | `src/oracle.ts`（`withConnection` / `withProbeWebConnection`） |

---

## 7. 机器发现（Agent 工具）

- 联调示例：**`GET http://10.192.130.89:30008/api/v3/manifest`**（**站点根不要**以 `/api/v3` 结尾再拼 path，见 **AI_AGENT_API.md §2.0**）。
- 实现：`buildManifestResponseJson`，路径来自 **`apiManifest.ts`** 经 **`rebaseApiManifest.ts`** 改写为 `/api/v3/...`。

---

## 8. Oracle 客户端、驱动版本与连接池（必读）

### 8.1 为何锁定 `oracledb@5.5.0`（勿随意升到 6.x）

- **`package.json` / `package-lock.json`** 将 **`oracledb` 固定为 `5.5.0`**（`@types/oracledb` 与 **5.x** 对齐）。
- **node-oracledb 6.x** 在 Thick 下要求本机 **Oracle Client ≥ 18.1**，旧环境仅用 **11g Instant Client / ORACLE_HOME** 时会在执行阶段报 **DPI-1050**。
- 多数部署机 **不能改** Oracle 安装路径或系统环境；锁定 **5.5.x** 可在 **不改服务器 Oracle 配置** 的前提下继续使用 **11g 客户端**。
- **升级回 6.x 前**必须先具备 **Instant Client 19+** 并设置 **`ORACLE_INSTANT_CLIENT_LIB_DIR`**，否则勿改依赖版本。

### 8.2 Thick / Thin 与常见错误

- **`src/oracle.ts`**：`bootstrapOracleThick()` 按顺序尝试 **`ORACLE_INSTANT_CLIENT_LIB_DIR`** → **`ORACLE_HOME/lib`** →（Linux）**legacy `/u01/.../client_11.2`** →（Windows）仅 **`ORACLE_CLIENT_CONFIG_DIR`**。
- **Thin** 且库用户使用部分口令校验算法时，查询会报 **NJS-116**；API 在 **`src/lib/agentResponse.ts`** 的 **`enrichOracleDriverDetail`** 中会附带 Thick 部署提示。
- **`src/server.ts`**：当 **`listApisForceOracleNoDummy()`** 为真（生产 / `dist`）且 **`isOracleThickRuntime()`** 为假时，启动会 **`console.warn`**，便于在 **`db/ping` 失败前**发现未启用 Thick。

### 8.3 连接池与排队超时（NJS-040）

- **`src/oracle.ts`**：`createPool` 使用 **`ORACLE_POOL_*` / `ORACLE_PROBEWEB_POOL_*` / `ORACLE_QUEUE_TIMEOUT`**；未设置时默认 **`poolMax=4`**、**`poolIncrement=1`**、**`queueTimeout=60000`** ms。
- **`withConnection` / `withProbeWebConnection`**：借连接后可选 **`ORACLE_CALL_TIMEOUT_MS`**（未设置则**不限制**）；断连类错误会 **`close({ drop: true })`** 以免坏连接还池。
- 可选 **`ORACLE_SLOW_QUERY_LOG_MS`**：大于 0 时，单次池内回调超过该毫秒数会 **`console.warn`**（默认 **0** 关闭）。
- **`ecosystem.config.cjs`**：在加载 **`.env`** 后，将 **`ORACLE_*` 池与客户端相关键** 合并进 PM2 子进程 **`env`**，减少「本机有变量、PM2 子进程拿不到」的情况。

### 8.4 Legacy 11.2 路径

- Linux 若存在 **`/u01/app/oracle/product/client_11.2/lib`**，默认仍会 **尝试** Thick（与历史行为一致）。
- 若在新环境必须禁止该回退：在 **`.env`** 设 **`ORACLE_SKIP_LEGACY_CLIENT_11=true`**（见 **`.env.example`**）。

### 8.5 前端与连接池突发（`pcr-ai-report`）

- **`src/utils/asyncConcurrency.ts`**：`allSettledWithConcurrency` 限制列表 + 多聚合同批请求的并行度；**`REPORT_ORACLE_FANOUT_CONCURRENCY`** 当前为 **1**（完全串行），减轻 **`db/ping` 与多 Tab 同时查询** 时的 **NJS-040**。
- **`App.tsx`**：「检查连接」在 **`/health`** 与 **`db/ping`** 之间 **间隔 200ms**，降低瞬时叠峰。

---

## 9. 交接检查清单（给下一位）

- [ ] 若动 **v4 聚合**：Dummy 与 Oracle **均**遵守 **`MEMORY_AGG_ORACLE_MAX_ROWS`**；Oracle 明细需经 **`normalizeDbRowKeysUpper`** 再 **`aggregate*FromRows`**。  
- [ ] 已读 **AI_AGENT_API.md** 至少 **§0、§4、§7、§8** 中与当前任务相关的节。  
- [ ] 若动 **AI Agent / SSE**：检查 **`src/routes/agent.ts`** 仍使用 **`res.on("close")`** 判断客户端断开；**`retry: true`** 与 **`agentConfig.maxRounds`** 行为与前端 Settings 一致；**工具后总结轮**仍走 **`historyAwaitingToolSummary`** + **`tool_choice: "none"`**（§11 条目 11）；跑 **`npm test`**（含 `test/agentRoute.test.ts`、`test/agentStream.test.ts`、`test/agentConfig.test.ts`、**`test/agentLoop.test.ts`**）。  
- [ ] 若动 v3 产量 / 层控：**Dummy 与 Oracle 两侧**都已改并通过 **`npm test`**。  
- [ ] 若动列表 SQL：**`npm run docs:api-v3`** 已跑且 **`docs/API_V3.md`** 无意外回退。  
- [ ] **`npm run typecheck`** 通过。  
- [ ] 若改 **`PROBECARDTYPE`** 语义：**`probeCardTypeLeadingSegment`**、**`api.ts`** 两处 enrich、Dummy 的 **`filterInfcontrolLayerBinV3DummyRowsMatching`** / **`filterYieldMonitorDummyRowsMatchingV3`**（及聚合维度 **`probeCardType`** 取值）须与 Oracle 同步。  
- [ ] 未误改 **`dist` / production** 下 Dummy 关闭语义（`listDummyRuntime.ts`）。  
- [ ] 若动 **硅基流动 / CORS**：见 **§12**；密钥仅 **`.env`**，勿硬编码。  
- [ ] 若升级 **`oracledb`**：须评估 **§8.1**（6.x 与 **Instant Client 18.1+**）；勿在未升级客户端时升到 6.x。  
- [ ] 若动 **site-bin-bylot**：同步 **`output_site_bin_bylot.pl`**、**`outputSiteBinByLot.ts`**、**`infAnalysisRoutes.ts`**、**`apiManifest.ts`**；服务器需 Perl + INFAnalysis；**`infPath` 须在 API 主机可读**。若做报表/Agent：读 **[`../docs/SITE_BIN_BY_LOT_INTEGRATION.md`](../docs/SITE_BIN_BY_LOT_INTEGRATION.md)**。

---

## 10. 与 AI_AGENT_API 的关系

- **本文件（`CLAUDE.md`）**：仓库内 **Claude Code 入口**——项目结构、命令、Dummy/Oracle 纪律、产量 v3 特殊约定、源码索引。  
- **`docs/AI_AGENT_API.md`**：对外集成与 **可复制 URL** 的完整说明；**§5** 为更短的「系统提示」列表。

二者冲突时以 **源码与 `manifest` 实际行为**为准，并应**更新文档**消除冲突。

---

## 11. 近期变更纪要（2026-05-16，交接备忘）

1. **AI Agent “输入后无反应”修复**：根因是 **`src/routes/agent.ts`** 用 **`req.on("close")`** 判断客户端断开；POST body 读完也会触发该事件，导致后续 SSE 事件不写回。已改为 **`res.on("close")`**。回归测试：**`test/agentRoute.test.ts`**。
2. **AI Agent 上游超时**：**`src/lib/agent/agentStream.ts`** 总超时默认 **90000ms**（多工具轮次需要），可通过 **`AGENT_STREAM_TIMEOUT_MS`** 覆盖；避免 SiliconFlow 连接/响应卡住时前端一直空等。回归测试：**`test/agentStream.test.ts`**。
3. **测试入口**：**`package.json`** 的 **`npm test`** 已改为 **`tsx --test test/*.test.ts`**，会跑 agent、chart、history、config、REST dummy 等全部后端测试。
4. **v3/v4 聚合旧纪要**：Oracle/Dummy v4 聚合、**`MEMORY_AGG_ORACLE_MAX_ROWS`**、**`normalizeDbRowKeysUpper`** 等规则仍有效；涉及列表/聚合改动时继续遵守 Dummy/Oracle 双路径同步。
5. **勿提交**：**`pcr-ai-api/dist.tar`**、**`node_modules`**、真实 **`.env`** 或任何密钥。
6. **AI Agent 坏 bin 表述（2026-05-20）**：**`agentPrompt.ts`** 专节「坏 Bin 编号与数量」+ **`agentJbBinFormat.ts`**：`query_jb_bins` 工具回传前将 **`bins[]` 的 `n`/`value`** 规范为 **`badBins`/`goodBins` 的 `bin`/`dieCount`**（与 **`aggregate_jb_bins`** 的 **`bin`/`count`** 同义），降低模型把「BIN37 8 颗」写反的概率。回归 **`test/agentJbBinFormat.test.ts`**。改口径时同步 **`agentPrompt.ts`**、**`agentToolHandlers.ts`**、**`agentToolSchemas.ts`**。
7. **INF site-bin-bylot（2026-05-20）**：**`GET /api/v1/inf-analysis/site-bin-bylot?infPath=&passId=`** — 看 **每片 wafer 按 pass**（可多 pass）的 **bin 测试结果由 probe card 哪个 DUT 测出**；JSON **`passes[].bins[].bin`** 为 `binN`，**`duts[].dut`** 为 DUT 号，**`dieCount`** 为 map 颗数。勿与 JB Oracle **`/infcontrol-layer-bins`** 的 BIN 列计数混淆。发布须 **`npm run build`**（含 copy perlscripts）。**报表/Agent 集成设计**见 **[`../docs/SITE_BIN_BY_LOT_INTEGRATION.md`](../docs/SITE_BIN_BY_LOT_INTEGRATION.md)**（`buildInfPath(device,lot,slot)`、下钻后请求、`query_inf_site_bin_by_dut` prompt 附录）。
8. **本地 dev 与 Node 24+（2026-05-21）**：**`src/polyfillUtilIsDate.ts`** 在加载 **oracledb 5.5** 前补丁 **`util.isDate`**（Node 23+ 已移除，否则 Oracle 绑定 `Date` 报 `util.isDate is not a function`）。**`loadEnv.ts`** 在 **非 dist / 非 production** 且未显式关闭时默认 **`YIELD_MONITOR_TRIGGERS_DUMMY`**、**`INFCONTROL_LAYER_BINS_DUMMY`** 为 **true**（`npm run dev` 走 Excel，服务器 **`dist` + PM2** 仍走 Oracle）。本机连真库：**`PCR_AI_LOCAL_DUMMY=false`**。联调报表：**`pcr-ai-report/.env.development`** 设 **`VITE_DEV_PROXY_TARGET=http://127.0.0.1:30008`**，设置页 API 地址留空；**`Failed to fetch`** 多为 API 未监听 30008 或端口占用。回归 **`test/polyfillUtilIsDate.test.ts`**。
9. **AI Agent 历史上下文与流式体验（2026-05-21）**：
   - **`src/lib/agent/agentHistory.ts`**：`SUMMARIZE_THRESHOLD` 20 → **40**，`KEEP_RECENT` 10 → **20**，`MAX_MESSAGES` 60 → **80**。正常会话极少触发压缩，lot ID / bin 编号不再被摘要洗掉。回归 **`test/agentHistory.test.ts`**（断言已同步更新为 `≤80`）。
   - **`src/lib/agent/agentLoop.ts`**：`LOOKAHEAD` 30 → **12**（仍足以检测 `<｜tool▁` 8 字符前缀），文字推送更连续；补 3 条 **`status`** SSE 事件填补静默期：`"正在压缩历史对话…"`（summarization 前）、`"正在准备系统信息…"`（manifest fetch 前）、`"正在分析工具结果…"`（工具结果回传后下一轮 LLM 调用前）。
10. **AI Agent 可配置轮数 + 超时重试 + INF PASS_TYPE 过滤（2026-05-22）**：
   - **`agentConfig.maxRounds`**（默认 **5**，范围 **1–20**）：前端 Settings → AI Agent 配置；请求体随 **`agentConfig`** 下发；服务端回退 **`AGENT_MAX_ROUNDS`**（**`.env.example`**）。**`agentLoop.ts`** 用该值替代硬编码 5 轮上限。
   - **超时重试**：**`POST /api/v4/agent/chat`** 支持 **`retry: true`**（仅需 **`sessionId`** + **`agentConfig`**）；**`runAgentLoop(..., { resume: true })`** 不重复 **`appendMessages` user**；前端 **`AiAgentReport`** 在 timeout 类错误（含 **`Request timeout after …ms`**）显示 **↻ 重试**，同一 session 续跑。
   - **`output_site_bin_bylot.pl`**：遍历 **`SmWaferPass`** 时增加 **`PASS_TYPE eq 'TEST'`**，与 JB **`PASSTYPE=TEST`** 对齐；改 Perl 后须 **`npm run build`**（copy perlscripts → **`dist/`**）。回归 **`test/outputSiteBinByLot.test.ts`**（Dummy 路径不受 Perl 影响）。
11. **AI Agent 工具后强制总结 —「有数据无输出 / 270s·5min 超时」（2026-05-22，Cursor）**：
   - **现象**：`aggregate_yield_triggers` / `aggregate_jb_bins` 等工具 JSON 已在 UI 展开，但第二轮 LLM 长时间无中文结论，最终 **`Request timeout after 270000ms`** 或前端 **「请求超时（5 分钟）」**。与 2026-05-21 的 LOOKAHEAD / statusHint **无关**（那些只改显示与 token 推送粒度）。
   - **根因**：工具跑完后下一轮仍 **`tool_choice: "auto"`** + 全量 **`tools`**，模型易继续空转调工具而不写结论；DeepSeek 流式 **`createDeepSeekFilter`** 在流结束时若处于 `inToken` 可能吞掉尾部文字；**`agentStream`** 原为整请求固定超时，出字后流停滞仍易误杀。
   - **`agentLoop.ts`**：
     - 导出 **`historyAwaitingToolSummary(history)`** — 当 history 末条为 **`role: "tool"`** 时为 true（含 **`retry: true`** 续跑）。
     - 总结轮：**不传 `tools`**，**`tool_choice: "none"`**；追加 system **`SUMMARIZE_NUDGE`**（「工具已完成，立即中文总结，禁止再调工具」）。
     - 总结轮若 **`textBuffer` 为空** → 明确 SSE **`error`**（不再静默 **`done`**）；若仍收到 **`tool_calls`** → **`error`** 提示拆问题或重试。
     - **`assistant` + `tool_calls`** 历史改为保留 **`content: textBuffer`**（首轮分析文字不丢）；**`tool`** 消息补 **`name`**。
     - **`createDeepSeekFilter.finalize()`**：流结束时 flush 未完成 token 缓冲为 plain text。
   - **`agentStream.ts`**：**idle 超时** — 每收到响应 **`data` 字节即重置 **`AGENT_STREAM_TIMEOUT_MS`** 计时（默认 270s）。
   - **测试**：**`test/agentLoop.test.ts`**（`historyAwaitingToolSummary`）；改 loop/stream/filter 时跑 **`npm test`**。
   - **质量 trade-off**：第 1 轮仍可一次调多个工具；仅**紧接工具结果后的那一轮**禁止再调工具。若模型第 1 轮少调了工具，需用户追问或拆问；复杂跨域问题可在 prompt 侧要求第 1 轮一次调齐。
   - **前端**：**`AiAgentReport`** 无改动；**↻ 重试** 在工具 JSON 已在 session 时可直接进入总结轮。
12. **Agent JB JOIN 修正 — `get_filter_values` / manifest（2026-05-22）**：
   - **现象**：JB **`get_filter_values`** 报 **`ORA-00904: "T2"."INFCONTROLID": invalid identifier`**；Agent 查 6045-13 等卡号时 JB 域失败。
   - **根因**：**`agentFilterValuesTool.ts`**、**`agentManifest.ts`** 误用 **`t1.ID = t2.INFCONTROLID`**；与列表/聚合一致应为 **`t1.KEYNUMBER = t2.KEYNUMBER`**（见 **`infcontrolLayerBinSql.ts`** / **`apiV3ListSql.ts`**）。
   - **改后**：Oracle JB 快照与 **`get_filter_values`**（`cardId` / `lot` / `testerId` / `probeCardType`）可正常执行。改 JOIN 时勿再引入 `INFCONTROLID`。
13. **Agent 超时 150s + 前端 New Chat 重置（2026-05-22）**：
   - **超时**：**`agentStream.ts`** **`DEFAULT_STREAM_TIMEOUT_MS`** **270s → 150s**（**idle** 超时，有 SSE 字节则重置）。生产若 `.env` 写死 **`AGENT_STREAM_TIMEOUT_MS=270000`** 须改 **150000** 或删除。
   - **前端**：**`AiAgentReport.tsx`** 客户端整请求 **180s**（略大于后端）；**`vite.config.ts`** dev 代理 **180s**；超时文案按秒显示。
   - **New Chat**：**`chatGenerationRef`** 丢弃旧 SSE；**`newSession`** 立即 **`setLoading(false)`** + **`abort()`**；stale **`finally`** 在 **`abortRef === null`** 时兜底，避免「发送 / 处理中」卡住。详见 **`../pcr-ai-report/CLAUDE.md` §16**。

---

## 12. 硅基流动、CORS 与部署备忘（2026-05 起）

### 12.1 硅基流动代理

- **旧直连路由**：**`GET /api/v1|/api/v3|/api/v4/siliconflow/chat?message=…`**（UTF-8 查询参数）；出站 **`POST`** 由 **`src/lib/siliconflowChat.ts`** 发往 **`SILICONFLOW_API_BASE`**（默认 **`https://api.siliconflow.cn/v1`**）。
- **旧直连密钥**：常量 **`SILICONFLOW_API_KEY`** 写在 **`src/lib/siliconflowChat.ts`**（源码硬编码，仅用于旧 **`GET /siliconflow/chat`** 路由）。轮换密钥时改该常量并 **`npm run build`**。
- **报表 AI Agent 路由**：前端 **`AiAgentReport`** 调 **`POST /api/v4/agent/chat`**，后端读取请求体 **`agentConfig.apiKey`**，否则回退 **`AGENT_API_KEY`** / **`SILICONFLOW_API_KEY`** 环境变量；没有 key 会返回 **400 CONFIG_ERROR**。此路由不使用 `siliconflowChat.ts` 的硬编码 key。
- **AI Agent 轮数**：**`agentConfig.maxRounds`**（前端 Settings，默认 5）→ 服务端 **`AGENT_MAX_ROUNDS`** 回退；**`agentLoop.ts`** ReAct 上限。
- **AI Agent 超时重试**：请求体 **`retry: true`** 从 session 历史续跑（不重复 user 消息）；前端 timeout 错误显示 **↻ 重试**。
- **AI Agent 超时**：**`AGENT_STREAM_TIMEOUT_MS`** 控制 `agentStream.ts` 上游流式 **idle** 超时（**每收到 SSE 字节重置计时**），默认 **150000ms**；全程无字节则触发。超时时 SSE **`{ type: "error", message: "Request timeout after ...ms" }`**。前端客户端整请求超时 **180s**（略大于后端）；Vite dev 代理与之对齐。
- **AI Agent 工具后总结轮（2026-05-22）**：**`historyAwaitingToolSummary`** 为真时（history 末条 **`tool`**，含 **retry 续跑**），**`agentLoop`** 以 **`tool_choice: "none"`** 调 SiliconFlow，并注入 **`SUMMARIZE_NUDGE`**。勿改回工具轮也带 **`tool_choice: "auto"`**，否则易复现「工具有 JSON、无中文结论」。详见 **§11 条目 11**。
- **TLS**：见 **`SILICONFLOW_TLS_INSECURE`**、**`SILICONFLOW_TLS_STRICT`**、**`NODE_EXTRA_CA_CERTS`**（**`.env.example`**）。**禁止 npm 包 `undici`**（见 **`.cursor/rules/no-undici.mdc`**）：严格校验用 Node 内置 **`fetch`**；跳过证书链用 **`node:https`** + **`rejectUnauthorized: false`**（仅硅基流动出站）。
- **构建守卫**：**`npm run build`** = **`tsc`** + **`scripts/verify-dist-no-undici.mjs`**（`dist/lib/siliconflowChat.js` 不得 `import 'undici'`）。发布时在 **`pcr-ai-api`** 目录 **`npm ci`** 再 **`npm run build`**，勿只复制旧 **`dist/`**。
- **Node 版本**：声明 **`>=18.12.1`**；**全局 `fetch` / `AbortSignal.timeout`** 依赖 Node 18。生产例：**v18.12.1** 可用。
- **PM2**：**`ecosystem.config.cjs`** 将 **`SILICONFLOW_*`**、**`NODE_EXTRA_CA_CERTS`** 及 Oracle 相关键透传，见文件内列表。

### 12.2 CORS

- 已移除 **`cors` npm 包**。逻辑在 **`src/lib/corsConfig.ts`**：**`wideOpenCorsMiddleware`** —— 有 **`Origin`** 则回写该源；**OPTIONS** 预检回显 **`Access-Control-Request-Headers`**；Chrome **Private Network Access** 时处理 **`Access-Control-Request-Private-Network`**。
- 不再通过 **`CORS_ORIGIN`** 环境变量收紧（见 **`.env.example`** 顶部说明）。

### 12.3 与报表（`pcr-ai-report`）联调

- **`npm run dev`** 时若从 **`localhost`** 访问内网 **`10.x` API**，易受浏览器 **PNA** 与网络策略影响；**`pcr-ai-report`** 通过 **`.env.development`** 的 **`VITE_DEV_API_VIA_PROXY`**、**`VITE_DEV_PROXY_TARGET`** 与 **`vite.config.ts`** 将 **`/api`、`/health`** 代理到网关。详见根目录 **`CLAUDE.md`** 与 **`pcr-ai-report/.env.example`**。
- **前端交接**（可拖拽布局、localStorage、`/api/v4` 调用约定、标题与 tab）：**[`../pcr-ai-report/CLAUDE.md`](../pcr-ai-report/CLAUDE.md)**。
- 报表与 API **同机部署**时：若 **30008** 不对客户端开放，需在防火墙放行或对 **80** 做反代（运维/网络问题，非 CORS 单独可解）。

---
