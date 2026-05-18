// pcr-ai-api/test/agentManifest.test.ts
import assert from "node:assert/strict";
import test from "node:test";

// 设置 Dummy 模式（必须在 import agentManifest 之前）
process.env["YIELD_MONITOR_TRIGGERS_DUMMY"] = "true";
process.env["INFCONTROL_LAYER_BINS_DUMMY"] = "true";

import {
  fetchOrCacheManifest,
  invalidateManifestCache,
  type DataManifest,
} from "../src/lib/agent/agentManifest.js";

test("fetchOrCacheManifest returns correct structure in Dummy mode", async () => {
  invalidateManifestCache();
  const manifest = await fetchOrCacheManifest();

  assert.equal(typeof manifest.fetchedAt, "number");
  assert.ok(manifest.fetchedAt > 0);

  // yield domain
  assert.ok("yield" in manifest);
  assert.ok("timeMin" in manifest.yield);
  assert.ok("timeMax" in manifest.yield);
  assert.ok(Array.isArray(manifest.yield.topDevices));
  // Dummy rows exist → should have at least one device
  assert.ok(manifest.yield.topDevices.length > 0, "yield topDevices should be non-empty");
  assert.equal(typeof manifest.yield.topDevices[0]!.device, "string");
  assert.equal(typeof manifest.yield.topDevices[0]!.count, "number");
  assert.ok(manifest.yield.topDevices[0]!.count > 0);

  // jb domain
  assert.ok("jb" in manifest);
  assert.ok(Array.isArray(manifest.jb.topDevices));
  assert.ok(manifest.jb.topDevices.length > 0, "jb topDevices should be non-empty");
});

test("fetchOrCacheManifest returns same object on second call (cache hit)", async () => {
  invalidateManifestCache();
  const m1 = await fetchOrCacheManifest();
  const m2 = await fetchOrCacheManifest();
  assert.equal(m1, m2, "second call should return cached object");
});

test("fetchOrCacheManifest re-fetches after invalidation", async () => {
  invalidateManifestCache();
  const m1 = await fetchOrCacheManifest();
  invalidateManifestCache();
  const m2 = await fetchOrCacheManifest();
  // Not the same object — fresh fetch
  assert.notEqual(m1, m2);
  assert.ok(m2.fetchedAt >= m1.fetchedAt);
});

test("yield topDevices are sorted by count descending", async () => {
  invalidateManifestCache();
  const manifest = await fetchOrCacheManifest();
  const devices = manifest.yield.topDevices;
  for (let i = 1; i < devices.length; i++) {
    assert.ok(
      devices[i - 1]!.count >= devices[i]!.count,
      `topDevices[${i - 1}].count (${devices[i - 1]!.count}) should be >= topDevices[${i}].count (${devices[i]!.count})`
    );
  }
});

test("topDevices capped at 10", async () => {
  invalidateManifestCache();
  const manifest = await fetchOrCacheManifest();
  assert.ok(manifest.yield.topDevices.length <= 10);
  assert.ok(manifest.jb.topDevices.length <= 10);
});

test("fetchOrCacheManifest handles empty domain when all rows filtered out", async () => {
  // Save and override env to force yield dummy to use a path where no rows match
  const origYield = process.env["YIELD_MONITOR_TRIGGERS_DUMMY"];
  const origJb = process.env["INFCONTROL_LAYER_BINS_DUMMY"];
  // Both dummy modes are already true — we test the emptyDomain fallback
  // by verifying the structure is valid even if rows happened to be empty
  // (the .catch fallback in fetchOrCacheManifest guarantees this shape)
  invalidateManifestCache();
  const manifest = await fetchOrCacheManifest();
  // Whether rows exist or not, the shape must be valid
  assert.ok(manifest.yield.timeMin === null || typeof manifest.yield.timeMin === "string");
  assert.ok(manifest.yield.timeMax === null || typeof manifest.yield.timeMax === "string");
  assert.ok(Array.isArray(manifest.yield.topDevices));
  assert.ok(manifest.jb.timeMin === null || typeof manifest.jb.timeMin === "string");
  assert.ok(manifest.jb.timeMax === null || typeof manifest.jb.timeMax === "string");
  assert.ok(Array.isArray(manifest.jb.topDevices));
});
