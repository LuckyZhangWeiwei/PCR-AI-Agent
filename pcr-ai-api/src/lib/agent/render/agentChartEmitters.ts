// pcr-ai-api/src/lib/agent/render/agentChartEmitters.ts
// DUT/BIN chart emitters and DUT-bin aggregate markdown, extracted verbatim from agentLoop.ts.
import type { AgentConfig } from "../agentConfig.js";
import { runTool } from "../tools/agentToolHandlers.js";
import { buildChartOption, tryParseJsonish } from "../tools/agentChartTool.js";
import { isCardProbeTestQuestion } from "../dispatch/agentQuestionHeuristics.js";
import type { AgentSseEvent } from "../core/agentLoop.js";

/** 从 query_lot_dut_bin_agg 结果中提取 DUT 分布，直接 emit bar chart。 */
export function tryEmitDutBinBarChart(
  rawContent: string,
  focusBin: number,
  emit: (event: AgentSseEvent) => void
): boolean {
  const parsed = tryParseJsonish(rawContent) as Record<string, unknown> | null;
  if (!parsed) return false;
  type DutEntry = { dut: number; dieCount: number };
  type DutGroup = { passId: number; duts: DutEntry[]; totalDieCount: number };
  const dutGroups = parsed["focusBinDuts"] as DutGroup[] | undefined;
  if (!dutGroups?.length) return false;
  const group = dutGroups.find((g) => g.passId === 1) ?? dutGroups[0];
  if (!group?.duts?.length || group.duts.length < 3) return false;
  const labels = group.duts.map((d) => `DUT${d.dut}`);
  const values = group.duts.map((d) => d.dieCount);
  try {
    const option = buildChartOption("bar", `BIN${focusBin} 各DUT颗数分布（pass${group.passId}）`, {
      labels,
      series: [{ name: `BIN${focusBin} 颗数`, values }],
    });
    emit({ type: "chart", option });
  } catch { return false; }
  return true;
}

/** 从 JB payload 的 topBadBins 提取前 10 BIN，直接 emit bar chart。 */
export function tryEmitTopBinBarChart(
  payload: Record<string, unknown>,
  emit: (event: AgentSseEvent) => void
): boolean {
  type TopBinEntry = { bin: number; dieCount: number };
  const topBins = payload["topBadBins"] as TopBinEntry[] | undefined;
  if (!topBins || topBins.length < 3) return false;
  const slice = topBins.slice(0, 10);
  const labels = slice.map((b) => `BIN${b.bin}`);
  const values = slice.map((b) => b.dieCount);
  const lot = String(payload["lot"] ?? "").trim();
  const title = `坏 BIN 分布${lot ? `（${lot}）` : ""}`;
  try {
    const option = buildChartOption("bar", title, {
      labels,
      series: [{ name: "坏 die 颗数", values }],
    });
    emit({ type: "chart", option });
  } catch { return false; }
  return true;
}

/**
 * 从 query_lot_dut_bin_agg passes 结果中计算各 DUT 的坏 die 总量（跨所有坏 BIN 求和）。
 * 返回按 DUT 编号升序排列（空间直观），仅含 totalBadDie > 0 的 DUT。
 */
function computeDutTotalBadDieFromPasses(
  rawContent: string,
  targetPassId = 1
): Array<{ dut: number; totalBadDie: number }> | null {
  const parsed = tryParseJsonish(rawContent) as Record<string, unknown> | null;
  if (!parsed) return null;

  type DutEntry = { dut: number; dieCount: number };
  type BinEntry = { isGoodBin?: boolean; duts?: DutEntry[]; dutBreakdownOmitted?: boolean };
  type PassEntry = { passId: number; bins: BinEntry[] };

  const passes = parsed["passes"] as PassEntry[] | undefined;
  if (!passes?.length) return null;

  const targetPass = passes.find((p) => p.passId === targetPassId) ?? passes[0];
  if (!targetPass?.bins?.length) return null;

  const dutTotals = new Map<number, number>();
  for (const bin of targetPass.bins) {
    if (bin.isGoodBin || bin.dutBreakdownOmitted || !bin.duts?.length) continue;
    for (const { dut, dieCount } of bin.duts) {
      dutTotals.set(dut, (dutTotals.get(dut) ?? 0) + dieCount);
    }
  }

  const result = [...dutTotals.entries()]
    .filter(([, total]) => total > 0)
    .sort((a, b) => a[0] - b[0])
    .map(([dut, totalBadDie]) => ({ dut, totalBadDie }));

  return result.length >= 2 ? result : null;
}

