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
| **`recentLotsByTestEnd`** | 每 lot MAX(TESTEND) 降序 top5；含 **`cardIds`** / **`hasCardChangeInLot`**（`cardId` 仅为最近一行，见换卡交接） |
| **`bin10Vs66ByLot`** | 每 lot 汇总 BIN10 / BIN66 / diff / bin10GtBin66（by lot 两 bin 对比；换卡 lot 仍为跨卡合计） |
| **`slotBadBinsCompact`** | `[{ slot, passId, cardId, badBins }]`，按 **(slot, passId, cardId)** 分组（换卡见 [`HANDOFF_AGENT_JB_PROBE_CARD_CHANGE.md`](HANDOFF_AGENT_JB_PROBE_CARD_CHANGE.md)） |
| **`cardByPassId`** | 各 passId 的 CARDID 集合（pass1 与 pass3 不同卡为正常） |
| **`cardChangesBySlotPass`** | 仅 **同 (slot, passId)** 多 CARDID → `hasCardChange: true` |
| **`binBySlot`** | 降级键：`"23:1:8041-08"` = slot:passId:cardId |
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
| `pcr-ai-api/src/lib/agent/agentJbBinFormat.ts` | `buildSlotBadBinsCompact`、`buildBin10Vs66ByLot`、`serializeJbQueryResultForAgent` |
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

## 5. 相关交接（2026-05-30）

Lot 概况 / BIN 趋势 / 总结轮 **服务端直出表** + **Wafer Test / Probe Card / DUT 专业建议**：[`HANDOFF_AGENT_JB_DETERMINISTIC_SUMMARY.md`](HANDOFF_AGENT_JB_DETERMINISTIC_SUMMARY.md)（`badBinSlotTrends`、`tryRunDeterministicJbSummary`、`toolResultMaxHistoryChars`）。

---

## 6. 改口径时同步

1. `agentJbBinFormat.ts`（字段形状 / 压缩策略）  
2. `agentPrompt.ts` + `agentToolSchemas.ts`  
3. `agentConfig.ts` + `usePersistedAgentConfig.ts`（若改默认或范围）  
4. 本文件 + `pcr-ai-api/CLAUDE.md` §11 条目 15 / 17 / 20  

---

## 7. 部署

```bash
cd pcr-ai-api && npm ci && npm run build && npm run pm2:reload
cd pcr-ai-report && npm ci && npm run build   # 或 pack:dist 部署静态资源
```

---

## 8. MiniMax-M2.5 嵌入式工具调用（2026-05-27 补充）

**现象：** 回答区只出现 `cardId: "7747-01", limit: 1000 } </invoke></minimax:tool_call>`，数秒内 `done`，无中文结论。

**原因：**

1. MiniMax 在 `<invoke>` 内用 **JSON / 松散 key:value** 传参，旧解析只认 `<parameter>`，工具未正确执行。
2. 流式片段缺少开头 `<minimax:tool_call>` 时，参数尾巴被当作正文推到 UI。
3. **Retry** 总结轮（history 末条为 `tool`）若再解析出嵌入式工具，会误触发工具而非中文总结。

**修复（`agentLoop.ts`）：** `parseMinimaxInvokeBody`、`stripOrphanToolMarkupTail`、总结轮忽略 `embeddedCalls`。  
**Prompt：**「某张探针卡最近五个 lot」→ `query_jb_bins(cardId, limit:200)` 按 TESTEND 去重取前 5 个 LOT。

**回归：** `test/agentLoop.test.ts`。

---

## 9. 「某卡最近 N 个 lot」勿用 aggregate（2026-05-27 补充）

**现象：** 问「7747-01 最近五个 lot」时调 `aggregate_jb_bins`，按 BIN66 坏 die 排序，并声称 API 不能按 TESTEND 排序。

**原因：** `aggregate_jb_bins` 按 **坏 die 合计** 取 top，与 **最近测试时间** 无关；`groupBy lot,bin` 时表格「主要坏 BIN」是 **该 lot 下单个 bin 的峰值**，不是全 lot 或全卡 BIN10 vs BIN66 总量对比。

**修复：** `query_jb_bins` 回传 **`recentLotsByTestEnd`**（每 lot 取 MAX(TESTEND) 降序 top5）。Prompt / 工具 schema 禁止用 aggregate 答「最近 lot」。

