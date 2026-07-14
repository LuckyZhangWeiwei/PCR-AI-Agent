/**
 * 7 lot-level inf_* tool implementations.
 * Tools that operate over an entire lot directory (multiple INF files).
 */

import fs from "node:fs";
import path from "node:path";
import {
  buildDieMapForFinalFlow,
  readPossibleDieCoords,
  type DieEntry,
  type WaferResult,
} from "../infWaferMap/infWaferMapGeometry.js";
import { getDiesForPassId } from "../infWaferMap/infWaferMapPassSpecs.js";
import { generateWaferMapHtml, type WaferMapPass } from "../infWaferMap/html/waferMapHtml.js";
import { generateLotHeatmapHtml } from "../infWaferMap/html/lotHeatmapHtml.js";
import { generateSlotTrendHtml } from "../infWaferMap/html/slotTrendHtml.js";
import { detectClusters } from "./infClusterDetector.js";
import {
  loadLotWafers,
  buildWaferMapFilename,
  saveWaferMapHtml,
  waferMapUrlPath,
  resolvePassId,
  pct,
  r4,
  truncResult,
  argStr,
  argInt,
  argBool,
  argFloat,
  type LotWaferEntry,
} from "./infToolCore.js";
import type { InfBlock } from "../infParser.js";

// ── Shared lot-loading helper ──────────────────────────────────────────────

async function loadLot(device: string, lot: string) {
  const { entries, lotDir, errors } = await loadLotWafers(device, lot);
  const valid = entries.filter((e) => !e.error && e.root && e.waferResult);
  return { entries, valid, lotDir, errors };
}

// ── 18. inf_parse_dir ─────────────────────────────────────────────────────

export async function runParseDir(
  args: Record<string, unknown>,
  device: string, lot: string
): Promise<string> {
  const { valid, errors } = await loadLot(device, lot);
  if (valid.length === 0) return `Lot 目录无可解析 INF 文件（${errors.join("; ")}）`;

  const wafers = valid.map((e) => {
    const r = e.waferResult!;
    return {
      wafer_id: r.waferId, slot: e.slot.toString(),
      yield: r4(r.final.yield),
      total_die: r.final.totalDie,
      good_die: r.final.goodDie,
    };
  }).sort((a, b) => Number(a.slot) - Number(b.slot));

  const yields = wafers.map((w) => w.yield);
  const avg = r4(yields.reduce((s, y) => s + y, 0) / yields.length);
  const minY = Math.min(...yields), maxY = Math.max(...yields);
  const worst = wafers.find((w) => w.yield === minY)?.wafer_id ?? "";
  const best = wafers.find((w) => w.yield === maxY)?.wafer_id ?? "";

  return truncResult({
    lot_id: valid[0]!.waferResult!.lot,
    parsed_count: valid.length,
    error_count: errors.length,
    avg_yield: avg, min_yield: r4(minY), max_yield: r4(maxY),
    worst_wafer: worst, best_wafer: best,
    wafers,
    ...(errors.length > 0 ? { parse_errors: errors } : {}),
  });
}

// ── 19. inf_compare_wafers ────────────────────────────────────────────────

