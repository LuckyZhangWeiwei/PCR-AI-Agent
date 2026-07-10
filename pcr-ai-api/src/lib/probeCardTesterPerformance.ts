import { badDieFromJbRow } from "./jbYieldCalc.js";

// ─── stats helpers ──────────────────────────────────────────────────────────

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/** Sample standard deviation (n-1 denominator). 0 when fewer than 2 values. */
export function sampleStdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const sumSq = values.reduce((s, v) => s + (v - m) * (v - m), 0);
  return Math.sqrt(sumSq / (values.length - 1));
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

// ─── per-row yield ──────────────────────────────────────────────────────────

function grossDieOf(row: Record<string, unknown>): number {
  const g = Number((row as Record<string, unknown>)["GROSSDIE"] ?? (row as Record<string, unknown>)["grossDie"] ?? 0);
  return Number.isFinite(g) && g > 0 ? g : 0;
}

/**
 * Per-row yield percentage (0-100). `row` must already be enriched (has
 * `row.bins[]`, see `enrichJbRow` / `enrichInfcontrolLayerBinRowV2`). Reuses
 * `badDieFromJbRow` (BIN1-hard-good + PASSBIN hyphen tokens + bins[].isGoodBin
 * union) — do not reimplement bad-die counting here.
 * Returns null when GROSSDIE is missing/zero (row excluded from stats).
 */
export function rowYieldPct(row: Record<string, unknown>): number | null {
  const grossDie = grossDieOf(row);
  if (grossDie <= 0) return null;
  const bad = badDieFromJbRow(row);
  return (1 - bad / grossDie) * 100;
}

import { goodBinIndicesForJbRow } from "./jbYieldCalc.js";

// ─── shared row accessors ───────────────────────────────────────────────────

function fieldStr(row: Record<string, unknown>, upper: string, lower: string): string {
  return String(row[upper] ?? row[lower] ?? "").trim();
}

function monthKeyFromTestEnd(row: Record<string, unknown>): string | null {
  const raw = row["TESTEND"] ?? row["testend"];
  if (!raw) return null;
  const d = raw instanceof Date ? raw : new Date(String(raw));
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/** Per-bin bad-die breakdown for one row (mirrors badDieFromJbRow's loop, but keeps per-bin counts instead of collapsing to a total). Reuses goodBinIndicesForJbRow — does not reimplement good-bin detection. */
function badBinCountsForRow(row: Record<string, unknown>): Map<number, number> {
  const good = goodBinIndicesForJbRow(row);
  const counts = new Map<number, number>();
  const bins = Array.isArray(row["bins"]) ? (row["bins"] as unknown[]) : [];
  for (const cell of bins) {
    if (cell == null || typeof cell !== "object") continue;
    const c = cell as { n?: number; value?: number };
    const n = Number(c.n);
    const v = Number(c.value ?? 0);
    if (!Number.isFinite(n) || !Number.isFinite(v) || v <= 0) continue;
    if (good.has(n)) continue;
    counts.set(n, (counts.get(n) ?? 0) + v);
  }
  return counts;
}

// ─── public types ───────────────────────────────────────────────────────────

export type ConfidenceTier = "高" | "中" | "低";

export interface ComboRankRow {
  cardId: string;
  testerId: string;
  passId: number;
  avgYieldPct: number;
  stdDevYieldPct: number;
  recordCount: number;
  lotCount: number;
  confidenceTier: ConfidenceTier;
}

export interface CardRankRow {
  cardId: string;
  passId: number;
  avgYieldPct: number;
  stdDevYieldPct: number;
  recordCount: number;
  lotCount: number;
  confidenceTier: ConfidenceTier;
  assessment: string;
}

export interface CardTrendRow {
  cardId: string;
  month: string;
  avgYieldPct: number;
  recordCount: number;
}

export interface CardBadBinRow {
  cardId: string;
  topBins: { bin: number; pct: number }[];
}

export interface PassGroupResult {
  passId: number;
  comboRanking: ComboRankRow[];
  cardRanking: CardRankRow[];
  cardTrend: CardTrendRow[];
  cardBadBin: CardBadBinRow[];
  comboRankingMarkdown: string;
  cardRankingMarkdown: string;
  cardTrendMarkdown: string;
  cardBadBinMarkdown: string;
}

function confidenceTierFromLotCount(lotCount: number): ConfidenceTier {
  if (lotCount >= 10) return "高";
  if (lotCount >= 3) return "中";
  return "低";
}

function fmtPct(n: number): string {
  return `${n.toFixed(2)}%`;
}

function mdTable(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return "(无数据)";
  const head = `| ${headers.join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${r.join(" | ")} |`).join("\n");
  return [head, sep, body].join("\n");
}

