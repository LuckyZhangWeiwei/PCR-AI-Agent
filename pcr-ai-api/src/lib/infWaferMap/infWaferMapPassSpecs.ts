/**
 * Pass-spec resolution: mapping a wafer-map "pass" argument (final / PASS_ID /
 * segment / block index) to a concrete die list, and building the tab list
 * shown in the wafer-map UI.
 */

import type { InfBlock } from "../infParser.js";
import {
  type DieEntry,
  type SmWaferPassInfo,
  findAllSmWaferPasses,
  findSmWaferPassesForId,
  buildDieMapForSmWaferPass,
  buildDieMapForFinalFlow,
} from "./infWaferMapGeometry.js";

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

// ── Wafer map pass tabs (incl. interrupt / retest segments) ────────────────

export type WaferMapPassSpec = {
  /** Passed to getDiesForWaferMapSpec (`final`, `5@pre`, or `__block:12`). */
  dieKey: string;
  label: string;
};

/** Dies for one wafer-map tab; `__block:N` = Nth SmWaferPass in file order. */
export function getDiesForWaferMapSpec(
  root: InfBlock,
  goodBins: Set<number>,
  dieKey: string
): DieEntry[] {
  const blockMatch = /^__block:(\d+)$/.exec(dieKey.trim());
  if (blockMatch) {
    const idx = Number(blockMatch[1]);
    const all = findAllSmWaferPasses(root);
    const pi = all[idx];
    if (!pi) return [];
    return buildDieMapForSmWaferPass(pi.block, goodBins);
  }
  return getDiesForPassId(root, goodBins, dieKey);
}

/** Multi-segment label when same PASS_ID has several blocks of one PASS_TYPE (interrupt). */
function layeredPassLabel(
  all: SmWaferPassInfo[],
  blockIndex: number,
  passType: string,
  prefix: string
): string {
  const pi = all[blockIndex]!;
  const indices = all
    .map((p, i) => ({ p, i }))
    .filter(
      ({ p }) =>
        p.passId === pi.passId && p.passType.toUpperCase() === passType.toUpperCase()
    )
    .map(({ i }) => i);
  if (indices.length < 2) return prefix;
  const pos = indices.indexOf(blockIndex);
  if (pos < 0) return prefix;
  if (indices.length === 2) {
    return pos === 0 ? `${prefix}·中断前` : `${prefix}·续测后`;
  }
  return `${prefix}·段${pos + 1}`;
}

/** Human label for one SmWaferPass tab (正测 / 复测 / 其它类型，含中断分段). */
export function describePassLayer(all: SmWaferPassInfo[], blockIndex: number): string {
  const pt = all[blockIndex]!.passType.toUpperCase();
  if (pt === "TEST") return layeredPassLabel(all, blockIndex, "TEST", "正测");
  if (pt === "RETESTBIN") return layeredPassLabel(all, blockIndex, "RETESTBIN", "复测");
  if (pt === "INTERRUPT") return layeredPassLabel(all, blockIndex, "INTERRUPT", "中断");
  return layeredPassLabel(all, blockIndex, pt, pt);
}

/**
 * Default wafer-map tabs: every SmWaferPass physical layer (in file order), then flow-level 合成.
 * 正测/复测均可有多段（中断前/续测后/段N）；最后为 TEST+RETEST 合并的 final 图。
 */
export function buildStandardWaferMapPassSpecs(root: InfBlock): WaferMapPassSpec[] {
  const all = findAllSmWaferPasses(root);
  const specs: WaferMapPassSpec[] = all.map((pi, i) => ({
    dieKey: `__block:${i}`,
    label: `Pass ${pi.passId} (${describePassLayer(all, i)})`,
  }));
  specs.push({
    dieKey: "final",
    label: "合成 (正测+复测)",
  });
  return specs;
}

/** Physical layers only (no final) — for tests. */
export function findSegmentedPassLayers(root: InfBlock): WaferMapPassSpec[] {
  return buildStandardWaferMapPassSpecs(root).filter((s) => s.dieKey !== "final");
}

/**
 * All physical blocks for one PASS_ID (正测/复测/中断前·续测后各段) + a pass-level composite tab.
 * Used when user asks "只画 pass1" — shows every segment of that pass separately.
 *
 * If the passId has only one block (no retest, no interrupt), no composite is added
 * (it would be identical to the single block).
 * Returns empty array if no blocks exist for this passId.
 */
export function buildPassIdWaferMapSpecs(root: InfBlock, passId: string): WaferMapPassSpec[] {
  const all = findAllSmWaferPasses(root);
  const matching = all.filter((pi) => pi.passId === passId);
  if (matching.length === 0) return [];

  const specs: WaferMapPassSpec[] = matching.map((pi) => {
    const globalIdx = all.indexOf(pi);
    return {
      dieKey: `__block:${globalIdx}`,
      label: `Pass ${pi.passId} (${describePassLayer(all, globalIdx)})`,
    };
  });

  // Add pass-level composite (merge all blocks for this passId) only when
  // there are multiple blocks (retest / interrupted segments present).
  if (matching.length > 1) {
    specs.push({ dieKey: passId, label: `Pass ${passId} (合成)` });
  }

  return specs;
}

function labelForDieKey(dieKey: string): string {
  if (dieKey === "final") return "合成 (正测+复测)";
  if (/^(\d+)@(pre|post)$/.test(dieKey)) {
    const m = /^(\d+)@(pre|post)$/.exec(dieKey)!;
    return `Pass ${m[1]} (${m[2] === "pre" ? "正测·中断前" : "正测·续测后"})`;
  }
  return `Pass ${dieKey}`;
}

/**
 * Build wafer-map tab list from passes= argument.
 * Default `final` / `all` → 每个 SmWaferPass 物理层 + 合成（flow-level final）。
 */
export function buildWaferMapPassSpecs(root: InfBlock, passesArg: string): WaferMapPassSpec[] {
  const arg = passesArg.trim().toLowerCase();

  if (arg === "all") {
    return buildStandardWaferMapPassSpecs(root);
  }

  /** 仅合成层（换 BIN 高亮跟随时，避免重复画全部中断段） */
  if (arg === "composite") {
    return [{ dieKey: "final", label: "合成 (正测+复测)" }];
  }

  if (arg === "final" || arg === "final+segments" || arg === "final_interrupt") {
    return buildStandardWaferMapPassSpecs(root);
  }

  const tokens = passesArg.split(",").map((s) => s.trim()).filter(Boolean);
  const specs: WaferMapPassSpec[] = [];
  let wantStandardExpand = false;
  for (const t of tokens) {
    if (t.toLowerCase() === "final") {
      wantStandardExpand = true;
    } else if (/^\d+$/.test(t)) {
      // Plain PASS_ID (e.g. "1"): expand to individual physical blocks + pass-level composite.
      // Ensures interrupt segments (中断前/续测后) and retest show as separate tabs.
      const passSpecs = buildPassIdWaferMapSpecs(root, t);
      if (passSpecs.length > 0) {
        const seen = new Set(specs.map((s) => s.dieKey));
        for (const s of passSpecs) {
          if (!seen.has(s.dieKey)) specs.push(s);
        }
      } else {
        specs.push({ dieKey: t, label: labelForDieKey(t) });
      }
    } else {
      specs.push({ dieKey: t, label: labelForDieKey(t) });
    }
  }
  if (wantStandardExpand) {
    const standard = buildStandardWaferMapPassSpecs(root);
    const seen = new Set(specs.map((s) => s.dieKey));
    for (const s of standard) {
      if (!seen.has(s.dieKey)) specs.push(s);
    }
  }
  return specs;
}
