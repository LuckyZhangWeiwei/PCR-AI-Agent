# Yield Monitor 周期报警趋势新增「YM 触发密度」独立图表 设计

日期:2026-07-08
范围包:`pcr-ai-api`(扩展 `GET …/v3/period-alarm-trend`)+ `pcr-ai-report`(周期报警趋势区块新增一张独立图表)
前置:[`2026-07-06-yield-monitor-period-trend-charts-design.md`](2026-07-06-yield-monitor-period-trend-charts-design.md)、[`../../HANDOFF_CURSOR_YIELD_MONITOR_PERIOD_ALARM_TREND_2026-07-07.md`](../../HANDOFF_CURSOR_YIELD_MONITOR_PERIOD_ALARM_TREND_2026-07-07.md)

## 背景

Yield Monitor tab 的「周期报警趋势」区块目前按周/月展示 YM(`YMWEB_YIELDMONITORTRIGGER`,`TYPE=delta_diff`)触发总量、tester/probe card 数趋势。这些数字是**绝对值**,无法看出"相对于当期实际测试量,报警是否密集"——同样是 500 次触发,如果当期只测了 200 片 wafer 和测了 2000 片 wafer,严重程度完全不同。

用户希望新增一个"发生率"口径:用同一周期内 JB STAR(`INFCONTROL⋈INFLAYERBINLIST`,`PASSTYPE='TEST'`)的测试记录数作分母,把 YM 触发总数换算成相对指标。

## 算法

```
ratio(bucket) = YM_total(bucket) / JB_total(bucket)
```

- **分子** `YM_total`:该周期桶内 `TYPE='delta_diff'` 触发记录数(`COUNT(*)`),即现有 `period-alarm-trend` 返回的 `total` 字段,不变、不去重。
- **分母** `JB_total`:该周期桶内 `PASSTYPE='TEST'` 的 JB STAR 记录数(`COUNT(*)`,一条 = 一片 wafer 的一次 pass 测试)。
- **先对分子分母各自求和,再相除一次**(不是"逐日/逐 lot 算比率再平均")。若按更细粒度先算比率再平均,会被分母很小的桶(如某天只测 1 片)放大噪声,统计上不稳健,因此采用总量比。
- **分子分母计数单位不同,比率可以超过 100%**:已用真实样本数据核实(`docs/delta-diff.xlsx`),同一片 wafer 同一个 pass 可能因为多个 bin/DUT 对同时超限、或良率持续漂移多次跌破阈值,产生多条 `delta_diff` 触发记录(样本中 142 个 `(LOTID,WAFER,PASS)` 组合有 9 个对应 2~3 条记录)。因此这个比率的准确含义是**"平均每次测试触发了几次报警"**(触发密度),不是"有百分之几的测试触发了报警"。**不对分子做 `(LOTID,WAFER,PASS)` 去重**,按用户确认的口径保留原始事件计数。
- **除零处理**:`JB_total === 0` 时 `ratio = null`(该周期没有测试记录,比率无意义),图表该点留空/断点,不显示为 0。
- **时间字段近似**:YM 按 `TIME_STAMP`(触发时刻)分桶,JB STAR 按 `TESTEND`(测试结束时刻)分桶,两者是不同表的自然时间字段,理论上可能在周期边界附近把同一次测试关联的触发和测试记录分到相邻桶。周/月粒度下影响很小,作为已知近似接受,不做跨记录精确关联。

## 筛选联动

`period-alarm-trend` 现状:请求参数来自前端 `periodAlarmQueryParams = buildPeriodAlarmQueryParams(appliedForm)`(`YieldMonitorReport.tsx:908-911`)——`appliedForm` 是点击「查询」后生效的筛选快照,包含 device/mask/lotId/wafer/hostname/platform/probeCardType/probeCard/pass/时间窗。新增的 JB STAR 分母查询**必须使用同一份 `appliedForm` 派生参数**(改名映射到 JB 参数),保证分子分母是同一筛选范围下的数字,口径一致。

字段名映射(YM 参数 → JB STAR 参数):

