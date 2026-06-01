// pcr-ai-api/src/lib/agent/agentJbBadBinCluster.ts
/** 按 slot 序列检测突增/聚集/递升坏 bin，供 Agent 必须点明。 */

import {
  binDieByHalvesForGroup,
  passIdFromJbRow,
  passIdSortLabel,
} from "../jbYieldCalc.js";

export type ClusteredBadBinAlertKind =
  | "sudden_increase"
  | "cluster"
  | "rising_trend";

export type ClusteredBadBinAlert = {
  bin: number;
  passId: number;
  sortLabel: string;
  kind: ClusteredBadBinAlertKind;
  slotStart: number;
  slotEnd: number;
  slots: number[];
  /** 该段内该 BIN 最大合计 die */
  peakDie: number;
  detail: string;
};

const KIND_LABEL: Record<ClusteredBadBinAlertKind, string> = {
  sudden_increase: "单片突增",
  cluster: "连续聚集",
  rising_trend: "递升趋势",
};

function groupRowsForSlotPass(
  rows: Record<string, unknown>[],
  slot: number,
  passId: number
): Record<string, unknown>[] {
  return rows.filter((r) => {
    const s = Number(r.SLOT ?? r.slot);
    return s === slot && passIdFromJbRow(r) === passId;
  });
}

function slotBinTotals(
  rows: Record<string, unknown>[],
  bin: number,
  passId: number
): Array<{ slot: number; die: number }> {
  const slots = new Set<number>();
  for (const r of rows) {
    const s = Number(r.SLOT ?? r.slot);
    if (Number.isFinite(s) && s > 0 && passIdFromJbRow(r) === passId) {
      slots.add(s);
    }
  }
  return [...slots]
    .sort((a, b) => a - b)
    .map((slot) => {
      const group = groupRowsForSlotPass(rows, slot, passId);
      const die = binDieByHalvesForGroup(group, bin).total;
      return { slot, die };
    })
    .filter((x) => x.die > 0);
}

function detectSuddenIncrease(
  series: Array<{ slot: number; die: number }>,
  bin: number,
  passId: number
): ClusteredBadBinAlert | null {
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1]!.die;
    const cur = series[i]!.die;
    const delta = cur - prev;
    if (cur < 12) continue;
    if (delta < 10) continue;
    if (cur >= Math.max(prev * 2, prev + 15)) {
      const slot = series[i]!.slot;
      return {
        bin,
        passId,
        sortLabel: passIdSortLabel(passId),
        kind: "sudden_increase",
        slotStart: series[i - 1]!.slot,
        slotEnd: slot,
        slots: [series[i - 1]!.slot, slot],
        peakDie: cur,
        detail: `waferId ${series[i - 1]!.slot}→${slot}：BIN${bin} 由 ${prev} 颗突增至 ${cur} 颗（+${delta}）`,
      };
    }
  }
  return null;
}

function detectCluster(
  series: Array<{ slot: number; die: number }>,
  bin: number,
  passId: number
): ClusteredBadBinAlert | null {
  if (series.length < 3) return null;
  const maxDie = Math.max(...series.map((x) => x.die));
  const threshold = Math.max(8, Math.round(maxDie * 0.35));
  let bestStart = -1;
  let bestLen = 0;
  let i = 0;
  while (i < series.length) {
    if (series[i]!.die < threshold) {
      i++;
      continue;
    }
    let j = i;
    while (j < series.length && series[j]!.die >= threshold) j++;
    const len = j - i;
    if (len > bestLen) {
      bestLen = len;
      bestStart = i;
    }
    i = j;
  }
  if (bestLen < 3) return null;
  const seg = series.slice(bestStart, bestStart + bestLen);
  const peak = Math.max(...seg.map((x) => x.die));
  const slotStart = seg[0]!.slot;
  const slotEnd = seg[seg.length - 1]!.slot;
  return {
    bin,
    passId,
    sortLabel: passIdSortLabel(passId),
    kind: "cluster",
    slotStart,
    slotEnd,
    slots: seg.map((x) => x.slot),
    peakDie: peak,
    detail: `waferId ${slotStart}–${slotEnd} 连续 **${bestLen}** 片 BIN${bin} ≥${threshold} 颗/片（峰 ${peak} 颗）`,
  };
}

