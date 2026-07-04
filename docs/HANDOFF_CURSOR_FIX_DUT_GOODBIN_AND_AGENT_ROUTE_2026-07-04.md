# Cursor 修复交接（2026-07-04 · 给 Claude Code）

> **执行者：** Cursor Agent  
> **读者：** Claude Code  
> **前置验证：** [`HANDOFF_CURSOR_VERIFICATION_RESULTS_2026-07-04_DUT_YIELD_MULTISELECT.md`](HANDOFF_CURSOR_VERIFICATION_RESULTS_2026-07-04_DUT_YIELD_MULTISELECT.md)  
> **分支：** `feat/jb-route-resolver`  
> **范围：** 真库验证 **P0（良品 bin 取数）** + **P1（Agent A 路直连谓词）**；**Part B 跨 LOT 多选未改**（API 已 PASS）

---

## 0. 一眼结论

| 项 | 状态 | 说明 |
|---|---|---|
| **P0** JB PASSBIN 优先取数 | ✅ 已修 | `runLotUnderperformingDuts` 从 JB TEST 行合并 `goodBinIndicesForJbRow`，按 pass 传入计算 |
| **P1** Agent 直连 `query_lot_underperforming_duts` | ✅ 已修 | 放宽 `isLotUnderperformingDutQuestion`，NF12499 类问句命中 A 路；复现验证路由层已无 bug（见 §2b） |
| **P1b** LLM 自主选工具兜底（Claude Code 追加） | ✅ 已改 prompt，⏭ **待真库验证** | `agentPrompt.ts` 补触发短语 + 禁止措辞，见 §2b；无法在沙箱验证 LLM 实际行为 |
| **Part B** JB Star 跨 LOT 多选 | ⏭ 未动 | 真库 API 无 bug，无需回改 `infDutSelection.ts` |
| **部署后复验** | ⏭ 待做 | `npm run build && pm2 reload` 后 curl + Agent 各测一次（含 §2b 新增的口语化问法） |

---

## 1. P0 — 低良率 DUT 良品 bin（JB PASSBIN 优先）

### 问题（真库）

- `NF12499.1N` slot17 pass1：INF 良品在 **BIN55**，BIN1 die=0；仅 `{BIN1}` 时 baseline **0%**、24/24 DUT `good=0`。
- JB 行 `PASSBIN=1-55`，`PASSTYPE=TEST`。
- 原 `lotUnderperformingDuts.ts` 只用 INF 启发式（avg die/DUT > 100）+ 硬编码 `BIN1`。

### 改法

| 文件 | 变更 |
|---|---|
| `pcr-ai-api/src/lib/lotUnderperformingDuts.ts` | 新增 `goodBinsByPassId?: Map<number, Set<number>>`；`resolveGoodBinsForPass()` — JB 有则用之，否则回退 INF 启发式 + BIN1 |
| `pcr-ai-api/src/lib/lotUnderperformingDutsResolve.ts` | 新增 `buildGoodBinsByPassFromJbRows()`、`fetchJbTestRowsForLot()`（Dummy + Oracle `PASSID/PASSBIN`）；`runLotUnderperformingDuts` 在 INF 取数后合并 JB 良品 bin 再 `computeUnderperformingDutsForPasses` |

### Oracle 路径

```sql
SELECT lb.PASSID, lb.PASSBIN
FROM INFCONTROL t1
INNER JOIN INFLAYERBINLIST lb ON t1.KEYNUMBER = lb.KEYNUMBER
WHERE … device + lot + PASSTYPE='TEST' + PASSID IN (…)
```

各行经 `goodBinIndicesForJbRow(row)` 合并（含 `PASSBIN` 段 + BIN1 + Dummy 行上 `bins[].isGoodBin`）。

### Dummy-parity

- Dummy：`jbTestRowsForLot()` 全字段行（与 v3 列表样本一致）。
- Oracle：至少 `PASSBIN`；与 JB 报表 `goodBinIndicesForJbRow` 同源。

### 测试

- `test/lotUnderperformingDuts.test.ts`：`goodBinsByPassId` BIN55 场景；`buildGoodBinsByPassFromJbRows` PASSBIN 合并。
- 既有 `goodBins: Set` 显式覆盖测试 **不变**。

### 部署后 curl 复验

```bash
curl -s -m 180 "http://<API>:30008/api/v4/inf-analysis/lot-underperforming-duts?lot=NF12499.1N&passId=1"
# pass1 baseline 应 >0（多片 lot 约 95%+），不应再出现整 pass 0%（除非真无良品 die）
```

---

## 2. P1 — Agent A 路直连（低良率 DUT 问句）

### 问题（真库 + Flash）

问句「NF12499.1N 各 DUT 良率 / 低于 lot 整体 75% 阈值」**未命中** `canRunUnderperformingDutDirectRoute`：

- 旧正则 `低于\s*(平均|阈值|均值)` 要求「低于」后**紧接**「阈值」，无法匹配「低于 lot 整体 75% 阈值」。
- 「各 DUT 良率怎么样」无「低」字，旧规则也不命中。
- 落回 LLM 后只调 `query_jb_bins`，回复「无 INF DUT map」。

### 改法

**文件：** `pcr-ai-api/src/lib/agent/agentUnderperformingDutRoute.ts` — `isLotUnderperformingDutQuestion()` 增补：

- `各 DUT 良率` / `DUT 良率`
- `低于…{0,48}…(平均|阈值|均值)`（允许中间插入 lot 整体 75% 等）
- `75%` / `0.75` + 良率/阈值
- 点名 `query_lot_underperforming_duts`

