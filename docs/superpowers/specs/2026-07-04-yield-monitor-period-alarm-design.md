# Yield Monitor Tab — Weekly/Monthly Alarm Section 设计

日期:2026-07-04
范围包:`pcr-ai-api`(新增聚合维度)+ `pcr-ai-report`(Yield Monitor 报表新 section)

## 背景

Yield Monitor 报表的「每日触发量趋势」只展示逐日曲线,缺少一个「本周/本月总量 + 环比 + 分类构成」的汇总视图,便于快速判断报警是在加剧还是好转,以及主要集中在哪些 tester / probe card / bin / DUT 上。

## 目标

在「每日触发量趋势」下方新增一个可拖拽 section:**Weekly/Monthly Yield Monitor Alarm**,包含:
1. 周/月切换
2. 总触发次数 + 环比变化率
3. 按 tester(hostname)、probe card(具体卡号)、bin、DUT 四个维度的 Top 10 分类次数图表

## 数据源确认(关键前提)

`YMWEB_YIELDMONITORTRIGGER`(`docs/delta-diff.xlsx` 为 Dummy 样本)没有独立的 BIN / DUT 列,但 `TRIGGER_LABEL` 文本里稳定携带这两类信息。对 152 条 `TYPE=delta_diff`(v3/v4 唯一保留的 TYPE)样本行做正则匹配,**100% 都能解析出 `Bin#` 后的值**(数字或字面量 `goodbin`),格式如:

```
Bin# 1 on dut# 2 Yield: 58.72, Min Yield(Dut#2): 58.72 Max Yield(Dut#0): 98.15 Delta exceed Delta Limit 20.
Bin# goodbin on dut# 21 Yield: 29.69, ...
```

`dutNumber` 已有解析逻辑(`src/lib/yieldTriggerLabelDut.ts` 的 `parseDutNumberFromTriggerLabel`,正则 `on\s+dut#\s*(\d+)`),已用于 v3 列表的 `dutNumber` 字段。`bin` 需要新增同类解析函数。

结论:bin / dutNumber 可以像现有的 `probeCardType`(从 `PROBECARD` 首段派生)一样,做成**派生聚合维度**,而不是要求前端拉全量明细行手工统计(会受 500 条 `limit` 上限影响、月度数据易失真)。

## 交互设计

### 位置与布局
- 新增顶层可拖拽 section id `periodAlarm`,插入 `YIELD_REPORT_SECTION_ORDER` 中 `timeTrend` 之后、`chartsGrid` 之前。
- `DraggableReportSections.tsx` 的 `TOP_SECTION_LABELS` 增加 `periodAlarm: "周期报警统计"`。
- section 内部:顶部周期切换 chip,其下 KPI 卡片行,再下 4 图 2×2 网格(用现有 `DraggableReportBlocks axis="grid"` 包裹,storageKey `pcr-ai-report:yield-monitor-alarm-chart-blocks`,让用户可拖拽/隐藏这 4 个图,但不做点击下钻)。

### 周期切换与筛选联动
- 切换 **[本周 | 本月]**(默认本周)时,使用**当前已生效的其它筛选**(device/lot/hostname/probeCardType/probeCard/pass — 即上一次点击「查询」后 `query()` 用的 `core` 参数,存入新增的 `appliedCoreParams` state)立即重新拉取,不需要用户再点「查询」。
- 用户修改筛选表单后仍需点「查询」才会更新该 section(与报表其余图表行为一致);点「查询」时一并刷新 `appliedCoreParams` 并触发该 section 重新拉取。
- 该 section **忽略**筛选表单里的时间戳字段,时间范围完全由周期开关决定。

### 时间窗口计算
- 本周:`[now - 7d, now]`(与现有 `dateShortcutLast7Days` 口径一致)。
- 本月:`[本自然月 1 日 00:00, now]`(与现有 `dateShortcutThisMonth` 口径一致)。
- 环比窗口:取与当前窗口**等长**的紧邻前段,即 `[start - (end - start), start)`。此规则统一适用于周/月两种粒度,月度早期(如每月 3 号)也能公平对比,不会出现"整月 vs 至今 3 天"的失真环比。

### KPI 卡片(复用 `KpiCard`,2 张)
1. **总触发次数**:当前周期 `totalRowsMatching`;`subtext` 显示"上一周期 N 次"。
2. **环比变化率**:`(current - previous) / previous * 100`,格式 `↑12.5%` / `↓8.3%`;上升(标红,报警增多是坏事)/ 下降(标绿)/ `previous === 0 且 current > 0` 显示"新增"/ 两者皆 0 显示 `0%`(灰)。

### 四个分类图表(横向条形图,Top 10,静态展示无下钻)
| 图表 | 维度 | Y 轴标签 |
|---|---|---|
| Tester 分布 | `hostname` | 原始 hostname |
| Probe Card 分布 | `probeCard`(具体卡号,区别于已有的卡型图) | 原始卡号 |
| Bin 分布 | 新增派生维度 `bin` | 数字 → `BIN n`;`goodbin` → `GOODBIN` |
| DUT 分布 | 新增派生维度 `dutNumber` | `dut#n`(与现有 DUT 分布图一致) |

