// pcr-ai-api/src/lib/agent/render/agentAggregateBinsRender.ts
// aggregate_jb_bins result -> single-source render-table selection, extracted from agentLoop.ts.
import { extractBinFromUserText } from "../jb/agentJbQuestionClassifiers.js";
import { extractLotsFromUserText } from "../tools/agentInfWaferMapTool.js";
import {
  buildAggregateBinRankingMarkdown,
  buildBinCardAggregateMarkdown,
  buildBinDeviceAggregateMarkdown,
  buildBinFocusedLotRankingMarkdown,
} from "../jb/agentJbRankingMarkdown.js";

function buildMultiLotBinTable(content: string): string | null {
  let agg: Record<string, unknown>;
  try { agg = JSON.parse(content) as Record<string, unknown>; } catch { return null; }
  const groups = agg["groups"] as Array<Record<string, unknown>> | undefined;
  if (!groups?.length) return null;

  // Detect cross-lot: groups contain 'lot' with multiple distinct values
  const lotOrder: string[] = [];
  const lotBins = new Map<string, Array<{ bin: string; count: number }>>();
  for (const g of groups) {
    const lot = String(g["lot"] ?? "").trim();
    if (!lot) continue;
    const binRaw = g["bin"] ?? g["BIN"];
    const bin = `BIN${String(binRaw ?? "").trim()}`;
    const count = Number(g["count"] ?? g["COUNT"] ?? 0);
    if (!lotBins.has(lot)) { lotBins.set(lot, []); lotOrder.push(lot); }
    if (binRaw && count > 0) lotBins.get(lot)!.push({ bin, count });
  }
  if (lotBins.size <= 1) return null; // single-lot: let normal path handle

  // Sort lots by total bad die DESC
  const lotTotals = new Map<string, number>();
  for (const [lot, bins] of lotBins) lotTotals.set(lot, bins.reduce((s, b) => s + b.count, 0));
  const sortedLots = [...lotOrder].sort((a, b) => (lotTotals.get(b) ?? 0) - (lotTotals.get(a) ?? 0));

  const lines = [
    `**各批次主要坏 BIN（共 ${lotBins.size} 个批次，按坏 die 总量排列）**`,
    "",
    "| Lot | TOP 1 BIN（颗数）| TOP 2 BIN（颗数）| TOP 3 BIN（颗数）| 坏 die 合计 |",
    "|---|---|---|---|---:|",
  ];
  for (const lot of sortedLots) {
    const bins = (lotBins.get(lot) ?? []).slice(0, 3);
    while (bins.length < 3) bins.push({ bin: "—", count: 0 });
    const cells = bins.map(b => b.count > 0 ? `${b.bin}（${b.count}）` : "—");
    lines.push(`| ${lot} | ${cells.join(" | ")} | ${lotTotals.get(lot) ?? 0} |`);
  }
  // 诊断：暴露排序基准（绝对坏 die 总量），供真库核对「测试最差」口径是否应改用良率%。
  console.warn(
    `[multiLotBinTable] 按坏die总量降序 ${sortedLots.length} lot：` +
      sortedLots.map((l) => `${l}=${lotTotals.get(l) ?? 0}`).join(", ")
  );
  // 口径脚注：坏 die 多 ≠ 良率低（大片/大批自然坏 die 多），避免把绝对量当「最差」。
  lines.push(
    "",
    "*注：本表按各 lot「坏 die 总量」降序（良品 bin 已在聚合中扣除）；坏 die 绝对量受片数/总 die 影响，" +
      "并不等价于良率最低。判定「测试最差」请以各 lot 良率% 复核（对目标 lot 调 query_jb_bins(lot) 看 yieldByPassId）。*"
  );
  return lines.join("\n");
}

/**
 * aggregate_jb_bins 结果 → 选出唯一应直出的渲染表（单一真相源）。
 *
 * 此前这条「binLot → multiLot → binCard → binDevice → binRank」选择链被**复制**在
 * tryRunDeterministicJbSummary（emit SSE）与 jbBinsYieldFallbackMessage（返字符串）两处，
 * 任何新增/修复都要改两遍（B1/B3 即如此）——典型「打地鼠」。这里收敛为一处，两个站点
 * 各自按返回值做自己的输出（SSE / 字符串），新增渲染分支只改这一个函数。
 *
 * 返回 null 表示无可直出表（交回上层）。`withDataTitle=false` 用于 multiLot 表
 * （自带表头，不加「## 实测数据」标题）；`statusMessage` 为空时调用方不发 status。
 */
