import { INFCONTROL_V3_AGGREGATE_DOCUMENTATION } from "./infcontrolLayerBinV3Aggregate.js";
import { YIELD_MONITOR_V3_AGGREGATE_DOCUMENTATION } from "./yieldMonitorTriggerV3Aggregate.js";

/** v4 层控聚合 JSON **`documentation`**：在 v3 说明基础上注明「全量行来自与 v4 列表同一 SQL（无 FETCH FIRST），在 Node 内 SUM」。Dummy 与 Oracle 均受 **`MEMORY_AGG_ORACLE_MAX_ROWS`** 约束（超出 **422**）。 */
export const INFCONTROL_V4_AGGREGATE_DOCUMENTATION =
  INFCONTROL_V3_AGGREGATE_DOCUMENTATION +
  " **【v4】** 聚合不调用 v3 的 Oracle UNPIVOT SQL；服务端先拉取与 **GET …/infcontrol-layer-bins/v4** 相同 **WHERE**、**无列表 FETCH FIRST** 的全量匹配行（主库或 Dummy 内存），再在进程内执行与 Dummy v3 相同的坏-bin **SUM** 循环；**Dummy 与 Oracle** 均在匹配行数超过 **`MEMORY_AGG_ORACLE_MAX_ROWS`** 时返回 **422**。";

/** v4 产量聚合 JSON **`documentation`**。 */
export const YIELD_MONITOR_V4_AGGREGATE_DOCUMENTATION =
  YIELD_MONITOR_V3_AGGREGATE_DOCUMENTATION +
  " **【v4】** 聚合不调用 v3 的 Oracle `GROUP BY` SQL；服务端先拉取与 **GET …/yield-monitor-triggers/v4** 相同 **WHERE**、**无 FETCH FIRST** 的全量匹配行（probeweb 或 Dummy 内存），再在进程内按维度 **COUNT(*)**（与 Dummy v3 路径一致）；**Dummy 与 Oracle** 均在匹配行数超过 **`MEMORY_AGG_ORACLE_MAX_ROWS`** 时返回 **422**。";
