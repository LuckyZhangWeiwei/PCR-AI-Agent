// src/lib/agent/jbIntentClassifier.ts
import type { AgentConfig } from "./agentConfig.js";
import { type JbReplyMode } from "./jb/agentJbQuestionClassifiers.js";
import { type JbRouteParams } from "./jbRouteResolver.js";
import {
  invokeVeroSimpleAgent,
  buildVeroChatMessageWithSystem,
  isVeroGenericLoopReady,
} from "../vero/veroSimpleAgent.js";

export type VeroInvokeFn = (prompt: string, systemPrompt: string) => Promise<string>;

const VALID_MODES: ReadonlySet<string> = new Set([
  "lot_overview","single_slot","bin_trend","slot_pass_yield","interrupt_count",
  "tester_machine","equipment","bad_bin_ranking","bin_card_attribution",
  "card_yield_compare","lot_yield_ranking","lot_listing","per_slot_bin_ranking",
  "card_test_overview","card_dut_question","generic",
]);

export interface JbClassifierResult {
  mode: JbReplyMode;
  confidence: "high" | "low";
  params?: JbRouteParams;
  flags?: { isMultiCardCompare: boolean; isMultiLotCompare: boolean; isDutLevel: boolean };
}

export type ChatFn = (prompt: string, agentConfig: AgentConfig) => Promise<string>;

const SYSTEM = `你是测试数据问句的意图分类器。仅输出 JSON:{"mode":<枚举>,"confidence":"high|low","focusBin":<数字或null>,"lot":<字符串或null>,"cardId":<字符串或null>,"isMultiCardCompare":<bool>,"isMultiLotCompare":<bool>,"isDutLevel":<bool>}。mode 必须是以下之一:` +
  [...VALID_MODES].join(",") + `。多卡对比/模糊/跨实体一律 mode=generic。isMultiCardCompare:对比≥2张卡;isMultiLotCompare:对比/枚举多个lot;isDutLevel:问dut/嫌疑die。`;

async function defaultChat(
  prompt: string,
  agentConfig: AgentConfig,
  invokeVero: VeroInvokeFn
): Promise<string> {
  if (isVeroGenericLoopReady()) {
    const message = buildVeroChatMessageWithSystem(SYSTEM, prompt);
    return invokeVero(message, "You are a JSON-only classifier. No tools, no prose.");
  }
  const { streamSiliconFlow } = await import("./core/agentStream.js");
  let out = "";
  await streamSiliconFlow(
    { model: agentConfig.subAgentModel, messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: prompt },
    ], max_tokens: 120 },
    agentConfig,
    (c: any) => { if (c.type === "delta") out += c.text; }
  );
  return out;
}

export async function callJbIntentClassifier(
  q: string,
  ctx: { lastToolName?: string; cachedLot?: string },
  agentConfig: AgentConfig,
  deps?: { chat?: ChatFn; invokeVero?: VeroInvokeFn }
): Promise<JbClassifierResult | null> {
  const invokeVero = deps?.invokeVero ?? invokeVeroSimpleAgent;
  const chat = deps?.chat ?? ((prompt, cfg) => defaultChat(prompt, cfg, invokeVero));
  const prompt = `问题:${q}\n上一工具:${ctx.lastToolName ?? "无"}\n缓存lot:${ctx.cachedLot ?? "无"}`;
  let raw: string;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    raw = await Promise.race([
      chat(prompt, agentConfig),
      new Promise<string>((_, rej) => {
        timer = setTimeout(() => rej(new Error("timeout")), 4000);
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj: any;
  try { obj = JSON.parse(m[0]); } catch { return null; }
  if (!obj || !VALID_MODES.has(obj.mode)) return null;
  const params: JbRouteParams = {};
  if (typeof obj.focusBin === "number") params.focusBin = obj.focusBin;
  if (typeof obj.lot === "string" && obj.lot) params.lot = obj.lot;
  if (typeof obj.cardId === "string" && obj.cardId) params.cardId = obj.cardId;
  const flags =
    typeof obj.isMultiCardCompare === "boolean"
      ? {
          isMultiCardCompare: !!obj.isMultiCardCompare,
          isMultiLotCompare: !!obj.isMultiLotCompare,
          isDutLevel: !!obj.isDutLevel,
        }
      : undefined;
  return {
    mode: obj.mode as JbReplyMode,
    confidence: obj.confidence === "high" ? "high" : "low",
    params,
    flags,
  };
}
