/**
 * Summary-round structured output validator.
 *
 * After the LLM produces its conclusion text (already streamed to the client),
 * extract verifiable claims and check each against the structured tool-result data.
 * On any mismatch, append a visible ⚠️ correction note so the user can act on it.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY NOT RETRY?
 *   The text is already on the wire. We cannot unsend it. Retrying would show
 *   duplicate text to the user. A clearly labeled correction note is less
 *   disruptive and equally actionable.
 *
 * FALSE-POSITIVE MITIGATION:
 *   • Lot ID check only fires when knownLots is non-empty.
 *   • Yield check uses ±8 pp tolerance (rounding, single-slot vs aggregate).
 *   • Slot count check uses ±2 tolerance.
 *   • Cross-tool lot check only fires when BOTH JB and YM tools ran.
 *   • Card ID and device checks only fire when the respective sets are non-empty.
 *   • Returns on the FIRST mismatch found (one clear note is more useful than a flood).
 *
 * ADDING NEW CHECKS:
 *   Add to factCheckSummaryText() in priority order.
 *   Add a matching entry to buildFactSheetFromHistory() if new data is needed.
 *   Add a test case in test/agentFactChecker.test.ts.
 * ────────────────────────────────────────────────────────────────────────────
 */

import type { ChatMessage } from "./agentHistory.js";
import { tryParseJsonish } from "./agentChartTool.js";

// ── Fact Sheet ────────────────────────────────────────────────────────────────

export type FactSheet = {
  /** All lot IDs appearing in any tool result. */
  knownLots: Set<string>;

  /** Lots that appeared ONLY in JB tool results (query_jb_bins / aggregate_jb_bins). */
  jbLots: Set<string>;

  /** Lots that appeared ONLY in YM tool results (query_yield_triggers / aggregate_yield_triggers). */
  ymLots: Set<string>;

  /** totalDistinctLots from query_jb_bins, if present. */
  totalDistinctLots: number | null;

  /** Probe card IDs (dddd-dd) from cardByPassId arrays in JB results. */
  knownCardIds: Set<string>;

  /** Device codes (WA-prefix) from the device field in any tool result. */
  knownDevices: Set<string>;

  /**
   * Slot count for the primary lot (pass1 distinct slots from slotYieldSummary,
   * or distinctSlots.length from the JB tool result).
   */
  slotCount: number | null;

  /** passId → aggregate yieldPct (%) computed from yieldByPassId in the JB result. */
  yieldByPassId: Map<number, number>;
};

// ── Fact Check Result ─────────────────────────────────────────────────────────

export type FactCheckResult =
  | { ok: true }
  | { ok: false; issue: string };

// ── Regex patterns ────────────────────────────────────────────────────────────

/** Standard lot ID: two uppercase letters + 5 digits + dot + digit + letter  (e.g. DR45721.1K) */
const LOT_PATTERN = /\b([A-Z]{2}\d{5}\.\d[A-Z])\b/g;

/** Probe card ID: dddd-dd (e.g. 6045-10) */
const CARD_ID_PATTERN = /\b(\d{4}-\d{2})\b/g;

/** Device code: WA + ≥6 alphanumeric chars (e.g. WA88888822N95G) */
const DEVICE_PATTERN = /\b(WA[A-Z0-9]{6,})\b/g;

/** "共 N 片" / "测试了 N 片" lot-wafer count claims */
const SLOT_COUNT_PATTERNS = [
  /共\s*(\d+)\s*片/,
  /测试.*?(\d+)\s*片/,
  /(?:全部|所有).*?(\d+)\s*片/,
];

/** "共 N 个 lot" / "共 N 批次" lot-count claims */
const LOT_COUNT_PATTERNS = [
  /共\s*(\d+)\s*个?\s*lot/,
  /共\s*(\d+)\s*个?批次/,
  /共\s*(\d+)\s*批次/,
  /共\s*(\d+)\s*个?\s*批/,
  /测试了?\s*(\d+)\s*个?\s*lot/,
];

/**
 * Yield claims with pass/sort/temperature context.
 * Groups: [1] passKeyword (pass|sort), [2] passNumber, [3] temperature,
 *         [4+] ignored context, [5] yieldPctStr
 * We extract passId and claimedYield from a single combined scan.
 */
const YIELD_CLAIM_RE =
  /(?:(?:pass\s*([135])|sort\s*([123])|(高温|低温|常温))[\s\S]{0,40}?良率[\s\S]{0,15}?([\d.]+)\s*%|良率[\s\S]{0,15}?([\d.]+)\s*%[\s\S]{0,30}?(?:pass\s*([135])|sort\s*([123])|(高温|低温|常温)))/gi;

