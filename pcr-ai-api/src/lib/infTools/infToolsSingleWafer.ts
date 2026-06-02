/**
 * 16 single-wafer inf_* tool implementations.
 * Each function takes (args, device, lot, slot) and returns a result string.
 */

import {
  getDiesForPassId,
  findAllSmWaferPasses,
  findSmWaferPassesForId,
  buildDieMapForSmWaferPass,
  buildDieMapForFinalFlow,
  computeSiteStats,
  buildAsciiMap,
  readPossibleDieCoords,
  countPossibleDie,
  type DieEntry,
} from "../infWaferMap.js";
import { generateWaferMapHtml, type WaferMapPass } from "../infWaferMapHtml.js";
import { detectClusters, classifyClusterShapes } from "./infClusterDetector.js";
import {
  loadInfWafer,
  buildWaferMapFilename,
  saveWaferMapHtml,
  waferMapUrlPath,
  resolvePassId,
  pct,
  r4,
  truncResult,
  topBadBinsSummary,
  argStr,
  argInt,
  argBool,
  argFloat,
  argIntArray,
  type InfWaferCtx,
} from "./infToolCore.js";

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

// ── 7. inf_bin_migration ──────────────────────────────────────────────────

export async function runBinMigration(
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
  const goodBins = ctx.goodBins;

  let compared = 0, notRetested = 0, recovered = 0, degraded = 0, stableGood = 0, stableBad = 0;
  const matrix: Record<number, Record<number, number>> = {};
  const badBinCounts: Record<number, { total: number; recovered: number }> = {};

  for (const db of diesBefore) {
    const da = afterMap.get(`${db.x},${db.y}`);
    if (!da) { notRetested++; continue; }
    compared++;
    const entry = (matrix[db.bin] ??= {});
    entry[da.bin] = (entry[da.bin] ?? 0) + 1;

    if (!db.isGood) {
      const bc = (badBinCounts[db.bin] ??= { total: 0, recovered: 0 });
      bc.total++;
      if (da.isGood) { recovered++; bc.recovered++; }
      else stableBad++;
    } else {
      if (!da.isGood) degraded++;
      else stableGood++;
    }
  }

  const topRecoverable = Object.entries(badBinCounts)
    .map(([b, { total, recovered: rec }]) => ({
      bin_before: Number(b), total_in_before: total, recovered_count: rec,
      recovery_rate: r4(total > 0 ? rec / total : 0),
    }))
    .filter((x) => x.recovered_count > 0)
    .sort((a, b) => b.recovered_count - a.recovered_count)
    .slice(0, 10);

  return truncResult({
    pass_before: { pass_id: passBefore, total_die: diesBefore.length },
    pass_after: { pass_id: passAfter, total_die: diesAfter.length },
    summary: { compared, not_retested: notRetested, recovered, degraded, stable_good: stableGood, stable_bad: stableBad },
    top_recoverable: topRecoverable,
    migration_matrix: matrix,
  });
}

// ── 8. inf_unstable_dies ──────────────────────────────────────────────────

export async function runUnstableDies(
  args: Record<string, unknown>,
  device: string, lot: string, slot: number
): Promise<string> {
  const ctx = await loadInfWafer(device, lot, slot);
  const minFlips = argInt(args, "min_flips", 1);
  const allPasses = findAllSmWaferPasses(ctx.root);
  const goodBins = ctx.goodBins;

  // Track per-die pass sequence
  const dieHistory = new Map<string, Array<{ passId: string; bin: number; good: boolean }>>();
  for (const pi of allPasses) {
    const dies = buildDieMapForSmWaferPass(pi.block, goodBins);
    for (const d of dies) {
      const key = `${d.x},${d.y}`;
      const h = dieHistory.get(key) ?? [];
      h.push({ passId: pi.passId, bin: d.bin, good: d.isGood });
      dieHistory.set(key, h);
    }
  }

  const unstable: Array<{
    x: number; y: number; flip_count: number; final_good: boolean;
    pass_sequence: Array<{ pass_id: string; bin: number; good: boolean }>;
  }> = [];

  for (const [key, seq] of dieHistory) {
    let flips = 0;
    for (let i = 1; i < seq.length; i++) {
      if (seq[i]!.good !== seq[i - 1]!.good) flips++;
    }
    if (flips < minFlips) continue;
    const [xs, ys] = key.split(",");
    unstable.push({
      x: Number(xs), y: Number(ys),
      flip_count: flips,
      final_good: seq[seq.length - 1]!.good,
      pass_sequence: seq.map((s) => ({ pass_id: s.passId, bin: s.bin, good: s.good })),
    });
  }

  unstable.sort((a, b) => b.flip_count - a.flip_count || (b.final_good ? 1 : -1));
  const riskyCount = unstable.filter((d) => d.final_good).length;

  return truncResult({
    total_dies_seen: dieHistory.size,
    unstable_count: unstable.length,
    risky_count: riskyCount,
    min_flips_threshold: minFlips,
    dies: unstable.slice(0, 200),
  });
}

