# Cursor 交接（2026-07-22 · 给 Claude Code）— Agent LLM 迁 WChat 最优方案

> **执行者：** Cursor Agent（方案已与产品方对齐）  
> **读者：** Claude Code / 接手实现的同事  
> **前置阅读：**  
> - [`HANDOFF_CURSOR_VERO_PROBE_CARD_PILOT.md`](HANDOFF_CURSOR_VERO_PROBE_CARD_PILOT.md) — 探针卡×机台 Path B 试点（**已合入 `mcp-branch`**）  
> - [`HANDOFF_AGENT_PROBE_CARD_TESTER_PERFORMANCE.md`](HANDOFF_AGENT_PROBE_CARD_TESTER_PERFORMANCE.md) — 确定性四表  
> - 根 [`CLAUDE.md`](../CLAUDE.md) Hard rules；`pcr-ai-api/CLAUDE.md` §11 Agent 循环  
> **分支建议：** 在 `mcp-branch` 上开子分支实现，或合入 main 后再开 `feat/wchat-llm-backend`  
> **范围：** 把 **SiliconFlow Chat Completions** 逐步替换为 **Vero/WChat `simple-agent/invoke`**，作为看板 Agent 的 LLM 后端；**工具执行仍在 `pcr-ai-api`**

---

## 0. 一眼结论（给 Claude Code 的决策）

| 项 | 结论 |
|---|---|
| **最优架构** | **① 关键字/PRE_LLM 路由拦截 → 固定工具**；**② 未命中 → WChat + 工具目录 JSON 选工具**；工具一律本地 `runTool` |
| **禁止** | 全量改用 WChat `agent/chat` + MCP 当看板主链路（易双查、超时、丢确定性表） |
| **WChat 角色** | 只做：抽参 JSON / 选工具 JSON / 写解读；**不执行** Oracle、不持有工具实现 |
| **与现试点关系** | 探针卡组合已是 ① 的样板；本方案是把同一范式扩到全 Agent |
| **硅基** | 过渡期双后端（flag）；稳定后默认 WChat，硅基作 fallback |
| **MCP（Path A）** | **可选旁路**，仅服务「人在 WChat UI 里聊」；与看板编排隔离，本文不实现 |
| **上下文上限** | Bedrock 模型本身约 **1M**；**WChat 平台实际 `context_window_max=200000`（20 万）** — 设计须按 **200k** 预算，勿按 1M 塞目录/历史（见 §2.1） |

产品方已确认该两段式路由为当前约束下的工程最优解（可信数字 + 长尾覆盖 + 可迁移）。

---

## 1. 目标架构

```text
AiAgentReport  POST /api/v4/agent/chat (SSE 形状不变)
        │
        ▼
   agentLoop
        │
        ├─① PRE_LLM / 关键字路由命中？
        │     yes → runTool(固定工具) → 确定性表/markdown（若有）
        │           → WChat simple-agent 仅写「数据解读/专业建议」
        │           → emit done
        │
        └─② 未命中
              → WChat simple-agent：输入 = 工具目录(切片) + 用户问题 + 短历史
              → 输出严格 JSON：
                    {"action":"tool","tool":"<name>","args":{...}}
                 或 {"action":"chat","reply":"..."}
                 或 {"action":"clarify","question":"...","options":[...]}
              → 白名单校验 tool 名 + args
              → runTool 本地执行
              → 若该工具有确定性总结路径 → 走现有 tryRunDeterministic*
              → 否则再调 WChat **总结轮**（prompt 禁止再选工具 / 禁止再查）
              → emit done
```

**不变：**

- 前端 SSE 事件类型（`status` / `tool_start` / `tool_result` / `text` / `done` / `error`）
- `runTool`、`TOOL_SCHEMAS` 业务语义、dummy-parity、oracledb 5.5、no-undici
- 确定性直出表（JB / 探针卡等）——数字不经 LLM 转述

**变的：**

- LLM HTTP：SiliconFlow `/v1/chat/completions` → WChat `/api/simple-agent/invoke`（主路径）
- 「选工具」：从 OpenAI `tool_calls` → **模型吐 JSON**，由 Node 解析后 `runTool`

