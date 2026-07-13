// pcr-ai-api/src/lib/agent/jb/agentJbListingMarkdown.ts
/** YM 侧 lot 信息抽取 + 跨 lot 列表 / 良率列表 markdown（lot_listing / card_test_overview 共用）。 */

import type { RecentLotByTestEndEntry } from "./agentJbBinFormat.js";

/** Yield Monitor 侧 lot 条目（合并进 lot 列表表）。 */
export type YmLotListingEntry = {
  lot: string;
  device?: string;
  testEnd?: string | null;
};

function parseDutNumbersFromTriggerLabel(label: string): number[] {
  const out: number[] = [];
  for (const m of label.matchAll(/dut#\s*(\d+)/gi)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) out.push(n);
  }
  return out;
}

/** YM 各 lot 报警次数（aggregate + 明细行合并）。 */
export function extractYmAlarmCountByLot(
  history: Array<{ role?: string; name?: string; content?: string | null }>
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of history) {
    if (m.role !== "tool") continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(String(m.content ?? "")) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (m.name === "aggregate_yield_triggers") {
      const groups = o["groups"] as Array<Record<string, unknown>> | undefined;
      for (const g of groups ?? []) {
        const lot = String(g["lotId"] ?? g["LOTID"] ?? "").trim();
        const count = Number(g["count"] ?? g["CNT"] ?? 0);
        if (lot && count > 0) counts.set(lot, (counts.get(lot) ?? 0) + count);
      }
    }
    if (m.name === "query_yield_triggers") {
      const rows = o["rows"] as Array<Record<string, unknown>> | undefined;
      for (const r of rows ?? []) {
        const lot = String(r["LOTID"] ?? r["lotId"] ?? "").trim();
        if (lot) counts.set(lot, (counts.get(lot) ?? 0) + 1);
      }
    }
  }
  return counts;
}

/** YM 各 lot 嫌疑 DUT（从 TRIGGER_LABEL 解析 dut#）。 */
export function extractYmSuspectDutsByLot(
  history: Array<{ role?: string; name?: string; content?: string | null }>
): Map<string, string[]> {
  const byLot = new Map<string, Set<number>>();
  for (const m of history) {
    if (m.role !== "tool" || m.name !== "query_yield_triggers") continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(String(m.content ?? "")) as Record<string, unknown>;
    } catch {
      continue;
    }
    const rows = o["rows"] as Array<Record<string, unknown>> | undefined;
    for (const r of rows ?? []) {
      const lot = String(r["LOTID"] ?? r["lotId"] ?? "").trim();
      const label = String(r["TRIGGER_LABEL"] ?? r["triggerLabel"] ?? "");
      if (!lot || !label) continue;
      const duts = parseDutNumbersFromTriggerLabel(label);
      if (!duts.length) continue;
      if (!byLot.has(lot)) byLot.set(lot, new Set());
      for (const d of duts) byLot.get(lot)!.add(d);
    }
  }
  const out = new Map<string, string[]>();
  for (const [lot, duts] of byLot) {
    out.set(
      lot,
      [...duts].sort((a, b) => a - b).map((d) => `DUT${d}`)
    );
  }
  return out;
}

type BinTotalsEntry = { lot: string; badBins?: Array<{ bin: number; dieCount: number }> };

