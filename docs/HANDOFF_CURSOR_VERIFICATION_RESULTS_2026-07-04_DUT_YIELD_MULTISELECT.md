# Cursor 真库验证结果交接（2026-07-04 · DUT 低良率口径 + JB Star 跨 LOT 多选）

> **执行者：** Cursor Agent  
> **读者：** Claude Code  
> **任务来源：** [`HANDOFF_CURSOR_REALDB_DUT_YIELD_AND_MULTISELECT_2026-07-04.md`](HANDOFF_CURSOR_REALDB_DUT_YIELD_AND_MULTISELECT_2026-07-04.md)  
> **背景诊断：** [`HANDOFF_UNDERPERFORMING_DUT_ZERO_YIELD_2026-07-04.md`](HANDOFF_UNDERPERFORMING_DUT_ZERO_YIELD_2026-07-04.md)  
> **分支：** `feat/jb-route-resolver`，验证时 HEAD `0f13cee`（含 `4643f77` JB Star 多选放宽）  
> **API：** `http://10.192.130.89:30008`（真 Oracle + INF Perl）  
> **原始日志：** [`scratchpad/realdb-dut-yield-multiselect-2026-07-04.txt`](../scratchpad/realdb-dut-yield-multiselect-2026-07-04.txt)  
> **可复跑脚本：** `pcr-ai-api/scripts/verify-realdb-dut-yield-multiselect.mjs`

---

## 0. 给 Claude Code 的一眼结论

| # | 问题 | 真库结论 | 是否要改代码 |
|---|---|---|---|
| **A1** | `NF12499.1N` PASS_ID=1 是什么层？ | **完整 TEST 层**；良品 bin **不是 BIN1**，主良品 **BIN55**（JB `PASSBIN=1-55`） | 否（口径理解） |
| **A2** | INF 启发式 vs JB `goodBinIndicesForJbRow` | 多 lot 不一致；仅 `{1}` 时 slot17 pass1 **灾难性全 0** | **是** — 取数应优先 JB PASSBIN |
| **A3** | 默认 `passId=[1,3,5]` 是否窄化？ | 抽样 10 lot：**0%** 空 baseline；pass5 偶缺失 | **否** — 维持默认，无数据 pass 跳过即可 |
| **B1** | 同 Device + 同卡型 + 不同 LOT 是否存在？ | **存在**：`WA12N36S` / `6052` / `NF13473.1X` + `NF13507.1K` | — |
| **B2** | 跨 LOT 多选 + DUT×Bin 数据 | API：**2 次** `site-bin-bylot`、infPath 各自正确；BIN 数字抽查 **吻合** | **否**（API 层） |
| **B3** | 同 LOT 不同 slot 回归 | **正常**（API） | **否** |
| **B4** | 拒绝场景 UI 提示 | 逻辑正确；**浏览器 tag/提示未测** | 待定（仅 UI 补验） |
| **Agent** | Flash 调低良率工具 | 明确问 DUT 75% 阈值仍 **未调** `query_lot_underperforming_duts` | **是** — 路由/工具选择（独立 issue） |

> ✅ **Cursor 已修（2026-07-04 晚）：** [`HANDOFF_CURSOR_FIX_DUT_GOODBIN_AND_AGENT_ROUTE_2026-07-04.md`](HANDOFF_CURSOR_FIX_DUT_GOODBIN_AND_AGENT_ROUTE_2026-07-04.md) — P0 JB PASSBIN 取数 + P1 A 路谓词放宽。**部署后请 curl + Agent 复验。**

**总判：**

- **Part A：** 展示层退化守卫（`agentUnderperformingDutView.ts`）已够用；**取数层**应改 — `lotUnderperformingDuts.ts` / `goodBinNumbersFromSiteBinPasses` 路径在有 JB 行时用 `goodBinIndicesForJbRow`（**dummy-parity 必做**）。
- **Part B：** commit `4643f77` **API 层无 bug**；`infDutSelection.ts` / `InfcontrolReport.tsx` **无需因真库问题再改**；UI tag/拒绝文案建议用户或下轮浏览器点选确认。

