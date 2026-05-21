# WaferMind 开发日志

---

## 2026-05-21 — INF DUT 分布面板、drill 缓存、图表布局重构、Node 23+ 兼容修复

**完成内容：**
- `pcr-ai-api/src/polyfillUtilIsDate.ts` + `loadEnv.ts`：Node 23+ 删除了 `util.isDate`，oracledb 5.5 Date 绑定会崩溃；在加载 oracledb 前打补丁；`npm run dev` 下自动开启 Dummy（`PCR_AI_LOCAL_DUMMY=false` 可关闭）。
- `pcr-ai-report/src/components/InfDutDistPanel.tsx`：新组件，展示 JB STAR lot/slot 下各 DUT 的 bin 分布（stacked bar，per pass）；调用 `GET /inf-analysis/site-bin-bylot`；默认只显示 good bins。
- `pcr-ai-report/src/components/ChartDrillSplit.tsx`：新组件，CSS grid `1fr 1fr`，左图 + 右侧下钻面板跨全行，`overflow:hidden` 防首次点击页面变宽。
- `pcr-ai-report/src/utils/infGoodBins.ts`：从三来源合并 good bin — `HARD_GOOD_BIN=1`、`bins[].isGoodBin`、PASSBIN 连字符格式（`1-55-250`）；与 API `parsePassBinHyphenGoodBins` 逻辑一致。
- `pcr-ai-report/src/utils/drillAggregate.ts`：`drillFromTree()` 从内存 aggTree 按父维切片，切换 drill tab 不再重复请求 Oracle；优先级：aggTree → list rows → tab cache → Oracle。
- `pcr-ai-report/src/reports/YieldMonitorReport.tsx` + `InfcontrolReport.tsx`：改为全行块 + 右侧下钻布局（`ChartDrillSplit`）；DUT# 分布移入 ProbeCard 下钻面板底部；JB detail 行按 Yield% 升序；Y 轴 `containLabel: true` 防截断。
- `pcr-ai-report/scripts/pack-report-dist.mjs`：`npm run pack:dist` 打 `dist.tar` 供 nginx 一步部署（extract at web root）。
- `CLAUDE.md`（根目录）：补 `loadEnv.ts` 启动链、`ChartDrillSplit`/`InfDutDistPanel`、新 utils、`pack:dist`/PM2 命令、修正 INF 状态为"已实现"。
- `feature/site-bin-bylot-integration` 已 fast-forward merge 到 `main`，分支已删除。

**测试：** 94 个测试，92 pass，2 skip（Oracle 集成测试），0 失败。

## 2026-05-16 — Agent ask_clarification 防空校验 + 前端空气泡修复

**完成内容：**
- `pcr-ai-api/src/lib/agent/agentTools.ts`：`ask_clarification` 工具对 `question` 做非空/trim 校验，空白时返回错误字符串让模型重试，防止空 clarification 事件导致对话死锁。
- `pcr-ai-report/src/reports/AiAgentReport.tsx`：`case "clarification"` SSE 处理改为检查最后一条消息是否为空 AI 气泡，若是则原地替换为 clarification 气泡，而不是追加，消除 ask_clarification 仅触发时界面出现空白 AI 框的问题。

**测试：** `tsc --noEmit`（pcr-ai-api）及 `tsc -b`（pcr-ai-report）均无类型错误；无功能回归。

## 2026-05-16 — AI Agent SSE 无响应修复

**完成内容：**
- `pcr-ai-api/src/routes/agent.ts`：将 SSE 客户端断开判断从 `req.close` 改为 `res.close`，修复 POST 请求体读完后误判连接关闭导致前端“输入后无反应”的问题。
- `pcr-ai-api/src/lib/agent/agentStream.ts`、`pcr-ai-api/.env.example`：新增 `AGENT_STREAM_TIMEOUT_MS` 流式上游总超时，默认 30000ms，避免 SiliconFlow 连接/响应停滞时前端一直空等。
- `pcr-ai-api/test/agentRoute.test.ts`、`pcr-ai-api/test/agentStream.test.ts`、`pcr-ai-api/package.json`：新增 SSE 路由与流式超时回归测试，并将 `npm test` 扩展为运行全部 `test/*.test.ts`。
- `CLAUDE.md`、`pcr-ai-api/CLAUDE.md`、`pcr-ai-report/CLAUDE.md`：记录 AI Agent 新链路、根因、修复点、验证命令和交接注意事项，避免继续按旧 `GET /siliconflow/chat` 排查聊天页。

**测试：** 46 个测试，0 失败（44 pass，2 skip）；`npm run typecheck` 通过；`npm run build` 通过。

## 2026-05-15 — 文档修正：JB START → JB STAR 全局重命名

**完成内容：**
- `CLAUDE.md`：修正 "JB START" 拼写为 "JB STAR"
- `docs/superpowers/plans/2026-05-13-report-rebuild.md`：全文替换 "JB START" → "JB STAR"（涉及 UI 标签、注释、commit message 模板等多处）
- `docs/superpowers/specs/2026-05-13-report-rebuild-design.md`：Tab 列表及 Section 5 标题修正
- `.superpowers/brainstorm/` 相关 HTML 文件：approaches、final-nav、grouping-options、wireframe 同步修正
- `.claude/settings.local.json`：权限/配置微调

**测试：** 无代码变更，仅文档；无测试需运行。
