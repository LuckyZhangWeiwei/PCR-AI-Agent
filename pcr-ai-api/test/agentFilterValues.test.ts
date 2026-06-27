// pcr-ai-api/test/agentFilterValues.test.ts
import assert from "node:assert/strict";
import test from "node:test";

process.env["YIELD_MONITOR_TRIGGERS_DUMMY"] = "true";
process.env["INFCONTROL_LAYER_BINS_DUMMY"] = "true";

import { runGetFilterValues } from "../src/lib/agent/agentFilterValuesTool.js";

test("yield/probeCard returns distinct list with counts", async () => {
  const raw = await runGetFilterValues({ domain: "yield", field: "probeCard" });
  const result = JSON.parse(raw) as {
    domain: string;
    field: string;
    values: string[];
    totalDistinct: number;
  };
  assert.equal(result.domain, "yield");
  assert.equal(result.field, "probeCard");
  assert.ok(Array.isArray(result.values));
  assert.ok(result.values.length > 0, "should have at least one probeCard");
  // Each value should end with " (N次)"
  assert.match(result.values[0]!, /\(\d+次\)$/);
  assert.ok(result.totalDistinct > 0);
});

test("yield/probeCard with filterBy.device narrows results", async () => {
  // Without filter: should have results
  const allRaw = await runGetFilterValues({ domain: "yield", field: "probeCard" });
  const allResult = JSON.parse(allRaw) as { values: string[]; totalDistinct: number };
  assert.ok(allResult.values.length > 0);

  // With a non-existent device: filterBy must be applied → zero results
  const filteredRaw = await runGetFilterValues({
    domain: "yield",
    field: "probeCard",
    filterBy: { device: "__NO_SUCH_DEVICE__" },
  });
  const filteredResult = JSON.parse(filteredRaw) as { values: string[]; totalDistinct: number };
  assert.ok(Array.isArray(filteredResult.values));
  assert.equal(filteredResult.totalDistinct, 0, "filterBy.device should narrow to 0 for non-existent device");
});

test("yield/probeCardType returns leading-segment values", async () => {
  const raw = await runGetFilterValues({ domain: "yield", field: "probeCardType" });
  const result = JSON.parse(raw) as { values: string[]; totalDistinct: number };
  assert.ok(result.values.length > 0);
  // probeCardType values should not contain "-" (they're the leading segment)
  for (const v of result.values) {
    const label = v.replace(/ \(\d+次\)$/, "");
    assert.ok(!label.includes("-"), `probeCardType "${label}" should not contain "-"`);
  }
});

test("jb/cardId returns results in Dummy mode", async () => {
  const raw = await runGetFilterValues({ domain: "jb", field: "cardId" });
  const result = JSON.parse(raw) as { domain: string; field: string; values: string[] };
  assert.equal(result.domain, "jb");
  assert.equal(result.field, "cardId");
  assert.ok(result.values.length > 0);
});

test("jb/lot with filterBy.device filters results", async () => {
  // Without filter: should have results
  const allRaw = await runGetFilterValues({ domain: "jb", field: "lot" });
  const allResult = JSON.parse(allRaw) as { values: string[]; totalDistinct: number };
  assert.ok(allResult.values.length > 0);

  // With a non-existent device: filterBy must be applied → zero results
  const filteredRaw = await runGetFilterValues({
    domain: "jb",
    field: "lot",
    filterBy: { device: "__NO_SUCH_DEVICE__" },
  });
  const filteredResult = JSON.parse(filteredRaw) as { values: string[]; totalDistinct: number };
  assert.ok(Array.isArray(filteredResult.values));
  assert.equal(filteredResult.totalDistinct, 0, "filterBy.device should narrow to 0 for non-existent device");
});

