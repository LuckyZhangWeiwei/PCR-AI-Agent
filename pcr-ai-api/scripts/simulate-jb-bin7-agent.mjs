/**
 * 模拟 JB Agent 确定性表（不调用 SiliconFlow）。
 *
 * 用法：
 *   node scripts/simulate-jb-bin7-agent.mjs
 *   node scripts/simulate-jb-bin7-agent.mjs "NF12316.1X 中 每一片的 yield"
 */
import { buildDeterministicJbTables } from "../dist/lib/agent/jb/agentJbOverviewMarkdown.js";
import { detectJbReplyMode, extractBinFromUserText } from "../dist/lib/agent/jb/agentJbQuestionClassifiers.js";
import { resolveJbToolPayload } from "../dist/lib/agent/jb/agentJbPayloadResolve.js";
import {
  buildJbSessionCacheJson,
  wrapJbQueryResultForAgent,
} from "../dist/lib/agent/jb/agentJbBinFormat.js";
import { compactJbCacheForHistory } from "../dist/lib/agent/jb/agentJbHistoryCompact.js";
import { storeJbToolRawJson, clearJbToolRawJson } from "../dist/lib/agent/agentJbSessionCache.js";

const USER_QUESTION =
  process.argv[2]?.trim() || "NF12316.1X 中 bin7 的趋势 请重新计算";

function mockLotRows() {
  const rows = [];
  for (let slot = 1; slot <= 25; slot++) {
    rows.push({
      LOT: "NF12316.1X",
      DEVICE: "WB10N57U",
      SLOT: slot,
      PASSID: 1,
      PASSNUM: 1,
      PASSTYPE: slot === 8 ? "INTERRUPT" : "TEST",
      CARDID: "8041-05",
      GROSSDIE: 4300,
      TESTEND: "2026-05-15T10:00:00",
      bins: [
        { n: 1, value: 4200, isGoodBin: true },
        { n: 7, value: slot === 20 ? 55 : slot <= 5 ? 8 : 15, isGoodBin: false },
      ],
    });
    if (slot === 8) {
      rows.push({
        LOT: "NF12316.1X",
        DEVICE: "WB10N57U",
        SLOT: 8,
        PASSID: 1,
        PASSNUM: 2,
        PASSTYPE: "TEST",
        CARDID: "8041-05",
        GROSSDIE: 4300,
        TESTEND: "2026-05-16T10:00:00",
        bins: [
          { n: 1, value: 4100, isGoodBin: true },
          { n: 7, value: 22, isGoodBin: false },
        ],
      });
    }
    rows.push({
      LOT: "NF12316.1X",
      DEVICE: "WB10N57U",
      SLOT: slot,
      PASSID: 3,
      PASSNUM: 1,
      PASSTYPE: "TEST",
      CARDID: "8041-21",
      GROSSDIE: 4300,
      TESTEND: "2026-05-20T10:00:00",
      bins: [
        { n: 1, value: 4280, isGoodBin: true },
        { n: 7, value: 3, isGoodBin: false },
      ],
    });
  }
  return rows;
}

function preview(text, maxLines = 45) {
  const lines = text.split("\n");
  const head = lines.slice(0, maxLines).join("\n");
  const tail = lines.length > maxLines ? `\n…（共 ${lines.length} 行，省略 ${lines.length - maxLines} 行）` : "";
  return head + tail;
}

async function main() {
  console.log("=== 用户问题 ===");
  console.log(USER_QUESTION);
  console.log("\n=== 意图识别 ===");
  console.log("BIN:", extractBinFromUserText(USER_QUESTION));
  console.log("模式:", detectJbReplyMode(USER_QUESTION));

  const wrapped = wrapJbQueryResultForAgent(mockLotRows(), { lotScopedFullRows: true });
  const cacheJson = buildJbSessionCacheJson(wrapped);
  const sessionId = "simulate-bin7-" + Date.now();
  clearJbToolRawJson(sessionId);
  storeJbToolRawJson(sessionId, cacheJson);

  const hist = compactJbCacheForHistory(cacheJson, 20000);
  console.log("\n=== 工具结果（写入 history，字符数）===", hist.length);
  console.log("含 _trendRows:", hist.includes('"_trendRows"'));

  const payload = resolveJbToolPayload(sessionId, hist);
  const tables = buildDeterministicJbTables(USER_QUESTION, payload);
  if (!tables?.trim()) {
    console.error("\n❌ 确定性表生成失败（与线上「模型未返回分析结论」同因）");
    process.exit(1);
  }

  const header =
    "以下表格由服务端根据 JB STAR 实测数据生成，**数字与下表一致**；请勿自行合并 sort 或改写半片良率/BIN 颗数。";
  const full = `${header}\n\n${tables}`;

  console.log("\n=== 模拟 SSE：status ===");
  console.log("正在输出服务端预计算表…");
  console.log("\n=== 模拟 AI 正文（服务端表，总结轮模型空输出时的回退同样输出此表）===\n");
  console.log(preview(full, 50));

  console.log("\n=== 模拟：总结轮 LLM 空输出 + 内嵌 query_jb_bins ===");
  console.log("→ finishWithJbServerTablesFallback：输出上表（不报错）");

  console.log("\n=== 若模型正常（需 SiliconFlow API Key）===");
  console.log("在表后追加 ### 数据解读 / ### 专业建议（Wafer Test / Probe Card / DUT）");

  clearJbToolRawJson(sessionId);
  console.log("\n✓ 模拟完成");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
