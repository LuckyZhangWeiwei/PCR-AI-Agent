// pcr-ai-api/src/lib/agent/dispatch/directRoutes/agentProbeCardVeroPilot.ts
// Vero Studio Path B pilot for probe-card × tester performance only.
// Flow: extract JSON (Vero) → local aggregate tool → deterministic tables → Vero commentary.
import type { AgentConfig } from "../../agentConfig.js";
import type { AgentSseEvent } from "../../core/agentLoop.js";
import {
  getHistory,
  appendSyntheticToolTurn,
  appendMessages,
  type ChatMessage,
} from "../../agentHistory.js";
import { runTool } from "../../tools/agentToolHandlers.js";
import { emitTextInChunks } from "../../core/agentLoopShared.js";
import { emitDeterministicProbeCardPerfReply } from "../../render/agentProbeCardPerfReply.js";
import {
  inferDeviceFromText,
  inferDeviceFromHistory,
  inferMaskFromText,
  inferMaskFromHistory,
  inferRecentMonthsWindow,
} from "../../agentQueryScope.js";
import {
  invokeVeroSimpleAgent,
  parseJsonLoose,
  isProbeCardVeroPilotReady,
} from "../../../vero/veroSimpleAgent.js";
import {
  PROBE_CARD_PERF_COMMENTARY_SYSTEM,
  buildBriefCommentaryUserMessage,
} from "../../jb/agentJbOverviewMarkdown.js";

export const PROBE_CARD_VERO_EXTRACT_SYSTEM = `You are a parameter extractor for a JB STAR probe-card / tester performance tool.
Reply with ONLY one JSON object (no markdown, no explanation).

When the user asks about probe card + tester (机台) combination yield ranking / 最好组合 / 最差探针卡 / card vs tester performance, output:
{"action":"tool","tool":"aggregate_probe_card_tester_performance","args":{...}}

Allowed args:
- device (string): full device code when known
- mask (string): last 4 chars of device when user only gives mask (e.g. N86K); use instead of device
- passId (number): 1 (sort1/常温), 3 (sort2/高温), or 5 (sort3/低温); omit to return all three
- testEndFrom (string, ISO): optional TESTEND start
- testEndTo (string, ISO): optional TESTEND end

Rules:
- device or mask is required for the tool action.
- Prefer device over mask when both are available.
- If the user only greets or asks something unrelated to probe-card/tester ranking, output:
{"action":"chat","reply":"<short helpful reply in the user's language>"}
- Use prior conversation context when resolving references like "刚才那个 device".`;

export type VeroInvokeFn = (
  prompt: string,
  systemPrompt: string
) => Promise<string>;

export type ProbeCardVeroPilotDeps = {
  /** Injectable for tests; defaults to invokeVeroSimpleAgent. */
  invokeVero?: VeroInvokeFn;
};

function historyBlock(history: ChatMessage[]): string {
  const turns = history
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-8)
    .map((m) => `${m.role.toUpperCase()}: ${String(m.content ?? "").slice(0, 800)}`);
  return turns.length ? turns.join("\n") : "(empty)";
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/** Normalize LLM extract args into tool args; merge regex fallbacks when LLM omits fields. */
export function normalizeProbeCardPerfArgs(
  rawArgs: Record<string, unknown>,
  userQuestion: string,
  history: ChatMessage[]
): Record<string, unknown> {
  const args: Record<string, unknown> = {};

  const deviceRaw =
    typeof rawArgs["device"] === "string" ? rawArgs["device"].trim() : "";
  const maskRaw =
    typeof rawArgs["mask"] === "string" ? rawArgs["mask"].trim() : "";

  const device =
    deviceRaw ||
    inferDeviceFromText(userQuestion) ||
    inferDeviceFromHistory(history);
  const mask =
    !device
      ? maskRaw ||
        inferMaskFromText(userQuestion) ||
        inferMaskFromHistory(history)
      : undefined;

  if (device) args["device"] = device;
  else if (mask) args["mask"] = mask;

  let passId: number | undefined;
  if (typeof rawArgs["passId"] === "number" && [1, 3, 5].includes(rawArgs["passId"])) {
    passId = rawArgs["passId"];
  } else if (typeof rawArgs["passId"] === "string") {
    const n = Number(rawArgs["passId"].trim());
    if ([1, 3, 5].includes(n)) passId = n;
  }
  if (passId == null) {
    const passIdMatch = userQuestion.match(
      /\bpass\s*Id\s*[=:]?\s*([135])\b|\bpass\s*([135])\b/i
    );
    if (passIdMatch) {
      passId = Number(passIdMatch[1] ?? passIdMatch[2]);
    } else if (/sort\s*1|常温/i.test(userQuestion)) {
      passId = 1;
    } else if (/sort\s*2|高温/i.test(userQuestion)) {
      passId = 3;
    } else if (/sort\s*3|低温/i.test(userQuestion)) {
      passId = 5;
    }
  }
  if (passId != null) args["passId"] = passId;

  const fromArg =
    typeof rawArgs["testEndFrom"] === "string"
      ? rawArgs["testEndFrom"].trim()
      : "";
  const toArg =
    typeof rawArgs["testEndTo"] === "string" ? rawArgs["testEndTo"].trim() : "";
  if (fromArg) args["testEndFrom"] = fromArg;
  if (toArg) args["testEndTo"] = toArg;
  if (!fromArg && !toArg) {
    const window = inferRecentMonthsWindow(userQuestion);
    if (window.testEndFrom) args["testEndFrom"] = window.testEndFrom;
    if (window.testEndTo) args["testEndTo"] = window.testEndTo;
  }

  return args;
}