| YM(`appliedForm`)| JB STAR(`parseInfcontrolLayerBinsV3Query`)|
|---|---|
| `device` | `device` |
| `mask` | `mask` |
| `lotId` | `lot` |
| `wafer` | `slot` |
| `hostname` | `testerId` |
| `platform` | `platform` |
| `probeCardType` | `probeCardType` |
| `probeCard` | `cardId` |
| `pass` | `passId` |
| 桶起止时间(`timeStampFrom`/`timeStampTo` 语义) | `testEndFrom`/`testEndTo` |

JB STAR 侧固定 `PASSTYPE='TEST'`,复用现有 kk/gg/c 前缀 LOT 排除规则(`infcontrolLayerBinFilters.ts` 已有逻辑,自动继承)。

## 后端设计(`pcr-ai-api`)

### 新文件 `src/lib/infcontrolLayerBinPeriodCountTrend.ts`

镜像 `yieldMonitorPeriodAlarmTrend.ts` 的分桶 SQL 构建方式,但只需 `COUNT(*) GROUP BY bucket_idx`(不需要 distinct tester/card/bin/dut):

- `buildInfcontrolPeriodCountTrendSql(whereSql, bucketCount): string` —— 与 `buildPeriodAlarmTrendSql` 同构的 `CASE WHEN t2.TESTEND BETWEEN … THEN i END` 分桶 + `COUNT(*) AS TOTAL`,`FROM INFCONTROL t1 JOIN INFLAYERBINLIST t2 ON t1.KEYNUMBER = t2.KEYNUMBER`。
- `mapInfcontrolPeriodCountTrendRows(buckets, rows): (number | null)[]` —— 按 `bucket_idx` 取 `TOTAL`,缺失桶记 `0`(区分"查了但是 0 条"与"查询失败"由调用方处理,见下)。
- `aggregateInfcontrolPeriodCountTrendDummy(applied, buckets): (number | null)[]` —— 复用 `filterInfcontrolLayerBinV3DummyRowsMatching` 的筛选逻辑。该函数内部计算 `offset = maxTs > 0 ? Date.now() - maxTs : 0`(`infcontrolLayerBinDummy.ts:500-503`)目前是私有实现,不对外暴露;本次改动需将这段偏移计算抽成新导出函数 `infcontrolLayerBinDummyTimeOffsetMs(rows: readonly InfcontrolLayerBinDummyRow[]): number`,供 `filterInfcontrolLayerBinV3DummyRowsMatching` 和新的 `aggregateInfcontrolPeriodCountTrendDummy` 共用同一份计算,避免复制一份产生 dummy-parity 漂移(与 `yieldMonitorPeriodAlarmTrend.ts` 复用 `yieldMonitorDummyTimeOffsetMs` 的既有模式一致)。

### 响应结构变更(`period-alarm-trend`)

`PeriodAlarmTrendPoint` 新增两个字段(`yieldMonitorPeriodAlarmTrend.ts`):

```ts
export type PeriodAlarmTrendPoint = {
  // ...existing fields unchanged...
  jbTotal: number | null; // 该周期 JB STAR 匹配到的测试记录数;查询失败为 null
  ratio: number | null;   // total / jbTotal;jbTotal 为 0 或 null 时为 null
};
```

顶层响应可选新增 `jbTotalError?: string`,仅在 JB STAR 查询失败时出现,供排查用,不影响 `buckets` 正常渲染。

### `yieldMonitorRoutes.ts` 中 `period-alarm-trend` handler 改动

在现有 YM 查询(`withProbeWebConnection`)之外,追加一次 `withConnection`(main 连接池)调用 JB STAR 统计 SQL:

- 构造 JB 查询参数:取 `parsed.applied` 中对应字段按上表改名,加上 `testEndFrom = spanFrom`、`testEndTo = spanTo`(与 YM 用的桶总跨度一致),调用 `parseInfcontrolLayerBinsV3Query` 得到 `whereSql`/`binds`。
- Oracle 分支:执行 `buildInfcontrolPeriodCountTrendSql`,映射到各桶 `jbTotal`。
- Dummy 分支(`infcontrolLayerBinsUseDummy()` 为真时):调用 `aggregateInfcontrolPeriodCountTrendDummy`。
- **失败降级**:JB STAR 查询(Oracle 或 Dummy)抛错时 **不让整个请求 500**——`catch` 后所有桶 `jbTotal: null, ratio: null`,顶层加 `jbTotalError: message`;YM 部分(`total`/`testerCount`/`cardCount`/`binCount`/`dutCount`)正常返回。
- 每个桶算 `ratio = jbTotal && jbTotal > 0 ? total / jbTotal : null`。

