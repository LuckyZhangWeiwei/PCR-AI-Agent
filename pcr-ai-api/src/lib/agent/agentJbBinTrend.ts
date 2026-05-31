// pcr-ai-api/src/lib/agent/agentJbBinTrend.ts
/** 按 slot × pass 的坏 bin 趋势（含 INTERRUPT 前半/后半/合计）。 */

import {
  binDieByHalvesForGroup,
  buildSlotYieldSummary,
  passIdFromJbRow,
  passIdSortLabel,
  splitPassGroupIntoHalves,
  type JbYieldMetrics,
  type SlotYieldSummaryEntry,
} from "../jbYieldCalc.js";

function formatPct(y: number | null | undefined): string {
  if (y === null || y === undefined || !Number.isFinite(y)) return "—";
  return `${Math.round(y * 100) / 100}%`;
}

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

export type SlotsByPassEntry = {
  passId: number;
  sortLabel: string;
  slots: number[];
  slotCount: number;
};

export type BadBinSlotTrendEntry = {
  bin: number;
  passId: number;
  sortLabel: string;
  markdown: string;
};

/** 各 passId 下实际有测试行的 slot 列表（含 INTERRUPT 行）。 */
export function buildSlotsByPassId(
  rows: Record<string, unknown>[]
): SlotsByPassEntry[] {
  const byPass = new Map<number, Set<number>>();
  for (const row of rows) {
    const slot = Number(row.SLOT ?? row.slot);
    const passId = passIdFromJbRow(row);
    if (!Number.isFinite(slot) || slot <= 0 || passId <= 0) continue;
    if (!byPass.has(passId)) byPass.set(passId, new Set());
    byPass.get(passId)!.add(slot);
  }
  return [...byPass.keys()]
    .sort((a, b) => a - b)
    .map((passId) => {
      const slots = [...(byPass.get(passId) ?? [])].sort((a, b) => a - b);
      return {
        passId,
        sortLabel: passIdSortLabel(passId),
        slots,
        slotCount: slots.length,
      };
    });
}

function distinctSlotsFromRows(rows: Record<string, unknown>[]): number[] {
  const s = new Set<number>();
  for (const row of rows) {
    const slot = Number(row.SLOT ?? row.slot);
    if (Number.isFinite(slot) && slot > 0) s.add(slot);
  }
  return [...s].sort((a, b) => a - b);
}

function slotHasPassRows(
  rows: Record<string, unknown>[],
  slot: number,
  passId: number
): boolean {
  return groupRowsForSlotPass(rows, slot, passId).length > 0;
}

function appendBinSegmentRows(
  lines: string[],
  slot: number,
  sortLabel: string,
  segment: string,
  bin: number,
  binDie: number,
  m: JbYieldMetrics
): void {
  lines.push(
    `| ${slot} | ${sortLabel} | ${segment} | ${binDie} | ${m.grossDie} | ${m.goodDie} | ${m.badDie} | ${formatPct(m.yieldPct)} |`
  );
}

/** 有中断的 (slot,passId)：BIN 与良率均按 整片→前半→后半 三行。 */
export function formatInterruptBinYieldMarkdown(
  rows: Record<string, unknown>[],
  summary: SlotYieldSummaryEntry[],
  bin: number,
  passId: number,
  lot?: string,
  device?: string
): string {
  const sortLabel = passIdSortLabel(passId);
  const title = lot
    ? `**${lot}** BIN${bin} + 良率（${sortLabel}，有中断片分段）`
    : `**BIN${bin} + 良率（${sortLabel}，有中断片分段）**`;

  const interruptEntries = summary.filter(
    (e) => e.passId === passId && e.hasInterrupt && e.interruptHalf
  );
  if (!interruptEntries.length) return "";

  const lines = [
    title,
    "",
    "有测试中断的 slot：**BIN 颗数与良率均须写整片正片、前半段、后半段**（0 也写）。",
    "",
    `| Slot | 测试层 | 段 | BIN${bin} | 总die | 好die | 坏die | 良率% |`,
    "|---:|---|---:|---:|---:|---:|---:|---:|",
  ];

  for (const e of interruptEntries.sort((a, b) => a.slot - b.slot)) {
    const group = groupRowsForSlotPass(rows, e.slot, passId);
    const split = splitPassGroupIntoHalves(group);
    const wholeBin = binDieByHalvesForGroup(group, bin).total;
    appendBinSegmentRows(
      lines,
      e.slot,
      sortLabel,
      "整片正片",
      bin,
      wholeBin,
      {
        grossDie: e.grossDie,
        badDie: e.badDie,
        goodDie: e.goodDie,
        yieldPct: e.yieldPct,
      }
    );
    const firstBin = split.segmented
      ? binDieByHalvesForGroup(group, bin).firstHalf
      : 0;
    appendBinSegmentRows(
      lines,
      e.slot,
      sortLabel,
      "前半段",
      bin,
      firstBin,
      e.interruptHalf!
    );
    if (e.completionHalf) {
      const secondBin = split.segmented
        ? binDieByHalvesForGroup(group, bin).secondHalf
        : 0;
      appendBinSegmentRows(
        lines,
        e.slot,
        sortLabel,
        "后半段",
        bin,
        secondBin,
        e.completionHalf
      );
    }
  }
  return lines.join("\n");
}