/** JB-domain keywords that indicate the text is discussing wafer test data */
const JB_CONTEXT_RE = /\b(BIN\s*\d+|slot\s*\d+|坏\s*die|中断|CARDID|探针卡|wafer|良率[^，。]{0,10}pass)\b/i;

// ── Build Fact Sheet ──────────────────────────────────────────────────────────

/** JB tool names */
const JB_TOOL_NAMES = new Set(["query_jb_bins", "aggregate_jb_bins", "query_lot_dut_bin_agg"]);
/** YM tool names */
const YM_TOOL_NAMES = new Set(["query_yield_triggers", "aggregate_yield_triggers"]);

function addLotsFromObj(parsed: Record<string, unknown>, dest: Set<string>): void {
  const lot = String(parsed["lot"] ?? "").trim();
  if (lot) dest.add(lot);

  const recent = parsed["recentLotsByTestEnd"];
  if (Array.isArray(recent)) {
    for (const r of recent as Array<Record<string, unknown>>) {
      const l = String(r["lot"] ?? "").trim();
      if (l) dest.add(l);
    }
  }

  const rank = parsed["lotYieldRankByTestEnd"];
  if (Array.isArray(rank)) {
    for (const r of rank as Array<Record<string, unknown>>) {
      const l = String(r["lot"] ?? "").trim();
      if (l) dest.add(l);
    }
  }
}

function addLotsFromRows(parsed: Record<string, unknown>, dest: Set<string>): void {
  const rows = parsed["rows"];
  if (Array.isArray(rows)) {
    for (const row of rows as Array<Record<string, unknown>>) {
      const l = String(row["LOTID"] ?? row["lot"] ?? "").trim();
      if (l) dest.add(l);
    }
  }
}

export function buildFactSheetFromHistory(history: ChatMessage[]): FactSheet {
  const knownLots = new Set<string>();
  const jbLots = new Set<string>();
  const ymLots = new Set<string>();
  const knownCardIds = new Set<string>();
  const knownDevices = new Set<string>();
  const yieldByPassId = new Map<number, number>();
  let totalDistinctLots: number | null = null;
  let slotCount: number | null = null;

  for (const msg of history) {
    if (msg.role !== "tool") continue;
    const content = typeof msg.content === "string" ? msg.content : "";
    if (!content.trim().startsWith("{")) continue;

    const parsed = tryParseJsonish(content) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object") continue;

    const toolName = msg.name ?? "";

    // ── Device codes ──────────────────────────────────────────────────────────
    const dev = String(parsed["device"] ?? "").trim();
    if (dev) knownDevices.add(dev);

    // ── Lots by tool domain ───────────────────────────────────────────────────
    if (JB_TOOL_NAMES.has(toolName)) {
      addLotsFromObj(parsed, jbLots);
      addLotsFromObj(parsed, knownLots);
    } else if (YM_TOOL_NAMES.has(toolName)) {
      addLotsFromRows(parsed, ymLots);
      addLotsFromRows(parsed, knownLots);
      addLotsFromObj(parsed, ymLots);
      addLotsFromObj(parsed, knownLots);
    } else {
      // unknown tool — add to knownLots but not domain-specific sets
      addLotsFromObj(parsed, knownLots);
      addLotsFromRows(parsed, knownLots);
    }

    // ── totalDistinctLots ─────────────────────────────────────────────────────
    if (totalDistinctLots === null) {
      const tdk = parsed["totalDistinctLots"] ?? parsed["distinctLotCount"];
      if (typeof tdk === "number") totalDistinctLots = tdk;
    }

    // ── Card IDs ──────────────────────────────────────────────────────────────
    const cardByPassId = parsed["cardByPassId"];
    if (Array.isArray(cardByPassId)) {
      for (const c of cardByPassId as Array<Record<string, unknown>>) {
        const cid = String(c["cardId"] ?? "").trim();
        if (cid) knownCardIds.add(cid);
      }
    }

    // ── Yield by pass ─────────────────────────────────────────────────────────
    // From pre-computed yieldByPassId array in JB result
    const yieldByPass = parsed["yieldByPassId"];
    if (Array.isArray(yieldByPass) && yieldByPassId.size === 0) {
      for (const e of yieldByPass as Array<Record<string, unknown>>) {
        const pid = Number(e["passId"]);
        const yp = Number(e["yieldPct"] ?? e["yield"]);
        if (Number.isFinite(pid) && Number.isFinite(yp)) {
          yieldByPassId.set(pid, yp);
        }
      }
    }

    // Fallback: compute from slotYieldSummary if yieldByPassId not present
    if (yieldByPassId.size === 0) {
      const summary = parsed["slotYieldSummary"];
      if (Array.isArray(summary)) {
        const passAgg = new Map<number, { good: number; gross: number }>();
        for (const e of summary as Array<Record<string, unknown>>) {
          const pid = Number(e["passId"]);
          const good = Number(e["goodDie"] ?? 0);
          const gross = Number(e["grossDie"] ?? 0);
          if (!Number.isFinite(pid)) continue;
          const acc = passAgg.get(pid) ?? { good: 0, gross: 0 };
          acc.good += good;
          acc.gross += gross;
          passAgg.set(pid, acc);
        }
        for (const [pid, { good, gross }] of passAgg.entries()) {
          if (gross > 0) yieldByPassId.set(pid, (good / gross) * 100);
        }
      }
    }

    // ── Slot count ────────────────────────────────────────────────────────────
    if (slotCount === null) {
      const ds = parsed["distinctSlots"];
      if (Array.isArray(ds)) {
        slotCount = ds.length;
      } else {
        // Count distinct slot numbers from slotYieldSummary pass1
        const summary = parsed["slotYieldSummary"];
        if (Array.isArray(summary)) {
          const slots = new Set<number>();
          for (const e of summary as Array<Record<string, unknown>>) {
            if (Number(e["passId"]) === 1) slots.add(Number(e["slot"]));
          }
          if (slots.size > 0) slotCount = slots.size;
        }
      }
    }
  }

  return {
    knownLots,
    jbLots,
    ymLots,
    totalDistinctLots,
    knownCardIds,
    knownDevices,
    slotCount,
    yieldByPassId,
  };
}

