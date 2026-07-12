# Cursor 真库验证结果（2026-07-12 · Agent 回答准确性 + 探针卡路由抽样）

> **执行者：** Cursor Agent  
> **代码：** 本地 `main` **`ee48ab2`**（已 push）；**远程 `10.192.130.89:30008` 验证时尚未 pm2 reload 此 commit**  
> **任务来源：** [`HANDOFF_CURSOR_AGENT_ACCURACY_2026-07-11.md`](HANDOFF_CURSOR_AGENT_ACCURACY_2026-07-11.md)、[`HANDOFF_CURSOR_REALDB_PROBE_CARD_TESTER_PERFORMANCE_2026-07-11.md`](HANDOFF_CURSOR_REALDB_PROBE_CARD_TESTER_PERFORMANCE_2026-07-11.md) §5 Q5  
> **原始日志：** [`scratchpad/realdb-agent-accuracy-2026-07-12.txt`](../scratchpad/realdb-agent-accuracy-2026-07-12.txt)  
> **复跑：** `cd pcr-ai-api && node scripts/verify-realdb-agent-accuracy-2026-07-12.mjs`

---

## 0. 一眼结论

| 项 | 真库结论 | 说明 |
|---|---|---|
| **REST P0-2/P0-3** | ✅ **3/3** lot `pass1` baseline > 0%（无全 0 退化大表数据源） | `NF12595.1A` 75.2%、`DR41803.1Y` 96.8%、`NF12499.1N` 95.1% |
| **Agent P0-4 good bin 直答** | ❌ **仍被 lot 概况劫持** | 第二问仍出机台/良率/逐片表 → **需 deploy `ee48ab2` 后复验** |
| **Agent P1-5/P1-6 listing** | ⚠️ **部分改善 / 未终验** | 标题已为 `device=WA01N39W`（无机台）；脚本判 FAIL（可能尾部仍 append DUT 或判定过严） |
| **Agent P2-8a 9440-03** | ✅ **有数据、非空转** | 95.65% pass1 表 + 坏 bin 排行；**旧 count=0 场景未复现** |
| **探针卡 Q5 组合排名路由** | ❌ **仍 hijack 到单 lot `query_jb_bins`** | 未命中 `aggregate_probe_card_tester_performance` |

**总判：** REST 层 DUT 良率取数在真库上**已非全 0 退化**；Agent 层 SSE 修复 **必须先在 `10.192.130.89` 上 `npm run build && npm run pm2:reload`** 再跑一轮 `verify-realdb-agent-accuracy-2026-07-12.mjs`。

---

## 1. 环境

| 项 | 值 |
|---|---|
| 验证时间 | 2026-07-12 ~01:52 UTC（09:52 +08） |
| API | `http://10.192.130.89:30008` |
| Health | `agentEnabled=true`, `agentJbDeterministicSummary=true` |
| Agent 模型 | `deepseek-ai/DeepSeek-V4-Flash` |
| 本地 HEAD | `ee48ab2` |
| 远程 deploy | **未确认** — SSE 行为与旧 dist 一致 |

---

## 2. REST — lot-underperforming-duts（P0-2/P0-3 口径）

```bash
curl -s -m 180 "http://10.192.130.89:30008/api/v4/inf-analysis/lot-underperforming-duts?lot=NF12595.1A&passId=1"
curl -s -m 180 "http://10.192.130.89:30008/api/v4/inf-analysis/lot-underperforming-duts?lot=DR41803.1Y&passId=1"
curl -s -m 180 "http://10.192.130.89:30008/api/v4/inf-analysis/lot-underperforming-duts?lot=NF12499.1N&passId=1"
```

| Lot | device | pass1 baseline | 判定 |
|---|---|---:|---|
| NF12595.1A | WA02P87K | **75.2%** | ✅ 非 0% |
| DR41803.1Y | WA01N39W | **96.8%** | ✅ 非 0%；与 JB 概况表 pass1 96.8% 同量级 |
| NF12499.1N | WA03P02G | **95.1%** | ✅ 非 0% |

> **待 deploy 后补验：** Agent 同屏 JB 分 sort 良率 vs DUT 表头「lot 整体 %」是否 ≤ 舍入误差（handoff 原 bug：`NF12595.1A` 47.83% vs 89.41%）。

---

## 3. Agent SSE

### P0-4 — 「DR41803.1Y 中的 good bin 是多少」

- 前置：「DR41803.1Y 的测试情况」  
- **结果：** ❌ 第二问仍输出完整 lot 概况（机台表 + 良率表 + 逐片 pivot），**未**直答 BIN 编号  
- **原因：** 远程未部署 `isGoodBinValueQuestion` / `tryRunGoodBinValueDirectRoute`（`ee48ab2`）

### P1-5 — 「WA01N39W 的测试情况」

- **结果：** ⚠️ 主体为 **213 lot 列表**，标题 `（device=WA01N39W）` **无机台** → P1-6 标签侧疑似已改善  
- 脚本判 FAIL：需 deploy 后查看完整 SSE 文本是否仍尾部 append DUT 大表

### P2-8a — 「9440-03 卡的测试情况」

- **结果：** ✅ 约 10 分钟内返回；pass1 95.65%、9440-03 卡表、坏 bin Top10  
- **旧 bug（count=0 + 125s 空转）：** **未复现**

### Q5 — 「WA03P02G …最好的探针卡+机台组合…」

- **结果：** ❌ 输出单 lot `NF13524.1F` 的卡汇总，**非**四表组合排名  
- **工具：** 未观察到 `aggregate_probe_card_tester_performance`（可能旧路由 + 未 deploy `758c282`/`31956f1` 组合）

---

## 4. 下一步（必须）

1. **在 API 主机：** `git pull && cd pcr-ai-api && npm ci && npm run build && npm run pm2:reload`  
2. **复跑：** `node scripts/verify-realdb-agent-accuracy-2026-07-12.mjs`  
3. **期望：** P0-4 / P1-5 / Q5 转绿；REST 维持 3/3  
4. **探针卡完整 Q1–Q7：** 仍按 [`HANDOFF_CURSOR_REALDB_PROBE_CARD_TESTER_PERFORMANCE_2026-07-11.md`](HANDOFF_CURSOR_REALDB_PROBE_CARD_TESTER_PERFORMANCE_2026-07-11.md) 在 deploy 后逐项补完

---

## 5. 给 Claude Code

- **代码：** `ee48ab2` 已 push，单测 + 黄金集已通过  
- **真库 REST：** DUT baseline 三条 lot 均正常，**不支持「全 0 大表」回归**  
- **真库 Agent：** **blocked on deploy** — 当前 SSE 行为说明远程仍是 pre-`ee48ab2` dist  
- **9440-03 cardId：** 可勾 P2-8a 回归清单「有数据路径」；count=0 路径未在本轮触发
