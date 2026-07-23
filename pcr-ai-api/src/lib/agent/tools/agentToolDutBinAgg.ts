// pcr-ai-api/src/lib/agent/tools/agentToolDutBinAgg.ts
import {
  runOutputSiteBinByLotForLot,
  runOutputSiteBinByLotForLotByDirectory,
} from "../../outputSiteBinByLot/aggregate.js";
import type { SiteBinPass } from "../../outputSiteBinByLot/types.js";
import {
  tryResolveSiteBinByLotDummyForLot,
  tryResolveSiteBinByLotDummyForLotByDirectory,
} from "../../outputSiteBinByLotDummy.js";
import { parseSiteBinByLotTestEndWindow } from "../../siteBinByLotTestEndWindow.js";
import {
  buildDutConcentrationInsights,
  formatDutConcentrationMarkdown,
} from "../agentDutConcentration.js";
import {
  fetchJbTestRowsForLot,
  buildGoodBinsByPassFromJbRows,
} from "../../lotUnderperformingDutsResolve.js";
import {
  buildCardByPassId,
  type CardByPassIdEntry,
} from "../jb/agentJbBinFormat.js";
import { ensureFocusDutInCompactedDuts } from "../agentDutFocusBins.js";
import { truncateResult } from "./agentToolHandlers.js";

/**
 * Compact INF DUT-distribution data before handing to the model.
 *
 * Without compaction a single wafer (78 DUTs × 50 bins × 3 passes) can
 * exceed 100 KB of JSON, blowing past any reasonable toolResultMaxChars.
 *
 * Strategy:
 *  - Good bins (avgDiePerDut > GOOD_BIN_THRESHOLD): replace the full DUT
 *    array with a 5-field summary — model only needs min/max/total.
 *  - Bad bins: keep top MAX_DUTS_PER_BIN DUTs sorted by dieCount desc;
 *    append a "moreDuts" note for the remainder.
 *  - Skip bins with totalDieCount = 0.
 *  - Optional focusDut: always keep that DUT in each bad BIN's duts list.
 */
const GOOD_BIN_AVG_THRESHOLD = 100; // avg dieCount/DUT above this ≈ good/passing bin
const MAX_DUTS_PER_BAD_BIN = 8;    // top DUTs shown per bad bin; 8 is enough for DUT comparison
const MAX_BAD_BINS_DETAIL = 15;    // limit full-DUT-breakdown to top N bad bins by totalDieCount

export function extractFocusBinDuts(passes: unknown[], focusBinKey: string): unknown[] {
  const result: unknown[] = [];
  for (const p of passes) {
    const pass = p as { passId: number; bins?: unknown[] };
    if (!pass.bins) continue;
    const entry = pass.bins.find((b) => (b as { bin?: string }).bin === focusBinKey);
    if (!entry) continue;
    result.push({ passId: pass.passId, ...(entry as object) });
  }
  return result;
}

export type CompactSiteBinOpts = {
  /** 用户聚焦的 DUT：压缩时保留该 DUT，即使不在各 BIN Top8 */
  focusDut?: number;
};

export type LotDutConcentrationContext = {
  opts: Parameters<typeof buildDutConcentrationInsights>[2];
  /** 各 pass 的 CARDID，供集中度表「卡号」列；勿写入工具 JSON（避免暴露内部字段名）。 */
  cardByPassId: CardByPassIdEntry[];
};

/**
 * 单 lot DUT 集中度：一次拉 JB TEST 行，同时得到良品 bin 集合 + cardByPassId。
 * 良品 bin 来自 PASSBIN（与 lotUnderperformingDutsResolve 同口径）；卡号来自 CARDID。
 */
export async function lotDutConcentrationContext(
  device: string,
  lot: string,
  passIds: number[],
  focusBinNum: number
): Promise<LotDutConcentrationContext> {
  const jbRows = await fetchJbTestRowsForLot(device, lot, passIds);
  const goodBinsByPassId = buildGoodBinsByPassFromJbRows(jbRows);
  const goodBins = new Set<number>();
  for (const set of goodBinsByPassId.values()) {
    for (const n of set) goodBins.add(n);
  }
  const opts: Parameters<typeof buildDutConcentrationInsights>[2] = { goodBins };
  if (Number.isFinite(focusBinNum)) opts.focusBins = [focusBinNum];
  return { opts, cardByPassId: buildCardByPassId(jbRows) };
}

