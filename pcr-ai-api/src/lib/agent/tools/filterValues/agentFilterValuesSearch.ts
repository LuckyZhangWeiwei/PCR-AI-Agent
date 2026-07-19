// pcr-ai-api/src/lib/agent/tools/filterValues/agentFilterValuesSearch.ts
//
// Generic distinct-value counting/limiting helpers shared by the Dummy and Oracle
// paths, plus the tester-search-term-expansion fallback and empty-result hint
// enrichment used by the dispatcher.
//
// FLEX vs UFLEX: substring "flex25" must NOT match "b3uflex25". They are different
// machines; search/expansion must keep the families separate.
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  type FilterValuesResult,
  type YieldField,
  type JbField,
} from "./agentFilterValuesDeviceMask.js";
import { oracleYield, oracleJb } from "./agentFilterValuesOracle.js";

export function clampLimit(raw: unknown): number {
  const n = typeof raw === "number" ? raw : DEFAULT_LIMIT;
  return Math.min(Math.max(1, Math.round(n)), MAX_LIMIT);
}

/** Search mentions FLEX family but not UFLEX (e.g. flex25, b3flex25, T25FLEX→flex25). */
export function isFlexOnlyTesterSearch(search: string): boolean {
  const s = search.trim().toUpperCase().replace(/\s+/g, "");
  if (!s || /UFLEX/.test(s)) return false;
  return /FLEX/.test(s);
}

/**
 * Normalize shop-floor / b3-prefixed tester labels to the short keyword used for
 * dual-DB matching: T25FLEX→flex25, T25UFLEX→uflex25, b3flex25→flex25.
 */
export function normalizeTesterSearchKeyword(raw: string): string {
  const t = raw.trim().replace(/\s+/g, "");
  if (!t) return t;

  const tUflex = t.match(/^T(\d+)UFLEX$/i);
  if (tUflex) return `uflex${tUflex[1]!.padStart(2, "0")}`;
  const tFlex = t.match(/^T(\d+)FLEX$/i);
  if (tFlex) return `flex${tFlex[1]!.padStart(2, "0")}`;
  const tPs16 = t.match(/^T(\d+)PS\s*16(?:00)?$/i);
  if (tPs16) return `ps16${tPs16[1]!.padStart(2, "0")}`;
  const tJ750 = t.match(/^T(\d+)J?\s*750$/i);
  if (tJ750) return `j750${tJ750[1]!.padStart(2, "0")}`;
  const tMst = t.match(/^T(\d+)MST$/i);
  if (tMst) return `mst${tMst[1]!.padStart(2, "0")}`;

  const lower = t.toLowerCase();
  if (lower.startsWith("b3")) return lower.slice(2);
  return lower;
}

/**
 * Hostname / TESTERID contains-match that does not let FLEX search hit UFLEX ids.
 */
export function testerValueMatchesSearch(value: string, search: string): boolean {
  const v = value.trim().toUpperCase();
  const s = search.trim().toUpperCase().replace(/\s+/g, "");
  if (!s) return true;
  if (!v.includes(s)) return false;
  if (isFlexOnlyTesterSearch(s) && v.includes("UFLEX")) return false;
  return true;
}