/** JB 各 lot TOP fail bin（payload binTotalsByLot + history aggregate_jb_bins）。 */
export function extractTopFailBinByLot(
  toolPayload: Record<string, unknown>,
  history: Array<{ role?: string; name?: string; content?: string | null }>
): Map<string, string> {
  const byLot = new Map<string, Map<number, number>>();

  const binTotals = toolPayload["binTotalsByLot"] as BinTotalsEntry[] | undefined;
  for (const e of binTotals ?? []) {
    const lot = String(e.lot ?? "").trim();
    if (!lot) continue;
    for (const b of e.badBins ?? []) {
      if (!byLot.has(lot)) byLot.set(lot, new Map());
      const m = byLot.get(lot)!;
      m.set(b.bin, (m.get(b.bin) ?? 0) + b.dieCount);
    }
  }

  for (const m of history) {
    if (m.role !== "tool" || m.name !== "aggregate_jb_bins") continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(String(m.content ?? "")) as Record<string, unknown>;
    } catch {
      continue;
    }
    const groups = o["groups"] as Array<Record<string, unknown>> | undefined;
    for (const g of groups ?? []) {
      const lot = String(g["lot"] ?? g["LOT"] ?? "").trim();
      const binRaw = g["bin"] ?? g["BIN"];
      const bin = Number(binRaw);
      const count = Number(g["count"] ?? g["CNT"] ?? 0);
      if (!lot || !Number.isFinite(bin) || count <= 0) continue;
      if (!byLot.has(lot)) byLot.set(lot, new Map());
      const mp = byLot.get(lot)!;
      mp.set(bin, (mp.get(bin) ?? 0) + count);
    }
  }

  const out = new Map<string, string>();
  for (const [lot, bins] of byLot) {
    const top = [...bins.entries()].sort((a, b) => b[1] - a[1])[0];
    out.set(lot, top ? `BIN${top[0]}（${top[1]}）` : "—");
  }
  return out;
}

export type LotListingContext = {
  ymLots?: YmLotListingEntry[];
  ymAlarmCountByLot?: Map<string, number>;
  ymSuspectDutsByLot?: Map<string, string[]>;
  topFailBinByLot?: Map<string, string>;
  detailed?: boolean;
  /** 表头 scope 标签（来自 resolveJbListingScope）。 */
  scopeLabel?: string;
  /** 列/行数呈现（良率列、topN、平均良率）。 */
  presentation?: LotListingPresentation;
};

/** lot 列表表的呈现选项（与查询 scope 解耦）。 */
export type LotListingPresentation = {
  topN?: number;
  includeYield: boolean;
  includeAverageYield: boolean;
};

const ZH_NUM_LISTING: Record<string, number> = {
  一: 1,
  两: 2,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

export function inferLotListingPresentation(text: string): LotListingPresentation {
  const t = text.trim();
  let topN: number | undefined;
  const nMatch = t.match(/top\s*(\d+)|(\d+)\s*个/i);
  if (nMatch) {
    topN = Math.min(Math.max(1, Number(nMatch[1] ?? nMatch[2])), 50);
  }
  const zhMatch = t.match(/([一两二三四五六七八九十两])\s*个\s*(lot|批次)/i);
  if (!topN && zhMatch) {
    const n = ZH_NUM_LISTING[zhMatch[1]!];
    if (n) topN = n;
  }
  const includeYield = /(良率|yield|良品率|评价)/i.test(t);
  const includeAverageYield =
    /平均.*(良率|yield|良品率)/i.test(t) ||
    (includeYield && topN != null);
  return { topN, includeYield, includeAverageYield };
}

export function buildLotListingContext(
  toolPayload: Record<string, unknown>,
  history: Array<{ role?: string; name?: string; content?: string | null }>
): LotListingContext {
  const ymLots = extractYmLotsFromHistory(history);
  return {
    ymLots,
    ymAlarmCountByLot: extractYmAlarmCountByLot(history),
    ymSuspectDutsByLot: extractYmSuspectDutsByLot(history),
    topFailBinByLot: extractTopFailBinByLot(toolPayload, history),
    detailed: false,
  };
}

/** 从 session history 提取 YM 侧不重复 lot（供 lot 列表与 JB 合并）。 */
export function extractYmLotsFromHistory(
  history: Array<{ role?: string; name?: string; content?: string | null }>
): YmLotListingEntry[] {
  const byLot = new Map<string, YmLotListingEntry>();
  for (const m of history) {
    if (m.role !== "tool" || m.name !== "query_yield_triggers") continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(String(m.content ?? "")) as Record<string, unknown>;
    } catch {
      continue;
    }
    const rows = o["rows"] as Array<Record<string, unknown>> | undefined;
    for (const r of rows ?? []) {
      const lot = String(r["LOTID"] ?? r["lotId"] ?? "").trim();
      if (!lot) continue;
      const device = String(r["DEVICE"] ?? r["device"] ?? "").trim();
      const tsRaw = r["TIME_STAMP"] ?? r["timeStamp"];
      const testEnd =
        tsRaw instanceof Date
          ? tsRaw.toISOString()
          : tsRaw != null && String(tsRaw).trim() !== ""
            ? String(tsRaw)
            : null;
      const prev = byLot.get(lot);
      if (
        !prev ||
        (testEnd && (!prev.testEnd || testEnd.localeCompare(prev.testEnd) > 0))
      ) {
        byLot.set(lot, {
          lot,
          device: device || prev?.device,
          testEnd: testEnd ?? prev?.testEnd ?? null,
        });
      }
    }
  }
  return [...byLot.values()].sort((a, b) =>
    (b.testEnd ?? "").localeCompare(a.testEnd ?? "")
  );
}

