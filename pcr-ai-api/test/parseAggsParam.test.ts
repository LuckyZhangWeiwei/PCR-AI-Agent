import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAggsParam } from "../src/lib/parseAggsParam.js";

describe("parseAggsParam", () => {
  it("non-string returns ok with empty specs", () => {
    assert.deepEqual(parseAggsParam(undefined), { ok: true, specs: [] });
    assert.deepEqual(parseAggsParam(null), { ok: true, specs: [] });
    assert.deepEqual(parseAggsParam(42), { ok: true, specs: [] });
  });

  it("empty string returns ok with empty specs", () => {
    assert.deepEqual(parseAggsParam(""), { ok: true, specs: [] });
    assert.deepEqual(parseAggsParam("  "), { ok: true, specs: [] });
  });

  it("parses single spec with groupTop", () => {
    const r = parseAggsParam("bin:30");
    assert.ok(r.ok);
    assert.deepEqual(r.specs, [{ groupBy: "bin", groupTop: 30 }]);
  });

  it("defaults groupTop to 30 when colon absent", () => {
    const r = parseAggsParam("bin");
    assert.ok(r.ok);
    assert.deepEqual(r.specs, [{ groupBy: "bin", groupTop: 30 }]);
  });

  it("parses multiple pipe-separated specs", () => {
    const r = parseAggsParam("bin:30|probeCardType,bin:25|slot,bin:50");
    assert.ok(r.ok);
    assert.deepEqual(r.specs, [
      { groupBy: "bin", groupTop: 30 },
      { groupBy: "probeCardType,bin", groupTop: 25 },
      { groupBy: "slot,bin", groupTop: 50 },
    ]);
  });

  it("returns error when spec count exceeds maxSpecs", () => {
    const input = Array.from({ length: 11 }, (_, i) => `dim${i}:10`).join("|");
    const r = parseAggsParam(input);
    assert.ok(!r.ok);
    assert.ok(r.error.includes("at most 10"));
  });

  it("returns error for zero groupTop", () => {
    const r = parseAggsParam("bin:0");
    assert.ok(!r.ok);
    assert.ok(r.error.includes("positive integer"));
  });

  it("returns error for non-integer groupTop", () => {
    const r = parseAggsParam("bin:1.5");
    assert.ok(!r.ok);
    assert.ok(r.error.includes("positive integer"));
  });

  it("returns error for non-numeric groupTop", () => {
    const r = parseAggsParam("bin:abc");
    assert.ok(!r.ok);
    assert.ok(r.error.includes("positive integer"));
  });

  it("uses maxSpecs parameter", () => {
    const r = parseAggsParam("bin:10|slot:10|device:10", 2);
    assert.ok(!r.ok);
    assert.ok(r.error.includes("at most 2"));
  });
});
