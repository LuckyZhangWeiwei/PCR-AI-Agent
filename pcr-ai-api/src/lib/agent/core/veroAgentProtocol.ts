// pcr-ai-api/src/lib/agent/core/veroAgentProtocol.ts
// JSON action protocol for the Vero-driven generic agent loop.
// Vero's simple-agent/invoke has no native tools[]/messages[] params — the
// model must reply with one JSON object per round describing what to do
// next. Same style as agentProbeCardVeroPilot.ts's extract protocol,
// generalized to cover the full tool list and multi-round looping.
import { parseJsonLoose } from "../../vero/veroSimpleAgent.js";

export interface VeroToolDecision {
  action: "tool";
  tool: string;
  args: Record<string, unknown>;
}

export interface VeroReplyDecision {
  action: "final" | "chat";
  reply: string;
}

export type VeroRoundDecision = VeroToolDecision | VeroReplyDecision;

interface ToolSchemaFunction {
  name: string;
  description: string;
  parameters?: {
    properties?: Record<string, { type?: string; description?: string }>;
    required?: string[];
  };
}

interface ToolSchemaEntry {
  type: string;
  function: ToolSchemaFunction;
}

/**
 * Render OpenAI-style tool JSON Schemas (agentToolSchemas.ts — the same
 * source of truth the old SiliconFlow tools[] param uses) as a text block
 * for the Vero system prompt. Adding a tool only requires editing
 * agentToolSchemas.ts; this renderer picks it up automatically.
 */
export function renderToolSchemasAsText(schemas: unknown[]): string {
  const entries = schemas as ToolSchemaEntry[];
  return entries
    .map(({ function: fn }) => {
      const props = fn.parameters?.properties ?? {};
      const required = new Set(fn.parameters?.required ?? []);
      const paramLines = Object.entries(props).map(([key, def]) => {
        const type = def?.type ?? "any";
        const req = required.has(key) ? "，必填" : "";
        const desc = def?.description ?? "";
        return `  - ${key} (${type}${req}): ${desc}`;
      });
      return `### ${fn.name}\n${fn.description}\n参数：\n${
        paramLines.length ? paramLines.join("\n") : "  (无参数)"
      }`;
    })
    .join("\n\n");
}

/** Fixed instructions appended to every round's system prompt. */
export const VERO_ACTION_PROTOCOL_INSTRUCTIONS = `你每次回复必须且只能是一个 JSON 对象（不要 markdown 代码块围栏，不要额外解释文字）：

调用工具：
{"action":"tool","tool":"<工具名>","args":{...}}

给出最终答案（不再需要工具，或已经拿到足够数据）：
{"action":"final","reply":"<面向用户的完整中文回答，可用 markdown>"}

闲聊/无需工具的简短澄清：
{"action":"chat","reply":"<简短中文回复>"}

规则：
- 每次只能选择一个 action，不能既调用工具又给最终答案。
- 工具名必须是下面工具列表中的一个，args 必须是该工具允许的参数。
- 已经执行过的工具及其结果会出现在下面的对话记录里，不要重复调用同一工具查询完全相同的参数。
- 如果工具结果已经足够回答用户问题，立即返回 final，不要为了"保险"再多调用工具。`;

/**
 * Parse and validate one round's raw Vero response into a typed decision.
 * Throws a descriptive Error when the shape is invalid — callers retry/error
 * per the design's §5 error-handling rules.
 */
export function parseVeroRoundDecision(raw: string): VeroRoundDecision {
  const parsed = parseJsonLoose(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Vero round decision is not a JSON object: ${raw.slice(0, 200)}`);
  }
  const obj = parsed as Record<string, unknown>;
  const action = String(obj["action"] ?? "");

  if (action === "tool") {
    const tool = typeof obj["tool"] === "string" ? obj["tool"].trim() : "";
    if (!tool) {
      throw new Error(`Vero tool decision missing "tool" name: ${raw.slice(0, 200)}`);
    }
    const args =
      obj["args"] && typeof obj["args"] === "object" && !Array.isArray(obj["args"])
        ? (obj["args"] as Record<string, unknown>)
        : {};
    return { action: "tool", tool, args };
  }

  if (action === "final" || action === "chat") {
    const reply = typeof obj["reply"] === "string" ? obj["reply"] : "";
    if (!reply.trim()) {
      throw new Error(`Vero ${action} decision missing "reply" text: ${raw.slice(0, 200)}`);
    }
    return { action, reply };
  }

  throw new Error(`Vero round decision has unknown action "${action}": ${raw.slice(0, 200)}`);
}