function detectRisingTrend(
  series: Array<{ slot: number; die: number }>,
  bin: number,
  passId: number
): ClusteredBadBinAlert | null {
  const minRun = 4;
  const minStep = 4;
  let runStart = 0;
  for (let i = 1; i < series.length; i++) {
    const rising =
      series[i]!.die >= series[i - 1]!.die + minStep ||
      (series[i]!.die > series[i - 1]!.die &&
        series[i]!.die >= series[i - 1]!.die * 1.25);
    if (!rising) {
      const runLen = i - runStart;
      if (runLen >= minRun) {
        const seg = series.slice(runStart, i);
        const first = seg[0]!.die;
        const last = seg[seg.length - 1]!.die;
        if (last - first >= 20) {
          return {
            bin,
            passId,
            sortLabel: passIdSortLabel(passId),
            kind: "rising_trend",
            slotStart: seg[0]!.slot,
            slotEnd: seg[seg.length - 1]!.slot,
            slots: seg.map((x) => x.slot),
            peakDie: last,
            detail: `waferId ${seg[0]!.slot}–${seg[seg.length - 1]!.slot} 连续 **${runLen}** 片 BIN${bin} 递升（${first}→${last} 颗）`,
          };
        }
      }
      runStart = i;
    }
  }
  const runLen = series.length - runStart;
  if (runLen >= minRun) {
    const seg = series.slice(runStart);
    const first = seg[0]!.die;
    const last = seg[seg.length - 1]!.die;
    if (last - first >= 20) {
      return {
        bin,
        passId,
        sortLabel: passIdSortLabel(passId),
        kind: "rising_trend",
        slotStart: seg[0]!.slot,
        slotEnd: seg[seg.length - 1]!.slot,
        slots: seg.map((x) => x.slot),
        peakDie: last,
        detail: `waferId ${seg[0]!.slot}–${seg[seg.length - 1]!.slot} 连续 **${runLen}** 片 BIN${bin} 递升（${first}→${last} 颗）`,
      };
    }
  }
  return null;
}

function alertKey(a: ClusteredBadBinAlert): string {
  return `${a.bin}\0${a.passId}\0${a.kind}\0${a.slotStart}`;
}

/** 对 top 坏 bin × 各 pass 检测突增/聚集/递升（lot 全量行）。 */
export function buildClusteredBadBinAlerts(
  rows: Record<string, unknown>[],
  topBadBins: Array<{ bin: number; dieCount: number }>,
  options?: { maxBins?: number; minSeriesLen?: number }
): ClusteredBadBinAlert[] {
  const maxBins = options?.maxBins ?? 8;
  const minSeriesLen = options?.minSeriesLen ?? 4;
  const passIds = new Set<number>();
  for (const r of rows) {
    const pid = passIdFromJbRow(r);
    if (pid > 0) passIds.add(pid);
  }
  const out: ClusteredBadBinAlert[] = [];
  const seen = new Set<string>();

  for (const { bin } of topBadBins.slice(0, maxBins)) {
    for (const passId of [...passIds].sort((a, b) => a - b)) {
      const series = slotBinTotals(rows, bin, passId);
      if (series.length < minSeriesLen) continue;

      const candidates = [
        detectCluster(series, bin, passId),
        detectSuddenIncrease(series, bin, passId),
        detectRisingTrend(series, bin, passId),
      ].filter((x): x is ClusteredBadBinAlert => x != null);

      for (const c of candidates) {
        const key = alertKey(c);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(c);
      }
    }
  }

  const kindOrder: Record<ClusteredBadBinAlertKind, number> = {
    cluster: 0,
    sudden_increase: 1,
    rising_trend: 2,
  };
  return out.sort(
    (a, b) =>
      kindOrder[a.kind] - kindOrder[b.kind] ||
      b.peakDie - a.peakDie ||
      a.bin - b.bin
  );
}

export const CLUSTERED_BAD_BIN_ALERTS_GUIDE =
  "clusteredBadBinAlerts / clusteredBadBinAlertsMarkdown：按 slot 序列自动检出「单片突增」「连续聚集」「递升趋势」坏 bin；**有则数据解读首段必须点明** BIN、waferId 范围与类型，禁止只报 topBadBins 总量。";

export function formatClusteredBadBinAlertsMarkdown(
  alerts: ClusteredBadBinAlert[],
  lot?: string,
  device?: string
): string {
  if (!alerts.length) return "";

  const title = lot
    ? `**⚠ ${lot}**${device ? `（${device}）` : ""} 聚集性 / 突增坏 bin 警示`
    : "**⚠ 聚集性 / 突增坏 bin 警示**";

  const lines = [
    title,
    "",
    "以下由服务端按 **waferId(slot) 顺序** 扫描检出；解读与专业建议中 **必须首段写明**（勿仅列 lot 合计 topBadBins）。",
    "",
    "| BIN | 测试层 | 类型 | waferId 范围 | 说明 |",
    "|---:|---|---|---|",
  ];

  for (const a of alerts.slice(0, 12)) {
    const range =
      a.slotStart === a.slotEnd
        ? String(a.slotStart)
        : `${a.slotStart}–${a.slotEnd}`;
    lines.push(
      `| BIN${a.bin} | ${a.sortLabel} | ${KIND_LABEL[a.kind]} | ${range} | ${a.detail} |`
    );
  }
  if (alerts.length > 12) {
    lines.push(`| … | … | … | … | 另有 ${alerts.length - 12} 条见 JSON clusteredBadBinAlerts |`);
  }
  return lines.join("\n");
}
