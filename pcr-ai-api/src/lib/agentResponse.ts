import type { Response } from "express";

export type AgentErrorBody = {
  error: string;
  code: string;
  detail?: string;
};

export function sendAgentError(
  res: Response,
  status: number,
  code: string,
  error: string,
  detail?: string
): void {
  const body: AgentErrorBody = { error, code };
  if (detail !== undefined && detail !== "") body.detail = detail;
  res.status(status).json(body);
}

/** NJS-116 等：在 API 响应里附带 Thick / Instant Client 部署提示 */
export function enrichOracleDriverDetail(raw: string): string {
  if (raw.includes("NJS-116")) {
    return `${raw} | Fix: use Oracle Thick mode — set ORACLE_INSTANT_CLIENT_LIB_DIR to Instant Client dir (libclntsh.so on Linux, oci.dll on Windows) and restart PM2.`;
  }
  if (raw.includes("DPI-1050")) {
    return `${raw} | Fix: node-oracledb 6+ needs Oracle Client library >= 18.1 in Thick mode. This project uses oracledb 5.5.x for older clients; if you upgraded to v6, install Instant Client 19+, set ORACLE_INSTANT_CLIENT_LIB_DIR, restart the API.`;
  }
  return raw;
}
