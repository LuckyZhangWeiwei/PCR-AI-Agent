# TODO

## ⭐ 下一步开发顺序

| 优先级 | 任务 | 备注 |
|--------|------|------|
| 1 | 服务器部署新版本 | `npm run build + pm2:reload`（API）；`npm run pack:dist` → scp + tar xf（前端） |
| 2 | AI Agent 生产部署验证 | 确认 `AGENT_API_KEY`、`AGENT_STREAM_TIMEOUT_MS`（默认 120s）、PM2 重启后聊天可用；验证 query_lot_dut_bin_agg 工具正常调用 |
| 3 | YM 确定性摘要路径 | 类似 JB 的 tryRunDeterministicJbSummary，服务端直出表，LLM 仅写解读 |
| 4 | 跨域退化信号：阈值调优 + 生产验证 | agentCrossdomainInsights.ts 早/晚段阈值（±2pp / ×1.4）需用真实卡历史数据验证；coverageRatio 计算依赖 YM LOTID 与 JB LOT 格式一致 |

## 待办

- [ ] 服务器部署：API `npm run build + pm2:reload`；前端 `npm run pack:dist` → scp dist.tar → nginx web root（含 INF 工具瘦身 + listDefaultLimit 2000 + New Chat 滚动修复 + 探针卡追问答案重复修复 + generic/双源总结结构化）
- [ ] AI Agent 生产部署验证：确认 `AGENT_API_KEY` / `SILICONFLOW_API_KEY`、PM2 重启后聊天页可用；验证 `query_lot_dut_bin_agg` 工具调用正常（含 DUT 集中度判别表前置）；验证 JB lot 查询有 clusteredBadBinAlerts 时 dutConcentrationMarkdown 自动出现在警示节
- ✅ INF DUT 面板 Agent 工具：`query_inf_site_bin_by_dut` 接入 agentPrompt + agentToolHandlers — 已完成（早于本次记录）
- ✅ Agent 新工具 query_lot_dut_bin_agg：lot 级 DUT×Bin 聚合，复用已有 lot 级 INF API，dummy 双路径 — 2026-06-02 完成
- ✅ 前端使用 `mask` 字段：JB Star 聚合 charts 新增 Mask 不良分析图 + 所有下钻选项加 Mask — 2026-05-27 完成
- [ ] Phase 1：YM 报表顶部新增探针卡报警排名图（`ProbeCardRankPanel.tsx`）
- [ ] Phase 2b：YM↔JB 跨报表跳转链接
- [ ] Phase 3 前端：`LotDutBinPanel.tsx`（lot 级堆叠条形图，调用已有 `/inf-analysis/site-bin-bylot?device&lot`）
- [ ] YM 确定性摘要路径：类似 tryRunDeterministicJbSummary，YM lot 查询后服务端直出探针卡报警排名表
- [ ] 报表重构：识别并提取 YM/JB 相同维度分析为共用组件（精简重复）
- [ ] 真库验证三段会话修复：复现后收集 `[agentSql/*]`（含 SQL）、`[equipmentRoute/skip:*]`、`[jbGoodBin/suspect]`、`[jbDeterministic/staleMaskCache]`、`[jbDeterministic/binCardMaskScope]`、`[jbDeterministic/multiLotBail]` 日志，据实定位：(a) `get_filter_values(device,mask)` 与 `(probeCardType→cardId)` 为何空（看 `filterValues:*DeviceByMask:result` 的 rowCount/sampleDevices；CARDID 前缀格式）；(b) BIN152 isGoodBin 是否 PASSBIN/分类与良率口径不一致；(c)「ps16 哪个最差」是否改良率%口径（现按坏 die 总量排序，仅脚注提示用 yieldByPassId 复核）

## 已完成

