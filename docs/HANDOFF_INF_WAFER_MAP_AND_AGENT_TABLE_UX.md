# Claude Code 交接：INF 晶圆图分层 + Agent 表格/解读分栏

**日期：** 2026-06-03  
**分支：** `feat/inf-wafer-map`  
**读者：** Claude Code / Cursor Agent 接手 **INF wafer map**、**AI Agent 聊天气泡 Markdown** 时优先阅读。  
**前置阅读：** [`HANDOFF_AGENT_JB_DETERMINISTIC_SUMMARY.md`](HANDOFF_AGENT_JB_DETERMINISTIC_SUMMARY.md)、[`HANDOFF_AGENT_JB_CLUSTER_INTERRUPT_TESTER_UX.md`](HANDOFF_AGENT_JB_CLUSTER_INTERRUPT_TESTER_UX.md)、[`pcr-ai-api/CLAUDE.md`](../pcr-ai-api/CLAUDE.md) §6 / §11

---

## 1. 本批解决的用户问题

| 问题 | 根因 | 修复要点 |
| --- | --- | --- |
| 同理画 BIN14 wafermap 无链接 | 第二轮 `inf_draw_wafer_map` 漏传 `lot` | `normalizeInfDrawWaferMapArgs` 从历史补全 device/lot/slot/highlight |
| 中断层未出现在晶圆图 | 默认只画 `final` 一层 | 默认画出**每个** `SmWaferPass` 物理层 + 合成层 |
| 聚集警示表显示为 `\|...\|` 原文 | GFM 分隔行列数 ≠ 表头（5 列头 / 4 列分隔） | `formatClusteredBadBinAlertsMarkdown` 修正 + 前端 `repairGfmMarkdownTables` |
| 良率表下方「总结」像在表格里 | 流式输出表与解读无分段；偶发假表格行 | SSE 先推 `## 分析结论`；`splitAgentReplyMarkdown` 拆表尾正文 |

---

## 2. INF 晶圆图：`inf_draw_wafer_map`

### 2.1 默认标签页（`passes=final` 或 `all`，二者相同）

**不是固定三层。** 按 INF 文件顺序，每个 **`SmWaferPass` 块**一页，最后一页为 flow-level **合成**：

| 标签示例 | 含义 |
| --- | --- |
| `Pass N (正测)` | `PASS_TYPE=TEST`，单段 |
| `Pass N (正测·中断前)` / `(正测·续测后)` | 同 PASS_ID 多段 TEST |
| `Pass N (复测)` / `(复测·中断前)` … | `PASS_TYPE=RETESTBIN`，可多段 |
| `合成 (正测+复测)` | `dieKey=final`，`buildDieMapForFinalFlow` |

实现入口：

- `pcr-ai-api/src/lib/infWaferMap.ts` — `buildStandardWaferMapPassSpecs`、`describePassLayer`、`getDiesForWaferMapSpec`（`__block:N` = 第 N 个 SmWaferPass）
- `pcr-ai-api/src/lib/infTools/infToolsSingleWafer.ts` — `runDrawWaferMap`
- `pcr-ai-api/src/app.ts` — `GET /wafermaps/*.html` 静态目录

工具返回含 `Device:` / `Lot:` / `Slot:` 行，便于多轮对话补参。

### 2.2 多轮换 BIN 高亮

`pcr-ai-api/src/lib/agent/agentInfWaferMapTool.ts`：

- 从上一轮成功的 `inf_draw_wafer_map` 或 `query_jb_bins` 补全 **device + lot + slot**
- 用户话中的 `BIN14` → `highlight: "bin:14"`（或 schema 别名 `bin: 14`）
- 在 `agentToolHandlers.ts` 调用 `runInfTool` 前执行

`agentPrompt.ts` 已写：**禁止换 BIN 时省略 lot**。

### 2.3 相关测试

```bash
cd pcr-ai-api
npm test -- test/infWaferMapPassSpecs.test.ts
npm test -- test/agentInfWaferMapTool.test.ts
```

Fixture：`pcr-ai-api/docs/inf-dummy-r_1-1`（6 个 SmWaferPass + 1 合成 = 7 标签）。

---

## 3. Agent 聊天气泡：表 vs 解读

### 3.1 布局（报表）

`pcr-ai-report/src/reports/AiAgentReport.tsx`：

