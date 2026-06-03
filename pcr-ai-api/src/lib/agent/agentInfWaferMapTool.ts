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
  const lotM = /Lot:\s*(\S+)/i.exec(content);
  if (lotM) out.lot = lotM[1];
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

function latestUserSlotHint(history: ChatMessage[]): number | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role !== "user" || typeof msg.content !== "string") continue;
    const t = msg.content;
    const waferM = /wafer\s*id\s*[=:]?\s*(\d+)/i.exec(t);
    if (waferM) return Number(waferM[1]);
    const slotM = /(?:第|slot)\s*(\d+)\s*(?:片|槽|slot)?/i.exec(t);
    if (slotM) return Number(slotM[1]);
  }
  return undefined;
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

  return out;
}
