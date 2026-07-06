# Yield Monitor「周期报警统计」改为近 4 周/近 4 月趋势柱图 设计

日期:2026-07-06
范围包:`pcr-ai-report`(仅前端;不涉及 `pcr-ai-api`,复用已有的 v3/v4 产量聚合维度 `hostname`/`probeCard`/`bin`/`dutNumber`)
前置:[`2026-07-04-yield-monitor-period-alarm-design.md`](2026-07-04-yield-monitor-period-alarm-design.md) 落地的 `periodAlarm` section(总触发次数 + 环比 + 4 张 Top10 横向条形图)

## 背景

`periodAlarm` section 目前展示「本周/本月」单一周期的总量、环比变化率,以及 tester/probe card/bin/DUT 四个维度当期 Top10 的横向排名图。用户希望改为看**近 4 期的趋势**(近 4 周或近 4 月),而不是只看当期 vs 上一期的单点对比,同时不删除已实现的旧图表/环比代码(便于未来复用或对比)。

## 目标

`periodAlarm` section 保留「本周 | 本月」切换 chip,但切换后决定的是**趋势粒度**(4 个滚动周窗口 or 4 个自然月窗口),内容改为 5 张竖版柱图:
1. 近 4 期**总触发次数**趋势
2. 近 4 期 **tester(hostname)出现的不同台数**趋势
3. 近 4 期 **probe card 出现的不同卡号数**趋势
4. 近 4 期 **bin 出现的不同 bin 值数**趋势
5. 近 4 期 **DUT 出现的不同 DUT 编号数**趋势

旧的 KPI 卡片(总触发次数 + 环比)、4 张 Top10 横向条形图及其数据获取逻辑保留在源码中但不渲染、不发请求(见「旧代码处理」)。

## 交互设计

### 周期切换语义变化
- chip 仍是 `["本周", "本月"]`,`period` state 类型不变(`PeriodKey`)。
- 语义从「当前单周期 vs 上一周期」变为「近 4 个周期分别是多少」:
  - `week`:4 个**连续、不重叠的滚动 7 天窗口**,最新一个是 `[now-7d, now]`,依次往前各推 7 天,最旧一个是 `[now-28d, now-21d]`。
  - `month`:4 个**自然月**窗口,最新一个是「本月 1 日 00:00 至 now」(与现有 `periodWindow` 的月定义一致,可能是不完整月份),往前 3 个月每个都是完整自然月。
- 与筛选联动规则不变:使用 `appliedCoreParams`(查询按钮生效后的筛选快照),忽略筛选表单里的时间戳字段,时间范围完全由 4 个桶各自的窗口决定。

### 新增纯函数(`utils/yieldCalc.ts`)
```ts
export type PeriodBucket = { start: Date; end: Date; label: string };
export function recentPeriodBuckets(period: PeriodKey, count: number, now = new Date()): PeriodBucket[]
```
- 返回按时间**从旧到新**排列的 `count` 个桶(本设计固定 `count = 4`),供图表 x 轴直接使用。
- `label` 格式:`week` 用 `MM/DD-MM/DD`(桶起止日期);`month` 用 `YYYY-MM`。
- 复用现有 `periodWindow` 里的窗口长度定义(周=7 天滚动,月=自然月),不引入新的时间语义。

### 数据获取
- 新增 state:`trendBuckets: PeriodBucket[]`、`trendTotal: (number | null)[]`、`trendByTester/Card/Bin/Dut: (number | null)[]`(长度均为 4,与 `trendBuckets` 对齐)、`loadingTrend`、`errorTrend`。
- 新增 `useEffect`,依赖 `[apiBase, appliedCoreParams, period]`:
  1. `const buckets = recentPeriodBuckets(period, 4)`。
  2. 用 `allSettledWithConcurrency`(并发度仍为 `REPORT_ORACLE_FANOUT_CONCURRENCY`,与现有代码一致,不新增并发风险)对 **4 个桶 × 4 个维度 = 16 次** `YIELD_AGGREGATE_PATH` 请求,每次带该桶的 `timeStampFrom/timeStampTo` + `dimensions`(`hostname`/`probeCard`/`bin`/`dutNumber` 之一)+ `groupTop=100`(API 允许的最大值 `YIELD_MONITOR_V3_AGG_MAX_TOP`,用于让 `groups.length` 尽量准确反映真实类别数,不被截断)。
  3. 每个桶的「总触发次数」直接取该桶任一维度请求返回的 `totalRowsMatching`(4 个维度用同一个 WHERE,数值恒等,不必单独发第 5 类请求)。
  4. 每个桶每个维度的「类别数」= 该次请求 `groups.length`。
  5. 请求失败(`allSettledWithConcurrency` 返回 `rejected`)时该桶对应位置留 `null`,图表按「无数据」展示该柱(不整体报错),并将首个失败原因写入 `errorTrend` 提示用户。
