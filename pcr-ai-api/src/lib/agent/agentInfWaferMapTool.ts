/**
 * Fill / normalize inf_draw_wafer_map args when the model omits device/lot/slot
 * on follow-up requests (e.g. "同理标出 BIN14").
 */

import type { ChatMessage } from "./agentHistory.js";
import { tryParseJsonish } from "./agentChartTool.js";

export type InfWaferMapContext = {
  device?: string;
  lot?: string;
  slot?: number;
  highlight?: string;
};

/** BIN98 / bin 14 / bin:14 / highlight bin:14 */
export function extractBinNumberFromText(text: string): number | undefined {
  const t = text.trim();
  if (!t) return undefined;
  const m1 = /\bBIN\s*(\d{1,3})\b/i.exec(t);
  if (m1) return Number(m1[1]);
  const m2 = /\bbin\s*[:=]?\s*(\d{1,3})\b/i.exec(t);
  if (m2) return Number(m2[1]);
  const m3 = /标出\s*(\d{1,3})/.exec(t);
  if (m3) return Number(m3[1]);
  return undefined;
}

function parseToolCallArgs(raw: string): Record<string, unknown> | null {
  const parsed = tryParseJsonish(raw);
  if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return null;
}

/** Parse markdown line from inf_draw_wafer_map result: `Lot: x  Wafer: y  Slot: n` */
export function parseInfDrawResultText(content: string): Partial<InfWaferMapContext> {
  const out: Partial<InfWaferMapContext> = {};
  const deviceM = /Device:\s*(\S+)/i.exec(content);
  if (deviceM) out.device = deviceM[1];
  const lotM = /Lot:\s*(\S+?)(?=\s{2,}Wafer:|\s{2,}Slot:|$)/i.exec(content);
  if (lotM?.[1]) out.lot = lotM[1];
  const slotM = /Slot:\s*(\d+)/i.exec(content);
  if (slotM) out.slot = Number(slotM[1]);
  const hlM = /highlight[=:]\s*['"]?(bin:\d+|edge)['"]?/i.exec(content);
  if (hlM) out.highlight = hlM[1].toLowerCase();
  return out;
}

function slotFromRecord(args: Record<string, unknown>): number | undefined {
  const v = args["slot"] ?? args["waferId"] ?? args["wafer_id"];
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function strField(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (v == null) return "";
  return String(v).trim();
}

function normalizeHighlight(
  args: Record<string, unknown>,
  binHint?: number
): string | undefined {
  const hl = strField(args, "highlight");
  if (hl) {
    if (hl === "edge") return "edge";
    if (/^bin:\d+$/i.test(hl)) return hl.toLowerCase();
  }
  const binArg = args["bin"];
  if (binArg != null && binArg !== "") {
    const n = Number(binArg);
    if (Number.isFinite(n)) return `bin:${n}`;
  }
  if (binHint != null && Number.isFinite(binHint)) return `bin:${binHint}`;
  return hl || undefined;
}

/**
 * Walk history (newest first) for the last successful inf_draw_wafer_map context.
 */
export function findLastInfDrawWaferMapContext(
  history: ChatMessage[]
): InfWaferMapContext | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role === "tool" && msg.name === "inf_draw_wafer_map") {
      const content = String(msg.content ?? "");
      if (!content.includes("晶圆图已生成") && !content.includes("/wafermaps/")) {
        continue;
      }
      const fromText = parseInfDrawResultText(content);
      if (fromText.lot || fromText.slot != null) {
        return {
          device: fromText.device,
          lot: fromText.lot,
          slot: fromText.slot,
          highlight: fromText.highlight,
        };
      }
    }
    if (msg.role === "assistant" && msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        if (tc.function.name !== "inf_draw_wafer_map") continue;
        const parsed = parseToolCallArgs(tc.function.arguments);
        if (!parsed) continue;
        const device = strField(parsed, "device");
        const lot = strField(parsed, "lot");
        const slot = slotFromRecord(parsed);
        const highlight = normalizeHighlight(parsed);
        if (device || lot || slot != null) {
          return { device: device || undefined, lot: lot || undefined, slot, highlight };
        }
      }
    }
  }
  return null;
}

