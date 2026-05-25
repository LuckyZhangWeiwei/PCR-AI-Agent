# WaferMind 开发日志

---

## 2026-05-25 — JB 中断 slot 良率半片 + Agent 汇报顺序

**完成内容：**
- `jbYieldCalc.ts`：`slotYieldSummary` 增加 `interruptHalf` / `completionHalf`；`computeJbYieldBreakdown`；整片正片仍走 `computeJbYieldMetrics`（前半 good=0 → 仅后半）。
- `agentPrompt.ts`：有中断时输出顺序 **整片正片 → 前半段 → 后半段**；良率 0% 也必须写出。
- 诊断脚本 `scripts/print-slot-breakdown.ts`；单测 `jbYieldCalc.test.ts` 半片用例。
- 交接文档 [`HANDOFF_JB_INTERRUPT_YIELD.md`](HANDOFF_JB_INTERRUPT_YIELD.md)，`pcr-ai-api/CLAUDE.md` §2 已索引。

**部署：** `npm run build` + `pm2:reload` 后 Agent `query_jb_bins` 才带半片字段。

**测试：** `npm test`（含 `jbYieldCalc.test.ts`）。

**后续（同分支）：** `f448422` 用 passId+passNum/TESTEND 识别续测；`agentJbBinFormat` 单测确认 `yieldPct:0` 写入 JSON。交接见 `HANDOFF_JB_INTERRUPT_YIELD.md` §5 0% 清单。

---

## 2026-05-24 — 规划：INF 文件聚合路径 + 报表重构 UX 原则

**完成内容：**
- 确定 lot 级 DUT×Bin 聚合数据源路径规则：`/data/INF/{DEVICE大写}/{LOT大写}/`，最多 25 个 INF 文本文件；device 级路径 `/data/INF/{DEVICE大写}/` 文件量大，不轻易触发
- 明确报表重构三项 UX 原则：① YM↔JB 跨报表跳转链接；② 相同维度分析逻辑抽共用组件（精简重复）；③ Drilldown 可用性视觉标志——不可下钻的 chart hover 时显示红色禁止圈（`cursor: not-allowed`）
- 以上规则已记录至项目记忆（`memory/project_report_ux_dut_bin_plan.md`）

**测试：** 无代码变更，无测试运行。

---

## 2026-05-22 — AI Agent 允许总结轮继续调工具（多步推理）

**现象：** MiniMax 2.5 对复杂查询（如"top15 lot device yield"）在工具结果返回后仍需追加调用第二个工具（`aggregate_jb_bins` → `query_jb_bins`），触发"模型在总结阶段仍尝试调用工具"错误，无法得到最终结论。

**根因：** `agentLoop.ts` 的 `awaitingSummary && toolCalls.length > 0` 错误块阻断了合法的多步推理。MiniMax 通过 `<minimax:tool_call>` 嵌入格式调用工具，新增的 MiniMax filter 将其转换为 `toolCalls`，触发该错误。

**完成内容：**
- `pcr-ai-api/src/lib/agent/agentLoop.ts`：删除 `if (awaitingSummary)` 工具调用错误块。`maxRounds`（默认 5）是防止无限循环的正确安全网；`SUMMARIZE_NUDGE` 持续引导模型最终输出中文结论。多步推理可正常进行（如 aggregate → query → 结论）。

**测试：** 108 个测试，106 pass，2 skip，0 失败。

---

## 2026-05-22 — AI Agent MiniMax 2.5 tool_call 流式泄漏过滤

**现象：** 使用 MiniMax 2.5 模型时，工具调用以 `<minimax:tool_call>…</minimax:tool_call>` XML 格式泄漏到聊天气泡，工具未被执行，后续也无分析输出。

**完成内容：**
- `pcr-ai-api/src/lib/agent/agentLoop.ts`：`createDeepSeekFilter` 扩展支持 MiniMax 格式：新增 `MINIMAX_START_RE`、`MINIMAX_END_RE`、`MINIMAX_INVOKE_RE`、`MINIMAX_PARAM_RE`、`MINIMAX_PARTIAL_OPEN_TAIL_RE` 常量；新增 `tryExtractFromMinimaxBuf()`（解析 `<invoke name>` + `<parameter name>`，生成 `CollectedToolCall`）；`scanForTokens` 加入 MiniMax 检测分支；`push` / `finalize` 接入 `"minimax"` tokenKind。
- `pcr-ai-api/test/agentLoop.test.ts`：新增 2 个测试（完整块 / 跨 chunk 分割），108 tests，106 pass。

**测试：** 108 个测试，106 pass，2 skip，0 失败。

---

## 2026-05-22 — Code Review 修复：双超时 / 测试健壮性 / 总结轮非标消息

