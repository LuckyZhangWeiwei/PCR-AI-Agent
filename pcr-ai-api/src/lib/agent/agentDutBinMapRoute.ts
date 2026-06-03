/**
 * DUT × BIN 关系晶圆图路由：须用 inf_draw_dut_bin_map，禁止误走 inf_draw_wafer_map 的 BIN 高亮。
 */

import type { ChatMessage } from "./agentHistory.js";
import {
  extractBinNumberFromText,
  findJbLotContext,
  findLastInfDrawWaferMapContext,
  infDrawWaferMapArgsComplete,
  normalizeInfDrawWaferMapArgs,
} from "./agentInfWaferMapTool.js";

/** 「BIN15 与 DUT 关系」类问题（图案图：横线/竖线/白块）。 */
export function userWantsDutBinRelationMap(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  const bin = extractBinNumberFromText(t);
  if (bin == null) return false;
  if (!/\bdut\b|DUT|site|探针|map\s*site/i.test(t)) return false;
  return /关系|关联|分布|对应|哪.*dut|哪个\s*dut|相关\s*dut|和\s*dut|与\s*dut/i.test(t);
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

/** 从会话补全 device/lot/slot/bin/dut/pass_id。 */
export function buildDutBinMapArgsFromSession(
  history: ChatMessage[],
  userText: string
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const prev = findLastInfDrawWaferMapContext(history);
  const jb = findJbLotContext(history);
  const waferCtx = normalizeInfDrawWaferMapArgs({}, history);

  out["device"] = prev?.device ?? jb.device ?? waferCtx["device"] ?? "";
  out["lot"] = prev?.lot ?? jb.lot ?? waferCtx["lot"] ?? "";
  if (waferCtx["slot"] != null) out["slot"] = waferCtx["slot"];

  const bin = extractBinNumberFromText(userText);
  if (bin != null) out["bin"] = bin;

  const dut = extractDutFromUserText(userText);
  if (dut != null) out["dut"] = dut;

  const passId = waferCtx["passes"];
  if (passId != null && String(passId).trim()) {
    out["pass_id"] = String(passId) === "composite" ? "final" : passId;
  }

  return out;
}

export function sessionCanDrawDutBinMap(
  history: ChatMessage[],
  userText: string
): boolean {
  if (!userWantsDutBinRelationMap(userText)) return false;
  const args = buildDutBinMapArgsFromSession(history, userText);
  if (dutBinMapArgsComplete(args)) return true;
  // dut 可缺省，由服务端按 BIN 最多的 site 推断
  const partial = { ...args };
  delete partial["dut"];
  return infDrawWaferMapArgsComplete(partial) && partial["bin"] != null;
}
