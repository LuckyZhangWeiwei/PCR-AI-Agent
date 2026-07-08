import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  aggregatePeriodAlarmTrendDummy,
  buildPeriodAlarmTrendSql,
  parsePeriodAlarmTrendQuery,
  periodBucketsInRange,
  recentPeriodBuckets,
  resolvePeriodAlarmTimeRange,
} from "../src/lib/yieldMonitorPeriodAlarmTrend.js";
import { filterYieldMonitorDummyRowsMatchingV3 } from "../src/lib/yieldMonitorTriggerDummy.js";
import { parseBinFromTriggerLabel } from "../src/lib/yieldTriggerLabelBin.js";

describe("yieldMonitorPeriodAlarmTrend", () => {
  const NOW = new Date("2026-07-06T10:00:00.000Z");

  test("recentPeriodBuckets week/month 与前端一致", () => {
    const week = recentPeriodBuckets("week", 4, NOW);
    assert.equal(week.length, 4);
    assert.equal(week[3]!.end.getTime(), NOW.getTime());
    assert.equal(
      week[0]!.start.getTime(),
      NOW.getTime() - 28 * 24 * 60 * 60 * 1000
    );

    const month = recentPeriodBuckets("month", 4, NOW);
    assert.equal(month[3]!.start.getTime(), new Date(2026, 6, 1).getTime());
    assert.equal(month[0]!.start.getTime(), new Date(2026, 3, 1).getTime());
  });

  test("periodBucketsInRange 按查询时间窗切分", () => {
    const from = new Date("2026-01-15T00:00:00.000Z");
    const to = new Date("2026-03-10T00:00:00.000Z");

    const months = periodBucketsInRange("month", from, to);
    assert.equal(months.ok, true);
    if (months.ok) {
      assert.equal(months.buckets.length, 3);
      assert.equal(months.buckets[0]!.label, "2026-01");
      assert.equal(months.buckets[2]!.label, "2026-03");
    }

    const weeks = periodBucketsInRange("week", from, to);
    assert.equal(weeks.ok, true);
    if (weeks.ok) {
      assert.ok(weeks.buckets.length >= 7);
      assert.equal(weeks.buckets[0]!.start.getTime(), from.getTime());
      assert.equal(weeks.buckets[weeks.buckets.length - 1]!.end.getTime(), to.getTime());
    }
  });

  test("resolvePeriodAlarmTimeRange 未传时间时默认近 1 年", () => {
    const now = new Date("2026-07-06T10:00:00.000Z");
    const r = resolvePeriodAlarmTimeRange({}, now);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.to.getTime(), now.getTime());
      assert.ok(r.from.getTime() < r.to.getTime());
      const weeks = periodBucketsInRange("week", r.from, r.to);
      assert.equal(weeks.ok, true);
      if (weeks.ok) {
        assert.ok(weeks.buckets.length <= 54);
      }
    }
  });

  test("parsePeriodAlarmTrendQuery 使用 timeStampFrom/To 切桶", () => {
    const r = parsePeriodAlarmTrendQuery({
      period: "month",
      timeStampFrom: "2026-04-01T00:00:00.000Z",
      timeStampTo: "2026-06-15T00:00:00.000Z",
      now: "2026-07-06T10:00:00.000Z",
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.buckets.length, 3);
      assert.equal(r.buckets[0]!.label, "2026-04");
      assert.equal(r.buckets[2]!.label, "2026-06");
    }
  });

  test("parsePeriodAlarmTrendQuery 拒绝非法 period", () => {
    const r = parsePeriodAlarmTrendQuery({ period: "day" });
    assert.equal(r.ok, false);
  });

  test("buildPeriodAlarmTrendSql 含 goodbin 排除与 4 桶 CASE", () => {
    const sql = buildPeriodAlarmTrendSql("WHERE 1=1", 4);
    assert.ok(sql.includes("bin_v IS NOT NULL AND bin_v != 'goodbin'"));
    assert.ok(sql.includes("dut_v IS NOT NULL"));
    assert.ok(sql.includes(":b0_from"));
    assert.ok(sql.includes(":b3_to"));
    assert.ok(sql.includes("COUNT(DISTINCT TRIM(HOSTNAME))"));
  });

  test("aggregatePeriodAlarmTrendDummy binCount 不含 goodbin", () => {
    const buckets = recentPeriodBuckets("week", 1, NOW);
    const applied = {
      timeStampFrom: buckets[0]!.start.toISOString(),
      timeStampTo: buckets[0]!.end.toISOString(),
      typeScope: "delta_diff",
    };
    const points = aggregatePeriodAlarmTrendDummy(applied, buckets);
    assert.equal(points.length, 1);
    const p = points[0]!;
    const rows = filterYieldMonitorDummyRowsMatchingV3(applied);
    const withGood = new Set<string>();
    const withoutGood = new Set<string>();
    for (const row of rows) {
      const bin = parseBinFromTriggerLabel(row.TRIGGER_LABEL);
      if (!bin) continue;
      withGood.add(bin);
      if (bin !== "goodbin") withoutGood.add(bin);
    }
    if (withGood.has("goodbin")) {
      assert.equal(p.binCount, withoutGood.size);
      assert.ok(p.binCount < withGood.size);
    }
  });
});
