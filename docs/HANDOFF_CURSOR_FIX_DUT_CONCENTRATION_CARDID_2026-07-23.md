# Cursor 修复交接（2026-07-23 · 给 Claude Code）

> **执行者：** Cursor Agent  
> **读者：** Claude Code / 接手 Agent DUT 集中度表的 Agent  
> **前置阅读：** [`superpowers/specs/2026-06-26-card-dut-baddie-analysis-design.md`](superpowers/specs/2026-06-26-card-dut-baddie-analysis-design.md) §4.2–4.3；[`HANDOFF_AGENT_JB_PROBE_CARD_CHANGE.md`](HANDOFF_AGENT_JB_PROBE_CARD_CHANGE.md)（`cardByPassId`）  
> **分支：** `main`  
> **范围：** Agent `query_lot_dut_bin_agg` 产出的「坏 die 的 DUT 集中度」表，**卡号**列恒为 `—`

---

## 0. 一眼结论

| 项 | 状态 | 说明 |
|---|---|---|
| **现象** | ✅ 已修 | 判别已是「疑探针卡」，但表里 **卡号 = —**；用户问「哪个 probe card 多 / 集中哪些 DUT」时看不到卡号 |
| **根因** | ✅ 已定位 | `toolQueryLotDutBinAgg` 调用 `buildDutConcentrationInsights(rawPasses, [], …)`，**第二参写死空数组**；Oracle `fetchJbTestRowsForLot` 也未 SELECT `CARDID` |
| **改法** | ✅ 已合入 | 一次拉 JB TEST 行 → `buildCardByPassId` + goodBins；四处 handler 传入 `cardByPassId`；Oracle SQL 补 `CARDID`（Dummy 全行本就有） |
| **本地单测** | ✅ | `npx tsx --test test/agentDutBinAggInsight.test.ts test/agentDutConcentration.test.ts` → **17/17** |
| **部署后复验** | ⏭ 待做 | `cd pcr-ai-api && npm run build && pm2 reload` 后重问下方真库句 |

---

## 1. 问题复现

用户问（例）：

> WA00P32P, bin90, 按照bin fail, 显示哪个probe card多些, 并显示出集中哪些dut

Agent 走 `query_lot_dut_bin_agg(device, lot, focusBin: 90)`，返回：

- 表：**坏 die 的 DUT 集中度（卡 vs 工艺判别）**
- BIN90 / pass1 / **卡号 `—`** / 总坏die 41 / DUT5(56%)… / **疑探针卡**
- JSON 有 `focusBin` + `focusBinDuts`，**无**卡号字段（设计上也不应把内部名 `cardByPassId` 写进 JSON）

`attachDutConcentrationToJbPayload` 路径若 payload 已带 `cardByPassId` 本来就能填卡号（I1 单测）；本次 bug 在 **直调 `query_lot_dut_bin_agg`**。

---

## 2. 根因

1. **`agentToolDutBinAgg.ts`**：四处 `buildDutConcentrationInsights(rawPasses, [], opts)` — 第二参恒 `[]` → `cardId: null` → markdown `| — |`。
2. **`fetchJbTestRowsForLot`（Oracle）**：只 SELECT `PASSID, PASSBIN`，即便想从同一批行建 `cardByPassId` 也没有 `CARDID`。Dummy 路径返回全行，含 `CARDID`（如 `DR43782.1A` → `7804-02`）。

设计意图（spec）：从 `cardByPassId` 取该 pass 卡号写入 insight；缺失时用「该 pass 探针卡」措辞、表列 `—`，**不捏造**。

---

## 3. 改法（已合入）

| 文件 | 改动 |
|---|---|
| `pcr-ai-api/src/lib/agent/tools/agentToolDutBinAgg.ts` | `lotDutConcentrationOpts` → **`lotDutConcentrationContext`**：返回 `{ opts, cardByPassId }`；四处调用传入 `cardByPassId` |
| `pcr-ai-api/src/lib/lotUnderperformingDutsResolve.ts` | Oracle：`SELECT …, lb.CARDID AS CARDID`（与 Dummy 对齐） |
| `pcr-ai-api/test/agentDutBinAggInsight.test.ts` | 断言集中度表含 Dummy CARDID **`7804-02`** |

**勿**把 `cardByPassId` 写入工具 JSON 正文（既有断言：结果字符串不得含内部字段名 `cardByPassId`）。

---

## 4. 验证

**本地（已跑）：**

```bash
cd pcr-ai-api
npx tsx --test test/agentDutBinAggInsight.test.ts test/agentDutConcentration.test.ts
# 17 pass，含 query_lot_dut_bin_agg concentration table includes probe card from JB CARDID
```

**部署后真库（⏭ Claude Code / 运维）：**

```bash
cd pcr-ai-api && npm run build && pm2 reload
```

Agent 重问：

> WA00P32P, bin90, 按照bin fail, 显示哪个probe card多些, 并显示出集中哪些dut

**判定：** 集中度表 **卡号** 列为该 lot 对应 pass 的真实 CARDID（非 `—`）；判别与 DUT 占比逻辑不变。

可选 Dummy 冒烟：`query_lot_dut_bin_agg(device: WA10P29E, lot: DR43782.1A)` → 表含 **7804-02**。

---

## 5. 已知边界（未改）

- **中途换卡**（同 pass 多 CARDID）：`cardIdForPass` 用 `cardIds.join(", ")`，表里可出现多卡并列——符合现有 `buildCardByPassId` 语义。
- **「哪张卡 fail 更多」跨 lot 排名**仍应走 `aggregate_jb_bins(groupBy:"bin,cardId")`；本修只补 **单 lot DUT 集中度表的卡号列**。
- `attachDutConcentrationToJbPayload` 在 payload **无** `cardByPassId` 时仍可能 `—`；本次未改为二次拉 JB（直调工具路径已自给自足）。

---

## 6. 给 Claude Code 的一句话

**`query_lot_dut_bin_agg` 的卡号列空是因为 `cardByPassId` 从未传入 + Oracle 未取 CARDID；已修。部署 `pm2 reload` 后用 WA00P32P/bin90 复验卡号非 `—`。**
