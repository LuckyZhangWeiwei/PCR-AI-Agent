// pcr-ai-api/src/lib/agent/agentJbSessionCache.ts
/** 保留 query_jb_bins 完整 JSON（未压缩），供总结轮直出表。 */

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
