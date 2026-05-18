import assert from "node:assert/strict";
import test from "node:test";

// Use dummy data so fetchOrCacheManifest() doesn't attempt Oracle pool connections,
// which would block the Node.js event loop in a test environment without a DB.
process.env["YIELD_MONITOR_TRIGGERS_DUMMY"] = "true";
process.env["INFCONTROL_LAYER_BINS_DUMMY"] = "true";

import { createApp } from "../src/app.js";

test("POST /api/v4/agent/chat writes SSE errors after the request body closes", async (t) => {
  const originalTimeout = process.env.AGENT_STREAM_TIMEOUT_MS;
  process.env.AGENT_STREAM_TIMEOUT_MS = "20";

  const app = createApp();
  const server = app.listen(0);

  t.after(() => {
    server.close();
    if (originalTimeout === undefined) {
      delete process.env.AGENT_STREAM_TIMEOUT_MS;
    } else {
      process.env.AGENT_STREAM_TIMEOUT_MS = originalTimeout;
    }
  });

  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  const bodyPromise = fetch(
    `http://127.0.0.1:${address.port}/api/v4/agent/chat`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "你好",
        sessionId: "route-timeout-test",
        agentConfig: {
          apiKey: "sk-test",
          apiBase: "https://10.255.255.1",
          model: "test-model",
        },
      }),
    }
  ).then(async (res) => {
    assert.equal(res.status, 200);
    return res.text();
  });

  const body = await Promise.race([
    bodyPromise,
    new Promise<"timed-out">((resolve) =>
      setTimeout(() => resolve("timed-out"), 500)
    ),
  ]);

  assert.notEqual(body, "timed-out");
  assert.match(body, /"type":"error"/);
  assert.match(body, /Request timeout after 20ms/);
});
