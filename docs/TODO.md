# TODO

## ⭐ 下一步开发顺序

| 优先级 | 任务 | 备注 |
|--------|------|------|
| 1 | AI Agent 生产部署验证 | 确认 `AGENT_API_KEY` / `SILICONFLOW_API_KEY`、`AGENT_STREAM_TIMEOUT_MS`、PM2 重启后聊天页可用 |
| 2 | INF DUT 面板 Agent 工具接入 | `query_inf_site_bin_by_dut` prompt 附录接入 Agent；见 `docs/SITE_BIN_BY_LOT_INTEGRATION.md` |
| 3 | 服务器部署新版本 | `npm run pack:dist` → scp dist.tar → `tar xf`；更新 API `pm2:reload` |

## 待办

- [ ] AI Agent 生产部署验证：确认 `AGENT_API_KEY` / `SILICONFLOW_API_KEY`、`AGENT_STREAM_TIMEOUT_MS`、PM2 重启后聊天页可用
- [ ] INF DUT 面板 Agent 工具：`query_inf_site_bin_by_dut` 接入 agentPrompt + agentToolHandlers（设计见 `docs/SITE_BIN_BY_LOT_INTEGRATION.md`）
- [ ] 服务器部署：运行 `npm run pack:dist`，scp + tar xf 到 nginx web root；API `pm2:reload`

## 已完成

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
