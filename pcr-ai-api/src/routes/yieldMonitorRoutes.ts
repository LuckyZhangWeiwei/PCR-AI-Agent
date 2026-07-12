import { Router } from "express";
import {
  handleYieldMonitorTriggers,
  handleYieldMonitorTriggersV3,
  handleYieldMonitorTriggersV3Aggregate,
  handleYieldMonitorTriggersV3Combined,
  handleYieldMonitorTriggersV3PeriodAlarmTrend,
  handleYieldMonitorTriggersV4,
  handleYieldMonitorTriggersV4Aggregate,
} from "../lib/yieldMonitor/handlers/yieldMonitorTriggersHandlers.js";

export const yieldMonitorRouter = Router();

/**
 * YMWEB_YIELDMONITORTRIGGER（Oracle 账号 probeweb），复合条件 AND，固定 Top 200，
 * 按 TIME_STAMP DESC；另可在**同一筛选**下对全量匹配行做 PROBECARD / HOSTNAME 分组计数（见 probeCardSummary、hostnameSummary）。
 *
 * 查询参数（可选，键名不区分大小写）：hostname, device, lotId, wafer, type,
 * triggerLabel, probeCard；数值 pass, id；时间 timeStampFrom / timeStampTo（ISO 8601）；
 * includeProbeCardSummary（默认 true，传 false 跳过探针卡与机台两次 GROUP BY）。
 */
yieldMonitorRouter.get("/yield-monitor-triggers", handleYieldMonitorTriggers);

/**
 * **v3** 产量监控：`YMWEB_YIELDMONITORTRIGGER` 全列；**固定** **`TYPE = delta_diff`**（Oracle **`UPPER(TRIM(t."TYPE"))`**；Dummy 同步）。每行 JSON 另含 **`dutNumber`**（从 **`TRIGGER_LABEL`** 中 **`on dut# …`** 解析，无则 **`null`**）与 **`PROBECARDTYPE`**（**`PROBECARD`** 按首个 **`-`** 拆出的前段）。**`YIELD_MONITOR_TRIGGERS_DUMMY=true`**（且非 `dist`/production）时走 **`docs/delta-diff.xlsx`** 内存样本；否则 **probeweb Oracle**。
 * 查询参数：`UPPER(TRIM)` 字符串筛选、时间窗等（**不支持** **`type`** 查询参数；**`TYPE`** 仍出现在每行对象中，**不能**用查询参数覆盖固定范围）。若未带任一 **timeStamp\*** 时间键，服务端追加 **`TIME_STAMP`** 默认 **UTC 向前一个日历年**（与 **`parseYieldMonitorTriggerV3Query`** 一致）。
 */
yieldMonitorRouter.get("/yield-monitor-triggers/v3", handleYieldMonitorTriggersV3);

/**
 * **v3 产量聚合**：与 **`/yield-monitor-triggers/v3`** 相同 **WHERE**（含固定 **`TYPE = delta_diff`**）。**Dummy** 在 Node 内 **COUNT**；**Oracle** 在库内 **`GROUP BY`**。无 **`MEMORY_AGG_ORACLE_MAX_ROWS`**（与 v4 内存聚合不同）。
 */
yieldMonitorRouter.get(
  "/yield-monitor-triggers/v3/aggregate",
  handleYieldMonitorTriggersV3Aggregate
);

/**
 * **v3 合并查询**：一次 HTTP + 一次 probeweb 连接，返回 v3 列表 + 多组 v3 库内聚合。
 * `aggs` 格式：`dimensions:groupTop|…`（如 `timeDay:60|probeCardType:25|device,lotId,probeCardType,probeCard:100`）。
 */
yieldMonitorRouter.get(
  "/yield-monitor-triggers/v3/combined",
  handleYieldMonitorTriggersV3Combined
);

/**
 * **周期报警趋势**：按查询时间窗切分周/月 x 轴桶，单次 Oracle 扫描；Bin 种类不含 goodbin。
 */
yieldMonitorRouter.get(
  "/yield-monitor-triggers/v3/period-alarm-trend",
  handleYieldMonitorTriggersV3PeriodAlarmTrend
);

/**
 * **v4** 产量列表：与 **v3** 相同；**`meta.apiVersion`** 为 **`"4"`**。
 */
yieldMonitorRouter.get("/yield-monitor-triggers/v4", handleYieldMonitorTriggersV4);

/**
 * **v4 产量聚合**：先 **COUNT** 匹配行（超过 **`MEMORY_AGG_ORACLE_MAX_ROWS`** 则 **422**），再拉全量行在 Node 内 **COUNT** 分桶。
 */
yieldMonitorRouter.get(
  "/yield-monitor-triggers/v4/aggregate",
  handleYieldMonitorTriggersV4Aggregate
);
