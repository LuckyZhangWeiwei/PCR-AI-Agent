# Report UX Improvement & DUT-Bin Aggregation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 YM 和 JB 两张报表建立清晰的叙事主线，并新增 lot 级 DUT×Bin 聚合能力，让用户从"哪里出问题"到"哪张卡/哪个 DUT 导致的"一路下钻不断线。

**Architecture:** 三个独立阶段，可按顺序分批交付。Phase 1–2 纯前端，无后端变动；Phase 3 需要新增后端 API endpoint + 前端新组件；Phase 4 为未来选项，需要缓存策略，不在本 plan 范围内实施。

**Tech Stack:** React 19 + TypeScript + ECharts + @dnd-kit（前端）；Node.js + Express + oracledb + Perl（后端 Phase 3）

---

## 背景与问题诊断

### YM 报表的现状问题

当前 `YieldMonitorReport` 把所有维度平铺展示，用户打开后不知道该从哪里看起。报表的核心问题是：**缺少"哪张探针卡需要关注"的顶层入口**。用户必须先填查询条件，等数据回来后再从 KPI 数字里猜问题所在，主线是反向的。

正确的叙事应该是：
```
探针卡健康排名（入口）→ 选卡后看 DUT 分布 → 看时间趋势 → 查具体报警事件
```

### JB 报表的现状问题

当前 `InfcontrolReport` 直接展示多个聚合图表（按 lot/device/card/slot/tester），缺少一个回答"什么 bin 在大量失效"的全局视角。`InfDutDistPanel` 是 per-slot 级别，细节丰富但需要用户已知道要看哪个 lot/slot 才有意义。

正确的叙事应该是：
```
坏 bin 分布总览（入口）→ 选 bin 后看是哪些卡/DUT → 下钻到 lot/wafer → 看 InfDutDistPanel
```

### DUT-Bin 关系的现状问题

目前 `InfDutDistPanel` 是 per-wafer（per-slot/pass）粒度，只在 JB 报表下钻到某个具体 lot+slot 后才能看到。无法回答：**在这个 lot 的 25 片 wafer 里，DUT3 总共产生了多少 BIN37 坏品？**

---

## 文件变更地图

### 前端（pcr-ai-report/src/）

| 文件 | 变更类型 | 职责 |
|---|---|---|
| `components/ProbeCardRankPanel.tsx` | **新建** | YM 探针卡报警排名条形图，点击回调 |
| `components/BinDistributionPanel.tsx` | **新建** | JB 坏 bin 分布总览横向条形图，点击回调 |
| `components/LotDutBinPanel.tsx` | **新建** | Lot 级 DUT×Bin 聚合堆叠条形图（Phase 3） |
| `reports/YieldMonitorReport.tsx` | **修改** | 新增 ProbeCardRankPanel 区段；调整区段顺序与叙事 |
| `reports/InfcontrolReport.tsx` | **修改** | 新增 BinDistributionPanel 区段；调整区段顺序；接入 LotDutBinPanel |
| `components/DraggableReportSections.tsx` | **修改** | 注册新区段 id 到 defaultOrder 与 labels |
| `api/types.ts` | **修改** | 新增 `LotDutBinAggResponse` 类型（Phase 3） |
| `api/paths.ts` | **修改** | 新增 `LOT_DUT_BIN_AGG_PATH` 常量（Phase 3） |

### 后端（pcr-ai-api/src/，Phase 3 only）

| 文件 | 变更类型 | 职责 |
|---|---|---|
| `routes/infAnalysisRoutes.ts` | **修改** | 挂载新的 `GET /inf-analysis/lot-dut-bin-agg` |
| `lib/lotDutBinAgg.ts` | **新建** | 查 INFCONTROL 取所有 slot → 并发 Perl → 汇总结果 |
| `lib/lotDutBinAggDummy.ts` | **新建** | Dummy 路径，复用现有 site-bin-bylot-dummy JSON |
| `lib/apiManifest.ts` | **修改** | 注册新 endpoint |

