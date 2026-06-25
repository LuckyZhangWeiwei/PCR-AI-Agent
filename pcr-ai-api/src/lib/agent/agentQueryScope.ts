/** Extract device / tester / time scope from user text + recent tool calls. */
import type { ChatMessage } from "./agentHistory.js";

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

/** Build query_jb_bins args from YM tool call + user question. */
export function buildJbScopeArgs(
  userQuestion: string,
  history: ChatMessage[],
  lastToolName: string
): Record<string, unknown> | null {
  const ymArgs =
    findLastToolCallArgs(history, lastToolName) ??
    findLastToolCallArgs(history, "query_yield_triggers") ??
    findLastToolCallArgs(history, "aggregate_yield_triggers");
  const device =
    String(ymArgs?.["device"] ?? "").trim() ||
    inferDeviceFromText(userQuestion) ||
    inferDeviceFromHistory(history);
  const testerId =
    String(ymArgs?.["hostname"] ?? ymArgs?.["testerId"] ?? "").trim() ||
    inferTesterIdFromText(userQuestion) ||
    inferTesterFromHistory(history);
  if (!device && !testerId) return null;

  const window = inferRecentMonthsWindow(userQuestion);
  const args: Record<string, unknown> = { limit: 200 };
  if (device) args["device"] = device;
  if (testerId) args["testerId"] = testerId;

  const testEndFrom = String(ymArgs?.["testEndFrom"] ?? window.testEndFrom ?? "").trim();
  const testEndTo = String(ymArgs?.["testEndTo"] ?? window.testEndTo ?? "").trim();
  if (testEndFrom) args["testEndFrom"] = testEndFrom.slice(0, 10);
  if (testEndTo) args["testEndTo"] = testEndTo.slice(0, 10);

  return args;
}

export function buildAggregateJbBinsScopeArgs(
  userQuestion: string,
  history: ChatMessage[],
  jbPayload: Record<string, unknown>
): Record<string, unknown> | null {
  const jbArgs = findLastToolCallArgs(history, "query_jb_bins");
  const device =
    String(jbPayload["device"] ?? jbArgs?.["device"] ?? "").trim() ||
    inferDeviceFromText(userQuestion) ||
    inferDeviceFromHistory(history);
  const testerId =
    String(jbPayload["testerId"] ?? jbArgs?.["testerId"] ?? "").trim() ||
    inferTesterIdFromText(userQuestion) ||
    inferTesterFromHistory(history);
  const cardId = String(jbArgs?.["cardId"] ?? "").trim();
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
  const fromYm = buildJbScopeArgs(userQuestion, history, "query_yield_triggers");
  if (fromYm?.["device"] || fromYm?.["testerId"]) return fromYm;

  const device =
    inferDeviceFromText(userQuestion) || inferDeviceFromHistory(history);
  const testerId =
    inferTesterIdFromText(userQuestion) || inferTesterFromHistory(history);
  if (!device && !testerId) return null;

  const window = inferRecentMonthsWindow(userQuestion);
  const args: Record<string, unknown> = { limit: 200 };
  if (device) args["device"] = device;
  if (testerId) args["testerId"] = testerId;
  if (window.testEndFrom) args["testEndFrom"] = window.testEndFrom;
  if (window.testEndTo) args["testEndTo"] = window.testEndTo;
  return args;
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
    device || testerId || mask ? undefined : inferPlatformFromText(userQuestion);
  if (!device && !testerId && !mask && !tstype) return null;

  const window = inferRecentMonthsWindow(userQuestion);
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