export function compactSiteBinPasses(
  passes: SiteBinPass[],
  opts?: CompactSiteBinOpts
): unknown[] {
  const focusDut = opts?.focusDut;
  return passes.map((pass) => {
    // Separate good bins (summary only) and bad bins (full DUT breakdown)
    type MappedBin = { bin: string; isGoodBin?: boolean; totalDieCount: number; [k: string]: unknown };
    const mapped: (MappedBin | null)[] = pass.bins.map((b) => {
      const total = b.duts.reduce((s, d) => s + d.dieCount, 0);
      if (total === 0) return null;
      const dutCount = b.duts.length;
      const avg = dutCount > 0 ? total / dutCount : 0;

      if (avg > GOOD_BIN_AVG_THRESHOLD) {
        // Good / passing bin — summary only
        const min = b.duts.reduce((m, d) => Math.min(m, d.dieCount), Infinity);
        const max = b.duts.reduce((m, d) => Math.max(m, d.dieCount), 0);
        return { bin: b.bin, isGoodBin: true, dutCount, totalDieCount: total, minPerDut: min === Infinity ? 0 : min, maxPerDut: max };
      }
      return { bin: b.bin, dutCount, totalDieCount: total, avgPerDut: Math.round(avg), _duts: b.duts };
    });

    const valid = mapped.filter(Boolean) as MappedBin[];
    const goodBins = valid.filter((b) => b.isGoodBin);
    const badBins  = valid.filter((b) => !b.isGoodBin);

    // Sort bad bins by totalDieCount desc; only show full DUT breakdown for top N
    badBins.sort((a, b) => b.totalDieCount - a.totalDieCount);
    const detailBins = badBins.slice(0, MAX_BAD_BINS_DETAIL);
    const summaryBins = badBins.slice(MAX_BAD_BINS_DETAIL);

    const formattedDetail = detailBins.map((b) => {
      const rawDuts =
        (b["_duts"] as Array<{ dut: number | "single"; dieCount: number }>) ?? [];
      const sorted = [...rawDuts].sort((a, z) => z.dieCount - a.dieCount);
      let top: Array<{ dut: number | "single"; dieCount: number }> = sorted.slice(
        0,
        MAX_DUTS_PER_BAD_BIN
      );
      if (focusDut != null) {
        top = ensureFocusDutInCompactedDuts(
          top,
          sorted,
          focusDut,
          MAX_DUTS_PER_BAD_BIN
        ) as Array<{ dut: number | "single"; dieCount: number }>;
      }
      const extra = Math.max(0, sorted.length - top.length);
      const { _duts: _d, ...rest } = b;
      void _d;
      return { ...rest, duts: top, ...(extra > 0 ? { moreDuts: `另有 ${extra} 个 DUT 未展示` } : {}) };
    });

    const formattedSummary = summaryBins.map(({ _duts: _d, ...rest }) => { void _d; return { ...rest, dutBreakdownOmitted: true }; });
    const extraNote = summaryBins.length > 0
      ? [{ note: `另有 ${summaryBins.length} 个低频坏 BIN 仅含汇总（无 DUT 明细）` }]
      : [];

    return {
      passId: pass.passId,
      bins: [...goodBins, ...formattedDetail, ...formattedSummary, ...extraNote],
    };
  });
}

