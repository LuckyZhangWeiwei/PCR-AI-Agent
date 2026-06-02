/**
 * Core wafer die-map construction from INF block tree.
 * Port of WaferYieldCalculator.cs + data models (DieEntry, WaferResult, PassResult).
 */

import type { InfBlock } from "./infParser.js";

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
  /** Notch angle in degrees (SVG convention: 0=right, 90=bottom, 180=left, 270=top). */
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

  const binRows = binLayer.keys("RowData");
  const siteRows = siteLayer?.keys("RowData") ?? [];

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

      dies.push({ x: colIdx + iColMin, y: rowIdx + iRowMin, bin, isGood: goodBins.has(bin), site, touchCount: null });
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

// ── SmWaferPass enumeration ────────────────────────────────────────────────

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

// ── Die map for a specific pass / segment ─────────────────────────────────

/**
 * Resolve a pass_id string to a list of DieEntry.
 * Supports: "final", PASS_ID number, "N@pre", "N@post", "RETESTBIN:N".
 */
export function getDiesForPassId(
  root: InfBlock,
  goodBins: Set<number>,
  passIdStr: string
): DieEntry[] {
  const ps = passIdStr.trim().toLowerCase();

  if (ps === "final") return buildDieMapForFinalFlow(root, goodBins);

  // RETESTBIN:N
  const rtMatch = /^retestbin:(\d+)$/.exec(ps);
  if (rtMatch) {
    const afterId = rtMatch[1]!;
    const passes = findAllSmWaferPasses(root);
    const idx = passes.findIndex((p) => p.passId === afterId);
    if (idx < 0) return [];
    const retestBlock = passes.slice(idx + 1).find((p) => p.passType === "RETESTBIN")?.block;
    return retestBlock ? buildDieMapForSmWaferPass(retestBlock, goodBins) : [];
  }

  // N@pre / N@post (interrupted segment)
  const segMatch = /^(\d+)@(pre|post)$/.exec(ps);
  if (segMatch) {
    const targetId = segMatch[1]!;
    const segment = segMatch[2] as "pre" | "post";
    const passes = findAllSmWaferPasses(root).filter((p) => p.passId === targetId);
    if (passes.length === 0) return [];
    if (passes.length === 1) {
      // Single block — decide which side of the interrupt
      const b = passes[0]!.block;
      return segment === "pre" ? buildDieMapForSmWaferPass(b, goodBins) : [];
    }
    // Two blocks: first = pre (INTERRUPTED), second = post (PASSED)
    const chosen = segment === "pre" ? passes[0]! : passes[passes.length - 1]!;
    return buildDieMapForSmWaferPass(chosen.block, goodBins);
  }

  // Plain PASS_ID — merge all blocks for that id
  const matching = findSmWaferPassesForId(root, passIdStr);
  if (matching.length === 0) return [];
  const merged = new Map<string, DieEntry>();
  for (const pi of matching)
    for (const d of buildDieMapForSmWaferPass(pi.block, goodBins))
      merged.set(`${d.x},${d.y}`, d);
  return [...merged.values()];
}

// ── Geometry helpers ───────────────────────────────────────────────────────

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
  const notchAngle = isNaN(notchRaw) ? 270 : notchRaw;

  return { dieAspect: aspect, notchAngle };
}

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

/** Complete wafer analysis — mirrors WaferYieldCalculator.Calculate(). */
export function calculateWafer(root: InfBlock): WaferResult {
  // --- Identity ---
  const hdr = root.block("WaferSummary") ?? root.block("SmWaferSummary") ?? root;
  const lot = hdr.key("LOT_ID") ?? hdr.key("LOTID") ?? root.key("LOT_ID") ?? "";
  const waferId = hdr.key("WAFER_ID") ?? root.key("WAFER_ID") ?? "";
  const slot = hdr.key("SLOT") ?? root.key("SLOT") ?? "";
  const cassette = hdr.key("CASSETTE") ?? root.key("CASSETTE") ?? "";
  const wptId = hdr.key("WPT_ID") ?? root.key("WPT_ID") ?? "";
  const waferBatch = hdr.key("WAFER_BATCH") ?? root.key("WAFER_BATCH") ?? "";
  const mesSlot = hdr.key("MES_SLOT") ?? root.key("MES_SLOT") ?? "";
  const rotation = hdr.key("ROTATION") ?? root.key("ROTATION") ?? "";

  // --- Good bins ---
  const psbn = findPsbn(root);
  const goodBins = psbn ? decodePsbn(psbn) : new Set([1]);

  // --- Geometry ---
  const { dieAspect, notchAngle } = readDieGeometry(root);

  // --- Final die map ---
  const finalDies = buildDieMapForFinalFlow(root, goodBins);
  const possibleDie = countPossibleDie(root);

  const finalBinCounts: Record<number, number> = {};
  let finalGood = 0;
  for (const d of finalDies) {
    finalBinCounts[d.bin] = (finalBinCounts[d.bin] ?? 0) + 1;
    if (d.isGood) finalGood++;
  }

  // Row/col bounds from final dies
  const xs = finalDies.map((d) => d.x);
  const ys = finalDies.map((d) => d.y);
  const rowMin = ys.length ? Math.min(...ys) : 0;
  const colMin = xs.length ? Math.min(...xs) : 0;
  const rowCount = ys.length ? Math.max(...ys) - rowMin + 1 : 0;
  const colCount = xs.length ? Math.max(...xs) - colMin + 1 : 0;

  // --- Per-pass results ---
  const allPasses = findAllSmWaferPasses(root);
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

  // --- Timing ---
  const allTimes = allPasses
    .flatMap((p) => [
      parseInfTime(p.block.key("STTI") ?? p.block.key("START_TIME") ?? ""),
      parseInfTime(p.block.key("ENTI") ?? p.block.key("END_TIME") ?? ""),
    ])
    .filter(Boolean);
  const startTime = allTimes[0] ?? "";
  const endTime = allTimes[allTimes.length - 1] ?? "";

  return {
    lot,
    waferId,
    slot,
    cassette,
    wptId,
    waferBatch,
    mesSlot,
    rotation,
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
    timing: {
      startTime,
      endTime,
      totalDurationSeconds: timeDiffSeconds(startTime, endTime),
    },
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