/** 片间（wafer-to-wafer）坏 die 总量对比图，来自 slotBadBinsCompact，无需额外查询。 */
function tryEmitWaferTotalBadDieChart(
  payload: Record<string, unknown>,
  passId: number,
  emit: (event: AgentSseEvent) => void
): void {
  type CompactEntry = {
    slot: number; passId: number; cardId: string;
    badBins: Array<{ bin: number; dieCount: number }>;
  };
  const compact = payload["slotBadBinsCompact"] as CompactEntry[] | undefined;
  if (!compact?.length) return;

  const filtered = compact.filter((e) => e.passId === passId);
  if (filtered.length < 2) return;

  const bySlot = new Map<number, number>();
  for (const { slot, badBins } of filtered) {
    bySlot.set(slot, (bySlot.get(slot) ?? 0) + badBins.reduce((s, b) => s + b.dieCount, 0));
  }
  const sorted = [...bySlot.entries()].sort((a, b) => a[0] - b[0]);
  if (sorted.length < 2) return;

  const lot = String(payload["lot"] ?? "").trim();
  try {
    const option = buildChartOption(
      "bar",
      `片间坏 die 总量（${lot ? lot + " " : ""}pass${passId}）`,
      {
        labels: sorted.map(([slot]) => `W${slot}`),
        series: [{ name: "坏 die 颗数", values: sorted.map(([, v]) => v) }],
      }
    );
    emit({ type: "chart", option });
  } catch { /* skip */ }
}

/** Lot 良率趋势折线图，来自 lotYieldRankByTestEnd，无需额外查询。 */
function tryEmitLotYieldTrendChart(
  payload: Record<string, unknown>,
  emit: (event: AgentSseEvent) => void
): void {
  type RankEntry = { lot: string; yieldPct: number; testEnd: string | null };
  const rank = payload["lotYieldRankByTestEnd"] as RankEntry[] | undefined;
  if (!rank || rank.length < 2) return;

  const sorted = [...rank]
    .filter((e) => e.testEnd)
    .sort((a, b) => (a.testEnd ?? "").localeCompare(b.testEnd ?? ""));
  if (sorted.length < 2) return;

  try {
    const option = buildChartOption(
      "line",
      "各 lot 良率趋势（按测试时间）",
      {
        labels: sorted.map((e) => e.lot),
        series: [{ name: "良率%", values: sorted.map((e) => parseFloat(e.yieldPct.toFixed(1))) }],
      }
    );
    emit({ type: "chart", option });
  } catch { /* skip */ }
}

/**
 * DUT 坏 die 跨 lot 对比表（最近两 lot），以 Markdown 文本 emit。
 * 用于判断哪个 DUT 位置持续偏高（探针磨损定位）。
 */
async function tryEmitDutCrossLotComparisonTable(
  payload: Record<string, unknown>,
  lot1RawContent: string,
  probeCardType: string,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void
): Promise<void> {
  const lot1 = String(payload["lot"] ?? "").trim();
  type RecentLot = { lot: string; device: string };
  const recentLots = payload["recentLotsByTestEnd"] as RecentLot[] | undefined;
  if (!recentLots || recentLots.length < 2) return;

  const lot2Entry = recentLots.find((e) => String(e.lot).trim() !== lot1);
  if (!lot2Entry) return;

  const lot2 = String(lot2Entry.lot).trim();
  const device2 = String(lot2Entry.device ?? payload["device"] ?? "").trim();
  if (!lot2 || !device2) return;

  emit({ type: "status", message: `正在获取 ${lot2} DUT 数据用于跨 lot 对比…` });

  let raw2: string;
  try {
    const result = await runTool("query_lot_dut_bin_agg", {
      device: device2, lot: lot2, passId: 1,
      ...(probeCardType ? { probeCardType } : {}),
    }, { toolResultMaxChars: agentConfig.toolResultMaxChars, history: [] });
    raw2 = typeof result === "string" ? result : JSON.stringify(result);
  } catch {
    return;
  }

  const duts1 = computeDutTotalBadDieFromPasses(lot1RawContent, 1);
  const duts2 = computeDutTotalBadDieFromPasses(raw2, 1);
  if (!duts1?.length || !duts2?.length) return;

  const map1 = new Map(duts1.map((d) => [d.dut, d.totalBadDie]));
  const map2 = new Map(duts2.map((d) => [d.dut, d.totalBadDie]));
  const allDuts = new Set([...map1.keys(), ...map2.keys()]);

  const tableRows = [...allDuts]
    .sort((a, b) => a - b)
    .filter((dut) => (map1.get(dut) ?? 0) > 0 || (map2.get(dut) ?? 0) > 0)
    .map((dut) => {
      const v2 = map2.get(dut) ?? 0;
      const v1 = map1.get(dut) ?? 0;
      const delta = v1 - v2;
      const trend = delta > 5 ? `▲${delta}` : delta < -5 ? `▼${Math.abs(delta)}` : "≈";
      return `| DUT${dut} | ${v2} | ${v1} | ${trend} |`;
    });
  if (tableRows.length === 0) return;

  const cardLabel = probeCardType || "同型号卡";
  const md = [
    `\n\n**DUT 坏 die 跨 lot 对比（pass1 / ${cardLabel}）**`,
    "",
    `| DUT | ${lot2}（次近） | ${lot1}（最近） | 趋势 |`,
    "|---|---|---|---|",
    ...tableRows,
    "",
    `> 趋势列：▲ = 坏 die 增加，▼ = 改善，≈ = 持平（阈值 ±5 颗）。DUT 持续偏高提示该触点位置磨损，建议针对性检查针尖状态。`,
  ].join("\n");

  emit({ type: "text", delta: md });
}

