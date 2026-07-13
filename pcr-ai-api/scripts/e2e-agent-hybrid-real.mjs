/**
 * 混合真实 E2E：Oracle 数据来自生产 GET v4 列表，表体用本机最新 dist 逻辑，解读调 SiliconFlow。
 * 用法：node scripts/e2e-agent-hybrid-real.mjs "NF12316.1X 中 每一片的 yield"
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolveAgentConfig } from "../dist/lib/agent/agentConfig.js";
import { streamSiliconFlow } from "../dist/lib/agent/agentStream.js";
import {
  BRIEF_COMMENTARY_SYSTEM,
  buildBriefCommentaryUserMessage,
  buildDeterministicJbTables,
  buildEngineeringContextFromPayload,
  DETERMINISTIC_TABLES_HEADER,
} from "../dist/lib/agent/jb/agentJbOverviewMarkdown.js";
import { detectJbReplyMode } from "../dist/lib/agent/jb/agentJbQuestionClassifiers.js";
import {
  buildJbSessionCacheJson,
  wrapJbQueryResultForAgent,
} from "../dist/lib/agent/jb/agentJbBinFormat.js";

const API_BASE = (process.env.PCR_API_BASE || "http://10.192.130.89:30008").replace(
  /\/$/,
  ""
);
const MESSAGE =
  process.argv[2]?.trim() || "NF12316.1X 中 每一片的 yield";

async function fetchLotRows(lot) {
  const url = `${API_BASE}/api/v4/infcontrol-layer-bins/v4?lot=${encodeURIComponent(lot)}&testEndFrom=2020-01-01&limit=500`;
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`JB list HTTP ${res.status}: ${await res.text()}`);
  const j = await res.json();
  const rows = j.rows ?? [];
  console.log(`Oracle 行数（生产 v4 列表）: ${rows.length}`);
  return rows;
}

async function main() {
  const lotMatch = MESSAGE.match(/NF[\w.]+/i);
  const lot = lotMatch ? lotMatch[0] : "NF12316.1X";

  console.log("=== 混合真实 E2E ===");
  console.log("问题:", MESSAGE);
  console.log("Lot:", lot);
  console.log("模式:", detectJbReplyMode(MESSAGE));

  const rows = await fetchLotRows(lot);
  const wrapped = wrapJbQueryResultForAgent(rows, { lotScopedFullRows: true });
  const cache = JSON.parse(buildJbSessionCacheJson(wrapped));

  const tables = buildDeterministicJbTables(MESSAGE, cache);
  if (!tables?.trim()) {
    console.error("确定性表生成失败");
    process.exit(1);
  }

  const tablesBlock = `${DETERMINISTIC_TABLES_HEADER}\n\n${tables}`;
  const config = resolveAgentConfig({
    model: process.env.AGENT_MODEL || "deepseek-ai/DeepSeek-V4-Pro",
    apiKey: process.env.AGENT_API_KEY,
    streamTimeoutSec: 250,
  });
  if (!config.apiKey) {
    console.error("需要环境变量 AGENT_API_KEY");
    process.exit(1);
  }

  console.log("\n--- 服务端预计算表（真实 Oracle + 最新逻辑）---\n");
  console.log(tablesBlock.length > 14000 ? tablesBlock.slice(0, 14000) + "\n…[表截断显示]" : tablesBlock);

  console.log("\n--- 正在调 SiliconFlow 生成解读… ---\n");
  let commentary = "";
  let err;
  await streamSiliconFlow(
    {
      model: config.model,
      messages: [
        { role: "system", content: BRIEF_COMMENTARY_SYSTEM },
        {
          role: "user",
          content: buildBriefCommentaryUserMessage(MESSAGE, tables, {
            engineeringContext: buildEngineeringContextFromPayload(cache),
          }),
        },
      ],
      tools: [],
      tool_choice: "none",
    },
    config,
    (chunk) => {
      if (chunk.type === "delta") {
        commentary += chunk.text;
        process.stdout.write(chunk.text);
      }
      if (chunk.type === "error") err = chunk.message;
    }
  );

  const full = `${tablesBlock}\n\n---\n\n${commentary}`;
  const path = `scripts/e2e-hybrid-${Date.now()}.txt`;
  writeFileSync(path, full, "utf8");
  console.log("\n\n--- 完整输出已保存:", path);
  if (err) {
    console.error("LLM error:", err);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
