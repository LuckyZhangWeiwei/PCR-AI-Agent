// pcr-ai-api/src/lib/agent/agentJbHistoryCompact.ts
/** query_jb_bins 写入会话历史时的压缩与空总结回退文案。 */

import {
  buildSlotYieldInterruptRows,
  buildSlotYieldPivot,
  passIdSortLabel,
  type JbYieldMetrics,
  type SlotYieldSummaryEntry,
  type SlotYieldPivot,
  type YieldByPassEntry,
} from "../jbYieldCalc.js";
import type { CardByPassIdEntry } from "./agentJbBinFormat.js";
import { jbYieldCoreFields } from "./agentJbYieldCore.js";

function roundYieldPct(v: number | null): number | null {
  if (v === null || !Number.isFinite(v)) return null;
  return Math.round(v * 100) / 100;
}

function passSortLabel(passId: number): string {
  return passIdSortLabel(passId);
}

function primaryLotDevice(o: Record<string, unknown>): { lot: string; device: string } {
  const recent = o["recentLotsByTestEnd"] as Array<{ lot?: string; device?: string }> | undefined;
  if (recent?.[0]?.lot) {
    return {
      lot: String(recent[0].lot),
      device: String(recent[0].device ?? ""),
    };
  }
  const rank = o["lotYieldRankByTestEnd"] as Array<{ lot?: string; device?: string }> | undefined;
  if (rank?.[0]?.lot) {
    return {
      lot: String(rank[0].lot),
      device: String(rank[0].device ?? ""),
    };
  }
  return {
    lot: String(o["lot"] ?? ""),
    device: String(o["device"] ?? ""),
  };
}

function slimMetrics(m: JbYieldMetrics): JbYieldMetrics {
  return {
    grossDie: m.grossDie,
    badDie: m.badDie,
    goodDie: m.goodDie,
    yieldPct: roundYieldPct(m.yieldPct),
  };
}

function slimSummary(
  summary: SlotYieldSummaryEntry[] | undefined
): Array<Record<string, unknown>> {
  if (!summary?.length) return [];
  return summary.map((e) => {
    const row: Record<string, unknown> = {
      slot: e.slot,
      passId: e.passId,
      yieldPct: roundYieldPct(e.yieldPct),
      grossDie: e.grossDie,
      badDie: e.badDie,
      goodDie: e.goodDie,
    };
    if (e.hasInterrupt) {
      row.hasInterrupt = true;
      if (e.interruptHalf) row.interruptHalf = slimMetrics(e.interruptHalf);
      if (e.completionHalf) row.completionHalf = slimMetrics(e.completionHalf);
    }
    return row;
  });
}

function formatMetricsCell(y: number | null): string {
  return y === null ? "—" : `${roundYieldPct(y)}%`;
}

function formatPct(y: number | null | undefined): string {
  if (y === null || y === undefined || !Number.isFinite(y)) return "—";
  return `${roundYieldPct(y)}%`;
}

function appendSegmentRows(
  lines: string[],
  slot: number,
  sortLabel: string,
  segment: string,
  m: JbYieldMetrics
): void {
  lines.push(
    `| ${slot} | ${sortLabel} | ${segment} | ${m.grossDie} | ${m.goodDie} | ${m.badDie} | ${formatMetricsCell(m.yieldPct)} |`
  );
}

/** 有中断：先各中断/续测段，再合并整片（前半 → 后半 → 整片正片）。 */
export function appendInterruptYieldSegmentRows(
  lines: string[],
  slot: number,
  sortLabel: string,
  whole: JbYieldMetrics,
  interruptHalf: JbYieldMetrics,
  completionHalf?: JbYieldMetrics
): void {
  appendSegmentRows(lines, slot, sortLabel, "前半段", interruptHalf);
  if (completionHalf) {
    appendSegmentRows(lines, slot, sortLabel, "后半段", completionHalf);
  }
  appendSegmentRows(lines, slot, sortLabel, "整片正片（合并）", whole);
}