---

## 2. 为何这是最优解（勿轻易改成 MCP 主链路）

| 约束 | ①+② Path B | 纯 `agent/chat`+MCP |
|---|---|---|
| 数字必须服务端表 | ✅ | ❌ 易转述/漏表 |
| Vero 须可达 MCP URL | 不需要 | 需要内网可达部署 |
| 双输出 / 超时 | 已踩坑，Path B 可避 | 高风险（MCP 再查） |
| 与现有 PRE_LLM 复用 | ✅ | 需重写编排 |
| 长尾问法 | ② 覆盖 | 模型自选，不可控 |

**不要做：** 把看板主循环改成「把用户话丢给 WChat agent/chat，指望 MCP 调 PCR」。

---

## 2.1 WChat 上下文 ≠ Bedrock 模型 1M（2026-07-22 实测，必读）

产品方在 WChat 内核对 `acc_bedrock` 三模型与会话用量后确认：

| 层 | 上限 | 说明 |
|---|---|---|
| **Bedrock 模型能力**（Sonnet 4.6 / Opus 4.6 / Opus 4.8） | 输入约 **1M** tokens；输出约 64k（Sonnet）/ **128k**（Opus）；1M 为标准配置、一般无需 context-1m beta | 官方对照以 Opus 4.8 最明确；4.6 同代推断 + Vero 内部「1M context」描述 |
| **WChat 平台喂给模型** | **`context_window_max = 200_000`（20 万）** | 实测 `GET /api/usage/current-session`（例 conversation 270201） |

要点：

1. **走 WChat / Vero Bot / `simple-agent`，按 200k 设计，不要按 1M。** 平台层截断/压缩，与选哪个 Claude 无关。  
2. `context_usage_percent` 可 **>100%**：统计的是会话**累计** input tokens / 200k，不是「当前窗口已塞满」；每一轮仍会被压回 200k 内，早期历史会被裁或摘要。  
3. 若将来 **直连 Bedrock**（不经 WChat），才可能用满 1M；**本迁移方案不直连 Bedrock**。  
4. 输出 300k 需 Batch API + beta 头；看板 Agent 解读/选工具用不到，忽略。

### 对本仓库实现的约束（Claude Code 须遵守）

| 做法 | 要求 |
|---|---|
| ② 工具目录 | **按域切片**（jb / yield / inf / meta），禁止一次塞全量冗长 JSON Schema |
| 历史 | 续用现有 `agentHistory` 压缩；送给 WChat 的 `prompt` 控制短历史（试点已用 `historyBlock` 近 8 轮 × 截断） |
| 工具结果 | 继续 `toolResultMaxChars` + 专用 serialize；**勿**把整份大 JSON 再贴进下一轮 WChat prompt（确定性表已 SSE 直出） |
| `detectLargeContext` | 现按 MiniMax/GLM 抬阈值；接 WChat 时应视为 **中等窗口（~200k）**，不要误当成 1M 而关掉压缩 |
| 监控（可选） | 若有 token：可调 `GET {VERO}/api/usage/current-session` 核对 `context_window_max`；若平台日后改上限，以该字段为准并更新本文 |

**待确认（非阻塞）：** 200k 是全局固定还是可按 bot/provider 配置——实现前可再查 WChat provider/bot 设置；**在未证实可调高之前，一律按 200k 预算。**

---

## 3. 分阶段落地（建议 Claude Code 按此顺序）

### Phase 0 — 已完成（勿重做）

- [x] 探针卡×机台 Path B 试点（`AGENT_PROBE_CARD_VERO_PILOT`）
- [x] `serializeProbeCardPerfForAgent`（合法 JSON，禁硬切）
- [x] 工具已跑后禁止 fallthrough 重查
- [x] 解读用 `simple-agent`，不用 `agent/chat`
- Commit 参考：`f29b5b4`（`mcp-branch`）

### Phase 1 — LLM 后端抽象（基础设施）

**目标：** 业务路由不直接 `import streamSiliconFlow` / `invokeVeroSimpleAgent`，统一走接口。

建议新建（名称可微调，保持职责清晰）：

