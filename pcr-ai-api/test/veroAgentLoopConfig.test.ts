import assert from "node:assert/strict";
import test from "node:test";

import {
  isVeroGenericLoopEnabled,
  isVeroGenericLoopReady,
} from "../src/lib/vero/veroSimpleAgent.js";
import {
  VERO_SUMMARIZE_THRESHOLD,
  VERO_TOOL_RESULT_MAX_HISTORY_CHARS,
  VERO_PROMPT_CHAR_BUDGET,
} from "../src/lib/agent/core/veroAgentLoopConfig.js";

test("isVeroGenericLoopEnabled / isVeroGenericLoopReady toggle with env", () => {
  const prevFlag = process.env.AGENT_VERO_GENERIC_LOOP;
  const prevToken = process.env.WCHAT_ACCESS_TOKEN;
  try {
    delete process.env.AGENT_VERO_GENERIC_LOOP;
    delete process.env.WCHAT_ACCESS_TOKEN;
    assert.equal(isVeroGenericLoopEnabled(), false);
    assert.equal(isVeroGenericLoopReady(), false);

    process.env.AGENT_VERO_GENERIC_LOOP = "true";
    assert.equal(isVeroGenericLoopEnabled(), true);
    assert.equal(isVeroGenericLoopReady(), false); // no token yet

    process.env.WCHAT_ACCESS_TOKEN = "tok";
    assert.equal(isVeroGenericLoopReady(), true);
  } finally {
    if (prevFlag === undefined) delete process.env.AGENT_VERO_GENERIC_LOOP;
    else process.env.AGENT_VERO_GENERIC_LOOP = prevFlag;
    if (prevToken === undefined) delete process.env.WCHAT_ACCESS_TOKEN;
    else process.env.WCHAT_ACCESS_TOKEN = prevToken;
  }
});

test("Vero loop calibration constants are sane relative to SiliconFlow large-context bucket", () => {
  // Claude 4.6 (128K) is smaller than the existing MiniMax-M2.5 large-context
  // bucket (192K, SUMMARIZE_THRESHOLD=80 in agentHistory.ts usage), so the
  // Vero-specific threshold must stay below it (see design doc §4.1).
  assert.ok(VERO_SUMMARIZE_THRESHOLD > 0 && VERO_SUMMARIZE_THRESHOLD < 80);
  assert.ok(VERO_TOOL_RESULT_MAX_HISTORY_CHARS > 0 && VERO_TOOL_RESULT_MAX_HISTORY_CHARS < 20000);
  assert.ok(VERO_PROMPT_CHAR_BUDGET > 100_000);
});