export async function runCompareWafers(
  args: Record<string, unknown>,
  device: string, lot: string
): Promise<string> {
  const showBins = argBool(args, "show_bins");
  const showPasses = argBool(args, "show_passes");
  const { valid, errors } = await loadLot(device, lot);
  if (valid.length === 0) return `无可解析 INF 文件`;

  const yields = valid.map((e) => e.waferResult!.final.yield);
  const avg = yields.reduce((s, y) => s + y, 0) / yields.length;
  const variance = yields.reduce((s, y) => s + (y - avg) ** 2, 0) / yields.length;
  const stdDev = Math.sqrt(variance);

  const wafers = valid
    .map((e) => {
      const r = e.waferResult!;
      const delta = r.final.yield - avg;
      return {
        wafer_id: r.waferId, slot: e.slot.toString(),
        yield: r4(r.final.yield),
        good_die: r.final.goodDie,
        total_die: r.final.totalDie,
        delta_from_avg: r4(delta),
        is_outlier: Math.abs(delta) > 2 * stdDev,
        ...(showBins ? { bins: r.final.binCounts } : {}),
        ...(showPasses ? {
          passes: r.passes.map((p) => ({
            pass_id: p.passId, type: p.passType,
            yield: r4(p.yield), good_die: p.goodDie, total_die: p.totalDie,
          }))
        } : {}),
      };
    })
    .sort((a, b) => b.yield - a.yield)
    .map((w, idx) => ({ rank: idx + 1, ...w }));

  return truncResult({
    lot_id: valid[0]!.waferResult!.lot,
    wafer_count: valid.length,
    avg_yield: r4(avg), std_dev: r4(stdDev),
    min_yield: r4(Math.min(...yields)), max_yield: r4(Math.max(...yields)),
    wafers,
    ...(errors.length > 0 ? { parse_errors: errors } : {}),
  });
}

// ── 20. inf_lot_die_compare ───────────────────────────────────────────────

export async function runLotDieCompare(
  args: Record<string, unknown>,
  device: string, lot: string
): Promise<string> {
  const passIdStr = resolvePassId(args, "final");
  const mode = argStr(args, "mode", "hotspot");
  const minBadWafers = argInt(args, "min_bad_wafers", 3);
  const qx = args["x"] != null ? Number(args["x"]) : null;
  const qy = args["y"] != null ? Number(args["y"]) : null;

  const { valid, errors } = await loadLot(device, lot);
  if (valid.length === 0) return "无可解析 INF 文件";

  // Build lot die map: (x,y) → per-wafer die info
  const lotMap = new Map<string, Array<{ waferId: string; bin: number; isGood: boolean }>>();

  for (const e of valid) {
    const dies = getDiesForPassId(e.root!, e.goodBins!, passIdStr);
    const waferId = e.waferResult!.waferId;
    for (const d of dies) {
      const key = `${d.x},${d.y}`;
      const arr = lotMap.get(key) ?? [];
      arr.push({ waferId, bin: d.bin, isGood: d.isGood });
      lotMap.set(key, arr);
    }
  }

  if (mode === "coordinate" && qx != null && qy != null) {
    const key = `${qx},${qy}`;
    const list = lotMap.get(key) ?? [];
    const badCount = list.filter((d) => !d.isGood).length;
    return truncResult({
      x: qx, y: qy, pass_id: passIdStr,
      wafer_count: valid.length,
      bad_count: badCount,
      dies: list.map((d) => ({ wafer: d.waferId, bin: d.bin, is_good: d.isGood })),
      ...(errors.length > 0 ? { parse_errors: errors } : {}),
    });
  }

  // Hotspot mode
  const hotspots: Array<{
    x: number; y: number; bad_count: number; bad_pct: number;
    bins: Record<number, number>; bad_wafers: string[];
  }> = [];

  for (const [key, waferList] of lotMap) {
    const badWafers = waferList.filter((d) => !d.isGood);
    if (badWafers.length < minBadWafers) continue;
    const [xs, ys] = key.split(",");
    const binMap: Record<number, number> = {};
    for (const d of badWafers) binMap[d.bin] = (binMap[d.bin] ?? 0) + 1;
    hotspots.push({
      x: Number(xs), y: Number(ys),
      bad_count: badWafers.length,
      bad_pct: r4(badWafers.length / valid.length),
      bins: binMap,
      bad_wafers: badWafers.map((d) => d.waferId),
    });
  }

  hotspots.sort((a, b) => b.bad_count - a.bad_count);

  return truncResult({
    pass_id: passIdStr, wafer_count: valid.length,
    hotspot_count: hotspots.length,
    hotspots: hotspots.slice(0, 50),
    ...(errors.length > 0 ? { parse_errors: errors } : {}),
  });
}

// ── 21. inf_lot_heatmap ───────────────────────────────────────────────────

