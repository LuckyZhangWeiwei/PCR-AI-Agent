import type { Request, Response } from "express";
import { enrichOracleDriverDetail, sendAgentError } from "./agentResponse.js";

export function reqId(req: Request): string | undefined {
  return (req as Request & { requestId?: string }).requestId;
}

export function sendValidationError(res: Response, error: string, hint?: string): void {
  sendAgentError(res, 400, "VALIDATION_ERROR", error, hint);
}

export function sendOracleError(res: Response, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  sendAgentError(res, 500, "ORACLE_QUERY_FAILED", "Oracle query failed", enrichOracleDriverDetail(message));
}

export function sendMemoryLimitError(res: Response, count: number, max: number, narrowHint: string): void {
  sendAgentError(
    res,
    422,
    "QUERY_TOO_LARGE",
    `Matching rows (${count}) exceed MEMORY_AGG_ORACLE_MAX_ROWS (${max}). ${narrowHint}`,
    "See .env.example MEMORY_AGG_ORACLE_MAX_ROWS."
  );
}
