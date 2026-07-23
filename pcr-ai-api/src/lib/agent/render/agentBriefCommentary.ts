// pcr-ai-api/src/lib/agent/render/agentBriefCommentary.ts
// Shared "数据解读/专业建议" LLM commentary step used by JB table replies
// (agentJbTablesReply.ts) and DUT×BIN focus replies
// (agentDutAggDirectRoutes.ts). Vero when AGENT_VERO_GENERIC_LOOP is ready
// (see veroSimpleAgent.ts's isVeroGenericLoopReady), else the existing
// SiliconFlow streaming path — same branch shape already shipped in
// agentProbeCardPerfReply.ts's invokeCommentary option (Path B), just DRYed
// across the call sites that share BRIEF_COMMENTARY_SYSTEM instead of the
// probe-card-specific system prompt.
import type { AgentConfig } from "../agentConfig.js";
import type { AgentSseEvent } from "../core/agentLoop.js";
import {
  cleanStreamErrorMessage,
  emitTextInChunks,
} from "../core/agentLoopShared.js";
import { createDeepSeekFilter } from "../core/agentEmbeddedToolParsing.js";
import { streamSiliconFlow } from "../core/agentStream.js";
import type { VeroInvokeFn } from "../core/veroAgentLoopSetup.js";
import {
  invokeVeroSimpleAgent,
  buildVeroChatMessageWithSystem,
  isVeroGenericLoopReady,
} from "../../vero/veroSimpleAgent.js";
import {
  BRIEF_COMMENTARY_SYSTEM,
  buildBriefCommentaryUserMessage,
  DETERMINISTIC_COMMENTARY_SECTION_TITLE,
} from "../jb/agentJbOverviewMarkdown.js";

export type BriefCommentaryContext = {
  engineeringContext?: string;
  yieldMonitorNote?: string;
};

export type EmitBriefCommentaryOptions = {
  /** SSE status line while generating (default: "正在生成数据解读…"). */
  statusMessage?: string;
  /** Test seam: override the Vero invoke function (default: invokeVeroSimpleAgent). */
  invoke?: VeroInvokeFn;
  /**
   * System prompt for both the Vero and the SiliconFlow branch (default:
   * BRIEF_COMMENTARY_SYSTEM). Callers with a domain-specific commentary
   * system prompt (e.g. probe-card's PROBE_CARD_PERF_COMMENTARY_SYSTEM) pass
   * it here instead of duplicating this function's branch logic.
   */
  systemPrompt?: string;
  /**
   * Additional Vero-readiness check, OR'd with isVeroGenericLoopReady().
   * Lets a caller with its own independently-gated Vero pilot flag (e.g.
   * probe-card's AGENT_PROBE_CARD_VERO_PILOT / isProbeCardVeroPilotReady)
   * route through Vero here too, without this function knowing about that
   * flag by name.
   */
  alsoReadyWhen?: () => boolean;
};

const VERO_COMMENTARY_SYSTEM_PLACEHOLDER =
  "You write brief Chinese engineering commentary only. No tools. No tables.";

/**
 * Emits the DETERMINISTIC_COMMENTARY_SECTION_TITLE ("## 分析结论") section header
 * and generates commentary text via Vero or SiliconFlow. Returns the commentary
 * or a fallback message for the caller to append to session history.
 */
export async function emitBriefCommentaryOrFallback(
  userQuestion: string,
  tablesMarkdown: string,
  context: BriefCommentaryContext,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void,
  options?: EmitBriefCommentaryOptions
): Promise<string> {
  emit({
    type: "status",
    message: options?.statusMessage ?? "正在生成数据解读…",
  });
  emit({
    type: "text",
    delta: `\n\n${DETERMINISTIC_COMMENTARY_SECTION_TITLE}\n\n`,
  });

  const systemPrompt = options?.systemPrompt ?? BRIEF_COMMENTARY_SYSTEM;

  if (isVeroGenericLoopReady() || options?.alsoReadyWhen?.()) {
    const invoke = options?.invoke ?? invokeVeroSimpleAgent;
    try {
      const message = buildVeroChatMessageWithSystem(
        systemPrompt,
        buildBriefCommentaryUserMessage(userQuestion, tablesMarkdown, context)
      );
      const text = (
        await invoke(message, VERO_COMMENTARY_SYSTEM_PLACEHOLDER)
      ).trim();
      if (text) {
        emitTextInChunks(text, emit);
        return text;
      }
      const emptyFallback = "*（模型未返回解读；以上实测数据表为准。）*";
      emit({ type: "text", delta: emptyFallback });
      return emptyFallback;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errFallback = `*（解读生成失败：${cleanStreamErrorMessage(msg)}；以上实测数据表为准。）*`;
      emit({ type: "text", delta: errFallback });
      return errFallback;
    }
  }

  const commFilter = createDeepSeekFilter(emit);
  let streamError: string | undefined;
  try {
    await streamSiliconFlow(
      {
        model: agentConfig.subAgentModel,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: buildBriefCommentaryUserMessage(
              userQuestion,
              tablesMarkdown,
              context
            ),
          },
        ],
        max_tokens: 1024,
      },
      agentConfig,
      (chunk) => {
        if (chunk.type === "delta") commFilter.push(chunk.text);
        if (chunk.type === "error") streamError = chunk.message;
      }
    );
  } catch (err) {
    streamError =
      err instanceof Error ? err.message : String(err);
  }
  commFilter.finalize();
  const commentary = commFilter.cleanText.trim();
  if (commentary) return commentary;

  const fallback = streamError
    ? `*（解读生成失败：${cleanStreamErrorMessage(streamError)}；以上实测数据表为准。）*`
    : `*（模型未返回解读；以上实测数据表为准。）*`;
  emit({ type: "text", delta: fallback });
  return fallback;
}
