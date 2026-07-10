/** Extract device / tester / time scope from user text + recent tool calls. */
import type { ChatMessage } from "./agentHistory.js";
import { extractLotFromUserText } from "./agentInfWaferMapTool.js";
import { extractBinFromUserText } from "./agentJbDeterministicReply.js";

export function tryParseToolCallArgs(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function findLastToolCallArgs(
  history: ChatMessage[],
  toolName: string
): Record<string, unknown> | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role !== "assistant" || !msg.tool_calls?.length) continue;
    for (const tc of msg.tool_calls) {
      if (tc.function.name !== toolName) continue;
      return tryParseToolCallArgs(tc.function.arguments);
    }
  }
  return null;
}

export function inferDeviceFromText(text: string): string | undefined {
  const full = text.match(DEVICE_FULL_RE);
  if (full) return full[1]!.toUpperCase();
  const m = text.match(/\b(WA\d{2}P\d{2}[A-Z0-9]+)\b/i);
  return m ? m[1]!.toUpperCase() : undefined;
}

// Full device code = 2 letters + 2 digits + mask(4), e.g. WC13N55Z / WA03P02G.
const DEVICE_FULL_RE = /\b([A-Za-z]{2}\d{2}[A-Za-z]\d{2}[A-Za-z])\b/;
// Standalone 4-char product mask = letter + 2 digits + letter, e.g. N55Z / P02G / N22J.
// Deliberately excludes platform tokens (PS16=letter,letter,digit,digit; J750=letter+3 digits).
const MASK_TOKEN_RE = /\b([A-Za-z]\d{2}[A-Za-z])\b/;

/** Infer a 4-char product mask from a full device code or a standalone mask token. */
export function inferMaskFromText(text: string): string | undefined {
  const dev = text.match(DEVICE_FULL_RE);
  if (dev) return dev[1]!.slice(-4).toUpperCase();
  const m = text.match(MASK_TOKEN_RE);
  if (m) return m[1]!.toUpperCase();
  return undefined;
}

export function inferMaskFromHistory(history: ChatMessage[]): string | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i]!;
    if (msg.role === "user") {
      const m = inferMaskFromText(String(msg.content ?? ""));
      if (m) return m;
    }
    if (msg.role === "assistant" && msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        const args = tryParseToolCallArgs(tc.function.arguments);
        const raw = String(args?.["mask"] ?? "").trim();
        if (raw) return raw.toUpperCase();
        const dev = String(args?.["device"] ?? "").trim();
        const m = inferMaskFromText(dev);
        if (m) return m;
      }
    }
  }
  return undefined;
}

// Platform (TSTYPE) aliases — ps/ps16/ps1600→PS16, 750/j750→J750, flex→FLEX, uflex→UFLEX.
// Order matters: uflex before flex, ps1600 before ps16.
const PLATFORM_PATTERNS: Array<[RegExp, string]> = [
  [/\bps\s*1600\b|\bps1600\b/i, "PS16"],
  [/\bps\s*16\b|\bps16\b/i, "PS16"],
  [/\buflex\b/i, "UFLEX"],
  [/\bflex\b/i, "FLEX"],
  [/\bj\s*750\b|\bj750\b|\b750\b/i, "J750"],
  [/\bmst\b/i, "MST"],
  [/\b93k\b/i, "93K"],
];

/** Infer a canonical TSTYPE platform token (PS16 / J750 / FLEX / UFLEX / MST / 93K). */
export function inferPlatformFromText(text: string): string | undefined {
  for (const [re, canonical] of PLATFORM_PATTERNS) {
    if (re.test(text)) return canonical;
  }
  return undefined;
}

const CARD_ID_RE = /\b(\d{4}-\d{2,3})\b/;

/** 从用户句提取完整探针卡号（dddd-dd / dddd-ddd）。 */
export function inferCardIdFromText(text: string): string | undefined {
  const m = text.match(CARD_ID_RE);
  return m ? m[1] : undefined;
}

