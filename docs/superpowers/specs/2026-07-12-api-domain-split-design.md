# pcr-ai-api 按业务域拆分大文件 — 设计文档

**日期：** 2026-07-12
**范围：** `pcr-ai-api` 包（不涉及 `pcr-ai-report`）
**分支：** `refactor/api-domain-split`（独立分支，完成后合并回 `main`）
**动机：** 人工维护困难——`src` 内多个文件已远超正常量级（`agent/agentLoop.ts` 4384 行、`agent/agentJbDeterministicReply.ts` 2830 行、`agent/agentPrompt.ts` 1531 行等），继 2026-05-17 那次拆分（`routes/api.ts` → `infcontrolRoutes.ts`/`yieldMonitorRoutes.ts`）之后又重新膨胀，需要一次更彻底、按业务域组织的拆分。

---

## 1. 现状（拆分前）

`pcr-ai-api/src` 共 37235 行。行数最多的文件：

| 文件 | 行数 |
|---|---|
| `lib/agent/agentLoop.ts` | 4384 |
| `lib/agent/agentJbDeterministicReply.ts` | 2830 |
| `lib/agent/agentPrompt.ts` | 1531 |
| `lib/agent/agentJbBinFormat.ts` | 1090 |
| `lib/agent/agentToolHandlers.ts` | 1083 |
| `lib/infWaferMap.ts` | 978 |
| `routes/infcontrolRoutes.ts` | 967 |
| `lib/infTools/infToolsSingleWafer.ts` | 960 |
| `lib/yieldMonitorPeriodAlarmTrend.ts` | 948 |
| `lib/apiManifest.ts` | 923 |
| `routes/yieldMonitorRoutes.ts` | 899 |
| `lib/agent/agentFilterValuesTool.ts` | 888 |
| `lib/jbYieldCalc.ts` | 841 |

测试覆盖较好（`test/` 下约 55 个 `*.test.ts`），是本次重构的安全网。

---

## 2. 总体原则

1. **单文件行数软上限约 400–500 行**——超过就该拆；极端情况（如 agentLoop.ts 拆分后的核心循环）允许略超，但不应再破千。
2. **纯搬迁为主**：只做代码位置调整和 import 修正，不改变任何行为、HTTP 路径、响应字段、错误码。允许顺手合并明显重复的辅助函数（如多处各自实现的相似小工具），但不做功能性改动。
3. **按业务域组织，不按技术层**：目录以 Yield Monitor / JB STAR(infcontrol) / 探针卡 / INF 晶圆图 / Agent 核心 划分，与现有 `docs/HANDOFF_*.md`、`test/*.test.ts` 命名里已经隐含的域一致。
4. **每个文件独立完成、独立验证**：拆完一个文件就跑一次 `npm run typecheck && npm test`，绿了再进入下一个，不积累多文件同时半成品状态。
5. **不留兼容层**：项目内部代码没有外部消费者，直接改 import 路径到新位置，不做 barrel re-export。

---

## 3. 目标目录结构

