// pcr-ai-api/src/lib/agent/agentCrossdomainInsights.ts
/** 跨域关联：JB STAR 良率趋势 + YM Monitor 触发趋势，识别探针卡退化信号。
 *
 * 反幻觉设计：算法负责统计计算，LLM 只负责叙述已算好的数字。
 * - YM 触发趋势：早期 lot vs 晚期 lot 的平均触发次数比较
 * - JB 良率趋势：早期 lot vs 晚期 lot 的平均最差片良率比较
 * - signalStrength：两项均朝退化方向 → strong；一项 → moderate；均稳定 → none
 */

import { buildLotYieldRank } from "../jbYieldCalc.js";

export type CardDegradationEvidence = {
  lot: string;
  testEnd: string;
  /** JB 该 lot 最差片良率%，null 表示无法计算 */
  jbYieldPct: number | null;
  /** 该 lot 在 YM Monitor 中该探针卡的触发次数 */
  ymTriggerCount: number;
};

export type CardDegradationSignal = {
  cardId: string;
  /** 参与趋势分析的 lot 数（有 testEnd 的） */
  analyzedLots: number;
  /** 仅有 JB 数据、在 YM 历史中未出现的 lot 数 */
  jbOnlyLots: number;
  ymTrend: "rising" | "stable" | "falling" | "insufficient_data";
  jbYieldTrend: "falling" | "stable" | "rising" | "insufficient_data";
  signalStrength: "strong" | "moderate" | "none";
  /** 最近 10 个 lot（时间倒序），供 LLM 引用具体数字 */
  evidence: CardDegradationEvidence[];
  /** 服务端预渲染的表格 + 摘要，LLM 可直接引用 */
  summaryMarkdown: string;
};

export const CARD_DEGRADATION_SIGNAL_GUIDE =
  "cardDegradationSignal：算法关联同一 cardId 多 lot 的 YM 触发频次趋势（ymTrend）与 JB 最差片良率趋势（jbYieldTrend）。" +
  "**signalStrength=strong**：两项均朝退化方向，必须首段点明并引用 evidence 中具体 lot 数/良率幅度/触发次数；" +
  "**signalStrength=moderate**：一项提示退化，须提醒关注；" +
  "**signalStrength=none** 或 **insufficient_data**：禁止做退化结论；" +
  "所有结论限于「观测到相关性，建议关注」，禁止写「因为…所以…」因果推断；summaryMarkdown 含预渲染表格可直接引用。";

/** 用外侧 40% 的 lot（早段与晚段）比较均值，比线性回归对小样本更稳健。 */
function earlyLateAvg(values: number[]): { earlyAvg: number; lateAvg: number } {
  const n = values.length;
  const split = Math.max(1, Math.floor(n * 0.4));
  const early = values.slice(0, split);
  const late = values.slice(n - split);
  const avg = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;
  return { earlyAvg: avg(early), lateAvg: avg(late) };
}

function classifyYmTrend(
  ymValues: number[],
  coverageRatio: number
): CardDegradationSignal["ymTrend"] {
  if (coverageRatio < 0.25 || ymValues.length < 4) return "insufficient_data";
  const { earlyAvg, lateAvg } = earlyLateAvg(ymValues);
  const delta = lateAvg - earlyAvg;
  const base = Math.max(earlyAvg, 0.5);
  if (delta >= 1.5 && lateAvg / base >= 1.4) return "rising";
  if (delta <= -1.5 && earlyAvg / Math.max(lateAvg, 0.5) >= 1.4) return "falling";
  return "stable";
}

function classifyJbYieldTrend(
  yieldValues: number[]
): CardDegradationSignal["jbYieldTrend"] {
  if (yieldValues.length < 3) return "insufficient_data";
  const { earlyAvg, lateAvg } = earlyLateAvg(yieldValues);
  const delta = lateAvg - earlyAvg;
  if (delta <= -2.0) return "falling";
  if (delta >= 2.0) return "rising";
  return "stable";
}

