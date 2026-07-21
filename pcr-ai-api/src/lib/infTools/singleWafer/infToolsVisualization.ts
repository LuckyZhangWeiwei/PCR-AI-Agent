/**
 * Visualization single-wafer inf_* tools: interactive SVG wafer map and
 * DUT × BIN relationship map, both rendered to standalone HTML files.
 */

import { readPossibleDieCoords, type DieEntry } from "../../infWaferMap/infWaferMapGeometry.js";
import {
  getDiesForWaferMapSpec,
  buildWaferMapPassSpecs,
  resolveDutBinMapDies,
} from "../../infWaferMap/infWaferMapPassSpecs.js";
import { generateWaferMapHtml, type WaferMapPass } from "../../infWaferMap/html/waferMapHtml.js";
import { generateDutBinMapHtml } from "../../infWaferMap/html/dutBinMapHtml.js";
import {
  loadInfWafer,
  buildWaferMapFilename,
  saveWaferMapHtml,
  waferMapUrlPath,
  resolvePassId,
  topBadBinsSummary,
  argStr,
  argInt,
} from "../infToolCore.js";

// ── 16. inf_draw_wafer_map ────────────────────────────────────────────────

export async function runDrawWaferMap(
  args: Record<string, unknown>,
  device: string, lot: string, slot: number
): Promise<string> {
  const ctx = await loadInfWafer(device, lot, slot);
  const passesArg = argStr(args, "passes", "final");
  const highlight = argStr(args, "highlight");

  const passSpecs = buildWaferMapPassSpecs(ctx.root, passesArg);
  const passes: WaferMapPass[] = [];
  for (const spec of passSpecs) {
    const dies = getDiesForWaferMapSpec(ctx.root, ctx.goodBins, spec.dieKey);
    if (dies.length > 0) passes.push({ label: spec.label, dies });
  }

  if (passes.length === 0) return `未找到任何 die 数据（passes=${passesArg}）`;

  const layerCount = passSpecs.filter((s) => s.dieKey.startsWith("__block:")).length;
  const hasFinal = passSpecs.some((s) => s.dieKey === "final");
  const segmentNote =
    layerCount > 0 && hasFinal
      ? `共 ${layerCount} 个物理测试层（正测/复测各段含中断）+ 1 个合成层，请在标签页切换查看。`
      : passSpecs.length > 1
        ? "含多层测试结果，请在标签页切换查看。"
        : "";

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

  const compositeTab =
    passes.find((p) => p.label.startsWith("合成")) ?? passes[passes.length - 1]!;
  const goodCount = compositeTab.dies.filter((d) => d.isGood).length;
  const yieldPct =
    compositeTab.dies.length > 0
      ? (goodCount / compositeTab.dies.length * 100).toFixed(2)
      : "0.00";
  const topBad = topBadBinsSummary(r.final.binCounts, ctx.goodBins);

  return [
    `**晶圆图已生成** → [点击在新窗口查看晶圆图](${urlPath})`,
    `Device: ${device}  Lot: ${lot || r.lot}  Wafer: ${r.waferId}  Slot: ${slot}`,
    `总 die: ${compositeTab.dies.length}  良品: ${goodCount}  良率: ${yieldPct}%（合成层）`,
    `坏 bin top: ${topBad}`,
    `Pass 数: ${passes.length}（${passes.map((p) => p.label).join(", ")}）`,
    segmentNote,
  ].filter(Boolean).join("\n");
}

/** BIN 在各 DUT(site) 上出现次数最多者，用于「相关 DUT」未指定编号时。 */
function inferPrimaryDutForBin(dies: DieEntry[], targetBin: number): number | undefined {
  const counts = new Map<number, number>();
  for (const d of dies) {
    if (d.bin !== targetBin || d.site == null) continue;
    counts.set(d.site, (counts.get(d.site) ?? 0) + 1);
  }
  let best: number | undefined;
  let max = 0;
  for (const [site, n] of counts) {
    if (n > max) {
      max = n;
      best = site;
    }
  }
  return best;
}

