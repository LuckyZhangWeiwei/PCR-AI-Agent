# Agent 修复验证问答清单（2026-06-27 续评审）

针对 `Desktop/FW_` 五个 DeepSeek-V4-Pro 会话暴露的问题（P1–P7），本文件汇总**验证用提问**、对应的 **dummy 等价数据**、**预期行为**与**实测结果**，供复现。

- 真实会话的 mask/卡型（P11C / N55Z / 9416）**不在** dummy xlsx 中，故验证时用 dummy 内**存在**的等价对象（P02G / N57U / 8003 / 8041）。
- dummy xlsx 数据结构与 Oracle 一致：`docs/delta-diff.xlsx`（YM）、`docs/JBStart.xlsx`（JB STAR）。
- 跑 LLM 实测需 dummy 开关 + SiliconFlow key（`deepseek-ai/DeepSeek-V4-Pro`）：
  ```
  YIELD_MONITOR_TRIGGERS_DUMMY=true
  INFCONTROL_LAYER_BINS_DUMMY=true
  ```

---

## P2 — 「哪个 lot BINnn 最多」按指定 bin 排序（最严重，原会答错数据）

**真实会话原问（N55Z）：** `n55z 中 哪个lot 测出的 bin35 最多`
> 旧行为：`buildMultiLotBinTable` 按**坏 die 总量**排序，把 bin35=968 的 DR41662.1J 排在 bin35=1402 的 DR42190.1X 之前 → 误导。

**dummy 验证提问（device WA03P02G / mask P02G，6 个 lot）：**
1. `P02G 这几个lot里 哪个lot 的 BIN4 最多，分别用什么卡测试的`
2. `统计 device WA03P02G 跨所有lot，按BIN4坏die颗数给各lot排名`

**预期：** 按 **BIN4 颗数**降序排 lot（非坏 die 总量），含探针卡列。
**实测（确定性渲染链路）：**
```
各 lot BIN4 坏 die 排行（device WA03P02G，坏 die 合计 154）
| # | Lot        | BIN4 坏 die 颗数 | 占比  |
| 1 | NF12560.1W | 66              | 42.9% |
| 2 | NF12609.1T | 47              | 30.5% |
| 3 | NF12575.1F | 41              | 26.6% |
```
新增 `buildBinFocusedLotRankingMarkdown`，接入 `tryRunDeterministicJbSummary` 与 fallback 两处，优先于 `buildMultiLotBinTable`。

---

## P5 — 卡型级「9416 卡的测试情况」给单 lot 深挖

**真实会话原问：** `9416 卡的测试情况`
> 旧行为：`query_jb_bins(probeCardType)` 只回最新单 lot DR44436.1W，确定性层出该单 lot 概况 → 代表不了整卡型。

**dummy 验证提问（卡型 8041）：**
- `8041 卡的测试情况`

**预期：** 跨 lot / 结合 YM 聚合作答，非单 lot 深挖。
**实测（live DeepSeek-V4-Pro）：** 输出三段综述 —— YM 侧（8041-01 报警 15 次、DUT21 集中、良率 14%–49%）、JB 侧（6 张卡跨 lot、良率 95.5%–99.8%）、综合结论。✅ 卡型范围正确。
新增 `isCardTypeLevelOverviewQuestion` bail 交回 LLM。

---

## P7 — 「这片 wafer 是否坏 die 聚集」被整 lot 警示表劫持

**真实会话原问（NF13322.1J 第 19 片上下文后）：** `这片wafer 是否有坏die 聚集性问题`
> 旧行为：重复输出整 lot 的 BIN 趋势警示表（"套话"，落入 default fallback）。JB lot 数据无 die 坐标，答不了单片空间聚集。

**dummy 验证提问（需先建立单片上下文，多轮）：**
1. `NF13322.1J 哪一片 BIN4 最多`（建立 slot 上下文）
2. `这片wafer 是否有坏die 聚集性问题`

