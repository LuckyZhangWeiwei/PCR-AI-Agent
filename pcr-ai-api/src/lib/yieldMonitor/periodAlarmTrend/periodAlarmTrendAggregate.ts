import {
  filterYieldMonitorDummyRowsMatchingV3,
  yieldMonitorDummyTimeOffsetMs,
  type YieldMonitorTriggerDummyRow,
} from "../yieldMonitorTriggerDummy.js";
import type { InfcontrolLayerBinDummyRow } from "../../infcontrol/infcontrolLayerBinDummy.js";
import { filterInfcontrolLayerBinV3DummyRowsMatching } from "../../infcontrol/infcontrolLayerBinDummyV3.js";
import { parseBinFromTriggerLabel } from "../../yieldTriggerLabelBin.js";
import { parseDutNumberFromTriggerLabel } from "../../yieldTriggerLabelDut.js";
import {
  PERIOD_ALARM_TOP_N_LIMIT,
  type PeriodAlarmBucket,
  type PeriodAlarmTopDevice,
  type PeriodAlarmTopProbeCard,
  type PeriodAlarmTopTester,
  type PeriodAlarmTrendPoint,
} from "./periodAlarmTrendTypes.js";

function assignBucketIndex(
  rowTs: number,
  buckets: PeriodAlarmBucket[],
  timeOffsetMs = 0
): number | null {
  for (let i = buckets.length - 1; i >= 0; i--) {
    const b = buckets[i]!;
    const from = b.start.getTime() - timeOffsetMs;
    const to = b.end.getTime() - timeOffsetMs;
    if (rowTs >= from && rowTs <= to) return i;
  }
  return null;
}

function computeTesterAlarmRate(
  numerator: number,
  activityTotal: number
): number | null {
  if (activityTotal <= 0 || numerator <= 0) return null;
  const rate = numerator / activityTotal;
  // JB 历史覆盖不足或 TIME_STAMP 与 TESTEND 分桶错位时，比率可 >>1；UI 按百分比展示，>100% 视为无效
  if (rate > 1) return null;
  return rate;
}

