# Cursor 交接（2026-07-09 · 给 Claude Code）

> **执行者：** Cursor Agent  
> **读者：** Claude Code / 接手 Yield Monitor「周期报警统计」的 Agent  
> **分支：** `main`（本次合入后 push）  
> **前置：** [`docs/HANDOFF_CURSOR_YIELD_MONITOR_PERIOD_ALARM_TREND_2026-07-07.md`](HANDOFF_CURSOR_YIELD_MONITOR_PERIOD_ALARM_TREND_2026-07-07.md) — `period-alarm-trend` 基础 API、16→1、goodbin 排除

---

## 0. 一眼结论

| 项 | 状态 | 说明 |
|---|---|---|
| **Tester 报警频率 Tab** | ✅ 已合入 | 与「Tester 数」同 section 内 chip 切换；折线图 y 轴为百分比 |
| **报警频率口径（方案一）** | ✅ | 分子 = 桶内 `delta_diff` 触发次数（`total`）；分母 = 同期同筛选下、**该桶内出过报警的 tester** 在 YM **全 TYPE** 记录总数 |
| **Top 5 Tester hover** | ✅ 前端 | 总和柱图 / Tester 数柱图 / 报警频率折线图 tooltip 均展示 Top 5（数据来自 API `topTesters`） |
| **周 \| 月联动** | ✅ | 总和、Tester 数、报警频率、Top5 文案前缀随 `period=week\|month` 切换 |
| **Oracle `ORA-01036`（month）** | ✅ 已修 | 主 SQL 改为单次 `bucketed` CTE；主/Top 查询分 bind |
| **Oracle 空串陷阱（分母/Top5 全 0）** | ✅ 已修 | 禁止 `hostname != ''`；改用 `LENGTH(hostname) > 0` |
| **真库部署后复验** | ⏭ 待做 | 2026-07-09 部署前 curl：`testerActivityTotal=0`、`topTesters=[]`、`testerAlarmRate=null` |

---

## 1. 业务口径

### 1.1 Tester 报警频率（每桶）

```
testerAlarmRate = testerAlarmNumerator / testerActivityTotal
```

| 字段 | 含义 |
|---|---|
| `testerAlarmNumerator` | 桶内 `delta_diff` 报警行数（= `total`） |
| `testerActivityTotal` | 桶内「曾在该桶出过 `delta_diff` 的 hostname」在 YM **全 TYPE** 上的行数之和 |
| `testerAlarmRate` | 比率；分母为 0 时 `null` |

**筛选联动：** 与周期报警区块共用 `periodAlarmQueryParams`（device / lot / hostname / 时间窗等），**不**再限 `TYPE=delta_diff` 于分母扫描（见 `parseYieldMonitorTriggerActivityQuery`）。

### 1.2 Top 5 Tester（每桶）

按桶内 `delta_diff` 触发 **次数** 降序取 Top 5 `{ hostname, count }`；与报警频率分母无关。

---

## 2. 后端改动（`pcr-ai-api`）

| 文件 | 作用 |
|---|---|
| `src/lib/yieldMonitorTriggerFilters.ts` | 新增 `parseYieldMonitorTriggerActivityQuery`（联动筛选，**不**固定 `TYPE=delta_diff`） |
| `src/lib/yieldMonitorTriggerDummy.ts` | 新增 `filterYieldMonitorDummyRowsMatchingActivity`（Dummy 分母路径） |
| `src/lib/yieldMonitorPeriodAlarmTrend.ts` | 扩展响应字段；`bucketed` CTE 主 SQL；`EXISTS` 算分母；Top5 子查询改走 activity 扫描 + `is_alarm_row` |
| `src/routes/yieldMonitorRoutes.ts` | 主查询 `periodAlarmTrendMainBinds`；Top5 `periodAlarmTrendTopBinds`（现同 main）；`normalizeDbRowKeysUpper` |
| `test/yieldMonitorPeriodAlarmTrend.test.ts` | 13 项单测（周/月 bind parity、Dummy 频率、Top5 attach） |

### 2.1 响应形状（新增字段）

```json
{
  "period": "week",
  "buckets": [
    {
      "label": "07/09-07/16",
      "total": 436,
      "testerCount": 77,
      "testerAlarmNumerator": 436,
      "testerActivityTotal": 1820,
      "testerAlarmRate": 0.2396,
      "topTesters": [
        { "hostname": "host-a", "count": 42 },
        { "hostname": "host-b", "count": 38 }
      ]
    }
  ]
}
```

### 2.2 Oracle 陷阱（必读）

1. **`ORA-01036`**：桶 bind `:b0_from` 等在 SQL 中出现两次时，勿把 v3 + v3a bind 合并后一次 `execute`。现主查询仅 `activityBinds` + 桶 bind；Top5 与主查询共用 activity 扫描。  
2. **`hostname != ''`**：Oracle 空串即 NULL，`col != ''` 对非空列结果为 UNKNOWN，**过滤掉所有行**。曾导致 `testerActivityTotal=0`、`topTesters=[]`。已改为 `LENGTH(hostname) > 0`。  
3. **goodbin 排除**：仍用 `bin_v != 'goodbin'`，勿改成 `NOT IN ('', …)`。

### 2.3 端点

```
GET /api/v3/yield-monitor-triggers/v3/period-alarm-trend
  ?period=week|month
  &now=<ISO>
  &timeStampFrom=&timeStampTo=
  （及 device / lot / hostname / mask / … 联动筛选）
```

