/**
 * Spatial-analysis single-wafer inf_* tools: bin migration between passes,
 * die stability across passes, edge-vs-inner yield, bin spatial distribution,
 * temperature comparison, and bad-die cluster detection/shape classification.
 */

import {
  findAllSmWaferPasses,
  buildDieMapForSmWaferPass,
} from "../../infWaferMap/infWaferMapGeometry.js";
import { getDiesForPassId } from "../../infWaferMap/infWaferMapPassSpecs.js";
import { buildAsciiMap } from "../../infWaferMap/infWaferMapCalculate.js";
import { detectClusters, classifyClusterShapes } from "../infClusterDetector.js";
import {
  loadInfWafer,
  resolvePassId,
  r4,
  truncResult,
  argStr,
  argInt,
  argBool,
  argFloat,
  argIntArray,
} from "../infToolCore.js";

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