---

## Phase 1：YM 报表改进 — 探针卡健康主线

### 设计目标

让用户打开 YM 报表、点"查询"后，**第一眼看到的就是探针卡报警排名**，无需手动分析就能知道哪张卡最需要关注。

### 新增区段：ProbeCardRankPanel

**位置：** YM 报表顶部，在现有 KPI 条之前

**内容：** 横向条形图，Y 轴 = probeCard（按报警次数降序），X 轴 = 报警次数（AlarmCount）。数据来源：复用现有 v3 aggregate API 的 `probeCard` 维度聚合结果，无需新 API。

**交互：** 点击某条 → 自动回填查询表单的 `probeCard` 字段 → 触发重新查询 → 页面下方各图表聚焦到该卡。

**空状态：** 查询前显示说明文字"查询后显示探针卡报警排名"；无数据时显示"当前筛选范围内无报警"。

**组件边界（ProbeCardRankPanel.tsx）：**
- Props：`groups: AggregateGroup[]`（已有的 aggregate 响应数据）、`onCardClick: (probeCard: string) => void`
- 内部用 ECharts 横向条形图，高度根据卡数量动态计算（最少 120px，每条 28px）
- 复用 `chartTheme.ts` 中 `horizontalBarChartBase` 样式

### 区段顺序调整

修改后的 YM 报表区段顺序（DraggableReportSections）：

```
1. [新] 探针卡报警排名（ProbeCardRankPanel）
2. [原] KPI 条（总报警数 / 涉及卡数 / 涉及 DUT 数）
3. [原] DUT 报警分布（哪个 DUT 触发最多）
4. [原] 时间趋势图
5. [原] 明细表
```

### 小改进：DUT 报警分布图

现有 DUT 分布图已在报表中，只需在图表标题下加一行说明文字：`"DUT 号从 TRIGGER_LABEL 解析，空白表示 label 未包含 dut# 信息"`，消除用户对 null 值的困惑。

### 跨表链接（可选小功能）

在明细表的 `probeCard` 列值旁加一个小图标（→），点击跳转到 JB 报表并预填 `cardId` + `testEndFrom/To`（同当前 YM 查询的时间范围）。实现方式：通过 `App.tsx` 的 tab 切换 + 状态提升传入 JB 报表初始 filter 值。

---

## Phase 2：JB 报表改进 — 坏 Bin 分布主线

### 设计目标

让用户打开 JB 报表、点"查询"后，**第一眼看到的是哪些 bin 失效最多**，然后才是各维度的拆解。

### 新增区段：BinDistributionPanel

**位置：** JB 报表顶部，在现有 KPI 条之前

**数据来源：** 复用现有 v3/v4 aggregate 响应，aggregate 已包含 bin × lot/device 的交叉数据；从中提取"每个 bin 的总 badDieCount"，在前端 `rollup.ts` 或 `binFilterLines.ts` 里计算，无需新 API。

**内容：** 横向条形图，Y 轴 = BIN 编号（如 BIN37、BIN23，过滤掉 BIN0），X 轴 = 总坏品颗数，降序排列；只显示 Top 15 个最差的 bin（其余合并为 "Others"）。

**交互：** 点击某个 bin → 在下方的 DrillDownPanel / TreeTable 中高亮该 bin 的数据，或自动展开该 bin 的 by-lot 分解。

**组件边界（BinDistributionPanel.tsx）：**
- Props：`binCounts: { bin: string; count: number }[]`、`onBinClick: (bin: string) => void`
- 颜色区分：`isGoodBin` 为 true 的 bin 用绿色，坏 bin 用红色/橙色渐变
- 复用 `infGoodBins.ts` 中的 `isGoodBin` 判断

### 区段顺序调整

修改后的 JB 报表区段顺序：