/**
 * BIN 按 slot 趋势表（固定 passId）。
 * 无中断：合计 BIN + 整片良率；有中断：合计/前半/后半 BIN + 整片/前半/后半良率。
 */
export function formatBinSlotTrendMarkdown(
  rows: Record<string, unknown>[],
  bin: number,
  passId: number,
  lot?: string,
  device?: string
): string {
  const slots = distinctSlotsFromRows(rows);
  if (!slots.length) return "";

  const summary = buildSlotYieldSummary(rows);
  const summaryByKey = new Map<string, SlotYieldSummaryEntry>();
  for (const e of summary) {
    summaryByKey.set(`${e.slot}:${e.passId}`, e);
  }

  const sortLabel = passIdSortLabel(passId);
  const title = lot
    ? `**${lot}**${device ? `（${device}）` : ""} BIN${bin} 按 slot（${sortLabel}，passId=${passId}）`
    : `**BIN${bin} 按 slot（${sortLabel}，passId=${passId}）**`;

  const lines = [
    title,
    "",
    "有中断：**BIN 与良率均分列前半/后半/整片**；无中断仅合计列。禁止写「无数据」若该层有测试行。",
    "",
    `| Slot | BIN${bin}合计 | BIN${bin}前半 | BIN${bin}后半 | 整片良率% | 前半良率% | 后半良率% | 中断 | 较上片Δ |`,
    "|---:|---:|---:|---:|---:|---:|---:|---|---|",
  ];

  let prevTotal: number | null = null;
  for (const slot of slots) {
    const hasPass = slotHasPassRows(rows, slot, passId);
    const s = summaryByKey.get(`${slot}:${passId}`);
    if (!hasPass) {
      lines.push(`| ${slot} | — | — | — | — | — | — | 无测试行 | — |`);
      prevTotal = null;
      continue;
    }
    const group = groupRowsForSlotPass(rows, slot, passId);
    const binH = binDieByHalvesForGroup(group, bin);
    const interrupt = s?.hasInterrupt ?? false;

    const binTotal = String(binH.total);
    const binFirst = interrupt ? String(binH.firstHalf) : "—";
    const binSecond =
      interrupt && binH.segmented ? String(binH.secondHalf) : "—";

    const yWhole = formatPct(s?.yieldPct);
    const yFirst = interrupt ? formatPct(s?.interruptHalf?.yieldPct) : "—";
    const ySecond =
      interrupt && s?.completionHalf
        ? formatPct(s.completionHalf.yieldPct)
        : interrupt
          ? "—"
          : "—";

    let delta = "—";
    if (prevTotal !== null) {
      const d = binH.total - prevTotal;
      delta = d > 0 ? `↑${d}` : d < 0 ? `↓${-d}` : "0";
    }
    lines.push(
      `| ${slot} | ${binTotal} | ${binFirst} | ${binSecond} | ${yWhole} | ${yFirst} | ${ySecond} | ${interrupt ? "是" : "否"} | ${delta} |`
    );
    prevTotal = binH.total;
  }

  const withPass = slots.filter((slot) => slotHasPassRows(rows, slot, passId));
  lines.push("");
  lines.push(
    `**覆盖**：${sortLabel} 共 **${withPass.length}** 片有测试行（slot: ${withPass.join(", ")}）。`
  );

  const interruptMd = formatInterruptBinYieldMarkdown(
    rows,
    summary,
    bin,
    passId,
    lot,
    device
  );
  if (interruptMd) {
    lines.push("");
    lines.push(interruptMd);
  }

  return lines.join("\n");
}

/** 为 top 坏 bin 在各出现的 passId 上生成 slot 趋势 markdown。 */
export function buildBadBinSlotTrends(
  rows: Record<string, unknown>[],
  topBins: Array<{ bin: number; dieCount: number }>,
  lot?: string,
  device?: string,
  maxBins = 5
): BadBinSlotTrendEntry[] {
  const out: BadBinSlotTrendEntry[] = [];
  for (const { bin } of topBins.slice(0, maxBins)) {
    const passIds = new Set<number>();
    for (const { passId, slots } of buildSlotsByPassId(rows)) {
      for (const slot of slots) {
        const group = groupRowsForSlotPass(rows, slot, passId);
        if (binDieByHalvesForGroup(group, bin).total > 0) passIds.add(passId);
      }
    }
    for (const passId of [...passIds].sort((a, b) => a - b)) {
      const markdown = formatBinSlotTrendMarkdown(
        rows,
        bin,
        passId,
        lot,
        device
      );
      if (!markdown) continue;
      out.push({
        bin,
        passId,
        sortLabel: passIdSortLabel(passId),
        markdown,
      });
    }
  }
  return out;
}

export const SLOTS_BY_PASS_GUIDE =
  "slotsByPassId：各 passId 下有测试行的 slot 列表（含 INTERRUPT）。slot 在列表中则禁止写「无常温/无 sort1 数据」。";

export const BAD_BIN_SLOT_TRENDS_GUIDE =
  "badBinSlotTrends：BIN 按 slot 表含合计/前半/后半颗数与整片/前半/后半良率；有中断片另附三行明细表。禁止只报后半段。";
