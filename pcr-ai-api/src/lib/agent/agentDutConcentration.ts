/** DUT 集中度检测：坏 die 集中在少数 DUT（探针卡）vs 分散（工艺）。 */
import type { SiteBinPass } from "../outputSiteBinByLot.js";
import type { CardByPassIdEntry } from "./agentJbBinFormat.js";
import { passIdSortLabel } from "../infcontrol/jbYieldCalc.js";

export type DutConcentrationVerdict = "probe_card" | "process" | "inconclusive";

export type DutConcentrationInsight = {
  bin: number;
  passId: number;
  sortLabel: string;
  cardId: string | null;
  totalDie: number;
  topDuts: Array<{ dut: number; dieCount: number; share: number }>;
  topShare: number;
  verdict: DutConcentrationVerdict;
  detail: string;
};

export type DutConcentrationOptions = {
  topShareThreshold?: number;
  minTotalDie?: number;
  focusBins?: number[];
  /** BIN numbers treated as good/passing — excluded from bad-die concentration table. */
  goodBins?: Set<number>;
};

function parseBinNumber(bin: string): number | null {
  const m = /(\d+)/.exec(bin);
  return m ? Number(m[1]) : null;
}

function cardIdForPass(cardByPassId: CardByPassIdEntry[], passId: number): string | null {
  const e = cardByPassId.find((c) => c.passId === passId);
  if (!e || e.cardIds.length === 0) return null;
  return e.cardIds.join(", ");
}

export function buildDutConcentrationInsights(
  passes: SiteBinPass[],
  cardByPassId: CardByPassIdEntry[] = [],
  opts: DutConcentrationOptions = {}
): DutConcentrationInsight[] {
  const threshold = opts.topShareThreshold ?? 0.7;
  const minTotalDie = opts.minTotalDie ?? 8;
  const focus = opts.focusBins && opts.focusBins.length ? new Set(opts.focusBins) : null;
  const goodBins = opts.goodBins;

  const insights: DutConcentrationInsight[] = [];
  for (const pass of passes) {
    const cardId = cardIdForPass(cardByPassId, pass.passId);
    for (const entry of pass.bins) {
      const bin = parseBinNumber(entry.bin);
      if (bin === null) continue;
      if (goodBins?.has(bin)) continue;
      if (focus && !focus.has(bin)) continue;

      const numeric = entry.duts.filter(
        (d): d is { dut: number; dieCount: number } => typeof d.dut === "number"
      );
      const total = numeric.reduce((s, d) => s + d.dieCount, 0);
      if (numeric.length === 0 || total < minTotalDie) continue;

      const sorted = [...numeric].sort((a, b) => b.dieCount - a.dieCount);
      const k = Math.min(3, sorted.length);
      const topSum = sorted.slice(0, k).reduce((s, d) => s + d.dieCount, 0);
      const topShare = topSum / total;
      const topDuts = sorted.slice(0, k).map((d) => ({
        dut: d.dut,
        dieCount: d.dieCount,
        share: d.dieCount / total,
      }));
      const sortLabel = passIdSortLabel(pass.passId);

      let verdict: DutConcentrationVerdict;
      if (sorted.length < 3) verdict = "inconclusive";
      else if (topShare >= threshold) verdict = "probe_card";
      else verdict = "process";

      const pct = (n: number) => `${Math.round(n * 100)}%`;
      const dutList = topDuts.map((d) => `DUT${d.dut}`).join("/");
      const cardLabel = cardId ? `卡 ${cardId}` : "该 pass 探针卡";
      const detail =
        verdict === "probe_card"
          ? `BIN${bin} ${sortLabel} 坏 die ${total} 颗，${pct(topShare)} 集中在 ${dutList}（${cardLabel}）→ 疑探针卡针点/接触问题`
          : verdict === "process"
          ? `BIN${bin} ${sortLabel} 坏 die ${total} 颗，分散在 ${sorted.length} 个 DUT（最高 ${pct(topShare)}）→ 疑工艺/批次问题`
          : `BIN${bin} ${sortLabel} 坏 die ${total} 颗，仅 ${sorted.length} 个 DUT，样本不足以判别卡/工艺`;

      insights.push({ bin, passId: pass.passId, sortLabel, cardId, totalDie: total, topDuts, topShare, verdict, detail });
    }
  }
  insights.sort((a, b) => b.totalDie - a.totalDie);
  return insights;
}

const VERDICT_LABEL: Record<DutConcentrationVerdict, string> = {
  probe_card: "疑探针卡",
  process: "疑工艺/批次",
  inconclusive: "样本不足",
};

export function formatDutConcentrationMarkdown(insights: DutConcentrationInsight[]): string {
  if (!insights.length) return "";
  const lines = [
    "**坏 die 的 DUT 集中度（卡 vs 工艺判别）**",
    "",
    "| BIN | 测试层 | 卡号 | 总坏die | 主要 DUT(占比) | 判别 |",
    "|---:|---|---|---:|---|---|",
  ];
  for (const i of insights) {
    const dutCol = i.topDuts.map((d) => `DUT${d.dut}(${Math.round(d.share * 100)}%)`).join("、");
    lines.push(
      `| BIN${i.bin} | ${i.sortLabel} | ${i.cardId ?? "—"} | ${i.totalDie} | ${dutCol} | ${VERDICT_LABEL[i.verdict]} |`
    );
  }
  return lines.join("\n");
}

export const DUT_CONCENTRATION_GUIDE =
  "DUT 集中度判别：某坏 BIN 的坏 die 若集中在少数 DUT（top 占比 ≥70%）→ 优先怀疑探针卡针点/接触" +
  "（查该卡对应 DUT 的 INF map、安排针尖检查/清针）；若分散在多数 DUT → 优先怀疑工艺/批次" +
  "（对比同期其它 lot、查工艺参数）。叙述时引用上方判别表，禁止自行估算占比。";
