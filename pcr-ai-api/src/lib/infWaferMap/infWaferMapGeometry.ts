/**
 * Core wafer die-map construction from INF block tree.
 * Port of WaferYieldCalculator.cs + data models (DieEntry, WaferResult, PassResult).
 */

import type { InfBlock } from "../infParser.js";

// ── Data models ────────────────────────────────────────────────────────────

export type DieEntry = {
  x: number;
  y: number;
  bin: number;
  isGood: boolean;
  site: number | null;
  touchCount: number | null;
};

export type PassResult = {
  passId: string;
  session: string;
  passType: string;
  passResult: string;
  wasInterrupted: boolean;
  /** True when a TEST pass was reconstructed by merging @pre + @post segments. */
  mergedPrePost: boolean;
  startTime: string;
  endTime: string;
  durationSeconds: number;
  probeCard: string;
  totalDie: number;
  goodDie: number;
  yield: number;
  siteCount: number;
  binCounts: Record<number, number>;
  dieWidth: number | null;
  dieHeight: number | null;
  notchAngle: number;
};

export type WaferResult = {
  lot: string;
  waferId: string;
  slot: string;
  cassette: string;
  wptId: string;
  waferBatch: string;
  mesSlot: string;
  rotation: string;
  goodBins: number[];
  final: {
    totalDie: number;
    goodDie: number;
    possibleDie: number;
    yield: number;
    rowCount: number;
    colCount: number;
    rowMin: number;
    colMin: number;
    binCounts: Record<number, number>;
  };
  timing: {
    startTime: string;
    endTime: string;
    totalDurationSeconds: number;
  };
  passes: PassResult[];
  /** Die aspect ratio (dieWidth / dieHeight) from MdMg block. */
  dieAspect: number;
  /** Notch angle in degrees for SVG rendering (0=right, 90=bottom, 180=left, 270=top). */
  notchAngle: number;
};

// ── NlFormat helper ────────────────────────────────────────────────────────

type NlFormat = {
  fPacked: boolean;
  iBase: number;
  offPad: string;
  onPad: string;
};

function readNlFormat(layer: InfBlock): NlFormat {
  const fmt = layer.block("NlFormat") ?? layer.block("Nlformat");
  const fPacked = fmt?.key("fPacked") === "1";
  const iBase = parseInt(fmt?.key("iBase") ?? "16", 10);
  const offPad = (fmt?.key("cOffWaferPad") ?? "_")[0]!;
  const onPad = (fmt?.key("cOnWaferPad") ?? "@")[0]!;
  return { fPacked, iBase, offPad, onPad };
}

// ── Layer finders ──────────────────────────────────────────────────────────
//
// INF NlLayer blocks are all named "NlLayer" — they are identified by the
// strTag key within them (e.g. strTag:iBinCode), NOT by block name.

export function findLayer(block: InfBlock, name: string): InfBlock | undefined {
  return block.blocks("NlLayer").find((b) => b.key("strTag") === name);
}

export function findLastLayer(block: InfBlock, name: string): InfBlock | undefined {
  const all = block.blocks("NlLayer").filter((b) => b.key("strTag") === name);
  return all.length > 0 ? all[all.length - 1] : undefined;
}

// ── PSBN decoder ───────────────────────────────────────────────────────────

/**
 * Decode the PSBN block: 8 rows × 32-char bit string → set of good bin numbers.
 * Bit position [row * 32 + col] = 1 means bin is good.
 */
export function decodePsbn(psbnBlock: InfBlock): Set<number> {
  const result = new Set<number>();
  const rows = psbnBlock.keys("ListData");
  for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
    const row = rows[rowIdx]!;
    for (let col = 0; col < row.length && col < 32; col++) {
      if (row[col] === "1") result.add(rowIdx * 32 + col);
    }
  }
  return result;
}

/**
 * Find PSBN bin table in INF.
 * In real INF files it lives as a StBinTable block with strTag:PSBN
 * directly inside SmWaferFlow (not as a block named "PSBN").
 */
