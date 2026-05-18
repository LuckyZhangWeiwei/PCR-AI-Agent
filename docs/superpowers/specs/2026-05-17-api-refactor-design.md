# pcr-ai-api 重构设计文档

**日期：** 2026-05-17  
**范围：** `pcr-ai-api` 包  
**分支：** 独立 refactor 分支  
**原则：** 纯文件级职责拆分，不改任何业务逻辑、HTTP 路径、响应字段、错误码

---

## 1. 背景与目标

| 痛点 | 当前状态 |
|---|---|
| 文件过大、职责混杂 | `routes/api.ts` 1590 行，`lib/agent/agentTools.ts` 552 行 |
| 系统提示词硬编码在业务逻辑中 | `buildSystemPrompt()` 内嵌于 `agentLoop.ts` |
| 工具 Schema 与实现耦合 | `TOOL_SCHEMAS`、handler、图表逻辑同在一个文件 |
| 错误处理分散重复 | 400/422 模式在 `api.ts` 中重复 15-20 次 |

目标：**提示词、Schema、handler 各自独立文件；路由按域拆分；公共错误处理集中**——不影响任何现有功能。

---

## 2. 文件结构变化

### 2.1 Agent 目录（`lib/agent/`）

| 文件 | 变化 | 说明 |
|---|---|---|
| `agentConfig.ts` | 不动 | AgentConfig + resolveAgentConfig |
| `agentHistory.ts` | 不动 | 历史管理 |
| `agentStream.ts` | 不动 | 流式请求 |
| `agentPrompt.ts` | **新建** | `buildSystemPrompt()` 从 `agentLoop.ts` 抽出 |
| `agentToolSchemas.ts` | **新建** | `TOOL_SCHEMAS` 常量从 `agentTools.ts` 抽出 |
| `agentChartTool.ts` | **新建** | `buildChartOption` + `ChartData`/`ChartSentinel`/`ClarificationSentinel` 类型 |
| `agentToolHandlers.ts` | **新建** | 6 个 tool 实现函数 + `runTool` dispatcher |
| `agentLoop.ts` | 修改 | 主循环保留，import 改指新文件 |
| `agentTools.ts` | **删除** | 内容全部迁移到上面 4 个新文件 |

### 2.2 路由目录（`routes/`）

| 文件 | 变化 | 说明 |
|---|---|---|
| `health.ts` | 不动 | |
| `agent.ts` | 不动 | |
| `yieldMonitorRoutes.ts` | **新建** | yield-monitor-triggers 所有端点（v1/v3/v4 列表、v3/v4 聚合） |
| `infcontrolRoutes.ts` | **新建** | infcontrol-layer-bins 所有端点（v2/v3/v4 列表、v3/v4 聚合） |
| `manifestRoutes.ts` | **新建** | GET manifest（v3/v4）+ apiV4Docs |
| `siliconflowRoutes.ts` | **新建** | GET /siliconflow/chat |
| `api.ts` | 修改 | 只做 Router 创建 + `router.use()` 挂载，业务代码全部移出 |

### 2.3 公共库（`lib/`）

| 文件 | 变化 | 说明 |
|---|---|---|
| `routeHelpers.ts` | **新建** | `sendValidationError`、`sendMemoryLimitError`；可选 `withOracleHandler` |
| `agentResponse.ts` | 不动 | 已有 `sendAgentError` / `enrichOracleDriverDetail` |
| 其余 `lib/*.ts` | 不动 | 所有路径保持不变 |

---

## 3. Import 关系

```
app.ts
  ├─ routes/health.ts
  ├─ routes/agent.ts
  │    └─ lib/agent/agentLoop.ts
  │         ├─ lib/agent/agentPrompt.ts          (buildSystemPrompt)
  │         ├─ lib/agent/agentToolSchemas.ts     (TOOL_SCHEMAS)
  │         ├─ lib/agent/agentToolHandlers.ts    (runTool)
  │         │    ├─ lib/agent/agentChartTool.ts
  │         │    └─ lib/*.ts (不动)
  │         ├─ lib/agent/agentHistory.ts
  │         └─ lib/agent/agentStream.ts
  └─ routes/api.ts  (只剩挂载)
       ├─ routes/manifestRoutes.ts
       ├─ routes/siliconflowRoutes.ts
       ├─ routes/yieldMonitorRoutes.ts   ← lib/routeHelpers.ts
       └─ routes/infcontrolRoutes.ts     ← lib/routeHelpers.ts
```

---

## 4. 关键约束

1. **lib/ 路径不变**：`lib/` 下（除 `lib/agent/` 内部重组）所有文件路径不变，不改任何现有 import
2. **HTTP 路径不变**：`/api/v3`、`/api/v4` 仍由 `app.ts` 挂载同一个 `apiRouter`，对外路径完全不变
3. **导出名保持**：`TOOL_SCHEMAS`、`runTool`、`ChartSentinel`、`ClarificationSentinel` 在新文件中保留相同名称
4. **Oracle/Dummy 逻辑不动**：双路径逻辑仅做文件级搬移，不修改任何条件判断
5. **响应格式不变**：所有 HTTP 响应状态码、字段名、错误 code 字符串一字不改

---

## 5. `lib/routeHelpers.ts` 接口

```typescript
// 400 参数校验失败（parsed.ok === false 时调用）
export function sendValidationError(res: Response, error: string): void

// 422 内存聚合行超限
export function sendMemoryLimitError(res: Response, count: number, max: number): void
```

这两个函数提取 `routes/api.ts` 中重复 15-20 次的相同 JSON 响应逻辑。

---

## 6. 验证策略

每个拆分步骤完成后执行：

```bash
cd pcr-ai-api
npm run typecheck   # import 路径全部正确
npm test            # agentRoute、agentStream、REST dummy 等全部通过
npm run build       # dist 构建成功 + verify-dist-no-undici 通过
```

---

## 7. 不在本次范围内

- `lib/` 按域重组（`lib/yield/`、`lib/infcontrol/` 等）——属于方案 C，本次不做
- 前端（`pcr-ai-report`）不做任何修改
- 新增功能、性能优化、SQL 修改
