/**
 * A2-4 兜底：bin 归因/排行类问句，句中带**无法识别**的疑似 scope token（如 ZZZZZ），
 * 且 device / mask / tester / platform / lot / 时间窗均无法解析时，确定性输出澄清，
 * 避免 LLM 拿着无效 scope 空转到 250s idle 超时（dead-end）。
 *
 * 注意：纯中文、无疑似 scope token 的问句（如"哪片卡 bin35 出得最多"）**不**在此拦截，
 * 仍交 LLM 澄清（现有行为，已判可接受）。此路由只把"带无效 token 会空转"的场景变成
 * 快速澄清，blast radius 仅限原本会 dead-end 的问句。
 */

import type { ChatMessage } from "./agentHistory.js";
import { extractLotFromUserText } from "./tools/agentInfWaferMapTool.js";
import {
  extractBinFromUserText,
  isBadBinRankingQuestion,
  isBinCardAttributionQuestion,
  isBinLotRankingQuestion,
} from "./jb/agentJbQuestionClassifiers.js";
import {
  inferDeviceFromHistory,
  inferDeviceFromText,
  inferLotFromHistory,
  inferMaskFromHistory,
  inferMaskFromText,
  inferPlatformFromHistory,
  inferPlatformFromText,
  inferTesterFromHistory,
  inferTesterIdFromText,
  resolveRecentTimeWindow,
} from "./agentQueryScope.js";

// 全大写 ≥4 字母的疑似 scope token 里，需排除的已知业务词（非 scope）。
const KNOWN_UPPER_TOKENS = new Set([
  "BIN",
  "DUT",
  "CARD",
  "CARDID",
  "LOT",
  "PASS",
  "SORT",
  "WAFER",
  "SLOT",
  "TEST",
  "YIELD",
  "STAR",
  "PROBE",
]);

/** 句中"疑似 scope 但无法识别"的全大写 token（≥4 连续字母，非已知业务词）。 */
export function findUnrecognizedScopeToken(text: string): string | null {
  for (const m of text.matchAll(/\b([A-Z]{4,}\d*)\b/g)) {
    const tok = m[1];
    if (KNOWN_UPPER_TOKENS.has(tok)) continue;
    if (/^BIN\d+$/i.test(tok)) continue;
    return tok;
  }
  return null;
}

/**
 * 是否应对该 bin 问句走"无效 scope 澄清"兜底。
 * 全部满足：① 有 BIN 编号；② 是 bin 归因/坏 bin 排行/BIN×lot 排行类问句；
 * ③ 无 lot（句 + history）；④ device/mask/tester/platform 均无法解析；
 * ⑤ 无时间窗；⑥ 句中存在无法识别的疑似 scope token。
 */
export function canRunUnscopedBinClarify(
  userText: string,
  history: ChatMessage[] = []
): boolean {
  if (extractBinFromUserText(userText) == null) return false;

  const scopedBinQuestion =
    isBinCardAttributionQuestion(userText) ||
    isBadBinRankingQuestion(userText) ||
    isBinLotRankingQuestion(userText);
  if (!scopedBinQuestion) return false;

  if (extractLotFromUserText(userText) || inferLotFromHistory(history)) return false;

  const hasScope = Boolean(
    inferDeviceFromText(userText) ||
      inferDeviceFromHistory(history) ||
      inferMaskFromText(userText) ||
      inferMaskFromHistory(history) ||
      inferTesterIdFromText(userText) ||
      inferTesterFromHistory(history) ||
      inferPlatformFromText(userText) ||
      inferPlatformFromHistory(history)
  );
  if (hasScope) return false;

  if (resolveRecentTimeWindow(userText, history).testEndFrom) return false;

  return findUnrecognizedScopeToken(userText) != null;
}

export function buildUnscopedBinClarifyMessage(userText: string): string {
  const bin = extractBinFromUserText(userText);
  const bogus = findUnrecognizedScopeToken(userText);
  return (
    `未能识别 “${bogus}” 对应的 device / lot / mask / 机台，` +
    `无法定位${bin != null ? ` BIN${bin} ` : "所查 BIN "}的数据范围。\n\n` +
    "请补充以下任一信息后重试：\n" +
    "- 具体 **lot**（如 NF13322.1J）\n" +
    "- **device** 或 **mask**（如 WA03P02G / N55Z）\n" +
    "- **机台 / tester**（如 UF3-07）\n" +
    "- 或时间范围（如“最近一个月”）"
  );
}