/** device + lot from latest query_jb_bins tool JSON. */
export function findJbLotContext(history: ChatMessage[]): Partial<InfWaferMapContext> {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role !== "tool" || msg.name !== "query_jb_bins") continue;
    const parsed = tryParseJsonish(String(msg.content ?? ""));
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const rec = parsed as Record<string, unknown>;
    const device = String(rec["device"] ?? "").trim();
    const lot = String(rec["lot"] ?? rec["LOT"] ?? "").trim();
    if (device || lot) return { device: device || undefined, lot: lot || undefined };
  }
  return {};
}

function latestUserBinHint(history: ChatMessage[]): number | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role === "user" && typeof msg.content === "string") {
      const b = extractBinNumberFromText(msg.content);
      if (b != null) return b;
    }
  }
  return undefined;
}

/** waferId / slot from user text (e.g. 第1片、wafer 14). */
export function extractSlotFromUserText(text: string): number | undefined {
  const patterns = [
    /第\s*(\d+)\s*片/i,
    /wafer\s*id\s*[=:]?\s*(\d+)/i,
    /(?:^|[\s/])wafer\s*(\d+)(?:\s|的|$)/i,
    /(?:slot|片)\s*[=:]?\s*(\d+)/i,
    /(?:第|slot)\s*(\d+)\s*(?:片|槽|slot)?/i,
  ];
  for (const p of patterns) {
    const m = p.exec(text);
    if (m) return Number(m[1]);
  }
  return undefined;
}

function latestUserSlotHint(history: ChatMessage[]): number | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role !== "user" || typeof msg.content !== "string") continue;
    const slot = extractSlotFromUserText(msg.content);
    if (slot != null) return slot;
  }
  return undefined;
}

/** Lot id embedded in user message (e.g. DR44117.1Y). */
export function extractLotFromUserText(text: string): string | undefined {
  const m = /\b([A-Z]{1,3}\d{4,6}\.\d+[A-Z0-9]+)\b/i.exec(text);
  return m ? m[1]! : undefined;
}

/**
 * User only wants an interactive wafer map link — not lot-wide JB tables / commentary.
 */
export function userWantsWaferMapOnly(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // DUT×BIN 关系图走 inf_draw_dut_bin_map，不是 BIN 高亮 wafermap
  if (
    extractBinNumberFromText(t) != null &&
    /\bdut\b|DUT|site/i.test(t) &&
    /关系|关联|相关\s*dut|和\s*dut|与\s*dut/i.test(t)
  ) {
    return false;
  }
  const wantsMap =
    /\bwafermap\b/i.test(t) ||
    /wafer\s*map/i.test(t) ||
    /画.*(晶圆图|wafer)/i.test(t) ||
    /(画出|绘制|生成).*(晶圆|wafer)/i.test(t) ||
    /同理.*(wafer|晶圆图|wafermap)/i.test(t) ||
    (/标出|标亮|高亮/i.test(t) && /bin/i.test(t) && /wafer/i.test(t));
  if (!wantsMap) return false;
  if (
    /概况|整体分析|批次.*分析|聚集.*分析|突增|排名|机台.*分布|各片.*对比|解读|专业建议|坏\s*bin\s*排名/i.test(
      t
    )
  ) {
    return false;
  }
  return true;
}

/** Build inf_draw_wafer_map args after query_jb_bins (device/lot from payload). */
export function buildInfDrawArgsAfterJbLookup(
  payload: Record<string, unknown>,
  history: ChatMessage[],
  userText: string
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const device = String(payload["device"] ?? "").trim();
  const lot =
    String(payload["lot"] ?? payload["LOT"] ?? "").trim() ||
    extractLotFromUserText(userText) ||
    "";
  if (device) args["device"] = device;
  if (lot) args["lot"] = lot;
  const slot =
    extractSlotFromUserText(userText) ?? latestUserSlotHint(history);
  if (slot != null) args["slot"] = slot;
  const passId = inferSinglePassIdFromText(userText);
  if (passId) args["passes"] = passId;
  return normalizeInfDrawWaferMapArgs(args, history);
}

/** Args for inf_draw_wafer_map from session history + latest user text. */
export function buildInfDrawArgsFromSession(
  history: ChatMessage[],
  userText: string
): Record<string, unknown> {
  const jb = findJbLotContext(history);
  const payload: Record<string, unknown> = {};
  if (jb.device) payload["device"] = jb.device;
  if (jb.lot) payload["lot"] = jb.lot;
  return buildInfDrawArgsAfterJbLookup(payload, history, userText);
}

