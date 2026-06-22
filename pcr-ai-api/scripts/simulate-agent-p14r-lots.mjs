/**
 * 模拟 Agent 工具链（不调用 LLM）：P14R 近两个月 lot 列表
 *   node scripts/simulate-agent-p14r-lots.mjs
 */
import "../dist/loadEnv.js";
import { runTool } from "../dist/lib/agent/agentToolHandlers.js";

const TEST_END_FROM = "2026-04-22T00:00:00.000Z";
const TEST_END_TO = "2026-06-22T23:59:59.999Z";
const TIME_FROM = TEST_END_FROM;
const TIME_TO = TEST_END_TO;

console.log("=== P14R 近两个月 lot 列表（工具层，无 LLM）===\n");

console.log("--- get_filter_values(domain=both, field=device, mask=P14R) ---");
const fv = await runTool("get_filter_values", {
  domain: "both",
  field: "device",
  filterBy: { mask: "P14R" },
  limit: 10,
});
console.log(fv.slice(0, 800));
console.log();

console.log(`--- query_jb_bins(mask=P14R, testEndFrom=${TEST_END_FROM.slice(0, 10)}, testEndTo=${TEST_END_TO.slice(0, 10)}, limit=200) ---`);
const jbRaw = await runTool("query_jb_bins", {
  mask: "P14R",
  testEndFrom: TEST_END_FROM,
  testEndTo: TEST_END_TO,
  limit: 200,
}, { toolResultMaxChars: 30000 });
let jb;
try {
  jb = JSON.parse(jbRaw);
} catch {
  console.log(jbRaw.slice(0, 2000));
  process.exit(1);
}
console.log(`totalDistinctLots: ${jb.totalDistinctLots ?? jb.distinctLotCount}`);
console.log(`distinctLotCount: ${jb.distinctLotCount}`);
console.log(`rowCount / count: ${jb.rowCount ?? jb.count}`);
console.log(`device: ${jb.device}`);
console.log(`recentLotsByTestEnd (${(jb.recentLotsByTestEnd ?? []).length}):`);
for (const e of jb.recentLotsByTestEnd ?? []) {
  console.log(`  ${e.lot}  device=${e.device}  testEnd=${String(e.testEnd ?? "").slice(0, 10)}  slots=${e.slotCount}`);
}
console.log();

console.log(`--- query_yield_triggers(mask=P14R, timeFrom, timeTo, limit=200) ---`);
const ymRaw = await runTool("query_yield_triggers", {
  mask: "P14R",
  timeFrom: TIME_FROM,
  timeTo: TIME_TO,
  limit: 200,
}, { toolResultMaxChars: 20000 });
let ym;
try {
  ym = JSON.parse(ymRaw);
} catch {
  console.log(ymRaw.slice(0, 1500));
  process.exit(1);
}
const ymLots = [...new Set((ym.rows ?? []).map((r) => String(r.LOTID ?? r.lotId ?? "").trim()).filter(Boolean))];
console.log(`YM trigger rows: ${(ym.rows ?? []).length}, distinct lots: ${ymLots.length}`);
console.log(`YM lots: ${ymLots.join(", ")}`);
