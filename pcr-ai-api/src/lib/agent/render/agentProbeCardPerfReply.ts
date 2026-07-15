// pcr-ai-api/src/lib/agent/render/agentProbeCardPerfReply.ts
// Deterministic probe-card/tester performance reply, extracted verbatim from agentLoop.ts.
import type { AgentConfig } from "../agentConfig.js";
import type { AgentSseEvent } from "../core/agentLoop.js";
import { appendMessages } from "../agentHistory.js";
import {
  emitTextInChunks,
  cleanStreamErrorMessage,
} from "../core/agentLoopShared.js";
import { createDeepSeekFilter } from "../core/agentEmbeddedToolParsing.js";
import { streamSiliconFlow } from "../core/agentStream.js";
import {
  buildProbeCardPerfSummaryMarkdown,
  type PassGroupResult,
} from "../../probeCard/probeCardTesterPerformance.js";
import {
  PROBE_CARD_PERF_COMMENTARY_SYSTEM,
  buildBriefCommentaryUserMessage,
  DETERMINISTIC_DATA_SECTION_TITLE,
  DETERMINISTIC_COMMENTARY_SECTION_TITLE,
} from "../jb/agentJbOverviewMarkdown.js";

/**
 * 从 aggregate_probe_card_tester_performance JSON 直出四表 + 解读 LLM（与总结轮共用）。
 */
export async function emitDeterministicProbeCardPerfReply(
  sessionId: string,
  userQuestion: string,
  payload: Record<string, unknown>,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void
): Promise<boolean> {
  const groups = Array.isArray(payload["groups"])
    ? (payload["groups"] as Array<Record<string, unknown>>)
    : [];
  if (groups.length === 0) return false;

  const tableParts: string[] = [];
  for (const g of groups) {
    for (const key of [
      "comboRankingMarkdown",
      "cardRankingMarkdown",
      "cardTrendMarkdown",
      "cardBadBinMarkdown",
    ] as const) {
      const md = g[key];
      if (typeof md === "string" && md.trim()) tableParts.push(md.trim());
    }
  }
  if (tableParts.length === 0) return false;

  const summaryGroups: Array<
    Pick<PassGroupResult, "passId" | "comboRanking" | "cardRanking">
  > = groups.map((g) => ({
    passId: Number(g["passId"]),
    comboRanking:
      (g["comboRanking"] as PassGroupResult["comboRanking"]) ?? [],
    cardRanking: (g["cardRanking"] as PassGroupResult["cardRanking"]) ?? [],
  }));
  const device = String(payload["device"] ?? "").trim();
  const summary = buildProbeCardPerfSummaryMarkdown(summaryGroups, device || undefined);
  const tables = tableParts.join("\n\n");

  const tablesBlock = summary
    ? `${DETERMINISTIC_DATA_SECTION_TITLE}\n\n### 🎯 一眼重点\n\n${summary}\n\n---\n\n${tables}`
    : `${DETERMINISTIC_DATA_SECTION_TITLE}\n\n${tables}`;
  emit({ type: "status", message: "正在输出服务端探针卡/机台组合排名表…" });
  emitTextInChunks(tablesBlock, emit);

  emit({ type: "status", message: "正在生成数据解读与专业建议…" });
  emit({
    type: "text",
    delta: `\n\n${DETERMINISTIC_COMMENTARY_SECTION_TITLE}\n\n`,
  });

  const commFilter = createDeepSeekFilter(emit);
  let streamError: string | undefined;

  await streamSiliconFlow(
    {
      model: agentConfig.subAgentModel,
      messages: [
        { role: "system", content: PROBE_CARD_PERF_COMMENTARY_SYSTEM },
        {
          role: "user",
          content: buildBriefCommentaryUserMessage(userQuestion, tables),
        },
      ],
      max_tokens: 1024,
    },
    agentConfig,
    (chunk) => {
      switch (chunk.type) {
        case "delta":
          commFilter.push(chunk.text);
          break;
        case "error":
          streamError = chunk.message;
          break;
        default:
          break;
      }
    }
  );

  commFilter.finalize();
  const commentary = commFilter.cleanText.trim();

  let commentaryOrFallback: string;
  if (commentary) {
    commentaryOrFallback = commentary;
  } else {
    commentaryOrFallback = streamError
      ? `*（解读生成失败：${cleanStreamErrorMessage(streamError)}；以上实测数据表为准。）*`
      : `*（模型未返回解读；以上实测数据表为准。）*`;
    emit({ type: "text", delta: commentaryOrFallback });
  }

  const full =
    tablesBlock +
    `\n\n${DETERMINISTIC_COMMENTARY_SECTION_TITLE}\n\n` +
    commentaryOrFallback;

  appendMessages(sessionId, { role: "assistant", content: full });
  emit({ type: "done" });
  return true;
}
