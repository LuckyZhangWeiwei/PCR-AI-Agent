import assert from "node:assert/strict";
import test from "node:test";

process.env["YIELD_MONITOR_TRIGGERS_DUMMY"] = "true";
process.env["INFCONTROL_LAYER_BINS_DUMMY"] = "true";

import { apiManifest } from "../src/lib/manifest/index.js";

function findEntry(path: string, method: string) {
  return apiManifest.endpoints.find(
    (e: any) => e.path === path && e.method === method
  );
}

test("manifest includes GET /api/v1/inf-analysis/lot-underperforming-duts", () => {
  const e = findEntry("/api/v1/inf-analysis/lot-underperforming-duts", "GET");
  assert.ok(e);
  const params = (e as any).queryParameters as Array<{ name: string; optional?: boolean }>;
  const lotParam = params.find((p) => p.name === "lot");
  assert.ok(lotParam, "expected a lot query parameter");
  assert.equal(lotParam!.optional, false, "lot must be marked required (optional: false)");
});

test("manifest includes GET /api/v1/inf-analysis/site-bin-bylot", () => {
  const e = findEntry("/api/v1/inf-analysis/site-bin-bylot", "GET");
  assert.ok(e);
});

test("manifest includes POST /api/v1/inf-analysis/site-bin-bylot/layers with a requestBody", () => {
  const e = findEntry("/api/v1/inf-analysis/site-bin-bylot/layers", "POST");
  assert.ok(e);
  assert.ok((e as any).requestBody);
});

test("manifest includes GET /api/v1/siliconflow/chat", () => {
  const e = findEntry("/api/v1/siliconflow/chat", "GET");
  assert.ok(e);
  const params = (e as any).queryParameters as Array<{ name: string; optional?: boolean }>;
  const messageParam = params.find((p) => p.name === "message");
  assert.ok(messageParam);
  assert.equal(messageParam!.optional, false);
});
