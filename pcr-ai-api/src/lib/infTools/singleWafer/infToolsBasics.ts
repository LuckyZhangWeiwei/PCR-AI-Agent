/**
 * Basic single-wafer inf_* tools: parse, die map, site stats, one-click
 * analysis, pass listing, and pass-to-pass comparison.
 */

import { buildDieMapForFinalFlow } from "../../infWaferMap/infWaferMapGeometry.js";
import { getDiesForPassId } from "../../infWaferMap/infWaferMapPassSpecs.js";
import { computeSiteStats, buildAsciiMap } from "../../infWaferMap/infWaferMapCalculate.js";
import {
  loadInfWafer,
  resolvePassId,
  pct,
  r4,
  truncResult,
  topBadBinsSummary,
  argStr,
  argBool,
} from "../infToolCore.js";

// ── 1. inf_parse_wafer ─────────────────────────────────────────────────────

export async function runParseWafer(
  args: Record<string, unknown>,
  device: string, lot: string, slot: number
): Promise<string> {
  const ctx = await loadInfWafer(device, lot, slot);
  const { waferResult: r, goodBins } = ctx;

  const result = {
    lot: r.lot, waferId: r.waferId, slot: r.slot,
    cassette: r.cassette, wptId: r.wptId,
    rotation: r.rotation,
    good_bins: r.goodBins,
    final: {
      total_die: r.final.totalDie,
      good_die: r.final.goodDie,
      possible_die: r.final.possibleDie,
      yield: r4(r.final.yield),
      row_count: r.final.rowCount, col_count: r.final.colCount,
      row_min: r.final.rowMin, col_min: r.final.colMin,
      bin_counts: r.final.binCounts,
    },
    timing: r.timing,
    passes: r.passes.map((p) => ({
      pass_id: p.passId, session: p.session,
      type: p.passType, status: p.passResult,
      was_interrupted: p.wasInterrupted,
      merged_pre_post: p.mergedPrePost,
      start_time: p.startTime, end_time: p.endTime,
      duration_seconds: p.durationSeconds,
      probe_card: p.probeCard,
      total_die: p.totalDie, good_die: p.goodDie,
      yield: r4(p.yield),
      site_count: p.siteCount,
      bin_counts: p.binCounts,
    })),
  };
  return truncResult(result);
}

// ── 2. inf_get_die_map ─────────────────────────────────────────────────────

export async function runGetDieMap(
  args: Record<string, unknown>,
  device: string, lot: string, slot: number
): Promise<string> {
  const ctx = await loadInfWafer(device, lot, slot);
  const passIdStr = resolvePassId(args, "final");
  const includeDies = argBool(args, "include_dies");
  const asciiMap = argBool(args, "ascii_map");
  const badOnly = argBool(args, "bad_only");

  const dies = getDiesForPassId(ctx.root, ctx.goodBins, passIdStr);
  const goodCount = dies.filter((d) => d.isGood).length;
  const badCount = dies.length - goodCount;

  const result: Record<string, unknown> = {
    pass_id: passIdStr,
    total_die: dies.length,
    good_die: goodCount,
    bad_die: badCount,
    yield: r4(dies.length > 0 ? goodCount / dies.length : 0),
  };

  if (asciiMap) {
    result["ascii_map"] = buildAsciiMap(dies);
  }

  if (includeDies) {
    const list = badOnly ? dies.filter((d) => !d.isGood) : dies;
    result["dies"] = list.map((d) => ({
      x: d.x, y: d.y, bin: d.bin, good: d.isGood,
      ...(d.site != null ? { site: d.site } : {}),
      ...(d.touchCount != null ? { touch_count: d.touchCount } : {}),
    }));
    if (badOnly) result["bad_only"] = true;
  }

  return truncResult(result);
}

// ── 3. inf_site_stats ─────────────────────────────────────────────────────

export async function runSiteStats(
  args: Record<string, unknown>,
  device: string, lot: string, slot: number
): Promise<string> {
  const ctx = await loadInfWafer(device, lot, slot);
  const dies = buildDieMapForFinalFlow(ctx.root, ctx.goodBins);
  const sites = computeSiteStats(dies, ctx.goodBins);

  if (sites.length === 0) {
    const goodCount = dies.filter((d) => d.isGood).length;
    return truncResult({
      single_site: true,
      total_die: dies.length,
      good_die: goodCount,
      yield: r4(dies.length > 0 ? goodCount / dies.length : 0),
      note: "INF 文件无 iTestSiteLast 层，无法区分各 DUT 统计",
    });
  }

  const yields = sites.map((s) => s.yield);
  const minY = Math.min(...yields), maxY = Math.max(...yields);

  const result: Record<string, unknown> = {
    site_count: sites.length,
    overall_yield: r4(dies.length > 0 ? dies.filter((d) => d.isGood).length / dies.length : 0),
    yield_range: { min: r4(minY), max: r4(maxY), spread: r4(maxY - minY) },
    sites: sites.map((s) => ({
      site_id: s.siteId,
      total_die: s.totalDie,
      good_die: s.goodDie,
      bad_die: s.badDie,
      yield: r4(s.yield),
    })),
  };
  return truncResult(result);
}

// ── 4. inf_analyze_wafer ──────────────────────────────────────────────────

