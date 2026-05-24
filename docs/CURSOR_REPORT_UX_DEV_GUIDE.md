# Cursor 开发指南：Report UX 改进 + DUT-Bin 聚合

> **分支：** `feat/report-ux-dut-bin-agg`  
> **计划文档：** `docs/superpowers/plans/2026-05-23-report-ux-and-dut-bin-agg.md`  
> **任务背景：** YM / JB 两张报表缺乏叙事主线；需新增 lot 级 DUT×Bin 聚合能力。

---

## 必读上下文（开始前）

- `pcr-ai-report/CLAUDE.md` — 前端结构、DraggableReportSections 规则、ECharts 规范
- `pcr-ai-api/CLAUDE.md` — Dummy-Oracle 双路径规则、aggregate API 参数
- `pcr-ai-api/src/lib/infcontrolLayerBinAggregate.ts` — JB aggregate 支持的 `groupBy` 维度
- `pcr-ai-api/src/lib/yieldMonitorTriggerFilters.ts` — YM 列表 `includeProbeCardSummary` 参数

---

## Phase 1：YM 报表 — 探针卡报警排名

### 目标

在 YieldMonitorReport 顶部新增「探针卡报警排名」横向条形图，让用户一眼看到哪张卡报警最多，点击自动填入查询筛选。

### 关键发现（省掉你自己 grep 的时间）

**后端已有 `probeCardSummary`**，不需要新 API endpoint。

- `pcr-ai-api/src/lib/yieldMonitorTriggerFilters.ts:13` — `includeProbeCardSummary: boolean`
- 前端列表请求加 `includeProbeCardSummary: true` 参数，API 响应就会包含 `probeCardSummary: { probeCard: string; count: number }[]`
- `pcr-ai-report/src/api/types.ts:46` — 类型 `YieldMonitorResponse` 里 `probeCardSummary` 字段已定义

### 实现步骤

**Step 1：新建 `pcr-ai-report/src/components/ProbeCardRankPanel.tsx`**

Props 接口：
```typescript
interface Props {
  data: { probeCard: string; count: number }[];
  onCardClick: (probeCard: string) => void;
}
```

图表要求：
- 使用 ECharts 横向条形图（`bar` + `yAxis.type = "category"`）
- 复用 `theme/chartTheme.ts` 中的 `horizontalBarChartBase`、`chartAccent`、`horizontalBarCategoryAxisLabel`
- 高度用 `rankBarChartHeight(data.length)`（已在 chartTheme.ts 中定义）
- Y 轴按 count 降序（ECharts 的 Y 轴 category 默认是倒序，需要在 data 传入前先 sort 好再 `[...].reverse()` 给 Y 轴）
- 点击柱子触发 `onCardClick`：`chart.on("click", params => onCardClick(params.name))`
- 空 data 时渲染一行灰色说明文字，不渲染 ECharts

**Step 2：在 `YieldMonitorReport.tsx` 的列表请求中加参数**

找到 `apiGetJson` 调用 yield-monitor list 的地方，加：
```
includeProbeCardSummary: true
```

响应里把 `data.probeCardSummary` 存到 state。

**Step 3：在 DraggableReportSections 中注册新区段**

在 `pcr-ai-report/src/components/DraggableReportSections.tsx` 里，找到 `YIELD_MONITOR_LAYOUT_STORAGE_KEYS` 和对应的 `defaultOrder`、`TOP_SECTION_LABELS`：

- 新增区段 id：`"probe-card-rank"`
- 加入 `defaultOrder` 数组的**第一位**（排在 KPI 条之前）
- 加入 `labels` 对象：`"probe-card-rank": "Probe Card Alarm Rank"`

**Step 4：在 `YieldMonitorReport.tsx` 的 sections 对象里加入新区段**

```tsx
sections["probe-card-rank"] = (
  <ProbeCardRankPanel
    data={probeCardSummary ?? []}
    onCardClick={(card) => {
      setForm(f => ({ ...f, probeCard: card }));
      // 可选：触发自动查询
    }}
  />
);
```

### 坑

1. **`rankBarChartHeight` 的最小高度**：如果 `data.length === 0`，不要传给 ECharts，直接渲染占位文字，否则 ECharts 会渲染一个高度为 0 的空图
2. **ECharts Y 轴排序方向**：ECharts category 轴从底部开始渲染，所以传入 `yAxis.data` 和 `series.data` 之前要先按 count 升序排（count 最大的在最后，因为最后 = 最上面）
3. **DraggableReportSections 三处必须同步**：`defaultOrder`、`labels`、`sections` 对象的键名必须完全一致，漏掉任何一处都会导致区段不显示或布局重置失效