export async function runLotHeatmap(
  args: Record<string, unknown>,
  device: string, lot: string
): Promise<string> {
  const passArg = argStr(args, "pass_id", "final");
  const passIds = passArg.split(",").map((s) => s.trim()).filter(Boolean);

  const { valid, errors } = await loadLot(device, lot);
  if (valid.length === 0) return "无可解析 INF 文件";

  // Reference geometry from first valid wafer
  const ref = valid[0]!;
  const refPossible = readPossibleDieCoords(ref.root!);
  const { dieAspect, notchAngle } = ref.waferResult!;

  const lotId = ref.waferResult!.lot;

  const passes = passIds.map((pid) => {
    const badFreq = new Map<string, number>();
    const allCoords = new Set<string>();

    for (const e of valid) {
      const dies = getDiesForPassId(e.root!, e.goodBins!, pid);
      for (const d of dies) {
        const key = `${d.x},${d.y}`;
        allCoords.add(key);
        if (!d.isGood) badFreq.set(key, (badFreq.get(key) ?? 0) + 1);
      }
    }

    return {
      label: pid === "final" ? "最终 (final)" : `Pass ${pid}`,
      badFreq,
      totalWafers: valid.length,
      allCoords,
    };
  });

  // Merge all coords
  const allCoords = new Set<string>();
  for (const p of passes) for (const k of p.allCoords) allCoords.add(k);

  const html = generateLotHeatmapHtml(
    `${device} / ${lot} — Lot 热力图`,
    passes.map(({ label, badFreq, totalWafers }) => ({ label, badFreq, totalWafers })),
    allCoords,
    dieAspect,
    notchAngle,
    refPossible
  );

  const filename = buildWaferMapFilename(device, lot, undefined, "_heatmap");
  saveWaferMapHtml(filename, html);
  const urlPath = waferMapUrlPath(filename);

  return [
    `**Lot 热力图已生成** → [点击在新窗口查看热力图](${urlPath})`,
    `Lot: ${lotId}  晶圆数: ${valid.length}  Pass: ${passIds.join(", ")}`,
    ...(errors.length > 0 ? [`解析失败: ${errors.length} 片`] : []),
  ].join("\n");
}

// ── 22. inf_lot_cluster_overlap ───────────────────────────────────────────

export async function runLotClusterOverlap(
  args: Record<string, unknown>,
  device: string, lot: string
): Promise<string> {
  const threshold = argInt(args, "threshold", 8);
  const minClusterSize = argInt(args, "min_cluster_size", 3);
  const maxGap = argInt(args, "max_gap", 2);

  const { valid, errors } = await loadLot(device, lot);
  if (valid.length === 0) return "无可解析 INF 文件";

  // Detect clusters per wafer for final pass
  const passIdStr = "final";
  const waferClusters: Array<{
    waferId: string;
    clusters: Array<{ centerX: number; centerY: number; badDieCount: number }>;
  }> = [];

  for (const e of valid) {
    const dies = getDiesForPassId(e.root!, e.goodBins!, passIdStr);
    const clusters = detectClusters(dies, minClusterSize, maxGap, 50, false);
    waferClusters.push({
      waferId: e.waferResult!.waferId,
      clusters: clusters.map((c) => ({ centerX: c.centerX, centerY: c.centerY, badDieCount: c.badDieCount })),
    });
  }

  // Group clusters across wafers by centroid proximity (threshold)
  type CentroidGroup = {
    groupId: number;
    waferCount: number;
    avgCenterX: number;
    avgCenterY: number;
    waferIds: string[];
  };

  const groups: CentroidGroup[] = [];

  for (const { waferId, clusters } of waferClusters) {
    for (const c of clusters) {
      // Find nearest existing group within threshold
      let nearest: CentroidGroup | null = null;
      let nearestDist = Infinity;
      for (const g of groups) {
        const dist = Math.sqrt((g.avgCenterX - c.centerX) ** 2 + (g.avgCenterY - c.centerY) ** 2);
        if (dist < nearestDist) { nearestDist = dist; nearest = g; }
      }

      if (nearest && nearestDist <= threshold) {
        // Update centroid (running average)
        const n = nearest.waferCount;
        nearest.avgCenterX = (nearest.avgCenterX * n + c.centerX) / (n + 1);
        nearest.avgCenterY = (nearest.avgCenterY * n + c.centerY) / (n + 1);
        nearest.waferCount++;
        if (!nearest.waferIds.includes(waferId)) nearest.waferIds.push(waferId);
      } else {
        groups.push({
          groupId: groups.length + 1,
          waferCount: 1,
          avgCenterX: c.centerX,
          avgCenterY: c.centerY,
          waferIds: [waferId],
        });
      }
    }
  }

  groups.sort((a, b) => b.waferCount - a.waferCount);
  const maxOverlap = groups.length > 0 ? groups[0]!.waferCount : 0;

  return truncResult({
    lot_id: valid[0]!.waferResult!.lot,
    wafer_count: valid.length,
    threshold,
    group_count: groups.length,
    max_wafer_overlap: maxOverlap,
    groups: groups.slice(0, 30).map((g) => ({
      group_id: g.groupId,
      wafer_count: g.waferCount,
      avg_center: [r4(g.avgCenterX), r4(g.avgCenterY)],
      wafer_ids: g.waferIds,
    })),
    ...(errors.length > 0 ? { parse_errors: errors } : {}),
  });
}

