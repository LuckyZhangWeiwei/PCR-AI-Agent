import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import https from "node:https";
import test from "node:test";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// RUNTIME_CONFIG_PATH is read once at module load time inside runtimeConfig.ts
// (transitively imported by agentStream.ts), so it must point at a file that
// already contains dataMaskingEnabled:true BEFORE the first (dynamic) import
// of agentStream.js in this test file's process. This keeps the test off the
// real, git-tracked pcr-ai-api/runtime-config.json entirely, matching the
// convention established in test/runtimeConfig.test.ts.
const TEST_CONFIG_PATH = join(
  tmpdir(),
  `pcr-ai-agent-stream-masking-test-${process.pid}-${Date.now()}.json`
);
process.env.RUNTIME_CONFIG_PATH = TEST_CONFIG_PATH;
writeFileSync(TEST_CONFIG_PATH, JSON.stringify({ dataMaskingEnabled: true }), "utf-8");

test.after(() => {
  delete process.env.RUNTIME_CONFIG_PATH;
  if (existsSync(TEST_CONFIG_PATH)) unlinkSync(TEST_CONFIG_PATH);
});

function mockStreamedResponse(sseBody: string) {
  const originalRequest = https.request;
  let capturedBody = "";

  const fakeReq = new EventEmitter() as EventEmitter & {
    setTimeout: (ms: number, cb: () => void) => typeof fakeReq;
    write: (body: string) => boolean;
    end: () => void;
    destroy: (err?: Error) => void;
  };
  fakeReq.setTimeout = () => fakeReq;
  fakeReq.write = (body: string) => {
    capturedBody += body;
    return true;
  };
  fakeReq.end = () => undefined;
  fakeReq.destroy = (err?: Error) => {
    fakeReq.emit("error", err ?? new Error("destroyed"));
  };

  (https as typeof https & { request: unknown }).request = (_options, cb) => {
    const res = new EventEmitter() as EventEmitter & { statusCode: number };
    res.statusCode = 200;
    process.nextTick(() => {
      (cb as (res: typeof res) => void)(res);
      process.nextTick(() => {
        res.emit("data", Buffer.from(sseBody));
        res.emit("end");
      });
    });
    return fakeReq;
  };

  return {
    getCapturedBody: () => capturedBody,
    restore: () => {
      (https as typeof https & { request: unknown }).request = originalRequest;
    },
  };
}

test("streamSiliconFlow masks NXP in the outbound request body when dataMaskingEnabled is true", async () => {
  const sse =
    `data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\n` +
    `data: [DONE]\n\n`;
  const mock = mockStreamedResponse(sse);
  try {
    const { streamSiliconFlow } = await import("../src/lib/agent/core/agentStream.js");
    const { resolveAgentConfig } = await import("../src/lib/agent/agentConfig.js");
    const config = resolveAgentConfig({
      apiKey: "sk-test",
      apiBase: "https://api.siliconflow.cn/v1",
      model: "test-model",
    });

    await streamSiliconFlow(
      {
        model: "test-model",
        messages: [{ role: "user", content: "NXP 的探针卡数据怎么样" }],
      },
      config,
      () => {}
    );

    const body = JSON.parse(mock.getCapturedBody()) as { messages: { content: string }[] };
    assert.ok(
      !/nxp/i.test(body.messages[0].content),
      "outbound request body must not contain NXP in any case"
    );
  } finally {
    mock.restore();
  }
});

test("streamSiliconFlow unmasks a COMPANY_X token back to NXP in streamed text before onChunk", async () => {
  const sse =
    `data: {"choices":[{"delta":{"content":"COMPANY_X 良率正常"},"finish_reason":null}]}\n\n` +
    `data: [DONE]\n\n`;
  const mock = mockStreamedResponse(sse);
  try {
    const { streamSiliconFlow } = await import("../src/lib/agent/core/agentStream.js");
    const { resolveAgentConfig } = await import("../src/lib/agent/agentConfig.js");
    const config = resolveAgentConfig({
      apiKey: "sk-test",
      apiBase: "https://api.siliconflow.cn/v1",
      model: "test-model",
    });

    const texts: string[] = [];
    await streamSiliconFlow(
      { model: "test-model", messages: [{ role: "user", content: "hi" }] },
      config,
      (chunk) => {
        if (chunk.type === "delta") texts.push(chunk.text);
      }
    );

    assert.equal(texts.join(""), "NXP 良率正常");
  } finally {
    mock.restore();
  }
});
