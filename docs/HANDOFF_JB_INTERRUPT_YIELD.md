# Claude Code 交接：JB 中断 slot 良率 + Agent 汇报规则

**分支：** `feat/report-ux-dut-bin-agg`  
**读者：** Claude Code / Cursor Agent 接手本仓库时优先阅读。  
**相关代码：** `pcr-ai-api/src/lib/jbYieldCalc.ts`、`agent/agentPrompt.ts`、`agent/agentJbBinFormat.ts`

---

## 1. 背景与问题

用户反馈：有 **测试中断（`PASSTYPE=INTERRUPT`）** 的 slot，Agent 只报了**下半片**良率（例如 NF12773.1H Slot 22 的 2011 / 94.88%），未单独列出**上半片**（常为 0% 良品）。

需求：

1. API `query_jb_bins` 的 **`slotYieldSummary`** 在有中断时拆出 **`interruptHalf`**（前半）、**`completionHalf`**（后半），顶层仍为**整片正片**。
2. Agent **输出顺序固定**：**整片正片 → 前半段 → 后半段**（按测试时间先后）。
3. **良率为 0% 的段也必须写出**（total / 好 / 坏 / 0%），禁止因无良品省略前半段。

---

## 2. 良率计算规则（`jbYieldCalc.ts`）

与报表 `pcr-ai-report/src/utils/yieldCalc.ts` 的 `computeYieldPct` 应对齐（报表侧尚未拆 `interruptHalf` 字段，仅 API/Agent 有）。

| 场景 | 规则 |
| --- | --- |
| **分组键** | **(slot, passId)** — 同一片 wafer、同一 sort 层；`splitSlotIntoHalves` 先按 `PASSID` 分组，取第一个发生分段的 pass 组。 |
| **判定有分段** (`hasInterrupt:true`) | 组内：存在 `PASSTYPE=INTERRUPT`；或 **PASSNUM 递增**（1→2→3）；或 **PASSNUM 相同但多行**（按 `TESTEND` 先后拆）。 |
| **前半 / 后半** | INTERRUPT → 前半；或 **较小 PASSNUM** → 前半；或 **较早 TESTEND**（同 PASSNUM 多行）→ 前半。 |
| **无分段** | 同 slot 仅一行/一 pass 组：`grossDie = MAX(GROSSDIE)`，坏 die 仅在满片行累加。 |
| **整片正片**（顶层） | 前半 **goodDie = 0** → 正片 **仅后半**（例：DR43375 Slot 21）。前半 **goodDie > 0** → 上下半合并。 |

良品 bin：`BIN1` + `PASSBIN` 连字符段 + `bins[].isGoodBin`（与 `passBinSemantics` / 报表 `infGoodBins` 一致）。

### `slotYieldSummary` 条目形状

```ts
{
  slot: number;
  grossDie, badDie, goodDie, yieldPct;  // 整片正片
  hasInterrupt: boolean;
  rowCount: number;
  interruptHalf?: { grossDie, badDie, goodDie, yieldPct };   // 有中断时必有
  completionHalf?: { ... };                                   // 有完成段时必有
}
```

工具回传里的 **`_slotYieldGuide`** 由 `slotYieldSummaryFieldGuide()` 生成，与 prompt 一致。

---

## 3. Agent prompt（`agentPrompt.ts`）

在 **「测试中断（INTERRUPT）」** 与 **「枚举 lot 内 wafer」** 两节已写明：

- `hasInterrupt:true` → 每 slot 三行：**整片正片 → 前半段 → 后半段**。
- **0% 也要输出**；禁止只报后半段或顺序写成「前半→后半→整片」。
- **回复质量** ① 关键数字：有中断 slot 三段各写一行。

**pass/sort（同分支较早 commit）：** `pass1=sort1→passId 1`，`pass3=sort2→3`，`pass5=sort3→5`，禁止 2/4。见 `agentToolSchemas.ts` 中 `passId` 描述。

---

## 4. 部署与验证

```bash
cd pcr-ai-api
npm ci
npm test                    # 含 test/jbYieldCalc.test.ts
npm run build
npm run pm2:reload          # 生产见 docs/DEPLOY_PM2.md
```

**诊断脚本（连生产 API，默认 `http://10.192.130.89:30008`）：**

```bash
cd pcr-ai-api
npx tsx scripts/print-slot-yield-api.ts NF12773.1H
npx tsx scripts/print-slot-breakdown.ts NF12773.1H 20-25
```

列表需 **`limit=500`** 才覆盖整 lot 多 slot。

---

## 5. 单测

`pcr-ai-api/test/jbYieldCalc.test.ts`：

- 无中断满片 MAX(GROSSDIE)
- 中断前半 good=0 → 正片=后半（slot 21 模式）
- 中断前半 good>0 → 上下合并
- `buildSlotYieldSummary` 含 `interruptHalf` / `completionHalf` / 顶层正片

---

## 6. 数据注意（NF12773.1H Slot 22）

2026-05 线上：`slot=22, passId=1` 有 **2 条 TEST、PASSNUM 均为 1**（960 @ 13:07 + 2011 @ 15:41）。按 **同 PASSNUM 多行 + TESTEND** 应 `hasInterrupt:true`，半片为 960（前半）与 2011（后半）；整片正片在前后半均有良品时为 **2971 合并** 或前半 good=0 时仅后半（以实算为准）。

诊断：

```bash
npx tsx scripts/dump-slot-rows.ts NF12773.1H 22
npx tsx scripts/scan-passnum.ts NF12773.1H
npx tsx scripts/print-slot-breakdown.ts NF12773.1H 22
```

---

## 7. 同分支其它已完成项（便于串联）

| 主题 | 位置 |
| --- | --- |
| Agent 反馈按钮 | `pcr-ai-report` `AiAgentReport.tsx`：仅 SSE `done` 后显示，在气泡**下方** |
| 报表 Yield% | `yieldCalc.ts` 与 API 正片规则一致，**未**暴露半片 JSON |
| INF DUT 分布 | `docs/SITE_BIN_BY_LOT_INTEGRATION.md` |

---

## 8. 待办 / 可选后续

- [ ] 报表 JB 视图：slot 有中断时在 UI 展示半片三行（复用 `computeJbYieldBreakdown` 或抽共享包）。
- [ ] `agentJbBinFormat.test.ts`：断言 `wrapJbQueryResultForAgent` 含 `interruptHalf` 的中断样例。
- [ ] 若库内 INTERRUPT 漏标：与 DBA/测试确认 `PASSTYPE` 写入规则，勿改代码强行把 TEST 当 INTERRUPT。

---

## 9. 改动文件清单（本交接对应 commit）

| 文件 | 变更 |
| --- | --- |
| `pcr-ai-api/src/lib/jbYieldCalc.ts` | `computeJbYieldBreakdown`、`SlotYieldSummaryEntry` 半片字段 |
| `pcr-ai-api/src/lib/agent/agentPrompt.ts` | 中断汇报顺序 + 0% 必输出 |
| `pcr-ai-api/test/jbYieldCalc.test.ts` | 半片汇总测试 |
| `pcr-ai-api/scripts/print-slot-breakdown.ts` | 诊断：整片/前半/后半 |
| `docs/HANDOFF_JB_INTERRUPT_YIELD.md` | 本文档 |

**入口索引：** 在 `pcr-ai-api/CLAUDE.md` §2 必读表已增加本文件链接。
