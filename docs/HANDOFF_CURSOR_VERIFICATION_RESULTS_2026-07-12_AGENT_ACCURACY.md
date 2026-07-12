# Cursor 真库验证结果（2026-07-12 · Agent 回答准确性 · 部署后终验）

> **执行者：** Cursor Agent  
> **代码：** `97906b2`（部署后）+ 待部署 `_trendRows` good-bin 补丁  
> **API：** `http://10.192.130.89:30008`  
> **日志：** [`scratchpad/realdb-post-deploy-2026-07-12.txt`](../scratchpad/realdb-post-deploy-2026-07-12.txt)、[`scratchpad/realdb-agent-accuracy-2026-07-12.txt`](../scratchpad/realdb-agent-accuracy-2026-07-12.txt)

---

## 0. 一眼结论（部署 `97906b2` 后）

| 项 | 结果 | 说明 |
|---|---|---|
| **REST P0-2/P0-3** | ✅ **3/3** | pass1 baseline > 0%，无全 0 DUT 退化 |
| **P0-4 good bin** | ✅ **功能通过** | 分轮 600s：第二问直答 BIN，无概况表劫持；**389s 走 LLM 慢路**（session cache 无 `rows`）→ 已修 `_trendRows` 兜底 |
| **P1-5 listing** | ✅ | 213 lot 列表，无 DUT 大表、标题无机台 |
| **P2-8a 9440-03** | ✅ | 有数据、非空转 |
| **Q5 探针卡组合路由** | ✅ | `aggregate_probe_card_tester_performance` 已调用 |
| **Q1 Oracle 工具路径** | ✅ | ~154s 完成，无报错 |
| **Q7 服务端原样贴表** | ⚠️ **部分** | 有排名 markdown 表，但标题为 LLM 改写（`### pass1 — 组合排名`），非 `#### pass1（sort1 常温）` + `探针卡+机台组合排名` 服务端字段直贴 |
| **P0-2 同屏 JB vs DUT %** | ⏭ **待补** | REST：DUT 75.2%； naive JB rows 估算不可信；需 Agent 同屏读 `yieldByPassIdMarkdown` vs DUT 表头 |

**总判：** Agent 准确性 8 项 **可关单**（P2-8a count=0 路径未触发）；探针卡 perf **Q5/Q1 通过**，Q7 建议再部署 `_trendRows` 补丁 + 确认 PRE_LLM 直出路径在主机 dist 生效。

---

## 1. REST — lot-underperforming-duts

| Lot | pass1 DUT baseline |
|---|---:|
| NF12595.1A | 75.2% |
| DR41803.1Y | 96.8% |
| NF12499.1N | 95.1% |

---

## 2. Agent SSE（部署后）

### P0-4 — good bin（分轮，600s/轮）

1. `DR41803.1Y 的测试情况` → 47s，`query_jb_bins`  
2. `DR41803.1Y 中的 good bin 是多少` → ✅ 含 BIN 编号、无概况表；389s（LLM 慢路，因 cache 无 `rows`）

**跟进：** `buildGoodBinValueMarkdown` / `buildGoodBinsByPassFromToolPayload` 已支持从 session cache `_trendRows` 读 PASSBIN → 第二问应 <5s 直出。

### P1-5 — `WA01N39W 的测试情况`

✅ 213 lot 列表，`device=WA01N39W`，无 DUT grid。

### Q5/Q7 — 探针卡组合

- 工具：`aggregate_probe_card_tester_performance` ✅  
- 输出：含 CardId/TesterId/平均良率排名表 ✅  
- verbatim 服务端四表字段：⚠️ LLM 重组表头（非 `comboRankingMarkdown` 原样）

---

## 3. 探针卡 perf 任务书进度（Q1–Q7）

| Q | 状态 |
|---|---|
| Q1 Oracle 跑通 | ✅ ~154s |
| Q2 手工核算 | ⏭ 未做 SQL 抽查 |
| Q3 行数保护 | ⏭ 未触发大 row 场景 |
| Q4 月度趋势/坏 bin | ⏭ 输出含表但未逐字段核对 |
| Q5 Agent 路由 | ✅ |
| Q6 中断 wafer 非负 | ⏭ |
| Q7 原样贴表 | ⚠️ 表在，非 verbatim |

---

## 4. 下一步

1. **部署** `_trendRows` good-bin 补丁 → 复跑 P0-4（期望 <10s）  
2. **UI 抽验** NF12595.1A 同屏 JB pass1 % vs DUT 表头 %  
3. **可选：** Q7 确认主机 `git log -1` = 含 `tryRunProbeCardPerfDirectRoute` 的 commit；若已是则查为何仍走 LLM 表头  
4. **可选：** 探针卡 Q2–Q4/Q6 SQL 抽查（见 [`HANDOFF_CURSOR_REALDB_PROBE_CARD_TESTER_PERFORMANCE_2026-07-11.md`](HANDOFF_CURSOR_REALDB_PROBE_CARD_TESTER_PERFORMANCE_2026-07-11.md)）

---

## 5. 给 Claude Code

- Agent 准确性清单：**8/8 代码 + 真库 7/8 场景绿**（P0-2 同屏 % 待 UI 一条）  
- 探针卡新工具：**真库 Oracle 路径首次跑通**；路由修复有效  
- 残余：`good bin` 直答应读 `_trendRows`（已修待 deploy）；Q7 verbatim 表头待确认 PRE_LLM dist
