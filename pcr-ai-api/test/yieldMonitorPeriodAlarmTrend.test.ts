import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  parsePeriodAlarmTrendQuery,
  periodBucketsInRange,
  recentPeriodBuckets,
  resolvePeriodAlarmTimeRange,
} from "../src/lib/yieldMonitor/periodAlarmTrend/periodAlarmTrendParse.js";
import {
  buildPeriodAlarmJbSlotTuplesSql,
  buildPeriodAlarmTrendSql,
  buildPeriodAlarmTrendTopDevicesSql,
  buildPeriodAlarmTrendTopProbeCardsSql,
  buildPeriodAlarmTrendTopTestersSql,
  periodAlarmTrendJbSlotBinds,
  periodAlarmTrendMainBinds,
  periodAlarmTrendTopBinds,
} from "../src/lib/yieldMonitor/periodAlarmTrend/periodAlarmTrendSql.js";
import {
  aggregatePeriodAlarmTrendDummy,
  attachPeriodAlarmTopDevices,
  attachPeriodAlarmTopProbeCards,
  attachPeriodAlarmTopTesters,
  mapPeriodAlarmTrendRows,
  mergePeriodAlarmJbSlotDenominator,
} from "../src/lib/yieldMonitor/periodAlarmTrend/periodAlarmTrendAggregate.js";
import { filterYieldMonitorDummyRowsMatchingV3 } from "../src/lib/yieldMonitor/yieldMonitorTriggerDummy.js";
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
      assert.ok(r.jbSlotWhereAndSql.includes("t2.TESTEND"));
    }
  });

  test("parsePeriodAlarmTrendQuery 拒绝非法 period", () => {
    const r = parsePeriodAlarmTrendQuery({ period: "day" });
    assert.equal(r.ok, false);
  });

  test("buildPeriodAlarmTrendSql 含 goodbin 排除、主查询不含 YM 分母", () => {
    const sql = buildPeriodAlarmTrendSql("WHERE 1=1", 4);
    assert.ok(sql.includes("WITH bucketed AS"));
    assert.ok(sql.includes("b.bin_v != 'goodbin'"));
    assert.ok(!sql.includes("TESTER_ACTIVITY_TOTAL"));
    assert.ok(sql.includes(":b0_from"));
    assert.ok(sql.includes(":b3_to"));
    assert.ok(sql.includes("COUNT(DISTINCT CASE WHEN b.is_alarm_row = 1 THEN b.hostname END"));
  });

  test("buildPeriodAlarmJbSlotTuplesSql 含 INFCONTROL、v3 PASSTYPE 与 TESTEND 分桶", () => {
    const sql = buildPeriodAlarmJbSlotTuplesSql("t1.DEVICE IS NOT NULL", 4);
    assert.ok(sql.includes("INFCONTROL t1"));
    assert.ok(sql.includes("'TEST'"));
    assert.ok(sql.includes("'INTERRUPT'"));
    assert.ok(sql.includes("'TEST ISR'"));
    assert.ok(sql.includes("'TEST INTERRUPT'"));
    assert.ok(sql.includes("ABANDONED"));
    assert.ok(sql.includes("t2.TESTEND"));
    assert.ok(sql.includes("COUNT(*) AS activity_total"));
    assert.ok(sql.includes("GROUP BY bucket_idx"));
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
    const topTestersSql = buildPeriodAlarmTrendTopTestersSql(
      parsed.activityWhereSql,
      parsed.buckets.length
    );
    const topSql = buildPeriodAlarmTrendTopDevicesSql(
      parsed.activityWhereSql,
      parsed.buckets.length
    );
    const topProbeCardsSql = buildPeriodAlarmTrendTopProbeCardsSql(
      parsed.activityWhereSql,
      parsed.buckets.length
    );
    const jbSlotSql = buildPeriodAlarmJbSlotTuplesSql(
      parsed.jbSlotWhereAndSql,
      parsed.buckets.length
    );
    const mainBinds = periodAlarmTrendMainBinds(parsed);
    const topBinds = periodAlarmTrendTopBinds(parsed);
    const jbBinds = periodAlarmTrendJbSlotBinds(parsed);
    const assertBinds = (sql: string, keys: Set<string>, label: string) => {
      for (const m of sql.matchAll(/:([a-zA-Z_][a-zA-Z0-9_$]*)/g)) {
        assert.ok(keys.has(m[1]!), `${label} missing bind :${m[1]}`);
      }
    };
    assertBinds(mainSql, new Set(Object.keys(mainBinds as object)), "main");
    assertBinds(topTestersSql, new Set(Object.keys(topBinds as object)), "top testers");
    assertBinds(topSql, new Set(Object.keys(topBinds as object)), "top");
    assertBinds(topProbeCardsSql, new Set(Object.keys(topBinds as object)), "top probe cards");
    assertBinds(jbSlotSql, new Set(Object.keys(jbBinds as object)), "jb slot");
  });

  test("aggregatePeriodAlarmTrendDummy binCount 不含 goodbin", () => {
    const buckets = recentPeriodBuckets("week", 1, NOW);
    const parsed = parsePeriodAlarmTrendQuery({
      period: "week",
      timeStampFrom: buckets[0]!.start.toISOString(),
      timeStampTo: buckets[0]!.end.toISOString(),
      now: NOW.toISOString(),
    });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const points = aggregatePeriodAlarmTrendDummy(
      parsed.applied,
      buckets,
      parsed.jbSlotApplied
    );
    assert.equal(points.length, 1);
    const p = points[0]!;
    const rows = filterYieldMonitorDummyRowsMatchingV3(parsed.applied);
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

  test("aggregatePeriodAlarmTrendDummy 含 JB distinct slot 报警频率", () => {
    const buckets = recentPeriodBuckets("week", 1, NOW);
    const parsed = parsePeriodAlarmTrendQuery({
      period: "week",
      timeStampFrom: buckets[0]!.start.toISOString(),
      timeStampTo: buckets[0]!.end.toISOString(),
      now: NOW.toISOString(),
    });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const points = aggregatePeriodAlarmTrendDummy(
      parsed.applied,
      buckets,
      parsed.jbSlotApplied
    );
    assert.equal(points.length, 1);
    const p = points[0]!;
    assert.equal(p.testerAlarmNumerator, p.total);
    if (p.total > 0) {
      assert.ok(p.testerActivityTotal > 0, "JB slot denominator");
      assert.ok(p.testerAlarmRate != null);
      assert.ok(p.testerAlarmRate! > 0);
      assert.ok(p.testerAlarmRate! < 1, "JB slot 分母应大于 YM 报警次数");
    }
  });

  test("buildPeriodAlarmTrendTopTestersSql 按 hostname 分组含 ROW_NUMBER Top 5", () => {
    const sql = buildPeriodAlarmTrendTopTestersSql("WHERE 1=1", 4, 5);
    assert.ok(sql.includes("TRIM(t.HOSTNAME) AS hostname"));
    assert.ok(sql.includes("GROUP BY bucket_idx, hostname"));
    assert.ok(sql.includes("ROW_NUMBER()"));
    assert.ok(sql.includes("WHERE rn <= 5"));
    assert.ok(sql.includes(":b0_from"));
  });

  test("buildPeriodAlarmTrendTopDevicesSql 含 ROW_NUMBER Top 5", () => {
    const sql = buildPeriodAlarmTrendTopDevicesSql("WHERE 1=1", 4, 5);
    assert.ok(sql.includes("WITH bucketed AS"));
    assert.ok(sql.includes("is_alarm_row = 1"));
    assert.ok(sql.includes("ROW_NUMBER()"));
    assert.ok(sql.includes("WHERE rn <= 5"));
    assert.ok(sql.includes(":b0_from"));
  });

  test("buildPeriodAlarmTrendTopProbeCardsSql 按 probe_card 分组含 ROW_NUMBER Top 5", () => {
    const sql = buildPeriodAlarmTrendTopProbeCardsSql("WHERE 1=1", 4, 5);
    assert.ok(sql.includes("TRIM(t.PROBECARD) AS probe_card"));
    assert.ok(sql.includes("GROUP BY bucket_idx, probe_card"));
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

      const points = aggregatePeriodAlarmTrendDummy(
        parsed.applied,
        parsed.buckets,
        parsed.jbSlotApplied
      );
      assert.equal(points.length, parsed.buckets.length);
      const sample = points.find((p) => p.total > 0);
      if (sample) {
        assert.ok(sample.topDevices.length > 0, `${period} top devices`);
        if (sample.testerActivityTotal > 0) {
          assert.ok(sample.testerAlarmRate != null, `${period} alarm rate`);
          assert.ok(
            sample.testerAlarmRate! < 1,
            `${period} JB slot rate should be below 100% when denominator matches`
          );
        }
      }
    }
  });

  test("mergePeriodAlarmJbSlotDenominator 统计桶内全部 JB 行数", () => {
    const buckets = recentPeriodBuckets("week", 2, NOW);
    const points = mapPeriodAlarmTrendRows(buckets, [
      { BUCKET_IDX: 0, TOTAL: 10, TESTER_CNT: 2, CARD_CNT: 3, BIN_CNT: 1, DUT_CNT: 1 },
      { BUCKET_IDX: 1, TOTAL: 5, TESTER_CNT: 1, CARD_CNT: 1, BIN_CNT: 1, DUT_CNT: 1 },
    ]);
    const merged = mergePeriodAlarmJbSlotDenominator(points, [
      { BUCKET_IDX: 0, ACTIVITY_TOTAL: 1500 },
      { BUCKET_IDX: 1, ACTIVITY_TOTAL: 800 },
    ]);
    assert.equal(merged[0]!.testerActivityTotal, 1500);
    assert.equal(merged[0]!.testerAlarmRate, 10 / 1500);
    assert.equal(merged[1]!.testerActivityTotal, 800);
    assert.equal(merged[1]!.testerAlarmRate, 5 / 800);
  });

  test("mergePeriodAlarmJbSlotDenominator JB 覆盖不足时报警频率为 null", () => {
    const buckets = recentPeriodBuckets("week", 1, NOW);
    const points = mapPeriodAlarmTrendRows(buckets, [
      { BUCKET_IDX: 0, TOTAL: 428, TESTER_CNT: 2, CARD_CNT: 3, BIN_CNT: 1, DUT_CNT: 1 },
    ]);
    const merged = mergePeriodAlarmJbSlotDenominator(points, [
      { BUCKET_IDX: 0, ACTIVITY_TOTAL: 1 },
    ]);
    assert.equal(merged[0]!.testerActivityTotal, 1);
    assert.equal(merged[0]!.testerAlarmRate, null);
  });

  test("attachPeriodAlarmTopTesters 合并 Oracle Top 行", () => {
    const buckets = recentPeriodBuckets("week", 2, NOW);
    const points = mapPeriodAlarmTrendRows(buckets, [
      { BUCKET_IDX: 0, TOTAL: 10, TESTER_CNT: 2, CARD_CNT: 3, BIN_CNT: 1, DUT_CNT: 1 },
      { BUCKET_IDX: 1, TOTAL: 5, TESTER_CNT: 1, CARD_CNT: 1, BIN_CNT: 1, DUT_CNT: 1 },
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

  test("attachPeriodAlarmTopDevices 合并 Oracle Top 行", () => {
    const buckets = recentPeriodBuckets("week", 2, NOW);
    const points = mapPeriodAlarmTrendRows(buckets, [
      { BUCKET_IDX: 0, TOTAL: 10, TESTER_CNT: 2, CARD_CNT: 3, BIN_CNT: 1, DUT_CNT: 1 },
      { BUCKET_IDX: 1, TOTAL: 5, TESTER_CNT: 1, CARD_CNT: 1, BIN_CNT: 1, DUT_CNT: 1 },
    ]);
    const merged = attachPeriodAlarmTopDevices(points, [
      { BUCKET_IDX: 0, DEVICE: "d-a", CNT: 7 },
      { BUCKET_IDX: 0, DEVICE: "d-b", CNT: 3 },
      { BUCKET_IDX: 1, DEVICE: "d-c", CNT: 5 },
    ]);
    assert.equal(merged[0]!.topDevices.length, 2);
    assert.equal(merged[0]!.topDevices[0]!.device, "d-a");
    assert.equal(merged[0]!.topDevices[0]!.count, 7);
    assert.equal(merged[1]!.topDevices[0]!.device, "d-c");
  });

  test("attachPeriodAlarmTopProbeCards 合并 Oracle Top 行", () => {
    const buckets = recentPeriodBuckets("week", 2, NOW);
    const points = mapPeriodAlarmTrendRows(buckets, [
      { BUCKET_IDX: 0, TOTAL: 10, TESTER_CNT: 2, CARD_CNT: 3, BIN_CNT: 1, DUT_CNT: 1 },
      { BUCKET_IDX: 1, TOTAL: 5, TESTER_CNT: 1, CARD_CNT: 1, BIN_CNT: 1, DUT_CNT: 1 },
    ]);
    const merged = attachPeriodAlarmTopProbeCards(points, [
      { BUCKET_IDX: 0, PROBE_CARD: "c-a", CNT: 7 },
      { BUCKET_IDX: 0, PROBE_CARD: "c-b", CNT: 3 },
      { BUCKET_IDX: 1, PROBE_CARD: "c-c", CNT: 5 },
    ]);
    assert.equal(merged[0]!.topProbeCards.length, 2);
    assert.equal(merged[0]!.topProbeCards[0]!.probeCard, "c-a");
    assert.equal(merged[0]!.topProbeCards[0]!.count, 7);
    assert.equal(merged[1]!.topProbeCards[0]!.probeCard, "c-c");
  });

  test("aggregatePeriodAlarmTrendDummy 含 topTesters、topDevices 与 topProbeCards", () => {
    const buckets = recentPeriodBuckets("week", 1, NOW);
    const parsed = parsePeriodAlarmTrendQuery({
      period: "week",
      timeStampFrom: buckets[0]!.start.toISOString(),
      timeStampTo: buckets[0]!.end.toISOString(),
      now: NOW.toISOString(),
    });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const points = aggregatePeriodAlarmTrendDummy(
      parsed.applied,
      buckets,
      parsed.jbSlotApplied
    );
    assert.equal(points.length, 1);
    const p = points[0]!;
    assert.ok(Array.isArray(p.topTesters));
    assert.ok(p.topTesters.length <= 5);
    if (p.topTesters.length >= 2) {
      assert.ok(p.topTesters[0]!.count >= p.topTesters[1]!.count);
    }
    const sumTopTesters = p.topTesters.reduce((s, t) => s + t.count, 0);
    assert.ok(sumTopTesters <= p.total);

    assert.ok(Array.isArray(p.topDevices));
    assert.ok(p.topDevices.length <= 5);
    if (p.topDevices.length >= 2) {
      assert.ok(p.topDevices[0]!.count >= p.topDevices[1]!.count);
    }
    const sumTop = p.topDevices.reduce((s, t) => s + t.count, 0);
    assert.ok(sumTop <= p.total);

    assert.ok(Array.isArray(p.topProbeCards));
    assert.ok(p.topProbeCards.length <= 5);
    if (p.topProbeCards.length >= 2) {
      assert.ok(p.topProbeCards[0]!.count >= p.topProbeCards[1]!.count);
    }
    const sumTopCards = p.topProbeCards.reduce((s, t) => s + t.count, 0);
    assert.ok(sumTopCards <= p.total);
  });
});