export function topTestersFromAlarmRows(
  rows: Array<YieldMonitorTriggerDummyRow & { PROBECARDTYPE?: string | null }>,
  limit = PERIOD_ALARM_TOP_N_LIMIT
): PeriodAlarmTopTester[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const hn = String(row.HOSTNAME ?? "").trim();
    if (!hn) continue;
    counts.set(hn, (counts.get(hn) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([hostname, count]) => ({ hostname, count }));
}

export function topDevicesFromAlarmRows(
  rows: Array<YieldMonitorTriggerDummyRow & { PROBECARDTYPE?: string | null }>,
  limit = PERIOD_ALARM_TOP_N_LIMIT
): PeriodAlarmTopDevice[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const dv = String(row.DEVICE ?? "").trim();
    if (!dv) continue;
    counts.set(dv, (counts.get(dv) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([device, count]) => ({ device, count }));
}

export function topProbeCardsFromAlarmRows(
  rows: Array<YieldMonitorTriggerDummyRow & { PROBECARDTYPE?: string | null }>,
  limit = PERIOD_ALARM_TOP_N_LIMIT
): PeriodAlarmTopProbeCard[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const pc = String(row.PROBECARD ?? "").trim();
    if (!pc) continue;
    counts.set(pc, (counts.get(pc) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([probeCard, count]) => ({ probeCard, count }));
}

function waferSlotKey(lot: string, slot: string | number): string {
  return `${lot}\u0001${slot}`;
}

function countJbDistinctSlotsInBucket(
  jbRows: InfcontrolLayerBinDummyRow[],
  bucket: PeriodAlarmBucket
): number {
  const keys = new Set<string>();
  const from = bucket.start.getTime();
  const to = bucket.end.getTime();
  for (const row of jbRows) {
    const lot = String(row.LOT ?? "").trim();
    if (!lot) continue;
    const te = new Date(String(row.TESTEND)).getTime();
    if (Number.isNaN(te) || te < from || te > to) continue;
    keys.add(waferSlotKey(lot, row.SLOT));
  }
  return keys.size;
}

function aggregateBucketMetrics(
  rows: Array<YieldMonitorTriggerDummyRow & { PROBECARDTYPE?: string | null }>,
  jbRows: InfcontrolLayerBinDummyRow[],
  bucket: PeriodAlarmBucket
): Omit<
  PeriodAlarmTrendPoint,
  "label" | "timeStampFrom" | "timeStampTo" | "topTesters" | "topDevices" | "topProbeCards"
> {
  const testers = new Set<string>();
  const cards = new Set<string>();
  const bins = new Set<string>();
  const duts = new Set<string>();

  for (const row of rows) {
    testers.add(String(row.HOSTNAME ?? "").trim());
    cards.add(String(row.PROBECARD ?? "").trim());
    const bin = parseBinFromTriggerLabel(row.TRIGGER_LABEL);
    if (bin != null && bin !== "" && bin !== "goodbin") {
      bins.add(bin);
    }
    const dut = parseDutNumberFromTriggerLabel(row.TRIGGER_LABEL);
    if (dut !== null) {
      duts.add(String(dut));
    }
  }

  testers.delete("");
  cards.delete("");

  const total = rows.length;
  const testerActivityTotal = countJbDistinctSlotsInBucket(jbRows, bucket);

  return {
    total,
    testerCount: testers.size,
    cardCount: cards.size,
    binCount: bins.size,
    dutCount: duts.size,
    testerAlarmNumerator: total,
    testerActivityTotal,
    testerAlarmRate: computeTesterAlarmRate(total, testerActivityTotal),
  };
}

export function aggregatePeriodAlarmTrendDummy(
  applied: Record<string, unknown>,
  buckets: PeriodAlarmBucket[],
  jbApplied: Record<string, unknown>
): PeriodAlarmTrendPoint[] {
  const rows = filterYieldMonitorDummyRowsMatchingV3(applied);
  const jbRows = filterInfcontrolLayerBinV3DummyRowsMatching(jbApplied);
  /**
   * 必须与 `filterYieldMonitorDummyRowsMatchingV3` 内部用的偏移同源（基于时间窗过滤前的行计算）。
   * 若改用已按时间窗过滤后的 `rows` 重新计算 maxTs，两次取值范围不同会得到不一致的偏移，
   * 导致窗口边界附近的行在分桶时被错误丢弃（分桶结果比实际过滤结果少）。
   */
  const timeOffsetMs = yieldMonitorDummyTimeOffsetMs(applied);
  const grouped: Array<
    Array<YieldMonitorTriggerDummyRow & { PROBECARDTYPE?: string | null }>
  > = buckets.map(() => []);

  for (const row of rows) {
    const t = new Date(row.TIME_STAMP).getTime();
    if (Number.isNaN(t)) continue;
    const idx = assignBucketIndex(t, buckets, timeOffsetMs);
    if (idx === null) continue;
    grouped[idx]!.push(row);
  }

  return buckets.map((bucket, i) => {
    const alarmRows = grouped[i] ?? [];
    const metrics = aggregateBucketMetrics(alarmRows, jbRows, bucket);
    return {
      label: bucket.label,
      timeStampFrom: bucket.start.toISOString(),
      timeStampTo: bucket.end.toISOString(),
      ...metrics,
      topTesters: topTestersFromAlarmRows(alarmRows),
      topDevices: topDevicesFromAlarmRows(alarmRows),
      topProbeCards: topProbeCardsFromAlarmRows(alarmRows),
    };
  });
}

export function mergePeriodAlarmJbSlotDenominator(
  points: PeriodAlarmTrendPoint[],
  jbSlotRows: Record<string, unknown>[]
): PeriodAlarmTrendPoint[] {
  const slotsByBucket = new Map<number, Set<string>>();
  for (const row of jbSlotRows) {
    const idxRaw = row.BUCKET_IDX ?? row.bucket_idx;
    const idx = idxRaw != null ? Number(idxRaw) : NaN;
    const lotRaw = row.LOT ?? row.lot;
    const lot = lotRaw == null ? "" : String(lotRaw).trim();
    const slotRaw = row.SLOT ?? row.slot;
    if (!Number.isFinite(idx) || !lot || slotRaw == null) continue;
    const key = waferSlotKey(lot, slotRaw as string | number);
    const set = slotsByBucket.get(idx) ?? new Set<string>();
    set.add(key);
    slotsByBucket.set(idx, set);
  }

  return points.map((p, i) => {
    const activity = slotsByBucket.get(i)?.size ?? 0;
    const num = p.testerAlarmNumerator;
    return {
      ...p,
      testerActivityTotal: activity,
      testerAlarmRate: computeTesterAlarmRate(num, activity),
    };
  });
}

export function attachPeriodAlarmTopTesters(
  points: PeriodAlarmTrendPoint[],
  topRows: Record<string, unknown>[]
): PeriodAlarmTrendPoint[] {
  const byBucket = new Map<number, PeriodAlarmTopTester[]>();
  for (const row of topRows) {
    const idxRaw = row.BUCKET_IDX ?? row.bucket_idx;
    const idx = idxRaw != null ? Number(idxRaw) : NaN;
    if (!Number.isFinite(idx)) continue;
    const hostnameRaw = row.HOSTNAME ?? row.hostname;
    const hostname =
      hostnameRaw == null ? "" : String(hostnameRaw).trim();
    const cntRaw = row.CNT ?? row.cnt;
    const count = cntRaw != null ? Number(cntRaw) : NaN;
    if (!hostname || !Number.isFinite(count)) continue;
    const list = byBucket.get(idx) ?? [];
    list.push({ hostname, count });
    byBucket.set(idx, list);
  }

  return points.map((p, i) => ({
    ...p,
    topTesters: byBucket.get(i) ?? [],
  }));
}

export function attachPeriodAlarmTopDevices(
  points: PeriodAlarmTrendPoint[],
  topRows: Record<string, unknown>[]
): PeriodAlarmTrendPoint[] {
  const byBucket = new Map<number, PeriodAlarmTopDevice[]>();
  for (const row of topRows) {
    const idxRaw = row.BUCKET_IDX ?? row.bucket_idx;
    const idx = idxRaw != null ? Number(idxRaw) : NaN;
    if (!Number.isFinite(idx)) continue;
    const deviceRaw = row.DEVICE ?? row.device;
    const device =
      deviceRaw == null ? "" : String(deviceRaw).trim();
    const cntRaw = row.CNT ?? row.cnt;
    const count = cntRaw != null ? Number(cntRaw) : NaN;
    if (!device || !Number.isFinite(count)) continue;
    const list = byBucket.get(idx) ?? [];
    list.push({ device, count });
    byBucket.set(idx, list);
  }

  return points.map((p, i) => ({
    ...p,
    topDevices: byBucket.get(i) ?? [],
  }));
}

export function attachPeriodAlarmTopProbeCards(
  points: PeriodAlarmTrendPoint[],
  topRows: Record<string, unknown>[]
): PeriodAlarmTrendPoint[] {
  const byBucket = new Map<number, PeriodAlarmTopProbeCard[]>();
  for (const row of topRows) {
    const idxRaw = row.BUCKET_IDX ?? row.bucket_idx;
    const idx = idxRaw != null ? Number(idxRaw) : NaN;
    if (!Number.isFinite(idx)) continue;
    const probeCardRaw = row.PROBE_CARD ?? row.probe_card;
    const probeCard =
      probeCardRaw == null ? "" : String(probeCardRaw).trim();
    const cntRaw = row.CNT ?? row.cnt;
    const count = cntRaw != null ? Number(cntRaw) : NaN;
    if (!probeCard || !Number.isFinite(count)) continue;
    const list = byBucket.get(idx) ?? [];
    list.push({ probeCard, count });
    byBucket.set(idx, list);
  }

  return points.map((p, i) => ({
    ...p,
    topProbeCards: byBucket.get(i) ?? [],
  }));
}

export function mapPeriodAlarmTrendRows(
  buckets: PeriodAlarmBucket[],
  rows: Record<string, unknown>[]
): PeriodAlarmTrendPoint[] {
  const byIdx = new Map<number, Record<string, unknown>>();
  for (const row of rows) {
    const idxRaw = row.BUCKET_IDX ?? row.bucket_idx;
    const idx = idxRaw != null ? Number(idxRaw) : NaN;
    if (Number.isFinite(idx)) byIdx.set(idx, row);
  }

  return buckets.map((bucket, i) => {
    const row = byIdx.get(i);
    const num = (k: string) => {
      const raw = row?.[k] ?? row?.[k.toLowerCase()];
      const n = Number(raw);
      return Number.isFinite(n) ? n : 0;
    };
    return {
      label: bucket.label,
      timeStampFrom: bucket.start.toISOString(),
      timeStampTo: bucket.end.toISOString(),
      total: num("TOTAL"),
      testerCount: num("TESTER_CNT"),
      cardCount: num("CARD_CNT"),
      binCount: num("BIN_CNT"),
      dutCount: num("DUT_CNT"),
      testerAlarmNumerator: num("TOTAL"),
      testerActivityTotal: 0,
      testerAlarmRate: null,
      topTesters: [],
      topDevices: [],
      topProbeCards: [],
    };
  });
}
