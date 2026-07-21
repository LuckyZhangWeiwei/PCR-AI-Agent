# Vero 驱动的通用 Agent 循环内核 — 设计（2026-07-21）

> **执行者：** Claude Code（设计）→ 待 Cursor 或后续会话实现 + 真实网络验证
> **读者：** 接手实现的 Agent / 同事
> **前置阅读：** [`HANDOFF_CURSOR_VERO_PROBE_CARD_PILOT.md`](../../HANDOFF_CURSOR_VERO_PROBE_CARD_PILOT.md)（Path B 试点，本设计是它的推广）
> **分支：** `mcp-branch`

---

## 0. 背景与目标

今天（2026-07-21）已验证 wchat（Vero Studio `POST /api/simple-agent/invoke`，背后是 Claude 4.6，128K 上下文）能替代 SiliconFlow 做「探针卡×机台组合」这一条问答的抽参 + 解读（`agentProbeCardVeroPilot.ts`，已合入 `ad2e5ec`）。

用户目标：**把整个 AI Agent 的模型层从 SiliconFlow（DeepSeek-V4-Flash / MiniMax-M2.5）完全换成 wchat/Vero 驱动**，包括：

1. 现有 5 个 direct-route 能力组（JB bin、JB lot、DUT 聚合、wafer map、探针卡组合）逐个迁移到 Vero pilot 写法（**探针卡组合已完成**）。
2. 兜底的通用 ReAct 循环（`agentLoop.ts` 中不匹配任何 direct route 时走的自由问答 + 多轮工具调用）也要用 Vero 驱动。
3. 妥善处理 Claude 4.6 128K 上下文（相对 SiliconFlow 侧 MiniMax-M2.5 的 192K 更紧张）。

这是架构级迁移，拆成 3 个子项目：

| # | 子项目 | 状态 |
|---|---|---|
| A | **本文档**：Vero 驱动的通用 ReAct 循环内核 | 设计中 |
| B | 剩余 4 个 direct-route 能力组迁移到 Vero pilot | 未开始（沿用 Path B 模式，风险低，可与 A 并行） |
| C | 退役 SiliconFlow / DeepSeek / MiniMax 相关代码 | 未开始（待 A + B 验证稳定后） |

**本设计只覆盖子项目 A。**

---

## 1. 范围

### 1.1 做什么

新增并行实现 `pcr-ai-api/src/lib/agent/core/veroAgentLoop.ts`，用 Vero 的 `simple-agent/invoke` 驱动"模型决定调哪个工具 / 何时给出最终答案"的多轮循环，替代现有 `agentLoop.ts` 中对 `streamSiliconFlow` 的调用。

### 1.2 不做什么（明确排除）

- 不做真正的 MCP（Model Context Protocol）server/client 对接。Vero 没有暴露给我们可用的 MCP endpoint，也不需要——手写 JSON 协议已经在 Path B 验证过。
- 不追加真实 token 级流式输出。Vero `simple-agent/invoke` 是一次性返回完整 response，`emitTextInChunks` 模拟打字机效果的现状保留不变（今天「设备组合」实测无异常，用户已确认）。
- 不改动 `PRE_LLM_DIRECT_ROUTES`（wafer map、JB 各类直连、DUT 聚合等）内部逻辑——这些是纯服务端规则，不依赖具体模型。
- 不在本子项目里删除 SiliconFlow 相关代码（那是子项目 C 的事）。
- 不改前端。`AiAgentReport` 仍然只对接 `POST /api/v4/agent/chat` 的 SSE 协议，事件类型（`text`/`status`/`tool_start`/`tool_result`/`chart`/`clarification`/`done`/`error`）不变。

---

## 2. 架构

### 2.1 入口与灰度开关

`runAgentLoop(message, sessionId, agentConfig, emit, options)`（`agentLoop.ts` 现有导出函数，路由层 `routes/agent.ts` 唯一调用点）在函数体最开头新增门槛判断：

```
if (isVeroGenericLoopReady()) {
  return runVeroAgentLoop(message, sessionId, agentConfig, emit, options);
}
// ...原有 SiliconFlow 实现，原样不动
```

`isVeroGenericLoopReady()`（新增，`vero/veroSimpleAgent.ts` 或旁边新文件）：`AGENT_VERO_GENERIC_LOOP=true` **且** `WCHAT_ACCESS_TOKEN` 非空才为真——与 Path B 的 `isProbeCardVeroPilotReady()` 同款判断逻辑（可考虑抽出共享 helper，视实现时代码量决定）。

**调用方零改动**：`routes/agent.ts` 不用感知这个分支，仍然只调 `runAgentLoop`。灰度只需要改 `.env` + `pm2 reload`，出问题直接关 flag 秒回滚到今天生产在跑的行为。

### 2.2 `runVeroAgentLoop` 内部流程