```
1. [新] 坏 Bin 分布总览（BinDistributionPanel）
2. [原] KPI 条（总 wafer 数 / 总坏品数 / yield%）
3. [原] By Card / By Device 图表组
4. [原] By Lot / 时间趋势图
5. [原] Per-wafer DUT-Bin 下钻（InfDutDistPanel，现位置不变）
6. [原] 明细表
```

### Lot 树表增强

在 TreeTable 的 lot 行上，增加一列"主要坏 Bin"（Top 1 bad bin）：从当前已有的 aggregate 数据里取 per-lot bin 分布的最大值，直接显示 "BIN37 (45%)" 这样的格式。让用户在树表里扫一眼就能看出哪个 lot 的失效模式。

### 跨表链接（对称于 Phase 1）

在明细表 `cardId` 列旁加小图标（→），点击跳转到 YM 报表并预填 `probeCard = cardId` + 时间范围，方向与 Phase 1 对称。

---

## Phase 3：新功能 — Lot 级 DUT×Bin 聚合

### 问题定义

`InfDutDistPanel` 目前是 per-slot（单片 wafer）粒度。要回答"这个 lot 的全部 25 片 wafer 里，DUT3 总共产生了多少 BIN37 坏品？"，需要：

1. 知道这个 lot 有哪些 slots（wafer 编号）
2. 对每个 slot 调用一次 Perl（site-bin-bylot）
3. 在 Node.js 里累加所有 slot 的 `bin × dut → dieCount`

### 新后端 API

**路径：** `GET /api/v4/inf-analysis/lot-dut-bin-agg`

**查询参数：**
- `device`（必须）
- `lot`（必须）
- `passId`（可选，默认不过滤）

**服务端逻辑（lotDutBinAgg.ts）：**

1. 查询 INFCONTROL，取 `WHERE LOT = :lot AND DEVICE = :device`，得到所有 `SLOT` 列表（去重），同时取每个 slot 对应的 `INFPATH`（通过已有的 `buildInfPath(device, lot, slot)`）
2. 并发调用 `outputSiteBinByLot` 逻辑（复用现有 Perl 调用），受 `asyncConcurrency` 限制（建议 `concurrency=3`，单 lot 25 片并发 3 张）
3. 将所有 slot 的 `passes[].bins[]` 按 `{ bin, dut }` 累加 `dieCount`
4. 响应结构：

```
{
  lot: string,
  device: string,
  passId: string | null,
  waferCount: number,      // 实际加载的 slot 数
  duts: [                  // 所有 DUT 编号（去重、升序）
    {
      dut: number,
      bins: [              // 只含 count > 0 的 bin
        { bin: string, dieCount: number }
      ]
    }
  ]
}
```

**Dummy 路径（lotDutBinAggDummy.ts）：**
- 复用现有 `docs/site-bin-bylot-dummy-r_1-1.passes.json`，模拟 3 个 slot 的累加
- 与 Oracle 路径的响应 shape 保持一致（dummy-parity 原则）

**注意事项：**
- 若 lot 下 slot 数量 > 30，返回 422 并提示"wafer 数量过多，请缩小范围"，防止过度并发
- 若 INFCONTROL 未找到该 lot，返回 404
- Dummy 开关：与 `INFCONTROL_LAYER_BINS_DUMMY` 保持一致

### 新前端组件 LotDutBinPanel

**触发时机：** 用户在 JB 报表的 TreeTable 或明细表里点击某个 lot（下钻后），在 InfDutDistPanel 同一区域的上方或旁边渲染。

**展示形式：** 堆叠横向条形图
- Y 轴 = DUT 编号（升序）
- X 轴 = 总坏品颗数
- 颜色堆叠 = 不同坏 bin（使用 chartTheme 颜色序列）
- 图例 = bin 名称，点击图例可过滤
- 标题：`Lot {lot} — DUT × Bad Bin Distribution（{N} wafers）`

