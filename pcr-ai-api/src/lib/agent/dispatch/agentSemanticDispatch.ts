// pcr-ai-api/src/lib/agent/dispatch/agentSemanticDispatch.ts
// Decision-driven deterministic dispatch direct route, extracted from agentLoop.ts.
import type { AgentConfig } from "../agentConfig.js";
import type { AgentSseEvent } from "../core/agentLoop.js";
import { getConfig } from "../../runtimeConfig.js";
import { getHistory, appendMessages } from "../agentHistory.js";
import { runTool } from "../tools/agentToolHandlers.js";
import { storeJbQuerySessionCache } from "../jb/agentJbBinFormat.js";
import { parseJbToolPayload, resolveJbToolPayload } from "../jb/agentJbPayloadResolve.js";
import { buildScopeLabelFromAggregateArgs } from "../agentQueryScope.js";
import { resolveJbRouteAsync } from "../jbRouteResolver.js";
import { resolveDispatch, type DispatchResult } from "../agentSemanticDispatchTable.js";
import {
  stampFirstTestNote,
  DETERMINISTIC_DATA_SECTION_TITLE,
  DETERMINISTIC_COMMENTARY_SECTION_TITLE,
} from "../jb/agentJbOverviewMarkdown.js";
import { renderAggregateJbBinsResult } from "../render/agentAggregateBinsRender.js";
import { emitDeterministicJbTablesReply } from "../render/agentJbTablesReply.js";
import {
  lastToolMessage,
  emitTextInChunks,
  toolResultForHistory,
} from "../core/agentLoopShared.js";

type LotYieldRankEntry = {
  lot: string;
  device: string;
  yieldPct: number | null;
  worstSlot: number | null;
  worstPassId: number | null;
  testEnd: string | null;
};

function lotYieldRankingTopN(userQuestion: string): number {
  const nMatch = userQuestion.match(/top\s*(\d+)|(\d+)\s*个/i);
  return nMatch
    ? Math.min(Math.max(1, Number(nMatch[1] ?? nMatch[2])), 50)
    : 5;
}

/** 合并多 lot query_jb_bins 的 lotYieldRankByTestEnd（A1-4 多 lot 良率排行）。 */
function mergeLotYieldRankingPayloads(
  payloads: Record<string, unknown>[]
): Record<string, unknown> {
  const base = { ...payloads[0]! };
  const byLot = new Map<string, LotYieldRankEntry>();
  for (const p of payloads) {
    const rank = p["lotYieldRankByTestEnd"] as LotYieldRankEntry[] | undefined;
    for (const e of rank ?? []) {
      if (!e.lot || e.yieldPct == null) continue;
      const prev = byLot.get(e.lot);
      if (!prev || (e.testEnd ?? "") >= (prev.testEnd ?? "")) {
        byLot.set(e.lot, e);
      }
    }
  }
  base["lotYieldRankByTestEnd"] = [...byLot.values()].sort((a, b) =>
    (b.testEnd ?? "").localeCompare(a.testEnd ?? "")
  );
  return base;
}

async function enrichLotYieldRankingPayload(
  sessionId: string,
  userQuestion: string,
  basePayload: Record<string, unknown>,
  scopeArgs: Record<string, unknown>,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void
): Promise<Record<string, unknown>> {
  const wantN = lotYieldRankingTopN(userQuestion);
  const rank = basePayload["lotYieldRankByTestEnd"] as LotYieldRankEntry[] | undefined;
  const recent = basePayload["recentLotsByTestEnd"] as Array<{ lot?: string }> | undefined;
  const validRank = (rank ?? []).filter((e) => e.yieldPct != null);

  if (!recent || recent.length <= 1) return basePayload;
  if (validRank.length >= wantN && validRank.length >= 2) return basePayload;

  const lotsToFetch = recent
    .slice(0, Math.max(wantN + 2, 8))
    .map((e) => String(e.lot ?? "").trim())
    .filter(Boolean);
  const primaryLot = String(basePayload["lot"] ?? "").trim();
  const mergedPayloads: Record<string, unknown>[] = [basePayload];

  for (const lot of lotsToFetch) {
    if (lot === primaryLot && validRank.some((r) => r.lot === lot)) continue;
    const lotArgs: Record<string, unknown> = {
      lot,
      limit: 500,
      testEndFrom: scopeArgs["testEndFrom"] ?? "2020-01-01",
    };
    emit({ type: "status", message: `正在查询 ${lot} 良率…` });
    emit({ type: "tool_start", name: "query_jb_bins", args: lotArgs });
    try {
      let lotCache: string | undefined;
      const result = await runTool("query_jb_bins", lotArgs, {
        toolResultMaxChars: agentConfig.toolResultMaxChars,
        history: getHistory(sessionId),
        onJbBinsWrapped: (wrapped) => {
          lotCache = storeJbQuerySessionCache(sessionId, wrapped);
        },
      });
      const raw = typeof result === "string" ? result : JSON.stringify(result);
      const historyContent = toolResultForHistory(
        "query_jb_bins",
        raw,
        agentConfig.toolResultMaxHistoryChars,
        agentConfig.toolResultMaxChars,
        lotCache
      );
      emit({
        type: "tool_result",
        name: "query_jb_bins",
        summary: historyContent.slice(0, 200),
      });
      appendMessages(sessionId, {
        role: "tool",
        name: "query_jb_bins",
        tool_call_id: `yield_rank_${lot}_${Date.now()}`,
        content: historyContent,
      });
      const p =
        (lotCache ? parseJbToolPayload(lotCache) : null) ??
        parseJbToolPayload(historyContent);
      if (p) mergedPayloads.push(p);
    } catch {
      /* skip lot */
    }
  }

  if (mergedPayloads.length <= 1) return basePayload;
  return mergeLotYieldRankingPayloads(mergedPayloads);
}

