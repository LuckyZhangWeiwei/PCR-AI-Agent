/**
 * A 路谓词/参数：识别「lot 内哪些 DUT 良率偏低」类问句，供 PRE_LLM 直连路由
 * tryRunUnderperformingDutDirectRoute 使用。必须有 DUT 级低良率意图 + 可解析 lot。
 */

import type { ChatMessage } from "./agentHistory.js";
import { extractLotFromUserText } from "./agentInfWaferMapTool.js";
import {
  inferDeviceFromHistory,
  inferDeviceFromText,
  inferLotFromHistory,
} from "./agentQueryScope.js";

export function isLotUnderperformingDutQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // 必须是 DUT / 探针 / 触点 / site 级（"哪张卡良率最低" 是卡级，不在此列）
  if (!/dut|探针|触点|\bsite\b/i.test(t)) return false;
  // 低良率 / 偏低 / 低于平均 意图
  return /低良率|良率\s*(低|差|偏低)|偏低|低于\s*(平均|阈值|均值)|拖后腿|表现\s*差|underperform/i.test(t);
}

export function canRunUnderperformingDutDirectRoute(
  userText: string,
  history: ChatMessage[] = []
): boolean {
  if (!isLotUnderperformingDutQuestion(userText)) return false;
  const lot = extractLotFromUserText(userText) || inferLotFromHistory(history);
  return Boolean(lot);
}

export function underperformingDutArgsFromText(
  userText: string,
  history: ChatMessage[] = []
): { lot: string; device?: string } | null {
  const lot = extractLotFromUserText(userText) || inferLotFromHistory(history);
  if (!lot) return null;
  const device =
    inferDeviceFromText(userText) || inferDeviceFromHistory(history) || undefined;
  return { lot, device };
}
