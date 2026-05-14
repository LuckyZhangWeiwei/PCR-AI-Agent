/** 未设置环境变量时的默认上限（单次 Oracle 拉取后在 Node 内聚合的最大行数） */
export const MEMORY_AGG_ORACLE_MAX_ROWS_DEFAULT = 200_000;

/** 允许通过环境变量配置的上限封顶（防误配极大值拖垮进程） */
export const MEMORY_AGG_ORACLE_MAX_ROWS_CAP = 5_000_000;

/**
 * Oracle 路径上 **仅 v4 聚合**（拉全量匹配行后在 Node 内聚合）单次允许拉取的最大匹配行数。
 * 环境变量 **`MEMORY_AGG_ORACLE_MAX_ROWS`**：正整数；缺省为 **`MEMORY_AGG_ORACLE_MAX_ROWS_DEFAULT`**，且不超过 **`MEMORY_AGG_ORACLE_MAX_ROWS_CAP`**。
 */
export function readMemoryAggregateOracleMaxRows(): number {
  const raw = process.env.MEMORY_AGG_ORACLE_MAX_ROWS?.trim();
  if (!raw) return MEMORY_AGG_ORACLE_MAX_ROWS_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    return MEMORY_AGG_ORACLE_MAX_ROWS_DEFAULT;
  }
  return Math.min(n, MEMORY_AGG_ORACLE_MAX_ROWS_CAP);
}