export async function runAnalyzeWafer(
  args: Record<string, unknown>,
  device: string, lot: string, slot: number
): Promise<string> {
  const ctx = await loadInfWafer(device, lot, slot);
  const { waferResult: r, goodBins } = ctx;
  const dies = buildDieMapForFinalFlow(ctx.root, goodBins);
  const sites = computeSiteStats(dies, goodBins);

  const yields = sites.map((s) => s.yield);
  const siteSpread = yields.length > 1 ? Math.max(...yields) - Math.min(...yields) : 0;

  const diagnosis: string[] = [];
  if (r.final.yield < 0.5) diagnosis.push("最终良率严重偏低（< 50%），建议停机排查");
  else if (r.final.yield < 0.75) diagnosis.push("最终良率偏低（< 75%），需关注坏 bin 分布");
  if (siteSpread > 0.1) diagnosis.push(`探针卡 DUT 良率差异显著（spread=${pct(siteSpread)}），疑似某 DUT 接触异常`);
  else if (siteSpread > 0.05) diagnosis.push(`探针卡 DUT 良率存在中等差异（spread=${pct(siteSpread)}），建议关注`);
  if (r.passes.some((p) => p.wasInterrupted)) diagnosis.push("存在测试中断记录，建议用 inf_list_passes 查分段详情");

  const result = {
    identity: { lot: r.lot, wafer_id: r.waferId, slot: r.slot, wpt_id: r.wptId },
    final_yield: {
      total_die: r.final.totalDie,
      good_die: r.final.goodDie,
      possible_die: r.final.possibleDie,
      yield: r4(r.final.yield),
      top_bad_bins: topBadBinsSummary(r.final.binCounts, goodBins),
    },
    pass_summary: r.passes.map((p) => ({
      pass_id: p.passId,
      type: p.passType,
      status: p.passResult,
      probe_card: p.probeCard,
      total_die: p.totalDie,
      good_die: p.goodDie,
      yield: r4(p.yield),
    })),
    site_analysis: {
      site_count: sites.length,
      single_site: sites.length === 0,
      yield_spread: r4(siteSpread),
      worst_sites: sites.sort((a, b) => a.yield - b.yield).slice(0, 3).map((s) => ({
        site_id: s.siteId, yield: r4(s.yield), bad_die: s.badDie,
      })),
    },
    diagnosis,
  };
  return truncResult(result);
}

// ── 5. inf_list_passes ────────────────────────────────────────────────────

export async function runListPasses(
  args: Record<string, unknown>,
  device: string, lot: string, slot: number
): Promise<string> {
  const ctx = await loadInfWafer(device, lot, slot);
  const { waferResult: r, goodBins } = ctx;

  const result = {
    good_bins: r.goodBins,
    passes: r.passes.map((p) => ({
      pass_id: p.passId,
      session: p.session,
      type: p.passType,
      status: p.passResult,
      was_interrupted: p.wasInterrupted,
      merged_pre_post: p.mergedPrePost,
      ...(p.mergedPrePost ? {
        segment_note: `使用 pass_id="${p.passId}@pre" 查中断前，"${p.passId}@post" 查恢复后段`,
      } : {}),
      total_die: p.totalDie,
      good_die: p.goodDie,
      yield: r4(p.yield),
    })),
  };
  return truncResult(result);
}

// ── 6. inf_compare_passes ─────────────────────────────────────────────────

export async function runComparePasses(
  args: Record<string, unknown>,
  device: string, lot: string, slot: number
): Promise<string> {
  const ctx = await loadInfWafer(device, lot, slot);
  const passBefore = argStr(args, "pass_before") || argStr(args, "passBefore");
  const passAfter = argStr(args, "pass_after") || argStr(args, "passAfter");
  if (!passBefore || !passAfter) return "参数错误: 需要 pass_before 和 pass_after";

  const diesBefore = getDiesForPassId(ctx.root, ctx.goodBins, passBefore);
  const diesAfter = getDiesForPassId(ctx.root, ctx.goodBins, passAfter);

  const afterMap = new Map(diesAfter.map((d) => [`${d.x},${d.y}`, d]));
  const recovered: Array<{ x: number; y: number; bin_before: number; bin_after: number }> = [];
  const degraded: Array<{ x: number; y: number; bin_before: number; bin_after: number }> = [];
  const stableBad: Array<{ x: number; y: number; bin: number }> = [];

  for (const db of diesBefore) {
    const da = afterMap.get(`${db.x},${db.y}`);
    if (!da) continue;
    if (!db.isGood && da.isGood) recovered.push({ x: db.x, y: db.y, bin_before: db.bin, bin_after: da.bin });
    else if (db.isGood && !da.isGood) degraded.push({ x: db.x, y: db.y, bin_before: db.bin, bin_after: da.bin });
    else if (!db.isGood && !da.isGood) stableBad.push({ x: db.x, y: db.y, bin: da.bin });
  }

  return truncResult({
    pass_before: { pass_id: passBefore, total_tested: diesBefore.length },
    pass_after: { pass_id: passAfter, total_tested: diesAfter.length },
    summary: { recovered: recovered.length, degraded: degraded.length, stable_bad: stableBad.length },
    recovered_dies: recovered.slice(0, 200),
    degraded_dies: degraded.slice(0, 200),
    stable_bad_count: stableBad.length,
  });
}
