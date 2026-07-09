import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  aggregatePeriodAlarmTrendDummy,
  attachPeriodAlarmTopTesters,
  buildPeriodAlarmTrendSql,
  buildPeriodAlarmTrendTopTestersSql,
  mapPeriodAlarmTrendRows,
  parsePeriodAlarmTrendQuery,
  periodAlarmTrendMainBinds,
  periodAlarmTrendTopBinds,
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

  test("buildPeriodAlarmTrendSql 含 goodbin 排除与 Tester 频率分母", () => {
    const sql = buildPeriodAlarmTrendSql("WHERE 1=1", 4);
    assert.ok(sql.includes("WITH bucketed AS"));
    assert.ok(sql.includes("b.bin_v != 'goodbin'"));
    assert.ok(sql.includes("TESTER_ACTIVITY_TOTAL"));
    assert.ok(sql.includes("LENGTH(ah.hostname) > 0"));
    assert.ok(!sql.includes("hostname != ''"));
    assert.ok(sql.includes(":b0_from"));
    assert.ok(sql.includes(":b3_to"));
    assert.ok(sql.includes("COUNT(DISTINCT CASE WHEN b.is_alarm_row = 1 THEN b.hostname END"));
  });

  test("periodAlarmTrendSql bind parity", () => {
    const parsed = parsePeriodAlarmTrendQuery({
      period: "month",
      now: "2026-07-09T04:46:20.977Z",
    });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const mainSql = buildPeriodAlarmTrendSql(
      parsed.activityWhereSql,
      parsed.buckets.length
    );
    const topSql = buildPeriodAlarmTrendTopTestersSql(
      parsed.activityWhereSql,
      parsed.buckets.length
    );
    const mainBinds = periodAlarmTrendMainBinds(parsed);
    const topBinds = periodAlarmTrendTopBinds(parsed);
    const mainKeys = new Set(Object.keys(mainBinds as object));
    const topKeys = new Set(Object.keys(topBinds as object));
    for (const m of mainSql.matchAll(/:([a-zA-Z_][a-zA-Z0-9_$]*)/g)) {
      assert.ok(mainKeys.has(m[1]!), `main sql missing bind :${m[1]}`);
    }
    for (const m of topSql.matchAll(/:([a-zA-Z_][a-zA-Z0-9_$]*)/g)) {
      assert.ok(topKeys.has(m[1]!), `top sql missing bind :${m[1]}`);
    }
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

  test("aggregatePeriodAlarmTrendDummy 含 Tester 报警频率", () => {
    const buckets = recentPeriodBuckets("week", 1, NOW);
    const applied = {
      timeStampFrom: buckets[0]!.start.toISOString(),
      timeStampTo: buckets[0]!.end.toISOString(),
      typeScope: "delta_diff",
    };
    const points = aggregatePeriodAlarmTrendDummy(applied, buckets);
    assert.equal(points.length, 1);
    const p = points[0]!;
    assert.equal(p.testerAlarmNumerator, p.total);
    assert.ok(p.testerActivityTotal >= p.testerAlarmNumerator);
    if (p.testerActivityTotal > p.testerAlarmNumerator) {
      assert.ok(p.testerAlarmRate != null);
      assert.ok(p.testerAlarmRate! < 1);
    }
  });

  test("buildPeriodAlarmTrendTopTestersSql 含 ROW_NUMBER Top 5", () => {
    const sql = buildPeriodAlarmTrendTopTestersSql("WHERE 1=1", 4, 5);
    assert.ok(sql.includes("WITH bucketed AS"));
    assert.ok(sql.includes("is_alarm_row = 1"));
    assert.ok(sql.includes("ROW_NUMBER()"));
    assert.ok(sql.includes("WHERE rn <= 5"));
    assert.ok(sql.includes(":b0_from"));
  });

  test("week/month SQL bind parity 与 Dummy 报警频率", () => {
    const now = "2026-07-09T04:46:20.977Z";
    for (const period of ["week", "month"] as const) {
      const parsed = parsePeriodAlarmTrendQuery({ period, now });
      assert.equal(parsed.ok, true);
      if (!parsed.ok) return;

      const mainSql = buildPeriodAlarmTrendSql(
        parsed.activityWhereSql,
        parsed.buckets.length
      );
      const topSql = buildPeriodAlarmTrendTopTestersSql(
        parsed.activityWhereSql,
        parsed.buckets.length
      );
      const mainBinds = periodAlarmTrendMainBinds(parsed);
      const topBinds = periodAlarmTrendTopBinds(parsed);
      const mainKeys = new Set(Object.keys(mainBinds as object));
      const topKeys = new Set(Object.keys(topBinds as object));

      for (const m of mainSql.matchAll(/:([a-zA-Z_][a-zA-Z0-9_$]*)/g)) {
        assert.ok(mainKeys.has(m[1]!), `${period} main sql missing bind :${m[1]}`);
      }
      for (const m of topSql.matchAll(/:([a-zA-Z_][a-zA-Z0-9_$]*)/g)) {
        assert.ok(topKeys.has(m[1]!), `${period} top sql missing bind :${m[1]}`);
      }

      const points = aggregatePeriodAlarmTrendDummy(parsed.applied, parsed.buckets);
      assert.equal(points.length, parsed.buckets.length);
      const sample = points.find((p) => p.total > 0);
      if (sample) {
        assert.ok(sample.testerActivityTotal > 0, `${period} activity total`);
        assert.ok(sample.testerAlarmRate != null, `${period} alarm rate`);
        assert.ok(sample.topTesters.length > 0, `${period} top testers`);
      }
    }
  });

  test("attachPeriodAlarmTopTesters 合并 Oracle Top 行", () => {
    const buckets = recentPeriodBuckets("week", 2, NOW);
    const points = mapPeriodAlarmTrendRows(buckets, [
      { BUCKET_IDX: 0, TOTAL: 10, TESTER_CNT: 2, CARD_CNT: 3, BIN_CNT: 1, DUT_CNT: 1, TESTER_ACTIVITY_TOTAL: 20 },
      { BUCKET_IDX: 1, TOTAL: 5, TESTER_CNT: 1, CARD_CNT: 1, BIN_CNT: 1, DUT_CNT: 1, TESTER_ACTIVITY_TOTAL: 8 },
    ]);
    const merged = attachPeriodAlarmTopTesters(points, [
      { BUCKET_IDX: 0, HOSTNAME: "t-a", CNT: 7 },
      { BUCKET_IDX: 0, HOSTNAME: "t-b", CNT: 3 },
      { BUCKET_IDX: 1, HOSTNAME: "t-c", CNT: 5 },
    ]);
    assert.equal(merged[0]!.topTesters.length, 2);
    assert.equal(merged[0]!.topTesters[0]!.hostname, "t-a");
    assert.equal(merged[0]!.topTesters[0]!.count, 7);
    assert.equal(merged[1]!.topTesters[0]!.hostname, "t-c");
  });

  test("aggregatePeriodAlarmTrendDummy 含 topTesters", () => {
    const buckets = recentPeriodBuckets("week", 1, NOW);
    const applied = {
      timeStampFrom: buckets[0]!.start.toISOString(),
      timeStampTo: buckets[0]!.end.toISOString(),
      typeScope: "delta_diff",
    };
    const points = aggregatePeriodAlarmTrendDummy(applied, buckets);
    assert.equal(points.length, 1);
    const p = points[0]!;
    assert.ok(Array.isArray(p.topTesters));
    assert.ok(p.topTesters.length <= 5);
    if (p.topTesters.length >= 2) {
      assert.ok(p.topTesters[0]!.count >= p.topTesters[1]!.count);
    }
    const sumTop = p.topTesters.reduce((s, t) => s + t.count, 0);
    assert.ok(sumTop <= p.total);
  });
});