**回归：** `test/agentJbBinFormat.test.ts`（`buildRecentLotsByTestEnd`）。

---

## 10. 「by lot BIN10 vs BIN66」勿用 aggregate top 表（2026-05-27 补充）

**现象：** 问「7747-01 by lot 是不是 BIN10 多于 BIN66」时，Agent 调 `aggregate_jb_bins(groupBy: lot,bin)`，表格里 TR17367.1T 排前列且为 BIN10，用户误以为 **全卡 / 多数 lot** 都是 BIN10 更多；实际上 aggregate 每行是 **(lot, 单个 bin)** 按坏 die 降序的 top 组，**不能**横向对比同一 lot 的 BIN10 与 BIN66 总量。

**Oracle 实测（7747-01，近一年，全量 3368 行 / 149 lot，人工分页验证）：**

| 维度 | 结果 |
| --- | --- |
| 全卡汇总 | BIN10 ≈ **62k**，BIN66 ≈ **195k** → **BIN66 约为 BIN10 的 3 倍** |
| 按 lot 胜负 | BIN66 更多的 lot：**139**；BIN10 更多的 lot：**仅 10** |
| 最近 5 lot | 4/5 为 BIN66 多；仅 TR21346.1K BIN10 略多（265 vs 242） |
| BIN10 明显领先的 lot（举例） | TR17367.1T（3686 vs 1608）、TR13070.1X（2485 vs 1710） |
| BIN66 明显领先的 lot（举例） | TR13069.1F（45 vs 5121）、TR13073.1Y（37 vs 5118） |

**修复：** `query_jb_bins` 回传 **`bin10Vs66ByLot`**（由 `buildBinTotalsByLot` → `buildBin10Vs66ByLot` 预计算）：

| 字段 | 含义 |
| --- | --- |
| `lot` / `device` | lot 与 device |
| `bin10` / `bin66` | 该 lot 跨全部匹配行（slot、INTERRUPT 续测行）汇总的坏 die |
| `diff` | bin10 − bin66 |
| `bin10GtBin66` | 布尔，是否 BIN10 更多 |

**Prompt（`agentPrompt.ts`）** 新增专节「按 lot 对比两个 BIN」：须读 `bin10Vs66ByLot`，逐 lot 列表 + 汇总胜负 lot 数；**禁止**用 aggregate top 表代替。

**工具 schema（`agentToolSchemas.ts`）**：`query_jb_bins` 描述含 `bin10Vs66ByLot`；`aggregate_jb_bins` 禁止用于 BIN10 vs BIN66 对比。

**回归：** `test/agentJbBinFormat.test.ts`（`buildBin10Vs66ByLot`、wrap 含字段）。

### 9.1 Agent 单次查询覆盖范围（重要）

`query_jb_bins` 工具 **`limit` 最大 200**（按 TESTEND DESC 取行）。7747-01 近一年有 **3368 行 / 149 lot**，单次 200 行约覆盖 **~22 个最近 lot** 的明细。

- **`bin10Vs66ByLot` 仅对本次返回行所属 lot 汇总**，不等于全卡 149 lot 全量对比。
- Agent 回答时须说明：**「基于本次查询返回的 N 行 / M 个 lot」**；若用户要全卡历史，需说明工具上限或建议报表 v4 聚合（`groupBy=bin` 可看全卡 BIN 排名）。
- 全卡级 BIN10 vs BIN66 可直接调 **`GET …/v4/aggregate?cardId=…&groupBy=bin&groupTop=20`**（不受 list limit 影响）。

### 9.2 验证用例

部署后 **New Chat** 问：

> 7747-01 by lot，BIN10 是否多于 BIN66？请逐 lot 列表并汇总。

**期望：**

- 调 **`query_jb_bins(cardId: "7747-01", limit: 200)`**，读 **`bin10Vs66ByLot`**
- **不**调 `aggregate_jb_bins` 作为主依据
- 结论含逐 lot 表格 + 「X 个 lot BIN10 多 / Y 个 lot BIN66 多」
- 注明数据范围（200 行内 lot 子集，非全卡 149 lot  unless 用户指定单个 lot）