---

## 3. 前端改动（`pcr-ai-report`）

| 文件 | 作用 |
|---|---|
| `src/api/types.ts` | `PeriodAlarmTopTester`、`testerAlarmRate`、`testerActivityTotal` 等 |
| `src/reports/YieldMonitorReport.tsx` | Tester section 内 Tab（数 / 频率）；`buildTrendTotalBarOption` / `buildTrendLineOption` / `buildTrendBarOption` tooltip Top5；`resolveTesterAlarmRate` 回退；周/月 `key={period}` 重绘 |
| `src/index.css` | `.tester-trend-tabs` 与 `.chart-no-drill` 光标分离；趋势 series `cursor: default` |

### 3.1 UI 结构

- **周期报警统计** 区块：周 \| 月 chip → 4 张排名图 + 3 张趋势图（总和 / Tester / Card）  
- **Tester 趋势** 内嵌 chip：`每周|每月 Tester 数` \| `每周|每月 报警频率`  
- Tab 按钮在 `chart-no-drill` **外**（可点击手型）；图表区保留禁止下钻光标  

### 3.2 Tooltip Top 5

hover 任一周/月桶时展示（有数据时）：

```
每周 10/15-10/22
每周触发总和: 590
每周 Top 5 Tester:
host-a: 42
host-b: 38
…
```

报警频率折线图、Tester 数柱图同样展示 Top 5。

### 3.3 Legacy fallback

新 API 404 时仍走 16× aggregate fallback；**无** `testerAlarmRate` / API `topTesters`，仅 aggregate hostname groups 推导 Top5（总和图）。

---

## 4. 真库验证实录（2026-07-09 · 部署修复前）

**环境：** `http://10.192.130.89:30008`

| 检查 | week | month |
|---|---|---|
| HTTP | 200 | 200（`ORA-01036` 已不再） |
| 桶数 | 53 | 13 |
| `total` / `testerCount` | ✅ 正常 | ✅ 正常 |
| `testerActivityTotal` | ❌ 全 0 | ❌ 全 0 |
| `testerAlarmRate` | ❌ 全 null | ❌ 全 null |
| `topTesters` | ❌ 全 `[]` | ❌ 全 `[]` |

**根因：** 线上仍为旧 SQL（`hostname != ''` + 旧 Top 查询）。部署本 commit 后应恢复。

### 4.1 部署后 smoke（Claude Code 必做）

```bash
NOW=2026-07-09T04:46:20.977Z
BASE=http://10.192.130.89:30008/api/v3/yield-monitor-triggers/v3/period-alarm-trend

# 周
curl -s "$BASE?period=week&now=$NOW" | jq '.buckets[0] | {label,total,testerActivityTotal,testerAlarmRate,topTesters}'

# 月
curl -s "$BASE?period=month&now=$NOW" | jq '.buckets[0] | {label,total,testerActivityTotal,testerAlarmRate,topTesters}'
```

**期望：**

- `testerActivityTotal > 0`（通常 ≥ `total`）  
- `testerAlarmRate` 为 0～1 小数  
- `topTesters` 长度 1～5，按 `count` 降序  

### 4.2 单测

```bash
cd pcr-ai-api && npx tsx --test test/yieldMonitorPeriodAlarmTrend.test.ts
# 期望 13/13 pass
```

### 4.3 浏览器

1. Yield Monitor → 周期报警统计 → 选「周」→ 点「查询」  
2. **触发总和** hover 某桶 → 见 Top 5  
3. **Tester 数 / 报警频率** Tab 切换 → 折线/柱图有数据；hover 见 Top 5  
4. 切「月」→ 同上；图表区禁止下钻光标，Tab 为手型  

---

## 5. 部署命令

```bash
# API
cd pcr-ai-api && npm ci && npm run build && npm run pm2:reload

# 报表
cd pcr-ai-report && npm ci && npm run build && npm run pack:dist
# 解压 dist.tar 到 nginx 根
```

---

## 6. 勿改坏

- **dummy-parity：** 改 WHERE / 分桶 / 响应时同步 `yieldMonitorTriggerDummy.ts` + `aggregatePeriodAlarmTrendDummy`。  
- **勿恢复 `hostname != ''`** 于 Oracle SQL（见 `oracleStringSql.ts` / P-A handoff）。  
- **周期报警与查询联动：** 本功能**已**与查询表单联动（与 2026-07-07 文档「不随查询联动」不同 — 若产品仍要求解耦，需与 PO 确认后再改 `PERIOD_ALARM_CORE_PARAMS`）。  
- **oracledb 5.5 / no undici：** 见根 `CLAUDE.md` Hard rules。

---

## 7. 相关文档

| 文档 | 关系 |
|---|---|
| [`HANDOFF_CURSOR_YIELD_MONITOR_PERIOD_ALARM_TREND_2026-07-07.md`](HANDOFF_CURSOR_YIELD_MONITOR_PERIOD_ALARM_TREND_2026-07-07.md) | 基础 period-alarm-trend |
| [`HANDOFF_AGENT_ISSUES_2026-06-27_ROUND2.md`](HANDOFF_AGENT_ISSUES_2026-06-27_ROUND2.md) | Oracle `TRIM/空串` 通用陷阱 |

---

## 8. 附带改动

- `pcr-ai-report/src/reports/InfcontrolReport.tsx`：JB 明细区增加 scope hint「仅 first test，不含 Auto retest」。
