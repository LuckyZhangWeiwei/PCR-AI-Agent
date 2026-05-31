// pcr-ai-api/src/lib/agent/agentJbDeterministicReply.ts
/** 总结轮：服务端直出预计算表，LLM 仅写简短解读（禁止改数字）。 */

import { formatLotYieldOverviewMarkdown } from "./agentJbHistoryCompact.js";

export type BinTrendDigest = {
  bin: number;
  passId: number;
  markdown: string;
};

export type AgentTablesDigest = {
  lotOverview?: string;
  binTrends?: BinTrendDigest[];
  passIdsPresent?: number[];
};

export type JbReplyMode = "lot_overview" | "bin_trend" | "generic";

/** 从用户问题识别 BIN 编号（BIN7 / bin 7）。 */
export function extractBinFromUserText(text: string): number | null {
  const m =
    text.match(/\bBIN\s*[#:]?\s*(\d{1,3})\b/i) ??
    text.match(/\bbin\s*[#:]?\s*(\d{1,3})\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 0 && n <= 255 ? n : null;
}

/** 是否 lot 整体/概况类问题（非单一 BIN 趋势）。 */
export function isLotOverviewQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (extractBinFromUserText(t) != null && /趋势|按\s*slot|各\s*片|1\s*[-~–]\s*25|每\s*片/i.test(t)) {
    return false;
  }
  if (extractBinFromUserText(t) != null && !/整体|概况|测试情况|重新计算/i.test(t)) {
    return false;
  }
  return /整体|概况|测试情况|重新计算|lot\s*概况|批次.*情况/i.test(t);
}

export function isBinTrendQuestion(text: string): boolean {
  const bin = extractBinFromUserText(text);
  if (bin == null) return false;
  return /趋势|按\s*slot|各\s*片|1\s*[-~–]\s*25|每\s*片|分布|颗数/i.test(text);
}

export function detectJbReplyMode(userMessage: string): JbReplyMode {
  if (isBinTrendQuestion(userMessage)) return "bin_trend";
  if (isLotOverviewQuestion(userMessage)) return "lot_overview";
  return "generic";
}

export function parseJbToolPayload(
  raw: string
): Record<string, unknown> | null {
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    return o && typeof o === "object" ? o : null;
  } catch {
    return null;
  }
}

function digestFromPayload(o: Record<string, unknown>): AgentTablesDigest {
  const direct = o["agentTablesDigest"] as AgentTablesDigest | undefined;
  if (direct && (direct.lotOverview || direct.binTrends?.length)) {
    return direct;
  }
  return {
    lotOverview:
      typeof o["lotYieldOverviewMarkdown"] === "string"
        ? o["lotYieldOverviewMarkdown"]
        : undefined,
    binTrends: Array.isArray(o["badBinSlotTrends"])
      ? (o["badBinSlotTrends"] as BinTrendDigest[])
      : undefined,
    passIdsPresent: Array.isArray(o["passIdsPresent"])
      ? (o["passIdsPresent"] as number[])
      : undefined,
  };
}

function pickPassIdForBinTrend(
  userMessage: string,
  trends: BinTrendDigest[],
  passIdsPresent?: number[]
): number | null {
  if (/常温|sort\s*1|pass\s*1|passId\s*[=:]?\s*1/i.test(userMessage)) return 1;
  if (/高温|sort\s*2|pass\s*3|passId\s*[=:]?\s*3/i.test(userMessage)) return 3;
  if (/低温|sort\s*3|pass\s*5|passId\s*[=:]?\s*5/i.test(userMessage)) return 5;
  const inTrends = [...new Set(trends.map((t) => t.passId))].sort((a, b) => a - b);
  if (inTrends.length === 1) return inTrends[0]!;
  if (passIdsPresent?.includes(1) && inTrends.includes(1)) return 1;
  return inTrends[0] ?? null;
}

/** 根据用户问题从工具 JSON 选出应直出的 markdown 表（不改写）。 */
export function buildDeterministicJbTables(
  userMessage: string,
  toolPayload: Record<string, unknown>
): string | null {
  const digest = digestFromPayload(toolPayload);
  const mode = detectJbReplyMode(userMessage);

  if (mode === "bin_trend") {
    const bin = extractBinFromUserText(userMessage);
    const trends = digest.binTrends ?? [];
    if (bin == null || !trends.length) return null;
    const matches = trends.filter((t) => t.bin === bin);
    if (!matches.length) return null;
    const passId = pickPassIdForBinTrend(
      userMessage,
      matches,
      digest.passIdsPresent
    );
    const chosen =
      passId != null
        ? matches.filter((t) => t.passId === passId)
        : matches;
    if (!chosen.length) return null;
    if (chosen.length === 1) return chosen[0]!.markdown;
    return chosen.map((t) => t.markdown).join("\n\n");
  }

  if (mode === "lot_overview" || mode === "generic") {
    const overview =
      digest.lotOverview?.trim() ||
      formatLotYieldOverviewMarkdown(toolPayload)?.trim();
    if (overview) return overview;
  }

  if (mode === "generic") {
    const bin = extractBinFromUserText(userMessage);
    if (bin != null && digest.binTrends?.length) {
      const m = digest.binTrends.filter((t) => t.bin === bin);
      if (m.length) return m.map((t) => t.markdown).join("\n\n");
    }
  }

  return rebuildDeterministicTablesFallback(toolPayload);
}

/** serialize 截断后仍可用 yield/interrupt/overview 片段拼表。 */
function rebuildDeterministicTablesFallback(
  toolPayload: Record<string, unknown>
): string | null {
  const overview = formatLotYieldOverviewMarkdown(toolPayload)?.trim();
  if (overview) return overview;

  const parts: string[] = [];
  const interruptMd = toolPayload["slotYieldInterruptMarkdown"];
  if (typeof interruptMd === "string" && interruptMd.trim()) {
    parts.push(interruptMd.trim());
  }
  const yieldMd = toolPayload["yieldByPassIdMarkdown"];
  if (typeof yieldMd === "string" && yieldMd.trim()) {
    parts.push(yieldMd.trim());
  }
  const pivotMd = toolPayload["slotYieldPivotMarkdown"];
  if (typeof pivotMd === "string" && pivotMd.trim()) {
    parts.push(pivotMd.trim());
  }
  return parts.length ? parts.join("\n\n") : null;
}

export const DETERMINISTIC_TABLES_HEADER =
  "以下表格由服务端根据 JB STAR 实测数据生成，**数字与下表一致**；请勿自行合并 sort 或改写半片良率/BIN 颗数。";

export const BRIEF_COMMENTARY_SYSTEM =
  "你是资深晶圆测试（Wafer Test）与探针卡（Probe Card）可靠性工程师，熟悉 JB STAR、Yield Monitor、INF map 与 DUT 维护。" +
  "术语：JB 字段 slot = waferId（第几片 wafer，对用户写 waferId）；INF 字段 dut = 探针卡触点（对用户写 DUT，勿写 site）。" +
  "用户消息含【实测数据表】，表中数字为最终结论，禁止修改、平均或合并 sort/半片。" +
  "你必须用中文输出以下两个小节（不要其它大表）：\n\n" +
  "### 数据解读\n" +
  "3–5 句：仅解读表内数字；有 INTERRUPT 时须体现「各中断段→整片合并→批次整体」逻辑，勿只报合并整片或只报后半；禁止复述整表。\n\n" +
  "### 专业建议\n" +
  "三个要点，每点 1–2 句，极度专业、可执行、简短，用工程术语：\n" +
  "1. **晶圆测试（Wafer Test）**：pass1/3/5 各层、INTERRUPT 与续测、tester 稳定性、工艺批次 vs 测试机因素；禁止写常温/高温/低温。\n" +
  "2. **探针卡（Probe Card）**：CARDID、清卡/针压/overdrive、中途换卡与污染、bin 模式指向测试项还是接触。\n" +
  "3. **DUT 维护**：针尖磨损/氧化、单 DUT vs 邻域 vs 全卡贬损、align/清针/换卡；无 Yield Monitor 依据时写明建议补查 delta_diff 或 INF DUT map。\n" +
  "禁止编造表中未出现的现象；无依据写「建议补查 Yield Monitor / INF site-bin-bylot」。";

/** 从 JB 工具 JSON 提取工程上下文，供解读/建议引用（非数字）。 */
export function buildEngineeringContextFromPayload(
  payload: Record<string, unknown>
): string {
  const lines: string[] = [];

  const passIds = payload.passIdsPresent as number[] | undefined;
  if (passIds?.length) {
    lines.push(`本批出现的测试层 passId：${passIds.join(", ")}`);
  }

  const cardMd = payload.cardByPassIdMarkdown;
  if (typeof cardMd === "string" && cardMd.trim()) {
    lines.push("各 sort 探针卡见上表 cardByPassId 段。");
  }

  const changes = payload.cardChangesBySlotPass as
    | Array<{ slot: number; passId: number; hasCardChange: boolean; hasTestInterrupt: boolean }>
    | undefined;
  if (changes?.length) {
    const bad = changes.filter((c) => c.hasCardChange || c.hasTestInterrupt);
    if (bad.length) {
      lines.push(
        `中途换卡/中断 (waferId/slot,passId)：${bad
          .map((c) => `${c.slot}/pass${c.passId}`)
          .slice(0, 8)
          .join(", ")}${bad.length > 8 ? "…" : ""}`
      );
    }
  }

  const tester = payload.testerId ?? payload.TESTERID;
  if (tester) lines.push(`测试机：${String(tester)}`);

  return lines.length ? lines.join("\n") : "（无额外工程上下文字段）";
}

export function buildYieldMonitorContextNote(
  historyNote?: string
): string {
  if (!historyNote?.trim()) return "";
  return `\n【Yield Monitor 补充】\n${historyNote.trim()}\n`;
}

export function buildBriefCommentaryUserMessage(
  userQuestion: string,
  tablesMarkdown: string,
  options?: { engineeringContext?: string; yieldMonitorNote?: string }
): string {
  const ctx = options?.engineeringContext?.trim() ?? "";
  const ym = buildYieldMonitorContextNote(options?.yieldMonitorNote);
  return (
    `【实测数据表 — 禁止改数字，勿重复粘贴全表】\n\n${tablesMarkdown}\n\n` +
    `---\n\n【工程上下文】\n${ctx || "（见上表）"}${ym}\n\n` +
    `【用户问题】\n${userQuestion}\n\n` +
    `请按 system 要求输出「### 数据解读」与「### 专业建议」两节；专业建议须覆盖 Wafer Test、Probe Card、DUT 维护，极度专业且简短。` +
    `正文用 waferId 指代片号（表头 slot 列除外）、用 DUT 指代触点（勿写 site）；测试层用 pass1/3/5，禁止常温/高温/低温。`
  );
}