// ── Yield claim extraction ────────────────────────────────────────────────────

type YieldClaim = { passId: number; claimed: number };

function extractYieldClaims(text: string): YieldClaim[] {
  const results: YieldClaim[] = [];
  const seen = new Set<number>();

  // Reset lastIndex since we reuse the regex
  YIELD_CLAIM_RE.lastIndex = 0;
  let m: RegExpExecArray | null;

  while ((m = YIELD_CLAIM_RE.exec(text)) !== null) {
    // Determine passId from matched groups
    let passId: number | null = null;
    let claimedStr: string | null = null;

    if (m[1]) { passId = parseInt(m[1]); claimedStr = m[4] ?? null; }          // pass N 良率 X%
    else if (m[2]) { passId = [1, 3, 5][parseInt(m[2]) - 1] ?? null; claimedStr = m[4] ?? null; } // sort N
    else if (m[3] === "常温") { passId = 1; claimedStr = m[4] ?? null; }
    else if (m[3] === "高温") { passId = 3; claimedStr = m[4] ?? null; }
    else if (m[3] === "低温") { passId = 5; claimedStr = m[4] ?? null; }
    else if (m[5]) {
      // reverse order: 良率 X% ... pass N
      claimedStr = m[5];
      if (m[6]) passId = parseInt(m[6]);
      else if (m[7]) passId = [1, 3, 5][parseInt(m[7]) - 1] ?? null;
      else if (m[8] === "常温") passId = 1;
      else if (m[8] === "高温") passId = 3;
      else if (m[8] === "低温") passId = 5;
    }

    if (passId && claimedStr && !seen.has(passId)) {
      const claimed = parseFloat(claimedStr);
      if (Number.isFinite(claimed) && claimed >= 0 && claimed <= 100) {
        results.push({ passId, claimed });
        seen.add(passId);
      }
    }
  }

  return results;
}

// ── Fact Check ────────────────────────────────────────────────────────────────

/**
 * Check the LLM's summary text against the structured fact sheet.
 * Returns ok:false on the FIRST failed claim, with a human-readable issue description.
 */
