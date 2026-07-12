/**
 * Full wafer analysis (calculateWafer) plus per-site statistics, lot-level
 * yield rollup and small geometry/rendering utilities used alongside it.
 * Port of WaferYieldCalculator.Calculate().
 */

import type { InfBlock } from "../infParser.js";
import {
  type DieEntry,
  type PassResult,
  type WaferResult,
  decodePsbn,
  findPsbn,
  readDieGeometry,
  buildDieMapForFinalFlow,
  buildDieMapForSmWaferPass,
  countPossibleDie,
  findAllSmWaferPasses,
} from "./infWaferMapGeometry.js";

// ── Parse timing ───────────────────────────────────────────────────────────

function parseInfTime(raw: string | undefined): string {
  if (!raw) return "";
  // INF times: "YYYY/MM/DD HH:MM:SS" or similar
  return raw.trim();
}

function timeDiffSeconds(start: string, end: string): number {
  if (!start || !end) return 0;
  const s = new Date(start.replace(/\//g, "-")).getTime();
  const e = new Date(end.replace(/\//g, "-")).getTime();
  if (isNaN(s) || isNaN(e)) return 0;
  return Math.round((e - s) / 1000);
}

// ── Full wafer calculate ───────────────────────────────────────────────────

/** Identity fields read from WaferSummary / SmWaferSummary (or root as fallback). */
function extractWaferIdentity(root: InfBlock): {
  lot: string;
  waferId: string;
  slot: string;
  cassette: string;
  wptId: string;
  waferBatch: string;
  mesSlot: string;
  rotation: string;
} {
  const hdr = root.block("WaferSummary") ?? root.block("SmWaferSummary") ?? root;
  return {
    lot: hdr.key("LOT_ID") ?? hdr.key("LOTID") ?? root.key("LOT_ID") ?? "",
    waferId: hdr.key("WAFER_ID") ?? root.key("WAFER_ID") ?? "",
    slot: hdr.key("SLOT") ?? root.key("SLOT") ?? "",
    cassette: hdr.key("CASSETTE") ?? root.key("CASSETTE") ?? "",
    wptId: hdr.key("WPT_ID") ?? root.key("WPT_ID") ?? "",
    waferBatch: hdr.key("WAFER_BATCH") ?? root.key("WAFER_BATCH") ?? "",
    mesSlot: hdr.key("MES_SLOT") ?? root.key("MES_SLOT") ?? "",
    rotation: hdr.key("ROTATION") ?? root.key("ROTATION") ?? "",
  };
}

/** Final (flow-level composite) die map + bin counts + row/col bounds. */
function computeFinalDieStats(
  root: InfBlock,
  goodBins: Set<number>
): {
  finalDies: DieEntry[];
  possibleDie: number;
  finalBinCounts: Record<number, number>;
  finalGood: number;
  rowMin: number;
  colMin: number;
  rowCount: number;
  colCount: number;
} {
  const finalDies = buildDieMapForFinalFlow(root, goodBins);
  const possibleDie = countPossibleDie(root);

  const finalBinCounts: Record<number, number> = {};
  let finalGood = 0;
  for (const d of finalDies) {
    finalBinCounts[d.bin] = (finalBinCounts[d.bin] ?? 0) + 1;
    if (d.isGood) finalGood++;
  }

  const xs = finalDies.map((d) => d.x);
  const ys = finalDies.map((d) => d.y);
  const rowMin = ys.length ? Math.min(...ys) : 0;
  const colMin = xs.length ? Math.min(...xs) : 0;
  const rowCount = ys.length ? Math.max(...ys) - rowMin + 1 : 0;
  const colCount = xs.length ? Math.max(...xs) - colMin + 1 : 0;

  return { finalDies, possibleDie, finalBinCounts, finalGood, rowMin, colMin, rowCount, colCount };
}

/** Per-pass results, including interrupt-pair detection and pre/post merge bookkeeping. */
function buildPassResults(
  allPasses: ReturnType<typeof findAllSmWaferPasses>,
  goodBins: Set<number>,
  notchAngle: number
): PassResult[] {
  const seenPassIds = new Set<string>();
  const passResults: PassResult[] = [];

  for (const pi of allPasses) {
    const key = `${pi.passId}:${pi.session}:${pi.passType}`;

    // Detect interruption pair (same passId, multiple blocks)
    const sameId = allPasses.filter((p) => p.passId === pi.passId && p.passType === "TEST");
    const wasInterrupted = sameId.length > 1 && pi.passType === "TEST";
    const mergedPrePost = wasInterrupted && !seenPassIds.has(pi.passId);

    if (mergedPrePost) seenPassIds.add(pi.passId);
    if (seenPassIds.has(key)) continue;
    seenPassIds.add(key);

    const dies = buildDieMapForSmWaferPass(pi.block, goodBins);
    const binCounts: Record<number, number> = {};
    let pgood = 0;
    for (const d of dies) {
      binCounts[d.bin] = (binCounts[d.bin] ?? 0) + 1;
      if (d.isGood) pgood++;
    }

    const stiRaw = pi.block.key("STTI") ?? pi.block.key("START_TIME") ?? "";
    const etiRaw = pi.block.key("ENTI") ?? pi.block.key("END_TIME") ?? "";
    const startTime = parseInfTime(stiRaw);
    const endTime = parseInfTime(etiRaw);
    const durationSeconds = timeDiffSeconds(startTime, endTime);

    const pc = pi.block.key("PROBE_CARD") ?? pi.block.key("PROBE_CARD_ID") ?? "";
    const siteSet = new Set(dies.map((d) => d.site).filter((s): s is number => s !== null));
    const mdmgPass = pi.block.block("MdMg");
    const dw = parseFloat(mdmgPass?.key("dDieWidth") ?? "");
    const dh = parseFloat(mdmgPass?.key("dDieHeight") ?? "");

    passResults.push({
      passId: pi.passId,
      session: pi.session,
      passType: pi.passType,
      passResult: pi.passResult,
      wasInterrupted,
      mergedPrePost,
      startTime,
      endTime,
      durationSeconds,
      probeCard: pc,
      totalDie: dies.length,
      goodDie: pgood,
      yield: dies.length > 0 ? pgood / dies.length : 0,
      siteCount: siteSet.size,
      binCounts,
      dieWidth: isNaN(dw) ? null : dw,
      dieHeight: isNaN(dh) ? null : dh,
      notchAngle,
    });
  }

  return passResults;
}

/** Overall start/end/duration across all SmWaferPass blocks. */
function computeOverallTiming(allPasses: ReturnType<typeof findAllSmWaferPasses>): {
  startTime: string;
  endTime: string;
  totalDurationSeconds: number;
} {
  const allTimes = allPasses
    .flatMap((p) => [
      parseInfTime(p.block.key("STTI") ?? p.block.key("START_TIME") ?? ""),
      parseInfTime(p.block.key("ENTI") ?? p.block.key("END_TIME") ?? ""),
    ])
    .filter(Boolean);
  const startTime = allTimes[0] ?? "";
  const endTime = allTimes[allTimes.length - 1] ?? "";
  return { startTime, endTime, totalDurationSeconds: timeDiffSeconds(startTime, endTime) };
}

/** Complete wafer analysis — mirrors WaferYieldCalculator.Calculate(). */
export function calculateWafer(root: InfBlock): WaferResult {
  const identity = extractWaferIdentity(root);

  // --- Good bins ---
  const psbn = findPsbn(root);
  const goodBins = psbn ? decodePsbn(psbn) : new Set([1]);

  // --- Geometry ---
  const { dieAspect, notchAngle } = readDieGeometry(root);

  // --- Final die map ---
  const { finalDies, possibleDie, finalBinCounts, finalGood, rowMin, colMin, rowCount, colCount } =
    computeFinalDieStats(root, goodBins);

  // --- Per-pass results ---
  const allPasses = findAllSmWaferPasses(root);
  const passResults = buildPassResults(allPasses, goodBins, notchAngle);

  // --- Timing ---
  const timing = computeOverallTiming(allPasses);

  return {
    ...identity,
    goodBins: [...goodBins].sort((a, b) => a - b),
    final: {
      totalDie: finalDies.length,
      goodDie: finalGood,
      possibleDie,
      yield: finalDies.length > 0 ? finalGood / finalDies.length : 0,
      rowCount,
      colCount,
      rowMin,
      colMin,
      binCounts: finalBinCounts,
    },
    timing,
    passes: passResults,
    dieAspect,
    notchAngle,
  };
}

// ── Site stats ─────────────────────────────────────────────────────────────

export type SiteStatRow = {
  siteId: number;
  rowSite: number | null;
  colSite: number | null;
  totalDie: number;
  goodDie: number;
  badDie: number;
  yield: number;
};

/** Compute per-site statistics from a die list (site = iTestSiteLast / iTestSite). */
export function computeSiteStats(dies: DieEntry[], goodBins: Set<number>): SiteStatRow[] {
  const map = new Map<number, { total: number; good: number }>();
  for (const d of dies) {
    if (d.site == null) continue;
    const s = map.get(d.site) ?? { total: 0, good: 0 };
    s.total++;
    if (d.isGood) s.good++;
    map.set(d.site, s);
  }
  return [...map.entries()]
    .map(([siteId, { total, good }]) => ({
      siteId,
      rowSite: null,
      colSite: null,
      totalDie: total,
      goodDie: good,
      badDie: total - good,
      yield: total > 0 ? good / total : 0,
    }))
    .sort((a, b) => a.siteId - b.siteId);
}

// ── Lot stats ──────────────────────────────────────────────────────────────

export type LotStats = {
  lotId: string;
  waferCount: number;
  avgYield: number;
  minYield: number;
  maxYield: number;
  stdDev: number;
  worstWafer: string;
  bestWafer: string;
};

export function computeLotStats(results: { waferId: string; finalYield: number }[]): LotStats {
  if (results.length === 0) {
    return { lotId: "", waferCount: 0, avgYield: 0, minYield: 0, maxYield: 0, stdDev: 0, worstWafer: "", bestWafer: "" };
  }
  const yields = results.map((r) => r.finalYield);
  const avg = yields.reduce((s, y) => s + y, 0) / yields.length;
  const min = Math.min(...yields);
  const max = Math.max(...yields);
  const variance = yields.reduce((s, y) => s + (y - avg) ** 2, 0) / yields.length;
  const stdDev = Math.sqrt(variance);
  const worstWafer = results.find((r) => r.finalYield === min)?.waferId ?? "";
  const bestWafer = results.find((r) => r.finalYield === max)?.waferId ?? "";
  return { lotId: "", waferCount: results.length, avgYield: avg, minYield: min, maxYield: max, stdDev, worstWafer, bestWafer };
}

// ── Utilities ──────────────────────────────────────────────────────────────

/** Manhattan distance between two die coordinates. */
export function manhattan(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/** Euclidean distance. */
export function euclidean(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

/** Generate a simple ASCII wafer map string array. */
export function buildAsciiMap(
  dies: DieEntry[],
  possibleCoords?: Array<{ x: number; y: number }>,
  focusBin?: number
): string[] {
  if (dies.length === 0) return [];
  const xs = dies.map((d) => d.x);
  const ys = dies.map((d) => d.y);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);

  const testedMap = new Map<string, DieEntry>();
  for (const d of dies) testedMap.set(`${d.x},${d.y}`, d);

  const possibleSet = new Set(possibleCoords?.map((c) => `${c.x},${c.y}`) ?? []);

  const rows: string[] = [];
  for (let y = yMin; y <= yMax; y++) {
    let row = "";
    for (let x = xMin; x <= xMax; x++) {
      const key = `${x},${y}`;
      const d = testedMap.get(key);
      if (d) {
        if (focusBin != null) row += d.bin === focusBin ? "B" : d.isGood ? "." : "X";
        else row += d.isGood ? "." : "X";
      } else if (possibleSet.has(key)) {
        row += "U";
      } else {
        row += " ";
      }
    }
    rows.push(row);
  }
  return rows;
}