/** 从近期对话推断 cardId（用户句、工具参数、YM probeCard）。 */
export function inferCardIdFromHistory(history: ChatMessage[]): string | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i]!;
    if (msg.role === "user") {
      const c = inferCardIdFromText(String(msg.content ?? ""));
      if (c) return c;
    }
    if (msg.role === "assistant") {
      const fromText = inferCardIdFromText(String(msg.content ?? ""));
      if (fromText) return fromText;
      if (msg.tool_calls?.length) {
        for (const tc of msg.tool_calls) {
          const args = tryParseToolCallArgs(tc.function.arguments);
          const cardId = String(
            args?.["cardId"] ?? args?.["probeCard"] ?? ""
          ).trim();
          if (CARD_ID_RE.test(cardId)) return cardId.match(CARD_ID_RE)![1]!;
        }
      }
    }
    if (msg.role === "tool") {
      try {
        const o = JSON.parse(String(msg.content ?? "")) as Record<string, unknown>;
        const cardByPass = o["cardByPassId"] as Array<{ cardId?: string }> | undefined;
        for (const e of cardByPass ?? []) {
          const c = String(e.cardId ?? "").trim();
          if (CARD_ID_RE.test(c)) return c.match(CARD_ID_RE)![1]!;
        }
      } catch {
        /* ignore */
      }
    }
  }
  return undefined;
}

/** 用户是否指代「这张/这个/该」探针卡（需结合 history 解析 cardId）。 */
export function isCardPronounQuestion(text: string): boolean {
  return /这\s*(张|把|个|块)?\s*卡|该卡|此卡/i.test(text.trim());
}

/** JB lot 列表 / 跨 lot 良率问题的统一查询范围（单一真相源）。 */
export type JbListingScope = {
  cardId?: string;
  device?: string;
  testerId?: string;
  tstype?: string;
  mask?: string;
  testEndFrom?: string;
  testEndTo?: string;
};

export function jbListingScopeToQueryArgs(
  scope: JbListingScope
): Record<string, unknown> {
  const args: Record<string, unknown> = { limit: 200 };
  if (scope.cardId) args["cardId"] = scope.cardId;
  if (scope.device) args["device"] = scope.device;
  if (scope.testerId) args["testerId"] = scope.testerId;
  if (scope.tstype) args["tstype"] = scope.tstype;
  if (scope.mask) args["mask"] = scope.mask;
  if (scope.testEndFrom) args["testEndFrom"] = scope.testEndFrom;
  if (scope.testEndTo) args["testEndTo"] = scope.testEndTo;
  return args;
}

export function jbListingScopeLabel(scope: JbListingScope): string {
  const parts: string[] = [];
  if (scope.cardId) parts.push(`cardId=${scope.cardId}`);
  if (scope.device) parts.push(`device=${scope.device}`);
  if (scope.testerId) parts.push(`机台=${scope.testerId}`);
  if (scope.mask) parts.push(`mask=${scope.mask}`);
  if (scope.tstype) parts.push(`platform=${scope.tstype}`);
  return parts.join("，");
}

/** 上轮 query_jb_bins 参数是否与当前解析出的 listing scope 一致。 */
export function jbListingScopeMatchesArgs(
  scope: JbListingScope,
  args: Record<string, unknown> | null
): boolean {
  if (!args) return false;
  if (scope.cardId) {
    return String(args["cardId"] ?? "").trim() === scope.cardId;
  }
  if (String(args["cardId"] ?? "").trim()) return false;
  if (scope.device) {
    const d = String(args["device"] ?? "").trim().toUpperCase();
    if (d !== scope.device.toUpperCase()) return false;
  }
  if (scope.testerId) {
    const t = String(args["testerId"] ?? "").trim().toLowerCase();
    if (t !== scope.testerId.toLowerCase()) return false;
  }
  if (scope.mask) {
    const m = String(args["mask"] ?? "").trim().toUpperCase();
    if (m !== scope.mask.toUpperCase()) return false;
  }
  return true;
}

/**
 * 解析 lot 列表 / 跨 lot 良率问题的 JB 查询范围。
 * 优先级：句中 cardId > 指代卡+history > YM 工具上下文 > device/机台/mask。
 */