export function findPsbn(root: InfBlock): InfBlock | undefined {
  const flow = root.block("SmWaferFlow") ?? root;
  // Try StBinTable with strTag:PSBN first (real INF format)
  const stBin = flow.blocks("StBinTable").find((b) => b.key("strTag") === "PSBN");
  if (stBin) return stBin;
  // Fallback: block literally named "PSBN" (older/alternate format)
  return flow.block("PSBN") ?? root.block("PSBN");
}

// ── SmWaferPass enumeration ────────────────────────────────────────────────
//
// Lives here (not in infWaferMapPassSpecs.ts) because buildDieMapForFinalFlow
// and readDieGeometry below both need it, which would otherwise create a
// circular import between infWaferMapGeometry.ts and infWaferMapPassSpecs.ts.

export type SmWaferPassInfo = {
  block: InfBlock;
  passId: string;
  session: string;
  passType: string;
  passResult: string;
};

/** Find all SmWaferPass blocks, recursively looking inside SmWaferFlow. */
export function findAllSmWaferPasses(root: InfBlock): SmWaferPassInfo[] {
  const result: SmWaferPassInfo[] = [];
  const sources = [root, root.block("SmWaferFlow")].filter(Boolean) as InfBlock[];
  for (const src of sources) {
    for (const b of src.blocks("SmWaferPass")) {
      result.push({
        block: b,
        passId: b.key("PASS_ID") ?? b.key("iPassId") ?? "",
        session: b.key("SESSION_NUM") ?? b.key("iSessionNum") ?? "1",
        passType: b.key("PASS_TYPE") ?? b.key("iPassType") ?? "TEST",
        passResult: b.key("PASS_RESULT") ?? b.key("iPassResult") ?? "PASSED",
      });
    }
  }
  return result;
}

/** Get all SmWaferPass blocks for a specific passId. */
export function findSmWaferPassesForId(root: InfBlock, passId: string): SmWaferPassInfo[] {
  return findAllSmWaferPasses(root).filter((p) => p.passId === passId);
}

// ── Die map builder ────────────────────────────────────────────────────────

/**
 * Build per-die list from a single MdMapResult block.
 * Coordinates: (colIdx + iColMin, rowIdx + iRowMin).
 */