**完成内容：**
- `pcr-ai-api/src/lib/agent/agentStream.ts`：删除 `req.setTimeout(timeoutMs, handleTimeout)`。`req.setTimeout` 是 Node socket 级超时，从请求开始固定计时、不因 SSE 字节流入而重置，会在 `timeoutMs` 精确杀死仍在传输的长流；`data` 事件里的 idle-reset `setTimeout` 已足够。
- `pcr-ai-api/src/lib/agent/agentConfig.ts`：`resolveStreamTimeout` 新增对 `override?.streamTimeoutMs` 的直接支持（原先只认 `streamTimeoutSec`），使测试可传 `streamTimeoutMs: 20` 而无需依赖 env 副作用。
- `pcr-ai-api/test/agentStream.test.ts`：两个超时测试去掉 `process.env.AGENT_STREAM_TIMEOUT_MS` 设置/还原，改为 `resolveAgentConfig({ streamTimeoutMs: 20 })` 直接注入，消除模块缓存脆弱性。
- `pcr-ai-api/src/lib/agent/agentLoop.ts`：把 `SUMMARIZE_NUDGE` 从追加在 `messages` 末尾的 `{ role: "system" }` 改为并入第一条 system prompt（仅对总结轮）；去掉总结轮的 `tool_choice: "none"`（无 `tools` 时该字段冗余，部分 SiliconFlow/DeepSeek 版本对无 `tools` + `tool_choice: "none"` 组合返回空响应）；总结轮 LLM 调用前新增 `{ type: "status", message: "正在生成分析结论…" }` 事件，减少用户等待感知。

**测试：** 106 个测试，104 pass，2 skip（设计跳过），0 失败。

---

## 2026-05-22 — AI Agent 聊天气泡横线（~~）与页面双滚动条

**现象：** 模型用 **`~~…~~`** 标「未展示/截断」时，GFM 渲染成删除线横线；消息变多后**页面最外层**出现纵向滚动条（应只在消息区滚动）。

**完成内容（仅 `pcr-ai-report`）：**
- **`utils/sanitizeAgentMarkdown.ts`**：展示前去掉 **`~~…~~`** 包裹。
- **`AiAgentReport.tsx`**：**`remarkGfm({ singleTilde: false })`**；**`del`/`s`** 组件不画删除线。
- **`AiAgentReport.css`**：去掉 **`calc(100vh - 180px)`**，**`flex: 1; min-height: 0; overflow: hidden`**；**`.ai-agent-messages`** 加 **`min-height: 0`**。
- **`index.css` + `App.tsx`**：AI Tab 使用 **`tab-panel--agent`** 占满 grid 第三行。
- 交接：**`pcr-ai-report/CLAUDE.md` §19**、根 **`CLAUDE.md`**。

**部署：** 前端 rebuild / 重启 dev（无 API 变更）。

---

## 2026-05-22 — AI Agent Settings 可配超时 + 流式泄漏过滤（think / DSML）

**现象：** 聊天气泡偶发 **think**、**`redacted_thinking`**、**`<｜DSML｜tool_calls>`** 等内部标记；复杂 INF 下钻需更长 idle 超时。

**完成内容：**
- **Settings**：**`streamTimeoutSec`**（默认 150s，30–600）、**`clientTimeoutSec`**（默认 180s）；随 **`agentConfig`** 下发；**`agentStream.ts`** 用 **`streamTimeoutMs`**；未传回退 **`AGENT_STREAM_TIMEOUT_MS`**。
- **`agentLoop.ts` `createDeepSeekFilter`**：剥离 `` / `` / **`<think>`**；剥离 **DSML** 工具块（结束标签 **`</｜DSML｜tool_calls>`**，无尾部 `｜`）；可解析为嵌入式 **`query_*`** 调用；**`agentStream.ts`** 不转发 **`reasoning_content`**。
- 测试：**`agentLoop.test.ts`**（think / thinking / DSML）；**`agentConfig.test.ts`**（**`streamTimeoutSec`**）。
- 交接：**`pcr-ai-api/CLAUDE.md` §11 条目 14/§12.1**、**`pcr-ai-report/CLAUDE.md` §17–§18**、根 **`CLAUDE.md`**。

**部署：** API **`npm run build` + pm2 reload**；前端 rebuild / 重启 dev。

---

## 2026-05-22 — AI Agent New Chat 重置、超时 150s

**现象：** 请求进行中点 **New Chat** 后，底部「仍在处理中」与 **发送** 按钮仍显示「处理中」；上游 idle 超时默认 270s 偏长。

