/**
 * 指定 DUT 的坏 BIN 反查：INF 结果是 bin→DUT，用户问「DUT12 哪个坏 bin 最多」时
 * 需在压缩前按 DUT 反查，避免 Top8 DUT 截断导致假阴性。
 */
import type { SiteBinPass } from "../outputSiteBinByLot/types.js";
import { extractDutFromUserText } from "./agentDutBinMapRoute.js";

const GOOD_BIN_AVG_THRESHOLD = 100;

export type FocusDutBinRow = {
  bin: string;
  binNum: number;
  dieCount: number;
};

export type FocusDutPassBins = {
  passId: number;
  bins: FocusDutBinRow[];
  totalBadDie: number;
};

/** 「DUT12 哪个坏 bin 最多 / DUT12 都测出了什么坏 bin」——有具体 DUT 编号。 */
export function isDutFocusBadBinQuestion(text: string): boolean {
  const dut = extractDutFromUserText(text);
  if (dut == null) return false;
  if (!/坏\s*bin|fail(?:ed)?\s*bin|坏\s*die/i.test(text)) return false;
  return /哪个|最多|都\s*(?:测试|测)出了?什么|测出了?什么|有哪些|哪些|列出|分别/i.test(
    text
  );
}

function parseBinNum(bin: string): number {
  const m = /^bin(\d+)$/i.exec(bin.trim());
  return m ? Number(m[1]) : NaN;
}

function isLikelyGoodBin(duts: Array<{ dieCount: number }>): boolean {
  const total = duts.reduce((s, d) => s + d.dieCount, 0);
  if (total === 0 || duts.length === 0) return false;
  return total / duts.length > GOOD_BIN_AVG_THRESHOLD;
}

/**
 * 从原始 INF passes 反查某 DUT 在各 pass 的坏 BIN 颗数（降序）。
 * 不经过 Top8 截断，保证 DUT 即使不在各 BIN 的头部 DUT 列表中也能被统计到。
 */
export function extractFocusDutBins(
  passes: SiteBinPass[],
  focusDut: number
): FocusDutPassBins[] {
  const out: FocusDutPassBins[] = [];
  for (const pass of passes) {
    const rows: FocusDutBinRow[] = [];
    for (const b of pass.bins) {
      if (isLikelyGoodBin(b.duts)) continue;
      const hit = b.duts.find(
        (d) => typeof d.dut === "number" && d.dut === focusDut && d.dieCount > 0
      );
      if (!hit) continue;
      const binNum = parseBinNum(b.bin);
      rows.push({
        bin: b.bin,
        binNum: Number.isFinite(binNum) ? binNum : -1,
        dieCount: hit.dieCount,
      });
    }
    rows.sort((a, z) => z.dieCount - a.dieCount || a.binNum - z.binNum);
    const totalBadDie = rows.reduce((s, r) => s + r.dieCount, 0);
    out.push({ passId: pass.passId, bins: rows, totalBadDie });
  }
  return out;
}

/** 压缩后仍保证 focusDut 出现在各坏 BIN 的 duts 列表中（即使原本不在 Top8）。 */
export function ensureFocusDutInCompactedDuts(
  duts: Array<{ dut?: number | "single"; dieCount: number; [k: string]: unknown }>,
  allDuts: Array<{ dut: number | "single"; dieCount: number }>,
  focusDut: number,
  maxDuts: number
): Array<{ dut?: number | "single"; dieCount: number; [k: string]: unknown }> {
  if (duts.some((d) => d.dut === focusDut)) return duts;
  const focusEntry = allDuts.find(
    (d) => typeof d.dut === "number" && d.dut === focusDut && d.dieCount > 0
  );
  if (!focusEntry) return duts;
  if (duts.length < maxDuts) return [...duts, focusEntry];
  return [...duts.slice(0, Math.max(0, maxDuts - 1)), focusEntry];
}