// ── inf_draw_dut_bin_map ───────────────────────────────────────────────────

export async function runDrawDutBinMap(
  args: Record<string, unknown>,
  device: string, lot: string, slot: number
): Promise<string> {
  const bin = argInt(args, "bin", NaN);
  if (!Number.isFinite(bin)) return "inf_draw_dut_bin_map 参数错误: bin 不能为空";

  const ctx = await loadInfWafer(device, lot, slot);
  const requestedPass = resolvePassId(args, "final");
  const { passId: passIdStr, dies, fallbackNote } = resolveDutBinMapDies(
    ctx.root,
    ctx.goodBins,
    requestedPass,
    bin
  );

  if (dies.length === 0) return `无 die 数据（pass_id=${passIdStr}）`;

  let dut = argInt(args, "dut", NaN);
  let dutInferred = false;
  if (!Number.isFinite(dut)) {
    const inferred = inferPrimaryDutForBin(dies, bin);
    if (inferred != null) {
      dut = inferred;
      dutInferred = true;
    }
  }
  if (!Number.isFinite(dut)) {
    return (
      "inf_draw_dut_bin_map 参数错误: dut 不能为空。" +
      "可说「DUT2 × BIN15」或先 query_inf_site_bin_by_dut 查哪个 DUT 的 BIN15 最多。"
    );
  }

  const { waferResult: r } = ctx;
  const passLabel = `${passIdStr === "final" ? "最终" : `Pass ${passIdStr}`} | DUT=${dut} × BIN=${bin}`;

  const html = generateDutBinMapHtml(
    `DUT${dut} × BIN${bin} — ${device} / ${lot} / Slot ${slot}`,
    dies.map((d) => ({ x: d.x, y: d.y, bin: d.bin, site: d.site, isGood: d.isGood })),
    dut,
    bin,
    r.dieAspect,
    r.notchAngle,
    passLabel
  );

  const filename = buildWaferMapFilename(device, lot, slot, `_dut${dut}_bin${bin}`);
  saveWaferMapHtml(filename, html);
  const urlPath = waferMapUrlPath(filename);

  const matchCount = dies.filter((d) => d.site === dut && d.bin === bin).length;
  const dutTotal = dies.filter((d) => d.site === dut).length;
  const binTotal = dies.filter((d) => d.bin === bin).length;

  const note = binTotal === 0
    ? `⚠️ 各 pass（含正测层 1/3/5）中 BIN${bin} 出现次数均为 0，图中无白色或竖线 die——请确认 bin 编号`
    : matchCount === 0
    ? `ℹ️ BIN${bin} 存在（${binTotal} 个），但均不由 DUT${dut} 测试（图中仅竖线，无白色 die）`
    : "";

  const inferredNote = dutInferred
    ? `已自动选取 BIN${bin} 颗数最多的 DUT${dut}；**竖线**=其他 DUT 上的 BIN${bin}（即「相关 DUT」）。`
    : "";

  return [
    `**DUT${dut} × BIN${bin} 关系图已生成** → [点击在新窗口查看](${urlPath})`,
    `Device: ${device}  Lot: ${lot}  Slot: ${slot}`,
    `Pass: ${passIdStr}  总 die: ${dies.length}`,
    `DUT${dut} 测的 die: ${dutTotal}  BIN${bin} 出现: ${binTotal}  双匹配: ${matchCount}`,
    `DUT${dut} 中 BIN${bin} 占比: ${dutTotal > 0 ? ((matchCount / dutTotal) * 100).toFixed(1) : 0}%`,
    inferredNote,
    fallbackNote,
    note,
    `图例: ■ 白色=DUT${dut}且BIN${bin}  横线=该DUT其他bin  竖线=BIN${bin}由其他DUT测得  极暗=其他`,
  ].filter(Boolean).join("\n");
}