export function sessionCanDrawWaferMapWithoutJb(
  history: ChatMessage[],
  userText: string
): boolean {
  if (!findLastInfDrawWaferMapContext(history) && !findJbLotContext(history).device) {
    return false;
  }
  return infDrawWaferMapArgsComplete(buildInfDrawArgsFromSession(history, userText));
}

function findLastInfDrawPassesArg(history: ChatMessage[]): string | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role !== "assistant" || !msg.tool_calls?.length) continue;
    for (const tc of msg.tool_calls) {
      if (tc.function.name !== "inf_draw_wafer_map") continue;
      const parsed = parseToolCallArgs(tc.function.arguments);
      if (!parsed) continue;
      const p = strField(parsed, "passes");
      if (p) return p;
    }
  }
  return undefined;
}

/** User explicitly wants every SmWaferPass layer + composite (slow on large INF). */
export function userWantsAllInfLayers(text: string): boolean {
  return /全部.*层|所有.*层|每一层|各.*层|所有.*中断|中断.*层|正测.*复测|含.*合成|画出.*全部|全.*层.*晶圆图/i.test(
    text
  );
}

/** e.g. "pass1" / "第1层" → "1" (PASS_ID); omit when user wants all layers. */
export function inferSinglePassIdFromText(text: string): string | undefined {
  if (userWantsAllInfLayers(text)) return undefined;
  const m =
    /\bpass\s*([135])\b/i.exec(text) ??
    /pass\s*([135])\s*的/i.exec(text) ??
    /第\s*([135])\s*层/i.exec(text);
  if (m) return m[1]!;
  if (/\bpass\s*1\b|pass1|常温/i.test(text)) return "1";
  if (/\bpass\s*3\b|pass3|高温/i.test(text)) return "3";
  if (/\bpass\s*5\b|pass5|低温/i.test(text)) return "5";
  return undefined;
}

function latestUserMessageText(history: ChatMessage[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role === "user" && typeof msg.content === "string") {
      return msg.content;
    }
  }
  return "";
}

export function infDrawWaferMapArgsComplete(args: Record<string, unknown>): boolean {
  return (
    strField(args, "device").length > 0 &&
    strField(args, "lot").length > 0 &&
    slotFromRecord(args) != null
  );
}

/**
 * Merge missing device/lot/slot/highlight from session history and user bin hints.
 */
export function normalizeInfDrawWaferMapArgs(
  args: Record<string, unknown>,
  history: ChatMessage[]
): Record<string, unknown> {
  const out = { ...args };
  const binHint = extractBinNumberFromText(strField(args, "highlight")) ??
    (args["bin"] != null ? Number(args["bin"]) : undefined) ??
    latestUserBinHint(history);

  const prev = findLastInfDrawWaferMapContext(history);
  const jb = findJbLotContext(history);
  const slotHint = slotFromRecord(out) ?? latestUserSlotHint(history) ?? prev?.slot;

  if (!strField(out, "device")) {
    out["device"] = prev?.device ?? jb.device ?? "";
  }
  if (!strField(out, "lot")) {
    out["lot"] = prev?.lot ?? jb.lot ?? "";
  }
  if (slotFromRecord(out) == null && slotHint != null) {
    out["slot"] = slotHint;
  }

  const hl = normalizeHighlight(out, binHint);
  if (hl) out["highlight"] = hl;
  if ("bin" in out) delete out["bin"];

  if (!strField(out, "passes")) {
    const userText = latestUserMessageText(history);
    const passId = inferSinglePassIdFromText(userText);
    if (passId) {
      out["passes"] = passId;
    } else if (
      findLastInfDrawWaferMapContext(history) &&
      extractBinNumberFromText(userText) != null &&
      !/\bdut\b|DUT|关系|相关\s*dut/i.test(userText)
    ) {
      // 换 BIN 高亮（非 DUT 关系图）：只重画合成层
      out["passes"] = "composite";
    } else {
      const prevPasses = findLastInfDrawPassesArg(history);
      if (prevPasses) out["passes"] = prevPasses;
    }
  }

  return out;
}
