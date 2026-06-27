// pcr-ai-api/test/oracleStringSql.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { oracleNonEmptyTrimmedColumn } from "../src/lib/oracleStringSql.js";

test("oracleNonEmptyTrimmedColumn avoids Oracle empty-string NULL trap", () => {
  const sql = oracleNonEmptyTrimmedColumn("t.DEVICE");
  assert.match(sql, /IS NOT NULL/);
  assert.match(sql, /LENGTH\(TRIM\(t\.DEVICE\)\) > 0/);
  assert.doesNotMatch(sql, /!= ''/);
});