/**
 * 探针卡概况问题的全套对比分析（调用位置：emitDeterministicJbTablesReply 末尾）：
 * ① 片间坏 die 柱状图  ② lot 良率趋势折线图
 * ③ 当前 lot DUT 坏 die 柱状图  ④ DUT 跨 lot 对比表
 * 任何步骤失败均静默跳过，不阻断主流程。
 */
export async function tryEmitCardDutBadDieChart(
  userQuestion: string,
  payload: Record<string, unknown>,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void
): Promise<void> {
  if (!isCardProbeTestQuestion(userQuestion)) return;

  const device = String(payload["device"] ?? "").trim();
  const lot = String(payload["lot"] ?? "").trim();
  if (!device || !lot) return;

  type CardByPassEntry = { passId: number; cardId: string };
  const cardByPassId = payload["cardByPassId"] as CardByPassEntry[] | undefined;
  const firstCardId = cardByPassId?.[0]?.cardId ?? "";
  const probeCardType = firstCardId.match(/^(\d+)-/)?.[1] ?? "";

  // ① 片间坏 die 对比（无需额外查询）
  tryEmitWaferTotalBadDieChart(payload, 1, emit);

  // ② lot 良率趋势（无需额外查询）
  tryEmitLotYieldTrendChart(payload, emit);

  // ③ 当前 lot DUT 坏 die 总量（需 query_lot_dut_bin_agg）
  emit({ type: "status", message: `正在分析 ${lot} DUT 坏 die 分布…` });

  let lotAggRaw: string;
  try {
    const result = await runTool("query_lot_dut_bin_agg", {
      device, lot, passId: 1,
      ...(probeCardType ? { probeCardType } : {}),
    }, { toolResultMaxChars: agentConfig.toolResultMaxChars, history: [] });
    lotAggRaw = typeof result === "string" ? result : JSON.stringify(result);
  } catch {
    return;
  }

  const dutTotals = computeDutTotalBadDieFromPasses(lotAggRaw, 1);
  if (dutTotals?.length) {
    try {
      const option = buildChartOption(
        "bar",
        `DUT 坏 die 总量（${lot} pass1）`,
        {
          labels: dutTotals.map((d) => `DUT${d.dut}`),
          series: [{ name: "坏 die 颗数", values: dutTotals.map((d) => d.totalBadDie) }],
        }
      );
      emit({ type: "chart", option });
    } catch { /* skip */ }

    // ④ DUT 跨 lot 对比表（需再查一次次近 lot）
    await tryEmitDutCrossLotComparisonTable(payload, lotAggRaw, probeCardType, agentConfig, emit);
  }
}

/** 把 query_lot_dut_bin_agg 结果格式化为 Markdown 表格 + 一句结论。 */
export function buildDutBinAggMarkdown(
  rawContent: string,
  focusBin: number,
  lot: string,
  device: string
): string {
  const parsed = tryParseJsonish(rawContent) as Record<string, unknown> | null;
  if (!parsed) return "";

  const focusBinStr = `BIN${focusBin}`;
  type DutEntry = { dut: number; dieCount: number };
  type DutGroup = { passId: number; bin: string; dutCount: number; totalDieCount: number; avgPerDut: number; duts: DutEntry[] };
  const dutGroups = parsed["focusBinDuts"] as DutGroup[] | undefined;
  if (!dutGroups?.length) return "";

  const lotTag = lot ? `（lot ${lot}${device ? ` ${device}` : ""}）` : "";
  const parts: string[] = [];
  for (const group of dutGroups) {
    const passLabel = `pass${group.passId}`;
    const rows: string[] = [
      `**${focusBinStr} 各 DUT 分布${lotTag}（${passLabel}）**`,
      "",
      `| DUT | 颗数 | 占 ${focusBinStr} 总量% |`,
      "|---:|---:|---:|",
    ];
    for (const d of group.duts) {
      const pct = group.totalDieCount > 0
        ? ((d.dieCount / group.totalDieCount) * 100).toFixed(1)
        : "0.0";
      rows.push(`| DUT${d.dut} | ${d.dieCount} | ${pct}% |`);
    }
    rows.push("");
    rows.push(
      `整批 ${focusBinStr} 合计 **${group.totalDieCount}** 颗，涉及 ${group.dutCount} 个 DUT，平均每 DUT ${group.avgPerDut} 颗。`
    );
    const top = group.duts[0];
    if (top) {
      const topPct = group.totalDieCount > 0
        ? ((top.dieCount / group.totalDieCount) * 100).toFixed(1)
        : "0";
      rows.push(`${focusBinStr} **最多的 DUT 为 DUT${top.dut}**（${top.dieCount} 颗，${topPct}%）。`);
    }
    parts.push(rows.join("\n"));
  }
  return parts.join("\n\n");
}