export function countDistinct(
  rawValues: string[],
  limit: number,
  search?: string,
  opts?: { testerSearch?: boolean }
): {
  values: string[];
  totalDistinct: number;
} {
  const counts = new Map<string, number>();
  for (const v of rawValues) {
    if (!v) continue;
    if (search?.trim()) {
      const ok = opts?.testerSearch
        ? testerValueMatchesSearch(v, search)
        : v.toUpperCase().includes(search.trim().toUpperCase());
      if (!ok) continue;
    }
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const values = sorted.slice(0, limit).map(([v, cnt]) => `${v} (${cnt}次)`);
  return { values, totalDistinct: counts.size };
}

/**
 * Expand alternate spellings for the same physical tester.
 * Never maps FLEX ↔ UFLEX (different machines).
 */
export function expandTesterSearchTerms(search: string): string[] {
  const normalized = normalizeTesterSearchKeyword(search);
  const terms = new Set<string>([search.trim(), normalized]);
  if (normalized.startsWith("b3")) terms.add(normalized.slice(2));

  const uflex = normalized.match(/^uflex(\d+)$/);
  if (uflex) {
    const n = uflex[1]!;
    const nPad = n.padStart(2, "0");
    terms.add(`uflex${n}`);
    terms.add(`uflex${nPad}`);
    terms.add(`b3uflex${n}`);
    terms.add(`b3uflex${nPad}`);
    return [...terms];
  }

  const flex = normalized.match(/^flex(\d+)$/);
  if (flex) {
    const n = flex[1]!;
    const nPad = n.padStart(2, "0");
    terms.add(`flex${n}`);
    terms.add(`flex${nPad}`);
    terms.add(`b3flex${n}`);
    terms.add(`b3flex${nPad}`);
    return [...terms];
  }

  const ps16 = normalized.match(/^ps16(\d+)$/);
  if (ps16) {
    const n = ps16[1]!;
    const nPad = n.padStart(2, "0");
    terms.add(`ps16${nPad}`);
    terms.add(`b3ps16${nPad}`);
  }
  const j750 = normalized.match(/^j750(\d+)$/);
  if (j750) {
    const nPad = j750[1]!.padStart(2, "0");
    terms.add(`j750${nPad}`);
    terms.add(`b3j750${nPad}`);
  }
  const mst = normalized.match(/^mst(\d+)$/);
  if (mst) {
    const nPad = mst[1]!.padStart(2, "0");
    terms.add(`mst${nPad}`);
    terms.add(`b3mst${nPad}`);
  }

  return [...terms];
}

export function countDistinctWithSearchFallback(
  rawValues: string[],
  limit: number,
  search?: string
): { values: string[]; totalDistinct: number } {
  const normalized = search?.trim()
    ? normalizeTesterSearchKeyword(search)
    : search;
  const first = countDistinct(rawValues, limit, normalized, { testerSearch: true });
  if (first.totalDistinct > 0 || !search?.trim()) return first;
  for (const alt of expandTesterSearchTerms(search)) {
    if (alt.toUpperCase() === (normalized ?? "").toUpperCase()) continue;
    const retry = countDistinct(rawValues, limit, alt, { testerSearch: true });
    if (retry.totalDistinct > 0) return retry;
  }
  return first;
}

export function enrichEmptyTesterSearchResult(
  result: FilterValuesResult,
  field: string,
  search?: string
): FilterValuesResult {
  if (result.totalDistinct > 0 || !search?.trim()) return result;
  if (field !== "hostname" && field !== "testerId") return result;
  const suggestions = expandTesterSearchTerms(search).filter(
    (t) => t.toUpperCase() !== search.trim().toUpperCase()
  );
  return {
    ...result,
    hint:
      "filter 索引未命中不代表无机台/无 lot 数据；若用户句中已有 device+机台（如 b3uflex24），" +
      "请直接 query_jb_bins(testerId) / query_yield_triggers(hostname)，禁止据此报告「未找到机台」。" +
      "注意：FLEX 与 UFLEX 是不同机台——search flex25 只匹配 b3flex25，不会匹配 b3uflex25。",
    suggestedSearchTerms: suggestions.slice(0, 6),
  };
}

/**
 * cardId / probeCard 按 probeCardType 枚举返回空时，附 hint：filter 索引未命中不等于
 * 该型号无测试记录（CARDID 前缀格式差异常致空命中）。禁止据此回答「型号无记录/无法对比」。
 */
export function enrichEmptyCardEnumResult(
  result: FilterValuesResult,
  field: string,
  filterBy: Record<string, string | undefined>
): FilterValuesResult {
  if (result.totalDistinct > 0) return result;
  if (field !== "cardId" && field !== "probeCard") return result;
  const pct = filterBy["probeCardType"]?.trim();
  if (!pct) return result;
  const aggHint =
    result.domain === "yield"
      ? `query_yield_triggers(probeCard:"<完整卡号>")`
      : `aggregate_jb_bins(probeCardType:"${pct}", groupBy:"bin,cardId", groupTop:50)`;
  return {
    ...result,
    hint:
      `未按 probeCardType="${pct}" 枚举到具体卡号；filter 索引未命中并不代表该型号无测试记录或未投入使用` +
      `（CARDID/PROBECARD 前缀提取格式差异常致空命中）。` +
      `请改用已知的完整卡号直接查询（query_jb_bins(cardId) / query_yield_triggers(probeCard)），` +
      `或用 ${aggHint} 在库内按 CARDID 枚举该型号下各卡再横向对比。` +
      `禁止据此回答「型号无记录 / 无法对比」。`,
  };
}

export async function oracleYieldWithSearchFallback(
  field: YieldField,
  filterBy: Record<string, string | undefined>,
  limit: number
): Promise<FilterValuesResult> {
  const fb = { ...filterBy };
  if (field === "hostname" && fb["search"]) {
    fb["search"] = normalizeTesterSearchKeyword(fb["search"]);
  }
  let result = await oracleYield(field, fb, limit);
  if (result.totalDistinct > 0 || !fb["search"] || field !== "hostname") {
    return result;
  }
  for (const alt of expandTesterSearchTerms(fb["search"])) {
    if (alt.toUpperCase() === fb["search"]!.toUpperCase()) continue;
    result = await oracleYield(field, { ...fb, search: alt }, limit);
    if (result.totalDistinct > 0) return result;
  }
  return result;
}

export async function oracleJbWithSearchFallback(
  field: JbField,
  filterBy: Record<string, string | undefined>,
  limit: number
): Promise<FilterValuesResult> {
  const fb = { ...filterBy };
  if (field === "testerId" && fb["search"]) {
    fb["search"] = normalizeTesterSearchKeyword(fb["search"]);
  }
  let result = await oracleJb(field, fb, limit);
  if (result.totalDistinct > 0 || !fb["search"] || field !== "testerId") {
    return result;
  }
  for (const alt of expandTesterSearchTerms(fb["search"])) {
    if (alt.toUpperCase() === fb["search"]!.toUpperCase()) continue;
    result = await oracleJb(field, { ...fb, search: alt }, limit);
    if (result.totalDistinct > 0) return result;
  }
  return result;
}
