// pcr-ai-api/src/lib/agent/agentSqlDebugLog.ts
/**
 * Agent Oracle 工具的 SQL 调试日志：把实际执行的 SQL + binds（+ 行数等）打到 stderr，
 * 方便把语句直接贴去真库复跑、定位「实查有数据但聚合/枚举为空」一类不一致。
 * 仅在 agent 工具路径调用，量小；可用 AGENT_SQL_DEBUG=false 关闭。
 */
function sqlDebugEnabled(): boolean {
  return String(process.env["AGENT_SQL_DEBUG"] ?? "true").toLowerCase() !== "false";
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, val) =>
      val instanceof Date ? val.toISOString() : val
    );
  } catch {
    return String(v);
  }
}

export function logAgentSql(
  tag: string,
  sql: string,
  binds: unknown,
  extra?: Record<string, unknown>
): void {
  if (!sqlDebugEnabled()) return;
  const oneLine = sql.replace(/\s+/g, " ").trim();
  const extraStr = extra ? ` ${safeJson(extra)}` : "";
  console.warn(
    `[agentSql/${tag}] binds=${safeJson(binds)}${extraStr}\n  SQL: ${oneLine}`
  );
}