**加载状态：** 独立 loading spinner，不阻塞其他区段。因为 Perl 并发调用可能需要 3–10 秒，需要明显的进度提示（如 "正在加载 N/25 片 wafer 数据..."）——这需要后端用 SSE 或分批返回（可以先实现简单版：一次性等全部完成后返回，加 spinner）。

**空状态：** "暂无 INF 文件数据，请确认该 lot 的 infPath 在服务器可访问"

**与 InfDutDistPanel 的关系：**
- `InfDutDistPanel`：单片 wafer 级，用户选定 lot+slot 后看
- `LotDutBinPanel`：整个 lot 级聚合，用户选定 lot 后自动加载
- 两者并存，`LotDutBinPanel` 在上（lot 概览），`InfDutDistPanel` 在下（单片下钻）

### 区段注册

在 `JB_START_LAYOUT_STORAGE_KEYS` 中注册新区段 `lot-dut-bin`，默认顺序：

```
1. BinDistributionPanel（新）
2. KPI 条
3. By Card / Device 图表
4. By Lot 图表
5. [新] LotDutBinPanel（lot 选中后显示）
6. InfDutDistPanel（slot 选中后显示）
7. 明细表
```

---

## Phase 4：Device 级 DUT 一致性（未来，不在本 plan 实施）

**愿景：** 跨多个 lot，分析同一张卡的同一个 DUT 是否持续出现同一个坏 bin——判断**探针卡物理损伤**的长期规律。

**可视化形式：** 热力图（X = DUT，Y = BIN，颜色 = 跨 lot 失效率 %）

**不实施原因：**
- 需要对多个 lot 各自跑 25 片 Perl，数据量过大，on-demand 不可行
- 需要后端结果缓存（per device+timeRange，TTL 约 30 分钟）
- 实现复杂度高，先验证 Phase 3 的可行性后再评估

**预留设计：** `LotDutBinPanel` 的 API 响应格式兼容 device 级聚合（只需 caller 改成多 lot 循环），Phase 4 可直接复用数据结构。

---

## 交付顺序建议

| 阶段 | 内容 | 预估复杂度 | 依赖 |
|---|---|---|---|
| Phase 1 | YM 探针卡排名区段 | 低（纯前端，复用现有 aggregate 数据） | 无 |
| Phase 2 | JB 坏 bin 分布区段 + lot 树表增强 | 低-中（前端数据聚合 + 新图表组件） | 无 |
| Phase 2b | YM ↔ JB 跨表链接 | 低（需要 App.tsx 状态提升） | Phase 1 + Phase 2 完成后 |
| Phase 3 | Lot 级 DUT×Bin 聚合（后端 + 前端） | 高（新 API + Perl 并发 + 新组件） | Phase 2 完成后 |
| Phase 4 | Device 级 DUT 一致性热力图 | 高，缓存策略复杂 | Phase 3 验证后评估 |

---

## 约束与注意事项

1. **Dummy-Oracle 双路径**：Phase 3 新增 API 必须同时实现 Oracle 路径和 `lotDutBinAggDummy.ts`；测试用例须覆盖两条路径。
2. **并发控制**：Phase 3 后端 Perl 调用复用 `asyncConcurrency`，不得直接 `Promise.all`，避免打爆服务器进程。
3. **DnD 布局兼容**：新增区段 id 时，同步更新 `defaultOrder`、`labels`、以及 `resetReportLayoutStorage` 所清除的 key 集合；不得破坏已有用户 localStorage 布局（若改了 key 名需要 migration 逻辑或文档说明接受重置）。
4. **oracledb@5.5 不升级**：Phase 3 不得引入任何新的数据库依赖，SQL 使用现有 `withConnection` / `withProbeWebConnection` 接口。
5. **跨表链接的状态提升**：Phase 2b 的 YM ↔ JB 链接需要在 `App.tsx` 层做 tab 切换 + 初始 filter 状态，避免 report 组件间直接通信。