**预期：** 不出整 lot 表；交回 LLM，引导走 `inf_cluster_detect(device, lot, slot)`（die 级坐标）。
**实测：** `isSingleWaferDieClusterQuestion` 单测覆盖检测；bail 已接入 `tryRunDeterministicJbSummary` 与 fallback；prompt 改为"上下文已知 device+lot+slot 时直接 `inf_cluster_detect`，勿先 `query_jb_bins`"。

---

## P4 — 「是否聚集到某个 DUT」误用 lot 维度聚合

**真实会话原问（承接 BIN35 在 9416-04 后）：** `是否聚集到 某个dut 上`
> 旧行为：调 `aggregate_jb_bins(groupBy:"bin,lot")`（lot 维度，答不了"哪个 DUT"）。

**dummy 验证提问：**
- `BIN4 是否聚集到某个 DUT 上`（承接前轮卡级结论）

**预期：** 路由到 `query_lot_dut_bin_agg(device, focusBin=<上一轮 BIN>)` 或 `query_inf_site_bin_by_dut`。
**修复：** prompt 路由表强化该追问的 DUT 维度路由，明确禁止用 `aggregate_jb_bins(bin,lot)` 代答。

---

## P1 / P6 — get_filter_values 返回空（真库现象）

> **2026-06-27 更新：** 根因已定位为 Oracle `TRIM(col)!=''` 空串陷阱（非「旧 dist / TYPE 裸值 / JOIN」）。本地探针修复后 `yield/full>0`。**完整验证见 [`HANDOFF_CURSOR_VERIFICATION_RESULTS_2026-06-27.md`](HANDOFF_CURSOR_VERIFICATION_RESULTS_2026-06-27.md)**。

**真实会话原问：**
- P1：`P11C 最近一个月的测试情况`（内部 `get_filter_values(domain:both, field:device, mask:P11C)` 返回空）
- P6：`9416 卡的测试情况`（内部 `get_filter_values(field:cardId/probeCard, filterBy:{probeCardType:9416})` 返回空）

**dummy 等价直查（证明逻辑正确）：**
| 调用 | 结果 |
|---|---|
| `get_filter_values{domain:"both", field:"device", mask:"N57U"}` | ✅ 2 个 device（WB10N57U / WL10N57U） |
| `get_filter_values{domain:"both", field:"device", mask:"P55A"}` | ✅ WA11P55A |
| `get_filter_values{domain:"jb", field:"cardId", filterBy:{probeCardType:"8003"}}` | ✅ 8003-01 / 8003-08 |
| `get_filter_values{domain:"yield", field:"probeCard", filterBy:{probeCardType:"8041"}}` | ✅ 8041-01 / 8041-07 |

**结论（已过时，见上链接）：** ~~dummy 下逻辑正常，真库空属部署/数据问题~~ → **已修正为 Oracle SQL 空串陷阱**；dummy 仍正常；远程 SSE 待 pm2 reload。

已加会话形状回归测试：`test/agentFilterValues.test.ts`（P1/P6 session shape）。

---

## 附带挖出的 dummy-parity 违规（P2 在 dummy 下不渲染的根因）

`aggregate_jb_bins` / `aggregate_yield_triggers`：
- **Oracle** 返回**展平**组 `{bin, lot, cardId, count}`（与真实会话日志一致）。
- **dummy** 原返回**嵌套** `{key, parts:{bin,lot}, count}`。

确定性渲染器（`buildMultiLotBinTable` / `buildBinFocusedLotRankingMarkdown` / `buildBinCardAggregateMarkdown`）均读 `g["bin"]`/`g["lot"]` → **dummy 下恒空、与生产分叉**。已在两个 agent handler 展平 dummy 组，加 dummy-parity 回归测试 `test/agentAggregateGuard.test.ts`。

---

## 验证汇总

- 全量 **394 测试，392 通过、2 跳过（既有）、0 失败**；`tsc --noEmit` 通过。
- 新增测试：`buildBinFocusedLotRankingMarkdown`（P2，3 例）、`isSingleWaferDieClusterQuestion`（P7）、`isCardTypeLevelOverviewQuestion`（P5）、P1/P6 session shape（3 例）、dummy-parity 展平（2 例）。
- live DeepSeek-V4-Pro + dummy 实测 P2 链路、P5 跨卡型综述通过。