export type LotYieldRankRow = {
  lot: string;
  device: string;
  yieldPct: number;
  worstSlot: number;
  worstPassId: number;
  testEnd: string | null;
};

/** 跨 lot 良率表（lotYieldRankByTestEnd；供 lot_listing 与 card_test_overview 共用）。 */
export function buildLotYieldRankListingMarkdown(
  rank: LotYieldRankRow[],
  options: {
    scopeTag: string;
    totalLots: number;
    presentation: LotListingPresentation;
  }
): string | null {
  if (!rank.length) return null;
  const { scopeTag, totalLots, presentation } = options;
  const topN = presentation.topN;
  const sorted = [...rank].sort((a, b) =>
    (b.testEnd ?? "").localeCompare(a.testEnd ?? "")
  );
  const slice = topN != null ? sorted.slice(0, topN) : sorted;
  if (!slice.length) return null;

  const rows = [
    "| # | lot | device | 良率% | 最差片 / pass | 测试结束 |",
    "|---:|---|---|---:|---|---|",
    ...slice.map((e, i) => {
      const passLabel = `waferId ${e.worstSlot} / pass${e.worstPassId}`;
      const testEnd = e.testEnd ? String(e.testEnd).slice(0, 10) : "—";
      return `| ${i + 1} | ${e.lot} | ${e.device} | ${e.yieldPct.toFixed(2)}% | ${passLabel} | ${testEnd} |`;
    }),
  ];

  let header = `**测试 lot 良率列表${scopeTag}**`;
  if (topN != null) {
    header =
      `**测试 lot 良率列表${scopeTag}（最近 ${slice.length} 个 lot` +
      (totalLots > slice.length ? `，该范围共 ${totalLots} 个 lot` : "") +
      `，按 TESTEND 降序）**`;
  } else if (totalLots > slice.length) {
    header = `**测试 lot 良率列表${scopeTag}（共 ${totalLots} 个 lot，下表列 ${slice.length} 个）**`;
  }

  let body = `${header}\n\n${rows.join("\n")}`;
  if (presentation.includeAverageYield && slice.length > 0) {
    const avg =
      slice.reduce((s, e) => s + e.yieldPct, 0) / slice.length;
    body += `\n\n**平均良率（上述 ${slice.length} 个 lot）：${avg.toFixed(2)}%**`;
  }
  return body;
}

type ListingRow = {
  lot: string;
  device: string;
  testEnd: string;
  slotCount: string;
  source: string;
};

/**
 * 收集跨 lot 列表的候选行：JB `recentLotsByTestEnd` → payload 主 lot 兜底
 * （单 lot 场景下 recentLotsByTestEnd 可能为空）→ 仅 YM 告警的 lot（明细行）
 * → 仅 YM aggregate 命中、JB 未枚举到的 lot。按先到先得去重（`seen`）。
 */
