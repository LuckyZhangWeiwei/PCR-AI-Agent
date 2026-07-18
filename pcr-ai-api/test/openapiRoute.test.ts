import assert from "node:assert/strict";
import test from "node:test";

process.env["YIELD_MONITOR_TRIGGERS_DUMMY"] = "true";
process.env["INFCONTROL_LAYER_BINS_DUMMY"] = "true";

import { createApp } from "../src/app.js";

test("GET /openapi.json returns a valid OpenAPI document", async (t) => {
  const app = createApp();
  const server = app.listen(0);
  t.after(() => server.close());
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  const res = await fetch(`http://127.0.0.1:${(address as any).port}/openapi.json`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);

  const body = await res.json();
  assert.ok(body.openapi.startsWith("3."));
  assert.ok(body.paths["/api/v4/agent/chat"]);
  assert.ok(body.paths["/api/v1/infcontrol-layer-bins"]);
});
