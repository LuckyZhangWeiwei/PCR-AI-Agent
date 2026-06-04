# TODO

## ⭐ 下一步开发顺序

| 优先级 | 任务 | 备注 |
|--------|------|------|
| 1 | 服务器部署新版本 | `npm run build + pm2:reload`（API）；`npm run pack:dist` → scp + tar xf（前端） |
| 2 | AI Agent 生产部署验证 | 确认 `AGENT_API_KEY`、`AGENT_STREAM_TIMEOUT_MS`（默认 120s）、PM2 重启后聊天可用；验证 query_lot_dut_bin_agg 工具正常调用 |
| 3 | YM 确定性摘要路径 | 类似 JB 的 tryRunDeterministicJbSummary，服务端直出表，LLM 仅写解读 |

## 待办

- [ ] 服务器部署：API `npm run build + pm2:reload`；前端 `npm run pack:dist` → scp dist.tar → nginx web root
- [ ] AI Agent 生产部署验证：确认 `AGENT_API_KEY` / `SILICONFLOW_API_KEY`、PM2 重启后聊天页可用；验证 `query_lot_dut_bin_agg` 工具调用正常
- ✅ INF DUT 面板 Agent 工具：`query_inf_site_bin_by_dut` 接入 agentPrompt + agentToolHandlers — 已完成（早于本次记录）
- ✅ Agent 新工具 query_lot_dut_bin_agg：lot 级 DUT×Bin 聚合，复用已有 lot 级 INF API，dummy 双路径 — 2026-06-02 完成
- ✅ 前端使用 `mask` 字段：JB Star 聚合 charts 新增 Mask 不良分析图 + 所有下钻选项加 Mask — 2026-05-27 完成
- [ ] Phase 1：YM 报表顶部新增探针卡报警排名图（`ProbeCardRankPanel.tsx`）
- [ ] Phase 2b：YM↔JB 跨报表跳转链接
- [ ] Phase 3 前端：`LotDutBinPanel.tsx`（lot 级堆叠条形图，调用已有 `/inf-analysis/site-bin-bylot?device&lot`）
- [ ] YM 确定性摘要路径：类似 tryRunDeterministicJbSummary，YM lot 查询后服务端直出探针卡报警排名表
- [ ] 报表重构：识别并提取 YM/JB 相同维度分析为共用组件（精简重复）

## 已完成

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