---

## 1. 环境

| 项 | 值 |
|---|---|
| 验证时间 | 2026-07-04 ~09:01 UTC（17:01 +08） |
| Health | `{"status":"ok","agentEnabled":true,"agentJbCacheVersion":6}` |
| Agent 模型（补测） | `deepseek-ai/DeepSeek-V4-Flash`（请求体 `agentConfig.model`） |
| 慢接口注意 | `lot-underperforming-duts` 全 lot 常 **90～130s**；curl 请 `-m 180` 以上 |

---

## 2. Part A — DUT 低良率阈值口径

### A1 — `NF12499.1N` PASS_ID=1

#### Lot 级 REST

```bash
curl -s -m 180 "http://10.192.130.89:30008/api/v4/inf-analysis/lot-underperforming-duts?lot=NF12499.1N"
curl -s -m 180 "http://10.192.130.89:30008/api/v4/inf-analysis/lot-underperforming-duts?lot=NF12499.1N&passId=1"
curl -s -m 180 "http://10.192.130.89:30008/api/v4/inf-analysis/lot-underperforming-duts?lot=NF12499.1N&passId=3"
```

| 字段 | 值 |
|---|---|
| device | `WA03P02G`（JB 反查） |
| probeCardType | `8041` |
| waferCount | **25**（slots 1–25；非 handoff 早期说的「仅 slot17 单片 lot」） |
| pass1 | baseline **95.1%**，threshold 71.32%，24 DUT，**0** underperformer |
| pass3 | baseline **99.69%**，**0** underperformer |
| pass5 | **无 pass 块**（缺失，非 baseline=0） |

#### 单片 INF — slot17（handoff 原关注 `r_1-17`）

```bash
curl -s "http://10.192.130.89:30008/api/v4/inf-analysis/site-bin-bylot?infPath=%2Fdata%2FINF%2FWA03P02G%2FNF12499.1N%2Fr_1-17&passId=1"
curl -s "http://10.192.130.89:30008/api/v4/inf-analysis/site-bin-bylot?infPath=%2Fdata%2FINF%2FWA03P02G%2FNF12499.1N%2Fr_1-17&passId=3"
```

| pass | 关键 bin 分布 | 含义 |
|---|---|---|
| pass1 | **bin55 die=2856**（24 DUT）；bin4/6/7/8 等为坏 bin；**BIN1 die=0** | 该层良品落在 **BIN55**，不是 BIN1 |
| pass3 | bin1 die=2855 | 与 JB 逐片 pass3 **99.79%** 一致 |

#### JB 行（slot17 pass1）

```bash
curl -s "http://10.192.130.89:30008/api/v4/infcontrol-layer-bins/v3?lot=NF12499.1N&device=WA03P02G&limit=200"
# 筛选 SLOT=17 PASSID=1 PASSTYPE=TEST
```

| 字段 | 值 |
|---|---|
| PASSTYPE | **TEST**（完整测试层，非 bump/预测层） |
| PASSBIN | **`1-55`** |
| CARDID | `8041-01` |

#### 良品 bin 复算（slot17 pass1，Cursor 本地对 INF JSON 复算）

| goodBins 集合 | lotOverall | DUT good=0 数 |
|---|---|---|
| `{1}` only | **0%** | **24/24** ← 复现「全 0 / 阈值 0% 全部达标」根因 |
| `{1, 55}` | **96.13%** | 0/24 ← 与 JB 逐片表 slot17 pass1 **96.13%** 一致 |

**A1 结论（给 Claude）：**

1. PASS 映射无错位；PASS_ID=1 是真实 TEST 层。  
2. 「全 0」不是 INF 无数据，而是 **良品 bin 口径错误**（硬编码/退化后只剩 BIN1，而 pass1 良品在 BIN55）。  
3. handoff 里「仅 1 片 slot17」已过时 — 真库该 lot 现 **25 片**；lot 级启发式在多片下能识别 bin55，故 REST pass1 baseline 已为 95.1%。