export function buildDieMap(
  mapResult: InfBlock,
  goodBins: Set<number>,
  binLayerName = "iBinCode",
  siteLayerName: string | null = "iTestSite"
): DieEntry[] {
  const binLayer = binLayerName.endsWith("Last")
    ? findLastLayer(mapResult, binLayerName)
    : findLayer(mapResult, binLayerName);
  if (!binLayer) return [];

  const siteLayer =
    siteLayerName == null
      ? null
      : siteLayerName.endsWith("Last")
      ? findLastLayer(mapResult, siteLayerName)
      : findLayer(mapResult, siteLayerName);

  const iRowMin = parseInt(binLayer.key("iRowMin") ?? "0", 10);
  const iColMin = parseInt(binLayer.key("iColMin") ?? "0", 10);

  const bf = readNlFormat(binLayer);
  const sf = siteLayer ? readNlFormat(siteLayer) : null;

  // nTouchCount layer: per-die touchdown count (decimal, space-separated)
  const touchLayer = findLayer(mapResult, "nTouchCount");
  const tf = touchLayer ? readNlFormat(touchLayer) : null;

  const binRows = binLayer.keys("RowData");
  const siteRows = siteLayer?.keys("RowData") ?? [];
  const touchRows = touchLayer?.keys("RowData") ?? [];

  // Pre-split touch rows (always non-packed in practice; guard anyway)
  const touchToks: Array<string[] | null> = touchRows.map((row) =>
    tf && !tf.fPacked ? row.split(" ").filter((s) => s.length > 0) : null
  );

  const dies: DieEntry[] = [];

  for (let rowIdx = 0; rowIdx < binRows.length; rowIdx++) {
    const binRow = binRows[rowIdx]!;
    const siteRow = rowIdx < siteRows.length ? siteRows[rowIdx]! : null;

    const bToks = bf.fPacked ? null : binRow.split(" ").filter((s) => s.length > 0);
    const sToks =
      sf && !sf.fPacked && siteRow ? siteRow.split(" ").filter((s) => s.length > 0) : null;

    const len = bf.fPacked ? binRow.length : (bToks?.length ?? 0);

    for (let colIdx = 0; colIdx < len; colIdx++) {
      const bStr = bf.fPacked ? binRow[colIdx]! : bToks![colIdx]!;
      if (bStr[0] === bf.offPad || bStr[0] === bf.onPad) continue;

      const bin = parseInt(bStr, bf.iBase);

      let site: number | null = null;
      if (sf) {
        if (sf.fPacked) {
          if (siteRow && colIdx < siteRow.length) {
            const sc = siteRow[colIdx]!;
            if (sc !== sf.offPad && sc !== sf.onPad)
              site = parseInt(sc, sf.iBase);
          }
        } else if (sToks && colIdx < sToks.length) {
          const s = sToks[colIdx]!;
          if (s[0] !== sf.offPad && s[0] !== sf.onPad)
            site = parseInt(s, sf.iBase);
        }
      }

      let touchCount: number | null = null;
      if (tf && rowIdx < touchRows.length) {
        if (tf.fPacked) {
          const row = touchRows[rowIdx]!;
          if (colIdx < row.length) {
            const tc = row[colIdx]!;
            if (tc !== tf.offPad && tc !== tf.onPad) {
              const n = parseInt(tc, tf.iBase);
              if (!isNaN(n)) touchCount = n;
            }
          }
        } else {
          const toks = touchToks[rowIdx];
          if (toks && colIdx < toks.length) {
            const tc = toks[colIdx]!;
            if (tc[0] !== tf.offPad && tc[0] !== tf.onPad) {
              const n = parseInt(tc, tf.iBase);
              if (!isNaN(n)) touchCount = n;
            }
          }
        }
      }

      dies.push({ x: colIdx + iColMin, y: rowIdx + iRowMin, bin, isGood: goodBins.has(bin), site, touchCount });
    }
  }
  return dies;
}

/**
 * Resolve bin/site layer names within a MdMapResult block.
 * Prefers iBinCodeLast (composite multi-tile result) over iBinCode.
 */
export function resolvePerPassLayerNames(
  mapResult: InfBlock
): { binLayerName: string; siteLayerName: string | null } {
  if (findLastLayer(mapResult, "iBinCodeLast")) {
    const site = findLastLayer(mapResult, "iTestSiteLast") ? "iTestSiteLast" : "iTestSite";
    return { binLayerName: "iBinCodeLast", siteLayerName: site };
  }
  return { binLayerName: "iBinCode", siteLayerName: "iTestSite" };
}

/**
 * Build die map for a SmWaferPass block — merges multiple MdMapResult tiles.
 * Later tiles overwrite earlier ones at the same (X, Y).
 */
export function buildDieMapForSmWaferPass(
  smWaferPass: InfBlock,
  goodBins: Set<number>,
  binLayerName = "iBinCode",
  siteLayerName: string | null = "iTestSite"
): DieEntry[] {
  const maps = smWaferPass.blocks("MdMapResult");
  if (maps.length === 0) return [];

  const useLegacy =
    binLayerName !== "iBinCode" ||
    (siteLayerName !== null && siteLayerName !== "iTestSite");

  if (maps.length === 1 && useLegacy)
    return buildDieMap(maps[0]!, goodBins, binLayerName, siteLayerName);

  const merged = new Map<string, DieEntry>();
  for (const m of maps) {
    const { binLayerName: bn, siteLayerName: sn } = useLegacy
      ? { binLayerName, siteLayerName }
      : resolvePerPassLayerNames(m);
    for (const d of buildDieMap(m, goodBins, bn, sn))
      merged.set(`${d.x},${d.y}`, d);
  }
  return [...merged.values()];
}

