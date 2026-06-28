import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJbRouteParams, resolveJbRoute } from "../src/lib/agent/jbRouteResolver.js";
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