function collectListingRows(
  toolPayload: Record<string, unknown>,
  recent: RecentLotByTestEndEntry[] | undefined,
  ymLots: YmLotListingEntry[] | undefined,
  ymAlarm: Map<string, number>
): ListingRow[] {
  const rows: ListingRow[] = [];
  const seen = new Set<string>();

  for (const e of recent ?? []) {
    const lot = String(e.lot ?? "").trim();
    if (!lot || seen.has(lot)) continue;
    seen.add(lot);
    const ymCount = ymAlarm.get(lot) ?? 0;
    rows.push({
      lot,
      device: String(e.device ?? "").trim() || "—",
      testEnd: e.testEnd ? String(e.testEnd).slice(0, 10) : "—",
      slotCount:
        typeof e.slotCount === "number" && e.slotCount > 0
          ? String(e.slotCount)
          : "—",
      source: ymCount > 0 ? "JB+YM" : "JB STAR",
    });
  }

  // 单 lot 的 query_jb_bins（如 cardId 仅命中 1 个 JB lot）不进入 recentLotsByTestEnd
  // （multiLotListingFields 仅在 distinctLotCount>1 时保留该字段）→ 该 JB lot 会从列表里消失，
  // 只剩 YM 告警 lot（见 B5）。这里用 payload 主 lot 兜底补一行 JB STAR。
  const primaryLot = String(toolPayload["lot"] ?? "").trim();
  if (primaryLot && !seen.has(primaryLot)) {
    seen.add(primaryLot);
    const ymCount = ymAlarm.get(primaryLot) ?? 0;
    const yieldByPassId = toolPayload["yieldByPassId"] as
      | Array<Record<string, unknown>>
      | undefined;
    const slotCountNum = Array.isArray(yieldByPassId)
      ? Math.max(
          0,
          ...yieldByPassId.map((p) =>
            typeof p["slotCount"] === "number" ? (p["slotCount"] as number) : 0
          )
        )
      : 0;
    rows.push({
      lot: primaryLot,
      device: String(toolPayload["device"] ?? "").trim() || "—",
      testEnd: toolPayload["testEnd"]
        ? String(toolPayload["testEnd"]).slice(0, 10)
        : "—",
      slotCount: slotCountNum > 0 ? String(slotCountNum) : "—",
      source: ymCount > 0 ? "JB+YM" : "JB STAR",
    });
  }

  for (const ym of ymLots ?? []) {
    const lot = String(ym.lot ?? "").trim();
    if (!lot || seen.has(lot)) continue;
    seen.add(lot);
    rows.push({
      lot,
      device: String(ym.device ?? "").trim() || "—",
      testEnd: ym.testEnd ? String(ym.testEnd).slice(0, 10) : "—",
      slotCount: "—",
      source: "仅 YM 告警",
    });
  }

  // YM aggregate 里有、JB 枚举未覆盖的 lot
  for (const [lot, count] of ymAlarm) {
    if (seen.has(lot) || count <= 0) continue;
    seen.add(lot);
    rows.push({
      lot,
      device: "—",
      testEnd: "—",
      slotCount: "—",
      source: "仅 YM 告警",
    });
  }

  return rows;
}

/**
 * 按测试结束时间排序（"—" 排最后）→ 依据 topN 截取展示行 → 按覆盖情况选表头
 * 文案 → 渲染 detailed/简版表格 + 追问引导 footer。
 */