/** 有 INTERRUPT/续测的 (slot,passId)：固定顺序 前半 → 后半 → 整片正片（合并）。 */
export function formatSlotYieldInterruptMarkdown(
  summary: SlotYieldSummaryEntry[],
  lot?: string,
  device?: string
): string {
  const rows = buildSlotYieldInterruptRows(summary);
  if (!rows.length) return "";

  const title = lot
    ? `**${lot}**${device ? `（${device}）` : ""} 测试中断 wafer 良率（前半→后半→整片合并）`
    : "**测试中断 wafer 良率（前半→后半→整片合并）**";

  const lines = [
    title,
    "",
    `共 **${rows.length}** 个 (waferId×pass) 有中断/续测；**先逐段**（前半、后半），**再整片合并**；良率 **0% 也写**。`,
    "",
    "| Slot | 测试层 | 段 | 总die | 好die | 坏die | 良率% |",
    "|---:|---|---:|---:|---:|---:|---:|",
  ];

  for (const r of rows) {
    appendInterruptYieldSegmentRows(
      lines,
      r.slot,
      r.sortLabel,
      r.wholeWafer,
      r.interruptHalf,
      r.completionHalf
    );
  }
  return lines.join("\n");
}

export function formatCardByPassIdMarkdown(
  entries: CardByPassIdEntry[]
): string {
  if (!entries.length) return "";
  const sorted = [...entries].sort((a, b) => a.passId - b.passId);
  const lines = [
    "**各测试层探针卡（cardByPassId）**",
    "",
    "| 测试层 | passId | 卡号 | 同层中途换卡 |",
    "|---|---:|---|---|",
  ];
  for (const e of sorted) {
    lines.push(
      `| ${passIdSortLabel(e.passId)} | ${e.passId} | ${e.cardIds.join(", ") || "—"} | ${e.hasCardChange ? "是" : "否"} |`
    );
  }
  return lines.join("\n");
}

export function formatYieldByPassSection(byPass: YieldByPassEntry[]): string {
  if (!byPass.length) return "";
  const lines = ["**分测试层（sort）批次良率**", "", "| 测试层 | passId | 片数 | 总die | 坏die | 良率% |"];
  lines.push("|---|---:|---:|---:|---:|---:|");
  for (const p of byPass) {
    const y = p.yieldPct === null ? "—" : `${roundYieldPct(p.yieldPct)}%`;
    lines.push(
      `| ${p.sortLabel} | ${p.passId} | ${p.slotCount} | ${p.grossDie} | ${p.badDie} | ${y} |`
    );
  }
  return lines.join("\n");
}

/** 多 pass 时：每行 slot，每列一个 sort；有中断的格显示 整片/前/后 良率。 */
export function formatSlotYieldPivotMarkdown(
  pivot: SlotYieldPivot,
  lot?: string,
  device?: string,
  summary?: SlotYieldSummaryEntry[]
): string {
  if (!pivot.slots.length || !pivot.passIds.length) return "";

  const title = lot
    ? `**${lot}**${device ? `（${device}）` : ""} 各片良率（按测试层分列）`
    : "各片良率（按测试层分列）";

  const header = [
    "| Slot |",
    ...pivot.passLabels.map((l) => ` ${l} 良率% |`),
    " 坏die合计 |",
  ].join("");
  const sep = [
    "|---:|",
    ...pivot.passIds.map(() => "---:|"),
    "---:|",
  ].join("");

  const lines = [
    title,
    "",
    "有中断的格子为 **前/后/整（合并）** 良率（按测试时间：前半→后半→整片）。",
    "",
    header,
    sep,
  ];
  for (const slot of pivot.slots) {
    const cells = pivot.passIds.map((passId) => {
      const c = pivot.cells[`${slot}:${passId}`];
      if (!c) return " — |";
      const e = summary?.find((s) => s.slot === slot && s.passId === passId);
      if (e?.hasInterrupt && e.interruptHalf) {
        const whole =
          e.yieldPct === null ? "—" : `${roundYieldPct(e.yieldPct)}%`;
        const first = formatPct(e.interruptHalf.yieldPct);
        const second = e.completionHalf
          ? formatPct(e.completionHalf.yieldPct)
          : "—";
        return ` ${first}前/${second}后/${whole}整 |`;
      }
      const y =
        c.yieldPct === null ? "—" : `${roundYieldPct(c.yieldPct)}%`;
      return ` ${y} |`;
    });
    let badSum = 0;
    for (const passId of pivot.passIds) {
      badSum += pivot.cells[`${slot}:${passId}`]?.badDie ?? 0;
    }
    lines.push(`| ${slot} |${cells.join("")} ${badSum} |`);
  }
  return lines.join("\n");
}