// ── 9. inf_edge_analysis ──────────────────────────────────────────────────

export async function runEdgeAnalysis(
  args: Record<string, unknown>,
  device: string, lot: string, slot: number
): Promise<string> {
  const ctx = await loadInfWafer(device, lot, slot);
  const passIdStr = resolvePassId(args, "final");
  const edgeRings = argInt(args, "edge_rings", 2);

  const dies = getDiesForPassId(ctx.root, ctx.goodBins, passIdStr);
  if (dies.length === 0) return truncResult({ error: "No dies for pass: " + passIdStr });

  const cx = dies.reduce((s, d) => s + d.x, 0) / dies.length;
  const cy = dies.reduce((s, d) => s + d.y, 0) / dies.length;
  const maxR = Math.max(...dies.map((d) => Math.sqrt((d.x - cx) ** 2 + (d.y - cy) ** 2)));

  // Edge = dies within edgeRings rings from edge
  const perRing: Array<{ ring: number; total_die: number; good_die: number; bad_die: number; yield: number; bad_ratio: number }> = [];
  for (let ring = 1; ring <= edgeRings; ring++) {
    const ringDies = dies.filter((d) => {
      const dist = Math.sqrt((d.x - cx) ** 2 + (d.y - cy) ** 2);
      return dist >= maxR - ring && dist <= maxR;
    });
    const good = ringDies.filter((d) => d.isGood).length;
    perRing.push({
      ring, total_die: ringDies.length, good_die: good,
      bad_die: ringDies.length - good,
      yield: ringDies.length > 0 ? r4(good / ringDies.length) : 0,
      bad_ratio: ringDies.length > 0 ? r4((ringDies.length - good) / ringDies.length) : 0,
    });
  }

  const edgeDies = dies.filter((d) => {
    const dist = Math.sqrt((d.x - cx) ** 2 + (d.y - cy) ** 2);
    return dist >= maxR - edgeRings;
  });
  const innerDies = dies.filter((d) => {
    const dist = Math.sqrt((d.x - cx) ** 2 + (d.y - cy) ** 2);
    return dist < maxR - edgeRings;
  });

  const edgeGood = edgeDies.filter((d) => d.isGood).length;
  const innerGood = innerDies.filter((d) => d.isGood).length;
  const edgeYield = edgeDies.length > 0 ? edgeGood / edgeDies.length : 0;
  const innerYield = innerDies.length > 0 ? innerGood / innerDies.length : 0;

  return truncResult({
    pass_id: passIdStr,
    edge_rings: edgeRings,
    circle_approx: { center_x: r4(cx), center_y: r4(cy), radius: r4(maxR) },
    edge: { total_die: edgeDies.length, good_die: edgeGood, yield: r4(edgeYield) },
    inner: { total_die: innerDies.length, good_die: innerGood, yield: r4(innerYield) },
    delta_inner_minus_edge: r4(innerYield - edgeYield),
    per_ring: perRing,
  });
}

// ── 10. inf_bin_spatial ───────────────────────────────────────────────────

