// pcr-ai-api/src/lib/agent/agentDataMaskingAudit.ts
/**
 * Timestamped audit evidence for Agent device/NXP masking.
 * Never logs real device values or raw message content — only counts / meta.
 *
 * Default file: <cwd>/logs/agent-data-masking-audit.jsonl
 * Override: AGENT_DATA_MASKING_AUDIT_PATH
 * Disable file (console only): AGENT_DATA_MASKING_AUDIT=false
 */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export type DataMaskingAuditEvent =
  | "outbound_mask"
  | "inbound_unmask"
  | "dictionary_ready";

export interface DataMaskingAuditRecord {
  /** ISO-8601 UTC timestamp */
  ts: string;
  event: DataMaskingAuditEvent;
  enabled: boolean;
  dictOk?: boolean;
  dictSize?: number;
  /** ISO-8601 when the in-memory device dictionary was built */
  dictBuiltAt?: string;
  messageCount?: number;
  deviceReplacements?: number;
  nxpReplacements?: number;
  /** Tokens restored from inbound LLM stream / tool_calls */
  deviceTokensRestored?: number;
  nxpTokensRestored?: number;
  toolCallArgsUnmasked?: number;
  model?: string;
}

function auditFileEnabled(): boolean {
  return String(process.env["AGENT_DATA_MASKING_AUDIT"] ?? "true").toLowerCase() !== "false";
}

export function resolveDataMaskingAuditPath(): string {
  const override = String(process.env["AGENT_DATA_MASKING_AUDIT_PATH"] ?? "").trim();
  if (override) return override;
  return join(process.cwd(), "logs", "agent-data-masking-audit.jsonl");
}

// Serializes async writes onto one chain so concurrent requests don't interleave
// appendFile calls; also lets tests await completion (see below).
let pendingWrites: Promise<void> = Promise.resolve();

/** Test-only: await every audit file write queued so far before asserting on the file. */
export function waitForPendingDataMaskingAuditWrites(): Promise<void> {
  return pendingWrites;
}

/**
 * Append one JSONL evidence line + mirror to console. Never includes secrets.
 * File I/O is async/fire-and-forget — this runs on every streamSiliconFlow call
 * (a per-request hot path), so it must never block the event loop.
 */
export function logDataMaskingEvidence(
  event: DataMaskingAuditEvent,
  fields: Omit<DataMaskingAuditRecord, "ts" | "event">
): DataMaskingAuditRecord {
  const record: DataMaskingAuditRecord = {
    ts: new Date().toISOString(),
    event,
    ...fields,
  };
  const line = JSON.stringify(record);
  console.info(`[agentDataMasking/audit] ${line}`);
  if (auditFileEnabled()) {
    const path = resolveDataMaskingAuditPath();
    pendingWrites = pendingWrites
      .then(() => mkdir(dirname(path), { recursive: true }))
      .then(() => appendFile(path, `${line}\n`, "utf-8"))
      .catch((err) => {
        console.warn(
          "[agentDataMasking/audit] failed to append audit file:",
          err instanceof Error ? err.message : err
        );
      });
  }
  return record;
}
