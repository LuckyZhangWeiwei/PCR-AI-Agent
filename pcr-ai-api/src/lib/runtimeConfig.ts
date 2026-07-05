import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export interface RuntimeConfig {
  agentEnabled: boolean;
  agentApiBase: string;
  agentModel: string;
  /** 子任务模型：用于历史压缩 + 确定性表解读（不涉及工具选择/最终回答）。空字符串 = 与 agentModel 相同。 */
  agentSubModel: string;
  /** OpenAI 兼容接口密钥，服务器端共享——任一客户端修改后所有客户端立即生效，无需重启。 */
  agentApiKey: string;
  /** JB 决策驱动确定性派发 dark-launch 开关（见 agentLoop.ts）。 */
  jbDeterministicDispatch: boolean;
  /** JB 路由 LLM 意图分类器 dark-launch 开关（见 jbRouteResolver.ts）。 */
  jbLlmIntentClassifier: boolean;
  maxRounds: number;
  streamTimeoutSec: number;
  clientTimeoutSec: number;
  toolResultMaxChars: number;
  toolResultMaxHistoryChars: number;
  listDefaultLimit: number;
  listMaxLimit: number;
}

export const RUNTIME_CONFIG_DEFAULTS: RuntimeConfig = {
  agentEnabled: true,
  agentApiBase: "https://api.siliconflow.cn/v1",
  agentModel: "deepseek-ai/DeepSeek-V3",
  agentSubModel: "",
  agentApiKey: "",
  jbDeterministicDispatch: false,
  jbLlmIntentClassifier: false,
  maxRounds: 5,
  streamTimeoutSec: 150,
  clientTimeoutSec: 180,
  toolResultMaxChars: 12000,
  toolResultMaxHistoryChars: 12000,
  listDefaultLimit: 300,
  listMaxLimit: 1000,
};

const CONFIG_PATH = resolve(
  process.cwd(),
  process.env.RUNTIME_CONFIG_PATH?.trim() || "runtime-config.json"
);

function readFile(): Partial<RuntimeConfig> {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Partial<RuntimeConfig>;
  } catch {
    return {};
  }
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export function getConfig(): RuntimeConfig {
  const f = readFile();
  const D = RUNTIME_CONFIG_DEFAULTS;
  return {
    agentEnabled:
      typeof f.agentEnabled === "boolean"
        ? f.agentEnabled
        : process.env.AGENT_ENABLED?.trim().toLowerCase() !== "false",
    agentApiBase:
      (typeof f.agentApiBase === "string" && f.agentApiBase) ||
      process.env.AGENT_API_BASE?.trim() ||
      D.agentApiBase,
    agentModel:
      (typeof f.agentModel === "string" && f.agentModel) ||
      process.env.AGENT_MODEL?.trim() ||
      D.agentModel,
    agentSubModel:
      (typeof f.agentSubModel === "string" ? f.agentSubModel : undefined) ??
      process.env.AGENT_SUB_MODEL?.trim() ??
      D.agentSubModel,
    agentApiKey:
      (typeof f.agentApiKey === "string" && f.agentApiKey) ||
      process.env.AGENT_API_KEY?.trim() ||
      process.env.SILICONFLOW_API_KEY?.trim() ||
      D.agentApiKey,
    jbDeterministicDispatch:
      typeof f.jbDeterministicDispatch === "boolean"
        ? f.jbDeterministicDispatch
        : process.env.JB_DETERMINISTIC_DISPATCH === "true",
    jbLlmIntentClassifier:
      typeof f.jbLlmIntentClassifier === "boolean"
        ? f.jbLlmIntentClassifier
        : process.env.JB_LLM_INTENT_CLASSIFIER === "true",
    maxRounds: num(
      f.maxRounds,
      process.env.AGENT_MAX_ROUNDS ? Number(process.env.AGENT_MAX_ROUNDS) : D.maxRounds
    ),
    streamTimeoutSec: num(f.streamTimeoutSec, D.streamTimeoutSec),
    clientTimeoutSec: num(f.clientTimeoutSec, D.clientTimeoutSec),
    toolResultMaxChars: num(
      f.toolResultMaxChars,
      process.env.AGENT_TOOL_RESULT_MAX_CHARS
        ? Number(process.env.AGENT_TOOL_RESULT_MAX_CHARS)
        : D.toolResultMaxChars
    ),
    toolResultMaxHistoryChars: num(
      f.toolResultMaxHistoryChars,
      process.env.AGENT_TOOL_RESULT_MAX_HISTORY_CHARS
        ? Number(process.env.AGENT_TOOL_RESULT_MAX_HISTORY_CHARS)
        : D.toolResultMaxHistoryChars
    ),
    listDefaultLimit: num(f.listDefaultLimit, D.listDefaultLimit),
    listMaxLimit: num(f.listMaxLimit, D.listMaxLimit),
  };
}

export function patchConfig(patch: Partial<RuntimeConfig>): RuntimeConfig {
  const current = readFile();
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({ ...current, ...patch }, null, 2),
    "utf-8"
  );
  return getConfig();
}

// Backward compat
export function getAgentEnabled(): boolean {
  return getConfig().agentEnabled;
}

export function setAgentEnabled(enabled: boolean): void {
  patchConfig({ agentEnabled: enabled });
}