/**
 * Build die map from the final (flow-level) composite MdMapResult.
 * In real INF files, SmWaferFlow contains multiple SmWaferPass children each
 * with their own MdMapResult, PLUS one or more top-level MdMapResult blocks
 * at the end of SmWaferFlow that represent the final composite map.
 * SmWaferFlow.blocks("MdMapResult") returns ONLY direct children — the pass-level
 * MdMapResult blocks are nested under SmWaferPass and won't appear here.
 */
export function buildDieMapForFinalFlow(
  root: InfBlock,
  goodBins: Set<number>
): DieEntry[] {
  const flow = root.block("SmWaferFlow") ?? root;
  // Direct-child MdMapResult blocks of SmWaferFlow = the final composite maps
  const maps = flow.blocks("MdMapResult");
  if (maps.length > 0) {
    if (maps.length === 1) {
      // Prefer iBinCodeLast, fall back to iBinCode
      const { binLayerName, siteLayerName } = resolvePerPassLayerNames(maps[0]!);
      return buildDieMap(maps[0]!, goodBins, binLayerName, siteLayerName);
    }
    const merged = new Map<string, DieEntry>();
    for (const m of maps) {
      const { binLayerName, siteLayerName } = resolvePerPassLayerNames(m);
      for (const d of buildDieMap(m, goodBins, binLayerName, siteLayerName))
        merged.set(`${d.x},${d.y}`, d);
    }
    return [...merged.values()];
  }

  // Fallback: use iBinCodeLast from the last SmWaferPass
  const passes = findAllSmWaferPasses(root);
  if (passes.length === 0) return [];
  const lastPass = passes[passes.length - 1]!;
  return buildDieMapForSmWaferPass(lastPass.block, goodBins, "iBinCodeLast", "iTestSiteLast");
}

// ── Possible-die counter ───────────────────────────────────────────────────

/** Count testable die from MdMapControl.tyControl layer (value '0' = testable). */
export function countPossibleDie(root: InfBlock): number {
  const ctrl = root.block("MdMapControl") ?? root.block("SmWaferFlow")?.block("MdMapControl");
  if (!ctrl) return 0;
  const layer = findLayer(ctrl, "tyControl");
  if (!layer) return 0;
  const rowData = layer.keys("RowData");
  if (rowData.length === 0) return 0;
  const fmt = layer.block("NlFormat") ?? layer.block("Nlformat");
  const offPad = (fmt?.key("cOffWaferPad") ?? "_")[0]!;
  const onPad = (fmt?.key("cOnWaferPad") ?? "@")[0]!;
  const fPacked = fmt?.key("fPacked") === "1";
  let count = 0;
  if (fPacked) {
    for (const row of rowData)
      for (const c of row)
        if (c !== offPad && c !== onPad && c === "0") count++;
  } else {
    for (const row of rowData)
      for (const tok of row.split(" ").filter((s) => s.length > 0)) {
        if (tok[0] === offPad || tok[0] === onPad) continue;
        if (tok.split("").every((c) => c === "0")) count++;
      }
  }
  return count;
}