export function resolveJbListingScope(
  userQuestion: string,
  history: ChatMessage[] = []
): JbListingScope | null {
  const cardFromText = inferCardIdFromText(userQuestion);
  const cardId =
    cardFromText ??
    (isCardPronounQuestion(userQuestion)
      ? inferCardIdFromHistory(history)
      : undefined);

  const window = resolveRecentTimeWindow(userQuestion, history);

  if (cardId) {
    const scope: JbListingScope = { cardId };
    if (window.testEndFrom) scope.testEndFrom = window.testEndFrom;
    if (window.testEndTo) scope.testEndTo = window.testEndTo;
    return scope;
  }

  const ymArgs =
    findLastToolCallArgs(history, "query_yield_triggers") ??
    findLastToolCallArgs(history, "aggregate_yield_triggers");
  const ymDevice = String(ymArgs?.["device"] ?? "").trim();
  const ymTester = String(
    ymArgs?.["hostname"] ?? ymArgs?.["testerId"] ?? ""
  ).trim();
  if (ymDevice || ymTester) {
    const scope: JbListingScope = {};
    if (ymDevice) scope.device = ymDevice.toUpperCase();
    if (ymTester) scope.testerId = ymTester.toLowerCase();
    const testEndFrom = String(
      ymArgs?.["testEndFrom"] ?? ymArgs?.["timeFrom"] ?? window.testEndFrom ?? ""
    ).trim();
    const testEndTo = String(
      ymArgs?.["testEndTo"] ?? ymArgs?.["timeTo"] ?? window.testEndTo ?? ""
    ).trim();
    if (testEndFrom) scope.testEndFrom = testEndFrom.slice(0, 10);
    if (testEndTo) scope.testEndTo = testEndTo.slice(0, 10);
    return scope;
  }

  const device =
    inferDeviceFromText(userQuestion) || inferDeviceFromHistory(history);
  const testerId =
    inferTesterIdFromText(userQuestion) || inferTesterFromHistory(history);
  const tstype =
    device || testerId
      ? undefined
      : inferPlatformFromText(userQuestion) ||
        inferPlatformFromHistory(history);
  const mask =
    !device && !testerId && !tstype
      ? inferMaskFromText(userQuestion) || inferMaskFromHistory(history)
      : undefined;

  if (!device && !testerId && !tstype && !mask) return null;

  const scope: JbListingScope = {};
  if (device) scope.device = device;
  if (testerId) scope.testerId = testerId;
  if (tstype) scope.tstype = tstype;
  if (mask) scope.mask = mask;
  if (window.testEndFrom) scope.testEndFrom = window.testEndFrom;
  if (window.testEndTo) scope.testEndTo = window.testEndTo;
  return scope;
}

export function inferTesterIdFromText(text: string): string | undefined {
  const b3 = text.match(/(b3(?:uflex|flex|ps16|j750|mst)\d+)/i);
  if (b3) return b3[1]!.toLowerCase();
  const uflex = text.match(/uflex[\s-]*(\d+)/i);
  if (uflex) {
    const n = uflex[1]!.padStart(2, "0");
    return `b3uflex${n}`;
  }
  return undefined;
}

export function inferDeviceFromHistory(history: ChatMessage[]): string | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i]!;
    if (msg.role === "user") {
      const d = inferDeviceFromText(String(msg.content ?? ""));
      if (d) return d;
    }
    if (msg.role === "tool") {
      try {
        const o = JSON.parse(String(msg.content ?? "")) as Record<string, unknown>;
        const d = String(o["device"] ?? "").trim();
        if (/^WA\d/i.test(d)) return d.toUpperCase();
      } catch {
        /* ignore */
      }
    }
    if (msg.role === "assistant" && msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        const args = tryParseToolCallArgs(tc.function.arguments);
        const d = String(args?.["device"] ?? "").trim();
        if (/^WA\d/i.test(d)) return d.toUpperCase();
      }
    }
  }
  return undefined;
}

/** 从用户句 + 近期 history 推断 lot（含单 lot 缓存 payload）。 */
export function inferLotFromHistory(history: ChatMessage[]): string | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i]!;
    if (msg.role === "user") {
      const lot = extractLotFromUserText(String(msg.content ?? ""));
      if (lot) return lot;
    }
    if (msg.role === "tool" && msg.name === "query_jb_bins") {
      try {
        const o = JSON.parse(String(msg.content ?? "")) as Record<string, unknown>;
        const lot = String(o["lot"] ?? o["primaryLot"] ?? "").trim();
        if (lot) return lot;
      } catch {
        /* ignore */
      }
    }
  }
  return undefined;
}

