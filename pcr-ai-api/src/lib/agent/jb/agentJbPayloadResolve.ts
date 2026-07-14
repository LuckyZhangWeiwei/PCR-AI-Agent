// pcr-ai-api/src/lib/agent/jb/agentJbPayloadResolve.ts
/** JB 工具 payload 解析/解析优先级 + good bin 直答 + DUT 良率追加判定。 */

import { goodBinIndicesForJbRow } from "../../infcontrol/jbYield/jbYieldRowHelpers.js";
import { getJbToolRawJson } from "../agentJbSessionCache.js";
import { extractLotFromUserText } from "../tools/agentInfWaferMapTool.js";
import {
  isLotListingQuestion,
  isLotOverviewQuestion,
  isMaskLevelQuestionOnMultiLotPayload,
  payloadCoversMultipleLots,
} from "./agentJbQuestionClassifiers.js";

/** 从 query_jb_bins payload 直出良品 bin 编号 + die 数（按 pass 分组）。 */
export function buildGoodBinValueMarkdown(
  toolPayload: Record<string, unknown>
): string | null {
  const rows =
    (toolPayload["rows"] as Record<string, unknown>[] | undefined)?.length
      ? (toolPayload["rows"] as Record<string, unknown>[])
      : (toolPayload["_trendRows"] as Record<string, unknown>[] | undefined);
  if (!rows?.length) return null;

  const byPass = new Map<number, Map<number, number>>();
  for (const row of rows) {
    const passId = Number(row["PASSID"] ?? row["passId"]);
    if (!Number.isInteger(passId)) continue;
    const goodBins = row["goodBins"] as
      | Array<{ bin?: number; dieCount?: number; n?: number; value?: number }>
      | undefined;
    if (goodBins?.length) {
      for (const g of goodBins) {
        const bin = Number(g.bin ?? g.n);
        const die = Number(g.dieCount ?? g.value ?? 0);
        if (!Number.isInteger(bin) || die <= 0) continue;
        let passMap = byPass.get(passId);
        if (!passMap) {
          passMap = new Map();
          byPass.set(passId, passMap);
        }
        passMap.set(bin, (passMap.get(bin) ?? 0) + die);
      }
      continue;
    }
    for (const n of goodBinIndicesForJbRow(row)) {
      let passMap = byPass.get(passId);
      if (!passMap) {
        passMap = new Map();
        byPass.set(passId, passMap);
      }
      if (!passMap.has(n)) passMap.set(n, 0);
    }
  }

  if (byPass.size === 0) return null;

  const lot = String(toolPayload["lot"] ?? "").trim();
  const device = String(toolPayload["device"] ?? "").trim();
  const lotTag = lot ? `Lot ${lot}${device && device !== "—" ? `（${device}）` : ""}` : "本批";
  const lines: string[] = [`**${lotTag} 良品 bin**`, ""];

  for (const passId of [...byPass.keys()].sort((a, b) => a - b)) {
    const bins = byPass.get(passId)!;
    const entries = [...bins.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    lines.push(`### pass${passId}`);
    if (entries.every(([, die]) => die <= 0)) {
      lines.push(`良品 bin 编号：${entries.map(([b]) => `BIN${b}`).join("、")}（payload 未含 die 计数）`);
    } else {
      lines.push("| 良品 bin | die 数 |");
      lines.push("|---:|---:|");
      for (const [bin, die] of entries) {
        lines.push(`| BIN${bin} | ${die} |`);
      }
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

export function parseJbToolPayload(
  raw: string
): Record<string, unknown> | null {
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    return o && typeof o === "object" ? o : null;
  } catch {
    return null;
  }
}

/** 内存缓存优先，否则解析工具 history（含 compact 后的 _trendRows）。 */
export function resolveJbToolPayload(
  sessionId: string,
  toolContent?: string,
  opts?: { preferredLot?: string }
): Record<string, unknown> | null {
  const preferredLot = opts?.preferredLot?.trim();
  const lotMatches = (p: Record<string, unknown>, lot: string): boolean => {
    const pLot = String(p["lot"] ?? p["LOT"] ?? "").trim();
    return (
      pLot.length > 0 && pLot.toUpperCase() === lot.trim().toUpperCase()
    );
  };

  if (preferredLot) {
    const cached = getJbToolRawJson(sessionId);
    if (cached) {
      const p = parseJbToolPayload(cached);
      if (p && lotMatches(p, preferredLot)) return p;
    }
    if (toolContent?.trim()) {
      const fromTool = parseJbToolPayload(toolContent);
      if (fromTool && lotMatches(fromTool, preferredLot)) return fromTool;
    }
    // 会话级缓存可能是其它 lot（如先查 cardId 再查单 lot）→ 勿用错批次的 payload
    if (toolContent?.trim()) return parseJbToolPayload(toolContent);
    return null;
  }

  const cached = getJbToolRawJson(sessionId);
  if (cached) {
    const p = parseJbToolPayload(cached);
    if (p) return p;
  }
  if (toolContent?.trim()) {
    return parseJbToolPayload(toolContent);
  }
  return null;
}

/** lot 概况类问题末尾是否应补各 DUT 良率表（与 mode 解耦，避免 equipment 误判漏 DUT）。 */
export function shouldAppendUnderperformingDutYield(
  userQuestion: string,
  mode: string,
  payload?: Record<string, unknown>
): boolean {
  if (mode === "good_bin_value" || mode === "lot_listing") return false;
  if (isLotListingQuestion(userQuestion)) return false;
  if (payload && payloadCoversMultipleLots(payload)) return false;
  if (payload && isMaskLevelQuestionOnMultiLotPayload(userQuestion, payload)) return false;
  if (mode === "lot_overview" || mode === "generic") return true;
  return (
    isLotOverviewQuestion(userQuestion) &&
    extractLotFromUserText(userQuestion) != null
  );
}
