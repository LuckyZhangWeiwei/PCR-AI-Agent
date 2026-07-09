# Cursor 交接（2026-07-09 · JB 分母 · 给 Claude Code）

> **执行者：** Cursor Agent  
> **读者：** Claude Code / 接手 Yield Monitor「周期报警统计 · Tester 报警频率」的 Agent  
> **分支：** `main`（本 commit push 后）  
> **前置：**  
> - [`HANDOFF_CURSOR_YIELD_MONITOR_PERIOD_ALARM_TREND_2026-07-07.md`](HANDOFF_CURSOR_YIELD_MONITOR_PERIOD_ALARM_TREND_2026-07-07.md) — `period-alarm-trend` 基础 API  
> - [`HANDOFF_CURSOR_YIELD_MONITOR_ALARM_RATE_AND_TOP5_2026-07-09.md`](HANDOFF_CURSOR_YIELD_MONITOR_ALARM_RATE_AND_TOP5_2026-07-09.md) — 报警频率 Tab、Top5 hover、Oracle `LENGTH(hostname)` 修复（`dbf31f0`）

---

## 0. 一眼结论

| 项 | 状态 | 说明 |
|---|---|---|
| **Tester 报警频率分母（最终口径）** | ✅ 本 commit | **该桶同期同筛选下，JB Start 全部 distinct (LOT, SLOT)**；PASSTYPE 与 JB Star v3 一致；**不含 RETESTBIN** |
| **不再限定「出过报警的 tester」** | ✅ | 已删除 YM `alarmHosts` 子查询；分母与报警机台集合解耦 |
| **PASSTYPE 范围** | ✅ | `TEST` / `INTERRUPT` / `TEST ISR` / `TEST INTERRUPT` + 排除 `LAYERNAME=Abandoned`（`infcontrolLayerBinV3BaseWhereBlock`） |
| **双库查询** | ✅ | YM：`withProbeWebConnection`；JB 分母：`withConnection`（main pool） |
| **Dummy parity** | ✅ | `filterInfcontrolLayerBinV3DummyRowsMatching` + `countJbDistinctSlotsInBucket` |
| **单测** | ✅ | `yieldMonitorPeriodAlarmTrend.test.ts` **15/15** |
| **部署** | ⏭ API 必做 | **仅部署 API 即可得到正确数值**；报表改动仅为 Tab 下说明文案（可选） |
| **真库部署后复验** | ⏭ 待做 | 期望 `testerActivityTotal` 显著大于 `total`，`testerAlarmRate` 明显低于旧 ~80% YM 分母 |

---

## 1. 分母口径演进（勿混用）

| 阶段 | 分母定义 | 典型比率 | 状态 |
|---|---|---|---|
| A · 初版 `dbf31f0` | YM `YMWEB_YIELDMONITORTRIGGER` 全 TYPE，仅限该桶出过 `delta_diff` 的 tester | ~73–96%，均 ~82.6% | 已 supersede |
| B · 中间稿（未单独部署） | JB distinct slot，**仅**该桶 YM 报警 tester | 低于 A，仍偏高 | 已 supersede |
| C · **本 commit（最终）** | **该桶全部 JB Start distinct (LOT, SLOT)**，v3 PASSTYPE，同期同筛选 | 预期最低、最合理 | ✅ 目标口径 |

### 1.1 最终公式（每桶）

```
testerAlarmRate = testerAlarmNumerator / testerActivityTotal
```

| 字段 | 含义 |
|---|---|
| `testerAlarmNumerator` | 桶内 YM `delta_diff` 报警行数（= `total`） |
| `testerActivityTotal` | 桶内 **全部** JB Start **distinct (LOT, SLOT)** 数（按 `TESTEND` 分桶） |
| `testerAlarmRate` | 比率；分母为 0 时 `null` |

**分子不变**；仅分母从 YM 活动量 → JB slot（且不再过滤 alarm tester）。

### 1.2 PASSTYPE / LAYERNAME（与 JB Star v3 对齐）

复用 `pcr-ai-api/src/lib/infcontrolLayerBinPasstypeScope.ts`：