/**
 * Path B pilot entry. Returns true if the turn was fully handled (including chat-only).
 * Returns false to let the caller fall back to the SiliconFlow regex direct route.
 */
export async function tryRunProbeCardVeroPilot(
  sessionId: string,
  userQuestion: string,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void,
  deps?: ProbeCardVeroPilotDeps
): Promise<boolean> {
  if (!isProbeCardVeroPilotReady() && !deps?.invokeVero) return false;

  const invoke: VeroInvokeFn =
    deps?.invokeVero ?? ((p, s) => invokeVeroSimpleAgent(p, s));
  const history = getHistory(sessionId);

  emit({ type: "status", message: "Vero 试点：正在解析探针卡/机台组合查询参数…" });

  let decision: Record<string, unknown>;
  try {
    const extractPrompt = `Conversation so far:
${historyBlock(history)}

Latest user message:
${userQuestion}

Extract the next action JSON now.`;
    const extractedRaw = await invoke(extractPrompt, PROBE_CARD_VERO_EXTRACT_SYSTEM);
    decision = asRecord(parseJsonLoose(extractedRaw));
  } catch {
    // Extract failed → caller falls back to regex + SiliconFlow.
    return false;
  }

  const action = String(decision["action"] ?? "").toLowerCase();
  const toolName = String(decision["tool"] ?? "");
  const replyText =
    typeof decision["reply"] === "string"
      ? decision["reply"]
      : typeof decision["response"] === "string"
        ? decision["response"]
        : "";

  if (action === "chat" || (replyText && action !== "tool")) {
    const text = replyText.trim() || "请提供 device 或 mask，以及探针卡/机台组合相关问题。";
    emitTextInChunks(text, emit);
    appendMessages(sessionId, { role: "assistant", content: text });
    emit({ type: "done" });
    return true;
  }

  if (
    action !== "tool" &&
    toolName !== "aggregate_probe_card_tester_performance"
  ) {
    return false;
  }

  const args = normalizeProbeCardPerfArgs(
    asRecord(decision["args"]),
    userQuestion,
    history
  );
  if (!args["device"] && !args["mask"]) return false;

  const scopeLabel = String(args["device"] ?? `mask=${args["mask"]}`);
  emit({
    type: "status",
    message: `Vero 试点：正在聚合 ${scopeLabel} 探针卡+机台组合表现…`,
  });
  emit({
    type: "tool_start",
    name: "aggregate_probe_card_tester_performance",
    args,
  });

  let raw = "";
  try {
    const result = await runTool("aggregate_probe_card_tester_performance", args, {
      toolResultMaxChars: agentConfig.toolResultMaxChars,
      history,
    });
    raw = typeof result === "string" ? result : JSON.stringify(result);
    if (raw.startsWith("aggregate_probe_card_tester_performance")) return false;
    emit({
      type: "tool_result",
      name: "aggregate_probe_card_tester_performance",
      summary: raw.slice(0, 200),
    });
    appendSyntheticToolTurn(sessionId, {
      name: "aggregate_probe_card_tester_performance",
      args,
      content: raw.slice(0, agentConfig.toolResultMaxChars ?? 12000),
      toolCallId: `probe_card_perf_vero_${Date.now()}`,
    });
  } catch {
    return false;
  }

  let payload: Record<string, unknown> | null = null;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return false;
  }

  // Tables from server; commentary via Vero. On Vero commentary failure,
  // emitDeterministicProbeCardPerfReply shows a fallback note (tables stay authoritative).
  return emitDeterministicProbeCardPerfReply(
    sessionId,
    userQuestion,
    payload,
    agentConfig,
    emit,
    {
      commentaryStatusMessage: "Vero 试点：正在生成数据解读与专业建议…",
      invokeCommentary: (q, tables) =>
        invoke(
          buildBriefCommentaryUserMessage(q, tables),
          PROBE_CARD_PERF_COMMENTARY_SYSTEM
        ),
    }
  );
}