---

### A2 — 两种良品 bin 口径对比（≥3 lot）

实现位置：

- 现口径：`agentDutConcentration.ts` → `goodBinNumbersFromSiteBinPasses`（avg die/DUT **> 100**）+ `lotUnderperformingDuts.ts` 硬编码 `BIN1`
- 备选：`jbYieldCalc.ts` → `goodBinIndicesForJbRow`（BIN1 + PASSBIN 段 + `isGoodBin`）

| lot | INF 启发式（pass1） | JB `goodBinIndicesForJbRow` | 差异 |
|---|---|---|---|
| NF12499.1N | `[1, 55]`（lot 聚合 INF） | PASSBIN `1-55` → `[1, 55]` | lot 级一致；**单片仅 `{1}` 时崩溃** |
| NF13537.1F | `[1, 250]` | `[1, 55, 250]` | JB **多 bin55** |
| TR24421.1H | `[1]` | `[1]` | 一致 |

**A2 建议（给 Claude — 请产品确认后实施）：**

- **改取数：** 在 `lotUnderperformingDutsResolve.ts` / `computeUnderperformingDutsForPass` 路径，对每个 pass **优先**从 JB 同 lot+pass 行取 `goodBinIndicesForJbRow`；无 JB 行时再 fallback INF 启发式 + BIN1。  
- **必做：** Oracle + Dummy 双路径同步（`dummy-parity`）。  
- **不必改：** 展示层 0% 退化守卫、多列表格（已在 `agentUnderperformingDutView.ts`）。

---

### A3 — 默认 passId 范围

抽样 **10 lot**、**11** 次 pass 结果：空 baseline / 无 DUT 比例 **0%（0/11）**。

- `NF12499.1N` pass5：**缺失**（响应无 pass5 块），不是「baseline=0%」  
- 其余 pass1/pass3 均有正常 baseline

**A3 建议：** **维持** `passId=[1,3,5]`；文档/API meta 说明「某 pass 无 JB+INF 数据则省略该 pass 块」即可，**不建议**默认窄化为「仅有 JB 良率的 pass」。

---

## 3. Part B — JB Star 跨 LOT 多选（`4643f77`）

改动文件：`pcr-ai-report/src/utils/infDutSelection.ts`（`canJoinDutSelectionGroup`）、`InfcontrolReport.tsx`。

### B1 — 真实跨 LOT 样本

从 `GET /api/v4/infcontrol-layer-bins/v3?limit=300` 分组 `(device, PROBECARDTYPE)` 得到：

| 字段 | LOT A | LOT B |
|---|---|---|
| device | `WA12N36S` | `WA12N36S` |
| probeCardType | `6052` | `6052` |
| lot | `NF13473.1X` | `NF13507.1K` |
| slot | 20 | 15 |
| CARDID | `6052-04` | `6052-05` |

### B2 — API 层（等同 `InfDutDistPanel` 双 wafer 请求）

```bash
curl -s "http://10.192.130.89:30008/api/v4/inf-analysis/site-bin-bylot?infPath=%2Fdata%2FINF%2FWA12N36S%2FNF13473.1X%2Fr_1-20&passId=1"
curl -s "http://10.192.130.89:30008/api/v4/inf-analysis/site-bin-bylot?infPath=%2Fdata%2FINF%2FWA12N36S%2FNF13507.1K%2Fr_1-15&passId=1"
```

| 检查项 | 结果 |
|---|---|
| `canJoinDutSelectionGroup` | 同 device + 同 `6052` → **应允许** ✅ |
| 请求次数 | **2**（各 wafer 一次）✅ |
| infPath | 分别含 **NF13473.1X/r_1-20** 与 **NF13507.1K/r_1-15** ✅ |
| HTTP | 均 **200**，各 1 pass ✅ |
| DUT×Bin 抽查 | BIN2 DUT0：waferA=**4**，waferB=**1** → 合并应 **5** ✅ |
| `selectionSummary`（代码预期） | `2 片 · 2 个 LOT · Slot 20, 15` — **浏览器未实测 tag** |