// ─── grouping ────────────────────────────────────────────────────────────

const VALID_PASS_IDS = [1, 3, 5];

export function computeProbeCardTesterPerformance(
  enrichedRows: Record<string, unknown>[]
): PassGroupResult[] {
  // { passId -> { cardId -> { testerId -> rows[] } } } plus flat card-level rows
  type ValidRow = { cardId: string; testerId: string; lot: string; yieldPct: number; month: string | null; row: Record<string, unknown> };
  const byPassId = new Map<number, ValidRow[]>();

  for (const row of enrichedRows) {
    const passId = Number(row["PASSID"] ?? row["passid"]);
    if (!VALID_PASS_IDS.includes(passId)) continue;
    const cardId = fieldStr(row, "CARDID", "cardid");
    if (!cardId) continue;
    const testerId = fieldStr(row, "TESTERID", "testerid");
    const lot = fieldStr(row, "LOT", "lot");
    const yieldPct = rowYieldPct(row);
    if (yieldPct == null) continue;
    const entry: ValidRow = { cardId, testerId, lot, yieldPct, month: monthKeyFromTestEnd(row), row };
    const list = byPassId.get(passId) ?? [];
    list.push(entry);
    byPassId.set(passId, list);
  }

  const passIds = [...byPassId.keys()].sort((a, b) => a - b);

  return passIds.map((passId) => {
    const rows = byPassId.get(passId)!;

    // ── combo ranking: group by (cardId, testerId) ──
    const comboGroups = new Map<string, ValidRow[]>();
    for (const r of rows) {
      const key = `${r.cardId}::${r.testerId}`;
      const list = comboGroups.get(key) ?? [];
      list.push(r);
      comboGroups.set(key, list);
    }
    const comboRanking: ComboRankRow[] = [...comboGroups.values()].map((list) => {
      const yields = list.map((r) => r.yieldPct);
      const lotCount = new Set(list.map((r) => r.lot)).size;
      return {
        cardId: list[0]!.cardId,
        testerId: list[0]!.testerId,
        passId,
        avgYieldPct: mean(yields),
        stdDevYieldPct: sampleStdDev(yields),
        recordCount: list.length,
        lotCount,
        confidenceTier: confidenceTierFromLotCount(lotCount),
      };
    });
    comboRanking.sort((a, b) =>
      b.avgYieldPct !== a.avgYieldPct
        ? b.avgYieldPct - a.avgYieldPct
        : a.stdDevYieldPct !== b.stdDevYieldPct
        ? a.stdDevYieldPct - b.stdDevYieldPct
        : b.recordCount - a.recordCount
    );

    // ── card ranking: group by cardId (across testers) ──
    const cardGroups = new Map<string, ValidRow[]>();
    for (const r of rows) {
      const list = cardGroups.get(r.cardId) ?? [];
      list.push(r);
      cardGroups.set(r.cardId, list);
    }
    const cardStats = [...cardGroups.entries()].map(([cardId, list]) => {
      const yields = list.map((r) => r.yieldPct);
      const lotCount = new Set(list.map((r) => r.lot)).size;
      return {
        cardId,
        avgYieldPct: mean(yields),
        stdDevYieldPct: sampleStdDev(yields),
        recordCount: list.length,
        lotCount,
      };
    });
    const groupAvgs = cardStats.map((c) => c.avgYieldPct);
    const groupMean = mean(groupAvgs);
    const groupStdDev = sampleStdDev(groupAvgs);
    const groupStdDevMedian = median(cardStats.map((c) => c.stdDevYieldPct));

    const cardRanking: CardRankRow[] = cardStats.map((c) => {
      const confidenceTier = confidenceTierFromLotCount(c.lotCount);
      let assessment: string;
      if (c.lotCount < 3) {
        assessment = "样本有限，置信度低";
      } else if (c.avgYieldPct < groupMean - 1.5 * groupStdDev) {
        assessment = "良率明显偏低";
      } else if (c.stdDevYieldPct > groupStdDevMedian) {
        assessment = "波动较大，稳定性差";
      } else {
        assessment = "表现稳定";
      }
      return { ...c, confidenceTier, assessment, passId };
    });
    cardRanking.sort((a, b) => a.avgYieldPct - b.avgYieldPct);

    // ── monthly trend by cardId ──
    const trendGroups = new Map<string, Map<string, ValidRow[]>>();
    for (const r of rows) {
      if (!r.month) continue;
      const byMonth = trendGroups.get(r.cardId) ?? new Map<string, ValidRow[]>();
      const list = byMonth.get(r.month) ?? [];
      list.push(r);
      byMonth.set(r.month, list);
      trendGroups.set(r.cardId, byMonth);
    }
    const cardTrend: CardTrendRow[] = [];
    for (const [cardId, byMonth] of trendGroups) {
      if (byMonth.size < 2) continue;
      const months = [...byMonth.keys()].sort();
      for (const month of months) {
        const list = byMonth.get(month)!;
        cardTrend.push({
          cardId,
          month,
          avgYieldPct: mean(list.map((r) => r.yieldPct)),
          recordCount: list.length,
        });
      }
    }
    cardTrend.sort((a, b) => (a.cardId === b.cardId ? a.month.localeCompare(b.month) : a.cardId.localeCompare(b.cardId)));

    // ── bad bin frequency by cardId ──
    const cardBadBin: CardBadBinRow[] = [];
    for (const [cardId, list] of cardGroups) {
      const totals = new Map<number, number>();
      for (const r of list) {
        const perRow = badBinCountsForRow(r.row);
        for (const [bin, count] of perRow) {
          totals.set(bin, (totals.get(bin) ?? 0) + count);
        }
      }
      const grandTotal = [...totals.values()].reduce((s, v) => s + v, 0);
      if (grandTotal <= 0) continue;
      const topBins = [...totals.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([bin, count]) => ({ bin, pct: (count / grandTotal) * 100 }));
      cardBadBin.push({ cardId, topBins });
    }
    cardBadBin.sort((a, b) => a.cardId.localeCompare(b.cardId));

    // ── markdown ──
    const comboRankingMarkdown = mdTable(
      ["排名", "CardId", "TesterId", "平均良率", "标准差", "片数", "Lot 数", "置信度"],
      comboRanking.map((r, i) => [
        String(i + 1),
        r.cardId,
        r.testerId,
        fmtPct(r.avgYieldPct),
        fmtPct(r.stdDevYieldPct),
        String(r.recordCount),
        String(r.lotCount),
        r.confidenceTier,
      ])
    );
    const cardRankingMarkdown = mdTable(
      ["排名", "CardId", "平均良率", "标准差", "片数", "Lot 数", "评估", "置信度"],
      cardRanking.map((r, i) => [
        String(i + 1),
        r.cardId,
        fmtPct(r.avgYieldPct),
        fmtPct(r.stdDevYieldPct),
        String(r.recordCount),
        String(r.lotCount),
        r.assessment,
        r.confidenceTier,
      ])
    );
    const cardTrendMarkdown = mdTable(
      ["CardId", "月份", "当月平均良率", "当月样本数"],
      cardTrend.map((r) => [r.cardId, r.month, fmtPct(r.avgYieldPct), String(r.recordCount)])
    );
    const cardBadBinMarkdown = mdTable(
      ["CardId", "Top 3 坏 bin"],
      cardBadBin.map((r) => [
        r.cardId,
        r.topBins.map((b) => `BIN${b.bin} (${b.pct.toFixed(2)}%)`).join(", "),
      ])
    );

    return {
      passId,
      comboRanking,
      cardRanking,
      cardTrend,
      cardBadBin,
      comboRankingMarkdown,
      cardRankingMarkdown,
      cardTrendMarkdown,
      cardBadBinMarkdown,
    };
  });
}