### Dummy-Oracle Parity 检查清单

- [ ] `buildInfcontrolPeriodCountTrendSql`(Oracle)与 `aggregateInfcontrolPeriodCountTrendDummy`(Dummy)对同一 `applied` 筛选返回一致的分桶计数。
- [ ] 筛选字段映射(mask/probeCardType/lot/slot/testerId/platform/passId)两侧一致。
- [ ] `PASSTYPE='TEST'` 固定、kk/gg/c LOT 前缀排除两侧一致(复用现有 `parseInfcontrolLayerBinsV3Query`/`filterInfcontrolLayerBinV3DummyRowsMatching`,天然继承)。

## 前端设计(`pcr-ai-report`)

### 类型

`api/types.ts` 的 `YieldMonitorPeriodAlarmTrendResponse`(桶 point 类型)新增 `jbTotal`、`ratio`;`YieldMonitorReport.tsx` 本地 `TrendPoint` 透传 `ratio`(`jbTotal` 前端暂不单独使用,只用于 tooltip 展示原始数字,可选透传)。

### 新增独立图表(不叠加在现有柱图上)

- 新增 `trendRatioOption`(`useMemo`),复用现有 `buildTrendBarOption(theme, buckets, values, color)` 构建方式,与「触发总和」「Tester 数」「Probe Card 数」三张趋势图风格一致(柱状图,不做折线/双轴)。
- **y 轴不锁 0–100%**:比率可能超过 100%,轴按数据自适应最大值(`buildTrendBarOption` 现有的 `yAxis: { type: "value" }` 默认行为已满足,无需特殊处理)。
- 数值格式化为百分比(`×100` 保留 1 位小数,如 `195.3%`),空桶(`ratio === null`)不画柱。
- Tooltip 同时显示 `YM 次数`、`JB STAR 测试数`、算出的比率,方便核对(不是"发生率",避免暗示有界百分比的误解)。

### 布局接入

- 复用现有 `pcr-ai-report:yield-monitor-alarm-trend-chart-blocks`(见前置设计文档)的 `DraggableReportBlocks`,新增一个块 id `chAlarmRatioTrend`,追加到 `YIELD_ALARM_TREND_CHART_BLOCK_ORDER` 末尾,`labels` 增加 `chAlarmRatioTrend: "触发密度趋势"`。
- 标签随周期 chip 变化,复用现有 `periodAlarmTotalTrendLabel` 等命名模式:`period === "week" ? "每周触发密度" : "每月触发密度"`。

## 不做的事(YAGNI)

- 不支持季/年周期(仍只有周/月两档,与现有 chip 一致)。
- 不做"有报警的测试占比"(需要对 YM 按 `(LOTID,WAFER,PASS)` 去重的另一种口径)——用户已明确选择保留原始触发密度口径。
- 不做触发记录与 JB STAR 测试记录的跨表精确关联(按 `TIME_STAMP`/`TESTEND` 差值配对),时间字段错位作为已知近似接受。
- 不新增比率图的点击下钻,与其余三张趋势图保持一致的"概览"定位。
- 不改动「不联动查询表单/仅查询后触发」的既有交互(仍是点「查询」后按 `appliedForm` 生效,不随输入框实时刷新)。

## 测试计划

- `pcr-ai-api`:新增/扩展单测覆盖——分桶计数、`PASSTYPE='TEST'` 固定、字段映射(mask/probeCardType/lot/slot/testerId/passId)、Dummy 与 Oracle 双路径的时间偏移一致性、`ratio` 除零/JB 查询失败降级为 `null` 且不影响 YM 部分。
- `npm run typecheck`(两包)+ `npm test`(`pcr-ai-api`)。
- 前端手动验证:Dummy 模式下起 `npm run dev`,确认新图表出现、断点桶正确留空、比率可超 100% 时正常显示不报错。
