# Cursor 修复交接（2026-07-23 · 跨 lot BIN×卡 + lot 列表被单 lot DUT 抢答）

> **执行者：** Cursor Agent  
> **读者：** Claude Code  
> **关联：** [`HANDOFF_CURSOR_FIX_DUT_CONCENTRATION_CARDID_2026-07-23.md`](HANDOFF_CURSOR_FIX_DUT_CONCENTRATION_CARDID_2026-07-23.md)（卡号列已修）  
> **分支：** `main`  
> **范围：** device + 近 N 月 + bin fail + 哪张 probe card + DUT + lot 列表 → 误出**单 lot** DUT 集中度表

---

## 0. 一眼结论

| 项 | 状态 | 说明 |
|---|---|---|
| **现象** | ✅ 已修 | 问「WA00P32P 近3个月 bin90 哪个 probe card 多 / DUT / lot 列表」却只出 `DR44948.1H` 单 lot DUT 表（卡号虽已填） |
| **根因** | ✅ | ① `isDutBinConcentrationQuestion` 见 `dut` 即 true → P-F 抢答；② `isBinCardAttributionQuestion` 不认英文 `probe card` → mode 落 `equipment`；③ lot 列表路由会再抢在卡归因前 |
| **改法** | ✅ | 跨 lot/时间窗/lot 列表 → 禁止 P-F；扩展卡归因正则；lot 列表在卡归因时 bail；语义派发卡表后可补 lot 列表 |
| **本地** | ✅ | `agentLoop` + semantic + dutBinMap **50/50**；`resolveDispatch` → `aggregate_jb_bins(device, 近3月, groupBy:bin,cardId)` |
| **部署复验** | ⏭ | `pm2 reload` 后重问下方原句 |

---

## 1. 复现问句

> WA00P32P，近3个月，bin90，按照bin fail，显示哪个probe card多些，并显示出集中哪些dut，并列出数据包含的lot列表

**修前：** `query_lot_dut_bin_agg(lot=DR44948.1H)` 单 lot 集中度表（history lot）。  
**修后期望：**

1. **BIN90 × 探针卡** 跨 lot 排行（`aggregate_jb_bins`，`JB_DETERMINISTIC_DISPATCH=true` 时直出）  
2. 同句要列表时再附 **lot 列表**（`query_jb_bins`）  
3. DUT：卡表脚注引导追问「指定 lot 的 BIN90 DUT」；跨 lot DUT 非本工具范围

---

## 2. 改动文件

| 文件 | 改动 |
|---|---|
| `jb/agentJbQuestionClassifiers.ts` | `isBinCardAttributionQuestion` 认 `probe card` / `card.*多` |
| `dispatch/agentQuestionHeuristics.ts` | `isCrossLotBinCardOrListingScope`；无 lot + 时间窗/列表 → P-F false；`requiresNewDataQuery` 扩「近N月」 |
| `agentJbLotListingRoute.ts` | 卡归因时 `canRunLotListingDirectRoute` false |
| `dispatch/agentSemanticDispatch.ts` | `bin_card_attribution` + lot 列表 → 补查并附 `buildRecentLotsListingMarkdown` |
| `test/agentLoop.test.ts` / `routing-golden.ts` | 回归；flag 测试改 `patchConfig`（runtime-config 优先于 env） |

---

## 3. 验证

```bash
cd pcr-ai-api
npx tsx --test test/agentLoop.test.ts test/agentSemanticDispatchTable.test.ts test/agentDutBinMapRoute.test.ts
# 50 pass
```

分类器冒烟（修后）：`dut=false, card=true, mode=bin_card_attribution, canList=false`。

**部署后：** Settings 确认 **JB 确定性派发** 打开（`jbDeterministicDispatch`），重问原句 → 应见 BIN×卡表 + lot 列表，**不是**单 lot `DR44948.1H` DUT 集中度表。

DUT 细表仍需追问：`DR44948.1H BIN90 集中哪些 DUT`（句中带 lot → 仍走 P-F）。

---

## 4. 给 Claude Code 一句话

**跨 lot「哪张 probe card + DUT + lot 列表」曾被单 lot P-F 抢答；已让位 bin_card_attribution（+ 可选 lot 列表）。部署后用 WA00P32P/近3月/bin90 原句复验。**