- 性能提示:相比旧逻辑的 5 次串行请求,本次为 16 次串行请求,切换周期/筛选后加载时间会明显变长;`loadingTrend` 期间 5 张图表位置显示统一的「加载中…」占位,与现有 `loadingPeriod` 占位模式一致。

### 图表渲染
- 新增 `buildTrendBarOption(theme, buckets: PeriodBucket[], values: (number | null)[], color: string): EChartsOption`:仿照现有 `timeTrendOption` 的竖版结构 —— `xAxis: { type: "category", data: buckets.map(b => b.label) }` + `yAxis: { type: "value" }` + `series: [{ type: "bar", data: values.map(v => v ?? 0) }]`,与当前 4 张维度图使用的 `horizontalBarChartBase`(横版)风格不同,是新的构建函数,不与 `buildRankBarOption` 合并。
- 5 张图使用**新的** `DraggableReportBlocks`:
  - `storageKey`: `pcr-ai-report:yield-monitor-alarm-trend-chart-blocks`(全新键,不复用旧的 `pcr-ai-report:yield-monitor-alarm-chart-blocks`,避免旧布局偏好里 4 个块 id 与新的 5 个块 id 冲突)。
  - `defaultOrder`: 新常量 `YIELD_ALARM_TREND_CHART_BLOCK_ORDER = ["chAlarmTotalTrend", "chAlarmTesterTrend", "chAlarmCardTrend", "chAlarmBinTrend", "chAlarmDutTrend"]`。
  - `labels`: `{ chAlarmTotalTrend: "总触发次数趋势", chAlarmTesterTrend: "Tester 数趋势", chAlarmCardTrend: "Probe Card 数趋势", chAlarmBinTrend: "Bin 种类数趋势", chAlarmDutTrend: "DUT 编号数趋势" }`。
- **不展示 KPI 卡片**(用户明确选择):`periodAlarmSection` 内容变为「周期 chip 切换」+「5 图 `DraggableReportBlocks axis="grid"`」,不再包含 KPI 行。

### 旧代码处理(不删除,不引用)
- 新增常量 `const SHOW_LEGACY_PERIOD_CHARTS = false;`(就近放在 `periodAlarmSection` 构建逻辑旁)。
- 旧的 `useEffect`(填充 `periodByTester/Card/Bin/Dut`、`periodTotal`、`periodPrevTotal` 的那个,当前文件约 742-825 行)在函数体最前面加 `if (!SHOW_LEGACY_PERIOD_CHARTS) return;`(需注意:`cancelled` 闭包和 cleanup 函数需保留在 flag 判断之后的分支里,不能整体裸露在 return 之前产生冗余的空 effect;直接在 effect 回调体最前 `if (!SHOW_LEGACY_PERIOD_CHARTS) return;` 即可,不需要返回 cleanup)。这样旧的 16→更早是 5 次网络请求不会再发出,不浪费 Oracle 连接池。
- 旧的 4 张 `useMemo` 图表 option(`periodTesterOption` 等)、`periodRatioPct/periodRatioLabel/periodRatioColor` 的 `useMemo` 保持原样不动(纯计算,无副作用,留着无成本)。
- 旧的 JSX(KPI `DraggableReportBlocks` + 旧 4 图 `DraggableReportBlocks`)整体保留,外层包一层 `{SHOW_LEGACY_PERIOD_CHARTS && ( ... )}`,不渲染但仍在 JSX 树的静态结构里,满足 TS `noUnusedLocals`(该项目 `tsconfig.app.json` 已开启)不报「未使用变量」。
- 效果:旧状态、旧 effect、旧 useMemo、旧 JSX 全部保留在源码中(`git blame`/未来复用可查),但运行时完全不可见、不产生副作用。

## 不做的事(YAGNI)
- 不支持自定义桶数量(固定 4 期)或自定义周期长度(仍只有周/月两档)。
- 5 张趋势图不做点击下钻,保持与旧版一致的「概览」定位。
- 不新增后端接口或聚合维度;完全复用已有的 `hostname`/`probeCard`/`bin`/`dutNumber` 聚合能力,只是调用方式从「单桶 Top10」变为「4 桶各取 `groups.length`」。
- 不删除、不重写 2026-07-04 设计文档中已实现的旧 state/effect/useMemo/JSX,只做「不引用」处理。