---

## Phase 2：JB 报表 — 坏 Bin 分布总览

### 目标

在 InfcontrolReport 顶部新增「坏 Bin 分布总览」横向条形图（显示 Top 15 bad bins），并在 Lot 树表行上加"主要坏 Bin"列。

### 关键发现

**`"bin"` 已经是 JB aggregate 的合法 `groupBy` 维度。**

- `pcr-ai-api/src/lib/infcontrolLayerBinAggregate.ts:14` — `| "bin"` 在 `InfcontrolLayerBinGroupBy` 类型里
- 前端已有 `INFCONTROL_AGGREGATE_PATH`，直接加一个 `groupBy=bin` 的 aggregate 请求即可
- 响应格式是 `InfcontrolAggregateResponse`，`groups[].key` 是 bin 名，`groups[].count` 是总坏品颗数
- 过滤 good bins：用 `pcr-ai-report/src/utils/infGoodBins.ts` 的 `isGoodBin(binNumber)` 函数

### 实现步骤

**Step 1：新建 `pcr-ai-report/src/components/BinDistributionPanel.tsx`**

Props：
```typescript
interface Props {
  data: { bin: string; count: number; isGood: boolean }[];
  onBinClick: (bin: string) => void;
}
```

图表要求：
- 横向条形图，只展示 `isGood === false` 的 bin，Top 15
- 坏 bin 用 `chartAccent`（红/橙色系），Good bin 如果要展示用 `chartAccent2`（绿色系）
- `rankBarChartHeight(Math.min(data.length, 15))`
- 空 data 时渲染说明文字

**Step 2：在 `InfcontrolReport.tsx` 里新增一个 bin aggregate 请求**

在现有的多个 aggregate 请求之外，新增：
```
GET INFCONTROL_AGGREGATE_PATH + "?groupBy=bin&groupTop=50"
```
（groupTop=50 足够覆盖所有 bad bins）

结果存入 state，结合 `isGoodBin` 过滤后传给 BinDistributionPanel。

**Step 3：注册到 JB DraggableReportSections**

与 Phase 1 类似，在 `JB_START_LAYOUT_STORAGE_KEYS` 对应的 `defaultOrder` 第一位加 `"bin-distribution"`。

**Step 4：Lot 树表加"主要坏 Bin"列（可选，二期实现）**

从 per-lot aggregate 数据里，找出每个 lot 的 `top bad bin`（count 最大且 `!isGoodBin`），在 TreeTable 的 lot 行加一列显示 `"BIN37 (45%)"` 格式。

### 坑

1. **`groupBy=bin` 返回的 key 格式**：key 是 `"bin37"` 还是 `"BIN37"`？先 console.log 实际返回确认，再写 `isGoodBin` 的匹配逻辑。目前 `infGoodBins.ts` 里的函数接受数字（bin index），需要先从 key 里 parse 出数字。
2. **aggregate 并发**：InfcontrolReport 里已经有多个并发 aggregate 请求，受 `REPORT_ORACLE_FANOUT_CONCURRENCY = 1` 约束（串行）。新增一个 bin aggregate 会**额外增加一次串行等待**，页面加载时间会增加。考虑把 bin aggregate 和最耗时的那个 aggregate 合并到 combined 接口，或者延迟加载（等其他 aggregate 都完成后再发）。
3. **BinDistributionPanel 的查询时机**：它依赖查询条件（device/lot/time range），必须和其他 aggregate 一起在「查询」按钮点击后触发，不要单独维护一套查询状态。

---

## Phase 2b：YM ↔ JB 跨表跳转链接

### 目标

- YM 明细表的 `probeCard` 列 → 点击后跳转到 JB 报表，预填 `cardId = probeCard`
- JB 明细表的 `cardId` 列 → 点击后跳转到 YM 报表，预填 `probeCard = cardId`

### 实现要点

**状态必须在 `App.tsx` 层提升**，不能让两个 report 组件直接通信。