| 计入 | 排除 |
|---|---|
| `TEST` | `RETESTBIN` / `RETEST`（Auto retest） |
| `INTERRUPT` | `NA` |
| `TEST ISR` | `LAYERNAME = Abandoned` |
| `TEST INTERRUPT` | |

Oracle WHERE 片段：`infcontrolLayerBinV3BaseWhereBlock("t2", jbAnd)`。

### 1.3 筛选联动（YM → JB 映射）

`mapPeriodAlarmFiltersToJbQuery`（`yieldMonitorPeriodAlarmTrend.ts`）：

| YM 查询键 | JB 键 |
|---|---|
| `timeStampFrom/To`（桶 span） | `testEndFrom/To` |
| `lotId` | `lot` |
| `hostname` | `testerId` |
| `probeCard` | `cardId` |
| `pass` | `passId` |
| `device` / `mask` 等 | 透传（JB v3 解析） |

删除：`wafer`、`type`、`platform`（JB 无对应列）。

---

## 2. 后端架构（`pcr-ai-api`）

### 2.1 请求链路

```
GET /api/v3/yield-monitor-triggers/v3/period-alarm-trend
  │
  ├─ probeweb pool
  │    ├─ buildPeriodAlarmTrendSql        → total / testerCount / …
  │    └─ buildPeriodAlarmTrendTopTestersSql → topTesters
  │
  └─ main Oracle pool
       └─ buildPeriodAlarmJbSlotTuplesSql  → bucket_idx, lot, slot
            mergePeriodAlarmJbSlotDenominator(points, jbSlotRows)
```

**已删除：** `buildPeriodAlarmYmAlarmHostsSql` + `periodAlarmTrendAlarmHostsBinds`（不再需要 YM 报警机台集合）。

### 2.2 关键文件

| 文件 | 作用 |
|---|---|
| `src/lib/yieldMonitorPeriodAlarmTrend.ts` | `parsePeriodAlarmTrendQuery`（含 `jbSlotWhereAndSql`）；`buildPeriodAlarmJbSlotTuplesSql`；`mergePeriodAlarmJbSlotDenominator`；Dummy `countJbDistinctSlotsInBucket` |
| `src/lib/infcontrolLayerBinPasstypeScope.ts` | v3 PASSTYPE 白名单 + `LAYERNAME <> Abandoned` |
| `src/lib/infcontrolLayerBinFilters.ts` | `parseInfcontrolLayerBinsV3Query` → JB AND 片段 |
| `src/routes/yieldMonitorRoutes.ts` | 双连接：probeweb 主查询 + main JB 分母 |
| `test/yieldMonitorPeriodAlarmTrend.test.ts` | 15 项（含 merge 全量 slot、bind parity、Dummy 频率） |

### 2.3 JB 分母 SQL 要点

```sql
-- buildPeriodAlarmJbSlotTuplesSql
SELECT bucket_idx, lot, slot
FROM (
  SELECT CASE WHEN t2.TESTEND BETWEEN :bN_from AND :bN_to THEN N … END AS bucket_idx,
         TRIM(t1.LOT) AS lot, t1.SLOT AS slot
  FROM INFCONTROL t1
  INNER JOIN INFLAYERBINLIST t2 ON t1.KEYNUMBER = t2.KEYNUMBER
  WHERE UPPER(TRIM(t2.PASSTYPE)) IN ('TEST','INTERRUPT','TEST ISR','TEST INTERRUPT')
    AND UPPER(TRIM(t2.LAYERNAME)) <> 'ABANDONED'
    AND … -- jbSlotWhereAndSql（device / lot / testerId / testEnd 等）
) src
WHERE bucket_idx IS NOT NULL AND lot IS NOT NULL AND LENGTH(lot) > 0
GROUP BY bucket_idx, lot, slot
```

Node 侧 `mergePeriodAlarmJbSlotDenominator` 按 `bucket_idx` 对 `(lot, slot)` 去重计数 → `testerActivityTotal`。

### 2.4 Dummy 路径

`aggregatePeriodAlarmTrendDummy(applied, buckets, jbSlotApplied)`：

- YM 行：`filterYieldMonitorDummyRowsMatchingV3(applied)`  
- JB 行：`filterInfcontrolLayerBinV3DummyRowsMatching(jbSlotApplied)`（已含 v3 PASSTYPE + Abandoned）  
- 分桶：`countJbDistinctSlotsInBucket(jbRows, bucket)` — **不过滤 alarm tester**

