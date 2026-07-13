// pcr-ai-api/src/lib/agent/tools/agentToolUnderperformingDutsRender.ts
// Underperforming-DUT scatter emit + lot-overview DUT section append, extracted from agentLoop.ts.
import type { AgentSseEvent } from "../core/agentLoop.js";
import type { PassUnderperformingDutsResult } from "../../lotUnderperformingDuts.js";
import {
  buildUnderperformingDutScatterOptions,
  formatAllDutsHighlightMarkdown,
} from "../agentUnderperformingDutView.js";
import {
  runLotUnderperformingDuts,
  buildGoodBinsByPassFromToolPayload,
  resolvePassIdsForDutAnalysis,
} from "../../lotUnderperformingDutsResolve.js";
import { extractLotFromUserText } from "./agentInfWaferMapTool.js";

/** 每个有 baseline 的 pass emit 一张 DUT 良率散点图（供直连路由与 LLM 工具路径复用）。 */
export function tryEmitUnderperformingDutScatter(
  passes: PassUnderperformingDutsResult[],
  emit: (event: AgentSseEvent) => void
): void {
  for (const s of buildUnderperformingDutScatterOptions(passes)) {
    emit({ type: "chart", option: s.option });
  }
}

/**
 * B 路：JB lot 概况末尾 best-effort 补「各 DUT 良率」高亮表 + 散点图。
 * payload 缺 lot/device 或 INF 失败 → 返回 "" 静默跳过（不阻塞主概况）。
 * 返回追加的 markdown（供调用方并入持久化的 assistant 内容）。
 */
export async function tryAppendUnderperformingDutSection(
  payload: Record<string, unknown>,
  emit: (event: AgentSseEvent) => void,
  userQuestion?: string
): Promise<string> {
  const lotInQ = userQuestion ? extractLotFromUserText(userQuestion) : undefined;
  let lot = String(payload["lot"] ?? "").trim();
  let device = String(payload["device"] ?? "").trim();

  if (lotInQ) {
    const qLot = lotInQ.trim();
    if (!lot || lot.toUpperCase() !== qLot.toUpperCase()) {
      lot = qLot;
      const recent = payload["recentLotsByTestEnd"] as
        | Array<{ lot?: string; device?: string }>
        | undefined;
      const hit = recent?.find(
        (e) => String(e.lot ?? "").trim().toUpperCase() === qLot.toUpperCase()
      );
      if (hit?.device) device = String(hit.device).trim();
    }
  }
  // device 可能是确定性层的占位符 "—"（见 agentJbDeterministicReply）→ 视为无 device，
  // 避免拿占位符去跑一次注定失败的慢 INF 取数。
  if (!lot || !device || device === "—") return "";

  emit({ type: "status", message: "正在补充各 DUT 良率分析（较慢）…" });
  // best-effort 整节：取数 + 格式化 + emit 全包在 try 内，任何异常都静默跳过、返回 ""，
  // 绝不打断已流出的主概况（本函数在 emitDeterministicJbTablesReply 主表之后调用）。
  try {
    const goodBinsByPassId = buildGoodBinsByPassFromToolPayload(payload);
    const passIds = resolvePassIdsForDutAnalysis(undefined, payload);
    const resp = await runLotUnderperformingDuts({
      lot,
      device,
      passIds,
      ...(goodBinsByPassId ? { goodBinsByPassId } : {}),
    });
    const passes = resp.passes ?? [];
    const md = formatAllDutsHighlightMarkdown(passes, resp.lot, resp.device);
    if (!md.trim()) return "";

    const section = `\n\n### 🔬 各 DUT 良率（低于阈值 🔴）\n\n${md}`;
    emit({ type: "text", delta: section });
    tryEmitUnderperformingDutScatter(passes, emit);
    return section;
  } catch {
    return ""; // best-effort：失败静默跳过
  }
}
