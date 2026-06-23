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

export function inferRecentMonthsWindow(text: string): {
  testEndFrom?: string;
  testEndTo?: string;
  timeFrom?: string;
  timeTo?: string;
} {
  const now = new Date();
  const to = now.toISOString().slice(0, 10);
  if (/[这近]?\s*[三3]\s*个?月|最近\s*[三3]\s*个?月/.test(text)) {
    const from = new Date(now);
    from.setMonth(from.getMonth() - 3);
    const fromStr = from.toISOString().slice(0, 10);
    return {
      testEndFrom: fromStr,
      testEndTo: to,
      timeFrom: `${fromStr}T00:00:00.000Z`,
      timeTo: now.toISOString(),
    };
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

/** 跨 lot 坏 BIN 排行：device + tester + 时间窗，groupBy bin。 */
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
  if (!device && !testerId) return null;

  const window = inferRecentMonthsWindow(userQuestion);
  const args: Record<string, unknown> = {
    groupBy: "bin",
    groupTop: 20,
  };
  if (device) args["device"] = device;
  if (testerId) args["testerId"] = testerId;
  const testEndFrom = String(jbArgs?.["testEndFrom"] ?? window.testEndFrom ?? "").trim();
  const testEndTo = String(jbArgs?.["testEndTo"] ?? window.testEndTo ?? "").trim();
  if (testEndFrom) args["testEndFrom"] = testEndFrom.slice(0, 10);
  if (testEndTo) args["testEndTo"] = testEndTo.slice(0, 10);
  return args;
}

export function buildScopeLabelFromAggregateArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  const device = String(args["device"] ?? "").trim();
  const tester = String(args["testerId"] ?? "").trim();
  if (device) parts.push(device);
  if (tester) parts.push(`@${tester}`);
  const from = String(args["testEndFrom"] ?? "").trim().slice(0, 10);
  const to = String(args["testEndTo"] ?? "").trim().slice(0, 10);
  if (from && to) parts.push(`${from}～${to}`);
  return parts.join(" ") || "查询范围";
}
