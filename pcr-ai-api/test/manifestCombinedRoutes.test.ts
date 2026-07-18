import assert from "node:assert/strict";
import test from "node:test";

process.env["YIELD_MONITOR_TRIGGERS_DUMMY"] = "true";
process.env["INFCONTROL_LAYER_BINS_DUMMY"] = "true";

import { apiManifest } from "../src/lib/manifest/index.js";
import { buildOpenApiDocument } from "../src/lib/manifest/openapiConverter.js";

function findEntry(path: string, method: string) {
  return apiManifest.endpoints.find(
    (e: any) => e.path === path && e.method === method
  );
}

test("manifest includes GET /api/v1/infcontrol-layer-bins/v4/combined", () => {
  const e = findEntry("/api/v1/infcontrol-layer-bins/v4/combined", "GET");
  assert.ok(e, "expected /api/v1/infcontrol-layer-bins/v4/combined GET entry");
  assert.equal(typeof (e as any).purpose, "string");
});

test("manifest includes GET /api/v1/yield-monitor-triggers/v3/combined", () => {
  const e = findEntry("/api/v1/yield-monitor-triggers/v3/combined", "GET");
  assert.ok(e, "expected /api/v1/yield-monitor-triggers/v3/combined GET entry");
  assert.equal(typeof (e as any).purpose, "string");
});

test("manifest includes GET /api/v1/yield-monitor-triggers/v3/period-alarm-trend", () => {
  const e = findEntry(
    "/api/v1/yield-monitor-triggers/v3/period-alarm-trend",
    "GET"
  );
  assert.ok(
    e,
    "expected /api/v1/yield-monitor-triggers/v3/period-alarm-trend GET entry"
  );
  assert.equal(typeof (e as any).purpose, "string");
});

test("OpenAPI document expands the 3 new combined/period-alarm-trend routes under v1, v3, and v4", () => {
  const doc = buildOpenApiDocument() as any;
  const relativePaths = [
    "/infcontrol-layer-bins/v4/combined",
    "/yield-monitor-triggers/v3/combined",
    "/yield-monitor-triggers/v3/period-alarm-trend",
  ];
  for (const rel of relativePaths) {
    for (const prefix of ["/api/v1", "/api/v3", "/api/v4"]) {
      const fullPath = `${prefix}${rel}`;
      assert.ok(doc.paths[fullPath], `missing ${fullPath}`);
      assert.ok(doc.paths[fullPath].get, `expected GET operation at ${fullPath}`);
    }
  }
});
