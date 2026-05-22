export interface AgentConfig {
  apiKey: string;
  apiBase: string;
  model: string;
  maxRounds: number;
}

const DEFAULT_API_BASE = "https://api.siliconflow.cn/v1";
const DEFAULT_MODEL = "deepseek-ai/DeepSeek-V3";
export const DEFAULT_MAX_ROUNDS = 5;
const MIN_MAX_ROUNDS = 1;
const MAX_MAX_ROUNDS = 20;

function clampMaxRounds(n: unknown): number {
  const parsed = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_ROUNDS;
  return Math.min(Math.max(Math.round(parsed), MIN_MAX_ROUNDS), MAX_MAX_ROUNDS);
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
  return { apiKey, apiBase, model, maxRounds };
}