/**
 * 阶段三：决策驱动确定性派发（dark-launch，flag `JB_DETERMINISTIC_DISPATCH=true` 才生效）。
 * 对 `resolveDispatch` 返回高置信 plan 的跨实体 mode 在 LLM 前服务端直发查询与渲染。
 * 查询失败 / 渲染为空 → return false 交回 LLM，绝不 dead-end。
 */
export async function tryRunSemanticDispatchDirectRoute(
  sessionId: string,
  userQuestion: string,
  agentConfig: AgentConfig,
  emit: (event: AgentSseEvent) => void
): Promise<boolean> {
  if (!getConfig().jbDeterministicDispatch) return false; // dark-launch

  const history = getHistory(sessionId);
  const lastToolName = lastToolMessage(history)?.name;
  const decision = await resolveJbRouteAsync(
    userQuestion, { lastToolName }, agentConfig, undefined, history
  );
  const plan: DispatchResult | null = resolveDispatch(decision, userQuestion, history);
  if (!plan) return false; // 低置信 / 不在派发表 → 交 LLM

  emit({ type: "status", message: "正在按意图直发查询…" });
  emit({ type: "tool_start", name: plan.queryTool, args: plan.args });
  let raw = "";
  let jbCache: string | undefined;
  try {
    const result = await runTool(plan.queryTool, plan.args, {
      toolResultMaxChars: agentConfig.toolResultMaxChars,
      history,
      onJbBinsWrapped: (wrapped) => { jbCache = storeJbQuerySessionCache(sessionId, wrapped); },
    });
    raw = typeof result === "string" ? result : JSON.stringify(result);
    emit({ type: "tool_result", name: plan.queryTool, summary: raw.slice(0, 200) });
    appendMessages(sessionId, {
      role: "tool", name: plan.queryTool,
      tool_call_id: `jb_dispatch_${Date.now()}`,
      content: raw.slice(0, agentConfig.toolResultMaxChars ?? 12000),
    });
  } catch {
    return false; // 查询失败 → 落回 LLM（不 dead-end）
  }

  if (plan.renderKind === "aggregate") {
    const scopeLabel = buildScopeLabelFromAggregateArgs(plan.args);
    const rendered = renderAggregateJbBinsResult(raw, userQuestion, scopeLabel);
    if (!rendered?.table?.trim()) return false; // 渲染空 → 落回 LLM
    const block = stampFirstTestNote(
      (rendered.withDataTitle ? `${DETERMINISTIC_DATA_SECTION_TITLE}\n\n` : "") +
        rendered.table +
        (rendered.commentaryNote
          ? `\n\n${DETERMINISTIC_COMMENTARY_SECTION_TITLE}\n\n${rendered.commentaryNote}`
          : "")
    );
    emitTextInChunks(block, emit);
    appendMessages(sessionId, { role: "assistant", content: block });
    emit({ type: "done" });
    return true;
  }

  // renderKind === "emitTables": 解析 payload → emitDeterministicJbTablesReply
  let payload =
    (jbCache ? parseJbToolPayload(jbCache) : null) ??
    resolveJbToolPayload(sessionId, raw);
  if (!payload) return false;

  if (decision.mode === "lot_yield_ranking") {
    payload = await enrichLotYieldRankingPayload(
      sessionId,
      userQuestion,
      payload,
      plan.args,
      agentConfig,
      emit
    );
  }

  return emitDeterministicJbTablesReply(sessionId, userQuestion, payload, agentConfig, emit);
}