**完成内容：**
- `pcr-ai-report/src/reports/AiAgentReport.tsx`：**`chatGenerationRef`** 隔离旧 SSE；**`newSession`** 先 **`setLoading(false)`** 再 **`abort()`**；stale **`finally`** 在 **`abortRef === null`** 时兜底重置 UI。
- `pcr-ai-api/src/lib/agent/agentStream.ts`：**`AGENT_STREAM_TIMEOUT_MS`** 默认 **270s → 150s**（idle：有 SSE 字节则重置计时）。
- `pcr-ai-report`：客户端整请求超时 **180s**（略大于后端）；Vite dev 代理 **`timeout` / `proxyTimeout`** 同步 **180s**；超时提示改按秒显示。
- 交接：**`pcr-ai-api/CLAUDE.md` §6/§11 条目 13/§12.1**、**`pcr-ai-report/CLAUDE.md` §16**、根 **`CLAUDE.md`**。

**部署：** API **`npm run build` + pm2 reload**；若 `.env` 曾设 **`AGENT_STREAM_TIMEOUT_MS=270000`** 请改为 **150000** 或删除以用新默认。前端 rebuild / 重启 dev。

---

## 2026-05-22 — AI Agent 工具后强制总结（有数据无输出 / 超时）

**现象：** 工具（如 `aggregate_yield_triggers`）JSON 已在 UI 展示，但第二轮 LLM 无中文结论，270s 或前端 5min 超时；与 2026-05-21 流式 UX 改动无关。

**完成内容：**
- `pcr-ai-api/src/lib/agent/agentLoop.ts`：`historyAwaitingToolSummary`；工具后总结轮 `tool_choice: "none"` + `SUMMARIZE_NUDGE`；DeepSeek filter `finalize()` flush；tool 消息补 `name`；空总结/总结轮再调工具 → 明确 error。
- `pcr-ai-api/src/lib/agent/agentStream.ts`：idle 超时（有 SSE 字节则重置 `AGENT_STREAM_TIMEOUT_MS`）。
- `pcr-ai-api/test/agentLoop.test.ts`：回归 `historyAwaitingToolSummary`。
- 交接：**`pcr-ai-api/CLAUDE.md` §6/§9/§11 条目 11/§12.1**、**`pcr-ai-report/CLAUDE.md` §15**、根 **`CLAUDE.md`**。

**测试：** `npm test`（含 `agentLoop.test.ts`）。

## 2026-05-22 — AI Agent 可配置轮数、超时重试、INF PASS_TYPE 过滤

**完成内容：**
- `pcr-ai-api/src/lib/agent/agentConfig.ts`：`AgentConfig.maxRounds`（默认 5，clamp 1–20）；环境变量 **`AGENT_MAX_ROUNDS`**；测试 **`test/agentConfig.test.ts`**。
- `pcr-ai-api/src/lib/agent/agentLoop.ts`：ReAct 上限读 **`agentConfig.maxRounds`**；支持 **`{ resume: true }`** 跳过重复追加 user 消息。
- `pcr-ai-api/src/routes/agent.ts`：请求体 **`retry: true`** 续跑 session。
- `pcr-ai-report`：Settings 新增「最大推理轮数」；**`AiAgentReport`** timeout 错误显示 **↻ 重试**（**`retry: true`** + 同 **`sessionId`**）。
- `pcr-ai-api/src/perlscripts/output_site_bin_bylot.pl`：仅统计 **`SmWaferPass`** 且 **`PASS_TYPE='TEST'`**（对齐 JB **`PASSTYPE=TEST`**）。
- 交接文档：**`pcr-ai-api/CLAUDE.md`** §6/§11/§12.1、**`pcr-ai-report/CLAUDE.md`** §14、根 **`CLAUDE.md`**、**`pcr-ai-api/docs/SITE_BIN_BY_LOT_API.md`**。

## 2026-05-21 — AI Agent 流式体验优化（历史上下文延长 + pending 状态显示 + LOOKAHEAD 收紧）

**完成内容：**
- `pcr-ai-api/src/lib/agent/agentHistory.ts`：`SUMMARIZE_THRESHOLD` 20→40、`KEEP_RECENT` 10→20、`MAX_MESSAGES` 60→80；正常会话极少触发压缩，lot ID / bin 编号不再被摘要洗掉。
- `pcr-ai-api/src/lib/agent/agentLoop.ts`：`LOOKAHEAD` 30→12，文字推送更连续（中文减少每批 15 字的卡顿）；补 3 条 `status` SSE 事件填补静默期（summarization 前 / manifest fetch 前 / 工具结果处理后）。
- `pcr-ai-report/src/reports/AiAgentReport.tsx`：空 AI 气泡改显示 `statusHint`（如"正在准备系统信息…"），不再只显示无意义的 `"…"`。
- `pcr-ai-report/src/reports/AiAgentReport.css`：新增 `.ai-status-hint`（灰色斜体，0.9em）。
- `pcr-ai-api/test/agentHistory.test.ts`：trim 断言同步更新为 `≤80 messages`。
- `pcr-ai-api/CLAUDE.md`、`pcr-ai-report/CLAUDE.md`：补充上述变更的交接说明。

**测试：** 94 个测试，92 pass，2 skip，0 失败。

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
