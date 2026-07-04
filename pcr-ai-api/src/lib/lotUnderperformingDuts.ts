import { goodBinNumbersFromSiteBinPasses } from "./agent/agentDutConcentration.js";
import { passIdSortLabel } from "./jbYieldCalc.js";
import {
  OutputSiteBinByLotValidationError,
  type SiteBinPass,
} from "./outputSiteBinByLot.js";

export const LOT_UNDERPERFORMING_DUTS_SUMMARY =
  "Lot-level probe-card DUT yield from aggregated INF site-bin data: list DUTs whose yield is below thresholdRatio × lot overall yield for each requested pass.";

export const DEFAULT_UNDERPERFORMING_THRESHOLD_RATIO = 0.75;
export const HARD_GOOD_BIN = 1;

export type DutYieldBaselineMethod = "lotOverall";

export type DutYieldEntry = {
  dut: number;
  goodDie: number;
  totalDie: number;
  yieldPct: number;
};

export type PassUnderperformingDutsResult = {
  passId: number;
  sortLabel: string;
  dutCount: number;
  lotGoodDie: number;
  lotTotalDie: number;
  baseline: {
    method: DutYieldBaselineMethod;
    yieldPct: number;
    thresholdPct: number;
    thresholdRatio: number;
  } | null;
  allDuts: DutYieldEntry[];
  underperformingDuts: Array<DutYieldEntry & { gapToThresholdPct: number }>;
};

export type LotUnderperformingDutsOptions = {
  thresholdRatio?: number;
  /** 所有 pass 共用（测试 / 显式覆盖）。 */
  goodBins?: Set<number>;
  /** JB PASSBIN + isGoodBin 按 pass 合并；缺省 pass 回退 INF 启发式 + BIN1。 */
  goodBinsByPassId?: Map<number, Set<number>>;
};

function parseBinNumber(bin: string): number | null {
  const m = /(\d+)/.exec(bin);
  return m ? Number(m[1]) : null;
}

function roundYieldPct(n: number): number {
  return Math.round(n * 100) / 100;
}

function yieldPctFromDie(good: number, total: number): number | null {
  if (total <= 0) return null;
  return roundYieldPct((good / total) * 100);
}

function buildGoodBinsFromInfHeuristic(passes: SiteBinPass[]): Set<number> {
  const good = goodBinNumbersFromSiteBinPasses(passes);
  good.add(HARD_GOOD_BIN);
  return good;
}

function resolveGoodBinsForPass(
  pass: SiteBinPass,
  opts: LotUnderperformingDutsOptions
): Set<number> {
  if (opts.goodBins) return opts.goodBins;
  const fromJb = opts.goodBinsByPassId?.get(pass.passId);
  if (fromJb && fromJb.size > 0) return fromJb;
  return buildGoodBinsFromInfHeuristic([pass]);
}

function dutYieldMapForPass(
  pass: SiteBinPass,
  goodBins: Set<number>
): Map<number, { goodDie: number; totalDie: number }> {
  const map = new Map<number, { goodDie: number; totalDie: number }>();
  for (const entry of pass.bins) {
    const binNum = parseBinNumber(entry.bin);
    const isGood = binNum !== null && goodBins.has(binNum);
    for (const { dut, dieCount } of entry.duts) {
      if (typeof dut !== "number" || !Number.isFinite(dieCount) || dieCount <= 0) continue;
      let cell = map.get(dut);
      if (!cell) {
        cell = { goodDie: 0, totalDie: 0 };
        map.set(dut, cell);
      }
      cell.totalDie += dieCount;
      if (isGood) cell.goodDie += dieCount;
    }
  }
  return map;
}