export interface AggregateJbBinsRender {
  table: string;
  commentaryNote: string;
  statusMessage: string;
  withDataTitle: boolean;
}

export function renderAggregateJbBinsResult(
  aggContent: string,
  userQuestion: string,
  scopeLabel: string | undefined
): AggregateJbBinsRender | null {
  const focusBin = extractBinFromUserText(userQuestion);
  const namedLots = extractLotsFromUserText(userQuestion);

  // 用户问「哪个 lot BINnn 最多」: 按指定 bin 在各 lot 的颗数排序（含卡），须在 multiLotBinTable
  // 之前判断——后者按「坏die总量」排序会把该 bin 少但总坏die多的 lot 误排第一。
  // 点名多个 lot（B3）时仅保留这些 lot 并对缺失者补 0 行。
  const binLotTable = buildBinFocusedLotRankingMarkdown(
    aggContent,
    focusBin,
    scopeLabel,
    namedLots
  );
  if (binLotTable?.trim()) {
    return {
      table: binLotTable,
      commentaryNote:
        `*以上按 BIN${focusBin} 在各 lot 的坏 die 颗数降序（非坏die总量口径）。` +
        `如需某 lot 逐片分布，请追问「<lot> 哪片 BIN${focusBin} 最多」。*`,
      statusMessage: "正在输出指定 BIN 的各 lot 排行…",
      withDataTitle: true,
    };
  }

  const multiLot = buildMultiLotBinTable(aggContent);
  if (multiLot?.trim()) {
    return {
      table: multiLot,
      commentaryNote: "如需深入分析某批次，请告知批次号（如上表第1行）。",
      statusMessage: "", // multiLot 表自带表头与口径脚注，summary 站原本不发 status
      withDataTitle: false,
    };
  }

  // groupBy:"bin,cardId" → 卡归属表（用户问「集中在哪张卡」）。须在 bin-only 排行前判断，
  // 否则 buildAggregateBinRankingMarkdown 会丢掉 cardId 列、渲染成重复 BIN 行。
  const binCardTable = buildBinCardAggregateMarkdown(
    aggContent,
    scopeLabel,
    focusBin
  );
  if (binCardTable?.trim()) {
    return {
      table: binCardTable,
      commentaryNote:
        `*以上为范围内 BIN×探针卡 坏 die 汇总（良品 bin 已扣除）。卡级已定位；DUT 级归属需 INF DUT map，` +
        `可继续追问「lot <号> wafer <片号> BIN<n> 的 DUT 分布」。*`,
      statusMessage: "正在输出 BIN×探针卡 归属表…",
      withDataTitle: true,
    };
  }

  // groupBy:"device,bin" → BIN×device 表（用户「把 device 也要列出来」）。须在 bin-only 排行前判断，
  // 否则 buildAggregateBinRankingMarkdown 会丢掉 device 列、跨 device 求和（见 B1）。
  const binDeviceTable = buildBinDeviceAggregateMarkdown(
    aggContent,
    scopeLabel,
    focusBin
  );
  if (binDeviceTable?.trim()) {
    return {
      table: binDeviceTable,
      commentaryNote:
        `*以上为范围内 BIN×device 坏 die 汇总（良品 bin 已扣除）。如需定位到具体批次，` +
        `请问「哪个 lot 的 BIN<n> 最多」（按 bin+lot 排行）。*`,
      statusMessage: "正在输出 BIN×device 汇总表…",
      withDataTitle: true,
    };
  }

  const binRank = buildAggregateBinRankingMarkdown(aggContent, scopeLabel);
  if (binRank?.trim()) {
    return {
      table: binRank,
      commentaryNote: "*以上为范围内坏 BIN 按 dieCount 降序汇总。*",
      statusMessage: "正在输出坏 BIN 排行表…",
      withDataTitle: true,
    };
  }

  return null;
}