export function factCheckSummaryText(text: string, facts: FactSheet): FactCheckResult {

  // ── 1. Lot IDs must appear in tool results ───────────────────────────────
  if (facts.knownLots.size > 0) {
    const mentionedLots = [...text.matchAll(LOT_PATTERN)].map((m) => m[1]!);
    for (const lot of mentionedLots) {
      if (!facts.knownLots.has(lot)) {
        const known = [...facts.knownLots].slice(0, 5).join("、");
        return {
          ok: false,
          issue:
            `结论中出现了 lot **${lot}**，但该 lot 不存在于任何工具返回数据中` +
            `（工具数据包含：${known}${facts.knownLots.size > 5 ? " 等" : ""}）。` +
            `请仅引用工具数据中实际存在的批次号。`,
        };
      }
    }
  }

  // ── 2. Cross-tool lot attribution: JB-context text must not use YM-only lots ─
  // Session 3 bug: YM returned DR45723.1W, JB returned DR45721.1K,
  // LLM labeled JB BIN table as "lot DR45723.1W" because it was the first lot it saw.
  if (facts.jbLots.size > 0 && facts.ymLots.size > 0 && JB_CONTEXT_RE.test(text)) {
    const mentionedLots = [...text.matchAll(LOT_PATTERN)].map((m) => m[1]!);
    for (const lot of mentionedLots) {
      if (facts.ymLots.has(lot) && !facts.jbLots.has(lot)) {
        const jbList = [...facts.jbLots].slice(0, 3).join("、");
        return {
          ok: false,
          issue:
            `结论在讨论 JB STAR（BIN/slot/良率）数据，但将 lot **${lot}** 作为主体，` +
            `而该 lot 仅出现在 YM（产量触发器）工具结果中，未出现在 JB 工具结果中。` +
            `JB 工具的 lot 为：**${jbList}**。请以 JB 工具数据的实际 lot 为准。`,
        };
      }
    }
  }

  // ── 3. Lot count claims must match totalDistinctLots ─────────────────────
  if (facts.totalDistinctLots !== null) {
    for (const pat of LOT_COUNT_PATTERNS) {
      const m = text.match(pat);
      if (m) {
        const claimed = parseInt(m[1]!);
        if (Math.abs(claimed - facts.totalDistinctLots) > 1) {
          return {
            ok: false,
            issue:
              `结论称"共 ${claimed} 个 lot"，但工具数据 totalDistinctLots = **${facts.totalDistinctLots}**。` +
              `lot 总数必须取自工具返回的 totalDistinctLots 字段，不得自行估算。`,
          };
        }
        break;
      }
    }
  }

  // ── 4. Probe card IDs in text must be in cardByPassId ───────────────────
  if (facts.knownCardIds.size > 0) {
    const mentionedCards = [...text.matchAll(CARD_ID_PATTERN)].map((m) => m[1]!);
    for (const card of mentionedCards) {
      if (!facts.knownCardIds.has(card)) {
        const known = [...facts.knownCardIds].join("、");
        return {
          ok: false,
          issue:
            `结论中出现了探针卡 **${card}**，但 JB 工具返回的 cardByPassId 中未包含该卡号` +
            `（实际使用卡号：${known}）。请仅引用工具数据中实际出现的卡号。`,
        };
      }
    }
  }

  // ── 5. Device codes in text must match known devices ────────────────────
  if (facts.knownDevices.size > 0) {
    const mentionedDevices = [...text.matchAll(DEVICE_PATTERN)].map((m) => m[1]!);
    for (const dev of mentionedDevices) {
      if (!facts.knownDevices.has(dev)) {
        const known = [...facts.knownDevices].join("、");
        return {
          ok: false,
          issue:
            `结论中出现了 device **${dev}**，但工具数据中的 device 为 **${known}**。` +
            `请以工具数据返回的 device 字段为准。`,
        };
      }
    }
  }

  // ── 6. Slot count claims must match actual slot count ───────────────────
  if (facts.slotCount !== null) {
    for (const pat of SLOT_COUNT_PATTERNS) {
      const m = text.match(pat);
      if (m) {
        const claimed = parseInt(m[1]!);
        if (Math.abs(claimed - facts.slotCount) > 2) {
          return {
            ok: false,
            issue:
              `结论称"共 ${claimed} 片"，但工具数据显示该 lot 实际测试 **${facts.slotCount} 片**。` +
              `片数应从工具返回的 distinctSlots 或 slotYieldSummary 获取。`,
          };
        }
        break;
      }
    }
  }

  // ── 7. Yield percentage claims must be close to actual aggregate yield ───
  // Tolerance: ±8 percentage points (accounts for rounding, single-slot vs lot-avg)
  if (facts.yieldByPassId.size > 0) {
    const claims = extractYieldClaims(text);
    for (const { passId, claimed } of claims) {
      const actual = facts.yieldByPassId.get(passId);
      if (actual !== undefined && Math.abs(claimed - actual) > 8) {
        const passLabel = passId === 1 ? "sort1/常温" : passId === 3 ? "sort2/高温" : "sort3/低温";
        return {
          ok: false,
          issue:
            `结论中 pass${passId}（${passLabel}）良率声称为 **${claimed.toFixed(1)}%**，` +
            `但工具数据汇总良率为 **${actual.toFixed(1)}%**（差值 ${Math.abs(claimed - actual).toFixed(1)} pp，超过容忍范围 8 pp）。` +
            `良率数字请从 yieldByPassIdMarkdown 或 slotYieldSummary 获取。`,
        };
      }
    }
  }

  return { ok: true };
}

// ── Format correction note ────────────────────────────────────────────────────

export function formatFactCheckNote(issue: string): string {
  return `\n\n> ⚠️ **数据核实提示**：${issue}`;
}
