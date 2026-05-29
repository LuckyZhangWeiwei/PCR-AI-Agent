# AI Agent 交接：JB 中途换卡（CARDID × passId）

**日期：** 2026-05-29（修订：同 pass 才算换卡）  
**背景：** Agent 将 **pass1 用 8041-08、pass3 用 8041-05** 误判为「24 片 wafer 均在测试中途换卡」。用户规则：**中途换卡** = **同一 pass、同一片 wafer（slot）** 用了 **不同 CARDID**；**不同 pass 用不同卡** 属于正常流程，**不算**换卡。

---

## 1. 业务规则（硬）

| 场景 | 规则 |
| --- | --- |
| **中途换卡** | 同一 **(slot, passId)** 在 `query_jb_bins` 返回行内 **CARDID**（trim）出现 **≥2 个不同值** |
| **正常（非换卡）** | **pass1（sort1/常温）** 与 **pass3（sort2/高温）** 各用一张卡，例如 pass1=**8041-08**、pass3=**8041-05** — **禁止**写成「整批中途换卡」或把两 pass 的卡号对调 |
| **坏 bin** | 按 **(slot, passId, cardId)** 读 `slotBadBinsCompact`；同组内 INTERRUPT/续测行 dieCount 相加 |
| **INF DUT** | `query_inf_site_bin_by_dut` 的 **passId + cardId** 须与 **该段 JB 行** 一致 |
| **禁止** | 用「同 slot 多 CARDID」「`cardIds.length > 1`」单独判定换卡 |

**典型误判（勿重复）：**

> ❌ 「所有 24 片 wafer 均在测试中途换卡（前 18 片从 8041-05 换成 8041-08…）」  
> ✅ **常温 pass1**：**8041-08**；**高温 pass3**：**8041-05**（不同 pass 各一卡，**无**同 pass 中途换卡，除非 `cardChangesBySlotPass` 有 `hasCardChange:true`）

**与中断续测：** 先按 **(slot, passId)** 看换卡，再在同一 (slot, passId, cardId) 段内按 INTERRUPT/PASSNUM 拆半片 → [`HANDOFF_JB_INTERRUPT_YIELD.md`](HANDOFF_JB_INTERRUPT_YIELD.md)。

---

## 2. `query_jb_bins` 工具回传字段

**文件：** `pcr-ai-api/src/lib/agent/agentJbBinFormat.ts`

| 字段 | 说明 |
| --- | --- |
| **`cardByPassId`** | `[{ passId, cardIds[], hasCardChange }]` — 各 sort/pass 用了哪些卡（跨 slot 汇总） |
| **`cardChangesBySlotPass`** | `[{ slot, passId, cardIds[], hasCardChange }]` — **仅** `hasCardChange:true` 为中途换卡 |
| **`slotBadBinsCompact`** | `[{ slot, passId, cardId, badBins[] }]` |
| **`recentLotsByTestEnd`** | `hasCardChangeInLot` = 是否存在任一 (slot,pass) 中途换卡（**非**多 pass 各一卡） |
| **`binBySlot`** | 降级键：`"slot:passId:cardId"` → `{ "7": 124 }` |

---

## 3. Agent prompt / schema

- **`agentPrompt.ts`**：中途换卡定义、8041-08/8041-05 反例、读 `cardByPassId`  
- **`agentToolSchemas.ts`**：`query_jb_bins` 描述同步  

---

## 4. 已知未改范围

| 字段 | 现状 |
| --- | --- |
| **`bin10Vs66ByLot`** | 仍 lot 级跨 pass、跨卡合计 |
| **`slotYieldSummary`** | 仍 (slot, passId) 良率，未按 cardId 拆段 |

---

## 5. 部署与验证

```bash
cd pcr-ai-api
npm test -- test/agentJbBinFormat.test.ts
npm run typecheck && npm run build && npm run pm2:reload
```

**单测：**

- 同 (slot, passId) 两 CARDID → `hasCardChange: true`  
- 同 slot、pass1=8041-08、pass3=8041-05 → `hasCardChange: false`，`cardByPassId` 两条  

---

## 6. 源码索引

| 文件 | 函数 |
| --- | --- |
| `agentJbBinFormat.ts` | `buildCardChangesBySlotPass`、`buildCardByPassId`、`buildSlotBadBinsCompact` |
| `agentPrompt.ts` | 换卡 + pass 规则 |
| `test/agentJbBinFormat.test.ts` | 回归 |

---

## 7. Agent 结论模板

> **常温 sort1（passId=1）**：探针卡 **8041-08**  
> **高温 sort2（passId=3）**：探针卡 **8041-05**  
> （不同 pass 各用一卡，**不属于**中途换卡。）  
> 若 `cardChangesBySlotPass` 存在 `hasCardChange:true`：列出 **slot X、passId Y** 从卡 A 换到卡 B。