- ✅ 续评审修复：mask 级「测试情况」改出多 lot 列表（非单 lot 概况）+ bin_card mask 级 bail + `buildBinCardAggregateMarkdown`（groupBy:"bin,cardId" 卡归属渲染，修 cardId 丢失）+ `isMultiLotComparisonQuestion` 多 lot 对比 bail + device-by-mask SQL 日志加 sampleDevices — 2026-06-27 完成（384 测试通过）
- ✅ 三段会话评审修复：get_filter_values 空结果 hint + 多 lot scope guide + equipment 直连缓存 scope 校验（防 N55Z↔P11C 张冠李戴）+ SQL 调试日志（query_jb_bins/aggregate_jb_bins/get_filter_values）— 2026-06-27 完成（376 测试通过）
- ✅ agentPrompt 可维护性重构：22 个命名 TypeScript const + TOC，LLM 看到文本完全不变，typecheck 通过 — 2026-06-06 完成
- ✅ default 兜底输出优化：cluster 警示与 AI 规律识别合并至末尾；清除 formatClusteredBadBinAlertsMarkdown 指令泄漏；detectAndFormatDataPatterns 改简洁 bullet 格式 — 2026-06-06 完成
- ✅ Agent 三项生产 Bug 修复（wafermap composite shortcut / 逐片 bin 死循环 / 指令泄漏）：移除 BIN 高亮跟画时的 passes=composite 捷径；新增 tryRunPerSlotBinRankingDirectRoute 直连路由；清除 jbBinsYieldFallbackMessage 中的 DETERMINISTIC_TABLES_HEADER — 2026-06-06 完成
- ✅ agentPrompt 规划规则收紧：识别 device/lot/cardId 后必须立即调工具；"规划其次"仅限跨多实体对比 — 2026-06-06 完成
- ✅ `BRIEF_COMMENTARY_SYSTEM` 空解读根本原因修复：移除 `generate_chart` 工具提示（无 schema 时推理模型输出被 filter 剥离），加无工具约束 — 2026-06-06 完成
- ✅ `per_slot_bin_ranking` 启用 LLM 解读：从 `jbReplySkipsCommentaryLlm` 跳过名单移出 — 2026-06-06 完成
- ✅ 确定性表输出 UI 修复：移除 `DETERMINISTIC_TABLES_HEADER` 用户侧泄漏；空分析结论 emit fallback — 2026-06-06 完成
- ✅ Agent generic/双源总结轮结构化：`getSummaryContext` 推断 `jb/dual_source/generic`，双源注入分节 nudge（YM 侧/JB 侧/综合结论），generic 注入三节 nudge（数据摘要/主要发现/建议），`summaryUserNudge` 动态化 — 2026-06-06 完成
- ✅ Agent subAgentModel 支持：历史压缩 + 确定性表解读改用轻量子模型，Settings 新增配置项，工具选择 / 最终回答仍用主模型 — 2026-06-06 完成
- ✅ Agent 多源时间段联查规则：agentPrompt 新增卡号/device + 时间段必须同时查 YM+JB 的规则，明确 INF 文件限制 — 2026-06-06 完成
- ✅ Agent 主动规律/风险识别：detectAndFormatDataPatterns 检测良率趋势、BIN 集中、片位持续最差、温度敏感、换卡 BIN 偏移，自动追加到 lot_overview/card_test_overview/bad_bin_ranking/lot_yield_ranking/generic 模式输出 — 2026-06-06 完成
- ✅ Agent JB generic 兜底结构性修复：含卡号/DUT 关键词时返回 null 而非错误 lot overview — 2026-06-06 完成
- ✅ Agent JB 探针卡 DUT 定位模式（card_dut_question）：「8036-06 中哪个dut有问题」直出该卡坏 die 汇总 + 各片排行 + DUT 晶圆图引导，跳过 LLM 解读 — 2026-06-06 完成
- ✅ Agent JB 探针卡测试概况模式（card_test_overview）：「8036-06 的测试情况」由错误 lot cluster alerts 改为 yieldByPassId + 卡分配 + 该卡坏 die 排行 + 近期 lot 记录 — 2026-06-06 完成
- ✅ Agent JB/Wafermap 四项 Bug 修复：lot 概况探针卡缺失、追问 probecard 重复输出总览表、晶圆图 BIN highlight "7号bin"格式失效、单 passId wafermap 不展开中断/复测段 — 2026-06-04 完成
- ✅ Agent 工具并发执行：同轮多工具按连接池分组，不同池并发执行，Oracle/SiliconFlow 调用方式不变 — 2026-06-03 完成
- ✅ Code Review 修复（2026-06-03）：agentWaferMapRoute not_applicable 携带错误 skip 标志、repairGfmMarkdownTables 表头双写、infWaferMapHtml Math.min spread 崩溃、BIN 图例过滤、splitAgentReplyMarkdown index=0 边界、agentLoop 标题未写 history、agentDutBinMapRoute 冗余扫描、重复 import — 2026-06-03 完成
- ✅ Code Review 修复（2026-05-28）：GLM 正则锚定、DUT 面板 null 保护、useEffect 冗余依赖、GLM arg zip、selectionSummary 计数、normalizeBinToken 去重 — 2026-05-28 完成
- ✅ toolResultMaxHistoryChars 可配置化：Settings 新增「历史存储上限」（1000–12000，默认 6000），随 agentConfig 下发替代硬编码常量 — 2026-05-27 完成
- ✅ mask 字段：所有 API device 相关响应新增 `mask`（device 末 4 位，Oracle+Dummy 双路径 + 聚合 parts）— 2026-05-27 完成
- ✅ history bug 修复：`TOOL_RESULT_MAX_HISTORY` 对 string 实际生效（3000→6000），多轮对话不再 context 膨胀 — 2026-05-27 完成
- ✅ AI Agent 标签页开关（Settings toggle，localStorage 持久化）— 2026-05-27 完成
- ✅ Settings AI Agent 配置描述清晰化（分组 + 每项说明 + 历史 cap 解耦说明）— 2026-05-27 完成
- ✅ AI Chat 🔄 重新生成按钮：feedback 栏新增 regenerate，截断消息列表并重新提交同一问题 — 2026-05-26 完成
- ✅ 警示表格渲染修复：`detachSummaryLikeTableRows` 只剥 summary 关键词行，BIN 命名表格不再被误删 — 2026-06-06 完成
- ✅ `focusBin` DUT 明细置顶：`toolQueryLotDutBinAgg` 实现 focusBin 参数，BIN55 的 DUT 明细写到 JSON 顶部 — 2026-06-06 完成
- ✅ Session 日志合并：`SessionLogger` 改为按 `sessionId` 命名文件，同一会话所有轮追加到一个文件 — 2026-06-06 完成
- ✅ AI 会话日志：每次对话请求写 markdown 文件（时间戳命名，含用户提问/工具调用/AI 回答），存 `session-logs/` — 2026-05-26 完成
- ✅ Phase 2：JB 报表顶部坏 Bin 分布总览（`binDist` 区段）+ lot 树表"主要坏 bin"列 — 2026-05-25 完成
- ✅ 报表重构：所有 chart drilldown 视觉标志（红色禁止圈）+ YM/JB 重复图表清理 — 2026-05-25 完成
- ✅ Code Review 修复：前后端 yieldCalc 边缘逻辑对齐、路由处理器拆分、并行文件访问、调试脚本清理 — 2026-05-25 完成
- ✅ Agent Prompt 工程经验章节：DUT 报警/坏 bin/温度层/INTERRUPT 参考表 + 3 步诊断流程 — 2026-05-25 完成
- ✅ pcr-ai-report 报告重建：YieldMonitorReport、InfcontrolReport（JB STAR）、AiAgentReport 占位、DraggableReportSections — 2026-05-13 完成
- ✅ Device analysis、probeCardType filter、layout & UX fixes — 2026-05-13 完成
- ✅ 全局文档拼写修正：JB START → JB STAR — 2026-05-15 完成
- ✅ LLM Query Agent：完成 Node.js ReAct Agent 原型（Function Calling + 硅基流动） — 2026-05-16 完成
- ✅ AI 助手 Tab 实现：从占位升级为真实对话（接入 Agent） — 2026-05-16 完成
- ✅ AI Agent SSE 无响应修复与回归测试 — 2026-05-16 完成
- ✅ Agent ask_clarification 防空校验 + 前端空气泡修复 — 2026-05-16 完成
- ✅ INF site-bin-bylot API + 报表集成（InfDutDistPanel、infGoodBins、drillAggregate、ChartDrillSplit） — 2026-05-21 完成
- ✅ 图表布局重构：全行块 + 右侧下钻（Yield + JB STAR 统一） — 2026-05-21 完成
- ✅ Node 23+ oracledb 兼容修复（polyfillUtilIsDate）+ dev 默认 Dummy — 2026-05-21 完成
- ✅ nginx 部署工具：pack-report-dist.mjs（npm run pack:dist） — 2026-05-21 完成
- ✅ AI Agent 历史上下文延长（SUMMARIZE_THRESHOLD 40、KEEP_RECENT 20、MAX_MESSAGES 80） — 2026-05-21 完成
- ✅ AI Agent 流式体验优化（LOOKAHEAD 12、status 事件补充、pending 气泡显示 statusHint） — 2026-05-21 完成
- ✅ AI Agent 工具后强制总结（`tool_choice: "none"` 总结轮、idle 超时、DeepSeek filter flush） — 2026-05-22 完成
- ✅ Code Review 修复：agentStream 双超时注册（删除 req.setTimeout）、测试去 env 副作用（streamTimeoutMs 直接注入）、总结轮 SUMMARIZE_NUDGE 改并入 system prompt（非标 trailing system 消息 → SiliconFlow 空响应） — 2026-05-22 完成
- ✅ AI Agent MiniMax 2.5 tool_call 流式泄漏过滤：createDeepSeekFilter 扩展支持 `<minimax:tool_call>` 格式，过滤泄漏并解析为 CollectedToolCall 执行 — 2026-05-22 完成
