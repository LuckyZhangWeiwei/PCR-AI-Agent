# Claude → Cursor 交接：低良率 DUT 高亮 + 散点图（2026-07-02）

> **执行者：** Claude Code（沙箱：可改代码 + 跑单测/dummy，**无真库 / 真 INF / 真 LLM**）
> **分支：** `feat/jb-route-resolver`（未 merge main）
> **依赖：** 昨天 `89c77b3` 的 `computeUnderperformingDutsForPass`（已算好 `passes[].allDuts` / `baseline` / `underperformingDuts`）
> **本次：** 展示层，问 lot 时把低良率 DUT 醒目标出 + 散点图。spec/plan 见 `docs/superpowers/{specs,plans}/2026-07-02-underperforming-dut-highlight-scatter*`

---

## 0. 一眼结论

| 项 | 内容 | 需 Cursor 真库/真 INF 复验 |
|---|---|---|
| **高亮表** | 各 pass 全部 DUT 良率表；低于 `lot 整体良率 × thresholdRatio`（默认 0.75，**严格小于**）的 DUT 行 🔴+加粗 | 真 INF 取数下高亮行正确、阈值/平均数字与表头一致 |
| **散点图** | 每 pass 一张 ECharts 散点：X=DUT 编号、Y=良率%；🟢≥平均 / 🟡平均~阈值 / 🔴<阈值；两条 markLine（lot 平均、75% 阈值） | 前端 `DarkChart` 是否正常渲染 markLine + 逐点色带 |
| **A 路** | PRE_LLM 直连路由：问「lot 内哪些 DUT 偏低」→ 直出高亮表+散点，跳过 LLM | 真库端到端首轮工具 = `query_lot_underperforming_duts` |
| **B 路** | JB `generic`/`lot_overview` 概况末尾 best-effort 追加 `### 🔬 各 DUT 良率` 子节 | 概况回复末尾出现该节；INF 取数耗时 |

**本地 CI（沙箱，Dummy）：** `npm test` 471 pass / 0 fail / 4 skip；typecheck + build（含 verify-dist-no-undici）通过。

---

## 1. A 路复验（PRE_LLM 确定性直连）

**问句样例（真库，挑一个真实存在的 lot）：**
```
<真实 lot，如 NF12316.1X> 哪些 DUT 偏低
<真实 lot> 哪些 dut 良率低
```

**期望：**
- 首轮工具 = `query_lot_underperforming_duts`（**不经首轮 LLM**）；
- 输出 `## 实测数据` + 各 pass「各 DUT 良率」高亮表：低于阈值的 DUT 行前缀 🔴、四列加粗、状态列「低于阈值」；表头形如 `### 常温 sort1 — lot 整体 96.38% · 阈值 72.29%（低于阈值 🔴 标注）`；
- 每个有数据的 pass 追加一张散点图（chart 事件）。

**触发条件：** 谓词 `isLotUnderperformingDutQuestion` 需 **DUT/探针/触点/site 级词** + **低良率意图词**（低良率/偏低/良率低/低于平均…）；且句或 history 能解析出 lot。卡级问句「哪张卡良率最低」**不**触发（交既有路由）。

**若真库不出高亮表：** 抓该 session 首轮 `tool_start` 事件确认工具名；若 INF 取数抛错，A 路设计为 `return false` 落回 LLM（不 dead-end）——确认是否落回。

---

## 2. B 路复验（JB 概况 best-effort 补 DUT 良率）

**问句样例：** `<真实 lot> 概况`（走 JB 确定性概况 `generic`/`lot_overview`）。

**期望：** 主概况表 + 坏 BIN 图之后、`## 分析结论` 之前，出现独立子节 `### 🔬 各 DUT 良率（低于阈值 🔴）` + 每 pass 散点。前置状态提示「正在补充各 DUT 良率分析（较慢）…」。

**best-effort 语义：** INF 取数失败 / payload 缺 lot·device / 无低良率数据 → **静默跳过**（不 emit error，不阻塞主概况）。所以若某 lot 无 INF 数据，概况正常出、只是没有该子节——这是预期，不是 bug。

**代价：** 该节给 `generic`/`lot_overview` 概况**每次**加一次 INF/Perl 取数，会变慢（用户已确认接受 + 前置提示）。**请回传真库 INF 取数耗时**，若过慢再评估是否加缓存/条件触发。

---

## 3. 需 Cursor 回传

1. **A 路**：真实 lot 问「哪些 DUT 偏低」→ 首轮工具名 + 是否出高亮表(🔴)+散点。
2. **B 路**：lot 概况末尾是否出现 `### 🔬 各 DUT 良率` 子节 + 散点；INF 取数耗时（ms）。
3. **前端渲染**：散点图在 `DarkChart` 里 markLine（平均线/阈值线）与逐点三色是否正常显示；若色带/参考线不显示，回传截图，再定是否需前端适配 ECharts option。
4. **device 反查**：是否有 lot 触发 `runLotUnderperformingDuts` 的 JB device 反查失败（多 device 同 lot → 需显式 device）。

---

## 4. 沙箱未验部分

- 真 INF（Perl `output_site_bin_bylot.pl`）取数：沙箱只跑了 Dummy（`INFCONTROL_LAYER_BINS_DUMMY=true`）。
- 前端 `DarkChart` 对 markLine / 逐点 `itemStyle.color` 的实际渲染。
- 真库端到端时延。

---

## 5. 改动文件（全部 feat/jb-route-resolver）

| 文件 | commit |
|---|---|
| `src/lib/agent/agentUnderperformingDutView.ts`（新，高亮表+散点 option） | 88c7f4a / 48ee8bb |
| `src/lib/agent/agentUnderperformingDutRoute.ts`（新，问句谓词） | 675564d |
| `src/lib/agent/agentLoop.ts`（A 路直连 + LLM 工具路径出图 + B 路 best-effort） | 9fbfb7f / ac03371 |
| `src/lib/agent/agentToolHandlers.ts`（内部工具串换高亮表 + onUnderperformingDuts 回调） | 9fbfb7f |

**未动**：`lotUnderperformingDuts.ts`（`formatUnderperformingDutsMarkdown` + REST 字段）、`infAnalysisRoutes.ts`、报表 `LotUnderperformingDutsPanel.tsx`、SQL/Dummy。
