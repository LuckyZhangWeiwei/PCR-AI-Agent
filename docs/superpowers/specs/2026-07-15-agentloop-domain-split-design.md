# agentLoop.ts 域拆分设计（Round 3）

**日期**: 2026-07-15
**分支**: refactor/api-domain-split
**范围**: `pcr-ai-api/src/lib/agent/core/agentLoop.ts`（当前 3387 行）

## 背景

`core/agentLoop.ts` 是 ReAct agent 主循环文件。此前两轮域拆分重构（Round 1 Task 9-12、Round 2 Task 13-19）中，该文件曾在 Round 1 Task 11 从 4384 行瘦身到 3387 行（拆出 `core/`、`dispatch/`、`tools/`、`render/` 四个方向），此后被列为"永久例外，不再动"的最高风险文件。用户现在明确要求继续对它做纯移动式拆分，要求"准确、可重用、易看懂"。

## 目标

在不改变任何行为的前提下（pure move-only），把 `agentLoop.ts` 剩余的 ~55 个顶层函数按职责拆到已存在的 `dispatch/`、`render/` 兄弟目录下的新子文件，并修复过程中发现的一个隐藏循环依赖，使模块依赖图变成单向无环。

## 现状分析

通过完整读取 3387 行源码得到的函数清单（详见实现阶段的 task brief），大致分三类：

1. **~15 个 `tryRunXXXDirectRoute`** 系列——绕过 LLM 工具循环的确定性直出路由，按实际调用的工具族（而非函数名字面意思）分组
2. **~10 个 `tryEmitXXXChart` / `buildXXXMarkdown` / `emitDeterministicXXXReply`** 系列——图表与 Markdown 渲染辅助函数
3. **核心循环机制**——`executeRoundToolCalls`、`runTouchdownSummaryReply`、`prepareRunAgentLoopContext`、`runAgentLoop` 本身等，留在 core

### 关键发现：预先存在的循环依赖

`dispatch/agentSemanticDispatch.ts`（Round 1 已拆出）当前从 `core/agentLoop.ts` import 运行时函数（`lastToolMessage`、`emitTextInChunks`、`emitDeterministicJbTablesReply`、`toolResultForHistory`），而 `core/agentLoop.ts` 又从 `agentSemanticDispatch.ts` import `tryRunSemanticDispatchDirectRoute`。这是一个已经存在的 2 节点循环值导入，目前"能跑"只是因为两边都是函数声明、模块求值阶段不会真正触发。本轮拆分若不处理，会因为 dispatch/render 新文件的加入变成 3 节点循环。

## 目标文件结构

```
agent/core/agentLoop.ts          # 瘦身后主循环，约 1650 行（含 runAgentLoop ~523 行）
agent/core/agentLoopShared.ts    # 新增叶子文件：lastToolMessage、emitTextInChunks、
                                  # cleanStreamErrorMessage、toolResultForHistory（~110 行，零内部依赖）
agent/dispatch/directRoutes/
  agentWaferMapDirectRoutes.ts       # ~300 行：晶圆图 / DUT-BIN 图相关直出路由
  agentJbLotDirectRoutes.ts          # ~400 行：lot 总览 / mask 范围 / listing / equipment / perSlot
  agentJbBinDirectRoutes.ts          # ~370 行：bad-bin 排名 / good-bin 值 / 未限定 bin 澄清 / JB 汇总
  agentDutAggDirectRoutes.ts         # ~230 行：DUT×BIN 聚合相关
  agentProbeCardDirectRoutes.ts      # ~140 行：探针卡 + 测试机性能排名
agent/render/
  agentChartEmitters.ts          # ~350 行：8 个图表 / markdown 生成函数
  agentJbTablesReply.ts          # ~270 行：JB 确定性表格 + 评论生成
  agentProbeCardPerfReply.ts     # ~140 行：探针卡性能确定性回复
```

依赖图（修复后，单向无环）：

```
agentLoopShared.ts (叶子)
   ↑          ↑
render/*   core/agentLoop.ts (直接使用)
   ↑
dispatch/* (含既有的 agentSemanticDispatch.ts，同步改 import 来源)
   ↑
core/agentLoop.ts (runAgentLoop，入口)
```

`agentSemanticDispatch.ts` 同步修改：`lastToolMessage`/`emitTextInChunks`/`toolResultForHistory` 改从 `agentLoopShared.ts` 取，`emitDeterministicJbTablesReply` 改从 `render/agentJbTablesReply.ts` 取——顺带修复了预先存在的历史循环。

`AgentSseEvent` 类型不搬：所有跨文件引用均为 `import type`，TypeScript 类型擦除后不产生运行时导入，不构成循环风险，留在 `core/agentLoop.ts`。

## runAgentLoop 内部私有函数抽取（本轮一并做）

`runAgentLoop`（~523 行）内部包含 4 段可识别的内联逻辑块，按项目 Global Constraints 的"函数超 80-100 行需拆"口径已超标，本轮一并抽成同文件内的私有函数（不跨文件、不改变行为）：

- `buildRoundSystemPrompt(...)` — system prompt / nudge 拼装（~37 行）
- `applySummaryRoundToolCallGuard(...)` — summary-round 工具调用过滤（~50 行）
- pending-query 处理段（~45 行）
- post-stream 收尾段（~108 行）

具体函数签名与局部变量捕获方式留给实现阶段按实际依赖决定，前提是纯移动、零行为改变。

## 执行与审查

- 沿用 Round 1/Round 2 的 `superpowers:subagent-driven-development` 流程，每个目标文件一个实现子任务
- 因该文件曾被标记"永久例外"，本轮实现者与审查者均使用 **opus**
- 每步 `npm run typecheck && npm test` 必须绿；用 diff 核对搬运内容与原文件逐段一致
- 不引入 barrel/re-export 层；新文件遵循项目现有 400-500 行软预算
- 全部任务完成后，对本轮改动做一次整体 opus 复核

## 测试与验证

不新增测试用例——纯移动不改变行为，现有 615 个测试即行为基准。验证手段：`npm run typecheck` + `npm test`（全量）+ `npm run build`（含 `verify-dist-no-undici`）三件套，加逐函数手工 diff 核对字节级一致。

## 范围外（本轮不做）

- 不合并/精简 `tryRunXXXDirectRoute` 之间的结构性重复代码（用户已明确选择"纯移动式拆分"，结构性去重留待未来单独评估）
- `agentToolProbeCardPerf.ts`、`agentToolInfSiteBin.ts` 等 `tools/` 目录下文件不在本轮范围
- 不合并到 main 分支（沿用既有指示：refactor/api-domain-split 与 main 不合并）
