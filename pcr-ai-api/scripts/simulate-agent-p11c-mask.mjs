/**
 * 模拟 Agent 对话（不调用 LLM）：P11C mask 近两周 → get_filter_values + query_jb_bins + 确定性表
 *
 * 用法：
 *   npm run build
 *   node scripts/simulate-agent-p11c-mask.mjs
 *
 * 环境：
 *   PCR_API_BASE  默认 http://10.192.130.89:30008（拉 Oracle 实测行）
 */
import { randomUUID } from "node:crypto";
import { buildDeterministicJbTables } from "../dist/lib/agent/jb/agentJbOverviewMarkdown.js";
import { detectJbReplyMode } from "../dist/lib/agent/jb/agentJbQuestionClassifiers.js";
import { resolveJbToolPayload } from "../dist/lib/agent/jb/agentJbPayloadResolve.js";
import {
  buildJbSessionCacheJson,
  storeJbQuerySessionCache,
  wrapJbQueryResultForAgent,
} from "../dist/lib/agent/jb/agentJbBinFormat.js";
import { enrichInfcontrolLayerBinRowV2 } from "../dist/lib/passBinSemantics.js";
import { compactJbCacheForHistory } from "../dist/lib/agent/jb/agentJbHistoryCompact.js";
import {
  clearJbToolRawJson,
  getJbToolRawJson,
} from "../dist/lib/agent/agentJbSessionCache.js";
import { runGetFilterValues } from "../dist/lib/agent/tools/agentFilterValuesTool.js";

const API_BASE = (process.env.PCR_API_BASE || "http://10.192.130.89:30008").replace(
  /\/$/,
  ""
);
const USER_QUESTION =
  process.argv[2]?.trim() ||
  "通过 mask P11C 查近两周的 测试的device";
const TEST_END_FROM = "2026-05-31";

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

function preview(text, maxLines = 55) {
  const lines = String(text ?? "").split("\n");
  const head = lines.slice(0, maxLines).join("\n");
  const tail =
    lines.length > maxLines
      ? `\n…（共 ${lines.length} 行，省略 ${lines.length - maxLines} 行）`
      : "";
  return head + tail;
}

async function fetchJbMaskRows() {
  const url = `${API_BASE}/api/v4/infcontrol-layer-bins/v4?mask=P11C&testEndFrom=${TEST_END_FROM}&limit=200`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`JB fetch HTTP ${res.status}`);
  const j = await res.json();
  return j.rows ?? [];
}

