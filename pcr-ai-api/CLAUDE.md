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
| `INFCONTROL_LAYER_BINS_DUMMY=true` | `/api/v3/infcontrol-layer-bins/v3`、`…/v3/aggregate`（样本 `docs/JBStart.xlsx`） |
| `YIELD_MONITOR_TRIGGERS_DUMMY=true` | `/api/v3/yield-monitor-triggers/v3`、`…/v3/aggregate`（样本 `docs/delta-diff.xlsx`） |

**`NODE_ENV=test`** 下单测里产量 Dummy 行为见 `test/rest-api-v3-dummy.test.ts` 的 `before` 钩子。

**硬规则**：凡改 v3 的 **WHERE 语义、筛选解析、排序、limit、聚合维度、响应字段**，必须同时改 **Oracle 路径**与 **`src/lib/*Dummy*.ts`** 中等价逻辑；详见 **dummy-parity** 规则文件。

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

---

## 5. 常用命令

```bash
npm ci                 # 依赖
npm run dev            # tsx watch 开发
npm run build          # tsc → dist
npm start              # node dist/server.js
npm run typecheck      # tsc --noEmit
npm test               # 当前为 test/rest-api-v3-dummy.test.ts
npm run docs:api-v3    # build + 重写 docs/API_V3.md（改 apiV3ListSql / yield 解析与 doc 脚本后跑）
```

改 **`src/lib/apiV3ListSql.ts`** 或 **`scripts/write-api-v3-doc.mjs`** 中与产量 v3 文档相关的模板后，应执行 **`npm run docs:api-v3`** 并提交 **`docs/API_V3.md`**。

---

## 6. 源码速查（改功能从哪进）

| 领域 | 入口 / 说明 |
| --- | --- |
| HTTP 路由 | `src/routes/api.ts`（`apiRouter`；v3 产量列表/聚合、`manifest` 等） |
| v3 产量筛选 + 固定 TYPE | `src/lib/yieldMonitorTriggerFilters.ts` → `parseYieldMonitorTriggerV3Query`；常量 `YIELD_MONITOR_V3_TYPE_SCOPE` |
| v3 产量聚合解析 / SQL | `src/lib/yieldMonitorTriggerV3Aggregate.ts` |
| v3 列表 SQL 模板 | `src/lib/apiV3ListSql.ts` → `buildYieldMonitorTriggersV3Sql` |
| 产量 Dummy 加载与筛选 | `src/lib/yieldMonitorTriggerDummy.ts`、`src/lib/dummyRowsFromExcel.ts` |
| 层控 v3 | `src/lib/infcontrolLayerBinFilters.ts`、`infcontrolLayerBinDummy.ts`、`infcontrolLayerBinV3Aggregate.ts` |
| manifest 静态定义 | `src/lib/apiManifest.ts`；`/api/v3/manifest` 前缀改写 `src/lib/rebaseApiManifest.ts` |
| Oracle 连接 | `src/oracle.ts`（`withConnection` / `withProbeWebConnection`） |

---

## 7. 机器发现（Agent 工具）

- 联调示例：**`GET http://10.192.130.89:30008/api/v3/manifest`**（**站点根不要**以 `/api/v3` 结尾再拼 path，见 **AI_AGENT_API.md §2.0**）。
- 实现：`buildManifestResponseJson`，路径来自 **`apiManifest.ts`** 经 **`rebaseApiManifest.ts`** 改写为 `/api/v3/...`。

---

## 8. 交接检查清单（给下一位）

- [ ] 已读 **AI_AGENT_API.md** 至少 **§0、§4、§7、§8** 中与当前任务相关的节。  
- [ ] 若动 v3 产量 / 层控：**Dummy 与 Oracle 两侧**都已改并通过 **`npm test`**。  
- [ ] 若动列表 SQL：**`npm run docs:api-v3`** 已跑且 **`docs/API_V3.md`** 无意外回退。  
- [ ] **`npm run typecheck`** 通过。  
- [ ] 未误改 **`dist` / production** 下 Dummy 关闭语义（`listDummyRuntime.ts`）。

---

## 9. 与 AI_AGENT_API 的关系

- **本文件（`CLAUDE.md`）**：仓库内 **Claude Code 入口**——项目结构、命令、Dummy/Oracle 纪律、产量 v3 特殊约定、源码索引。  
- **`docs/AI_AGENT_API.md`**：对外集成与 **可复制 URL** 的完整说明；**§5** 为更短的「系统提示」列表。

二者冲突时以 **源码与 `manifest` 实际行为**为准，并应**更新文档**消除冲突。
