/**
 * 列表走 **v4**（支持 `limit` Top-N 明细）。
 * 图表聚合走 **v3**（库内聚合全集匹配行，不受 `limit` 影响，且无 v4 内存行数上限）。
 */
export const API_PREFIX = "/api/v4";

export const INFCONTROL_AGGREGATE_PATH =
  "/api/v3/infcontrol-layer-bins/v3/aggregate";

export const INFCONTROL_COMBINED_PATH =
  "/api/v4/infcontrol-layer-bins/v4/combined";

export const YIELD_AGGREGATE_PATH =
  "/api/v3/yield-monitor-triggers/v3/aggregate";

/** 列表 + 多组 v3 库内聚合，一次 HTTP / 一次 Oracle 连接 */
export const YIELD_COMBINED_PATH =
  "/api/v3/yield-monitor-triggers/v3/combined";

export const YIELD_PERIOD_ALARM_TREND_PATH =
  "/api/v3/yield-monitor-triggers/v3/period-alarm-trend";

/** INF wafer pass × bin × DUT distribution — uses v1 path (stable across API_PREFIX changes) */
export const SITE_BIN_BY_LOT_PATH = "/api/v1/inf-analysis/site-bin-bylot";

/** 明细多选：一次 HTTP 批量拉多层 site-bin map */
export const SITE_BIN_BY_LOT_LAYERS_PATH =
  "/api/v1/inf-analysis/site-bin-bylot/layers";

/** Lot 低良率 DUT 筛选（v4 INF 分析） */
export const LOT_UNDERPERFORMING_DUTS_PATH =
  "/api/v4/inf-analysis/lot-underperforming-duts";
