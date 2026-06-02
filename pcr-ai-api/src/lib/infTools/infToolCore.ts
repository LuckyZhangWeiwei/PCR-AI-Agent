/**
 * Shared utilities for all inf_* agent tools.
 */

import fs from "node:fs";
import path from "node:path";
import { parseInf } from "../infParser.js";
import {
  calculateWafer,
  decodePsbn,
  findPsbn,
  getDiesForPassId,
  type DieEntry,
  type WaferResult,
} from "../infWaferMap.js";
import { buildInfPath, buildInfLotDir } from "../buildInfPath.js";
import { listWaferInfPathsInLotDir } from "../outputSiteBinByLot.js";
import type { InfBlock } from "../infParser.js";

// ── Wafer maps output directory ────────────────────────────────────────────

export function getWaferMapsDir(): string {
  const dir =
    process.env["WAFERMAPS_DIR"] ??
    path.join(process.cwd(), "wafermaps");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function buildWaferMapFilename(
  device: string,
  lot: string,
  slot?: number,
  suffix = ""
): string {
  const d = device.replace(/[^a-zA-Z0-9]/g, "_");
  const l = lot.replace(/[^a-zA-Z0-9.]/g, "_");
  const s = slot != null ? `_slot${slot}` : "";
  const ts = Date.now();
  return `${d}_${l}${s}${suffix}_${ts}.html`;
}

/** Save HTML to wafermaps dir; return absolute path. */
export function saveWaferMapHtml(filename: string, html: string): string {
  const dir = getWaferMapsDir();
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, html, "utf8");
  return filePath;
}

/** URL path (relative) for a saved wafer map file. */
export function waferMapUrlPath(filename: string): string {
  return `/wafermaps/${filename}`;
}

// ── INF file loading ───────────────────────────────────────────────────────

export type InfWaferCtx = {
  root: InfBlock;
  goodBins: Set<number>;
  waferResult: WaferResult;
  infPath: string;
};

export async function loadInfWafer(
  device: string,
  lot: string,
  slot: number
): Promise<InfWaferCtx> {
  const infPath = buildInfPath(device, lot, slot);
  if (!fs.existsSync(infPath)) {
    throw new Error(`INF 文件不存在: ${infPath}`);
  }
  const root = await parseInf(infPath);
  const psbn = findPsbn(root);
  const goodBins = psbn ? decodePsbn(psbn) : new Set([1]);
  const waferResult = calculateWafer(root);
  return { root, goodBins, waferResult, infPath };
}

// ── Lot directory enumeration ──────────────────────────────────────────────

export type LotWaferEntry = {
  slot: number;
  infPath: string;
  root?: InfBlock;
  waferResult?: WaferResult;
  goodBins?: Set<number>;
  error?: string;
};

export async function loadLotWafers(
  device: string,
  lot: string,
  maxWafers = 25
): Promise<{ entries: LotWaferEntry[]; lotDir: string; errors: string[] }> {
  const lotDir = buildInfLotDir(device, lot);
  if (!fs.existsSync(lotDir)) {
    throw new Error(`Lot INF 目录不存在: ${lotDir}`);
  }

  const listed = await listWaferInfPathsInLotDir(lotDir);
  const errors: string[] = [];
  const capped = listed.slice(0, maxWafers);

  const entries: LotWaferEntry[] = await Promise.all(
    capped.map(async ({ slot, infPath }) => {
      try {
        const root = await parseInf(infPath);
        const psbn = findPsbn(root);
        const goodBins = psbn ? decodePsbn(psbn) : new Set([1]);
        const waferResult = calculateWafer(root);
        return { slot, infPath, root, waferResult, goodBins };
      } catch (e) {
        const msg = `slot${slot}: ${e instanceof Error ? e.message : String(e)}`;
        errors.push(msg);
        return { slot, infPath, error: msg };
      }
    })
  );

  return { entries, lotDir, errors };
}

// ── Pass-id argument parsing ───────────────────────────────────────────────

export function resolvePassId(args: Record<string, unknown>, defaultVal = "final"): string {
  const v = args["pass_id"] ?? args["passId"];
  if (v == null) return defaultVal;
  return String(v).trim() || defaultVal;
}

// ── Text helpers ───────────────────────────────────────────────────────────

export function pct(v: number, decimals = 2): string {
  return (v * 100).toFixed(decimals) + "%";
}

export function r4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/** Truncate a JSON result string to maxChars. */
export function truncResult(obj: unknown, maxChars = 20000): string {
  try {
    const s = JSON.stringify(obj, null, 2);
    return s.length > maxChars ? s.slice(0, maxChars) + "\n…(截断)" : s;
  } catch {
    return String(obj).slice(0, maxChars);
  }
}

/** Top-N bad bins summary string for tool result header. */
export function topBadBinsSummary(
  binCounts: Record<number, number>,
  goodBins: Set<number>,
  topN = 5
): string {
  const bad = Object.entries(binCounts)
    .filter(([b]) => !goodBins.has(Number(b)))
    .sort(([, a], [, b]) => b - a)
    .slice(0, topN);
  return bad.length > 0
    ? bad.map(([b, c]) => `BIN${b}×${c}`).join(", ")
    : "（无坏 bin）";
}

/** Arg helpers */
export function argStr(args: Record<string, unknown>, key: string, def = ""): string {
  const v = args[key];
  return v != null ? String(v).trim() : def;
}

export function argInt(args: Record<string, unknown>, key: string, def: number): number {
  const v = args[key];
  if (v == null) return def;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : def;
}

export function argBool(args: Record<string, unknown>, key: string, def = false): boolean {
  const v = args[key];
  if (v == null) return def;
  if (typeof v === "boolean") return v;
  const s = String(v).toLowerCase();
  return s === "true" || s === "1" || s === "yes";
}

export function argFloat(args: Record<string, unknown>, key: string, def: number): number {
  const v = args[key];
  if (v == null) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

export function argIntArray(args: Record<string, unknown>, key: string): number[] {
  const v = args[key];
  if (!Array.isArray(v)) return [];
  return v.map(Number).filter((n) => Number.isFinite(n));
}