export async function runBinSpatial(
  args: Record<string, unknown>,
  device: string, lot: string, slot: number
): Promise<string> {
  const ctx = await loadInfWafer(device, lot, slot);
  const bin = argInt(args, "bin", 0);
  const passIdStr = resolvePassId(args, "final");
  const includeCoords = argBool(args, "include_coords", true);
  const maxPoints = argInt(args, "max_points", 500);

  const dies = getDiesForPassId(ctx.root, ctx.goodBins, passIdStr);
  const binDies = dies.filter((d) => d.bin === bin);
  const binRatio = dies.length > 0 ? binDies.length / dies.length : 0;

  const cx = binDies.length > 0 ? binDies.reduce((s, d) => s + d.x, 0) / binDies.length : null;
  const cy = binDies.length > 0 ? binDies.reduce((s, d) => s + d.y, 0) / binDies.length : null;

  // Nearest-neighbor avg Manhattan distance
  let nnAvg: number | null = null;
  if (binDies.length >= 2) {
    let totalMin = 0;
    for (const d of binDies) {
      let minDist = Infinity;
      for (const e of binDies) {
        if (e === d) continue;
        const dist = Math.abs(d.x - e.x) + Math.abs(d.y - e.y);
        if (dist < minDist) minDist = dist;
      }
      totalMin += minDist;
    }
    nnAvg = r4(totalMin / binDies.length);
  }

  const result: Record<string, unknown> = {
    pass_id: passIdStr,
    bin,
    total_die: dies.length,
    bin_die: binDies.length,
    bin_ratio: r4(binRatio),
    centroid: { x: cx != null ? r4(cx) : null, y: cy != null ? r4(cy) : null },
    nearest_neighbor_manhattan_avg: nnAvg,
    ascii_heatmap: buildAsciiMap(dies, [], bin),
    truncated: includeCoords && binDies.length > maxPoints,
  };

  if (includeCoords) {
    const sorted = [...binDies].sort((a, b) => a.y - b.y || a.x - b.x);
    result["points"] = sorted.slice(0, maxPoints).map((d) => ({
      x: d.x, y: d.y, bin: d.bin, good: d.isGood,
      ...(d.site != null ? { site: d.site } : {}),
    }));
  }

  return truncResult(result);
}

// ── 11. inf_temperature_compare ───────────────────────────────────────────

export async function runTemperatureCompare(
  args: Record<string, unknown>,
  device: string, lot: string, slot: number
): Promise<string> {
  const ctx = await loadInfWafer(device, lot, slot);
  const passRoom = argStr(args, "pass_room", "1");
  const passHot = argStr(args, "pass_hot", "3");
  const passCold = argStr(args, "pass_cold", "5");
  const includeCoords = argBool(args, "include_coords");
  const maxPoints = argInt(args, "max_points", 500);
  const categoryFilter = argStr(args, "category");

  const roomDies = getDiesForPassId(ctx.root, ctx.goodBins, passRoom);
  const hotDies = getDiesForPassId(ctx.root, ctx.goodBins, passHot);
  const coldDies = getDiesForPassId(ctx.root, ctx.goodBins, passCold);

  const roomMap = new Map(roomDies.map((d) => [`${d.x},${d.y}`, d]));
  const hotMap = new Map(hotDies.map((d) => [`${d.x},${d.y}`, d]));
  const coldMap = new Map(coldDies.map((d) => [`${d.x},${d.y}`, d]));

  const buckets: Record<string, Array<{ x: number; y: number; room: boolean; hot: boolean; cold: boolean }>> = {
    only_room_fail: [], only_hot_fail: [], only_cold_fail: [],
    hot_and_cold_fail: [], all_three_fail: [], all_three_good: [],
  };

  const allKeys = new Set([...roomMap.keys(), ...hotMap.keys(), ...coldMap.keys()]);
  let compared = 0;

  for (const key of allKeys) {
    const r = roomMap.get(key);
    const h = hotMap.get(key);
    const c = coldMap.get(key);
    if (!r || !h || !c) continue;
    compared++;

    const rg = r.isGood, hg = h.isGood, cg = c.isGood;
    const entry = { x: r.x, y: r.y, room: rg, hot: hg, cold: cg };

    if (!rg && hg && cg) buckets["only_room_fail"]!.push(entry);
    else if (rg && !hg && cg) buckets["only_hot_fail"]!.push(entry);
    else if (rg && hg && !cg) buckets["only_cold_fail"]!.push(entry);
    else if (rg && !hg && !cg) buckets["hot_and_cold_fail"]!.push(entry);
    else if (!rg && !hg && !cg) buckets["all_three_fail"]!.push(entry);
    else if (rg && hg && cg) buckets["all_three_good"]!.push(entry);
  }

  const summary = Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length]));
  const result: Record<string, unknown> = {
    pass_ids: { room: passRoom, hot: passHot, cold: passCold },
    compared_dies: compared,
    summary,
  };

  if (includeCoords) {
    for (const [cat, list] of Object.entries(buckets)) {
      if (categoryFilter && cat !== categoryFilter) continue;
      result[cat] = {
        count: list.length,
        truncated: list.length > maxPoints,
        dies: list.slice(0, maxPoints),
      };
    }
  }

  return truncResult(result);
}

