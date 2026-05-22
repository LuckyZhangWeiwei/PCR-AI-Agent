import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import https from "node:https";
import test from "node:test";
import { streamSiliconFlow, type StreamChunk } from "../src/lib/agent/agentStream.js";

test("streamSiliconFlow emits an error when the upstream request never responds", async (t) => {
  const originalRequest = https.request;

  const fakeReq = new EventEmitter() as EventEmitter & {
    setTimeout: (ms: number, cb: () => void) => typeof fakeReq;
    write: (body: string) => boolean;
    end: () => void;
    destroy: (err?: Error) => void;
  };
  fakeReq.setTimeout = () => fakeReq;
  fakeReq.write = () => true;
  fakeReq.end = () => undefined;
  fakeReq.destroy = (err?: Error) => {
    fakeReq.emit("error", err ?? new Error("destroyed"));
  };

  (https as typeof https & { request: unknown }).request = () => fakeReq;

  t.after(() => {
    (https as typeof https & { request: unknown }).request = originalRequest;
  });

  const chunks: StreamChunk[] = [];
  const { resolveAgentConfig } = await import("../src/lib/agent/agentConfig.js");
  const config = resolveAgentConfig({
    apiKey: "sk-test",
    apiBase: "https://api.siliconflow.cn/v1",
    model: "test-model",
    streamTimeoutMs: 20,
  });
  const result = await Promise.race([
    streamSiliconFlow(
      {
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
      },
      config,
      (chunk) => chunks.push(chunk)
    ).then(() => "resolved"),
    new Promise<"timed-out">((resolve) =>
      setTimeout(() => resolve("timed-out"), 200)
    ),
  ]);

  assert.equal(result, "resolved");
  assert.deepEqual(chunks, [
    { type: "error", message: "Request timeout after 20ms" },
  ]);
});

test("streamSiliconFlow emits an error when the upstream response stalls after headers", async (t) => {
  const originalRequest = https.request;

  const fakeReq = new EventEmitter() as EventEmitter & {
    setTimeout: (ms: number, cb: () => void) => typeof fakeReq;
    write: (body: string) => boolean;
    end: () => void;
    destroy: (err?: Error) => void;
  };
  fakeReq.setTimeout = () => fakeReq;
  fakeReq.write = () => true;
  fakeReq.end = () => undefined;
  fakeReq.destroy = (err?: Error) => {
    fakeReq.emit("error", err ?? new Error("destroyed"));
  };

  (https as typeof https & { request: unknown }).request = (_options, cb) => {
    const res = new EventEmitter() as EventEmitter & { statusCode: number };
    res.statusCode = 200;
    process.nextTick(() => {
      (cb as (res: typeof res) => void)(res);
    });
    return fakeReq;
  };

  t.after(() => {
    (https as typeof https & { request: unknown }).request = originalRequest;
  });

  const chunks: StreamChunk[] = [];
  const { resolveAgentConfig } = await import("../src/lib/agent/agentConfig.js");
  const config = resolveAgentConfig({
    apiKey: "sk-test",
    apiBase: "https://api.siliconflow.cn/v1",
    model: "test-model",
    streamTimeoutMs: 20,
  });
  const result = await Promise.race([
    streamSiliconFlow(
      {
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
      },
      config,
      (chunk) => chunks.push(chunk)
    ).then(() => "resolved"),
    new Promise<"timed-out">((resolve) =>
      setTimeout(() => resolve("timed-out"), 200)
    ),
  ]);

  assert.equal(result, "resolved");
  assert.deepEqual(chunks, [
    { type: "error", message: "Request timeout after 20ms" },
  ]);
});
