# Claude Code 交接：JB Agent 突增/聚集坏 bin、中断次数、机台、数据/结论分栏

**日期：** 2026-06-01  
**分支：** `report-refactor`  
**读者：** Claude Code 接手 JB Agent 准确度与 AI 聊天气泡 UX 时优先阅读。  
**前置：** [`HANDOFF_AGENT_JB_DETERMINISTIC_SUMMARY.md`](HANDOFF_AGENT_JB_DETERMINISTIC_SUMMARY.md)、[`HANDOFF_JB_INTERRUPT_YIELD.md`](HANDOFF_JB_INTERRUPT_YIELD.md)、[`HANDOFF_AGENT_JB_BIN_AND_TOOL_RESULT.md`](HANDOFF_AGENT_JB_BIN_AND_TOOL_RESULT.md)

---

## 1. 用户诉求（生产症状）

| 症状 | 修复要点 |
| --- | --- |
| 问「中断几次」答成 2（误把良率表前半/后半两段当次数） | `testInterruptCount` 服务端计数 + `testInterruptCountMarkdown` |
| 问「哪台机台测」答不出 | `testerByLot` / `testerId` + prompt：JB `TESTERID` ↔ YM `HOSTNAME` |
| 数据表与结论混在一张宽表里 | 服务端 `## 实测数据` / `## 分析结论`；前端 `splitAgentReplyMarkdown.ts` |
| **聚集性/突增坏 bin 未点明** | `agentJbBadBinCluster.ts` 自动检出 + **有则解读首段必写** |

---

## 2. 聚集性 / 突增坏 bin（最高警惕）

**文件：** `pcr-ai-api/src/lib/agent/agentJbBadBinCluster.ts`

| `kind` | 含义 |
| --- | --- |
| `sudden_increase` | 相邻 waferId 间该 BIN 坏 die 突增（阈值见源码 `detectSuddenIncrease`） |
| `cluster` | 连续 ≥3 片同 BIN 持续偏高 |
| `rising_trend` | 多片按 slot 递升 |

**触发：** `wrapJbQueryResultForAgent` 在 `lotQueryFullRows` 或单 lot（`distinctLotCount === 1` / `primaryLot`）时调用 `buildClusteredBadBinAlerts(rows, topBadBins)`。

**输出字段：**

- `clusteredBadBinAlerts` — JSON 数组（`detail` 含 waferId 范围文案）
- `clusteredBadBinAlertsMarkdown` — 文首 ⚠ 表，并 prepend 进 `lotYieldOverviewMarkdown`（`agentJbHistoryCompact.formatLotYieldOverviewMarkdown`）

**Agent 必须点明：** `agentPrompt.ts`「聚集性 / 突增坏 bin」节；`agentLoop.ts` `SUMMARIZE_NUDGE`；`agentJbDeterministicReply.ts` `BRIEF_COMMENTARY_SYSTEM` + `buildEngineeringContextFromPayload`。

**序列化：** `jbYieldCoreFieldsForSerialize` — 省略长 markdown、`agentTablesDigest`、警示里大 `slots[]`；`topBadBins` 等从 serialize 剔除以保住 `slotYieldSummary`（session cache 仍保留全量）。见 `agentJbYieldCore.ts`。

**测试：** `pcr-ai-api/test/agentJbBadBinCluster.test.ts`

---

## 3. 测试中断次数（≠ 半片段数）

**文件：** `pcr-ai-api/src/lib/jbYieldCalc.ts` — `countTestInterruptEvents()`：

1. `PASSTYPE === INTERRUPT` 行数  
2. 否则 `PASSNUM` 跳变次数  
3. 否则同 PASSNUM 多 TEST 行 −1  

**字段：** `SlotYieldSummaryEntry.testInterruptCount` → `testInterruptCountMarkdown` / `formatTestInterruptCountMarkdown`。

**确定性模式：** `agentJbDeterministicReply.isInterruptCountQuestion` → `interrupt_count`。

