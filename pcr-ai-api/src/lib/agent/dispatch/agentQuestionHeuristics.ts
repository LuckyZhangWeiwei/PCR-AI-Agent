// pcr-ai-api/src/lib/agent/dispatch/agentQuestionHeuristics.ts
// Question-classification heuristics used by the pre-LLM direct routes, extracted from agentLoop.ts.
import {
  extractBinFromUserText,
  isBinCardAttributionQuestion,
  isLotListingQuestion,
} from "../jb/agentJbQuestionClassifiers.js";
import { extractLotFromUserText } from "../tools/agentInfWaferMapTool.js";
import { inferDeviceFromText, inferRecentMonthsWindow } from "../agentQueryScope.js";
import { deviceBaseMask } from "../../deviceMask.js";
import { userWantsDutBinRelationMap } from "../agentDutBinMapRoute.js";

/**
 * 无具体 lot +（时间窗 / 要 lot 列表）→ 跨 lot 场景。
 * 单 lot 的 query_lot_dut_bin_agg 答不了「近3个月哪张卡多 / 列出 lot」。
 */
export function isCrossLotBinCardOrListingScope(text: string): boolean {
  if (extractLotFromUserText(text)) return false;
  if (isLotListingQuestion(text)) return true;
  if (inferRecentMonthsWindow(text).testEndFrom) return true;
  return false;
}

/**
 * 用户是否在问 lot 级 DUT×BIN 集中度（DUT/触点/探针 级，非卡级归因）。
 * - DUT 级意图（dut/触点/探针）→ P-F（query_lot_dut_bin_agg 单 lot DUT 集中度），
 *   即便同时问"哪张卡"也以 DUT 集中度作答（如 P-F 的
 *   "哪个卡 哪个dut 测试出的 bin79 最多"）。
 * - 纯卡级归因（"BINnn 集中在哪张卡"，无 dut）→ 让给 bin_card_attribution 语义派发
 *   （aggregate_jb_bins groupBy:bin,cardId），勿被 P-F 用 history primary lot 抢成
 *   单 lot DUT 集中度（A1-2 误路由根因）。
 * - 跨 lot / 时间窗 / 要 lot 列表（无句中 lot）→ 禁止 P-F：否则会用 history 旧 lot
 *   答「近3个月 + probe card + lot 列表」（2026-07-23 WA00P32P/bin90）。
 */
export function isDutBinConcentrationQuestion(text: string): boolean {
  const focusBin = extractBinFromUserText(text);
  if (focusBin == null) return false;
  // 画 DUT×BIN 关系图 / wafermap → inf_draw_dut_bin_map，禁止 lot 聚合代答
  if (userWantsDutBinRelationMap(text)) return false;
  if (
    /(画出|绘制|生成).{0,12}(关系图|wafer\s*map|wafermap|晶圆图)/i.test(text) ||
    /(关系图|wafermap|晶圆图).{0,20}(dut|bin)/i.test(text)
  ) {
    return false;
  }
  if (isCrossLotBinCardOrListingScope(text)) return false;
  if (/(dut|触点|探针)/i.test(text)) return true;
  if (/(卡|card)/i.test(text)) return !isBinCardAttributionQuestion(text);
  return false;
}

/**
 * 首轮（非 awaitingSummary）用户问题里能否识别出 device / lot / cardId 之一。
 * 用于事后检测「模型只说了要查、却没真正调用工具」——若问题里有明确实体，
 * 正常应该立即触发工具调用（见 prompt/agentPrompt.ts 硬规则），没调用大概率是模型违反了该规则。
 */
export function questionHasIdentifiableToolScope(userQuestion: string): boolean {
  return (
    Boolean(extractLotFromUserText(userQuestion)) ||
    Boolean(inferDeviceFromText(userQuestion)) ||
    isCardProbeTestQuestion(userQuestion)
  );
}

/**
 * 判断用户是否在请求跨批次/多 lot/时间范围的新数据查询。
 * 此类问题不能用 session 缓存（单批次数据）直接作答。
 */
