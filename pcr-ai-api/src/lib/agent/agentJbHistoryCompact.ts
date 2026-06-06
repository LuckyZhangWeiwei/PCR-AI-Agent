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
  type YieldInterruptSegment,
} from "../jbYieldCalc.js";
import type { CardByPassIdEntry, LotTesterEntry } from "./agentJbBinFormat.js";
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
      if (e.testInterruptCount > 0) row.testInterruptCount = e.testInterruptCount;
      if (e.interruptHalf) row.interruptHalf = slimMetrics(e.interruptHalf);
      if (e.completionHalf) row.completionHalf = slimMetrics(e.completionHalf);
      if (e.interruptSegments?.length) {
        row.interruptSegments = e.interruptSegments.map((s) => ({
          label: s.label,
          metrics: slimMetrics(s.metrics),
        }));
      }
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

/** 有中断：按 interruptSegments 逐段；无 segments 时回退前半→后半→整片。 */
export function appendInterruptYieldSegmentRows(
  lines: string[],
  slot: number,
  sortLabel: string,
  whole: JbYieldMetrics,
  interruptHalf: JbYieldMetrics,
  completionHalf?: JbYieldMetrics,
  interruptSegments?: YieldInterruptSegment[]
): void {
  if (interruptSegments?.length) {
    for (const seg of interruptSegments) {
      appendSegmentRows(lines, slot, sortLabel, seg.label, seg.metrics);
    }
    return;
  }
  appendSegmentRows(lines, slot, sortLabel, "前半段", interruptHalf);
  if (completionHalf) {
    appendSegmentRows(lines, slot, sortLabel, "后半段", completionHalf);
  }
  appendSegmentRows(lines, slot, sortLabel, "整片正片（合并）", whole);
}

/** JB STAR 机台（TESTERID）；Yield Monitor 同机台为 HOSTNAME。 */
export function formatLotTesterMarkdown(
  entries: LotTesterEntry[],
  focusLot?: string
): string {
  const list = focusLot?.trim()
    ? entries.filter((e) => e.lot === focusLot.trim())
    : entries;
  if (!list.length) return "";

  const title = focusLot?.trim()
    ? `**${focusLot.trim()}** 测试机台`
    : "**测试机台**";

  const lines = [
    title,
    "",
    "| 批次 lot | 机台 TESTERID | 本批出现过的机台 |",
    "|---|---|---|",
  ];

  for (const e of list) {
    const all =
      e.testerIds.length > 1
        ? e.testerIds.join(", ")
        : e.testerIds[0] || "—";
    lines.push(
      `| ${e.lot} | ${e.primaryTesterId || "—"} | ${all} |`
    );
  }
  return lines.join("\n");
}

