/**
 * v3 层控 / 产量：当请求**未携带**任何时间窗查询参数时，服务端追加默认
 * **`[UTC 现在 − 1 个日历年, UTC 现在]`**（`lo` 含当前时刻，`hi` 含当前时刻），以缩小 Oracle / Dummy 扫描范围。
 *
 * - 层控：落在 **`t2.TESTEND`** 上（与列表 **`ORDER BY TESTEND`** 一致）。
 * - 产量：落在 **`t.TIME_STAMP`** 上（与列表 **`ORDER BY TIME_STAMP`** 一致）。
 */
export function v3DefaultThroughNowMinusOneUtcYear(): { lo: Date; hi: Date } {
  const hi = new Date();
  const lo = new Date(hi.getTime());
  lo.setUTCFullYear(lo.getUTCFullYear() - 1);
  return { lo, hi };
}
