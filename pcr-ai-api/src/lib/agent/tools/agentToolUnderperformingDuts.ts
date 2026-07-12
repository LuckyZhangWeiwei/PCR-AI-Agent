// pcr-ai-api/src/lib/agent/tools/agentToolUnderperformingDuts.ts
import { runLotUnderperformingDuts } from "../../lotUnderperformingDutsResolve.js";
import { formatAllDutsHighlightMarkdown } from "../agentUnderperformingDutView.js";
import { truncateResult, type RunToolOptions } from "./agentToolHandlers.js";

export async function toolQueryLotUnderperformingDuts(
  args: Record<string, unknown>,
  maxChars: number,
  options?: RunToolOptions
): Promise<string> {
  const lot = typeof args["lot"] === "string" ? args["lot"].trim() : "";
  if (!lot) return "query_lot_underperforming_duts 参数错误: lot 不能为空";

  const device = typeof args["device"] === "string" ? args["device"].trim() : "";
  const thresholdRaw = args["thresholdRatio"];
  const thresholdRatio =
    typeof thresholdRaw === "number" && Number.isFinite(thresholdRaw)
      ? thresholdRaw
      : undefined;

  const passIds: number[] = [];
  if (typeof args["passId"] === "number") passIds.push(Math.round(args["passId"]));
  if (Array.isArray(args["passIds"])) {
    for (const p of args["passIds"]) {
      if (typeof p === "number") passIds.push(Math.round(p));
    }
  }

  try {
    const result = await runLotUnderperformingDuts({
      lot,
      device: device || undefined,
      passIds: passIds.length > 0 ? passIds : undefined,
      thresholdRatio,
      includeMarkdown: true,
    });
    options?.onUnderperformingDuts?.(result.passes ?? []);
    // 内部工具结果串：用全 DUT 高亮表（非 REST 字段，不违反非破坏约束）
    const md =
      formatAllDutsHighlightMarkdown(result.passes ?? [], result.lot, result.device) ||
      (result.underperformingDutsMarkdown ?? "");
    const { underperformingDutsMarkdown: _md, ...payload } = result;
    void _md;
    const body = truncateResult(payload, maxChars);
    return (md ? md + "\n\n" : "") + body;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e && typeof e === "object" && "statusCode" in e) {
      const code = (e as { statusCode: number }).statusCode;
      if (code === 404) return `query_lot_underperforming_duts: lot 未找到 — ${msg}`;
      if (code === 400) return `query_lot_underperforming_duts 参数错误: ${msg}`;
    }
    return `query_lot_underperforming_duts 执行失败: ${msg}`;
  }
}
