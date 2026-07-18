// pcr-ai-api/src/lib/agent/core/agentTouchdownReply.ts — touchdown summary reply extracted from agentLoop.ts (Round 4)
import { appendMessages, type ChatMessage } from "../agentHistory.js";
import { runTool } from "../tools/agentToolHandlers.js";
import { tryParseJsonish } from "../tools/agentChartTool.js";
import { resolveJbToolPayload } from "../jb/agentJbPayloadResolve.js";
import { extractSlotFromUserText } from "../jb/agentJbQuestionClassifiers.js";
import { emitTextInChunks } from "./agentLoopShared.js";
import type { AgentSseEvent } from "./agentLoop.js";

/**
 * Summary-round touchdown branch: JB result gave device/lot, but touch counts live
 * in per-wafer INF files. When the user named a slot, run `inf_touch_analysis` and
 * emit the per-DUT analysis; otherwise emit guidance asking which slots to query.
 * Always finishes the turn (emits `done`); the caller returns immediately after.
 * Behavior-identical to the inline `else if` branch it replaces.
 */
export async function runTouchdownSummaryReply(
  sessionId: string,
  userQuestion: string,
  lastTool: ChatMessage,
  emit: (event: AgentSseEvent) => void
): Promise<void> {
  const jbPayload = resolveJbToolPayload(sessionId, String(lastTool.content ?? ""));
  const lot = jbPayload ? String(jbPayload["lot"] ?? "") : "";
  const device = jbPayload ? String(jbPayload["device"] ?? "") : "";
  const slotSet = new Set<number>();
  if (jbPayload) {
    const summary = (jbPayload["slotYieldSummary"] as Array<{ slot: number }> | undefined) ?? [];
    summary.forEach((r) => slotSet.add(r.slot));
  }
  const slots = [...slotSet].sort((a, b) => a - b);

  // 用户问题中已包含 slot 编号时，直接调 inf_touch_analysis，跳过引导轮
  const specifiedSlot = extractSlotFromUserText(userQuestion);
  if (specifiedSlot != null && device && lot) {
    emit({ type: "status", message: `正在查询 slot ${specifiedSlot} 的 touchdown 数据…` });
    try {
      const touchRaw = await runTool("inf_touch_analysis", { device, lot, slot: specifiedSlot });
      if (typeof touchRaw === "string") {
        const td = tryParseJsonish(touchRaw) as Record<string, unknown> | null;
        if (td && !td["note"]) {
          const totalDies = Number(td["total_dies"] ?? 0);
          const withData = Number(td["dies_with_touch_data"] ?? 0);
          const maxTouch = Number(td["max_touch"] ?? 0);
          const avgTouch = Number(td["avg_touch"] ?? 0);
          const highTouchCount = Number(td["high_touch_count"] ?? 0);
          const minTh = Number(td["min_touch_threshold"] ?? 2);
          const siteStats = (td["site_stats"] as Array<{ site: number; die_count: number; avg_touch: number; max_touch: number }> | undefined) ?? [];
          const byTouch = (td["by_touch_count"] as Array<{ touch_count: number; die_count: number; good_count: number; bad_count: number; yield: number }> | undefined) ?? [];
          const highPct = totalDies > 0 ? ((highTouchCount / totalDies) * 100).toFixed(1) : "0.0";

          const lines: string[] = [
            `**lot ${lot}**（${device}）**slot ${specifiedSlot} Touchdown（探针接触次数）分析**`,
            "",
            `- 总 die 数：${totalDies}，有接触数据：${withData}`,
            `- 平均接触次数：**${avgTouch.toFixed(2)}**，最大接触次数：**${maxTouch}**`,
            `- 高接触（≥${minTh}次）die 数：**${highTouchCount}**（占 ${highPct}%）`,
          ];

          if (byTouch.length > 0) {
            lines.push("", "**接触次数分布**", "");
            lines.push("| 接触次数 | die数 | 良品 | 坏品 | 良率% |");
            lines.push("|---:|---:|---:|---:|---:|");
            for (const r of byTouch) {
              lines.push(`| ${r.touch_count} | ${r.die_count} | ${r.good_count} | ${r.bad_count} | ${(r.yield * 100).toFixed(1)}% |`);
            }
          }

          if (siteStats.length > 0) {
            lines.push("", "**各 DUT（site）接触次数**（按平均次数降序）", "");
            lines.push("| DUT | die数 | 平均接触次数 | 最大接触次数 |");
            lines.push("|---:|---:|---:|---:|");
            for (const s of siteStats) {
              lines.push(`| DUT${s.site} | ${s.die_count} | ${s.avg_touch.toFixed(2)} | ${s.max_touch} |`);
            }
          }

          const highDuts = siteStats.filter((s) => s.avg_touch >= minTh);
          if (highDuts.length > 0) {
            lines.push("", `> ⚠ 高接触 DUT：${highDuts.map((s) => `DUT${s.site}（平均 ${s.avg_touch.toFixed(1)} 次）`).join("、")}，建议优先检查这些位号针尖状态。`);
          }

          const msg = lines.join("\n");
          emitTextInChunks(msg, emit);
          appendMessages(sessionId, { role: "assistant", content: msg });
          emit({ type: "done" });
          return;
        }
        // td["note"] 表示无数据，fall through to guidance
      }
    } catch {
      // inf_touch_analysis 调用失败，fall through to guidance
    }
  }

  const slotHint = slots.length > 0
    ? `，共 ${slots.length} 片（slot ${slots[0]}–${slots[slots.length - 1]}）`
    : "";
  const deviceHint = device ? `（${device}）` : "";
  const msg = [
    `已查询到 lot **${lot}**${deviceHint}${slotHint}。`,
    "",
    "**Touchdown（探针接触次数）** 记录在各片 wafer 的 INF 文件中，需逐片调用 `inf_touch_analysis` 查询，无法一次性返回全部片数据。",
    "",
    "请告知需要查哪几片（如「第1片」「slot 3、5、12」），我将逐片列出各 DUT 的平均接触次数统计。",
  ].join("\n");
  emitTextInChunks(msg, emit);
  appendMessages(sessionId, { role: "assistant", content: msg });
  emit({ type: "done" });
}
