import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export interface RuntimeConfig {
  agentEnabled: boolean;
  agentApiBase: string;
  agentModel: string;
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
  maxRounds: 5,
  streamTimeoutSec: 150,
  clientTimeoutSec: 180,
  toolResultMaxChars: 12000,
  toolResultMaxHistoryChars: 12000,
  listDefaultLimit: 300,
  listMaxLimit: 1000,
};

const CONFIG_PATH = resolve(process.cwd(), "runtime-config.json");

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
