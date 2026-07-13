// pcr-ai-api/src/lib/agent/jb/agentJbRankingMarkdown.ts
/** aggregate_jb_bins 跨 lot 坏 BIN 排行 / 卡归属 / device 归属 / 指定 bin 排 lot 的 markdown 渲染。 */

/** aggregate_jb_bins(groupBy:"bin") → 跨 lot 坏 BIN 排行表。含 lot 维度时返回 null（交 buildMultiLotBinTable）。 */
export function buildAggregateBinRankingMarkdown(
  rawContent: string,
  scopeLabel?: string
): string | null {
  let agg: Record<string, unknown>;
  try {
    agg = JSON.parse(rawContent) as Record<string, unknown>;
  } catch {
    return null;
  }
  const groups = agg["groups"] as Array<Record<string, unknown>> | undefined;
  if (!groups?.length) return null;

  if (groups.some((g) => String(g["lot"] ?? "").trim())) return null;
  // 含 device 维度（groupBy "device,bin"）时纯 BIN 排行会跨 device 求和、丢掉 device 列
  // （见 B1：用户「把 device 也要列出来」却仍只出 BIN 排行）→ 交回 buildBinDeviceAggregateMarkdown。
  if (groups.some((g) => String(g["device"] ?? g["DEVICE"] ?? "").trim())) {
    return null;
  }

  const bins = groups
    .map((g) => {
      const binRaw = g["bin"] ?? g["BIN"];
      const binNum = Number(String(binRaw ?? "").replace(/^BIN/i, ""));
      const count = Number(g["count"] ?? g["CNT"] ?? 0);
      return {
        bin: Number.isFinite(binNum) && binNum > 0 ? binNum : null,
        count,
      };
    })
    .filter((b) => b.bin != null && b.count > 0)
    .sort((a, b) => b.count - a.count);

  if (!bins.length) return null;

  const total = bins.reduce((s, b) => s + b.count, 0);
  const totalRows = Number(agg["totalRowsMatching"] ?? 0);
  const scope = scopeLabel?.trim() || "查询范围";
  const header = `**主要坏 BIN 排行（${scope}，Top ${bins.length}，坏 die 合计 ${total}${totalRows > 0 ? `，匹配 ${totalRows} 行` : ""}）**`;
  const rows = [
    "| # | BIN | 坏 die 颗数 | 占比 |",
    "|---:|---|---:|---:|",
    ...bins.map((b, i) => {
      const pct = total > 0 ? ((b.count / total) * 100).toFixed(1) : "0.0";
      return `| ${i + 1} | BIN${b.bin} | ${b.count} | ${pct}% |`;
    }),
  ];
  // 纯 bin 合计跨该范围全部 lot，无法定位具体批次——引导按 lot 下钻（见 P-D）。
  const footnote =
    "\n\n*以上为查询范围内各 BIN 的坏 die 合计排行（未区分批次）。" +
    "如需定位到具体批次，请问「哪个 lot 的 BIN<n> 最多」（按 bin+lot 排行）。*";
  return `${header}\n\n${rows.join("\n")}${footnote}`;
}

/**
 * aggregate_jb_bins(groupBy:"bin,cardId") 的卡归属渲染。
 * buildAggregateBinRankingMarkdown 只取 bin+count，会把「bin35 在 9416-04/03/01」
 * 渲染成重复的 BIN35 行、丢掉 cardId（用户问「集中在哪张卡」却看不到卡号）。
 * - focusBin 有值（如「bin35 集中在哪张卡」）→ 仅列该 BIN 各卡坏 die 排行。
 * - focusBin 无值（如「9406 各卡对比」）→ bin×card 全表按坏 die 降序。
 * groups 无 cardId 时返回 null，交回 buildAggregateBinRankingMarkdown。
 */