/** 各 (waferId×pass) 测试中断次数（与良率前半/后半段数无关）。 */
export function formatTestInterruptCountMarkdown(
  summary: SlotYieldSummaryEntry[],
  lot?: string,
  device?: string
): string {
  const rows = summary.filter((e) => e.testInterruptCount > 0);
  if (!rows.length) return "";

  const title = lot
    ? `**${lot}**${device ? `（${device}）` : ""} 各片测试中断次数`
    : "**各片测试中断次数**";

  const lines = [
    title,
    "",
    "| waferId | 测试层 | 中断次数 |",
    "|---:|---|---:|",
  ];

  for (const e of [...rows].sort(
    (a, b) => a.slot - b.slot || a.passId - b.passId
  )) {
    lines.push(
      `| ${e.slot} | ${passSortLabel(e.passId)} | ${e.testInterruptCount} |`
    );
  }
  return lines.join("\n");
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
      r.completionHalf,
      r.interruptSegments
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

  // Single-pass: two-column layout to halve table height
  if (pivot.passIds.length === 1) {
    const passId = pivot.passIds[0]!;
    const passLabel = pivot.passLabels[0]!;
    const hdr = `| Slot | ${passLabel} 良率% | 坏die合计 | Slot | ${passLabel} 良率% | 坏die合计 |`;
    const sep2 = `|---:|---:|---:|---:|---:|---:|`;
    const pairLines = [title, "", hdr, sep2];
    for (let i = 0; i < pivot.slots.length; i += 2) {
      const s1 = pivot.slots[i]!;
      const c1 = pivot.cells[`${s1}:${passId}`];
      const y1 = c1 ? (c1.yieldPct === null ? "—" : `${roundYieldPct(c1.yieldPct)}%`) : "—";
      const bad1 = c1?.badDie ?? 0;
      if (i + 1 < pivot.slots.length) {
        const s2 = pivot.slots[i + 1]!;
        const c2 = pivot.cells[`${s2}:${passId}`];
        const y2 = c2 ? (c2.yieldPct === null ? "—" : `${roundYieldPct(c2.yieldPct)}%`) : "—";
        const bad2 = c2?.badDie ?? 0;
        pairLines.push(`| ${s1} | ${y1} | ${bad1} | ${s2} | ${y2} | ${bad2} |`);
      } else {
        pairLines.push(`| ${s1} | ${y1} | ${bad1} | | | |`);
      }
    }
    pairLines.push("");
    return pairLines.join("\n");
  }

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
  // 表后空行，避免后续解读段落被 GFM 误解析为表内最后一行
  lines.push("");
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
  const testerMd =
    typeof o["testerIdMarkdown"] === "string"
      ? o["testerIdMarkdown"]
      : formatLotTesterMarkdown(
          (o["testerByLot"] as LotTesterEntry[] | undefined) ?? [],
          lot || undefined
        );
  if (testerMd?.trim()) {
    parts.push(testerMd.trim());
    parts.push("");
  }
  // cardByPassId (raw array) is not preserved in session cache; fall back to
  // the pre-formatted string so the probe-card section survives serialization.
  const prebuiltCardMd =
    typeof o["cardByPassIdMarkdown"] === "string"
      ? (o["cardByPassIdMarkdown"] as string).trim()
      : "";
  const cardMd =
    prebuiltCardMd ||
    formatCardByPassIdMarkdown(
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

  const interruptCountMd = formatTestInterruptCountMarkdown(summary, lot, device);
  if (interruptCountMd) {
    parts.push(interruptCountMd);
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
        e.completionHalf,
        e.interruptSegments
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
  lines.push("");
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

/**
 * 将 buildJbSessionCacheJson 写入 history：优先保留 _trendRows（BIN 趋势按需建表）。
 */
export function compactJbCacheForHistory(
  cacheJson: string,
  maxChars: number
): string {
  if (cacheJson.length <= maxChars) {
    try {
      JSON.parse(cacheJson);
      return cacheJson;
    } catch {
      /* fall through */
    }
  }

  let o: Record<string, unknown>;
  try {
    o = JSON.parse(cacheJson) as Record<string, unknown>;
  } catch {
    return cacheJson.slice(0, maxChars);
  }

  const trendRows = o["_trendRows"];
  const tiers: Array<() => Record<string, unknown>> = [
    () => o,
    () => ({
      _historyNote:
        "JB 总结轮缓存；BIN 趋势读 badBinSlotTrends 或 _trendRows 按需生成；概况读 lotYieldOverviewMarkdown",
      rowsOmitted: true,
      ...jbYieldCoreFields(o),
      _jbSessionCacheVersion: o["_jbSessionCacheVersion"],
      _trendRows: trendRows,
      slotYieldSummary: o["slotYieldSummary"],
      agentTablesDigest: o["agentTablesDigest"],
    }),
    () => ({
      _historyNote: "精简 JB 缓存；保留 _trendRows 供 BIN 趋势表",
      rowsOmitted: true,
      lot: o["lot"],
      device: o["device"],
      passIdsPresent: o["passIdsPresent"],
      lotQueryFullRows: o["lotQueryFullRows"],
      topBadBins: o["topBadBins"],
      yieldByPassIdMarkdown: o["yieldByPassIdMarkdown"],
      lotYieldOverviewMarkdown: o["lotYieldOverviewMarkdown"],
      _jbSessionCacheVersion: o["_jbSessionCacheVersion"],
      _trendRows: trendRows,
    }),
    () => ({
      ...jbYieldCoreFields(o),
      rowsOmitted: true,
      _historyNote: "仅核心良率；BIN 趋势可能不可用",
    }),
  ];

  for (const build of tiers) {
    const s = JSON.stringify(build());
    if (s.length <= maxChars) return s;
  }

  const shrunk = shrinkSlotSummaryForHistory(
    (o["slotYieldSummary"] as SlotYieldSummaryEntry[] | undefined) ?? [],
    maxChars,
    jbYieldCoreFields(o)
  );
  if (shrunk) return shrunk;
  return JSON.stringify({
    ...jbYieldCoreFields(o),
    _historyNote: "JB 缓存压缩极限",
    rowsOmitted: true,
  });
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
      _trendRows: o["_trendRows"],
      lotQueryFullRows: o["lotQueryFullRows"],
      _jbSessionCacheVersion: o["_jbSessionCacheVersion"],
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
