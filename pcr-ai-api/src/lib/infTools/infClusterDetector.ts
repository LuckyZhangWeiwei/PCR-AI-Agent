/**
 * BFS-based bad die cluster detection.
 * Port of ClusterDetector.cs from WaferMind.Tools.Inf.
 */

import type { DieEntry } from "../infWaferMap.js";
import { euclidean } from "../infWaferMap.js";

export type ClusterResult = {
  clusterId: number;
  centerX: number;
  centerY: number;
  radius: number;
  badDieCount: number;
  totalDieInArea: number;
  localYield: number;
  dies?: Array<{ x: number; y: number; bin: number }>;
};

/**
 * Detect clusters of bad dies using BFS with Manhattan distance adjacency.
 *
 * @param allDies         Full die list (good + bad)
 * @param minClusterSize  Minimum bad dies to form a cluster
 * @param maxGap          Max Manhattan distance between adjacent bad dies
 * @param maxClusters     Return top N clusters by size
 * @param includeDies     Include die coordinate list per cluster
 */
export function detectClusters(
  allDies: DieEntry[],
  minClusterSize: number,
  maxGap: number,
  maxClusters: number,
  includeDies: boolean
): ClusterResult[] {
  const badDies = allDies.filter((d) => !d.isGood);
  if (badDies.length === 0) return [];

  // Index all dies by coordinate for quick lookup
  const allDieMap = new Map<string, DieEntry>();
  for (const d of allDies) allDieMap.set(`${d.x},${d.y}`, d);

  // BFS
  const visited = new Set<string>();
  const rawClusters: DieEntry[][] = [];

  for (const startDie of badDies) {
    const key = `${startDie.x},${startDie.y}`;
    if (visited.has(key)) continue;

    const cluster: DieEntry[] = [];
    const queue: DieEntry[] = [startDie];
    visited.add(key);

    while (queue.length > 0) {
      const cur = queue.shift()!;
      cluster.push(cur);

      // Find bad neighbours within maxGap Manhattan distance
      for (const candidate of badDies) {
        const ck = `${candidate.x},${candidate.y}`;
        if (visited.has(ck)) continue;
        const dist = Math.abs(candidate.x - cur.x) + Math.abs(candidate.y - cur.y);
        if (dist <= maxGap) {
          visited.add(ck);
          queue.push(candidate);
        }
      }
    }

    if (cluster.length >= minClusterSize) rawClusters.push(cluster);
  }

  // Sort by size descending
  rawClusters.sort((a, b) => b.length - a.length);
  const topClusters = rawClusters.slice(0, maxClusters);

  return topClusters.map((cluster, idx) => {
    const cx = cluster.reduce((s, d) => s + d.x, 0) / cluster.length;
    const cy = cluster.reduce((s, d) => s + d.y, 0) / cluster.length;
    const radius = Math.max(...cluster.map((d) => euclidean(d, { x: cx, y: cy })));

    // Count all dies in the area (within radius + maxGap)
    const searchRadius = radius + maxGap;
    const areaCenter = { x: cx, y: cy };
    let areaTotal = 0, areaGood = 0;
    for (const d of allDies) {
      if (euclidean(d, areaCenter) <= searchRadius) {
        areaTotal++;
        if (d.isGood) areaGood++;
      }
    }

    return {
      clusterId: idx + 1,
      centerX: Math.round(cx * 10) / 10,
      centerY: Math.round(cy * 10) / 10,
      radius: Math.round(radius * 10) / 10,
      badDieCount: cluster.length,
      totalDieInArea: areaTotal,
      localYield: areaTotal > 0 ? areaGood / areaTotal : 0,
      ...(includeDies
        ? { dies: cluster.map((d) => ({ x: d.x, y: d.y, bin: d.bin })) }
        : {}),
    };
  });
}

// ── PCA shape analysis (for inf_cluster_shape) ────────────────────────────

export type ClusterShape = ClusterResult & {
  shape: "scratch" | "particle";
  aspectRatio: number;
  angleDeg: number;
};

/**
 * Run PCA on cluster die coordinates to classify shape:
 * aspect_ratio = λ₁ / λ₂ (> scratchThreshold → "scratch", otherwise "particle")
 */
export function classifyClusterShapes(
  clusters: ClusterResult[],
  scratchThreshold: number
): ClusterShape[] {
  return clusters.map((c) => {
    if (!c.dies || c.dies.length < 3) {
      return { ...c, shape: "particle" as const, aspectRatio: 1, angleDeg: 0 };
    }

    const xs = c.dies.map((d) => d.x);
    const ys = c.dies.map((d) => d.y);
    const n = xs.length;
    const mx = xs.reduce((s, v) => s + v, 0) / n;
    const my = ys.reduce((s, v) => s + v, 0) / n;

    // Covariance matrix
    let cxx = 0, cxy = 0, cyy = 0;
    for (let i = 0; i < n; i++) {
      const dx = xs[i]! - mx;
      const dy = ys[i]! - my;
      cxx += dx * dx;
      cxy += dx * dy;
      cyy += dy * dy;
    }
    cxx /= n; cxy /= n; cyy /= n;

    // Eigenvalues of 2x2 symmetric matrix
    const trace = cxx + cyy;
    const det = cxx * cyy - cxy * cxy;
    const discriminant = Math.max(0, (trace / 2) ** 2 - det);
    const sqrtDisc = Math.sqrt(discriminant);
    const lambda1 = trace / 2 + sqrtDisc;
    const lambda2 = trace / 2 - sqrtDisc;

    const aspectRatio = lambda2 > 1e-9 ? lambda1 / lambda2 : lambda1 > 1e-9 ? 99 : 1;
    const angleDeg = (Math.atan2(cxy, lambda1 - cyy) * 180) / Math.PI;

    return {
      ...c,
      shape: aspectRatio > scratchThreshold ? "scratch" : "particle",
      aspectRatio: Math.round(aspectRatio * 100) / 100,
      angleDeg: Math.round(angleDeg * 10) / 10,
    };
  });
}