- `splitAgentReplyMarkdown(msg.text)` → **上方** `.ai-md-data`（可横向滚动表格）
- **下方** `.ai-md-commentary`（分隔线 + 纯文字解读/建议）

依赖 `remark-gfm`（已配置）+ `sanitizeAgentMarkdownForDisplay`（去 `~~`、修表分隔符）。

### 3.2 确定性 JB 总结流（API）

`agentLoop.ts` → `tryRunDeterministicJbSummary`：

1. SSE 直出 `## 实测数据` + 服务端表（`buildDeterministicJbTables` / `lotYieldOverviewMarkdown`）
2. **再 SSE** `\n\n## 分析结论\n\n`（本批新增，避免解读贴在表块内）
3. 流式 LLM 只写 `### 数据解读` / `### 专业建议`（禁止表格）

### 3.3 前端拆分与修复

| 文件 | 作用 |
| --- | --- |
| `splitAgentReplyMarkdown.ts` | 按 `## 分析结论` / `### 数据解读` 分段；`detachProseAfterMarkdownTables`；`detachSummaryLikeTableRows`（去掉 `\| 总结 \|` 假行） |
| `repairGfmMarkdownTables.ts` | 表头与 `\|---\|` 列数不一致时自动补齐 |
| `sanitizeAgentMarkdown.ts` | 展示前调用 repair |

服务端表生成在表末增加**空行**（`formatSlotYieldPivotMarkdown`、`formatSlotYieldFlatTable`、`formatClusteredBadBinAlertsMarkdown`）。

### 3.4 聚集警示表 GFM 修复

`agentJbBadBinCluster.ts` 分隔行必须为 **5 列**：

```text
| BIN | 测试层 | 类型 | waferId 范围 | 说明 |
|---:|---:|---:|---:|---|
```

---

## 4. 关键文件索引

| 领域 | 文件 |
| --- | --- |
| INF 图 pass 列表 | `infWaferMap.ts` — `buildWaferMapPassSpecs`, `buildStandardWaferMapPassSpecs` |
| 画图工具 | `infTools/infToolsSingleWafer.ts`, `infTools/index.ts` |
| 多轮补参 | `agent/agentInfWaferMapTool.ts`, `agent/agentToolHandlers.ts` |
| 总结流分段 | `agent/agentLoop.ts` |
| 表 markdown | `agent/agentJbHistoryCompact.ts`, `agent/agentJbBadBinCluster.ts` |
| 气泡 UI | `reports/AiAgentReport.tsx`, `reports/AiAgentReport.css` |
| 拆分/修表 | `utils/splitAgentReplyMarkdown.ts`, `utils/repairGfmMarkdownTables.ts` |

---

## 5. 部署与验证

### 5.1 构建

```bash
cd pcr-ai-api && npm ci && npm run build && npm test
cd ../pcr-ai-report && npm ci && npm run build
# 生产 API：pm2 reload（见 pcr-ai-api/docs/DEPLOY_PM2.md）
```

### 5.2 手动验证清单

- [ ] AI 页问 lot 概况：聚集警示、良率 pivot 为** HTML 表格**，非 `\|` 原文
- [ ] 表下方「数据解读」在**分隔线以下**，不是表格最后一行
- [ ] `inf_draw_wafer_map`：标签页含各正测/复测段 + **合成**；换 BIN 说「同理画 bin14」仍有 `/wafermaps/` 链接
- [ ] 设置里 API 地址正确时，wafermap 链接新标签可打开

### 5.3 Agent 测试话术

见 `docs/pcr-ai-agent-test-prompts.md` §10（INF 23 工具）、§10f-2（DUT×BIN 图）。

---

## 6. 勿破坏的约定

1. **dummy-parity**：本批未改 Oracle WHERE；INF 工具仅用 dummy fixture `docs/inf-dummy-r_1-1`。
2. **总结轮**：`query_jb_bins` 仍走 `tryRunDeterministicJbSummary`；勿在服务端表里加「结论列」。
3. **GFM 表**：任何新增 markdown 表，分隔符列数必须与表头一致；表后加空行。
4. **`no-undici`** / **`oracledb@5.5`**：不变。

---

## 7. 后续可做（未实现）

- 合成层标签置顶（当前在**最后**一页，与 INF 文件顺序一致）
- 将 `splitAgentReplyMarkdown.test.ts` 纳入 CI（报表 `tsconfig.app.json` 已 exclude `*.test.ts`）

---

*文档版本：2026-06-03。冲突时以源码为准并更新本文。*
