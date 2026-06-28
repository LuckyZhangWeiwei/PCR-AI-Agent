import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJbRouteParams } from "../src/lib/agent/jbRouteResolver.js";

test("extractJbRouteParams pulls focusBin and lot", () => {
  const p = extractJbRouteParams("NF13322.1J 哪片 bin79 最多");
  assert.equal(p.focusBin, 79);
  assert.equal(p.lot, "NF13322.1J");
});

test("extractJbRouteParams pulls slot", () => {
  const p = extractJbRouteParams("第3片的测试情况");
  assert.equal(p.slot, 3);
});