**禁止：** 用 `slotYieldSummary` 仅 2 段推断「中断 2 次」。

**测试：** `jbYieldCalc.test.ts`、`agentJbDeterministicReply.test.ts`

---

## 4. 测试机 + 探针卡（同问必同表）

**文件：** `agentJbBinFormat.ts` — `buildTesterByLot`, `buildCardByPassId`, `cardByPassIdMarkdown`。

| 用户问法 | 模式 | 实测数据表 |
| --- | --- | --- |
| 机台 + 几号卡 | `equipment` | **cardByPassId 表 + TESTERID 表** |
| 仅机台 | `tester_machine` | 机台表（有数据则附带卡表） |

**禁止：** 有 `cardByPassId` 却写「无 CARDID」而不出表。

**Prompt：** JB `TESTERID` ↔ Yield `HOSTNAME`。

---

## 5. 多次中断逐段良率（非仅前半/后半）

**文件：** `jbYieldCalc.ts` — `buildYieldInterruptSegments()` → `slotYieldSummary[].interruptSegments`。

| 数据形态 | 输出段 |
| --- | --- |
| 多行 `PASSTYPE=INTERRUPT` | 中断1 … 中断N → 续测完成 → 整片正片（合并） |
| passNum 1,2,3…（≥3） | 续测段1(passNum1) … → 整片合并 |
| 单次中断 + 续测 | 前半段 → 后半段 → 整片合并（与旧行为一致） |

展示：`slotYieldInterruptMarkdown`、`formatSlotYieldFlatTable` 均读 `interruptSegments`。

**次数：** 仍用 `testInterruptCount`（≠ 段数）。

---

## 6. 前端：数据 vs 结论分栏

| 文件 | 作用 |
| --- | --- |
| `pcr-ai-report/src/utils/splitAgentReplyMarkdown.ts` | 在 `## 分析结论` 或 `### 数据解读` 处拆分；结论段 `stripPipeTablesFromMarkdown` |
| `AiAgentReport.tsx` | `AgentMarkdownBody` → `.ai-md-data` / `.ai-md-commentary` |
| `AiAgentReport.css` | 数据表 `max-content` + 横滚；结论区隐藏表格 |

**服务端对齐：** `agentLoop.ts`、`agentJbDeterministicReply.ts` 使用 `DETERMINISTIC_DATA_SECTION_TITLE` / `DETERMINISTIC_COMMENTARY_SECTION_TITLE`。

---

## 6. 部署与验证

```bash
cd pcr-ai-api && npm ci && npm run build && npm run pm2:reload
cd pcr-ai-report && npm ci && npm run build   # 或 pack:dist
cd pcr-ai-api && npm test
```

**手测 lot（用户样例）：** `DR45459.1A` — wafer 1 中断 4 次、4→3、5/10→2；问机台应读 `testerId`/`testerByLot`；有 BIN 片间突增时文首应有 ⚠ 警示表。

**已知 CI 噪音（与本提交无关时需单独修）：** `resolveAgentConfig` override、`GET /api/v3/infcontrol-layer-bins/v3` dummy。

---

## 7. 关键文件索引

```
pcr-ai-api/src/lib/agent/agentJbBadBinCluster.ts   # 新增
pcr-ai-api/src/lib/agent/agentJbBinFormat.ts
pcr-ai-api/src/lib/agent/agentJbHistoryCompact.ts
pcr-ai-api/src/lib/agent/agentJbDeterministicReply.ts
pcr-ai-api/src/lib/agent/agentJbYieldCore.ts
pcr-ai-api/src/lib/agent/agentLoop.ts
pcr-ai-api/src/lib/agent/agentPrompt.ts
pcr-ai-api/src/lib/jbYieldCalc.ts
pcr-ai-report/src/utils/splitAgentReplyMarkdown.ts  # 新增
pcr-ai-report/src/reports/AiAgentReport.tsx
```