export function inferTesterFromHistory(history: ChatMessage[]): string | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i]!;
    if (msg.role === "user") {
      const t = inferTesterIdFromText(String(msg.content ?? ""));
      if (t) return t;
    }
    if (msg.role === "assistant" && msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        const args = tryParseToolCallArgs(tc.function.arguments);
        const t = String(args?.["hostname"] ?? args?.["testerId"] ?? "").trim();
        if (/^b3/i.test(t)) return t.toLowerCase();
      }
    }
  }
  return undefined;
}

type TimeWindow = {
  testEndFrom?: string;
  testEndTo?: string;
  timeFrom?: string;
  timeTo?: string;
};

function windowFromDays(days: number): TimeWindow {
  const now = new Date();
  const from = new Date(now);
  from.setDate(from.getDate() - days);
  const fromStr = from.toISOString().slice(0, 10);
  return {
    testEndFrom: fromStr,
    testEndTo: now.toISOString().slice(0, 10),
    timeFrom: `${fromStr}T00:00:00.000Z`,
    timeTo: now.toISOString(),
  };
}

function windowFromMonths(months: number): TimeWindow {
  const now = new Date();
  const from = new Date(now);
  const targetMonth = now.getMonth() - months;
  from.setMonth(targetMonth);
  // setMonth can overflow (e.g. May 31 → Feb 31 → Mar 3); clamp to last day of intended month
  if (from.getMonth() !== ((targetMonth % 12) + 12) % 12) {
    from.setDate(0);
  }
  const fromStr = from.toISOString().slice(0, 10);
  return {
    testEndFrom: fromStr,
    testEndTo: now.toISOString().slice(0, 10),
    timeFrom: `${fromStr}T00:00:00.000Z`,
    timeTo: now.toISOString(),
  };
}

const ZH_NUM: Record<string, number> = {
  一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6,
  七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12,
};

/**
 * Infer a recent time window from natural language: week / N weeks / month /
 * N months / half year / year. Returns {} when no duration phrase is present.
 * Name kept for backward compatibility (callers treat {} as "no window").
 */
export function inferRecentMonthsWindow(text: string): TimeWindow {
  // ── day(s) ──
  const dayArabic = text.match(/(?:最近|近|过去|这|本)\s*(\d+)\s*(?:个)?\s*天/);
  if (dayArabic) {
    const n = Number(dayArabic[1]);
    if (n > 0 && n <= 365) return windowFromDays(n);
  }
  const dayZh = text.match(/(?:最近|近|过去|这|本)\s*([一两二三四五六七八九十]+)\s*(?:个)?\s*天/);
  if (dayZh) {
    const n = ZH_NUM[dayZh[1]!];
    if (n) return windowFromDays(n);
  }
  // ── week(s) ──
  if (/最近\s*7\s*天|近\s*7\s*天|过去\s*7\s*天/.test(text)) return windowFromDays(7);
  const wkArabic = text.match(/(?:最近|近|过去|这|本)?\s*(\d+)\s*(?:个)?\s*(?:周|星期|礼拜)/);
  if (wkArabic) {
    const n = Number(wkArabic[1]);
    if (n > 0 && n <= 52) return windowFromDays(7 * n);
  }
  if (/(?:最近|近|过去|这|本|上)\s*[一1]?\s*(?:个)?\s*(?:周|星期|礼拜)/.test(text)) {
    return windowFromDays(7);
  }

  // ── year ──
  if (/(?:最近|近|过去)\s*[一1]\s*年|[一1]\s*年内|今年以来|过去\s*一\s*年/.test(text)) {
    return windowFromMonths(12);
  }
  // ── half year ──
  if (/(?:最近|近|过去)?\s*半\s*年/.test(text)) return windowFromMonths(6);

  // ── N months (Arabic) ──
  const moArabic = text.match(/(?:最近|近|过去|这|本)\s*(\d+)\s*个?\s*月/);
  if (moArabic) {
    const n = Number(moArabic[1]);
    if (n > 0 && n <= 24) return windowFromMonths(n);
  }
  // ── N months (Chinese numeral) ──
  const moZh = text.match(/(?:最近|近|过去|这|本)\s*([一两二三四五六七八九十]+)\s*个?\s*月/);
  if (moZh) {
    const n = ZH_NUM[moZh[1]!];
    if (n) return windowFromMonths(n);
  }
  // ── single month phrases ──
  if (/(?:最近|近|过去|这|本|上)\s*[一1]?\s*个?\s*月/.test(text)) {
    return windowFromMonths(1);
  }
  return {};
}

