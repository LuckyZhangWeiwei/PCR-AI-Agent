export interface AgentConfig {
  apiKey: string;
  apiBase: string;
  model: string;
  /** 子任务模型：历史压缩 + 确定性表解读。等于 model 时无差异。 */
  subAgentModel: string;
  maxRounds: number;
  /** LLM 流式 idle 超时（秒）；有 SSE 字节则重置计时 */
  streamTimeoutSec: number;
  /** 流式 idle 超时（毫秒）；Settings 为秒，env 可为任意毫秒 */
  streamTimeoutMs: number;
  /** 单次工具结果 JSON 最大字符数（发给 LLM 前截断/压缩） */
  toolResultMaxChars: number;
  /** 每条工具结果写入会话历史时的最大字符数（防止多轮上下文膨胀） */
  toolResultMaxHistoryChars: number;
  /**
   * 是否为大上下文模型（≥200K token）。
   * 自动检测 GLM-4.7 / GLM-5.x（Zhipu AI bigmodel.cn）及同等模型；
   * 为 true 时：历史压缩阈值提高、toolResultMaxHistoryChars 默认值更大。
   */
  largeContext: boolean;
}

const DEFAULT_API_BASE = "https://api.siliconflow.cn/v1";
const DEFAULT_MODEL = "deepseek-ai/DeepSeek-V4-Pro";
const DEFAULT_SUB_MODEL = "deepseek-ai/DeepSeek-V4-Flash";
export const DEFAULT_MAX_ROUNDS = 8;
const MIN_MAX_ROUNDS = 1;
const MAX_MAX_ROUNDS = 20;

export const DEFAULT_STREAM_TIMEOUT_SEC = 120;
const MIN_STREAM_TIMEOUT_SEC = 30;
const MAX_STREAM_TIMEOUT_SEC = 600;

export const DEFAULT_TOOL_RESULT_MAX_CHARS = 20000;
const MIN_TOOL_RESULT_MAX_CHARS = 6000;
const MAX_TOOL_RESULT_MAX_CHARS = 30000;

export const DEFAULT_TOOL_RESULT_MAX_HISTORY_CHARS = 8000;
/** Default for large-context models (≥200K): keep full tool results in history. */
export const LARGE_CTX_TOOL_RESULT_MAX_HISTORY_CHARS = 20000;
const MIN_TOOL_RESULT_MAX_HISTORY_CHARS = 1000;
/** Raised to 30 000 to accommodate user manual overrides on large-context models. */
const MAX_TOOL_RESULT_MAX_HISTORY_CHARS = 30000;

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

export function clampToolResultMaxChars(n: unknown): number {
  const parsed = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(parsed)) return DEFAULT_TOOL_RESULT_MAX_CHARS;
  return Math.min(
    Math.max(Math.round(parsed), MIN_TOOL_RESULT_MAX_CHARS),
    MAX_TOOL_RESULT_MAX_CHARS
  );
}

export function clampToolResultMaxHistoryChars(n: unknown): number {
  const parsed = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(parsed)) return DEFAULT_TOOL_RESULT_MAX_HISTORY_CHARS;
  return Math.min(
    Math.max(Math.round(parsed), MIN_TOOL_RESULT_MAX_HISTORY_CHARS),
    MAX_TOOL_RESULT_MAX_HISTORY_CHARS
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
  // Raw ms override (e.g. tests passing streamTimeoutMs: 20 directly)
  if (override?.streamTimeoutMs !== undefined) {
    const ms = override.streamTimeoutMs;
    return {
      streamTimeoutSec: Math.ceil(ms / 1000),
      streamTimeoutMs: ms,
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

/**
 * Returns true for models with ≥200K context window that support longer histories
 * and larger tool-result storage without triggering context overflow.
 *
 * Detection rules (either condition is sufficient):
 *  • apiBase is Zhipu AI BigModel (open.bigmodel.cn) — all models are ≥200K
 *  • Model name contains glm-4.7, glm-4.6, glm-5, glm-z1 (large-context GLM series)
 */
export function detectLargeContext(model: string, apiBase: string): boolean {
  if (apiBase.includes("bigmodel.cn")) return true;
  const m = model.toLowerCase();
  return (
    m.includes("glm-4.7") ||
    m.includes("glm-4.6") ||
    m.includes("glm-5") ||
    m.includes("glm-z1")
  );
}

/**
 * Sanitize apiBase: strip trailing slash and common wrong path suffixes that
 * users accidentally paste (e.g. /agents, /chat, /chat/completions).
 * We always append /chat/completions in agentStream.ts, so none of these
 * should appear at the end of the base URL.
 */
function sanitizeApiBase(raw: string): string {
  let base = raw.replace(/\/$/, "");
  // Strip the full endpoint path if the user pasted it directly
  if (base.endsWith("/chat/completions")) {
    base = base.slice(0, -"/chat/completions".length);
    console.warn("[agent] apiBase contained /chat/completions — stripped. New base:", base);
  }
  // Strip /agents suffix (Zhipu AI agent API path, not chat completions API)
  if (base.endsWith("/agents")) {
    base = base.slice(0, -"/agents".length);
    console.warn("[agent] apiBase ended with /agents — stripped. New base:", base);
  }
  // Strip trailing /chat to prevent /chat/chat/completions doubling
  if (base.endsWith("/chat")) {
    base = base.slice(0, -"/chat".length);
    console.warn("[agent] apiBase ended with /chat — stripped to prevent URL doubling. New base:", base);
  }
  return base;
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
  const apiBase = sanitizeApiBase(rawBase);
  const model =
    override?.model?.trim() ||
    process.env.AGENT_MODEL?.trim() ||
    DEFAULT_MODEL;
  const subAgentModel =
    override?.subAgentModel?.trim() ||
    process.env.AGENT_SUB_MODEL?.trim() ||
    DEFAULT_SUB_MODEL;
  const maxRounds = clampMaxRounds(
    override?.maxRounds ?? process.env.AGENT_MAX_ROUNDS
  );
  const { streamTimeoutSec, streamTimeoutMs } = resolveStreamTimeout(override);
  const toolResultMaxChars = clampToolResultMaxChars(
    override?.toolResultMaxChars ?? process.env.AGENT_TOOL_RESULT_MAX_CHARS
  );
  const largeContext = override?.largeContext ?? detectLargeContext(model, apiBase);
  const historyDefault = largeContext
    ? LARGE_CTX_TOOL_RESULT_MAX_HISTORY_CHARS
    : DEFAULT_TOOL_RESULT_MAX_HISTORY_CHARS;
  const toolResultMaxHistoryChars = clampToolResultMaxHistoryChars(
    override?.toolResultMaxHistoryChars ??
      process.env.AGENT_TOOL_RESULT_MAX_HISTORY_CHARS ??
      historyDefault
  );
  return {
    apiKey,
    apiBase,
    model,
    subAgentModel,
    maxRounds,
    streamTimeoutSec,
    streamTimeoutMs,
    toolResultMaxChars,
    toolResultMaxHistoryChars,
    largeContext,
  };
}