方式：
1. 在 `App.tsx` 维护 `crossTabFilter: { target: "yield" | "jb"; filter: Partial<FormState> } | null` state
2. 各 Report 组件接收 `initialFilter?: Partial<FormState>` prop
3. 切换 tab 时，把 `crossTabFilter.filter` 传给目标 report，report 在 `useEffect` 里把它合并进 `formState`
4. 传完后清空 `crossTabFilter`（防止重复触发）

### 坑

1. **FormState 字段名不同**：YM 的表单字段是 `probeCard`，JB 的表单字段是 `cardId`。跳转时需要做字段名映射，不能直接传同一个对象。
2. **React tab 切换时机**：先切 tab（`setActiveTab`），再在 `useEffect` 里合并 filter。顺序反了会导致 filter 设进旧 tab 的 state 里。

---

## Phase 3：新 API + LotDutBinPanel（最复杂）

### 目标

新增 `GET /api/v4/inf-analysis/lot-dut-bin-agg` 端点，聚合一个 lot 里所有 wafer 的 DUT×Bin 分布，前端新增 `LotDutBinPanel.tsx`。

### 后端实现

**Step 1：新建 `pcr-ai-api/src/lib/lotDutBinAgg.ts`**

逻辑：
1. 用 `withConnection` 查 INFCONTROL，得到该 lot 下所有 `SLOT` 和对应的 `infPath`（用 `buildInfPath(device, lot, slot)`）
2. 用 `allSettledWithConcurrency(slots, 3, slot => callOutputSiteBinByLot(infPath, passId))` 并发调 Perl（**不要用 `Promise.all`**，会同时起 25 个 Perl 进程）
3. 累加所有 slot 的 `passes[].bins[]` → `{ bin, dut } → dieCount`

响应 shape：
```typescript
{
  lot: string;
  device: string;
  passId: string | null;
  waferCount: number;
  duts: {
    dut: number;
    bins: { bin: string; dieCount: number }[];
  }[];
}
```

**Step 2：新建 `pcr-ai-api/src/lib/lotDutBinAggDummy.ts`**

- 复用已有 `docs/site-bin-bylot-dummy-r_1-1.passes.json`
- 模拟 3 个 slot 各自重复该文件，累加结果（dieCount × 3）
- 响应 shape 与 Oracle 路径完全一致（dummy-parity 原则）

**Step 3：在 `infAnalysisRoutes.ts` 挂载新路由**

```
GET /inf-analysis/lot-dut-bin-agg?device=&lot=&passId=
```

- 用 `INFCONTROL_LAYER_BINS_DUMMY` 开关（与现有 site-bin-bylot 保持一致）
- wafer 数 > 30 → 返回 422
- lot 在 INFCONTROL 里找不到 → 返回 404

**Step 4：在 `apiManifest.ts` 注册新 endpoint**

### 前端实现

**新建 `pcr-ai-report/src/components/LotDutBinPanel.tsx`**

- 堆叠横向条形图：Y 轴 = DUT 编号，X 轴 = dieCount，颜色堆叠 = bad bin 类型（用 chartTheme 颜色序列）
- 只显示 `dieCount > 0` 的 bin
- 加载时显示 spinner（Perl 并发可能需要 3–10 秒）
- 空数据时显示"暂无 INF 文件数据"

触发时机：用户在 JB 报表下钻到某个 lot 时，LotDutBinPanel 自动发请求加载。

**在 `api/types.ts` 新增类型 `LotDutBinAggResponse`**

**在 `api/paths.ts` 新增常量 `LOT_DUT_BIN_AGG_PATH`**

### 坑（Phase 3 最多）

1. **`allSettledWithConcurrency` 的正确用法**：
   - 已有 `pcr-ai-report/src/utils/asyncConcurrency.ts`，但那是前端的
   - 后端没有这个 util，需要自己实现或从 `outputSiteBinByLot.ts` 看看怎么组织并发
   - 不要用 `Promise.all`，后端最多 3 并发：写一个简单的 chunk-based 串并发函数
   
2. **`buildInfPath` 在后端的位置**：
   - 已有前端版本 `pcr-ai-report/src/utils/buildInfPath.ts`
   - 后端版本在 `pcr-ai-api/src/lib/outputSiteBinByLot.ts` 或附近，找到后直接 import，不要重复实现

3. **SLOT 查询用主库还是 probeweb**：
   - INFCONTROL 表在**主库**（`withConnection`），不是 `withProbeWebConnection`（那个是产量触发器的 probeweb schema）
   - 这两个连接池的 schema 不同，混用会报表不存在错误