/** 当前句有时间短语则用当前句，否则从 history 继承（避免 `{}` truthy 阻断 fallback）。 */
export function resolveRecentTimeWindow(
  text: string,
  history: ChatMessage[] = []
): TimeWindow {
  const fromText = inferRecentMonthsWindow(text);
  if (fromText.testEndFrom) return fromText;
  return inferRecentMonthsWindowFromHistory(history);
}

/** Build query_jb_bins args from YM tool call + user question. */
export function buildJbScopeArgs(
  userQuestion: string,
  history: ChatMessage[],
  _lastToolName: string
): Record<string, unknown> | null {
  const scope = resolveJbListingScope(userQuestion, history);
  if (!scope) return null;
  if (!scope.cardId && !scope.device && !scope.testerId && !scope.mask) {
    return null;
  }
  return jbListingScopeToQueryArgs(scope);
}

export function buildAggregateJbBinsScopeArgs(
  userQuestion: string,
  history: ChatMessage[],
  jbPayload: Record<string, unknown>
): Record<string, unknown> | null {
  const jbArgs = findLastToolCallArgs(history, "query_jb_bins");
  const listingScope = resolveJbListingScope(userQuestion, history);
  const cardId =
    String(jbArgs?.["cardId"] ?? "").trim() ||
    listingScope?.cardId ||
    "";
  const device =
    String(jbPayload["device"] ?? jbArgs?.["device"] ?? "").trim() ||
    inferDeviceFromText(userQuestion) ||
    inferDeviceFromHistory(history);
  const testerId =
    String(jbPayload["testerId"] ?? jbArgs?.["testerId"] ?? "").trim() ||
    inferTesterIdFromText(userQuestion) ||
    inferTesterFromHistory(history);
  if (!device && !testerId && !cardId) return null;

  const window = inferRecentMonthsWindow(userQuestion);
  const args: Record<string, unknown> = {
    groupBy: "lot,bin",
    groupTop: 50,
  };
  if (device) args["device"] = device;
  if (testerId) args["testerId"] = testerId;
  if (cardId) args["cardId"] = cardId;
  const testEndFrom = String(jbArgs?.["testEndFrom"] ?? window.testEndFrom ?? "").trim();
  const testEndTo = String(jbArgs?.["testEndTo"] ?? window.testEndTo ?? "").trim();
  if (testEndFrom) args["testEndFrom"] = testEndFrom.slice(0, 10);
  if (testEndTo) args["testEndTo"] = testEndTo.slice(0, 10);
  return args;
}

/** 从用户句 + 可选 history 构造 lot 列表 query_jb_bins 参数。 */
export function buildLotListingQueryArgs(
  userQuestion: string,
  history: ChatMessage[] = []
): Record<string, unknown> | null {
  const scope = resolveJbListingScope(userQuestion, history);
  return scope ? jbListingScopeToQueryArgs(scope) : null;
}

function inferPlatformFromHistory(history: ChatMessage[]): string | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]?.role !== "user") continue;
    const p = inferPlatformFromText(String(history[i]!.content ?? ""));
    if (p) return p;
  }
  return undefined;
}

export { inferPlatformFromHistory };

/** 从近期 user 句继承「最近 N 天/月」时间窗（P-B 第二轮「都测试了什么lot」）。 */
export function inferRecentMonthsWindowFromHistory(
  history: ChatMessage[]
): TimeWindow {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]?.role !== "user") continue;
    const w = inferRecentMonthsWindow(String(history[i]!.content ?? ""));
    if (w.testEndFrom) return w;
  }
  return {};
}

