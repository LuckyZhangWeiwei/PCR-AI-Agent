// pcr-ai-api/src/lib/agent/tools/filterValues/agentFilterValuesSearch.ts
//
// Generic distinct-value counting/limiting helpers shared by the Dummy and Oracle
// paths, plus the tester-search-term-expansion fallback (uflex24 <-> flex24 style
// variants) and the empty-result hint enrichment used by the dispatcher.
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

export function countDistinct(rawValues: string[], limit: number, search?: string): {
  values: string[];
  totalDistinct: number;
} {
  const searchUpper = search?.toUpperCase();
  const counts = new Map<string, number>();
  for (const v of rawValues) {
    if (!v) continue;
    if (searchUpper && !v.toUpperCase().includes(searchUpper)) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const values = sorted.slice(0, limit).map(([v, cnt]) => `${v} (${cnt}次)`);
  return { values, totalDistinct: counts.size };
}

/** 机台 search 无命中时尝试 uflex24 → flex24 / b3uflex24 等变体。 */
export function expandTesterSearchTerms(search: string): string[] {
  const normalized = search.trim().toLowerCase().replace(/\s+/g, "");
  const terms = new Set<string>([search.trim(), normalized]);
  const uflex = normalized.match(/uflex(\d+)/);
  if (uflex) {
    terms.add(`flex${uflex[1]}`);
    terms.add(`b3uflex${uflex[1]}`);
    terms.add(`b3uflex${uflex[1]!.padStart(2, "0")}`);
  }
  const flexOnly = normalized.match(/^flex(\d+)$/);
  if (flexOnly) {
    terms.add(`b3uflex${flexOnly[1]}`);
    terms.add(`uflex${flexOnly[1]}`);
  }
  if (normalized.startsWith("b3")) terms.add(normalized.slice(2));
  return [...terms];
}

export function countDistinctWithSearchFallback(
  rawValues: string[],
  limit: number,
  search?: string
): { values: string[]; totalDistinct: number } {
  const first = countDistinct(rawValues, limit, search);
  if (first.totalDistinct > 0 || !search?.trim()) return first;
  for (const alt of expandTesterSearchTerms(search)) {
    if (alt.toUpperCase() === search.trim().toUpperCase()) continue;
    const retry = countDistinct(rawValues, limit, alt);
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
      "请直接 query_jb_bins(testerId) / query_yield_triggers(hostname)，禁止据此报告「未找到机台」。",
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
  let result = await oracleYield(field, filterBy, limit);
  if (result.totalDistinct > 0 || !filterBy["search"] || field !== "hostname") {
    return result;
  }
  for (const alt of expandTesterSearchTerms(filterBy["search"])) {
    if (alt.toUpperCase() === filterBy["search"]!.toUpperCase()) continue;
    result = await oracleYield(field, { ...filterBy, search: alt }, limit);
    if (result.totalDistinct > 0) return result;
  }
  return result;
}

export async function oracleJbWithSearchFallback(
  field: JbField,
  filterBy: Record<string, string | undefined>,
  limit: number
): Promise<FilterValuesResult> {
  let result = await oracleJb(field, filterBy, limit);
  if (result.totalDistinct > 0 || !filterBy["search"] || field !== "testerId") {
    return result;
  }
  for (const alt of expandTesterSearchTerms(filterBy["search"])) {
    if (alt.toUpperCase() === filterBy["search"]!.toUpperCase()) continue;
    result = await oracleJb(field, { ...filterBy, search: alt }, limit);
    if (result.totalDistinct > 0) return result;
  }
  return result;
}