```
prepareRunAgentLoopContext(...)          // 复用，不变：历史加载、manifest、feedback 注入
for round in 0..maxRounds:
  history = getHistory(sessionId)
  awaitingSummary = historyAwaitingToolSummary(history)   // 复用判断逻辑
  userQuestion = lastUserMessageText(history, message)

  // PRE_LLM_DIRECT_ROUTES 原样复用——纯服务端规则，不过 Vero
  for runDirectRoute in PRE_LLM_DIRECT_ROUTES:
    if await runDirectRoute(...): return

  // ↓ 本子项目新写的部分，替代原 streamSiliconFlow 调用 ↓
  prompt = buildVeroRoundPrompt(sessionId, history, userQuestion, round, maxRounds)
  decision = await invokeVeroAgentRound(prompt)   // parseJsonLoose，同 Path B

  switch decision.action:
    case "tool":
      result = await runTool(decision.tool, decision.args, { toolResultMaxChars, history })
      appendSyntheticToolTurn(sessionId, { name: decision.tool, args: decision.args, content: result })
      emit({ type: "tool_start", ... }); emit({ type: "tool_result", ... })
      continue  // 下一轮
    case "final" / "chat":
      emitTextInChunks(decision.reply, emit)
      appendMessages(sessionId, { role: "assistant", content: decision.reply })
      emit({ type: "done" })
      return

// 到 maxRounds 仍未 final → 兜底：用已执行的工具结果拼一个简短结论（见 §4），不空手报错
```

`PRE_LLM_DIRECT_ROUTES`、`runTool`、`appendSyntheticToolTurn`、`getHistory`/`appendMessages`、SSE 事件类型——全部原样导入复用，不重写。

---

## 3. 协议设计

新增 `pcr-ai-api/src/lib/agent/vero/veroAgentProtocol.ts`：

### 3.1 工具 schema 渲染

`renderToolSchemasAsText(schemas: ToolSchema[]): string`——把 `agentToolSchemas.ts` 里已有的 15+ 个工具 JSON Schema（唯一数据源，不新开一份）转成人类可读文本块（工具名 + 描述 + 参数说明），拼进 system prompt。新增工具时只需改 `agentToolSchemas.ts` 一处，Vero 侧自动跟着变。

### 3.2 每轮 JSON 协议

沿用 `agentProbeCardVeroPilot.ts` 已验证的写法，扩展为可循环：

```json
{"action":"tool","tool":"<name>","args":{...}}
{"action":"final","reply":"<最终中文回答，markdown>"}
{"action":"chat","reply":"<闲聊/澄清，无需工具>"}
```

