# TODO

## ⭐ 下一步开发顺序

| 优先级 | 任务 | 备注 |
|--------|------|------|
| 1 | 服务器部署新版本 | `npm run build + pm2:reload`（API）；`npm run pack:dist` → scp + tar xf（前端） |
| 2 | AI Agent 生产部署验证 | 确认 `AGENT_API_KEY`、`AGENT_STREAM_TIMEOUT_MS`（默认 150s）、PM2 重启后聊天可用；验证工具结果后能正常输出中文结论 |
| 3 | INF DUT 面板 Agent 工具接入 | `query_inf_site_bin_by_dut` 接入 agentPrompt + agentToolHandlers；见 `docs/SITE_BIN_BY_LOT_INTEGRATION.md` |

## 待办

- [ ] 服务器部署：API `npm run build + pm2:reload`；前端 `npm run pack:dist` → scp dist.tar → nginx web root
- [ ] AI Agent 生产部署验证：确认 `AGENT_API_KEY` / `SILICONFLOW_API_KEY`、PM2 重启后聊天页可用；验证工具调用后能正常输出分析结论（已修复总结轮非标消息结构 + 双超时注册）
- [ ] INF DUT 面板 Agent 工具：`query_inf_site_bin_by_dut` 接入 agentPrompt + agentToolHandlers（设计见 `docs/SITE_BIN_BY_LOT_INTEGRATION.md`）
- [ ] Phase 1：YM 报表顶部新增探针卡报警排名图（`ProbeCardRankPanel.tsx`）
- [ ] Phase 2b：YM↔JB 跨报表跳转链接
- [ ] Phase 3：新 API `GET /inf-analysis/lot-dut-bin-agg`（读取 `/data/INF/{DEVICE}/{LOT}/` 下最多 25 个 INF 文件汇总）+ 前端 `LotDutBinPanel.tsx`
- [ ] 报表重构：识别并提取 YM/JB 相同维度分析为共用组件（精简重复）

## 已完成

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