改 WHERE / 分桶 / 响应时须同步 Dummy（**dummy-parity**）。

### 2.5 响应形状（字段名未变）

```json
{
  "period": "week",
  "buckets": [{
    "label": "07/03-07/09",
    "total": 436,
    "testerAlarmNumerator": 436,
    "testerActivityTotal": 12500,
    "testerAlarmRate": 0.0349,
    "topTesters": [{ "hostname": "host-a", "count": 42 }]
  }]
}
```

> 字段仍叫 `testerActivityTotal`（历史命名）；语义已是 **JB distinct slot 总数**，非 YM tester 活动量。

---

## 3. 前端（`pcr-ai-report` · 可选部署）

| 文件 | 改动 |
|---|---|
| `src/reports/YieldMonitorReport.tsx` | Tab 下说明：「该桶 JB Start 全部 distinct slot…(v3 PASSTYPE) |
| `src/api/types.ts` | JSDoc 注释同步 |

**图表逻辑未改** — 读 API 的 `testerAlarmRate` / `testerActivityTotal` 即可。仅部署 API 后数值即正确。

---

## 4. 部署与验证

### 4.1 部署（API 必做）

```bash
cd pcr-ai-api && npm ci && npm run build && npm run pm2:reload
```

报表（可选，仅文案）：

```bash
cd pcr-ai-report && npm ci && npm run build && npm run pack:dist
```

### 4.2 单测

```bash
cd pcr-ai-api && npx tsx --test test/yieldMonitorPeriodAlarmTrend.test.ts
# 期望 15/15 pass
```

### 4.3 真库 smoke（部署后必做）

```bash
NOW=2026-07-09T04:46:20.977Z
BASE=http://10.192.130.89:30008/api/v3/yield-monitor-triggers/v3/period-alarm-trend

curl -s "$BASE?period=week&now=$NOW" \
  | jq '.buckets[-1] | {label,total,testerActivityTotal,testerAlarmRate,topTesters}'

curl -s "$BASE?period=month&now=$NOW" \
  | jq '.buckets[-1] | {label,total,testerActivityTotal,testerAlarmRate,topTesters}'
```

**期望：**

- `testerActivityTotal >> total`（全厂 JB slot 分母远大于报警次数）  
- `testerAlarmRate` 为小数（通常 **≪ 80%**；若仍 ~80% 说明线上仍是旧 YM 分母或未 reload）  
- `topTesters` 长度 1～5  
- `testerActivityTotal > 0` 时 `testerAlarmRate != null`

### 4.4 浏览器

1. Yield Monitor → 周期报警统计 → 查询  
2. Tester 趋势 → **报警频率** Tab → 折线应为较低百分比  
3. hover 桶 → Top 5 仍正常  

---

## 5. 勿改坏

- **dummy-parity：** JB 分母改动须同步 `infcontrolLayerBinDummy.ts` + `aggregatePeriodAlarmTrendDummy`。  
- **PASSTYPE：** 勿改回 `PASSTYPE='TEST'` 单值；与 JB Star v3 报表保持一致。  
- **勿恢复 `hostname != ''`**（Oracle 空串陷阱 → 分母/Top5 全 0）。  
- **勿把分母再绑回「报警 tester」** — 产品已确认要全量 JB slot。  
- **oracledb 5.5 / no undici：** 见根 `CLAUDE.md` Hard rules。

---

## 6. 相关 commit / 文档

| 引用 | 说明 |
|---|---|
| `dbf31f0` | 报警频率 Tab + Top5 + Oracle `LENGTH(hostname)`（旧 YM 分母） |
| **本 commit** | JB 全量 slot 分母 + v3 PASSTYPE + 删 alarmHosts 查询 |
| [`HANDOFF_CURSOR_YIELD_MONITOR_ALARM_RATE_AND_TOP5_2026-07-09.md`](HANDOFF_CURSOR_YIELD_MONITOR_ALARM_RATE_AND_TOP5_2026-07-09.md) | Tab / Top5 / Oracle 修复（§0 分母行已过时，以本文为准） |