export function formatLotYieldOverviewMarkdown(
  o: Record<string, unknown>
): string | null {
  const summary = o["slotYieldSummary"] as SlotYieldSummaryEntry[] | undefined;
  if (!summary?.length) return null;
  const { lot, device } = primaryLotDevice(o);
  const byPass = o["yieldByPassId"] as YieldByPassEntry[] | undefined;
  const pivotRaw = o["slotYieldPivot"] as SlotYieldPivot | undefined;

  const parts: string[] = [];
  const cardMd = formatCardByPassIdMarkdown(
    (o["cardByPassId"] as CardByPassIdEntry[] | undefined) ?? []
  );
  if (cardMd) {
    parts.push(cardMd);
    parts.push("");
  }
  if (byPass?.length) {
    parts.push(formatYieldByPassSection(byPass));
    parts.push("");
  }

  const interruptMd = formatSlotYieldInterruptMarkdown(summary, lot, device);
  if (interruptMd) {
    parts.push(interruptMd);
    parts.push("");
  }

  const pivot =
    pivotRaw ??
    (summary.length > 0 ? buildSlotYieldPivot(summary) : undefined);
  if (pivot && pivot.passIds.length > 0) {
    const noInterrupt = summary.filter((e) => !e.hasInterrupt);
    if (noInterrupt.length > 0) {
      const pivotNoInt = buildSlotYieldPivot(noInterrupt);
      if (pivotNoInt.slots.length > 0) {
        parts.push(
          formatSlotYieldPivotMarkdown(pivotNoInt, lot, device, summary).replace(
            "各片良率（按测试层分列）",
            "无中断 slot 良率（按测试层分列）"
          )
        );
      }
    } else if (pivot.passIds.length > 1) {
      parts.push(formatSlotYieldPivotMarkdown(pivot, lot, device, summary));
    }
  }

  if (parts.length === 0) {
    const simple = formatSlotYieldFlatTable(summary, lot, device);
    if (simple) parts.push(simple);
  }

  return parts.filter(Boolean).join("\n\n") || null;
}

/** 无 pivot 或单层时的平铺表（每行含测试层）。 */
function formatSlotYieldFlatTable(
  summary: SlotYieldSummaryEntry[],
  lot?: string,
  device?: string
): string {
  if (!summary.length) return "";
  const title = lot
    ? `**${lot}**${device ? `（${device}）` : ""} 各片良率`
    : "各片良率";
  const lines = [
    title,
    "",
    "| Slot | 测试层 | 段 | 总die | 好die | 坏die | 良率% |",
    "|---:|---|---:|---:|---:|---:|---:|",
  ];
  for (const e of [...summary].sort(
    (a, b) => a.slot - b.slot || a.passId - b.passId
  )) {
    const sortLabel = passSortLabel(e.passId);
    if (e.hasInterrupt && e.interruptHalf) {
      appendInterruptYieldSegmentRows(
        lines,
        e.slot,
        sortLabel,
        {
          grossDie: e.grossDie,
          badDie: e.badDie,
          goodDie: e.goodDie,
          yieldPct: e.yieldPct,
        },
        e.interruptHalf,
        e.completionHalf
      );
    } else {
      appendSegmentRows(lines, e.slot, sortLabel, "整片", {
        grossDie: e.grossDie,
        badDie: e.badDie,
        goodDie: e.goodDie,
        yieldPct: e.yieldPct,
      });
    }
  }
  return lines.join("\n");
}