export function computeUnderperformingDutsForPass(
  pass: SiteBinPass,
  opts: LotUnderperformingDutsOptions = {}
): PassUnderperformingDutsResult {
  const thresholdRatio = opts.thresholdRatio ?? DEFAULT_UNDERPERFORMING_THRESHOLD_RATIO;
  const goodBins = resolveGoodBinsForPass(pass, opts);

  const dutMap = dutYieldMapForPass(pass, goodBins);
  let lotGoodDie = 0;
  let lotTotalDie = 0;
  const allDuts: DutYieldEntry[] = [];

  for (const [dut, { goodDie, totalDie }] of [...dutMap.entries()].sort(
    (a, b) => a[0] - b[0]
  )) {
    lotGoodDie += goodDie;
    lotTotalDie += totalDie;
    const yieldPct = yieldPctFromDie(goodDie, totalDie);
    if (yieldPct === null) continue;
    allDuts.push({ dut, goodDie, totalDie, yieldPct });
  }

  if (lotTotalDie === 0 || allDuts.length === 0) {
    return {
      passId: pass.passId,
      sortLabel: passIdSortLabel(pass.passId),
      dutCount: allDuts.length,
      lotGoodDie,
      lotTotalDie,
      baseline: null,
      allDuts,
      underperformingDuts: [],
    };
  }

  const baselineYieldPct = yieldPctFromDie(lotGoodDie, lotTotalDie)!;
  const thresholdPct = roundYieldPct(baselineYieldPct * thresholdRatio);

  const underperformingDuts = allDuts
    .filter((d) => d.yieldPct < thresholdPct)
    .map((d) => ({
      ...d,
      gapToThresholdPct: roundYieldPct(d.yieldPct - thresholdPct),
    }))
    .sort((a, b) => a.yieldPct - b.yieldPct || a.dut - b.dut);

  return {
    passId: pass.passId,
    sortLabel: passIdSortLabel(pass.passId),
    dutCount: allDuts.length,
    lotGoodDie,
    lotTotalDie,
    baseline: {
      method: "lotOverall",
      yieldPct: baselineYieldPct,
      thresholdPct,
      thresholdRatio,
    },
    allDuts,
    underperformingDuts,
  };
}

export function computeUnderperformingDutsForPasses(
  passes: SiteBinPass[],
  opts: LotUnderperformingDutsOptions = {}
): PassUnderperformingDutsResult[] {
  return passes.map((pass) => computeUnderperformingDutsForPass(pass, opts));
}

export function parseUnderperformingThresholdRatio(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") {
    return DEFAULT_UNDERPERFORMING_THRESHOLD_RATIO;
  }
  const s = Array.isArray(raw) ? String(raw[0] ?? "") : String(raw);
  const n = Number(s.trim());
  if (!Number.isFinite(n) || n <= 0 || n > 1) {
    throw new OutputSiteBinByLotValidationError(
      "thresholdRatio must be a number in (0, 1]"
    );
  }
  return n;
}

export function formatUnderperformingDutsMarkdown(
  lot: string,
  device: string,
  passResults: PassUnderperformingDutsResult[],
  thresholdRatio: number
): string {
  const lines = [
    `**Lot ${lot}（${device}）低良率 DUT**（DUT 良率 < lot 整体良率 × ${thresholdRatio}）`,
    "",
  ];
  let any = false;
  for (const pass of passResults) {
    if (!pass.baseline) continue;
    lines.push(
      `### ${pass.sortLabel} — lot 整体 ${pass.baseline.yieldPct}% · 阈值 ${pass.baseline.thresholdPct}%`
    );
    if (pass.underperformingDuts.length === 0) {
      lines.push("无低于阈值的 DUT。");
    } else {
      any = true;
      lines.push("| DUT | 良率% | good/total | 距阈值% |");
      lines.push("|---:|---:|---:|---:|");
      for (const d of pass.underperformingDuts) {
        lines.push(
          `| DUT${d.dut} | ${d.yieldPct} | ${d.goodDie}/${d.totalDie} | ${d.gapToThresholdPct} |`
        );
      }
    }
    lines.push("");
  }
  if (!any && passResults.every((p) => p.baseline && p.underperformingDuts.length === 0)) {
    return lines.join("\n") + "各 pass 均无低于阈值的 DUT。";
  }
  return lines.join("\n").trimEnd();
}
