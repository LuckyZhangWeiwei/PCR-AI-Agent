# Cursor 交接（2026-07-07 · 给 Claude Code）

> **执行者：** Cursor Agent  
> **读者：** Claude Code / 接手 Yield Monitor「周期报警统计」的 Agent  
> **分支：** `feat/jb-route-resolver`  
> **前置：** 周期趋势柱图已合入 `158672e`；查询解耦与「周/月」文案 `bb98b15`

---

## 0. 一眼结论

| 项 | 状态 | 说明 |
|---|---|---|
| **周期报警 UI** | ✅ | 「周 \| 月」chip；5 张趋势柱图；**不随「查询」联动**（`PERIOD_ALARM_CORE_PARAMS` 无筛选） |
| **新 API** | ✅ 已合入，⏭ **待部署** | `GET /api/v3/yield-monitor-triggers/v3/period-alarm-trend?period=week\|month&now=<ISO>` |
| **16→1 请求** | ✅ | 单次 Oracle 扫描返回 4 桶 × 5 指标 |
| **Bin 不含 goodbin** | ✅ | `COUNT(DISTINCT CASE WHEN bin_v NOT IN ('','goodbin') …)`；图表标题 **「坏 Bin 种类数趋势」** |
| **Tester/Card 种类** | ✅ | `COUNT(DISTINCT hostname/probeCard)`，不再被 `groupTop=100` 截断 |
| **正式库验证（旧接口）** | ✅ | 月 4 桶 total 之和 = 并集 5484；周/月边界无重复计数 |
| **部署后复验** | ⏭ 待做 | 见 §5 |

---

## 1. 本次改动摘要

### 1.1 后端（`pcr-ai-api`）

| 文件 | 作用 |
|---|---|
| `src/lib/yieldMonitorPeriodAlarmTrend.ts` | `recentPeriodBuckets`、`buildPeriodAlarmTrendSql`、`aggregatePeriodAlarmTrendDummy`、`parsePeriodAlarmTrendQuery` |
| `src/routes/yieldMonitorRoutes.ts` | 挂载 `GET …/v3/period-alarm-trend` |
| `test/yieldMonitorPeriodAlarmTrend.test.ts` | 桶划分、SQL goodbin 排除、Dummy 聚合（含时间偏移） |

**响应形状：**

```json
{
  "period": "week",
  "filters": { "typeScope": "delta_diff", "timeStampFrom": "…", "timeStampTo": "…" },
  "buckets": [
    {
      "label": "06/30-07/07",
      "timeStampFrom": "…",
      "timeStampTo": "…",
      "total": 470,
      "testerCount": 78,
      "cardCount": 112,
      "binCount": 4,
      "dutCount": 37
    }
  ]
}
```

**Bin / DUT 数据来源：** 均从 `TRIGGER_LABEL` 正则解析（非独立列）。Bin 自 `Bin#\s*([0-9]+|goodbin)`；DUT 自 `on dut#\s*(\d+)`。

**Dummy 注意：** `aggregatePeriodAlarmTrendDummy` 须用与 `filterYieldMonitorDummyRowsMatchingV3` 相同的 **`timeOffsetMs`** 做分桶，否则 dev Dummy 下全 0。

### 1.2 前端（`pcr-ai-report`）

| 文件 | 作用 |
|---|---|
| `src/api/paths.ts` | `YIELD_PERIOD_ALARM_TREND_PATH` |
| `src/api/types.ts` | `YieldMonitorPeriodAlarmTrendResponse` |
| `src/reports/YieldMonitorReport.tsx` | 优先调新 API；404 时 **legacy fallback**（16 次 aggregate + `countBadBinKinds` 滤 goodbin） |

---

## 2. 与旧实现的差异

| 维度 | 旧（16× aggregate） | 新（period-alarm-trend） |
|---|---|---|
| HTTP 次数 | 16（串行 fanout=1） | 1 |
| Tester/Card 数 | `groups.length`，月视图常 **=100 触顶** | `COUNT(DISTINCT …)` 真值 |
| Bin 种类 | 含 **goodbin** 作为一种 | **排除 goodbin** |
| 总触发 | `totalRowsMatching` | 不变（仍含 goodbin 触发行） |

---

## 3. 正式库核查实录（2026-07-07 · 旧接口）

**环境：** `http://10.192.130.89:30008`（部署新 API **前**）

### 月模式

| 月份 | total | 备注 |
|---|---|---|
| 2026-04 | 1862 | 完整自然月 |
| 2026-05 | 1679 | 完整自然月 |
| 2026-06 | 1518 | 完整自然月；旧 binKinds=11，去 goodbin **=10** |
| 2026-07 | ~425 | 不完整月（1 日至今） |

4 桶 sum = union = **5484**（无边界重复）。

### 周模式

4 桶 sum = union = **1466**（无边界重复）。

### Bin / DUT 覆盖率（近 1 年 delta_diff）

- **bin**（含 goodbin）：100% 可解析  
- **dutNumber**：21465/21502（37 条 `TRIGGER_LABEL` 无 `on dut#`）

---

## 4. 已知限制

1. **月桶时区：** `recentPeriodBuckets('month')` 用 **服务器/浏览器本地** `new Date(y,m,1)`；前端传 `now=<ISO>`。生产服务器 UTC+8 与 ATTJ 用户一致即可。  
2. **总触发仍含 goodbin 行：** 仅「坏 Bin 种类数」排除 goodbin；若产品要求 total 也排除，需另改 SQL `WHERE bin_v != 'goodbin'`。  
3. **Legacy fallback：** 新 API 404 时仍用旧 aggregate，Tester/Card 仍可能触顶 100。  
4. **manifest：** 未自动写入 `apiManifest.ts`；若 Agent 需发现此端点，可补 manifest 条目。

---

## 5. 部署与复验

### API

```bash
cd pcr-ai-api
npm ci && npm run build && npm run pm2:reload
```

### 报表

```bash
cd pcr-ai-report
npm ci && npm run build && npm run pack:dist
# 解压 dist.tar 到 nginx 根
```

### curl  smoke

```bash
curl -s "http://10.192.130.89:30008/api/v3/yield-monitor-triggers/v3/period-alarm-trend?period=month&now=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" | jq '.buckets[] | {label,total,testerCount,cardCount,binCount,dutCount}'
```

**期望：**

- HTTP 200（非 404）  
- `buckets.length === 4`  
- 2026-06 的 `binCount` **比旧 UI 少 1**（去掉 goodbin）  
- 2026-04～06 的 `testerCount` / `cardCount` **可 >100**

### 单测

```bash
cd pcr-ai-api && npx tsx --test test/yieldMonitorPeriodAlarmTrend.test.ts
```

---

## 6. 相关 commit（本分支）

| Commit | 说明 |
|---|---|
| `158672e` | 周期报警改为近 4 周/月趋势柱图 |
| `bb98b15` | 周期报警与「查询」解耦；「本周/本月」→「周/月」 |
| *本次* | `period-alarm-trend` API；goodbin 排除；16→1 请求；legacy fallback |

---

## 7. 勿改坏

- **dummy-parity：** 改 `yieldMonitorPeriodAlarmTrend.ts` 的 WHERE/桶/响应时，同步 Dummy 路径。  
- **周期报警仍不读查询表单：** 勿恢复 `setAppliedCoreParams(core)` 于 `query()`。  
- **oracledb 5.5 / no undici：** 见根 `CLAUDE.md` Hard rules。
