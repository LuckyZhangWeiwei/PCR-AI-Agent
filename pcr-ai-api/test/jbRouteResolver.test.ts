import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJbRouteParams, resolveJbRoute, resolveJbRouteAsync } from "../src/lib/agent/jbRouteResolver.js";
import { detectJbReplyMode } from "../src/lib/agent/agentJbDeterministicReply.js";

test("extractJbRouteParams pulls focusBin and lot", () => {
  const p = extractJbRouteParams("NF13322.1J 哪片 bin79 最多");
  assert.equal(p.focusBin, 79);
  assert.equal(p.lot, "NF13322.1J");
});

test("extractJbRouteParams pulls slot", () => {
  const p = extractJbRouteParams("第3片的测试情况");
  assert.equal(p.slot, 3);
});

const PARITY_CORPUS = [
  "DR44436.1W 用几号卡测试的",
  "NF13322.1J 哪片 bin79 最多",
  "这4张probecard的测试情况做对比",
  "都测试了什么lot",
  "NF12316.1X 中 bin7 的趋势",
  "DR45459.1A 各片中断多少次",
  "9416 卡的测试情况",
  "第二片的测试情况",
  "这批主要的fail bin有哪些",
  "N55Z bin35 是集中到哪张卡上的",
];

test("resolveJbRoute mode matches detectJbReplyMode (parity)", () => {
  for (const q of PARITY_CORPUS) {
    assert.equal(resolveJbRoute(q).mode, detectJbReplyMode(q), `parity fail: ${q}`);
  }
});

test("resolveJbRoute carries source=regex and params", () => {
  const d = resolveJbRoute("NF13322.1J 哪片 bin79 最多");
  assert.equal(d.source, "regex");
  assert.equal(d.params.focusBin, 79);
});

test("resolveJbRoute 决策携带集中后的三 flag", () => {
  const d = resolveJbRoute("把这4张probecard的测试情况做对比");
  assert.equal(d.isMultiCardCompare, true);
  assert.equal(d.isMultiLotCompare, false);
  assert.equal(d.isDutLevel, false);

  const e = resolveJbRoute("这几个lot分别用什么卡");
  assert.equal(e.isMultiLotCompare, true);

  const f = resolveJbRoute("这lot哪些die是嫌疑die");
  assert.equal(f.isDutLevel, true);
});

test("开关关 → 不调分类器,等于同步结果", async () => {
  delete process.env.JB_LLM_INTENT_CLASSIFIER;
  const chat = async () => '{"mode":"equipment"}';
  const d = await resolveJbRouteAsync("这几张卡咋样", {}, { subAgentModel: "x" } as any, { chat });
  assert.equal(d.source, "regex");          // 未走 LLM
});

test("开关开 + 同步 generic + 模糊 → 用分类器结果", async () => {
  process.env.JB_LLM_INTENT_CLASSIFIER = "true";
  const chat = async () => '{"mode":"card_test_overview","confidence":"high"}';
  const d = await resolveJbRouteAsync("这几张卡最近咋样", {}, { subAgentModel: "x" } as any, { chat });
  assert.equal(d.mode, "card_test_overview");
  assert.equal(d.source, "llm");
  delete process.env.JB_LLM_INTENT_CLASSIFIER;
});

test("开关开 + 分类器 null → 降级 generic", async () => {
  process.env.JB_LLM_INTENT_CLASSIFIER = "true";
  const chat = async () => "garbage";
  const d = await resolveJbRouteAsync("这几张卡最近咋样", {}, { subAgentModel: "x" } as any, { chat });
  assert.equal(d.mode, "generic");
  assert.equal(d.source, "default");
  delete process.env.JB_LLM_INTENT_CLASSIFIER;
});
