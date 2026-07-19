import assert from "node:assert/strict";
import test from "node:test";
import {
  countDistinct,
  expandTesterSearchTerms,
  normalizeTesterSearchKeyword,
  testerValueMatchesSearch,
} from "../src/lib/agent/tools/filterValues/agentFilterValuesSearch.js";

test("normalizeTesterSearchKeyword: T25FLEX→flex25, T25UFLEX→uflex25, strip b3", () => {
  assert.equal(normalizeTesterSearchKeyword("T25FLEX"), "flex25");
  assert.equal(normalizeTesterSearchKeyword("T25UFLEX"), "uflex25");
  assert.equal(normalizeTesterSearchKeyword("b3flex25"), "flex25");
  assert.equal(normalizeTesterSearchKeyword("b3uflex25"), "uflex25");
  assert.equal(normalizeTesterSearchKeyword("flex25"), "flex25");
});

test("testerValueMatchesSearch: flex25 matches b3flex25 only, not b3uflex25", () => {
  assert.equal(testerValueMatchesSearch("b3flex25", "flex25"), true);
  assert.equal(testerValueMatchesSearch("b3uflex25", "flex25"), false);
  assert.equal(testerValueMatchesSearch("b3uflex25", "uflex25"), true);
  assert.equal(testerValueMatchesSearch("b3flex25", "uflex25"), false);
  assert.equal(testerValueMatchesSearch("b3flex25", "T25FLEX"), false); // caller should normalize first
  assert.equal(
    testerValueMatchesSearch("b3flex25", normalizeTesterSearchKeyword("T25FLEX")),
    true
  );
});

test("expandTesterSearchTerms never maps flex↔uflex", () => {
  const flexTerms = expandTesterSearchTerms("flex25");
  assert.ok(flexTerms.some((t) => /b3flex25/i.test(t)));
  assert.ok(!flexTerms.some((t) => /uflex/i.test(t)));

  const uflexTerms = expandTesterSearchTerms("uflex25");
  assert.ok(uflexTerms.some((t) => /b3uflex25/i.test(t)));
  assert.ok(!uflexTerms.some((t) => /^flex/i.test(t) || /^b3flex/i.test(t)));
});

test("countDistinct testerSearch excludes UFLEX when searching flex25", () => {
  const raw = ["b3flex25", "b3flex25", "b3uflex25", "b3uflex25", "b3uflex25"];
  const { values, totalDistinct } = countDistinct(raw, 10, "flex25", {
    testerSearch: true,
  });
  assert.equal(totalDistinct, 1);
  assert.equal(values.length, 1);
  assert.match(values[0]!, /^b3flex25 /);
});
