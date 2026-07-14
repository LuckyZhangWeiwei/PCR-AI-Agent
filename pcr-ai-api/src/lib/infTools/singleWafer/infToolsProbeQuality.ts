/**
 * Probe-quality single-wafer inf_* tools: touch-count (contact) analysis,
 * per-bin yield loss breakdown, and untested-die detection.
 */

import { buildDieMapForFinalFlow, readPossibleDieCoords } from "../../infWaferMap/infWaferMapGeometry.js";
import { getDiesForPassId } from "../../infWaferMap/infWaferMapPassSpecs.js";
import { buildAsciiMap } from "../../infWaferMap/infWaferMapCalculate.js";
import {
  loadInfWafer,
  resolvePassId,
  r4,
  truncResult,
  argInt,
  argBool,
} from "../infToolCore.js";

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