样式复用 `horizontalBarChartBase` + `rankBarChartHeight`,四图分别用不同强调色(`chartPalette.accent` / `accent2` / `accent3` / `selectionTierColors(theme,"orange").base`)区分。

## 后端改动

在 `pcr-ai-api` 的 v3/v4 产量聚合基础设施中新增两个派生维度,遵循与 `probeCardType` 完全一致的模式(Oracle 用 `REGEXP_SUBSTR`,Dummy/v4 用 Node 正则解析,同一份逻辑同时服务 Dummy 与 v4 Oracle 全量行聚合路径)。

### 新文件:`src/lib/yieldTriggerLabelBin.ts`
```ts
const BIN_FROM_TRIGGER_LABEL = /\bBin#\s*([0-9]+|goodbin)\b/i;
export function parseBinFromTriggerLabel(label: string | null | undefined): string | null
```
返回值:数字原样返回(字符串形式);`goodbin`（大小写不敏感）归一化为小写 `"goodbin"`；无匹配返回 `null`。

### `src/lib/yieldMonitorTriggerV3Aggregate.ts`
- `YieldMonitorV3AggDim` 联合类型新增 `"bin" | "dutNumber"`。
- `parseDimToken` 映射表新增 `bin: "bin"`、`dutnumber: "dutNumber"`。
- `dimSql()` 新增两个 case:
  - `bin`:`NVL(LOWER(REGEXP_SUBSTR(t.TRIGGER_LABEL, 'Bin#\s*([0-9]+|goodbin)', 1, 1, 'i', 1)), '')`
  - `dutNumber`:`NVL(REGEXP_SUBSTR(t.TRIGGER_LABEL, 'on\s+dut#\s*([0-9]+)', 1, 1, 'i', 1), '')`
- 文档字符串 `YIELD_MONITOR_V3_AGGREGATE_DOCUMENTATION` 与「Missing required dimensions」错误提示文本中列举的允许维度枚举同步加上 `bin`、`dutNumber`。

### `src/lib/yieldMonitorTriggerDummy.ts`
- `valueForYieldV3Dimension()` 新增 `case "bin"`(调用 `parseBinFromTriggerLabel`)与 `case "dutNumber"`(调用现有 `parseDutNumberFromTriggerLabel`,均取 `row.TRIGGER_LABEL`,`null` 归一化为 `""` 以对齐 Oracle 的 `NVL(..., '')`)。此函数是 Dummy 聚合与 v4 Oracle 全量行聚合(`aggregateYieldMonitorV3FromRows`)的共用入口,一处改动两条路径同时生效。

### 测试
新增/扩展测试(沿用 `test/rest-api-v3-dummy.test.ts` 风格)验证:
- `dimensions=bin` 与 `dimensions=dutNumber` 在 Dummy 与 v4 路径下返回正确分组与计数。
- `bin` 维度对 `goodbin` 与数字混合数据分组正确、大小写不敏感。
- 允许维度枚举的错误提示文本已更新。

### 影响范围确认
- 不改变现有 `probeCardType`、`triggerLabel` 等既有维度行为。
- 不改变 v3 列表 `dutNumber` enrich 逻辑(仍是独立于聚合维度的字段)。
- `docs/API_V3.md` 需要在改动落地后跑 `npm run docs:api-v3` 重新生成。

## 前端改动

### `pcr-ai-report/src/reports/YieldMonitorReport.tsx`
- 新增 state:`period: "week" | "month"`(默认 `"week"`)、`appliedCoreParams`(在 `query()` 成功发起时快照 `buildCoreParams(form)` 去掉时间字段部分)、周期报警的 5 组结果 state(`periodTotal`、`periodPrevTotal`、`periodByTester`、`periodByCard`、`periodByBin`、`periodByDut`,以及 loading/error)。
- 新增 `useEffect`,依赖 `[appliedCoreParams, period, apiBase, listLimits]`,用 `allSettledWithConcurrency` 串行发起 5 个 `YIELD_AGGREGATE_PATH` 请求(4 个当前周期维度 + 1 个前一周期总量,`groupTop` 分别用 10 和 1)。
- 新增纯函数(可放 `utils/yieldCalc.ts` 或就近定义):`periodWindow(period)` 返回 `[currentStart, currentEnd, prevStart, prevEnd]`;`formatBinLabel(bin: string)`。
- section 渲染:周期 chip 切换按钮、2 张 `KpiCard`、`DraggableReportBlocks axis="grid"` 包裹的 4 图。
- `YIELD_REPORT_SECTION_ORDER` 插入 `"periodAlarm"`;`sections` 对象增加对应键。

### `pcr-ai-report/src/components/DraggableReportSections.tsx`
- `TOP_SECTION_LABELS` 增加 `periodAlarm: "周期报警统计"`。

## 不做的事(YAGNI)
- 4 个分类图表不做点击下钻(保持 section 轻量,与"每日触发量趋势"同级定位:概览而非钻取入口)。
- 不支持自定义周期长度(仅周/月两档,与用户原始需求一致)。
- 不在此 section 内重复展示已有的 probeCardType 卡型分布(该维度已在下方"图表矩阵"中存在)。
