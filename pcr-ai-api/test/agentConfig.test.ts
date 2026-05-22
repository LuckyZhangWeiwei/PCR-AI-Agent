import { describe, it } from "node:test";
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
    assert.equal(cfg.maxRounds, 5);
  });

  it("clamps maxRounds from override", async () => {
    const { resolveAgentConfig } = await import(
      "../src/lib/agent/agentConfig.js"
    );
    assert.equal(resolveAgentConfig({ maxRounds: 0 }).maxRounds, 1);
    assert.equal(resolveAgentConfig({ maxRounds: 99 }).maxRounds, 20);
    assert.equal(resolveAgentConfig({ maxRounds: 8 }).maxRounds, 8);
  });

  it("reads AGENT_MAX_ROUNDS from env when override omitted", async () => {
    const saved = process.env.AGENT_MAX_ROUNDS;
    process.env.AGENT_MAX_ROUNDS = "12";
    try {
      const { resolveAgentConfig } = await import(
        "../src/lib/agent/agentConfig.js"
      );
      assert.equal(resolveAgentConfig({}).maxRounds, 12);
    } finally {
      if (saved !== undefined) process.env.AGENT_MAX_ROUNDS = saved;
      else delete process.env.AGENT_MAX_ROUNDS;
    }
  });

  it("strips trailing slash from apiBase", async () => {
    const { resolveAgentConfig } = await import(
      "../src/lib/agent/agentConfig.js"
    );
    const cfg = resolveAgentConfig({ apiBase: "https://api.example.com/v1/" });
    assert.equal(cfg.apiBase, "https://api.example.com/v1");
  });

  it("returns empty apiKey when nothing configured", async () => {
    const savedAgent = process.env.AGENT_API_KEY;
    const savedSilicon = process.env.SILICONFLOW_API_KEY;
    delete process.env.AGENT_API_KEY;
    delete process.env.SILICONFLOW_API_KEY;
    try {
      const { resolveAgentConfig } = await import(
        "../src/lib/agent/agentConfig.js"
      );
      const cfg = resolveAgentConfig({});
      assert.equal(cfg.apiKey, "");
    } finally {
      if (savedAgent !== undefined) process.env.AGENT_API_KEY = savedAgent;
      if (savedSilicon !== undefined) process.env.SILICONFLOW_API_KEY = savedSilicon;
    }
  });

  it("falls back to SILICONFLOW_API_KEY env var", async () => {
    const savedSilicon = process.env.SILICONFLOW_API_KEY;
    const savedAgent = process.env.AGENT_API_KEY;
    process.env.SILICONFLOW_API_KEY = "sk-from-env";
    delete process.env.AGENT_API_KEY;
    try {
      const { resolveAgentConfig } = await import(
        "../src/lib/agent/agentConfig.js"
      );
      const cfg = resolveAgentConfig({});
      assert.equal(cfg.apiKey, "sk-from-env");
    } finally {
      if (savedSilicon !== undefined) process.env.SILICONFLOW_API_KEY = savedSilicon;
      else delete process.env.SILICONFLOW_API_KEY;
      if (savedAgent !== undefined) process.env.AGENT_API_KEY = savedAgent;
    }
  });
});
