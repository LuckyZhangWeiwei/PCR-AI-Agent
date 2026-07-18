import assert from "node:assert/strict";
import test from "node:test";

process.env["YIELD_MONITOR_TRIGGERS_DUMMY"] = "true";
process.env["INFCONTROL_LAYER_BINS_DUMMY"] = "true";

import { createApp } from "../src/app.js";

test("GET /api-docs/ serves the swagger-ui HTML page", async (t) => {
  const app = createApp();
  const server = app.listen(0);
  t.after(() => server.close());
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as any).port;

  const res = await fetch(`http://127.0.0.1:${port}/api-docs/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /swagger-ui/);
  assert.match(html, /\/openapi\.json/);
});

test("GET /api-docs (no trailing slash) redirects to /api-docs/", async (t) => {
  const app = createApp();
  const server = app.listen(0);
  t.after(() => server.close());
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as any).port;

  const res = await fetch(`http://127.0.0.1:${port}/api-docs`, { redirect: "manual" });
  assert.ok(res.status === 301 || res.status === 302, `expected a redirect, got ${res.status}`);
  assert.equal(res.headers.get("location"), "/api-docs/");
});

test("GET /api-docs/vendor/swagger-ui-bundle.js serves the vendored bundle", async (t) => {
  const app = createApp();
  const server = app.listen(0);
  t.after(() => server.close());
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as any).port;

  const res = await fetch(`http://127.0.0.1:${port}/api-docs/vendor/swagger-ui-bundle.js`);
  assert.equal(res.status, 200);
});