function renderListingTable(
  rows: ListingRow[],
  options: {
    scopeTag: string;
    totalDistinct: number;
    presentation: LotListingPresentation;
    detailed: boolean;
    ymAlarm: Map<string, number>;
    ymSuspect: Map<string, string[]>;
    topFail: Map<string, string>;
  }
): string {
  const { scopeTag, totalDistinct, presentation, detailed, ymAlarm, ymSuspect, topFail } =
    options;

  rows.sort((a, b) => {
    if (a.testEnd === "—" && b.testEnd !== "—") return 1;
    if (b.testEnd === "—" && a.testEnd !== "—") return -1;
    return b.testEnd.localeCompare(a.testEnd);
  });

  const totalKnown = Math.max(totalDistinct, rows.length);

  const displayRows =
    presentation.topN != null ? rows.slice(0, presentation.topN) : rows;

  let header = `**测试 lot 列表${scopeTag}（共 ${totalKnown} 个 lot，按测试结束时间降序）**`;
  if (totalDistinct > 0 && displayRows.length < totalDistinct) {
    header = `**测试 lot 列表${scopeTag}（共 ${totalDistinct} 个 lot，下表列前 ${displayRows.length} 个）**`;
  } else if (presentation.topN != null) {
    header = `**测试 lot 列表${scopeTag}（最近 ${displayRows.length} 个 lot）**`;
  }

  const tableRows = detailed
    ? [
        "| # | Lot | Device | 测试结束 | 片数 | TOP fail BIN | YM 报警 | 嫌疑 DUT | 数据来源 |",
        "|---:|---|---|---|---:|---|---:|---|---|",
        ...displayRows.map((r, i) => {
          const alarm = ymAlarm.get(r.lot);
          const duts = ymSuspect.get(r.lot)?.join("、") ?? "—";
          const failBin = topFail.get(r.lot) ?? "—";
          return `| ${i + 1} | ${r.lot} | ${r.device} | ${r.testEnd} | ${r.slotCount} | ${failBin} | ${alarm != null && alarm > 0 ? alarm : "—"} | ${duts} | ${r.source} |`;
        }),
      ]
    : [
        "| # | Lot | Device | 测试结束 | 片数 | 数据来源 |",
        "|---:|---|---|---|---:|---|",
        ...displayRows.map((r, i) =>
          `| ${i + 1} | ${r.lot} | ${r.device} | ${r.testEnd} | ${r.slotCount} | ${r.source} |`
        ),
      ];

  const footer =
    rows.length >= 1
      ? "\n\n如需深入分析某批次，请告知上表中的 lot 号。"
      : "";
  return `${header}\n\n${tableRows.join("\n")}${footer}`;
}

/** 跨 lot 列表（JB recentLotsByTestEnd + YM 合并；可选 fail bin / 嫌疑 DUT / 良率列）。 */
export function buildRecentLotsListingMarkdown(
  toolPayload: Record<string, unknown>,
  ctx?: Partial<LotListingContext>
): string | null {
  const presentation = ctx?.presentation ?? {
    includeYield: false,
    includeAverageYield: false,
  };
  const rank = toolPayload["lotYieldRankByTestEnd"] as
    | LotYieldRankRow[]
    | undefined;
  const totalDistinct = Number(
    toolPayload["totalDistinctLots"] ??
      toolPayload["distinctLotCount"] ??
      toolPayload["multiLotDistinctCount"] ??
      rank?.length ??
      0
  );

  const scopeTag = ctx?.scopeLabel
    ? `（${ctx.scopeLabel}）`
    : (() => {
        const scopeDevice = String(toolPayload["device"] ?? "").trim();
        const scopeParts = [scopeDevice ? `device=${scopeDevice}` : ""].filter(Boolean);
        return scopeParts.length ? `（${scopeParts.join("，")}）` : "";
      })();

  if (presentation.includeYield && rank?.length) {
    return buildLotYieldRankListingMarkdown(rank, {
      scopeTag,
      totalLots: totalDistinct || rank.length,
      presentation,
    });
  }

  const recent = toolPayload["recentLotsByTestEnd"] as
    | RecentLotByTestEndEntry[]
    | undefined;
  const ymLots = ctx?.ymLots;
  const ymAlarm = ctx?.ymAlarmCountByLot ?? new Map<string, number>();
  const ymSuspect = ctx?.ymSuspectDutsByLot ?? new Map<string, string[]>();
  const topFail = ctx?.topFailBinByLot ?? new Map<string, string>();
  const detailed = Boolean(ctx?.detailed);

  const rows = collectListingRows(toolPayload, recent, ymLots, ymAlarm);
  if (rows.length === 0) return null;

  return renderListingTable(rows, {
    scopeTag,
    totalDistinct,
    presentation,
    detailed,
    ymAlarm,
    ymSuspect,
    topFail,
  });
}