// ── 12. inf_cluster_detect ────────────────────────────────────────────────

export async function runClusterDetect(
  args: Record<string, unknown>,
  device: string, lot: string, slot: number
): Promise<string> {
  const ctx = await loadInfWafer(device, lot, slot);
  const passIdStr = resolvePassId(args, "final");
  const badBinsOverride = argIntArray(args, "bad_bins");
  const minClusterSize = argInt(args, "min_cluster_size", 3);
  const maxGap = argInt(args, "max_gap", 2);
  const maxClusters = argInt(args, "max_clusters", 20);
  const includeDies = argBool(args, "include_dies");

  let dies = getDiesForPassId(ctx.root, ctx.goodBins, passIdStr);

  // Override good/bad if user specified bad_bins
  if (badBinsOverride.length > 0) {
    const overrideSet = new Set(badBinsOverride);
    dies = dies.map((d) => ({ ...d, isGood: !overrideSet.has(d.bin) }));
  }

  const clusters = detectClusters(dies, minClusterSize, maxGap, maxClusters, includeDies);

  return truncResult({
    pass_id: passIdStr,
    bad_bins_mode: badBinsOverride.length > 0
      ? `user_specified: [${badBinsOverride.join(",")}]`
      : "auto (PSBN)",
    total_bad_die: dies.filter((d) => !d.isGood).length,
    cluster_count: clusters.length,
    shown: clusters.length,
    min_cluster_size: minClusterSize,
    max_gap: maxGap,
    clusters: clusters.map((c) => ({
      cluster_id: c.clusterId,
      center_x: c.centerX, center_y: c.centerY,
      radius: c.radius,
      bad_die_count: c.badDieCount,
      total_die_in_area: c.totalDieInArea,
      local_yield: r4(c.localYield),
      ...(includeDies ? { dies: c.dies } : {}),
    })),
  });
}

// ── 13. inf_touch_analysis ────────────────────────────────────────────────