| 模块 | 职责 |
|---|---|
| `pcr-ai-api/src/lib/agent/llm/agentLlmBackend.ts` | `completeText({ system, user, … })` / 可选 `streamText` |
| `siliconFlowLlmBackend.ts` | 现有 `streamSiliconFlow` 封装 |
| `wchatSimpleAgentLlmBackend.ts` | `invokeVeroSimpleAgent` 封装；鉴权 `WCHAT_ACCESS_TOKEN` |
| `resolveLlmBackend(config)` | flag：`AGENT_LLM_BACKEND=siliconflow\|wchat`（或 runtimeConfig） |

**Hard rules：**

- 出站仍 **禁止 undici**；WChat 继续 `node:https`
- Token **只**在服务器 `.env` / PM2 env，勿进前端、勿写进 handoff 正文

**验收：** 探针卡试点的 commentary/extract 改为经 `agentLlmBackend`，行为与现在一致；单测 mock backend。

### Phase 2 — ② 通用「工具目录 → JSON 选工具」

**目标：** 替代硅基 ReAct 第一轮的 `tool_choice: auto`。

1. 从 `TOOL_SCHEMAS` 生成 **紧凑目录**（name + 短 description + 关键参数），按域切片，避免一次塞满上下文：
   - `jb` / `yield` / `inf` / `meta`（`get_filter_values` / `ask_clarification` / `generate_chart`）
2. System prompt 模板（建议独立文件 `agent/prompt/wchatToolSelectPrompt.ts`）：
   - 只允许输出一个 JSON object
   - `tool` 必须是目录中的 name
   - 禁止编造 lot/device/数字
3. 解析：`parseJsonLoose`（已有）+ **白名单** `ALLOWED_TOOL_NAMES`
4. Args：复用 `agentToolValidator` / 现有 normalize
5. 执行：`runTool` → 写入 history（`appendSyntheticToolTurn`，兼容后续若再回硅基）
6. **总结轮：** 再调 WChat，system 明确「工具已完成，禁止再选工具、禁止输出 tool JSON」；有确定性路径则优先 `tryRunDeterministic*`

**开关建议：**

```bash
# 示例（实现时写入 .env.example，勿提交真实 token）
AGENT_LLM_BACKEND=wchat          # 或 siliconflow
AGENT_WCHAT_TOOL_SELECT=true     # ② 启用；false 时仍走硅基 tool_calls
WCHAT_ACCESS_TOKEN=
VERO_BASE_URL=https://verostudio.sw.nxp.com
```

**验收（Dummy）：**

- 未命中 ① 的问法（如「最近 WA03P02G 的 yield trigger」）→ JSON 选中 `query_yield_triggers` → 本地执行 → 有中文结论
- 非法 tool 名 → error/澄清，不 crash
- 总结轮再吐 `{"action":"tool"...}` → 丢弃并 nudge / 确定性路径兜底

### Phase 3 — ① 路由清单固化（扩展拦截面）

**目标：** 高价值问法不进 ②，避免选错工具。

已有入口参考 `agentLoop.ts` 的 `PRE_LLM_DIRECT_ROUTES`。Claude Code 应：

1. 列出当前所有 `tryRun*DirectRoute` / `isXxxQuestion`
2. 对「已有确定性表」的路由：解读 LLM 改为经 WChat backend（与探针卡试点一致）
3. **不要**为了迁 WChat 删掉正则拦截；只把 SiliconFlow commentary 换成 backend
4. 新增拦截须带：分类器单测 +（如有）eval golden

优先保持拦截的场景（示例，非完整）：

- 探针卡+机台组合 → `aggregate_probe_card_tester_performance`
- lot / device / 机台列表与概况 → `lot_listing` / JB deterministic
- 晶圆图 / DUT×BIN 图 → INF draw 路由
- 低良率 DUT 等已有 direct route

### Phase 4 — 默认切 WChat + 硅基 fallback

1. 生产默认 `AGENT_LLM_BACKEND=wchat`（需 token）
2. WChat 5xx / 超时 → 同轮或下一请求 fallback 硅基（打日志）
3. 前端 Settings：可选展示「LLM 后端」只读或 admin 开关（若动 UI，见 `pcr-ai-report/CLAUDE.md`）
4. 文档：更新 `pcr-ai-api/CLAUDE.md` §11/§12、本 handoff 状态表

