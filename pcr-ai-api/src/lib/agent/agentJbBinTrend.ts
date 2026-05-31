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

/** 有中断的 (slot,passId)：BIN 与良率均按 前半→后半→整片合并 三行。 */
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
    "有测试中断的 wafer：**先写前半段、后半段（各中断/续测段），再写整片正片（合并）**（0 也写）。",
    "",
    `| Slot | 测试层 | 段 | BIN${bin} | 总die | 好die | 坏die | 良率% |`,
    "|---:|---|---:|---:|---:|---:|---:|---:|",
  ];

  for (const e of interruptEntries.sort((a, b) => a.slot - b.slot)) {
    const group = groupRowsForSlotPass(rows, e.slot, passId);
    const split = splitPassGroupIntoHalves(group);
    const binHalves = binDieByHalvesForGroup(group, bin);
    const firstBin = split.segmented ? binHalves.firstHalf : 0;
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
      const secondBin = split.segmented ? binHalves.secondHalf : 0;
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
    appendBinSegmentRows(
      lines,
      e.slot,
      sortLabel,
      "整片正片（合并）",
      bin,
      binHalves.total,
      {
        grossDie: e.grossDie,
        badDie: e.badDie,
        goodDie: e.goodDie,
        yieldPct: e.yieldPct,
      }
    );
  }
  return lines.join("\n");
}

/**
 * BIN 按 slot 趋势表（固定 passId）。
 * 无中断：合计 BIN + 整片良率；有中断：前半/后半/合计 BIN + 前半/后半/整片良率（列顺序同输出逻辑）。
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
    "有中断：**先前半/后半各段，再合计与整片良率**；无中断仅合计列。禁止写「无数据」若该层有测试行。",
    "",
    `| Slot | BIN${bin}前半 | BIN${bin}后半 | BIN${bin}合计 | 前半良率% | 后半良率% | 整片良率% | 中断 | 较上片Δ |`,
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

    const binFirst = interrupt ? String(binH.firstHalf) : "—";
    const binSecond =
      interrupt && binH.segmented ? String(binH.secondHalf) : "—";
    const binTotal = String(binH.total);

    const yFirst = interrupt ? formatPct(s?.interruptHalf?.yieldPct) : "—";
    const ySecond =
      interrupt && s?.completionHalf
        ? formatPct(s.completionHalf.yieldPct)
        : interrupt
          ? "—"
          : "—";
    const yWhole = formatPct(s?.yieldPct);

    let delta = "—";
    if (prevTotal !== null) {
      const d = binH.total - prevTotal;
      delta = d > 0 ? `↑${d}` : d < 0 ? `↓${-d}` : "0";
    }
    lines.push(
      `| ${slot} | ${binFirst} | ${binSecond} | ${binTotal} | ${yFirst} | ${ySecond} | ${yWhole} | ${interrupt ? "是" : "否"} | ${delta} |`
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

function binsFieldForTrendRow(r: Record<string, unknown>): unknown {
  if (r["bins"] != null) return r["bins"];
  const bad = r["badBins"] as unknown[] | undefined;
  const good = r["goodBins"] as unknown[] | undefined;
  return [...(Array.isArray(bad) ? bad : []), ...(Array.isArray(good) ? good : [])];
}

/** 写入 session 缓存的精简行（仅供总结轮按需生成 BIN 趋势表）。 */
export function slimRowsForBinTrend(
  rows: Record<string, unknown>[]
): Record<string, unknown>[] {
  return rows.map((r) => ({
    LOT: r["LOT"] ?? r["lot"],
    DEVICE: r["DEVICE"] ?? r["device"],
    SLOT: r["SLOT"] ?? r["slot"],
    PASSID: passIdFromJbRow(r),
    PASSNUM: r["PASSNUM"] ?? r["passNum"],
    PASSTYPE: r["PASSTYPE"] ?? r["passType"],
    GROSSDIE: r["GROSSDIE"] ?? r["grossDie"],
    CARDID: r["CARDID"] ?? r["cardId"],
    TESTEND: r["TESTEND"] ?? r["testEnd"],
    bins: binsFieldForTrendRow(r),
  }));
}

function passHasBinDie(
  rows: Record<string, unknown>[],
  bin: number,
  passId: number
): boolean {
  for (const slot of distinctSlotsFromRows(rows)) {
    const h = binDieByHalvesForGroup(
      groupRowsForSlotPass(rows, slot, passId),
      bin
    );
    if (h.total > 0) return true;
  }
  return false;
}

/** 用户指定 BIN 且未预生成 trend 时，从缓存行现场生成全 slot 表。 */
export function buildBinSlotTrendMarkdownOnDemand(
  payload: Record<string, unknown>,
  bin: number,
  userMessage: string
): string | null {
  const rows = payload["_trendRows"] as Record<string, unknown>[] | undefined;
  if (!rows?.length) return null;
  const lot = String(payload["lot"] ?? "").trim() || undefined;
  const device = String(payload["device"] ?? "").trim() || undefined;
  const passIds =
    (payload["passIdsPresent"] as number[] | undefined) ?? [1, 3, 5];
  const existing = (
    (payload["badBinSlotTrends"] as BadBinSlotTrendEntry[] | undefined) ?? []
  ).filter((t) => t.bin === bin);
  const pref = pickPassIdFromUserText(userMessage, existing, passIds);
  const order = [
    ...(pref != null ? [pref] : []),
    ...passIds.filter((p) => p !== pref),
  ];
  const parts: string[] = [];
  for (const passId of order) {
    if (!passHasBinDie(rows, bin, passId)) continue;
    const md = formatBinSlotTrendMarkdown(rows, bin, passId, lot, device);
    if (md?.trim()) parts.push(md);
    if (pref != null) return md;
  }
  return parts.length ? parts.join("\n\n") : null;
}

function pickPassIdFromUserText(
  userMessage: string,
  existing: BadBinSlotTrendEntry[],
  passIds: number[]
): number | null {
  if (/常温|sort\s*1|pass\s*1|passId\s*[=:]?\s*1/i.test(userMessage)) return 1;
  if (/高温|sort\s*2|pass\s*3|passId\s*[=:]?\s*3/i.test(userMessage)) return 3;
  if (/低温|sort\s*3|pass\s*5|passId\s*[=:]?\s*5/i.test(userMessage)) return 5;
  const inTrends = [...new Set(existing.map((t) => t.passId))].sort(
    (a, b) => a - b
  );
  if (inTrends.length === 1) return inTrends[0]!;
  if (passIds.includes(1)) return 1;
  return passIds[0] ?? null;
}

/** 为 top 坏 bin（最多 15 个）在各出现的 passId 上生成 slot 趋势 markdown。 */
export function buildBadBinSlotTrends(
  rows: Record<string, unknown>[],
  topBins: Array<{ bin: number; dieCount: number }>,
  lot?: string,
  device?: string,
  maxBins = 15
): BadBinSlotTrendEntry[] {
  const out: BadBinSlotTrendEntry[] = [];
  const binNums = [
    ...new Set(topBins.slice(0, maxBins).map((t) => t.bin)),
  ];
  for (const bin of binNums) {
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
  "slotsByPassId：各 passId 下有测试行的 waferId(slot) 列表（含 INTERRUPT）。在列表中则禁止写「无 pass1 数据」。";

export const BAD_BIN_SLOT_TRENDS_GUIDE =
  "badBinSlotTrends：有中断时先前半/后半段 BIN 与良率，再合计与整片合并；明细表三行顺序：前半→后半→整片正片（合并）。禁止只报后半段。";
