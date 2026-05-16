import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

// Dynamic import after env manipulation
describe("resolveAgentConfig", () => {
  it("uses override values when provided", async () => {
    const { resolveAgentConfig } = await import(
      "../src/lib/agent/agentConfig.js"
    );
    const cfg = resolveAgentConfig({
      apiKey: "sk-test",
      apiBase: "https://custom.api/v1/",
      model: "my-model",
    });
    assert.equal(cfg.apiKey, "sk-test");
    assert.equal(cfg.apiBase, "https://custom.api/v1"); // trailing slash stripped
    assert.equal(cfg.model, "my-model");
  });

  it("strips trailing slash from apiBase", async () => {
    const { resolveAgentConfig } = await import(
      "../src/lib/agent/agentConfig.js"
    );
    const cfg = resolveAgentConfig({ apiBase: "https://api.example.com/v1/" });
    assert.equal(cfg.apiBase, "https://api.example.com/v1");
  });

  it("returns empty apiKey when nothing configured", async () => {
    const saved = process.env.AGENT_API_KEY;
    delete process.env.AGENT_API_KEY;
    delete process.env.SILICONFLOW_API_KEY;
    const { resolveAgentConfig } = await import(
      "../src/lib/agent/agentConfig.js"
    );
    const cfg = resolveAgentConfig({});
    assert.equal(cfg.apiKey, "");
    if (saved !== undefined) process.env.AGENT_API_KEY = saved;
  });

  it("falls back to SILICONFLOW_API_KEY env var", async () => {
    const saved = process.env.SILICONFLOW_API_KEY;
    process.env.SILICONFLOW_API_KEY = "sk-from-env";
    delete process.env.AGENT_API_KEY;
    const { resolveAgentConfig } = await import(
      "../src/lib/agent/agentConfig.js"
    );
    const cfg = resolveAgentConfig({});
    assert.equal(cfg.apiKey, "sk-from-env");
    if (saved !== undefined) process.env.SILICONFLOW_API_KEY = saved;
    else delete process.env.SILICONFLOW_API_KEY;
  });
});