```
pcr-ai-api/src/
  lib/
    agent/
      core/
        agentLoop.ts                  # 瘦身后：仅 runAgentLoop 主流程
        agentEmbeddedToolParsing.ts   # parseGlmToolCallBody / parseMinimaxInvokeBody / createDeepSeekFilter(filterAgentStreamTextForUi)
        agentToolStatus.ts            # isLastToolEmptyResult / toolStatusLabel / historyAwaitingToolSummary
        agentStream.ts                # 不动（288行，已合理）
        agentToolSchemas.ts           # 不动（406行，已合理）
      dispatch/
        agentQuestionHeuristics.ts    # isDutBinConcentrationQuestion / requiresNewDataQuery / equipmentRouteCrossLotBail 等问题分类启发式
        agentSemanticDispatch.ts      # tryRunSemanticDispatchDirectRoute
        agentQueryScope.ts            # 不动（658行，已是独立域，保留原位）
      jb/
        agentJbQuestionClassifiers.ts # 原 agentJbDeterministicReply.ts 中全部 isXxxQuestion / detectJbReplyMode / extractJbIntentFlags
        agentJbListingMarkdown.ts     # buildRecentLotsListingMarkdown / buildLotListingContext 等
        agentJbRankingMarkdown.ts     # buildAggregateBinRankingMarkdown / buildBinCardAggregateMarkdown / buildBinDeviceAggregateMarkdown / buildBinFocusedLotRankingMarkdown
        agentJbOverviewMarkdown.ts    # buildDeterministicJbTables / buildDeterministicLotOverviewCommentary / buildLotOverviewTablesMarkdown
        agentJbPayloadResolve.ts      # parseJbToolPayload / resolveJbToolPayload / shouldAppendUnderperformingDutYield
        agentJbBinFormat.ts           # 迁入本目录，内容先不拆（1090行，格式化职责单一，观察后续是否需要再拆）
        agentJbHistoryCompact.ts      # 迁入本目录，不改内容（664行）
        agentJbBadBinCluster.ts       # 迁入本目录，不改内容
        agentJbBinTrend.ts            # 迁入本目录，不改内容
      tools/
        agentToolHandlers.ts          # 瘦身后：仅 runTool 派发 + 公共小工具（resolveToolResultMaxChars / clampLimit / truncateResult / enrichYieldRow / enrichJbRow）
        agentToolYieldTriggers.ts     # toolQueryYieldTriggers / toolAggregateYieldTriggers / fetchYmRowsForCard
        agentToolJbBins.ts            # toolQueryJbBins / toolAggregateJbBins
        agentToolProbeCardPerf.ts     # toolAggregateProbeCardTesterPerformance
        agentToolDutBinAgg.ts         # toolQueryLotDutBinAgg / lotDutConcentrationOpts / compactSiteBinPasses
        agentToolUnderperformingDuts.ts  # toolQueryLotUnderperformingDuts / tryEmitUnderperformingDutScatter / tryAppendUnderperformingDutSection（从 agentLoop.ts 移入）
        agentToolInfSiteBin.ts        # toolQueryInfSiteBinByDut
        agentFilterValuesTool.ts      # 迁入本目录，不改内容
        agentChartTool.ts             # 迁入本目录，不改内容
        agentInfWaferMapTool.ts       # 迁入本目录，不改内容
      prompt/
        agentPromptIntent.ts          # classifyIntent + PromptIntent 类型
        agentPromptSections/          # buildSystemPrompt 内部按现有自然段落拆成常量字符串片段文件；具体切几个文件在实施阶段按内容边界确定
        agentPrompt.ts                # 瘦身后：仅 buildSystemPrompt 组装逻辑
      render/
        agentAggregateBinsRender.ts   # renderAggregateJbBinsResult（从 agentLoop.ts 移入）
        agentFactChecker.ts           # 迁入本目录，不改内容

  infcontrol/
    infcontrolLayerBinFilters.ts
    infcontrolLayerBinV2Filters.ts
    infcontrolLayerBinAggregate.ts
    infcontrolLayerBinDummy.ts        # 以上四个：原样从 lib/ 平移，只改 import 路径
    jbYieldCalc.ts                    # 原样平移（841行，内部是否再拆留待观察）

  yieldMonitor/
    yieldMonitorTriggerFilters.ts
    yieldMonitorTriggerV3Aggregate.ts
    yieldMonitorTriggerDummy.ts       # 以上三个：原样平移
    periodAlarmTrend/
      periodAlarmTrendTypes.ts        # 类型 + 常量（PeriodKey / PeriodAlarmBucket 等 + TOP_N_LIMIT 等常量）
      periodAlarmTrendSql.ts          # buildPeriodAlarmTrendSql 等 build*Sql 系列 + *Binds 系列
      periodAlarmTrendParse.ts        # parsePeriodAlarmTrendQuery / resolvePeriodAlarmTimeRange / periodBucketsInRange / recentPeriodBuckets
      periodAlarmTrendAggregate.ts    # topTestersFromAlarmRows / topDevicesFromAlarmRows / topProbeCardsFromAlarmRows / aggregatePeriodAlarmTrendDummy

  infWaferMap/
    infWaferMap.ts                    # 原文件按内部自然边界拆（几何/dieMap解析 vs calculateWafer主计算等），具体切分在实施阶段确定
    infWaferMapHtml.ts                # 迁入本目录，不改内容
    infTools/
      infToolsSingleWafer.ts          # 18 个 runXxx 独立工具函数，按"读图 / 分析 / 绘图"拆 2-3 个文件
      infToolsLot.ts
      index.ts                        # 迁入本目录，不改内容（是否再拆视体量）

  probeCard/
    probeCardTesterPerformance.ts     # 迁入本目录，不改内容（453行，已合理）

  manifest/
    yieldMonitorManifest.ts
    infcontrolManifest.ts
    agentManifest.ts                  # 按 apiManifest.ts 现有结构分片
    index.ts                          # 合并导出，对外仍暴露同名 `apiManifest` 对象，routes/api.ts 等消费者的引用符号不变

routes/
  infcontrolRoutes.ts                 # 保留 Router 注册骨架；每个 endpoint 里 100+ 行的解析/查询/格式化逻辑抽到 lib/infcontrol/handlers/ 或对应域的 handlers 文件里的具名函数，路由文件里只剩 `router.get(path, handlerFn)`
  yieldMonitorRoutes.ts               # 同上，抽到 lib/yieldMonitor/handlers/
```

