/**
 * DUT × BIN 关系晶圆图路由：须用 inf_draw_dut_bin_map，禁止误走 inf_draw_wafer_map 的 BIN 高亮。
 */

import type { ChatMessage } from "./agentHistory.js";
import {
  extractBinNumberFromText,
  extractLotFromUserText,
  extractSlotFromUserText,
  findJbLotContext,
  inferSinglePassIdFromText,
  infDrawWaferMapArgsComplete,
  normalizeInfDrawWaferMapArgs,
} from "./tools/agentInfWaferMapTool.js";
import { getCachedJbPayloadForLot } from "./agentJbOverviewRoute.js";

/** 「BIN15 与 DUT 关系」类问题（图案图：横线/竖线/白块）。 */
export function userWantsDutBinRelationMap(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  const bin = extractBinNumberFromText(t);
  if (bin == null) return false;
  // dut12 / DUT 12 / site — `\bdut\b` 匹配不了 dut12（数字粘连），须单独覆盖
  if (!/\bdut\s*\d{1,3}\b|\bdut\b|DUT|site|探针|map\s*site/i.test(t)) return false;
  // 勿用「哪个 DUT」——那是数量集中度问法，应交 query_lot_dut_bin_agg
  return (
    /关系图|关系|关联|对应|相关\s*dut|和\s*dut|与\s*dut|dut\s*\d{1,3}\s*和\s*bin|bin\s*\d{1,3}\s*和\s*dut/i.test(
      t
    ) ||
    (/(画出|绘制|生成|wafermap|wafer\s*map|晶圆图)/i.test(t) &&
      /\bdut\s*\d{1,3}\b/i.test(t))
  );
}

export function extractDutFromUserText(text: string): number | undefined {
  const m =
    /\bdut\s*[#:=]?\s*(\d{1,3})\b/i.exec(text) ??
    /\bDUT\s*(\d{1,3})\b/.exec(text) ??
    /第\s*(\d{1,3})\s*(?:号\s*)?DUT/i.exec(text);
  if (m) {
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

export function dutBinMapArgsComplete(args: Record<string, unknown>): boolean {
  const device = String(args["device"] ?? "").trim();
  const lot = String(args["lot"] ?? "").trim();
  const slot = args["slot"];
  const dut = args["dut"];
  const bin = args["bin"];
  return (
    device.length > 0 &&
    lot.length > 0 &&
    slot != null &&
    Number.isFinite(Number(slot)) &&
    dut != null &&
    Number.isFinite(Number(dut)) &&
    bin != null &&
    Number.isFinite(Number(bin))
  );
}

/** lot+slot+bin 已齐（device 可后续 JB 反查）即可尝试画 DUT×BIN 关系图。 */
export function dutBinMapArgsReadyForLookup(args: Record<string, unknown>): boolean {
  const lot = String(args["lot"] ?? "").trim();
  const slot = args["slot"];
  const bin = args["bin"];
  return (
    lot.length > 0 &&
    slot != null &&
    Number.isFinite(Number(slot)) &&
    bin != null &&
    Number.isFinite(Number(bin))
  );
}

/** 从会话补全 device/lot/slot/bin/dut/pass_id。 */
export function buildDutBinMapArgsFromSession(
  sessionId: string,
  history: ChatMessage[],
  userText: string
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const waferCtx = normalizeInfDrawWaferMapArgs({}, history);

  const jbCtx = findJbLotContext(history);
  const userLot = extractLotFromUserText(userText);
  const historyLot = String(waferCtx["lot"] ?? "").trim() || jbCtx.lot || "";
  const lot = userLot || historyLot || "";
  out["lot"] = lot;

  // waferCtx["device"] / jbCtx.device 来自历史中最后出现的 lot，可能与刚
  // 解析出的 lot 不是同一个批次（用户切换到会话里未查询过的新 lot）；仅当
  // 两者 lot 一致时才信任该 device，否则留空，交由下方 session 缓存反查
  // 或调用方的 JB 自动补查逻辑取正确 device。
  let device =
    historyLot && lot && historyLot.toUpperCase() === lot.toUpperCase()
      ? String(waferCtx["device"] ?? "").trim() || jbCtx.device || ""
      : "";
  if (lot && !device) {
    const cached = getCachedJbPayloadForLot(sessionId, lot);
    if (cached) device = String(cached["device"] ?? "").trim();
  }
  out["device"] = device;

  const slot =
    extractSlotFromUserText(userText) ??
    (waferCtx["slot"] != null ? Number(waferCtx["slot"]) : undefined);
  if (slot != null && Number.isFinite(slot)) out["slot"] = slot;

  const bin = extractBinNumberFromText(userText);
  if (bin != null) out["bin"] = bin;

  const dut = extractDutFromUserText(userText);
  if (dut != null) out["dut"] = dut;

  const passId =
    inferSinglePassIdFromText(userText) ??
    (waferCtx["passes"] != null ? String(waferCtx["passes"]) : undefined);
  if (passId != null && String(passId).trim()) {
    out["pass_id"] = String(passId) === "composite" ? "final" : passId;
  }

  return out;
}

export function sessionCanDrawDutBinMap(
  sessionId: string,
  history: ChatMessage[],
  userText: string
): boolean {
  if (!userWantsDutBinRelationMap(userText)) return false;
  const args = buildDutBinMapArgsFromSession(sessionId, history, userText);
  if (dutBinMapArgsComplete(args)) return true;
  // device 可缺：服务端用 lot 反查；dut 可缺：按 BIN 最多的 site 推断
  if (dutBinMapArgsReadyForLookup(args)) return true;
  const partial = { ...args };
  delete partial["dut"];
  return infDrawWaferMapArgsComplete(partial) && partial["bin"] != null;
}

/** 首轮缺 device 时注入 system，约束 LLM 只调 query_jb_bins 取 device/lot。 */
export const DUT_BIN_MAP_JB_LOOKUP_NUDGE =
  "【DUT×BIN关系图路由】用户要画某个 BIN 与 DUT 的关系晶圆图（inf_draw_dut_bin_map）。" +
  "若缺 device/lot：**仅**调 query_jb_bins(lot) 取 device/lot，禁止展开 JB 良率/机台/聚集表或长段解读。" +
  "绘图由服务端在工具完成后自动执行。若缺片号（slot/waferId），须向用户询问。" +
  "**禁止**用 query_lot_dut_bin_agg 回答「画出 DUT×BIN 关系图」——那是数量聚合，不是晶圆图。";
