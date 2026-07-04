import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  parseYieldMonitorTriggerV3AggregateQuery,
  buildYieldMonitorTriggerV3AggregateSql,
} from "../src/lib/yieldMonitorTriggerV3Aggregate.js";

describe("yieldMonitorTriggerV3Aggregate — bin / dutNumber 维度", () => {
  test("parseYieldMonitorTriggerV3AggregateQuery 接受 dimensions=bin", () => {
    const r = parseYieldMonitorTriggerV3AggregateQuery({ dimensions: "bin" });
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.dimensions, ["bin"]);
  });

  test("parseYieldMonitorTriggerV3AggregateQuery 接受 dimensions=DutNumber（大小写不敏感）", () => {
    const r = parseYieldMonitorTriggerV3AggregateQuery({ dimensions: "DutNumber" });
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.dimensions, ["dutNumber"]);
  });

  test("buildYieldMonitorTriggerV3AggregateSql（bin）含 REGEXP_SUBSTR 提取表达式", () => {
    const sql = buildYieldMonitorTriggerV3AggregateSql("", ["bin"]);
    assert.ok(
      sql.includes(
        "REGEXP_SUBSTR(t.TRIGGER_LABEL, 'Bin#\\s*([0-9]+|goodbin)', 1, 1, 'i', 1)"
      )
    );
    assert.ok(sql.includes("GROUP BY"));
  });

  test("buildYieldMonitorTriggerV3AggregateSql（dutNumber）含 REGEXP_SUBSTR 提取表达式", () => {
    const sql = buildYieldMonitorTriggerV3AggregateSql("", ["dutNumber"]);
    assert.ok(
      sql.includes(
        "REGEXP_SUBSTR(t.TRIGGER_LABEL, 'on\\s+dut#\\s*([0-9]+)', 1, 1, 'i', 1)"
      )
    );
  });
});