export async function runTouchAnalysis(
  args: Record<string, unknown>,
  device: string, lot: string, slot: number
): Promise<string> {
  const ctx = await loadInfWafer(device, lot, slot);
  const passIdStr = resolvePassId(args, "final");
  const minTouch = argInt(args, "min_touch", 2);
  const includeHighTouchDies = argBool(args, "include_high_touch_dies");
  const maxPoints = argInt(args, "max_points", 200);

  const dies = getDiesForPassId(ctx.root, ctx.goodBins, passIdStr);
  const withTouch = dies.filter((d) => d.touchCount != null);

  if (withTouch.length === 0) {
    return truncResult({
      pass_id: passIdStr,
      total_dies: dies.length,
      dies_with_touch_data: 0,
      note: "该 pass 无 nTouchCount 层数据",
    });
  }

  const touches = withTouch.map((d) => d.touchCount!);
  const maxT = Math.max(...touches);
  const avgT = r4(touches.reduce((s, v) => s + v, 0) / touches.length);

  // Group by touch count
  const byTouch = new Map<number, { good: number; bad: number }>();
  for (const d of withTouch) {
    const tc = d.touchCount!;
    const e = byTouch.get(tc) ?? { good: 0, bad: 0 };
    if (d.isGood) e.good++; else e.bad++;
    byTouch.set(tc, e);
  }

  // Group by site
  const bySite = new Map<number, number[]>();
  for (const d of withTouch) {
    if (d.site == null) continue;
    const arr = bySite.get(d.site) ?? [];
    arr.push(d.touchCount!);
    bySite.set(d.site, arr);
  }

  const highTouch = withTouch.filter((d) => d.touchCount! >= minTouch);

  const result: Record<string, unknown> = {
    pass_id: passIdStr,
    total_dies: dies.length,
    dies_with_touch_data: withTouch.length,
    max_touch: maxT,
    avg_touch: avgT,
    min_touch_threshold: minTouch,
    high_touch_count: highTouch.length,
    by_touch_count: [...byTouch.entries()].sort((a, b) => a[0] - b[0]).map(([tc, { good, bad }]) => ({
      touch_count: tc, die_count: good + bad, good_count: good, bad_count: bad,
      yield: r4((good + bad) > 0 ? good / (good + bad) : 0),
    })),
    site_stats: [...bySite.entries()].map(([site, arr]) => ({
      site, die_count: arr.length,
      avg_touch: r4(arr.reduce((s, v) => s + v, 0) / arr.length),
      max_touch: Math.max(...arr),
    })).sort((a, b) => b.avg_touch - a.avg_touch),
    high_touch_truncated: highTouch.length > maxPoints,
  };

  if (includeHighTouchDies) {
    result["high_touch_dies"] = highTouch
      .sort((a, b) => b.touchCount! - a.touchCount!)
      .slice(0, maxPoints)
      .map((d) => ({ x: d.x, y: d.y, bin: d.bin, site: d.site, touch_count: d.touchCount }));
  }

  return truncResult(result);
}

// ── 14. inf_yield_loss_breakdown ──────────────────────────────────────────

export async function runYieldLossBreakdown(
  args: Record<string, unknown>,
  device: string, lot: string, slot: number
): Promise<string> {
  const ctx = await loadInfWafer(device, lot, slot);
  const passIdStr = resolvePassId(args, "final");
  const dies = getDiesForPassId(ctx.root, ctx.goodBins, passIdStr);

  const totalDie = dies.length;
  const goodDie = dies.filter((d) => d.isGood).length;
  const badDie = totalDie - goodDie;

  const binCounts: Record<number, number> = {};
  for (const d of dies) {
    if (!d.isGood) binCounts[d.bin] = (binCounts[d.bin] ?? 0) + 1;
  }

  const breakdown = Object.entries(binCounts)
    .map(([b, count]) => ({
      bin: Number(b),
      die_count: count,
      pct_of_total: r4(totalDie > 0 ? count / totalDie : 0),
      pct_of_bad: r4(badDie > 0 ? count / badDie : 0),
    }))
    .sort((a, b) => b.die_count - a.die_count);

  return truncResult({
    pass_id: passIdStr,
    total_die: totalDie, good_die: goodDie, bad_die: badDie,
    yield: r4(totalDie > 0 ? goodDie / totalDie : 0),
    breakdown,
  });
}

// ── 15. inf_partial_probe ─────────────────────────────────────────────────

export async function runPartialProbe(
  args: Record<string, unknown>,
  device: string, lot: string, slot: number
): Promise<string> {
  const ctx = await loadInfWafer(device, lot, slot);
  const includeCoords = argBool(args, "include_coords");
  const asciiMap = argBool(args, "ascii_map");

  const possibleCoords = readPossibleDieCoords(ctx.root);
  const finalDies = buildDieMapForFinalFlow(ctx.root, ctx.goodBins);
  const testedSet = new Set(finalDies.map((d) => `${d.x},${d.y}`));

  const untestedCoords = possibleCoords.filter((c) => !testedSet.has(`${c.x},${c.y}`));
  const possibleDie = possibleCoords.length;
  const testedDie = finalDies.length;
  const untestedCount = untestedCoords.length;

  const result: Record<string, unknown> = {
    possible_die: possibleDie,
    tested_die: testedDie,
    untested_count: untestedCount,
    untested_pct: r4(possibleDie > 0 ? untestedCount / possibleDie : 0),
  };

  if (includeCoords) result["untested_coords"] = untestedCoords.slice(0, 1000);
  if (asciiMap) result["ascii_map"] = buildAsciiMap(finalDies, untestedCoords);

  return truncResult(result);
}

