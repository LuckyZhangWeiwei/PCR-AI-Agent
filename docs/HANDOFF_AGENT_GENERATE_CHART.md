# AI Agent 交接：`generate_chart` 空参数与 DUT 占比图

**日期：** 2026-05-28  
**分支：** `feat/report-ux-dut-bin-agg`（提交时以实际分支为准）  
**背景：** 用户先查 INF DUT 分布，再要求「生成 dut2 占比的比例图」；`generate_chart` 执行失败，错误为：

```text
生成图表失败: 缺少有效的 labels/values 或 data 结构。…收到参数键: (空)
```

（同一轮可能连续失败两次。）

---

## 1. 根因

| 层 | 行为 |
| --- | --- |
| **模型 / SiliconFlow** | 常只发结构化 `tool_calls`，`function.arguments` 为 `{}`、截断 JSON 或根本不传 `data` |
| **GLM 5.x** | 有时把完整参数写在 **content** 的 `<tool_call>…<arg_key>…<arg_value>…</tool_call>` 里，与空 `tool_calls` 并存 |
| **旧 Agent** | 仅当 `tool_calls` 全空时才用嵌入式解析；或解析后仍得不到 `labels`/`values` → `runTool` 收到 `{}` |
| **业务** | DUT 占比数据在上一条 **`query_inf_site_bin_by_dut`** 的 tool 结果里，模型未把数字填进 `generate_chart` |

**不是** ECharts、前端 SSE `chart` 事件或 Oracle 问题。

---

## 2. 修复概要（三层）

### 2.1 GLM 嵌入式 tool call 解析

**文件：** `pcr-ai-api/src/lib/agent/agentLoop.ts`

| 符号 | 说明 |
| --- | --- |
| `parseGlmToolCallBody` | 解析 `<tool_call>name<arg_key>…</arg_key><arg_value>…</arg_value></tool_call>`；`arg_value` 为 JSON 时 `JSON.parse` |
| `tryExtractFromGlmBuf` / `tokenKind === "glm"` | 流式缓冲至 `</tool_call>` 后入 `embeddedCalls` |
| `mergeStructuredWithEmbedded` | 结构化 `tool_calls` 参数不可用（空对象、非法 JSON、`generate_chart` 无有效 data）时，**按工具名/下标** 用嵌入式参数覆盖 |
| `toolCallArgsUsable` | `generate_chart` 走 `generateChartArgsHaveData`（见 `agentChartTool.ts`） |

`filterAgentStreamTextForUi` 会剥掉上述标记，避免泄漏到聊天气泡。

### 2.2 `generate_chart` 参数规范化

**文件：** `pcr-ai-api/src/lib/agent/agentChartTool.ts`

| 函数 | 说明 |
| --- | --- |
| `normalizeGenerateChartArgs` | 支持顶层 **`labels` + `values`**、**`data` JSON 字符串**、嵌套 `data.series` |
| `resolveGenerateChartData` | 得到 `ChartData { labels, series }` |
| `generateChartArgsHaveData` | 判断参数是否已够画图 |

**文件：** `pcr-ai-api/src/lib/agent/agentToolSchemas.ts`

- `required` 改为 **`chartType`、`title`**（不再强制 `data`）
- 增加顶层 `labels`、`values`、`seriesName` 属性说明

### 2.3 从会话历史推断 DUT 占比（空参数兜底）

**文件：** `pcr-ai-api/src/lib/agent/agentChartTool.ts`

| 函数 | 说明 |
| --- | --- |
| `inferGenerateChartArgsFromHistory` | 参数无效时，找最近一条 **`query_inf_site_bin_by_dut`** tool JSON |
| `extractDutNumberFromText` | 从用户问题 / `title` 解析 `dut2`、`DUT2` |
| `extractBinHintFromText` | 可选 `BIN7` → 只统计该 bin |
| `buildDutShareChartData` | **DUTn** vs **其他DUT** 的 dieCount 汇总 → pie 用 `labels`/`values` |

**文件：** `pcr-ai-api/src/lib/agent/agentToolHandlers.ts`

- `RunToolOptions.history`：`runAgentLoop` 执行工具时传入 `getHistory(sessionId)`
- `generate_chart`：先 `inferGenerateChartArgsFromHistory`，再 `normalize` / `resolve`

**前提：** 同会话内已成功执行 **`query_inf_site_bin_by_dut`**；用户问题或 `title` 含 DUT 编号（缺省按 **DUT2** 仅当能从文案解析时；文案含 `dut2` 会解析为 2）。