export function requiresNewDataQuery(text: string): boolean {
  // 跨 tester / 机台 比较
  if (/不同.*(tester|机台|测试机)/i.test(text)) return true;
  // 多批次列表
  if (/(各批次|所有批次|多批次|批次.*列表|列表.*批次|lot\s*列表|列表.*lot)/i.test(text)) return true;
  // 时间范围 + 批次 / lot / 卡排行（「近3个月…lot列表」「近3个月…probe card」）
  if (
    /(?:三周|一个月|两个月|三个月|近\s*\d+\s*个?\s*月|过去\s*\d+\s*(?:天|周|月)|最近\s*\d+\s*(?:天|周|月))/i.test(
      text
    ) &&
    /(批次|lot|卡|card|bin\s*\d)/i.test(text)
  ) {
    return true;
  }
  // 消息中含 2 个以上明确的 lot ID（如 DR45487.1K、DR45246.1N...）
  const lots = text.match(/\b[A-Z]{2}\d{5}\.\d[A-Z]\b/g) ?? [];
  if (lots.length >= 2) return true;
  return false;
}

const QUESTION_MASK_TOKEN_RE = /\b([A-Z]\d{2}[A-Z])\b/g;
const QUESTION_LOT_TOKEN_RE = /\b[A-Z]{2}\d{4,5}\.\d[A-Z]?\w*/g;

/**
 * 缓存 JB payload 的产品/批次是否与当前问题不一致——一致才允许直接吐缓存 equipment 表。
 * 返回不一致原因（用于日志），一致返回 null。
 * 防止「N55Z bin35 哪张卡」被上一题 P11C 的 TR21697.1K 缓存张冠李戴回答。
 */
export function cachedJbScopeMismatchReason(
  payload: Record<string, unknown>,
  userQuestion: string
): string | null {
  const q = userQuestion.toUpperCase();
  const device = String(payload["device"] ?? "").trim();
  const payloadMask = deviceBaseMask(device); // 缓存产品 mask（device base 末 4 位）

  // 问题里出现的 mask token 与缓存产品 mask 不一致
  if (payloadMask) {
    for (const m of q.matchAll(QUESTION_MASK_TOKEN_RE)) {
      if (m[1] && m[1] !== payloadMask) {
        return `问题含 mask=${m[1]}，与缓存产品 mask=${payloadMask}（device=${device}）不一致`;
      }
    }
  }

  // 问题里出现的 lot 与缓存 lot（primary + recentLotsByTestEnd）都不匹配
  const cachedLots = new Set<string>();
  const primaryLot = String(payload["lot"] ?? "").trim().toUpperCase();
  if (primaryLot) cachedLots.add(primaryLot);
  const recent = payload["recentLotsByTestEnd"];
  if (Array.isArray(recent)) {
    for (const r of recent) {
      const l = String((r as Record<string, unknown>)?.["lot"] ?? "").trim().toUpperCase();
      if (l) cachedLots.add(l);
    }
  }
  const lotsInQ = [...q.matchAll(QUESTION_LOT_TOKEN_RE)].map((m) => m[0]);
  if (lotsInQ.length > 0 && cachedLots.size > 0 && !lotsInQ.some((l) => cachedLots.has(l))) {
    return `问题含 lot=${lotsInQ.join(",")}，与缓存 lot=${[...cachedLots].join(",")} 不一致`;
  }
  return null;
}

/** 跨多 lot 的「哪个/分析」类问题：缓存只含单批，不能代表整组，禁用 equipment 直连。 */
export function equipmentRouteCrossLotBail(text: string): boolean {
  if (/\d+\s*个\s*(lot|批次)/i.test(text)) return true;
  if (/(请分析|分析).*(哪个|哪些|哪几)/i.test(text)) return true;
  if (/(哪个|哪些).*(lot|批次).*(有关|相关|问题|可能|异常)/i.test(text)) return true;
  return false;
}

/** 检测用户是否在询问特定探针卡（格式如 6045-10）的测试情况。 */
export function isCardProbeTestQuestion(userText: string): boolean {
  return /\b\d{4}-\d{2}\b/.test(userText);
}