### Phase 5 —（可选，非看板）WChat UI MCP

仅当产品要「在 verostudio WChat 网页直接问 PCR」时另开任务：

- 参考 `C:\Users\nxf83192\vero-agent-demo` Path A
- MCP 部署在 Vero 可达主机
- **禁止**与看板 `agentLoop` 共用同一编排，避免双路径抢查

---

## 4. 关键 / 将触及文件（实现时）

| 路径 | 动作 |
|---|---|
| `src/lib/vero/veroSimpleAgent.ts` | 已有 invoke；复用 |
| `src/lib/agent/llm/*`（新） | 后端抽象 |
| `src/lib/agent/core/agentLoop.ts` | ② 接入；总结轮改 backend |
| `src/lib/agent/core/agentStream.ts` | 硅基保留为 backend 之一 |
| `src/lib/agent/core/agentToolSchemas.ts` | 目录切片源 |
| `src/lib/agent/dispatch/directRoutes/*` | ① 解读改 backend |
| `src/lib/agent/dispatch/directRoutes/agentProbeCardVeroPilot.ts` | 样板；可收编进统一 backend |
| `agentConfig.ts` / `runtimeConfig.ts` / `.env.example` / `ecosystem.config.cjs` | flag 与 PM2 透传 |
| `test/veroProbeCardPilot.test.ts` 等 | 扩 WChat tool-select 单测 |

---

## 5. Hard rules（接手勿破）

1. **dummy-parity** — 改工具 WHERE/形状须 Oracle + Dummy 同步。  
2. **no-undici** — WChat/硅基出站禁止 `undici`。  
3. **oracledb@5.5** — 勿升 6.x。  
4. **工具已 emit `tool_start` 后** — 失败须 `done` 结束本轮，禁止 fallthrough 再查同一工具（见 `f29b5b4`）。  
5. **工具 JSON** — 大结果用专用 serialize（如 `serializeProbeCardPerfForAgent`），禁止 `truncateResult` 硬切导致 `JSON.parse` 失败。  
6. **勿把 `WCHAT_ACCESS_TOKEN` 写入仓库 / 前端 / handoff 正文。**  
7. **看板主链路禁用 MCP**；总结轮禁止再选工具。  
8. **WChat 有效上下文按 200k 设计**（§2.1），勿按 Bedrock 1M 塞目录/历史。

---

## 6. 验收清单（Claude Code 交付前）

- [ ] Dummy：① 探针卡组合仍一次工具 + 表 + 解读  
- [ ] Dummy：② 至少 3 个不同工具被正确 JSON 选中并执行  
- [ ] 总结轮不再触发第二次 `runTool`（单测断言）  
- [ ] `AGENT_LLM_BACKEND=siliconflow` 回归旧行为  
- [ ] `npm run typecheck` + 相关 `npx tsx --test …`  
- [ ] 更新本文件 §0 状态与 `pcr-ai-api/CLAUDE.md` 纪要  
- [ ] （可选）真库冒烟：1 条 ① + 1 条 ②

---

## 7. 明确非目标

- 不删除 SiliconFlow 代码路径（至少保留 fallback 一个版本周期）  
- 不把 `TOOL_SCHEMAS` 注册进 WChat MCP 作为看板默认  
- 不要求 WChat 请求体带 `model`（账号级模型在 WChat 侧选择）  
- 不在本任务做前端大改版

---

## 8. 给 Claude Code 的第一刀建议

1. 读本文件 + Vero 试点 handoff + `agentLoop.ts` 的 `PRE_LLM_DIRECT_ROUTES`。  
2. 实现 Phase 1（`agentLlmBackend`）并让探针卡试点走抽象层。  
3. 实现 Phase 2 最小闭环：仅开放 3～5 个工具的目录选工具 + 总结轮。  
4. 再扩目录与 Phase 3 解读迁移。  

遇产品分歧时以 **§0 / §2** 为准：优先可信数字与单次查库，不为「更像原生 WChat Agent」牺牲编排控制权。