### 2.4 图表轮收尾（GLM 空总结）

**文件：** `agentLoop.ts`

- 工具轮仅 `generate_chart` 且上一条 tool 已是图表结果时，跳过无意义的「分析结论」轮，SSE 输出简短确认（`chartToolFallbackMessage`）。

---

## 3. 推荐调用顺序（DUT 占比 pie）

1. `query_jb_bins` → 拿 device、lot、slot、cardId、passId  
2. `query_inf_site_bin_by_dut` → 拿 `passes[].bins[].duts[]`  
3. 用户确认要图后 `generate_chart`：

```json
{
  "chartType": "pie",
  "title": "BIN7 DUT2 占比",
  "labels": ["DUT2", "其他DUT"],
  "values": [395, 45]
}
```

若模型仍传 `{}`，服务端会尝试从步骤 2 的 tool 结果自动构图（需 title/用户句含 **dut2** 等）。

**GLM 嵌入式示例（content 流，会被解析，不显示在 UI）：**

```xml
<tool_call>generate_chart<arg_key>chartType</arg_key><arg_value>pie</arg_value>
<arg_key>labels</arg_key><arg_value>["DUT2 (395颗)", "其他DUT (45颗)"]</arg_value>
<arg_key>values</arg_key><arg_value>[395, 45]</arg_value>
<arg_key>title</arg_key><arg_value>Slot 7 BIN7 DUT分布</arg_value></tool_call>
```

---

## 4. 源码索引

| 文件 | 职责 |
| --- | --- |
| `pcr-ai-api/src/lib/agent/agentChartTool.ts` | 规范化、推断、`buildChartOption` |
| `pcr-ai-api/src/lib/agent/agentLoop.ts` | GLM 过滤、`mergeStructuredWithEmbedded`、`runTool(..., { history })` |
| `pcr-ai-api/src/lib/agent/agentToolHandlers.ts` | `generate_chart` case |
| `pcr-ai-api/src/lib/agent/agentToolSchemas.ts` | OpenAI function schema |
| `pcr-ai-api/src/lib/agent/agentPrompt.ts` | INF DUT 专节；用户确认后才 `generate_chart` |

**测试：**

- `pcr-ai-api/test/agentLoop.test.ts` — `parseGlmToolCallBody`、`normalizeGenerateChartArgs`、`inferGenerateChartArgsFromHistory`、`runTool` 空参推断  
- `pcr-ai-api/test/agentTools.chart.test.ts` — 标准 `data.labels` + `data.series`  

```bash
cd pcr-ai-api && npm test
```

---

## 5. 验证用例

部署 / `npm run dev` 后**新会话**：

1. 按 prompt 完成 JB + `query_inf_site_bin_by_dut`（例如某 slot、BIN7）。  
2. 用户：「生成 dut2 占比的比例图」或「要图」。  
3. **期望：** SSE `chart` 事件、气泡内饼图；tool 区不再出现「收到参数键: (空)」。  
4. 若从未查 INF，应仍报错并提示需先 `query_inf_site_bin_by_dut` 或显式传 `labels`/`values`。

---

## 6. 改口径时同步

1. `agentChartTool.ts`（字段形状 / 推断规则）  
2. `agentLoop.ts`（GLM / DeepSeek / MiniMax 标记正则）  
3. `agentToolHandlers.ts` + `agentToolSchemas.ts`  
4. `agentPrompt.ts`（图表与 INF 顺序）  
5. 本文件 + `pcr-ai-api/CLAUDE.md` §11 条目 18 + 根 `CLAUDE.md` 交接链接  

---

## 7. 部署

```bash
cd pcr-ai-api && npm ci && npm run build && npm run pm2:reload
```

本地开发：`npm run dev`（tsx watch）保存即生效。  
**仅改前端 Settings 不改本逻辑**；本修复在后端，须 API 进程加载新代码。

---

## 8. 已知限制

- 历史推断仅针对 **`query_inf_site_bin_by_dut`**；Yield/JB 聚合占比需模型显式传 `labels`/`values` 或后续扩展推断器。  
- `BIN` 过滤依赖用户文案或 `title` 中的 `BINn`；未写 BIN 时对该 pass **所有 bin** 的 DUT 颗数汇总。  
- 结构化 `tool_calls` 与嵌入式 **同时带冲突参数** 时，以「结构化可用则保留、否则合并嵌入式」为准；若两者皆空仍失败。
