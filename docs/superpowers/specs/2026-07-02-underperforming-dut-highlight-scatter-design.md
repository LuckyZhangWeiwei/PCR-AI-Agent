# 设计：低良率 DUT 高亮 + 散点图（2026-07-02）

**状态：** 设计已与用户确认，待写实现计划
**范围：** 展示层（Agent 回复渲染），**不碰**取数 / SQL / 响应形状
**依赖：** 昨天新增的 `lotUnderperformingDuts.ts`（`computeUnderperformingDutsForPass`）与 `lotUnderperformingDutsResolve.ts`（`runLotUnderperformingDuts`）

---

## 1. 目标

用户问 lot 相关问题时，让「低于 lot 平均 yield × 0.75 的 DUT」**一眼可辨**：

1. **表格高亮**：DUT 良率表中，低于阈值（`lot 整体良率 × thresholdRatio`，默认 0.75）的 DUT 行用 🔴 emoji + 加粗醒目标出。
2. **散点图**：新增每 pass 一张散点图，直观展示各 DUT 相对 lot 平均的高/低分布。

**关键前提：** 所需数据（每 pass 的 `allDuts`、`baseline.yieldPct`、`thresholdPct`、`underperformingDuts`）昨天的 `computeUnderperformingDutsForPass` 已全部算好，**本设计只做展示层加工，不新增取数逻辑**。

---

## 2. 口径（沿用已确认产品口径，不改）

- **基准 baseline** = lot 整体良率 = 该 pass 全部 DUT 的 `Σgood / Σtotal`（`baselineMethod: "lotOverall"`）。
- **阈值** = `baseline × thresholdRatio`（默认 0.75）。
- **低良率 DUT** = `DUT 良率 < 阈值`。
- **pass 维度**：默认 passId 1/3/5 各一组，各自独立的平均线与阈值线。

---

## 3. 组件设计

### 3.1 共享纯函数模块 `src/lib/agent/agentUnderperformingDutView.ts`（新）

纯函数，输入 `PassUnderperformingDutsResult[]`（来自 resolve 响应的 `passes`），无副作用、可独立单测。

**`formatAllDutsHighlightMarkdown(passResults, lot, device): string`**
- 每个 pass 一个 `### {sortLabel} — lot 整体 {yieldPct}% · 阈值 {thresholdPct}%` 小标题。
- 表列 `| DUT | 良率% | good/total | 状态 |`，列出**该 pass 全部 DUT**（`allDuts`），按良率升序。
- `yieldPct < thresholdPct` 的行：DUT 单元格前缀 🔴、四列文字加粗，状态列写「低于阈值」；达标行状态列留空或 ✅。
- `baseline` 为 null（该 pass 无数据）时跳过该 pass。
- 全部 pass 均无 DUT → 返回空串（调用方据此不追加）。
- **非破坏**：现有 `formatUnderperformingDutsMarkdown`（只列低于阈值的）与 REST 响应字段 `underperformingDutsMarkdown` **保持不变**；本函数是**新增**、独立的全 DUT 高亮版，仅 Agent 展示层使用。REST / 报表面板契约零改动。

**`buildUnderperformingDutScatterOptions(passResults): Array<{ passId: number; sortLabel: string; option: EChartsOption }>`**
- 每个有 `baseline` 的 pass 生成一个散点 option。
- X 轴：DUT 编号（category，`DUT{n}`）；Y 轴：良率%（0–100）。
- 每个点按良率分三色带：
  - 🟢 绿：`yieldPct ≥ baseline.yieldPct`（高于/等于平均）
  - 🟡 黄：`thresholdPct ≤ yieldPct < baseline.yieldPct`（低于平均但达标）
  - 🔴 红：`yieldPct < thresholdPct`（低于阈值）
- 两条 `markLine`：lot 平均线（`baseline.yieldPct`）、75% 阈值线（`thresholdPct`），带标签。
- 复用 `theme/chartTheme` 暗色调（与其它 agent 图一致）。
- 单 DUT / 空 → 返回该 pass 空跳过（散点至少 ≥1 点才 emit）。

### 3.2 A 路：PRE_LLM 确定性直连路由

**新谓词 `isLotUnderperformingDutQuestion(text)`**（放 `agentJbDeterministicReply.ts` 或新 route 文件）：
- 命中「低良率 DUT / 哪些 DUT 偏低 / DUT 良率(低|差) / 哪些探针(偏低|差) / 低于平均的 DUT / 哪些 DUT 低于(平均|阈值)」等表述。
- 且能从句 / history 解析出 **lot**（`runLotUnderperformingDuts` 必需 lot；device 服务端反查）。