// ── 23. inf_slot_trend ────────────────────────────────────────────────────

export async function runSlotTrend(
  args: Record<string, unknown>,
  device: string, lot: string
): Promise<string> {
  const driftThreshold = argFloat(args, "drift_threshold", 0.02);
  const { valid, errors } = await loadLot(device, lot);
  if (valid.length === 0) return "无可解析 INF 文件";

  const wafers = valid
    .sort((a, b) => a.slot - b.slot)
    .map((e) => ({
      slot: e.slot.toString(),
      waferId: e.waferResult!.waferId,
      yield: e.waferResult!.final.yield,
    }));

  const yields = wafers.map((w) => w.yield);
  const avg = yields.reduce((s, y) => s + y, 0) / yields.length;
  const half = Math.floor(yields.length / 2);
  const firstHalfYields = yields.slice(0, half);
  const secondHalfYields = yields.slice(half);
  const firstHalfAvg = firstHalfYields.length > 0
    ? firstHalfYields.reduce((s, y) => s + y, 0) / firstHalfYields.length : 0;
  const secondHalfAvg = secondHalfYields.length > 0
    ? secondHalfYields.reduce((s, y) => s + y, 0) / secondHalfYields.length : 0;
  const driftPct = Math.abs(secondHalfAvg - firstHalfAvg);
  const hasDrift = driftPct > driftThreshold;
  const driftDirection = secondHalfAvg >= firstHalfAvg ? "improving" : "degrading";

  // Generate HTML trend chart
  const html = generateSlotTrendHtml(
    `${device} / ${lot} — Slot 良率趋势`,
    wafers,
    firstHalfAvg,
    secondHalfAvg
  );

  const filename = buildWaferMapFilename(device, lot, undefined, "_trend");
  saveWaferMapHtml(filename, html);
  const urlPath = waferMapUrlPath(filename);

  const textResult = {
    lot_id: valid[0]!.waferResult!.lot,
    wafer_count: valid.length,
    error_count: errors.length,
    avg_yield: r4(avg),
    first_half_avg: r4(firstHalfAvg),
    second_half_avg: r4(secondHalfAvg),
    drift_pct: r4(driftPct),
    has_drift: hasDrift,
    drift_direction: driftDirection,
    chart_url: `[点击在新窗口查看趋势图](${urlPath})`,
    wafers,
  };

  return [
    `**Slot 趋势图已生成** → [点击在新窗口查看趋势图](${urlPath})`,
    truncResult(textResult),
  ].join("\n");
}