**关键约束**：拆分只发生在 `pcr-ai-api/src` 内部；不影响 `pcr-ai-report`；`routes/api.ts` 等对外暴露的符号名（`apiManifest` 等）保持不变。

---

## 4. 迁移机制

- **每文件迁移步骤**：① 建新文件/目录 → ② 剪切代码 → ③ 用 grep 找出全部旧路径引用者并修正 import → ④ `npm run typecheck` → ⑤ `npm test` 全绿 → ⑥ 提交一个小 commit。
- **不留兼容层**：直接改 import 路径，不做 re-export 桥接。
- **文档同步**：每完成一个文件拆分，grep `pcr-ai-api/CLAUDE.md` 是否引用了该文件旧路径/函数名（如 "createDeepSeekFilter (inline in agentLoop.ts)"），同步更新为新路径。`docs/HANDOFF_*.md` 保持不变（历史快照，不处理）。

---

## 5. 执行顺序

先易后难、先叶子后核心，降低中途返工风险：

1. `lib/apiManifest.ts` 拆分（纯数据，无逻辑依赖，风险最低）
2. `lib/infcontrol*`、`lib/yieldMonitorTrigger*`、`lib/jbYieldCalc.ts`、`lib/probeCardTesterPerformance.ts` 平移进域目录（只挪位置 + 改 import）
3. `lib/yieldMonitorPeriodAlarmTrend.ts` 按 types/sql/parse/aggregate 拆分
4. `lib/infWaferMap.ts` + `lib/infTools/` 拆分
5. `routes/infcontrolRoutes.ts`、`routes/yieldMonitorRoutes.ts` 抽取 handler
6. `lib/agent/agentToolHandlers.ts` 按工具域拆分
7. `lib/agent/agentJbBinFormat.ts`、`agentJbHistoryCompact.ts`、`agentJbBadBinCluster.ts`、`agentJbBinTrend.ts` 迁入 `agent/jb/`
8. `lib/agent/agentJbDeterministicReply.ts` 拆分（体量最大，放靠后，此时拆分经验已从前面文件积累）
9. `lib/agent/agentPrompt.ts` 拆分
10. `lib/agent/agentLoop.ts` 拆分（风险最高——核心 ReAct 循环，放最后，此时其余依赖它的模块边界已稳定）

---

## 6. 验证策略

- 每步：`npm run typecheck` + `npm test`（全量 `test/*.test.ts`，约55个文件，覆盖 Dummy 和部分真实路径逻辑）。
- 全部完成后：额外跑一次 `npm run build`（含 `verify-dist-no-undici` 检查，确保拆分没有意外引入新依赖或打破 no-undici 规则）。
- 全绿后合并回 `main`。

---

## 7. Git 工作流

- 新建分支 `refactor/api-domain-split`。
- 按第 5 节顺序逐文件提交小 commit（每个 commit 对应一次完整的"搬迁+验证"）。
- 全部完成、`typecheck` + `test` + `build` 全绿后，合并回 `main`（合并方式届时与用户确认，不在本设计中预先决定 squash/merge）。

---

## 8. 不在本次范围内

- `pcr-ai-report` 前端包的任何改动。
- `docs/HANDOFF_*.md` 历史交接文档的路径更新（视为历史快照，保留原样）。
- 任何业务逻辑、SQL、响应字段的变更——本次是纯结构重构。