**新直连路由 `tryRunUnderperformingDutDirectRoute(sessionId, userQuestion, agentConfig, emit)`**（`agentLoop.ts`，加入 `PRE_LLM_DIRECT_ROUTES`）：
1. 谓词不命中 → `return false`。
2. `emit status`「正在分析各 DUT 良率（含 INF 取数，稍慢）…」。
3. `runLotUnderperformingDuts({ lot, device? })`（best-effort try/catch，失败 `return false` 落回 LLM，不 dead-end）。
4. `emit tool_start/tool_result`（`query_lot_underperforming_duts`，与既有工具展示一致）。
5. `formatAllDutsHighlightMarkdown` → `emitTextInChunks` 高亮表；`appendMessages` assistant。
6. `buildUnderperformingDutScatterOptions` → 逐 pass `emit({ type: "chart", option })`。
7. `emit done`，`return true`。

**LLM 工具路径也顺带出图**：在 agentLoop LLM 工具执行段（~3790 行），`tc.name === "query_lot_underperforming_duts"` 时，解析 payload 调 `tryEmitUnderperformingDutScatter(payload, emit)`（复用 §3.1 helper），保证 LLM 自主调用时也有散点图。agent 工具处理器（`agentToolHandlers.ts`）构造的**内部工具结果串**可前置全 DUT 高亮表（属 agent 内部串，非 REST 响应字段，不违反 §6 非破坏）。

### 3.3 B 路：JB lot 概况的「🔍 警示 / 规律识别」节

在确定性 JB 汇总构建警示节时（`formatAlertsAndPatternsSection` 或其调用处，需 async 化）：
1. 从 JB payload 取 `lot` + `device`（已有，省一次反查）。
2. `emit status`「正在补充 DUT 良率分析（较慢）…」。
3. `runLotUnderperformingDuts({ lot, device })` best-effort（try/catch，失败静默跳过，**不阻塞主概况**）。
4. 有结果 → 追加 `formatAllDutsHighlightMarkdown` 高亮表到警示节；逐 pass emit 散点。
5. **用户已确认**：接受概况变慢，前置状态提示即可。

---

## 4. 数据流

```
A 路（直连）:
  用户「DR43782.1A 哪些 DUT 偏低」
   → tryRunUnderperformingDutDirectRoute
   → runLotUnderperformingDuts (INF/Perl)  → passes[]
   → formatAllDutsHighlightMarkdown  → emit text（🔴 高亮表）
   → buildUnderperformingDutScatterOptions → emit chart ×N（每 pass 一张）

B 路（JB 概况顺带）:
  用户「DR43782.1A 概况」
   → 确定性 JB 汇总（query_jb_bins）
   → 警示节构建时：runLotUnderperformingDuts(lot, device) best-effort
   → 追加高亮表 + emit 散点
```

---

## 5. 测试

- **纯函数单测** `test/agentUnderperformingDutView.test.ts`（新）：
  - 高亮表：阈值边界（`yieldPct` 恰 = 阈值 → 不高亮；< 阈值 → 🔴+加粗）；全达标（无 🔴）；空 DUT / baseline=null 跳过。
  - 散点 option：三色带分档正确（点颜色 == 所在带）；两条 markLine 值 == baseline/threshold；单点 pass 仍出图；空跳过。
- **谓词单测**：`isLotUnderperformingDutQuestion` 命中 / 不命中（避免误伤「lot 概况」「哪个卡」等）。
- **Dummy 双路径**：`INFCONTROL_LAYER_BINS_DUMMY=true` 下 A 路直连 / B 路概况均出高亮表 + 散点（沿用 `runLotUnderperformingDuts` 既有 Dummy）。
- 全量 `npm test` 零回退；`typecheck` + `build`。

---

## 6. 开放项 / 风险

- **REST 契约零改动**：既有 `underperformingDutsMarkdown` 与报表面板 `LotUnderperformingDutsPanel.tsx` **不动**；全 DUT 高亮表是 Agent 展示层新增函数，不经 REST 字段（见 §3.1 非破坏说明）。
- **B 路真库延迟**：INF/Perl 调用慢；已前置状态提示 + best-effort try/catch。真库耗时需部署后由 Cursor 观测（沙箱无法量）。
- **红线**：不翻开关、不碰 SQL/Dummy/响应字段语义、不降现有回复质量（A 路失败落回 LLM，B 路失败静默跳过）。

---

## 7. 文件清单（预估）

| 文件 | 改动 |
|---|---|
| `src/lib/agent/agentUnderperformingDutView.ts` | **新**：高亮表 + 散点 option 纯函数 |
| `src/lib/agent/agentLoop.ts` | 新 `tryRunUnderperformingDutDirectRoute` + 注册 PRE_LLM；LLM 工具路径 emit 散点 |
| `src/lib/agent/agentJbDeterministicReply.ts` | 新谓词 `isLotUnderperformingDutQuestion`；B 路警示节注入（async 化） |
| `src/lib/agent/agentToolHandlers.ts` | 内部工具结果串前置全 DUT 高亮表（不动 REST 字段） |
| `src/lib/lotUnderperformingDuts.ts` | 保持不变（`formatUnderperformingDutsMarkdown` 与 REST 字段原样）；新高亮函数放 §3.1 新模块 |
| `test/agentUnderperformingDutView.test.ts` | **新** 单测 |

真库派发/延迟复验交 Cursor（沙箱无真库/真 INF）。
