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

test("manifest includes POST /api/v4/agent/chat with a requestBody", () => {
  const e = findEntry("/api/v4/agent/chat", "POST");
  assert.ok(e, "expected /api/v4/agent/chat POST entry");
  assert.equal(typeof (e as any).purpose, "string");
  assert.ok((e as any).requestBody, "expected requestBody description");
});

test("manifest includes POST /api/v4/agent/feedback with a requestBody", () => {
  const e = findEntry("/api/v4/agent/feedback", "POST");
  assert.ok(e, "expected /api/v4/agent/feedback POST entry");
  assert.ok((e as any).requestBody);
});

test("manifest includes GET and PATCH /api/v4/admin/config", () => {
  const get = findEntry("/api/v4/admin/config", "GET");
  const patch = findEntry("/api/v4/admin/config", "PATCH");
  assert.ok(get, "expected /api/v4/admin/config GET entry");
  assert.ok(patch, "expected /api/v4/admin/config PATCH entry");
  assert.ok((patch as any).requestBody);
});

test("manifest includes deprecated POST /api/v4/admin/agent-enabled", () => {
  const e = findEntry("/api/v4/admin/agent-enabled", "POST");
  assert.ok(e, "expected /api/v4/admin/agent-enabled POST entry");
  assert.equal((e as any).deprecated, true);
});
