# AI Agent 交接：JB 同 slot 中途换卡（CARDID）

**日期：** 2026-05-29  
**背景：** Agent 回答 lot **DR45459.1A** 时写「整批 5 片 wafer 统一探针卡 6093-01」，仅依据 `recentLotsByTestEnd` 最近 TESTEND 行的 `cardId`，未识别同 slot 多行 **CARDID** 不同（中途换卡）。用户规则：**同一 slot 若 CARDID 列不同 = 中途换卡**；坏 bin 与 INF DUT 须挂到对应卡，禁止跨卡合并。

---

## 1. 业务规则（硬）

| 场景 | 规则 |
| --- | --- |
| **换卡判定** | 同一 **(lot, slot)** 在 `query_jb_bins` 返回的多行中，**CARDID**（trim 后）若出现 **≥2 个不同值** → 该 slot **中途换卡**（与 INTERRUPT/续测无关，只看 CARDID） |
| **坏 bin** | 按 **(slot, cardId)** 分别汇总；同 (slot, cardId) 内 INTERRUPT/续测行仍 **同 bin dieCount 相加** |
| **INF DUT** | `query_inf_site_bin_by_dut` 的 **cardId** 必须与 **该段 JB 行** 的 CARDID 一致；换卡后须 **分卡** 再调 INF |
| **禁止** | 用 `recentLotsByTestEnd.cardId`（仅最近 TESTEND 一行）推断「整 lot / 整批统一一张卡」 |
| **lot 级** | `recentLotsByTestEnd.cardIds` 为返回行集内该 lot 全部不同 CARDID；`hasCardChangeInLot: true` 表示 lot 内曾出现多张卡（可能不同 slot 各用一卡，也可能同 slot 换卡） |

**与中断续测区分：** INTERRUPT / PASSNUM / TESTEND 拆半片见 [`HANDOFF_JB_INTERRUPT_YIELD.md`](HANDOFF_JB_INTERRUPT_YIELD.md)。换卡与半片可并存：先按 CARDID 分段，再在每段内按中断规则看良率。

---

## 2. `query_jb_bins` 工具回传字段

**文件：** `pcr-ai-api/src/lib/agent/agentJbBinFormat.ts` → `wrapJbQueryResultForAgent`

| 字段 | 形状 / 说明 |
| --- | --- |
| **`cardChangesBySlot`** | `[{ slot, cardIds[], hasCardChange }]` — 快速列出哪些片换卡 |
| **`slotBadBinsCompact`** | `[{ slot, cardId, badBins[] }]` — **按 (slot, cardId) 分组**，同 slot 多卡为多条 |
| **`recentLotsByTestEnd`** | 每 lot：`cardIds[]`、`hasCardChangeInLot`、`cardId`（最近一行）、`testEnd`、… |
| **`binBySlot`** | 体积降级时：`{ "slot:cardId": { "7": 124 } }`（键含卡号，同 slot 不覆盖） |
| **`_cardChangesBySlotGuide`** 等 | 与上表对应的 `_…Guide` 字符串，供模型读 |

**序列化：** `serializeJbQueryResultForAgent` 超限时仍保留 `cardChangesBySlot`、`recentLotsByTestEnd`、`slotBadBinsCompact`（或 `binBySlot`）。

---

## 3. Agent prompt / schema

| 文件 | 改动 |
| --- | --- |
| **`agentPrompt.ts`** | 层级图改为 lot → slot → CARDID；换卡、BIN、INF 分卡规则；`recentLotsByTestEnd` 以 **cardIds** 为准 |
| **`agentToolSchemas.ts`** | `query_jb_bins` description 列出 `cardChangesBySlot`、按 slot+cardId 的 compact |

---

## 4. 已知未改范围（勿误以为已分卡）

| 字段 / 能力 | 现状 |
| --- | --- |
| **`bin10Vs66ByLot`** | 仍按 **lot** 跨 slot、**跨 CARDID** 相加 BIN10/BIN66 |
| **`slotYieldSummary`** | 仍按 **(slot, passId)** 良率，**未**按 cardId 拆段 |
| **`buildBinTotalsByLot`** | 同上，lot 级坏 bin 合计 |

若用户问「某 lot 在某张卡上的 BIN10 vs BIN66」，应用 **`query_jb_bins(cardId=…, lot=…)`** 或看 **`slotBadBinsCompact`** / **`rows`**，不要单独信 `bin10Vs66ByLot` 在换卡 lot 上的含义。

---

## 5. 部署与验证

```bash
cd pcr-ai-api
npm ci
npm test                    # 含 test/agentJbBinFormat.test.ts
npm run typecheck
npm run build
npm run pm2:reload          # 生产
```

**单测要点（`agentJbBinFormat.test.ts`）：**

- 同 slot 两 CARDID → `slotBadBinsCompact` 两条、不合并 dieCount  
- `buildCardChangesBySlot` → `hasCardChange: true`  
- 同 lot 两 CARDID → `recentLotsByTestEnd[0].cardIds` 含两张、`hasCardChangeInLot: true`  
- `serializeJbQueryResultForAgent` 降级 → `binBySlot["23:8041-05"]`

**联调示例：**

```http
POST /api/v4/agent/chat
# 或直连列表
GET /api/v4/infcontrol-layer-bins/v4?lot=DR45459.1A&limit=200
```

核对：同 slot 各行 **CARDID** 是否一致；工具 JSON 中 **`cardChangesBySlot`** 与 **`slotBadBinsCompact[].cardId`**。

---

## 6. 源码索引

| 文件 | 职责 |
| --- | --- |
| `pcr-ai-api/src/lib/agent/agentJbBinFormat.ts` | `buildCardChangesBySlot`、`buildSlotBadBinsCompact`、`buildRecentLotsByTestEnd`、`buildBinBySlotMap` |
| `pcr-ai-api/src/lib/agent/agentPrompt.ts` | 探针卡层级、INF 前置、最近 lot 读法 |
| `pcr-ai-api/src/lib/agent/agentToolSchemas.ts` | `query_jb_bins` 工具描述 |
| `pcr-ai-api/test/agentJbBinFormat.test.ts` | 回归 |

**相关：** [`HANDOFF_AGENT_JB_BIN_AND_TOOL_RESULT.md`](HANDOFF_AGENT_JB_BIN_AND_TOOL_RESULT.md)（逐片 BIN 体积）、[`HANDOFF_JB_INTERRUPT_YIELD.md`](HANDOFF_JB_INTERRUPT_YIELD.md)（半片良率）、[`SITE_BIN_BY_LOT_INTEGRATION.md`](SITE_BIN_BY_LOT_INTEGRATION.md)（INF DUT）。

---

## 7. Agent 结论模板（换卡 lot）

> Lot **{lot}** 在返回数据中出现探针卡：**{cardIds 列表}**（`hasCardChangeInLot` / 按 slot：`cardChangesBySlot`）。  
> **Slot {n}**：{卡 A} … / {卡 B} …（坏 bin 与 DUT 分卡写，勿写「整批统一 {单卡}」）。

逐行核对：读工具 **`rows`** 每行的 **CARDID、TESTEND、PASSNUM、PASSTYPE**。