/** Read possible-die coordinates (tyControl == '0') for rendering untested spots. */
export function readPossibleDieCoords(root: InfBlock): Array<{ x: number; y: number }> {
  const ctrl = root.block("MdMapControl") ?? root.block("SmWaferFlow")?.block("MdMapControl");
  if (!ctrl) return [];
  const layer = findLayer(ctrl, "tyControl");
  if (!layer) return [];
  const rowData = layer.keys("RowData");
  const iRowMin = parseInt(layer.key("iRowMin") ?? "0", 10);
  const iColMin = parseInt(layer.key("iColMin") ?? "0", 10);
  const fmt = layer.block("NlFormat") ?? layer.block("Nlformat");
  const offPad = (fmt?.key("cOffWaferPad") ?? "_")[0]!;
  const onPad = (fmt?.key("cOnWaferPad") ?? "@")[0]!;
  const fPacked = fmt?.key("fPacked") === "1";
  const coords: Array<{ x: number; y: number }> = [];
  for (let rowIdx = 0; rowIdx < rowData.length; rowIdx++) {
    const row = rowData[rowIdx]!;
    if (fPacked) {
      for (let colIdx = 0; colIdx < row.length; colIdx++) {
        const c = row[colIdx]!;
        if (c !== offPad && c !== onPad && c === "0")
          coords.push({ x: colIdx + iColMin, y: rowIdx + iRowMin });
      }
    } else {
      const toks = row.split(" ").filter((s) => s.length > 0);
      for (let colIdx = 0; colIdx < toks.length; colIdx++) {
        const tok = toks[colIdx]!;
        if (tok[0] === offPad || tok[0] === onPad) continue;
        if (tok.split("").every((c) => c === "0"))
          coords.push({ x: colIdx + iColMin, y: rowIdx + iRowMin });
      }
    }
  }
  return coords;
}

// ── Die-count from raw RowData ─────────────────────────────────────────────

export function countDiesFromLayer(
  layer: InfBlock,
  goodBins: Set<number>
): { total: number; good: number; binCounts: Record<number, number> } {
  const { fPacked, iBase, offPad, onPad } = readNlFormat(layer);
  const rowData = layer.keys("RowData");
  let total = 0, good = 0;
  const binCounts: Record<number, number> = {};
  for (const row of rowData) {
    const toks = fPacked ? row.split("") : row.split(" ").filter((s) => s.length > 0);
    for (const tok of toks) {
      if (tok[0] === offPad || tok[0] === onPad) continue;
      total++;
      const bin = parseInt(tok, iBase);
      binCounts[bin] = (binCounts[bin] ?? 0) + 1;
      if (goodBins.has(bin)) good++;
    }
  }
  return { total, good, binCounts };
}

// ── Geometry helpers ───────────────────────────────────────────────────────

/**
 * Convert INF `dNotchAngle` to SVG canvas degrees.
 * INF: 0=top, 90=right, 180=bottom, 270=left (clockwise).
 * SVG: 0=right, 90=bottom, 180=left, 270=top (clockwise, y-down).
 */
export function infNotchAngleToSvg(infAngle: number): number {
  return ((infAngle - 90) % 360 + 360) % 360;
}

/**
 * Read die geometry from MdMapResult.
 * - dDieWidth / dDieHeight are direct keys of MdMapResult
 * - dNotchAngle is in MdMapResult.MdBlank.dNotchAngle
 */
export function readDieGeometry(root: InfBlock): { dieAspect: number; notchAngle: number } {
  const flow = root.block("SmWaferFlow") ?? root;

  // Find the first MdMapResult (flow-level or pass-level)
  let mdMapResult: InfBlock | undefined = flow.blocks("MdMapResult")[0];
  if (!mdMapResult) {
    const passes = findAllSmWaferPasses(root);
    mdMapResult = passes[0]?.block.block("MdMapResult");
  }

  // Die dimensions are direct keys on MdMapResult
  const dieWidth = parseFloat(mdMapResult?.key("dDieWidth") ?? "1");
  const dieHeight = parseFloat(mdMapResult?.key("dDieHeight") ?? "1");
  const aspect = !isNaN(dieWidth) && !isNaN(dieHeight) && dieHeight !== 0
    ? dieWidth / dieHeight : 1;

  // Notch angle: MdMapResult.MdBlank.dNotchAngle
  const mdBlank = mdMapResult?.block("MdBlank");
  const notchRaw = parseFloat(mdBlank?.key("dNotchAngle") ?? "270");
  const infNotch = isNaN(notchRaw) ? 270 : notchRaw;
  const notchAngle = infNotchAngleToSvg(infNotch);

  return { dieAspect: aspect, notchAngle };
}