**未改：** `agentLoop.ts` 直连流程、`agentPrompt.ts` LLM 选工具逻辑（A 路命中后无需 LLM）。

### 测试

- `test/agentUnderperformingDutRoute.test.ts`：NF12499.1N 完整问句 + `canRunUnderperformingDutDirectRoute`。

### 部署后 Agent 复验

```
NF12499.1N 各 DUT 良率怎么样？有没有低于 lot 整体 75% 阈值的 DUT？
```

期望：`tool_start` = `query_lot_underperforming_duts`（A 路直连），**非**仅 `query_jb_bins`；正文含「各 DUT 良率」高亮表。模型：`deepseek-ai/DeepSeek-V4-Flash`。

---

## 2b. P1 追加修复（2026-07-04，Claude Code）— LLM 自主选工具时的兜底

### 根因排查

用 `tsx` 直接复现 Cursor 报告失败的两条问句，验证 P1 正则修复后 **路由层已无 bug**：
- `"NF12499.1N 各 DUT 良率怎么样？有没有低于 lot 整体 75% 阈值的 DUT？"` → `canRunUnderperformingDutDirectRoute` = **true**
- 第二轮 `"请用 query_lot_underperforming_duts"`（lot 从 history 推断）→ 同样 **true**

即 P1 已解决「路由层」问题；Cursor 报告的真实失败复现于 **P1 修复之前** 的 HEAD（`0f13cee`），尚未部署后复验。

但排查发现**另一个独立缺口**：当用户问法不落入直连正则（比如更口语化、或系统处于工具结果之后的总结轮——该阶段 `agentLoop.ts` 按设计**禁止**再调数据工具，只能靠第一轮工具选对），LLM 需要**自主**从 `tool_choice:"auto"` 里选工具。对比 `agentPrompt.ts` 里相邻的 `query_lot_dut_bin_agg` 段落（有「适用于「...」「...」类问题」的显式触发短语），`query_lot_underperforming_duts` 段落**只写了业务含义，没写触发短语**；且全文反复强调「先调 `query_jb_bins(lot)`」作为几乎所有 lot 级问题的前置动作，容易让模型养成「先 query_jb_bins，拿到点良率数据就当结论」的习惯，与 Cursor 实测「仅调 query_jb_bins，回复无 INF DUT map」的现象吻合。

### 改法（仅改 prompt，不改路由代码）

**文件：** `pcr-ai-api/src/lib/agent/agentPrompt.ts`

1. 「两种 DUT 必须区分」表格新增一行：`各 DUT 良率是否偏低 / 是否有 DUT 低于阈值` → 直接 `query_lot_underperforming_duts(lot)`，不要先调 `query_jb_bins` 再猜。
2. 「Lot 低良率 DUT」段落补：
   - **适用于：** 显式触发短语列表（各 DUT 良率怎么样 / 哪些 DUT 良率明显偏低 / 有没有低于阈值的 DUT），并声明「没出现"低"字也应调用」。
   - **禁止：** 仅调 `query_jb_bins` 拿到 wafer/pass 级良率就回复「无 INF DUT map」/「数据不支持」——直接点名 Cursor 实测到的失败措辞，禁止复现。

### 验证

- `npm run typecheck && npm run build && npm test` — 483 tests / 479 pass / 0 fail / 4 skip（与改动前一致，无回归）。
- **无法在本沙箱验证**：prompt 措辞对 LLM 实际选工具行为的影响需要真实模型调用。**请 Cursor 部署后用真实 Agent 复验**（沿用上面 §2「部署后 Agent 复验」的问句 + 追加一条口语化问法，例如「这个 lot 各个 DUT 良率怎么样」不带「阈值/75%」字样），确认：
  1. 第一轮直接 `tool_start = query_lot_underperforming_duts`（大概率仍走 A 路直连，因为问法多半仍命中正则）；
  2. 若某问法未命中直连正则、落到 LLM 自主选工具，也应选对 `query_lot_underperforming_duts` 而非仅 `query_jb_bins`。

---

## 3. 给 Claude Code 的后续（可选）

| 优先级 | 项 | 说明 |
|---|---|---|
| ~~低~~ | ~~LLM 路径仍误选工具~~ | ✅ Claude Code 已改 prompt（见 §2b），**待 Cursor 真库+真模型复验** |
| 低 | Part B UI | tag / 拒绝提示浏览器补验（见验证结果 doc §3 B4） |
| 文档 | `HANDOFF_LOT_UNDERPERFORMING_DUTS_API.md` | 可补一句：良品 bin 来自 JB PASSBIN 优先 |
| 无 | Part B 代码 | 不必改 |

---

## 4. 命令

```bash
cd pcr-ai-api
npm run typecheck
npx tsx --test test/lotUnderperformingDuts.test.ts test/agentUnderperformingDutRoute.test.ts test/agentUnderperformingDutView.test.ts
npm run build
# 生产：pm2 reload <api>
```

---

## 5. 关联文档

| 文档 | 关系 |
|---|---|
| [`HANDOFF_CURSOR_VERIFICATION_RESULTS_2026-07-04_DUT_YIELD_MULTISELECT.md`](HANDOFF_CURSOR_VERIFICATION_RESULTS_2026-07-04_DUT_YIELD_MULTISELECT.md) | 真库问题来源；§5 P0/P1 **已由本文修复** |
| [`HANDOFF_UNDERPERFORMING_DUT_ZERO_YIELD_2026-07-04.md`](HANDOFF_UNDERPERFORMING_DUT_ZERO_YIELD_2026-07-04.md) | 展示层已修；取数层 **本文** |
