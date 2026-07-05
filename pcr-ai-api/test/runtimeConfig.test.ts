import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// RUNTIME_CONFIG_PATH is read once at module load time inside runtimeConfig.ts,
// so it must be set before that module's first import in this process. Every
// test below dynamically imports the module (after this line has already run)
// instead of using a static top-level import, which ESM would hoist above this
// assignment. This keeps the test off the real, git-tracked runtime-config.json
// entirely — required because Task 2 makes other test files read the real file
// via getConfig(), and node's test runner runs test files concurrently.
const TEST_CONFIG_PATH = join(
  tmpdir(),
  `pcr-ai-runtime-config-test-${process.pid}-${Date.now()}.json`
);
process.env.RUNTIME_CONFIG_PATH = TEST_CONFIG_PATH;

describe("runtimeConfig", () => {
  after(() => {
    delete process.env.RUNTIME_CONFIG_PATH;
    if (existsSync(TEST_CONFIG_PATH)) unlinkSync(TEST_CONFIG_PATH);
  });

  it("agentApiKey defaults to empty string when nothing configured", async () => {
    const savedAgent = process.env.AGENT_API_KEY;
    const savedSilicon = process.env.SILICONFLOW_API_KEY;
    delete process.env.AGENT_API_KEY;
    delete process.env.SILICONFLOW_API_KEY;
    try {
      const { getConfig } = await import("../src/lib/runtimeConfig.js");
      assert.equal(getConfig().agentApiKey, "");
    } finally {
      if (savedAgent === undefined) delete process.env.AGENT_API_KEY;
      else process.env.AGENT_API_KEY = savedAgent;
      if (savedSilicon === undefined) delete process.env.SILICONFLOW_API_KEY;
      else process.env.SILICONFLOW_API_KEY = savedSilicon;
    }
  });

  it("reads AGENT_API_KEY from env when file has no value", async () => {
    const saved = process.env.AGENT_API_KEY;
    process.env.AGENT_API_KEY = "sk-from-env";
    try {
      const { getConfig } = await import("../src/lib/runtimeConfig.js");
      assert.equal(getConfig().agentApiKey, "sk-from-env");
    } finally {
      if (saved === undefined) delete process.env.AGENT_API_KEY;
      else process.env.AGENT_API_KEY = saved;
    }
  });

  it("falls back to SILICONFLOW_API_KEY when AGENT_API_KEY is unset", async () => {
    const savedAgent = process.env.AGENT_API_KEY;
    const savedSilicon = process.env.SILICONFLOW_API_KEY;
    delete process.env.AGENT_API_KEY;
    process.env.SILICONFLOW_API_KEY = "sk-from-siliconflow";
    try {
      const { getConfig } = await import("../src/lib/runtimeConfig.js");
      assert.equal(getConfig().agentApiKey, "sk-from-siliconflow");
    } finally {
      if (savedAgent === undefined) delete process.env.AGENT_API_KEY;
      else process.env.AGENT_API_KEY = savedAgent;
      if (savedSilicon === undefined) delete process.env.SILICONFLOW_API_KEY;
      else process.env.SILICONFLOW_API_KEY = savedSilicon;
    }
  });

  it("persists agentApiKey via patchConfig and prefers it over env", async () => {
    const saved = process.env.AGENT_API_KEY;
    process.env.AGENT_API_KEY = "sk-from-env";
    try {
      const { getConfig, patchConfig } = await import("../src/lib/runtimeConfig.js");
      const updated = patchConfig({ agentApiKey: "sk-from-file" });
      assert.equal(updated.agentApiKey, "sk-from-file");
      assert.equal(getConfig().agentApiKey, "sk-from-file");
    } finally {
      if (saved === undefined) delete process.env.AGENT_API_KEY;
      else process.env.AGENT_API_KEY = saved;
    }
  });

  it("jbDeterministicDispatch defaults to false, reads env, and can be persisted", async () => {
    const saved = process.env.JB_DETERMINISTIC_DISPATCH;
    delete process.env.JB_DETERMINISTIC_DISPATCH;
    try {
      const { getConfig, patchConfig } = await import("../src/lib/runtimeConfig.js");
      assert.equal(getConfig().jbDeterministicDispatch, false);
      process.env.JB_DETERMINISTIC_DISPATCH = "true";
      assert.equal(getConfig().jbDeterministicDispatch, true);
      delete process.env.JB_DETERMINISTIC_DISPATCH;
      const updated = patchConfig({ jbDeterministicDispatch: true });
      assert.equal(updated.jbDeterministicDispatch, true);
      assert.equal(getConfig().jbDeterministicDispatch, true);
    } finally {
      if (saved === undefined) delete process.env.JB_DETERMINISTIC_DISPATCH;
      else process.env.JB_DETERMINISTIC_DISPATCH = saved;
    }
  });

  it("jbLlmIntentClassifier defaults to false, reads env, and can be persisted", async () => {
    const saved = process.env.JB_LLM_INTENT_CLASSIFIER;
    delete process.env.JB_LLM_INTENT_CLASSIFIER;
    try {
      const { getConfig, patchConfig } = await import("../src/lib/runtimeConfig.js");
      assert.equal(getConfig().jbLlmIntentClassifier, false);
      process.env.JB_LLM_INTENT_CLASSIFIER = "true";
      assert.equal(getConfig().jbLlmIntentClassifier, true);
      delete process.env.JB_LLM_INTENT_CLASSIFIER;
      const updated = patchConfig({ jbLlmIntentClassifier: true });
      assert.equal(updated.jbLlmIntentClassifier, true);
      assert.equal(getConfig().jbLlmIntentClassifier, true);
    } finally {
      if (saved === undefined) delete process.env.JB_LLM_INTENT_CLASSIFIER;
      else process.env.JB_LLM_INTENT_CLASSIFIER = saved;
    }
  });
});