function buildSummaryMarkdown(
  cardId: string,
  ymTrend: CardDegradationSignal["ymTrend"],
  jbYieldTrend: CardDegradationSignal["jbYieldTrend"],
  signalStrength: CardDegradationSignal["signalStrength"],
  evidence: CardDegradationEvidence[]
): string {
  const signalLabel =
    signalStrength === "strong"
      ? "⚠ 强退化信号"
      : signalStrength === "moderate"
      ? "△ 中等信号"
      : "✓ 无明显退化信号";

  const ymLabel =
    ymTrend === "rising"
      ? "↑ 上升"
      : ymTrend === "falling"
      ? "↓ 下降"
      : ymTrend === "stable"
      ? "→ 稳定"
      : "数据不足";

  const jbLabel =
    jbYieldTrend === "falling"
      ? "↓ 下降"
      : jbYieldTrend === "rising"
      ? "↑ 上升"
      : jbYieldTrend === "stable"
      ? "→ 稳定"
      : "数据不足";

  const lines = [
    `**探针卡 ${cardId} 退化风险评估（${signalLabel}）**`,
    `YM 触发趋势：${ymLabel}　JB 最差片良率趋势：${jbLabel}`,
    "",
    "| Lot | 测试结束 | JB 最差片良率% | YM 触发次数 |",
    "|---|---|---:|---:|",
  ];

  for (const e of evidence.slice(0, 8)) {
    const yStr = e.jbYieldPct !== null ? e.jbYieldPct.toFixed(1) : "—";
    const date = e.testEnd.slice(0, 10);
    lines.push(`| ${e.lot} | ${date} | ${yStr} | ${e.ymTriggerCount} |`);
  }
  lines.push("");
  return lines.join("\n");
}

/** 按 YM 行统计每个 lot 的触发次数（key = LOTID）。 */
function buildYmTriggerCountByLot(
  ymRows: Record<string, unknown>[]
): Map<string, number> {
  const map = new Map<string, number>();
  for (const r of ymRows) {
    const lotId = String(
      r["LOTID"] ?? r["lotId"] ?? r["lotid"] ?? ""
    ).trim();
    if (!lotId) continue;
    map.set(lotId, (map.get(lotId) ?? 0) + 1);
  }
  return map;
}

/**
 * 计算同一探针卡多 lot 的跨域退化信号。
 *
 * @param jbRows   query_jb_bins 返回的已 enrich 行（含 LOT / TESTEND / bins）
 * @param ymRows   针对该 cardId（probeCard）查询的 YM 原始行（含 LOTID）
 * @param cardId   探针卡 ID，用于结论显示
 * @returns        退化信号对象；lot 数 < 3 时返回 null
 */
export function buildCardDegradationSignal(
  jbRows: Record<string, unknown>[],
  ymRows: Record<string, unknown>[],
  cardId: string
): CardDegradationSignal | null {
  // 1. 每 lot JB 最差片良率（buildLotYieldRank 内部按 testEnd DESC 排，取 top50）
  const lotYieldEntries = buildLotYieldRank(jbRows, 50);
  if (lotYieldEntries.length < 3) return null;

  // 2. YM 触发次数 per lot
  const ymByLot = buildYmTriggerCountByLot(ymRows);

  // 3. 合并并按 testEnd ASC 排序（早→晚，用于趋势方向判断）
  const jointLots = lotYieldEntries
    .filter((e) => e.testEnd !== null)
    .sort((a, b) => {
      const ta = new Date(a.testEnd!).getTime();
      const tb = new Date(b.testEnd!).getTime();
      return ta - tb;
    })
    .map((e) => ({
      lot: e.lot,
      testEnd: e.testEnd!,
      jbYieldPct: e.yieldPct,
      ymTriggerCount: ymByLot.get(e.lot) ?? 0,
    }));

  if (jointLots.length < 3) return null;

  const jbOnlyLots = jointLots.filter((e) => !ymByLot.has(e.lot)).length;
  const coverageRatio = 1 - jbOnlyLots / jointLots.length;

  // 4. 趋势分类
  const ymValues = jointLots.map((e) => e.ymTriggerCount);
  const jbYieldValues = jointLots
    .map((e) => e.jbYieldPct)
    .filter((v): v is number => v !== null);

  const ymTrend = classifyYmTrend(ymValues, coverageRatio);
  const jbYieldTrend = classifyJbYieldTrend(jbYieldValues);

  // 5. 综合信号强度
  const concerningCount =
    (ymTrend === "rising" ? 1 : 0) +
    (jbYieldTrend === "falling" ? 1 : 0);
  const signalStrength: CardDegradationSignal["signalStrength"] =
    concerningCount >= 2 ? "strong" : concerningCount === 1 ? "moderate" : "none";

  // 6. Evidence：最近 10 lot（时间倒序，供 LLM 引用具体数字）
  const evidence = [...jointLots].reverse().slice(0, 10);

  // 7. 预渲染 Markdown
  const summaryMarkdown = buildSummaryMarkdown(
    cardId,
    ymTrend,
    jbYieldTrend,
    signalStrength,
    evidence
  );

  return {
    cardId,
    analyzedLots: jointLots.length,
    jbOnlyLots,
    ymTrend,
    jbYieldTrend,
    signalStrength,
    evidence,
    summaryMarkdown,
  };
}