test("jb/cardId with non-existent probeCardType returns empty + hint (no '型号无记录' giveup)", async () => {
  const raw = await runGetFilterValues({
    domain: "jb",
    field: "cardId",
    filterBy: { probeCardType: "__NO_SUCH_TYPE__" },
  });
  const result = JSON.parse(raw) as { totalDistinct: number; hint?: string };
  assert.equal(result.totalDistinct, 0);
  assert.ok(
    result.hint && /型号|CARDID|aggregate|已知/.test(result.hint),
    `empty probeCardType enum should carry a guidance hint, got: ${result.hint}`
  );
});

test("yield/probeCard with non-existent probeCardType returns empty + hint", async () => {
  const raw = await runGetFilterValues({
    domain: "yield",
    field: "probeCard",
    filterBy: { probeCardType: "__NO_SUCH_TYPE__" },
  });
  const result = JSON.parse(raw) as { totalDistinct: number; hint?: string };
  assert.equal(result.totalDistinct, 0);
  assert.ok(result.hint && result.hint.length > 0, "should carry a guidance hint");
});

test("unknown field returns error string", async () => {
  const result = await runGetFilterValues({ domain: "yield", field: "nonexistent" });
  assert.ok(typeof result === "string");
  assert.match(result, /不支持.*field/);
});

test("unknown domain returns error string", async () => {
  const result = await runGetFilterValues({ domain: "unknown", field: "probeCard" });
  assert.ok(typeof result === "string");
  assert.match(result, /domain/);
});

test("limit is respected", async () => {
  const raw = await runGetFilterValues({ domain: "yield", field: "lotId", limit: 2 });
  const result = JSON.parse(raw) as { values: string[] };
  assert.ok(result.values.length <= 2);
});

test("yield/device resolves mask P02G to WA03P02G in Dummy mode", async () => {
  const raw = await runGetFilterValues({
    domain: "yield",
    field: "device",
    filterBy: { mask: "P02G" },
    limit: 5,
  });
  const result = JSON.parse(raw) as { values: string[]; totalDistinct: number };
  assert.ok(result.totalDistinct >= 1, "P02G should match WA03P02G in dummy data");
  assert.ok(result.values.some((v) => v.startsWith("WA03P02G")), result.values.join(", "));
});

test("yield/device accepts top-level mask param", async () => {
  const raw = await runGetFilterValues({
    domain: "yield",
    field: "device",
    mask: "P02G",
    limit: 5,
  });
  const result = JSON.parse(raw) as { values: string[]; totalDistinct: number };
  assert.ok(result.totalDistinct >= 1);
});

test("yield/device without mask returns hint", async () => {
  const raw = await runGetFilterValues({ domain: "yield", field: "device" });
  const result = JSON.parse(raw) as { totalDistinct: number; hint?: string };
  assert.equal(result.totalDistinct, 0);
  assert.ok(result.hint?.includes("mask"));
});

test("jb/device resolves mask P02G in Dummy mode", async () => {
  const raw = await runGetFilterValues({
    domain: "jb",
    field: "device",
    filterBy: { search: "P02G" },
    limit: 5,
  });
  const result = JSON.parse(raw) as { values: string[]; totalDistinct: number };
  assert.ok(result.totalDistinct >= 1, "jb dummy should also match P02G");
});

test("both/device merges yield+jb mask hits (N84R: WC07 in yield, WC06 in jb)", async () => {
  const raw = await runGetFilterValues({
    domain: "both",
    field: "device",
    filterBy: { mask: "N84R" },
    limit: 10,
  });
  const result = JSON.parse(raw) as {
    domain: string;
    values: string[];
    totalDistinct: number;
    devices?: Array<{ device: string; lastYield: string | null; lastJb: string | null }>;
    note?: string;
  };
  assert.equal(result.domain, "both");
  assert.ok(result.totalDistinct >= 2, `expected >=2 devices, got ${result.totalDistinct}`);
  const codes = (result.devices ?? []).map((d) => d.device);
  assert.ok(codes.includes("WC06N84R"), `missing WC06N84R in ${codes.join(",")}`);
  assert.ok(codes.includes("WC07N84R"), `missing WC07N84R in ${codes.join(",")}`);
  assert.ok(result.note?.includes("mask N84R"));
});
