// pcr-ai-api/src/lib/agent/agentJbSessionCache.ts
/** 保留 query_jb_bins 总结轮缓存（serialize 前写入，含 markdown）。 */

/** GET /health 的 agentJbCacheVersion，用于确认已部署新 API。 */
export const AGENT_JB_CACHE_VERSION = 4;

const rawBySession = new Map<string, string>();

export function storeJbToolRawJson(sessionId: string, rawJson: string): void {
  if (!sessionId || !rawJson) return;
  rawBySession.set(sessionId, rawJson);
}

export function getJbToolRawJson(sessionId: string): string | undefined {
  return rawBySession.get(sessionId);
}

export function clearJbToolRawJson(sessionId: string): void {
  rawBySession.delete(sessionId);
}