export function buildBinCardAggregateMarkdown(
  rawContent: string,
  scopeLabel?: string,
  focusBin?: number | null
): string | null {
  let agg: Record<string, unknown>;
  try {
    agg = JSON.parse(rawContent) as Record<string, unknown>;
  } catch {
    return null;
  }
  const groups = agg["groups"] as Array<Record<string, unknown>> | undefined;
  if (!groups?.length) return null;
  // 必须含 cardId（即 groupBy 含 cardId）才走本渲染
  if (!groups.some((g) => String(g["cardId"] ?? g["CARDID"] ?? "").trim())) {
    return null;
  }

  type Row = { bin: number; cardId: string; count: number };
  const rows: Row[] = groups
    .map((g) => {
      const binNum = Number(String(g["bin"] ?? g["BIN"] ?? "").replace(/^BIN/i, ""));
      return {
        bin: binNum,
        cardId: String(g["cardId"] ?? g["CARDID"] ?? "").trim(),
        count: Number(g["count"] ?? g["CNT"] ?? 0),
      };
    })
    .filter((r) => Number.isFinite(r.bin) && r.bin > 0 && r.cardId && r.count > 0);
  if (!rows.length) return null;

  const scope = scopeLabel?.trim() || "查询范围";
  const totalRows = Number(agg["totalRowsMatching"] ?? 0);
  const rowsSuffix = totalRows > 0 ? `，匹配 ${totalRows} 行` : "";

  if (focusBin != null) {
    const forBin = rows
      .filter((r) => r.bin === focusBin)
      .sort((a, b) => b.count - a.count);
    if (!forBin.length) return null; // 该 BIN 不在结果里 → 交回通用渲染
    const total = forBin.reduce((s, r) => s + r.count, 0);
    const lines = [
      `**BIN${focusBin} 坏 die 所属探针卡（${scope}，坏 die 合计 ${total}${rowsSuffix}）**`,
      "",
      `| # | 探针卡 (CARDID) | BIN${focusBin} 坏 die 颗数 | 占比 |`,
      "|---:|---|---:|---:|",
      ...forBin.map((r, i) => {
        const pct = total > 0 ? ((r.count / total) * 100).toFixed(1) : "0.0";
        return `| ${i + 1} | ${r.cardId} | ${r.count} | ${pct}% |`;
      }),
    ];
    return lines.join("\n");
  }

  const sorted = rows.sort((a, b) => b.count - a.count).slice(0, 30);
  const total = rows.reduce((s, r) => s + r.count, 0);
  const lines = [
    `**坏 BIN × 探针卡（${scope}，Top ${sorted.length}，坏 die 合计 ${total}${rowsSuffix}）**`,
    "",
    "| # | BIN | 探针卡 (CARDID) | 坏 die 颗数 | 占比 |",
    "|---:|---|---|---:|---:|",
    ...sorted.map((r, i) => {
      const pct = total > 0 ? ((r.count / total) * 100).toFixed(1) : "0.0";
      return `| ${i + 1} | BIN${r.bin} | ${r.cardId} | ${r.count} | ${pct}% |`;
    }),
  ];
  return lines.join("\n");
}

/**
 * aggregate_jb_bins(groupBy:"device,bin") 的 device 归属渲染（镜像 buildBinCardAggregateMarkdown）。
 * buildAggregateBinRankingMarkdown 只取 bin+count，会把含 device 的结果跨 device 求和、丢掉 device 列
 * （见 B1：用户「把 device 也要列出来」却仍只出纯 BIN 排行）。
 * - focusBin 有值 → 仅列该 BIN 在各 device 的坏 die 排行。
 * - focusBin 无值 → bin×device 全表按坏 die 降序（单 device 时每行 device 相同，仍满足「列出 device」诉求）。
 * groups 无 device 时返回 null，交回 buildAggregateBinRankingMarkdown。
 */
export function buildBinDeviceAggregateMarkdown(
  rawContent: string,
  scopeLabel?: string,
  focusBin?: number | null
): string | null {
  let agg: Record<string, unknown>;
  try {
    agg = JSON.parse(rawContent) as Record<string, unknown>;
  } catch {
    return null;
  }
  const groups = agg["groups"] as Array<Record<string, unknown>> | undefined;
  if (!groups?.length) return null;
  // 必须含 device（即 groupBy 含 device）才走本渲染
  if (!groups.some((g) => String(g["device"] ?? g["DEVICE"] ?? "").trim())) {
    return null;
  }

  type Row = { bin: number; device: string; count: number };
  const rows: Row[] = groups
    .map((g) => {
      const binNum = Number(String(g["bin"] ?? g["BIN"] ?? "").replace(/^BIN/i, ""));
      return {
        bin: binNum,
        device: String(g["device"] ?? g["DEVICE"] ?? "").trim(),
        count: Number(g["count"] ?? g["CNT"] ?? 0),
      };
    })
    .filter((r) => Number.isFinite(r.bin) && r.bin > 0 && r.device && r.count > 0);
  if (!rows.length) return null;

  const scope = scopeLabel?.trim() || "查询范围";
  const totalRows = Number(agg["totalRowsMatching"] ?? 0);
  const rowsSuffix = totalRows > 0 ? `，匹配 ${totalRows} 行` : "";

  if (focusBin != null) {
    const forBin = rows
      .filter((r) => r.bin === focusBin)
      .sort((a, b) => b.count - a.count);
    if (!forBin.length) return null; // 该 BIN 不在结果里 → 交回通用渲染
    const total = forBin.reduce((s, r) => s + r.count, 0);
    const lines = [
      `**BIN${focusBin} 坏 die 所属 device（${scope}，坏 die 合计 ${total}${rowsSuffix}）**`,
      "",
      `| # | Device | BIN${focusBin} 坏 die 颗数 | 占比 |`,
      "|---:|---|---:|---:|",
      ...forBin.map((r, i) => {
        const pct = total > 0 ? ((r.count / total) * 100).toFixed(1) : "0.0";
        return `| ${i + 1} | ${r.device} | ${r.count} | ${pct}% |`;
      }),
    ];
    return lines.join("\n");
  }

  const sorted = rows.sort((a, b) => b.count - a.count).slice(0, 30);
  const total = rows.reduce((s, r) => s + r.count, 0);
  const lines = [
    `**坏 BIN × Device（${scope}，Top ${sorted.length}，坏 die 合计 ${total}${rowsSuffix}）**`,
    "",
    "| # | BIN | Device | 坏 die 颗数 | 占比 |",
    "|---:|---|---|---:|---:|",
    ...sorted.map((r, i) => {
      const pct = total > 0 ? ((r.count / total) * 100).toFixed(1) : "0.0";
      return `| ${i + 1} | BIN${r.bin} | ${r.device} | ${r.count} | ${pct}% |`;
    }),
  ];
  return lines.join("\n");
}

