# AI Agent 交接：JB 逐片 BIN 查询 + 工具结果体积上限

**日期：** 2026-05-27  
**背景：** 用户问「某 lot 1–25 片 BIN7 颗数 / BIN7 趋势」时，Agent 多次调 `query_jb_bins` 后声称「API 截断、无法给全量」，只列出 slot 23–25 三条。

---

## 1. 根因（不是 Oracle API）

| 层 | 行为 |
| --- | --- |
| Oracle / v3 列表 | 正常返回最多 `limit` 行（Agent 默认 50，最大 200） |
| **`agentToolHandlers` / `agentJbBinFormat`** | 将工具结果 `JSON.stringify` 后，若超过 **`toolResultMaxChars`**（原硬编码 **6000**），旧逻辑会 **硬切字符串** + `…(truncated)`，模型只看到 JSON 前缀 |
| **模型误判** | 把 Agent 层截断当成「后端 API 截断」，反复重试或让用户选分批方案 |

6000 字符 ≈ 1500–2500 input tokens，与 MiniMax-M2.5 **192K** 上下文无关，是 Agent 侧人为预算。

---

## 2. 修复概要

### 2.1 `query_jb_bins` 紧凑摘要（优先读这个）

**文件：** `pcr-ai-api/src/lib/agent/agentJbBinFormat.ts`

工具回传在 `wrapJbQueryResultForAgent` 中增加：

| 字段 | 用途 |
| --- | --- |
| **`slotBadBinsCompact`** | `[{ slot, badBins: [{ bin, dieCount }] }]`，按 slot 升序；同 slot 跨 INTERRUPT/续测行 **dieCount 相加** |
| **`binBySlot`** | 体积仍超限时由 `serializeJbQueryResultForAgent` 降级：`{ "23": { "7": 124 } }` |
| **`distinctSlots`** | 去重 slot 列表（枚举 wafer 片数） |
| **`slotYieldSummary`** | 整片/中断良率（原有） |
| **`rowsOmitted`** | 为控体积省略明细 `rows` 时为 `true`，**不影响**上述摘要完整性 |

**序列化策略（`serializeJbQueryResultForAgent(wrapped, maxChars)`）：**

1. 完整 payload（含 `rows`）≤ `maxChars` → 原样返回  
2. 否则去掉 `rows`，保留 `slotBadBinsCompact` 等  
3. 仍超限 → 仅保留 `binBySlot` + 精简 `slotYieldSummary`  
4. **不再**输出半截无效 JSON（去掉 `…(truncated)` 硬切）

### 2.2 系统提示词

**文件：** `pcr-ai-api/src/lib/agent/agentPrompt.ts`

新增 **「按 slot 分析某一 BIN」** 专节：

- 一次 `query_jb_bins(lot, passId, limit: 200)` 即可  
- 从 **`slotBadBinsCompact` / `binBySlot`** 读每片 BIN 颗数  
- **禁止**向用户声称「API 截断」  
- 必须按 **`distinctSlots` 全量** 升序列出，不能只列 `rows` 前几行  

**文件：** `pcr-ai-api/src/lib/agent/agentToolSchemas.ts` — `query_jb_bins` 描述同步。

### 2.3 可配置工具结果字符上限

| 位置 | 说明 |
| --- | --- |
| **Settings → AI Agent** | **`toolResultMaxChars`**，默认 **12000**，范围 **6000–30000** |
| **`usePersistedAgentConfig.ts`** | `localStorage` 键 `pcr-ai-report.agent.v1` |
| **`agentConfig.ts`** | `resolveAgentConfig`；env 回退 **`AGENT_TOOL_RESULT_MAX_CHARS`** |
| **`agentLoop.ts`** | `runTool(name, args, { toolResultMaxChars })` |
| **`agentToolHandlers.ts`** | 所有 `truncateResult(obj, maxChars)` |

**无需重启 API**：Settings 值随每次 `POST /api/v4/agent/chat` 的 `agentConfig` 下发。  
**仅改服务器 `.env` 或部署新代码** 时需要 `npm run build` + `pm2 reload`。

---

## 3. 源码索引

| 文件 | 职责 |
| --- | --- |
| `pcr-ai-api/src/lib/agent/agentJbBinFormat.ts` | `buildSlotBadBinsCompact`、`serializeJbQueryResultForAgent` |
| `pcr-ai-api/src/lib/agent/agentToolHandlers.ts` | `runTool` + `RunToolOptions.toolResultMaxChars` |
| `pcr-ai-api/src/lib/agent/agentConfig.ts` | `DEFAULT_TOOL_RESULT_MAX_CHARS=12000`、`clampToolResultMaxChars` |
| `pcr-ai-api/src/lib/agent/agentPrompt.ts` | 逐片 BIN 规则 |
| `pcr-ai-report/src/hooks/usePersistedAgentConfig.ts` | 前端默认值与 clamp |
| `pcr-ai-report/src/App.tsx` | Settings 数字输入 |

**测试：**

- `pcr-ai-api/test/agentJbBinFormat.test.ts` — compact、省略 rows、跨行累加  
- `pcr-ai-api/test/agentConfig.test.ts` — `toolResultMaxChars` clamp 与 env  

---

## 4. 验证用例

部署后在新会话问：

> WA03P02G NF12316.1X 这个 lot，sort1，请列出 1–25 片每片的 BIN7 颗数。

**期望：**

- 一次（或少量）`query_jb_bins`，不再报「API 截断」  
- 表格 slot 1–25 齐全，BIN 编号与颗数未对调（见 prompt「坏 Bin 编号与数量」）  
- 工具 JSON 中可见 `slotBadBinsCompact` 或 `binBySlot`；大 lot 时可能有 `rowsOmitted: true`

---

## 5. 改口径时同步

1. `agentJbBinFormat.ts`（字段形状 / 压缩策略）  
2. `agentPrompt.ts` + `agentToolSchemas.ts`  
3. `agentConfig.ts` + `usePersistedAgentConfig.ts`（若改默认或范围）  
4. 本文件 + `pcr-ai-api/CLAUDE.md` §11 条目 15  

---

## 6. 部署

```bash
cd pcr-ai-api && npm ci && npm run build && npm run pm2:reload
cd pcr-ai-report && npm ci && npm run build   # 或 pack:dist 部署静态资源
```
