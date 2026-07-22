// pcr-ai-api/src/lib/agent/dispatch/directRoutes/agentProbeCardDirectRoutes.ts
// Probe-card+tester performance direct routes, extracted verbatim from
// core/agentLoop.ts (Round 3 split, Task 9).
import type { AgentConfig } from "../../agentConfig.js";
import type { AgentSseEvent } from "../../core/agentLoop.js";
import { getHistory, appendSyntheticToolTurn, appendMessages } from "../../agentHistory.js";
import { runTool } from "../../tools/agentToolHandlers.js";
import { lastToolMessage, emitTextInChunks } from "../../core/agentLoopShared.js";
import { emitDeterministicProbeCardPerfReply } from "../../render/agentProbeCardPerfReply.js";
import { isProbeCardTesterPerformanceQuestion } from "../../jb/agentJbQuestionClassifiers.js";
import {
  inferDeviceFromText,
  inferDeviceFromHistory,
  inferMaskFromText,
  inferMaskFromHistory,
  inferRecentMonthsWindow,
} from "../../agentQueryScope.js";
import { isProbeCardVeroPilotReady } from "../../../vero/veroSimpleAgent.js";
import { tryRunProbeCardVeroPilot } from "./agentProbeCardVeroPilot.js";

/**
 * 「WA03P02G …最好的探针卡+机台组合…」：PRE_LLM 直调 aggregate_probe_card_tester_performance，
 * 不依赖 LLM 选工具（真库 DeepSeek 仍常误选 query_jb_bins 单 lot 表）。
 *
 * When AGENT_PROBE_CARD_VERO_PILOT=true + WCHAT_ACCESS_TOKEN：Path B via Vero
 * simple-agent (extract → tool → deterministic tables → Vero commentary).
 * On Vero extract/tool failure, falls back to the regex + SiliconFlow path below.
 */
export async function tryRunProbeCardPerfDirectRoute(
  sessionId: string,
  userQuestion: string,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void
): Promise<boolean> {
  if (!isProbeCardTesterPerformanceQuestion(userQuestion)) return false;

  if (isProbeCardVeroPilotReady()) {
    try {
      const handled = await tryRunProbeCardVeroPilot(
        sessionId,
        userQuestion,
        agentConfig,
        emit
      );
      if (handled) return true;
    } catch {
      // Fall through to SiliconFlow regex path.
    }
  }

  const history = getHistory(sessionId);
  const device =
    inferDeviceFromText(userQuestion) || inferDeviceFromHistory(history);
  const mask =
    !device
      ? inferMaskFromText(userQuestion) || inferMaskFromHistory(history)
      : undefined;
  if (!device && !mask) return false;

  const args: Record<string, unknown> = {};
  if (device) args["device"] = device;
  else if (mask) args["mask"] = mask;
  const scopeLabel = device ?? `mask=${mask}`;
  const window = inferRecentMonthsWindow(userQuestion);
  if (window.testEndFrom) args["testEndFrom"] = window.testEndFrom;
  if (window.testEndTo) args["testEndTo"] = window.testEndTo;
  const passIdMatch = userQuestion.match(/\bpass\s*Id\s*[=:]?\s*([135])\b|\bpass\s*([135])\b/i);
  if (passIdMatch) {
    args["passId"] = Number(passIdMatch[1] ?? passIdMatch[2]);
  } else if (/sort\s*1|常温/i.test(userQuestion)) {
    args["passId"] = 1;
  } else if (/sort\s*2|高温/i.test(userQuestion)) {
    args["passId"] = 3;
  } else if (/sort\s*3|低温/i.test(userQuestion)) {
    args["passId"] = 5;
  }

  emit({ type: "status", message: `正在聚合 ${scopeLabel} 探针卡+机台组合表现…` });
  emit({ type: "tool_start", name: "aggregate_probe_card_tester_performance", args });

  let raw = "";
  try {
    const result = await runTool("aggregate_probe_card_tester_performance", args, {
      toolResultMaxChars: agentConfig.toolResultMaxChars,
      history,
    });
    raw = typeof result === "string" ? result : JSON.stringify(result);
    if (raw.startsWith("aggregate_probe_card_tester_performance")) {
      // Error string from tool — finish turn; avoid LLM re-query loop.
      emitTextInChunks(raw, emit);
      appendMessages(sessionId, { role: "assistant", content: raw });
      emit({ type: "done" });
      return true;
    }
    emit({
      type: "tool_result",
      name: "aggregate_probe_card_tester_performance",
      summary: raw.slice(0, 200),
    });
    // Must pair assistant(tool_calls) + tool — MiniMax rejects orphan tool history.
    appendSyntheticToolTurn(sessionId, {
      name: "aggregate_probe_card_tester_performance",
      args,
      content: raw.slice(0, agentConfig.toolResultMaxChars ?? 12000),
      toolCallId: `probe_card_perf_${Date.now()}`,
    });
  } catch {
    return false;
  }

  let payload: Record<string, unknown> | null = null;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // Should not happen with serializeProbeCardPerfForAgent; if it does, stop
    // the turn so the main LLM loop does not re-query the same device.
    const msg =
      "工具结果无法解析。请缩小 passId 或时间窗后重试。";
    emitTextInChunks(msg, emit);
    appendMessages(sessionId, { role: "assistant", content: msg });
    emit({ type: "done" });
    return true;
  }
  return emitDeterministicProbeCardPerfReply(
    sessionId,
    userQuestion,
    payload,
    agentConfig,
    emit
  );
}

/**
 * 直出 aggregate_probe_card_tester_performance 服务端表 + 单独一轮"仅写解读/建议"的
 * LLM 调用，复用既有 BRIEF_COMMENTARY_SYSTEM 架构。
 *
 * 2026-07-11 真实 MiniMax-M2.5 联调发现：仅在 prompt/agentPrompt.ts 里用文字硬规则要求"必须原样
 * 贴表、禁止改写"，模型仍会把 comboRankingMarkdown / cardRankingMarkdown 转述成自己的大白话
 * 总结（且转述时出现过 pass2/pass3 张冠李戴）。与 query_jb_bins 走 `tryRunDeterministicJbSummary`
 * 服务端直出表的理由完全一致：数字必须由服务端保证，不能寄望于 prompt 约束模型的转述行为。
 */
export async function tryRunDeterministicProbeCardPerfSummary(
  sessionId: string,
  userQuestion: string,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void
): Promise<boolean> {
  const history = getHistory(sessionId);
  const lastTool = lastToolMessage(history);
  if (lastTool?.name !== "aggregate_probe_card_tester_performance") return false;

  let payload: Record<string, unknown> | null = null;
  try {
    payload = JSON.parse(String(lastTool.content ?? "")) as Record<string, unknown>;
  } catch {
    return false;
  }
  return emitDeterministicProbeCardPerfReply(
    sessionId,
    userQuestion,
    payload,
    agentConfig,
    emit
  );
}