/**
 * 用户问「哪个 lot BINnn 最多」：aggregate_jb_bins(groupBy 含 bin,lot[,cardId]) 结果里
 * 按**指定 bin** 在各 lot 的坏 die 颗数排 lot（而非 multiLotBinTable 的「坏die总量」口径——
 * 后者会把总坏die多但该 bin 少的 lot 误排第一，如 DR41662.1J(bin35=968) 排在
 * DR42190.1X(bin35=1402) 之前）。无 lot 维度或该 bin 不在结果里 → 返回 null 交回其它渲染。
 * 若 groups 含 cardId，附「探针卡」列直接回答「都是用什么卡测试的」。
 */
export function buildBinFocusedLotRankingMarkdown(
  rawContent: string,
  focusBin: number | null | undefined,
  scopeLabel?: string,
  restrictLots?: string[]
): string | null {
  if (focusBin == null) return null;
  let agg: Record<string, unknown>;
  try {
    agg = JSON.parse(rawContent) as Record<string, unknown>;
  } catch {
    return null;
  }
  const groups = agg["groups"] as Array<Record<string, unknown>> | undefined;
  if (!groups?.length) return null;
  // 必须含 lot 维度（否则交回 buildBinCardAggregateMarkdown / multiLotBinTable）
  if (!groups.some((g) => String(g["lot"] ?? g["LOT"] ?? "").trim())) return null;
  const hasCard = groups.some((g) => String(g["cardId"] ?? g["CARDID"] ?? "").trim());

  // 用户点名了多个具体 lot（如「DR44039.1Y、DR44040.1R… 这4个lot 有测出 bin35吗」）→
  // 仅保留这些 lot，并对没出现的 lot 显式补 0 行，直接回答「有没有测出」（见 B3）。
  const restrictSet =
    restrictLots && restrictLots.length >= 2
      ? new Set(restrictLots.map((l) => l.toUpperCase()))
      : null;

  type LotAgg = { lot: string; count: number; cards: Map<string, number> };
  const byLot = new Map<string, LotAgg>();
  for (const g of groups) {
    const binNum = Number(String(g["bin"] ?? g["BIN"] ?? "").replace(/^BIN/i, ""));
    if (binNum !== focusBin) continue;
    const lot = String(g["lot"] ?? g["LOT"] ?? "").trim();
    if (!lot) continue;
    if (restrictSet && !restrictSet.has(lot.toUpperCase())) continue;
    const count = Number(g["count"] ?? g["CNT"] ?? 0);
    if (!(count > 0)) continue;
    const cardId = String(g["cardId"] ?? g["CARDID"] ?? "").trim();
    let entry = byLot.get(lot);
    if (!entry) {
      entry = { lot, count: 0, cards: new Map() };
      byLot.set(lot, entry);
    }
    entry.count += count;
    if (cardId) entry.cards.set(cardId, (entry.cards.get(cardId) ?? 0) + count);
  }
  // 限定 lot 集合：被点名但本 BIN 颗数为 0 的 lot 也要列出（答「没测出」）。
  if (restrictSet) {
    for (const l of restrictLots!) {
      if (![...byLot.keys()].some((k) => k.toUpperCase() === l.toUpperCase())) {
        byLot.set(l, { lot: l, count: 0, cards: new Map() });
      }
    }
  }
  const ranked = [...byLot.values()].sort((a, b) => b.count - a.count);
  if (!ranked.length) return null;

  const scope = scopeLabel?.trim() || "查询范围";
  const total = ranked.reduce((s, r) => s + r.count, 0);
  const scopeHint = restrictSet ? `指定 ${restrictSet.size} 个 lot，` : "";
  const header = hasCard
    ? `| # | Lot | BIN${focusBin} 坏 die 颗数 | 占比 | 探针卡 |`
    : `| # | Lot | BIN${focusBin} 坏 die 颗数 | 占比 |`;
  const divider = hasCard ? "|---:|---|---:|---:|---|" : "|---:|---|---:|---:|";
  const lines = [
    `**各 lot BIN${focusBin} 坏 die 排行（${scope}，${scopeHint}坏 die 合计 ${total}）**`,
    "",
    header,
    divider,
    ...ranked.map((r, i) => {
      const pct = total > 0 ? ((r.count / total) * 100).toFixed(1) : "0.0";
      if (!hasCard) return `| ${i + 1} | ${r.lot} | ${r.count} | ${pct}% |`;
      const cards =
        [...r.cards.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([c]) => c)
          .join(", ") || "—";
      return `| ${i + 1} | ${r.lot} | ${r.count} | ${pct}% | ${cards} |`;
    }),
  ];
  return lines.join("\n");
}
