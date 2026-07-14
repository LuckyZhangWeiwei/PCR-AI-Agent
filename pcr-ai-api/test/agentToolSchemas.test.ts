import assert from "node:assert/strict";
import test from "node:test";
import { TOOL_SCHEMAS } from "../src/lib/agent/core/agentToolSchemas.js";

test("TOOL_SCHEMAS includes aggregate_probe_card_tester_performance with device or mask", () => {
  const entry = TOOL_SCHEMAS.find(
    (t) => t.function.name === "aggregate_probe_card_tester_performance"
  );
  assert.ok(entry, "schema entry must exist");
  assert.ok(!entry!.function.parameters.required.includes("device"));
  assert.ok("device" in entry!.function.parameters.properties);
  assert.ok("mask" in entry!.function.parameters.properties);
  assert.ok("passId" in entry!.function.parameters.properties);
  assert.ok("testEndFrom" in entry!.function.parameters.properties);
  assert.ok("testEndTo" in entry!.function.parameters.properties);
});
