import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const CONFIG_PATH = resolve(process.cwd(), "runtime-config.json");

interface RuntimeConfig {
  agentEnabled: boolean;
}

function readFile(): Partial<RuntimeConfig> {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Partial<RuntimeConfig>;
  } catch {
    return {};
  }
}

export function getAgentEnabled(): boolean {
  const file = readFile();
  if (typeof file.agentEnabled === "boolean") return file.agentEnabled;
  return process.env.AGENT_ENABLED?.trim().toLowerCase() !== "false";
}

export function setAgentEnabled(enabled: boolean): void {
  const current = readFile();
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({ ...current, agentEnabled: enabled }, null, 2),
    "utf-8"
  );
}
