export interface AgentConfig {
  apiKey: string;
  apiBase: string;
  model: string;
  maxRounds: number;
  /** LLM 流式 idle 超时（秒）；有 SSE 字节则重置计时 */
  streamTimeoutSec: number;
  /** 流式 idle 超时（毫秒）；Settings 为秒，env 可为任意毫秒 */
  streamTimeoutMs: number;
}

const DEFAULT_API_BASE = "https://api.siliconflow.cn/v1";
const DEFAULT_MODEL = "deepseek-ai/DeepSeek-V3";
export const DEFAULT_MAX_ROUNDS = 5;
const MIN_MAX_ROUNDS = 1;
const MAX_MAX_ROUNDS = 20;

export const DEFAULT_STREAM_TIMEOUT_SEC = 150;
const MIN_STREAM_TIMEOUT_SEC = 30;
const MAX_STREAM_TIMEOUT_SEC = 600;

function clampMaxRounds(n: unknown): number {
  const parsed = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_ROUNDS;
  return Math.min(Math.max(Math.round(parsed), MIN_MAX_ROUNDS), MAX_MAX_ROUNDS);
}

export function clampStreamTimeoutSec(n: unknown): number {
  const parsed = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(parsed)) return DEFAULT_STREAM_TIMEOUT_SEC;
  return Math.min(
    Math.max(Math.round(parsed), MIN_STREAM_TIMEOUT_SEC),
    MAX_STREAM_TIMEOUT_SEC
  );
}

function readEnvStreamTimeoutMs(): number | undefined {
  const raw = process.env.AGENT_STREAM_TIMEOUT_MS?.trim();
  if (!raw) return undefined;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return ms;
}

function resolveStreamTimeout(
  override?: Partial<AgentConfig>
): { streamTimeoutSec: number; streamTimeoutMs: number } {
  if (override?.streamTimeoutSec !== undefined) {
    const streamTimeoutSec = clampStreamTimeoutSec(override.streamTimeoutSec);
    return {
      streamTimeoutSec,
      streamTimeoutMs: streamTimeoutSec * 1000,
    };
  }
  const envMs = readEnvStreamTimeoutMs();
  if (envMs !== undefined) {
    return {
      streamTimeoutSec: clampStreamTimeoutSec(Math.ceil(envMs / 1000)),
      streamTimeoutMs: envMs,
    };
  }
  return {
    streamTimeoutSec: DEFAULT_STREAM_TIMEOUT_SEC,
    streamTimeoutMs: DEFAULT_STREAM_TIMEOUT_SEC * 1000,
  };
}

// Reads process.env lazily at call time — do not hoist env reads to module scope.
export function resolveAgentConfig(
  override?: Partial<AgentConfig>
): AgentConfig {
  const apiKey =
    override?.apiKey?.trim() ||
    process.env.AGENT_API_KEY?.trim() ||
    process.env.SILICONFLOW_API_KEY?.trim() ||
    "";
  const rawBase =
    override?.apiBase?.trim() ||
    process.env.AGENT_API_BASE?.trim() ||
    process.env.SILICONFLOW_API_BASE?.trim() ||
    DEFAULT_API_BASE;
  const apiBase = rawBase.replace(/\/$/, "");
  const model =
    override?.model?.trim() ||
    process.env.AGENT_MODEL?.trim() ||
    DEFAULT_MODEL;
  const maxRounds = clampMaxRounds(
    override?.maxRounds ?? process.env.AGENT_MAX_ROUNDS
  );
  const { streamTimeoutSec, streamTimeoutMs } = resolveStreamTimeout(override);
  return { apiKey, apiBase, model, maxRounds, streamTimeoutSec, streamTimeoutMs };
}