function shrinkSlotSummaryForHistory(
  slim: Array<Record<string, unknown>>,
  maxChars: number,
  core: Record<string, unknown>
): string | null {
  const copy = [...slim];
  while (copy.length > 0) {
    const s = JSON.stringify({
      ...core,
      _historyNote: "slotYieldSummary 已截短；结论以 lotYieldOverviewMarkdown 为准",
      rowsOmitted: true,
      slotYieldSummary: copy,
    });
    if (s.length <= maxChars) return s;
    copy.pop();
  }
  const coreOnly = JSON.stringify({
    ...core,
    _historyNote: "仅保留核心良率字段",
    rowsOmitted: true,
  });
  return coreOnly.length <= maxChars ? coreOnly : null;
}

/** 保证写入 history 的 JSON 可解析且优先保留分 sort 良率核心字段。 */
export function compactJbBinsForHistory(
  rawJson: string,
  maxChars: number
): string {
  if (rawJson.length <= maxChars) {
    try {
      JSON.parse(rawJson);
      return rawJson;
    } catch {
      /* fall through */
    }
  }

  let o: Record<string, unknown>;
  try {
    o = JSON.parse(rawJson) as Record<string, unknown>;
  } catch {
    return `{"_historyNote":"工具结果 JSON 无效，请重试 query_jb_bins"}`;
  }

  const { lot, device } = primaryLotDevice(o);
  const fullSummary = o["slotYieldSummary"] as SlotYieldSummaryEntry[] | undefined;
  const slim = slimSummary(fullSummary);
  const core = jbYieldCoreFields(o);

  const tiers: Array<() => Record<string, unknown>> = [
    () => ({
      _historyNote:
        "rows 已省略；lot 概况读 lotYieldOverviewMarkdown；分 sort 读 yieldByPassIdMarkdown",
      rowsOmitted: true,
      rowCount: o["rowCount"] ?? o["count"],
      ...core,
      topBadBins: o["topBadBins"],
      cardByPassId: o["cardByPassId"],
      cardChangesBySlotPass: o["cardChangesBySlotPass"],
      distinctSlots: o["distinctSlots"],
      distinctLotSlotCount: o["distinctLotSlotCount"],
      slotsByPassId: o["slotsByPassId"],
      badBinSlotTrends: o["badBinSlotTrends"],
      agentTablesDigest: o["agentTablesDigest"],
      slotYieldPivotMarkdown: o["slotYieldPivotMarkdown"],
      slotYieldSummary: slim,
    }),
    () => ({
      _historyNote: "精简历史；结论以 lotYieldOverviewMarkdown / yieldByPassIdMarkdown 为准",
      rowsOmitted: true,
      ...core,
      slotYieldSummary: slim,
    }),
    () => ({
      ...core,
      rowsOmitted: true,
      slotYieldSummary: slim,
    }),
  ];

  for (const build of tiers) {
    const s = JSON.stringify(build());
    if (s.length <= maxChars) return s;
  }

  const shrunk = shrinkSlotSummaryForHistory(slim, maxChars, core);
  if (shrunk) return shrunk;
  return JSON.stringify({
    ...core,
    _historyNote: "历史压缩极限；请读 lotYieldOverviewMarkdown",
    rowsOmitted: true,
  });
}

/** 总结轮 LLM 无输出时，由服务端生成含分 sort 的良率表。 */
export function formatSlotYieldMarkdownFromToolJson(
  rawJson: string
): string | null {
  try {
    return formatLotYieldOverviewMarkdown(
      JSON.parse(rawJson) as Record<string, unknown>
    );
  } catch {
    return null;
  }
}
