# Cursor 交接（2026-07-21 · 给 Claude Code）— Vero Path B 探针卡×机台试点

> **执行者：** Cursor Agent  
> **读者：** Claude Code / 接手 Agent 或部署本试点的同事  
> **前置阅读：** [`HANDOFF_AGENT_PROBE_CARD_TESTER_PERFORMANCE.md`](HANDOFF_AGENT_PROBE_CARD_TESTER_PERFORMANCE.md)；参考实现 `C:\Users\nxf83192\vero-agent-demo`（Path B：`agent-b.js`）  
> **分支：** `mcp-branch`（合入时以实际推送分支为准）  
> **范围：** **仅** PRE_LLM「device × 探针卡 × 机台组合」这一条；其它 Agent 路由仍 SiliconFlow

---

## 0. 一眼结论

| 项 | 状态 | 说明 |
|---|---|---|
| **目标** | ✅ 已合入 | 抽参：`simple-agent/invoke`；解读：WChat **SSE 流式**（`agent/chat` + `conversations/{id}/stream`，对齐 [wchat/c/268418](https://verostudio.sw.nxp.com/wchat/c/268418)） |
| **数字权威** | ✅ 不变 | 仍 `aggregate_probe_card_tester_performance` + 服务端四表；模型不得改表 |
| **开关** | ✅ 默认关 | `AGENT_PROBE_CARD_VERO_PILOT=true` **且** `WCHAT_ACCESS_TOKEN` 有值才走 Vero |
| **降级** | ✅ | extract/工具失败 → 原 regex + SiliconFlow 解读 |
| **真连冒烟** | ✅ Dummy+真 Vero | `scripts/smoke-vero-probe-card-pilot.mjs`：ping / 抽参 / 四表+解读 |
| **Path A MCP 工具** | ❌ 未做 MCP 服务 | 解读走 `agent/chat` SSE；提示词禁止调工具（若用户已注册 MCP，偶发误调需观察） |
| **前端** | 无需改 | 仍 `AiAgentReport` → `/api/v4/agent/chat` SSE |
| **部署** | ⏭ 待 API 机 | 改服务器 `.env` + `build` + `pm2 reload`（见 §5） |

---

## 1. 架构（抽参 Path B + 解读 WChat SSE）

```text
AiAgentReport
  → agentLoop PRE_LLM
  → isProbeCardTesterPerformanceQuestion
  → flag+token?
       yes → extract JSON (POST /api/simple-agent/invoke，非流式)
            → runTool(aggregate_probe_card_tester_performance)  # Oracle/Dummy
            → SSE 确定性四表（一次写出）
            → commentary：POST /api/agent/chat → GET …/stream（token 事件真流式）
       no / 失败 → 原 regex 抽参 + SiliconFlow 流式解读
```

与 demo / 文档对应：

| 来源 | 本仓库 |
|---|---|
| `vero-agent-demo/agent-b.js` `simpleAgent` | `invokeVeroSimpleAgent`（抽参） |
| `vero-agent-demo/agent.js` chat+SSE | `streamVeroAgentChat`（解读） |
| wchat/c/268418 流式要点 | 模型 stream + 传输 SSE；工具阶段用 status |

---

## 2. 关键文件

| 路径 | 作用 |
|---|---|
| `pcr-ai-api/src/lib/vero/veroSimpleAgent.ts` | `invokeVeroSimpleAgent` + **`streamVeroAgentChat`（SSE）** |
| `pcr-ai-api/src/lib/agent/dispatch/directRoutes/agentProbeCardVeroPilot.ts` | extract → tool → tables → **streamCommentary** |
| `pcr-ai-api/src/lib/agent/dispatch/directRoutes/agentProbeCardDirectRoutes.ts` | flag 分支 + 降级 |
| `pcr-ai-api/src/lib/agent/render/agentProbeCardPerfReply.ts` | `streamCommentary` / `invokeCommentary` 可插拔 |
| `pcr-ai-api/ecosystem.config.cjs` | PM2 透传 `AGENT_PROBE_CARD_VERO_*` / `WCHAT_*` / `VERO_*` |
| `pcr-ai-api/.env.example` | 变量说明（无真实 token） |
| `pcr-ai-api/test/veroProbeCardPilot.test.ts` | mock 单测 |
| `pcr-ai-api/scripts/smoke-vero-probe-card-pilot.mjs` | 真连冒烟（读本地 `.env`） |

---

## 3. 环境变量

写在 **API 服务器** `pcr-ai-api/.env`（**勿提交**；勿进浏览器）：

```bash
AGENT_PROBE_CARD_VERO_PILOT=true
WCHAT_ACCESS_TOKEN=<JWT，不要带 Bearer 前缀>
VERO_BASE_URL=https://verostudio.sw.nxp.com
# 企业 MITM：默认 Vero TLS 可跳过校验；强制校验：
# VERO_TLS_STRICT=true
```

- 进程须能访问 `verostudio.sw.nxp.com`（NXP 内网/VPN）。
- Token 与 `vero-agent-demo` / WChat 同源即可。
- **关闭试点：** `AGENT_PROBE_CARD_VERO_PILOT=false` 或清空 token → `pm2 reload` → 回 SiliconFlow。

---

## 4. 验证（已做 / 可重跑）

单元（mock，无需 token）：

```bash
cd pcr-ai-api
npx tsx --test test/veroProbeCardPilot.test.ts
```

真连冒烟（需 `.env` 有 token + Dummy 可开）：

```bash
cd pcr-ai-api
npx tsx scripts/smoke-vero-probe-card-pilot.mjs
```

期望：`ping → PONG`；extract 含 `device=WA03P02G`；`handled: true`；正文含「实测数据」+「数据解读」。  
脚本里的 `...[truncated]...` **仅控制台预览截断**，不是 API 截断。

AI 页手工：问「WA03P02G 最好的探针卡和机台组合是哪个」→ status 出现「Vero 试点…」。

---

## 5. 部署（API only）

前端 **不必** `pack:dist`。

```bash
cd pcr-ai-api
# 1) 同步本提交代码
# 2) 编辑 .env（§3），勿提交 token
npm ci          # 依赖有变时
npm run build
pm2 reload ecosystem.config.cjs
# 或：npm run pm2:reload
```

生产请保持 `*_DUMMY=false`（走 Oracle）。确认机房出站能到 Vero。

回退：关 flag → `pm2 reload`。

---

## 6. Hard rules（接手勿破）

1. **dummy-parity**：改聚合 WHERE/形状须 Oracle + Dummy 同步（本试点未改 SQL）。
2. **no-undici**：Vero 出站只用 Node `https` / 内置能力。
3. **oracledb@5.5**：勿升 6.x。
4. **勿把 WCHAT_ACCESS_TOKEN 写进仓库 / 前端 / handoff 正文。**
5. 勿擅自上 Path A MCP，除非明确要解决「Vero 服务器可达 MCP URL」。

---

## 7. 建议后续（非阻塞）

| 项 | 说明 |
|---|---|
| 真库复验 | 生产 Oracle + 真实 device 问组合排名 |
| Token 轮换 | 若 token 曾出现在聊天记录，建议 WChat/SSO 侧轮换 |
| 其它 Agent 能力迁 Vero | 按同 Path B 模板逐条加 flag，勿一次切全量 |

---

## 8. 根 CLAUDE.md 索引

已在仓库根 [`CLAUDE.md`](../CLAUDE.md) 增加一行指向本文档。
