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