### B3 — 同 LOT 不同 slot 回归

`NF13473.1X` slot **20** + slot **15** 各调 `site-bin-bylot` → 均 200，totalDie 7052。**API 正常** ✅

### B4 — 拒绝场景

- 代码：`canJoinDutSelectionGroup` 对不同 device / 不同 LOT 且不同 probeCardType → **false** ✅  
- 文案（`InfcontrolReport`）：「仅可选同一 Device + LOT，或同一 Device + 相同探针卡类型 的行」— **浏览器未点选验证**

**Part B 结论：** 无 API/infPath 合并 bug；**无需**因真库问题回改 `infDutSelection.ts`。若用户报 UI 问题，再要 Network 截图。

---

## 4. Agent 补测（DeepSeek-V4-Flash · 真库）

| 用户问句 | 实际工具 | 问题 |
|---|---|---|
| `NF12499.1N 各 DUT 良率 / 75% 阈值` | 仅 `query_jb_bins` | 未调 `query_lot_underperforming_duts`；回复「无 INF DUT map」 |
| 明确要求「请用 query_lot_underperforming_duts」 | 仍 `query_jb_bins` / lot_listing | **工具未执行** |

REST 同 lot pass3：`baseline 99.69%`，`underperformingDuts: []` — API 正常。

**给 Claude：** 独立 issue — `agentPrompt.ts` / `detectPendingQuery` / 路由应把「DUT 良率阈值 / 低良率 DUT」导向 `query_lot_underperforming_duts`；与 Part A 取数口径修改可并行但不同 PR。

---

## 5. 建议 Claude Code 的下一步（优先级）

| 优先级 | 动作 | 文件 hint |
|---|---|---|
| ~~**P0**~~ | ~~取数良品 bin：JB PASSBIN 优先~~ | ✅ Cursor 已修 — 见 [`HANDOFF_CURSOR_FIX_DUT_GOODBIN_AND_AGENT_ROUTE_2026-07-04.md`](HANDOFF_CURSOR_FIX_DUT_GOODBIN_AND_AGENT_ROUTE_2026-07-04.md) |
| ~~**P1**~~ | ~~Agent 路由：DUT 75% 阈值 → `query_lot_underperforming_duts`~~ | ✅ Cursor 已修 — 同上 |
| **P2** | 文档：pass5 缺失 vs baseline=0；NF12499.1N 25 片 | `HANDOFF_LOT_UNDERPERFORMING_DUTS_API.md` |
| **P3** | Part B UI tag/拒绝 — 可选浏览器补验 | 无代码改动 unless 用户报 bug |
| **不做** | 窄化默认 passId | A3 真库不支持 |
| **不做** | 回滚 JB Star 跨 LOT 多选 | B2 API 已 PASS |

---

## 6. 复验命令

```bash
cd pcr-ai-api
node scripts/verify-realdb-dut-yield-multiselect.mjs
# 可选：PCR_API_BASE=http://10.192.130.89:30008 VERIFY_FETCH_MS=180000
```

---

## 7. 与前置 handoff 的关系

| 文档 | 状态 |
|---|---|
| [`HANDOFF_CURSOR_REALDB_DUT_YIELD_AND_MULTISELECT_2026-07-04.md`](HANDOFF_CURSOR_REALDB_DUT_YIELD_AND_MULTISELECT_2026-07-04.md) | ✅ Cursor 已完成 — 见本文 |
| [`HANDOFF_UNDERPERFORMING_DUT_ZERO_YIELD_2026-07-04.md`](HANDOFF_UNDERPERFORMING_DUT_ZERO_YIELD_2026-07-04.md) | Q1/Q3 展示已修；Q2 根因 **PASSBIN/BIN55** — 见本文 §2 A1/A2 |