/** 跨 lot 坏 BIN 排行：device / mask / tester / platform + 时间窗，groupBy bin。 */
export function buildScopedBadBinAggregateArgs(
  userQuestion: string,
  history: ChatMessage[] = [],
  jbPayload?: Record<string, unknown>
): Record<string, unknown> | null {
  const jbArgs = findLastToolCallArgs(history, "query_jb_bins");
  const device =
    inferDeviceFromText(userQuestion) ||
    inferDeviceFromHistory(history) ||
    String(jbPayload?.["device"] ?? jbArgs?.["device"] ?? "").trim() ||
    undefined;
  const testerId =
    inferTesterIdFromText(userQuestion) ||
    inferTesterFromHistory(history) ||
    String(jbPayload?.["testerId"] ?? jbArgs?.["testerId"] ?? "").trim() ||
    undefined;
  // mask / platform are broader fallbacks when no specific device/tester present.
  const mask = device
    ? undefined
    : inferMaskFromText(userQuestion) || inferMaskFromHistory(history);
  const tstype =
    device || testerId || mask
      ? undefined
      : inferPlatformFromText(userQuestion) || inferPlatformFromHistory(history);
  if (!device && !testerId && !mask && !tstype) return null;

  const window = resolveRecentTimeWindow(userQuestion, history);
  const args: Record<string, unknown> = {
    groupBy: "bin",
    groupTop: 20,
  };
  if (device) args["device"] = device;
  if (testerId) args["testerId"] = testerId;
  if (mask) args["mask"] = mask;
  if (tstype) args["tstype"] = tstype;
  const testEndFrom = String(jbArgs?.["testEndFrom"] ?? window.testEndFrom ?? "").trim();
  const testEndTo = String(jbArgs?.["testEndTo"] ?? window.testEndTo ?? "").trim();
  if (testEndFrom) args["testEndFrom"] = testEndFrom.slice(0, 10);
  if (testEndTo) args["testEndTo"] = testEndTo.slice(0, 10);
  return args;
}

/** 「哪个 lot BINnn 最多」：aggregate_jb_bins(groupBy:"bin,lot") + 按指定 bin 排 lot。 */
export function buildBinLotRankingAggregateArgs(
  userQuestion: string,
  history: ChatMessage[] = []
): Record<string, unknown> | null {
  const focusBin = extractBinFromUserText(userQuestion);
  if (focusBin == null) return null;

  const jbArgs = findLastToolCallArgs(history, "query_jb_bins");
  const device =
    inferDeviceFromText(userQuestion) ||
    inferDeviceFromHistory(history) ||
    String(jbArgs?.["device"] ?? "").trim() ||
    undefined;
  const testerId =
    inferTesterIdFromText(userQuestion) ||
    inferTesterFromHistory(history) ||
    String(jbArgs?.["testerId"] ?? "").trim() ||
    undefined;
  const mask = device
    ? undefined
    : inferMaskFromText(userQuestion) || inferMaskFromHistory(history);
  const tstype =
    device || testerId || mask
      ? undefined
      : inferPlatformFromText(userQuestion) || inferPlatformFromHistory(history);
  if (!device && !testerId && !mask && !tstype) return null;

  const window = resolveRecentTimeWindow(userQuestion, history);
  const args: Record<string, unknown> = {
    groupBy: "bin,lot",
    groupTop: 50,
  };
  if (device) args["device"] = device;
  if (testerId) args["testerId"] = testerId;
  if (mask) args["mask"] = mask;
  if (tstype) args["tstype"] = tstype;
  const testEndFrom = String(jbArgs?.["testEndFrom"] ?? window.testEndFrom ?? "").trim();
  const testEndTo = String(jbArgs?.["testEndTo"] ?? window.testEndTo ?? "").trim();
  if (testEndFrom) args["testEndFrom"] = testEndFrom.slice(0, 10);
  if (testEndTo) args["testEndTo"] = testEndTo.slice(0, 10);
  return args;
}

export function buildScopeLabelFromAggregateArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  const device = String(args["device"] ?? "").trim();
  const mask = String(args["mask"] ?? "").trim();
  const tstype = String(args["tstype"] ?? "").trim();
  const tester = String(args["testerId"] ?? "").trim();
  if (device) parts.push(device);
  if (mask) parts.push(`mask ${mask}`);
  if (tstype) parts.push(`平台 ${tstype}`);
  if (tester) parts.push(`@${tester}`);
  const from = String(args["testEndFrom"] ?? "").trim().slice(0, 10);
  const to = String(args["testEndTo"] ?? "").trim().slice(0, 10);
  if (from && to) parts.push(`${from}～${to}`);
  return parts.join(" ") || "查询范围";
}