export async function toolQueryLotDutBinAgg(
  args: Record<string, unknown>,
  maxChars: number
): Promise<string> {
  const device = typeof args["device"] === "string" ? args["device"].trim() : "";
  const lot = typeof args["lot"] === "string" ? args["lot"].trim() : "";

  if (!device) return "query_lot_dut_bin_agg 参数错误: device 不能为空";
  if (!lot) return "query_lot_dut_bin_agg 参数错误: lot 不能为空";

  const passIds: number[] = [];
  if (typeof args["passId"] === "number") passIds.push(Math.round(args["passId"]));
  if (Array.isArray(args["passIds"])) {
    for (const p of args["passIds"]) {
      if (typeof p === "number") passIds.push(Math.round(p));
    }
  }
  if (passIds.length === 0) passIds.push(1, 3, 5);

  const probeCardType =
    typeof args["probeCardType"] === "string" ? args["probeCardType"].trim() : "";

  const focusBinRaw = args["focusBin"];
  const focusBinNum = typeof focusBinRaw === "number" ? Math.round(focusBinRaw) : NaN;
  const focusBinKey = Number.isFinite(focusBinNum) ? `bin${focusBinNum}` : undefined;

  try {
    if (probeCardType) {
      const testEndWindow = parseSiteBinByLotTestEndWindow({});
      const dummy = tryResolveSiteBinByLotDummyForLot(
        device, lot, probeCardType, passIds, testEndWindow
      );
      if (dummy !== null) {
        const rawPasses = dummy.passes;
        const { opts, cardByPassId } = await lotDutConcentrationContext(
          device, lot, passIds, focusBinNum
        );
        const dutMd = formatDutConcentrationMarkdown(
          buildDutConcentrationInsights(rawPasses, cardByPassId, opts)
        );
        const passes = compactSiteBinPasses(rawPasses);
        const focusBinDuts = focusBinKey ? extractFocusBinDuts(passes, focusBinKey) : undefined;
        const body = truncateResult(
          {
            ...(focusBinDuts?.length ? { focusBin: focusBinKey, focusBinDuts } : {}),
            device, lot, probeCardType: dummy.probeCardType ?? probeCardType,
            waferCount: dummy.waferCount, waferSlots: dummy.waferSlots,
            passes,
          },
          maxChars
        );
        return (dutMd ? dutMd + "\n\n" : "") + body;
      }
      const res = await runOutputSiteBinByLotForLot(
        device, lot, probeCardType, passIds, testEndWindow
      );
      const rawPasses = res.data.passes;
      const { opts, cardByPassId } = await lotDutConcentrationContext(
        device, lot, passIds, focusBinNum
      );
      const dutMd = formatDutConcentrationMarkdown(
        buildDutConcentrationInsights(rawPasses, cardByPassId, opts)
      );
      const passes = compactSiteBinPasses(rawPasses);
      const focusBinDuts = focusBinKey ? extractFocusBinDuts(passes, focusBinKey) : undefined;
      const body = truncateResult(
        {
          ...(focusBinDuts?.length ? { focusBin: focusBinKey, focusBinDuts } : {}),
          device, lot, probeCardType: res.probeCardType ?? probeCardType,
          waferCount: res.waferCount, waferSlots: res.waferSlots,
          passes,
          ...(res.skippedInfPaths.length > 0 ? { skippedWafers: res.skippedInfPaths.length } : {}),
        },
        maxChars
      );
      return (dutMd ? dutMd + "\n\n" : "") + body;
    } else {
      const dummy = tryResolveSiteBinByLotDummyForLotByDirectory(device, lot, passIds);
      if (dummy !== null) {
        const rawPasses = dummy.passes;
        const { opts, cardByPassId } = await lotDutConcentrationContext(
          device, lot, passIds, focusBinNum
        );
        const dutMd = formatDutConcentrationMarkdown(
          buildDutConcentrationInsights(rawPasses, cardByPassId, opts)
        );
        const passes = compactSiteBinPasses(rawPasses);
        const focusBinDuts = focusBinKey ? extractFocusBinDuts(passes, focusBinKey) : undefined;
        const body = truncateResult(
          {
            ...(focusBinDuts?.length ? { focusBin: focusBinKey, focusBinDuts } : {}),
            device, lot,
            waferCount: dummy.waferCount, waferSlots: dummy.waferSlots,
            passes,
          },
          maxChars
        );
        return (dutMd ? dutMd + "\n\n" : "") + body;
      }
      const res = await runOutputSiteBinByLotForLotByDirectory(device, lot, passIds);
      const rawPasses = res.data.passes;
      const { opts, cardByPassId } = await lotDutConcentrationContext(
        device, lot, passIds, focusBinNum
      );
      const dutMd = formatDutConcentrationMarkdown(
        buildDutConcentrationInsights(rawPasses, cardByPassId, opts)
      );
      const passes = compactSiteBinPasses(rawPasses);
      const focusBinDuts = focusBinKey ? extractFocusBinDuts(passes, focusBinKey) : undefined;
      const body = truncateResult(
        {
          ...(focusBinDuts?.length ? { focusBin: focusBinKey, focusBinDuts } : {}),
          device, lot,
          waferCount: res.waferCount, waferSlots: res.waferSlots,
          passes,
        },
        maxChars
      );
      return (dutMd ? dutMd + "\n\n" : "") + body;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e && typeof e === "object" && "statusCode" in e) {
      const code = (e as { statusCode: number }).statusCode;
      if (code === 404) return `query_lot_dut_bin_agg: lot INF 目录未找到 — ${msg}`;
      if (code === 400) return `query_lot_dut_bin_agg 参数错误: ${msg}`;
    }
    return `query_lot_dut_bin_agg 执行失败: ${msg}`;
  }
}