async function main() {
  const sessionId = `sim-p11c-${randomUUID()}`;
  clearJbToolRawJson(sessionId);

  console.log("=== 模拟对话 ===");
  console.log("用户:", USER_QUESTION);
  console.log("API:", API_BASE);
  console.log("sessionId:", sessionId);
  console.log("");

  // ── Turn 1: get_filter_values ──
  console.log("--- Tool: get_filter_values(domain=both, field=device, mask=P11C) ---");
  let filterResult;
  try {
    filterResult = await runGetFilterValues({
      domain: "both",
      field: "device",
      mask: "P11C",
      limit: 10,
    });
  } catch (e) {
    filterResult = { error: String(e) };
  }
  const filterJson =
    typeof filterResult === "string" ? filterResult : JSON.stringify(filterResult);
  console.log(filterJson.slice(0, 300));
  const filterParsed = tryParse(filterJson);
  if (filterParsed?.values?.length) {
    console.log(`→ device 列表: ${filterParsed.values.join(", ")}`);
  } else {
    console.log("→ device 列表为空（与线上一致时可改用 query_jb_bins(mask) 直查）");
  }
  console.log("");

  // ── Turn 2: query_jb_bins ──
  console.log(`--- Tool: query_jb_bins(mask=P11C, testEndFrom=${TEST_END_FROM}, limit=200) ---`);
  const rawRows = await fetchJbMaskRows();
  const rows = rawRows.map((r) => enrichInfcontrolLayerBinRowV2(r));
  const lots = [...new Set(rows.map((r) => String(r.LOT ?? "").trim()).filter(Boolean))];
  console.log(`→ Oracle 行数: ${rows.length}，涉及 lot: ${lots.length} 个`);
  console.log(`→ lots: ${lots.slice(0, 8).join(", ")}${lots.length > 8 ? "…" : ""}`);

  let cacheJson;
  const wrapped = wrapJbQueryResultForAgent(rows);
  cacheJson = storeJbQuerySessionCache(sessionId, wrapped);
  assert(cacheJson, "应有 JB 缓存");
  const hist = compactJbCacheForHistory(cacheJson, 20000);
  console.log(`→ 写入 session 缓存，history 字符数: ${hist.length}`);
  console.log(
    `→ primary lot: ${wrapped.lot}，multiLotYieldScope: ${Boolean(wrapped.multiLotYieldScope)}，distinctLotCount: ${wrapped.distinctLotCount}`
  );
  console.log("");

  // ── Turn 3: 总结轮确定性表（模拟 LLM 空输出 / 直出表）──
  console.log("--- 服务端确定性表（buildDeterministicJbTables）---");
  console.log("意图模式:", detectJbReplyMode(USER_QUESTION));
  const payload = resolveJbToolPayload(sessionId, hist);
  assert(payload, "resolveJbToolPayload 应有 payload");
  const tables = buildDeterministicJbTables(USER_QUESTION, payload);
  assert(tables?.trim(), "确定性表不应为空");

  const header = "## 实测数据";
  console.log("\n" + preview(`${header}\n\n${tables}`, 60));
  console.log("");

  // ── 断言：修复后 TR22422.1J 不应出现「25 片全中断」假象 ──
  const summary = payload.slotYieldSummary ?? [];
  const interrupted = summary.filter((s) => s.hasInterrupt);
  const pass1 = (payload.yieldByPassId ?? []).find((p) => p.passId === 1);
  const slot1 = summary.find((s) => s.slot === 1 && s.passId === 1);

  console.log("=== 自动校验（修复后预期）===");
  const checks = [
    [
      "mask 查询含多个 lot（distinctLotCount>1）",
      (wrapped.distinctLotCount ?? 0) > 1,
    ],
    [
      "primary lot = TR22422.1J",
      String(payload.lot ?? "").toUpperCase() === "TR22422.1J",
    ],
    [
      "有中断片 ≤ 5（非 25 片全中断）",
      interrupted.length <= 5,
    ],
    [
      "slot1 pass1 无假中断",
      slot1 && !slot1.hasInterrupt,
    ],
    [
      "slot1 pass1 良率 > 90%",
      slot1?.yieldPct != null && slot1.yieldPct > 90,
    ],
    [
      "pass1 批次良率 > 91%（非跨 lot 混合 90.57%）",
      pass1?.yieldPct != null && pass1.yieldPct > 91,
    ],
    [
      "中断表不含「后半段 8190 die」假分段（跨 lot 合并特征）",
      !String(tables).includes("| 8190 |"),
    ],
    [
      "不应出现 25 行中断次数 5–11 的假象",
      !(
        String(tables).includes("| 1 | pass1 | 9 |") &&
        String(tables).includes("| 25 | pass1 | 5 |")
      ),
    ],
    [
      "各片良率简表含 pass1 slot1（非仅 pass2）",
      /pass1.*92/i.test(String(tables)) || /slot.*1.*9[0-2]/i.test(String(tables)),
    ],
  ];

  let failed = 0;
  for (const [label, ok] of checks) {
    console.log(`${ok ? "✓" : "✗"} ${label}`);
    if (!ok) failed++;
  }
  console.log("");
  console.log(
    `中断片 slot: ${interrupted.map((s) => s.slot).join(", ") || "无"}（预期约 11,12,21）`
  );
  console.log(
    `pass1 良率: ${pass1?.yieldPct?.toFixed(2) ?? "—"}%，slot1: ${slot1?.yieldPct?.toFixed(2) ?? "—"}%`
  );

  clearJbToolRawJson(sessionId);
  if (failed > 0) {
    console.error(`\n❌ ${failed} 项校验未通过`);
    process.exit(1);
  }
  console.log("\n✓ 模拟对话输出符合预期");
}

function tryParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
