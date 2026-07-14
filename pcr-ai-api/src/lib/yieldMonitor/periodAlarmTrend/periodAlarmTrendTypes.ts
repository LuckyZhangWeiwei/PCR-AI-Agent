import type { BindParameters } from "oracledb";

export type PeriodKey = "week" | "month";

export type PeriodAlarmBucket = {
  start: Date;
  end: Date;
  label: string;
};

export type PeriodAlarmTopTester = {
  hostname: string;
  count: number;
};

export type PeriodAlarmTopDevice = {
  device: string;
  count: number;
};

export type PeriodAlarmTopProbeCard = {
  probeCard: string;
  count: number;
};

export type PeriodAlarmTrendPoint = {
  label: string;
  timeStampFrom: string;
  timeStampTo: string;
  total: number;
  testerCount: number;
  cardCount: number;
  /** distinct bin kinds excluding goodbin and empty */
  binCount: number;
  /** distinct dut# excluding empty */
  dutCount: number;
  /** delta_diff 报警触发次数（= total；分子） */
  testerAlarmNumerator: number;
  /** 同期同筛选、该桶内 JB Start distinct (LOT,SLOT) 片数（分母；v3 PASSTYPE，不含 RETESTBIN；同片多断片/多 pass 计 1） */
  testerActivityTotal: number;
  /** testerAlarmNumerator / testerActivityTotal；分母为 0 时为 null */
  testerAlarmRate: number | null;
  /** 该桶触发次数 Top N 的 tester（按 count 降序） */
  topTesters: PeriodAlarmTopTester[];
  /** 该桶触发次数 Top N 的 device（按 count 降序） */
  topDevices: PeriodAlarmTopDevice[];
  /** 该桶触发次数 Top N 的 probe card（按 count 降序） */
  topProbeCards: PeriodAlarmTopProbeCard[];
};

export const PERIOD_ALARM_TOP_N_LIMIT = 5;

export const PERIOD_ALARM_TREND_BUCKET_COUNT = 4;
export const PERIOD_ALARM_MAX_WEEK_BUCKETS = 54;
export const PERIOD_ALARM_MAX_MONTH_BUCKETS = 24;

export type PeriodBucketsInRangeResult =
  | { ok: true; buckets: PeriodAlarmBucket[] }
  | { ok: false; error: string };

export type ParsePeriodAlarmTrendOk = {
  ok: true;
  period: PeriodKey;
  now: Date;
  buckets: PeriodAlarmBucket[];
  /** delta_diff 报警 WHERE（YM 报警机台集合 + Top tester） */
  whereSql: string;
  /** YM 全 TYPE 扫描 WHERE（Top tester 子查询） */
  activityWhereSql: string;
  /** JB Start slot 分母 WHERE（`parseInfcontrolLayerBinsV3Query` AND 片段） */
  jbSlotWhereAndSql: string;
  alarmBinds: BindParameters;
  activityBinds: BindParameters;
  jbSlotBinds: BindParameters;
  jbSlotApplied: Record<string, unknown>;
  applied: Record<string, unknown>;
};

export type ParsePeriodAlarmTrendFail = { ok: false; error: string };

export const PERIOD_ALARM_TREND_DOCUMENTATION =
  "按查询 TIME_STAMP 时间窗（未传则近 1 UTC 年）切分周/月 x 轴桶，返回各桶触发总量与 COUNT(DISTINCT) 种类数（Tester / Probe Card / Bin excluding goodbin / DUT）、Tester 报警频率（分子 YM delta_diff 次数 ÷ 分母同期同筛选 JB Start distinct (LOT,SLOT) 片数，v3 PASSTYPE 不含 RETESTBIN；同片多断片计 1）、以及各桶触发 Top 5 device。";
