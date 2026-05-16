export interface AgentConfig {
  apiKey: string;
  apiBase: string;
  model: string;
}

const DEFAULT_API_BASE = "https://api.siliconflow.cn/v1";
const DEFAULT_MODEL = "deepseek-ai/DeepSeek-V3";

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
  return { apiKey, apiBase, model };
}
