/**
 * 列表走 **v4**（支持 `limit` Top-N 明细）。
 * 图表聚合走 **v3**（库内聚合全集匹配行，不受 `limit` 影响，且无 v4 内存行数上限）。
 */
export const API_PREFIX = "/api/v4";

export const INFCONTROL_AGGREGATE_PATH =
  "/api/v3/infcontrol-layer-bins/v3/aggregate";

export const YIELD_AGGREGATE_PATH =
  "/api/v3/yield-monitor-triggers/v3/aggregate";