// ── 16. inf_draw_wafer_map ────────────────────────────────────────────────

export async function runDrawWaferMap(
  args: Record<string, unknown>,
  device: string, lot: string, slot: number
): Promise<string> {
  const ctx = await loadInfWafer(device, lot, slot);
  const passesArg = argStr(args, "passes", "final");
  const highlight = argStr(args, "highlight");

  const passIdList = passesArg === "all"
    ? [...new Set(findAllSmWaferPasses(ctx.root).map((p) => p.passId)), "final"]
    : passesArg.split(",").map((s) => s.trim()).filter(Boolean);

  const passes: WaferMapPass[] = [];
  for (const pid of passIdList) {
    const dies = getDiesForPassId(ctx.root, ctx.goodBins, pid);
    if (dies.length > 0) {
      const label = pid === "final" ? "最终 (final)" : `Pass ${pid}`;
      passes.push({ label, dies });
    }
  }

  if (passes.length === 0) return `未找到任何 die 数据（passes=${passesArg}）`;

  const possibleDies = readPossibleDieCoords(ctx.root);
  const { waferResult: r } = ctx;
  const html = generateWaferMapHtml(
    `${device} / ${lot} / Slot ${slot}`,
    passes,
    possibleDies,
    r.dieAspect,
    r.notchAngle,
    ctx.goodBins,
    highlight
  );

  const filename = buildWaferMapFilename(device, lot, slot);
  saveWaferMapHtml(filename, html);
  const urlPath = waferMapUrlPath(filename);

  const finalPass = passes[0]!;
  const goodCount = finalPass.dies.filter((d) => d.isGood).length;
  const yieldPct = finalPass.dies.length > 0 ? (goodCount / finalPass.dies.length * 100).toFixed(2) : "0.00";
  const topBad = topBadBinsSummary(r.final.binCounts, ctx.goodBins);

  return [
    `晶圆图已生成，访问地址：${urlPath}`,
    `Lot: ${r.lot}  Wafer: ${r.waferId}  Slot: ${slot}`,
    `总 die: ${finalPass.dies.length}  良品: ${goodCount}  良率: ${yieldPct}%`,
    `坏 bin top: ${topBad}`,
    `Pass 数: ${passes.length}（${passes.map((p) => p.label).join(", ")}）`,
  ].join("\n");
}

// ── 17. inf_cluster_shape ─────────────────────────────────────────────────

export async function runClusterShape(
  args: Record<string, unknown>,
  device: string, lot: string, slot: number
): Promise<string> {
  const ctx = await loadInfWafer(device, lot, slot);
  const passIdStr = resolvePassId(args, "final");
  const minClusterSize = argInt(args, "min_cluster_size", 3);
  const maxGap = argInt(args, "max_gap", 2);
  const scratchThreshold = argFloat(args, "scratch_threshold", 3.0);
  const maxClusters = argInt(args, "max_clusters", 20);

  const dies = getDiesForPassId(ctx.root, ctx.goodBins, passIdStr);
  const clusters = detectClusters(dies, minClusterSize, maxGap, maxClusters, true);
  const shapes = classifyClusterShapes(clusters, scratchThreshold);

  const scratchCount = shapes.filter((s) => s.shape === "scratch").length;

  return truncResult({
    pass_id: passIdStr,
    scratch_threshold: scratchThreshold,
    min_cluster_size: minClusterSize,
    max_gap: maxGap,
    cluster_count: shapes.length,
    shown: shapes.length,
    scratch_count: scratchCount,
    particle_count: shapes.length - scratchCount,
    clusters: shapes.map((s) => ({
      cluster_id: s.clusterId,
      shape: s.shape,
      aspect_ratio: s.aspectRatio,
      angle_deg: s.angleDeg,
      die_count: s.badDieCount,
      center_x: s.centerX,
      center_y: s.centerY,
    })),
  });
}