`parseJsonLoose`（已有，`veroSimpleAgent.ts`）负责容错解析（裸 JSON / ```json 围栏 / 首尾 `{…}` 截取）。

### 3.3 收尾保护

`round === maxRounds - 1` 时，system prompt 追加一句强约束："这是最后一轮，必须返回 `action:final`，禁止再要求调用工具"。若模型仍不配合（返回 `tool` 或解析失败），服务端用已执行过的工具结果生成一个兜底简短结论（复用现有 `tryRunDeterministicJbSummary` 等确定性汇总的思路：有数据就整理成文字，不生造内容），而不是让用户空手看到报错。

---

## 4. 128K 上下文预算

Claude 4.6 128K 相对现有 SiliconFlow 侧 MiniMax-M2.5（192K，`largeContext` 档）更紧张，且 Vero 没有 messages[] 数组、需要我们手写整段 prompt 字符串，风险点集中在**单次 turn 内多轮工具结果的累积**（而非跨 turn 的会话历史——那部分复用现有 `needsSummarization` 机制已经够用）。

### 4.1 复用 + 新增校准常量

- 复用 `agentHistory.ts` 现有的 `needsSummarization` / `popOldMessagesForSummarization`（跨轮摘要机制不变）。
- 新增 Vero 专用校准常量（初始估算值，**标记为待 Cursor 用真实 Vero 调用观察输出质量后微调**）：
  - `VERO_SUMMARIZE_THRESHOLD = 60`（相对 MiniMax 大上下文档的 80，按 128K/192K ≈ 0.67 折算并留安全余量）
  - `VERO_TOOL_RESULT_MAX_HISTORY_CHARS = 15000`（相对现有 `LARGE_CTX_TOOL_RESULT_MAX_HISTORY_CHARS = 20000` 同比例折算）
  - `VERO_MAX_OUTPUT_HINT`：在 prompt 里提示模型控制回答长度，避免单次 response 过长（Vero 没有 `max_tokens` 参数可传，只能靠 prompt 约束）

### 4.2 单轮字符预算护栏（新增，现有 SiliconFlow 循环没有）

`buildVeroRoundPrompt` 组装完 `system + summary + 历史 + 最新工具结果` 后，若总字符数超过约 **18 万字符**（128K token 的保守字符估算，留出模型输出 + 安全余量），**在发送前**主动触发一次历史压缩（调用 `popOldMessagesForSummarization` 提前收紧），而不是等下一轮才检查。这是专门为"手写大 prompt 字符串"场景加的护栏，原有基于 messages 数组传给 SiliconFlow 的循环没有这个必要（该场景下按 token 计费/截断由供应商 API 自己处理）。

---

## 5. 错误处理

Vero 调用失败（网络错误、超时、JSON 解析失败）：

1. 重试 1 次（同步、无退避，因为 Vero 单次调用已经可能耗时较久）。
2. 仍失败 → SSE `error` 事件，保留本轮已经产生的部分文本（若有），不尝试切回 SiliconFlow 循环——两套循环的历史/状态表示不兼容，混着切会导致状态不一致，比直接报错更难排查。
3. 用户可重新发送 / 用现有 `retry: true` 机制重试（`resume: true` 从 session 续跑，机制不变）。

---

## 6. 灰度与回滚

- 环境变量：`AGENT_VERO_GENERIC_LOOP=true` + `WCHAT_ACCESS_TOKEN`（与 Path B 共用同一个 token）。
- `ecosystem.config.cjs` 的 `ORACLE_FORWARD_KEYS` 追加 `AGENT_VERO_GENERIC_LOOP`（`WCHAT_ACCESS_TOKEN`/`VERO_*` 已在 Path B 时加过，复用）。
- 关闭：`AGENT_VERO_GENERIC_LOOP=false` 或清空 token → `pm2 reload` → 整体回退到今天生产在跑的 SiliconFlow 循环，行为不受本子项目影响。
- 两套循环（`agentLoop.ts` 旧实现 / `veroAgentLoop.ts` 新实现）在合入后会并存一段时间，直到子项目 B + C 完成、验证稳定，再删除旧实现。

---

## 7. 测试计划

- **单元测试**（mock `invokeVero`，无需真实 token，仿照 `test/veroProbeCardPilot.test.ts` 的 mock 模式）：
  - `buildVeroRoundPrompt` 在超过字符预算时触发压缩
  - 多轮循环：tool → tool → final 的正常路径
  - 协议解析容错：裸 JSON / fenced JSON / 畸形 JSON → 走兜底
  - 到达 `maxRounds` 仍未 final → 服务端兜底结论，不空手报错
  - flag 关闭 / token 缺失 → 完全不进入新循环（现有 `runAgentLoop` 行为不受影响，回归测试用现有 `test/agentLoop.test.ts` 验证）
- **真连冒烟**（仿照 `scripts/smoke-vero-probe-card-pilot.mjs`）：跑几条现有 direct-route 覆盖不到的自由提问，观察 Claude 4.6 是否稳定吐出协议 JSON、多轮工具调用是否正确收尾。

---

## 8. 交给 Cursor 的开放问题（需真实网络 + 真实 token 验证）

1. **Vero 是否有其他支持流式输出的接口/参数**——本设计假设没有，沿用一次性返回 + `emitTextInChunks` 模拟。若 Cursor 发现 Vero Studio 其实有 SSE 端点，值得后续单独评估是否切换（不阻塞本子项目落地）。
2. **单轮 prompt 在真实数据量下的实际字符量**——例如 25 片 wafer 全量 JB 数据、`aggregate_jb_bins` 大结果集，实测 §4 的 18 万字符护栏阈值和 `VERO_TOOL_RESULT_MAX_HISTORY_CHARS=15000` 是否合适，需要真实调用后回填修正数字。
3. **Claude 4.6 在多轮 JSON 协议下的稳定性**——是否会像 MiniMax/DeepSeek 那样偶尔吐出格式错误的 JSON 或在 markdown 代码块里夹杂解释文字，决定 `parseJsonLoose` 的容错逻辑是否需要加强。
4. **真实 token 下 §3.3 收尾保护的实际表现**——模型是否严格遵守"最后一轮必须 final"的约束。

---

## 9. Hard rules（接手勿破）

沿用 `pcr-ai-api/CLAUDE.md` 现有规则，本子项目额外注意：

1. **no-undici**：Vero 出站只用 `node:https`（`veroSimpleAgent.ts` 已是这样，新代码不要引入 undici）。
2. **勿把 `WCHAT_ACCESS_TOKEN` 写进仓库 / 前端 / handoff 正文**。
3. **dummy-parity 不适用于本子项目**（不涉及 Oracle/Dummy 双路径，`runTool` 内部工具执行层已经保证这点，本子项目只换"谁来决定调哪个工具"）。
4. 两套循环并存期间，**不要在 `agentLoop.ts` 里为了共享代码而强行耦合两套实现**——目前的复用边界（direct routes / 工具执行 / 历史存储）已经是清晰的复用点，循环控制本身（§2.2 的 for 循环体）保持两份独立代码，等子项目 C 删除旧实现时自然收敛，不要提前做"参数化两套模型协议"这种抽象。