4. **passId 的数值映射**：
   - 前端传来的 `passId` 可能是 `"sort1"` / `"sort2"` / `"sort3"` 的文字形式
   - 但 Perl 脚本和 INF 文件里用的是 `1` / `3` / `5`（数字）
   - 参考 `domain_pass_sort_mapping.md` 内存记录：sort1→1, sort2→3, sort3→5
   - 转换逻辑写在后端 handler 里，不要让前端处理

5. **Dummy 文件路径**：
   - `docs/site-bin-bylot-dummy-r_1-1.passes.json` 这个文件路径在 `outputSiteBinByLotDummy.ts` 里是硬编码的相对路径
   - 新的 `lotDutBinAggDummy.ts` 要用 `path.join(__dirname, "../../docs/...")` 这种相对于 dist/ 的路径，跑 `npm run build` 后确认文件被 copy 过去

6. **并发上限 422 的防止**：
   - wafer 数 > 30 时直接 422，不要让用户等 25 × Perl 进程
   - INFCONTROL 一个 lot 通常 25 片，但有些 lot 可能 > 25，要有这个保护

7. **`npm run build` 必须在 API 改完后跑**：
   - 新增 Perl 脚本相关的改动（`outputSiteBinByLot.pl` 不在本 Phase 里）不需要 build
   - 但新的 `.ts` 文件需要 `tsc → dist/`，否则 `npm start` 跑的还是旧版本

---

## DraggableReportSections 改动规范（每个 Phase 都适用）

每次新增一个可拖拽区段，必须同时改以下三处（缺一不可）：

```
DraggableReportSections.tsx:
  1. defaultOrder 数组 → 加新 id
  2. labels 对象 → 加 "新id": "显示名称"
  
YieldMonitorReport.tsx 或 InfcontrolReport.tsx:
  3. sections 对象 → 加 sections["新id"] = <NewComponent ... />
```

如果三处不一致，症状：
- 只加了 `defaultOrder` 没加 `labels`：区段显示但标题是 undefined
- 只加了 `sections` 没加 `defaultOrder`：区段永远不显示（被 DraggableReportSections 过滤掉）
- 只加了 `defaultOrder` + `labels` 没加 `sections`：区段显示为空

---

## ECharts 通用规范

- 所有图表用 `DarkChart` 组件包装，不直接用 `ReactECharts`
- 高度：固定数量用 `rankBarChartHeight(count)`；趋势图用 `YIELD_TREND_CHART_HEIGHT`；slot 图用 `JB_SLOT_TREND_CHART_HEIGHT`
- 颜色：`chartAccent`（主色/坏）、`chartAccent2`（副色/好）、`chartAccent3`（第三色）、`chartAxisColor`（轴线）、`chartSplitLine`（分割线）
- X 轴 / Y 轴文字：`horizontalBarCategoryAxisLabel`（横向 bar 的类目轴，自动处理长文字截断）

---

## 测试检查清单

实现每个 Phase 后，验证：

- [ ] `npm run typecheck`（pcr-ai-report）通过，无 TS 错误
- [ ] `npm run build`（pcr-ai-api，Phase 3 only）通过
- [ ] `npm test`（pcr-ai-api，Phase 3 only）通过，新 endpoint 有测试用例覆盖 Dummy 路径
- [ ] 浏览器里打开报表，查询一次，新区段正确渲染
- [ ] 点击新图表的交互（onCardClick / onBinClick）正确填入筛选表单
- [ ] 拖动新区段到不同位置，刷新后位置保留（localStorage 持久化）
- [ ] 点击「↺ 还原布局」后，新区段回到默认位置
- [ ] 关闭新区段（✕），刷新后不再显示；还原布局后重新出现
- [ ] Phase 3：后端 Dummy 模式下（`INFCONTROL_LAYER_BINS_DUMMY=true`）LotDutBinPanel 能正常加载

---

## 不要碰的东西

- `oracledb` 版本：锁定在 5.5.0，不要升级（会破坏 11g 客户端兼容性）
- `undici` npm 包：项目有守卫脚本禁止引入，TLS 出站用 `node:https` 或全局 `fetch`
- `DragOverlay`：@dnd-kit 的 overlay 组件在这个项目里故意不用（用户反馈过 overlay 只剩标题条）
- `InfDutDistPanel`：保持现有 per-slot 逻辑不变，`LotDutBinPanel` 是新增而非替换