export function buildFocusDutBinsMarkdown(
  focusDut: number,
  focusDutBins: FocusDutPassBins[],
  meta: { device?: string; lot?: string; slot?: number; passId?: number }
): string {
  const lines: string[] = [];
  const scopeParts: string[] = [];
  if (meta.lot) scopeParts.push(`批次 ${meta.lot}`);
  if (meta.slot != null) scopeParts.push(`waferId ${meta.slot}`);
  if (meta.passId != null) scopeParts.push(`pass${meta.passId}`);
  scopeParts.push(`DUT${focusDut}`);
  lines.push(`**DUT${focusDut} 坏 BIN 排行**（${scopeParts.join(" · ")}）`);
  lines.push("");

  const passes =
    meta.passId != null
      ? focusDutBins.filter((p) => p.passId === meta.passId)
      : focusDutBins;

  if (passes.length === 0 || passes.every((p) => p.bins.length === 0)) {
    lines.push(
      `DUT${focusDut} 在查询范围内**未测出任何坏 BIN**（已按完整 INF 反查，非 Top DUT 截断推断）。`
    );
    return lines.join("\n");
  }

  for (const p of passes) {
    if (passes.length > 1) {
      lines.push(`### pass${p.passId}（坏 die 合计 ${p.totalBadDie}）`);
      lines.push("");
    } else {
      lines.push(`坏 die 合计 **${p.totalBadDie}** 颗。`);
      lines.push("");
    }
    lines.push("| # | BIN | 坏 die 颗数 | 占比 |");
    lines.push("|---|-----|------------|------|");
    p.bins.forEach((row, i) => {
      const pct =
        p.totalBadDie > 0
          ? ((row.dieCount / p.totalBadDie) * 100).toFixed(1)
          : "0.0";
      const label = row.binNum >= 0 ? `BIN${row.binNum}` : row.bin;
      lines.push(`| ${i + 1} | ${label} | ${row.dieCount} | ${pct}% |`);
    });
    lines.push("");
    const top = p.bins[0];
    if (top) {
      const label = top.binNum >= 0 ? `BIN${top.binNum}` : top.bin;
      lines.push(
        `**最多坏 BIN：${label}**（${top.dieCount} 颗，占该 DUT 坏 die ${((top.dieCount / p.totalBadDie) * 100).toFixed(1)}%）。`
      );
      lines.push("");
    }
  }

  lines.push(
    "> 以上为指定 DUT 在 INF 中的完整坏 BIN 反查（不受各 BIN Top8 DUT 截断影响）。"
  );
  return lines.join("\n").trim();
}

/**
 * 从 `"key":` 开始扫描一个完整的 JSON 值（对象/数组按括号配对，标量按下一个
 * `,`/`}`/`]` 截断）。truncateResult() 对超长结果按字符数硬切并追加中文提示
 * 后缀，不是合法 JSON 收尾；focusDut/focusDutBins 在 buildInfSiteBinResult()
 * 中被放在对象最前面，即使 passes 被截断，这两个字段本身通常仍然完整——
 * 因此逐字段提取比对整段 raw 做 JSON.parse 更抗截断。
 */
function extractJsonValueAfterKey(text: string, key: string): string | null {
  const marker = `"${key}":`;
  const markerIdx = text.indexOf(marker);
  if (markerIdx < 0) return null;
  let i = markerIdx + marker.length;
  while (i < text.length && /\s/.test(text[i]!)) i++;
  const start = i;
  const openChar = text[i];
  if (openChar !== "{" && openChar !== "[") {
    let end = i;
    while (end < text.length && !",}]".includes(text[end]!)) end++;
    return text.slice(start, end);
  }
  const closeChar = openChar === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escape = false;
  for (; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null; // unbalanced — truncated mid-value, can't recover
}

/** 从工具 JSON 字符串解析 focusDutBins（若服务端已写入）。 */
export function parseFocusDutBinsFromToolResult(
  raw: string
): {
  focusDut?: number;
  focusDutBins?: FocusDutPassBins[];
  device?: string;
  lot?: string;
  slot?: number;
} | null {
  const jsonStart = raw.indexOf("{");
  if (jsonStart < 0) return null;
  const body = raw.slice(jsonStart);

  const focusDutRaw = extractJsonValueAfterKey(body, "focusDut");
  const focusDutBinsRaw = extractJsonValueAfterKey(body, "focusDutBins");
  if (!focusDutRaw || !focusDutBinsRaw) return null;

  try {
    const focusDut = JSON.parse(focusDutRaw) as unknown;
    const focusDutBins = JSON.parse(focusDutBinsRaw) as unknown;
    if (typeof focusDut !== "number" || !Array.isArray(focusDutBins)) return null;

    const deviceRaw = extractJsonValueAfterKey(body, "device");
    const lotRaw = extractJsonValueAfterKey(body, "lot");
    const slotRaw = extractJsonValueAfterKey(body, "slot");
    const device = deviceRaw != null ? (JSON.parse(deviceRaw) as unknown) : undefined;
    const lot = lotRaw != null ? (JSON.parse(lotRaw) as unknown) : undefined;
    const slot = slotRaw != null ? (JSON.parse(slotRaw) as unknown) : undefined;

    return {
      focusDut,
      focusDutBins: focusDutBins as FocusDutPassBins[],
      device: typeof device === "string" ? device : undefined,
      lot: typeof lot === "string" ? lot : undefined,
      slot: typeof slot === "number" ? slot : undefined,
    };
  } catch {
    return null;
  }
}
