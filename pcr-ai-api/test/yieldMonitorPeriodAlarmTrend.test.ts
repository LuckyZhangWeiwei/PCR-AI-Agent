import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  aggregatePeriodAlarmTrendDummy,
  buildPeriodAlarmTrendSql,
  parsePeriodAlarmTrendQuery,
  recentPeriodBuckets,
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
