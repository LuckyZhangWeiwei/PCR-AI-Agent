import { describe, it } from "node:test";
import assert from "node:assert/strict";

process.env["YIELD_MONITOR_TRIGGERS_DUMMY"] = "true";
process.env["INFCONTROL_LAYER_BINS_DUMMY"] = "true";

import {
  loadMaskingDictionary,
  createStreamUnmasker,
  resetMaskingDictionaryCacheForTest,
  type MaskingDictionary,
} from "../src/lib/agent/agentDataMasking.js";
import { getYieldMonitorTriggerDummyRows } from "../src/lib/yieldMonitor/yieldMonitorTriggerDummy.js";

describe("agentDataMasking", () => {
  it("masks a real device value to a DEV_ token and unmasks it back", async () => {
    resetMaskingDictionaryCacheForTest();
    const rows = getYieldMonitorTriggerDummyRows();
    const realDevice = String(rows[0]?.DEVICE ?? "").trim();
    assert.ok(realDevice.length > 0, "dummy rows must contain at least one DEVICE value");

    const dict = await loadMaskingDictionary();
    const text = `设备 ${realDevice} 良率偏低`;
    const masked = dict.mask(text);

    assert.ok(!masked.includes(realDevice), "masked text must not contain the real device value");
    assert.match(masked, /DEV_[0-9a-f]+/, "masked text must contain a DEV_ token");
    assert.equal(dict.unmask(masked), text, "unmask must restore the original text exactly");
  });

  it("maps the same real device value to the same token across a cache rebuild", async () => {
    resetMaskingDictionaryCacheForTest();
    const rows = getYieldMonitorTriggerDummyRows();
    const realDevice = String(rows[0]?.DEVICE ?? "").trim();

    const dictA = await loadMaskingDictionary();
    const maskedA = dictA.mask(realDevice);

    resetMaskingDictionaryCacheForTest();
    const dictB = await loadMaskingDictionary();
    const maskedB = dictB.mask(realDevice);

    assert.equal(maskedA, maskedB, "token for the same real device must be stable across rebuilds");
  });

  it("replaces NXP case-insensitively and restores it to canonical NXP", async () => {
    resetMaskingDictionaryCacheForTest();
    const dict = await loadMaskingDictionary();
    const text = "这是 NXP 的产品，Nxp 团队负责，nxp内部代号";
    const masked = dict.mask(text);

    assert.ok(!/nxp/i.test(masked), "masked text must not contain NXP in any case");
    assert.equal(
      dict.unmask(masked),
      "这是 NXP 的产品，NXP 团队负责，NXP内部代号",
      "unmask restores all NXP variants to canonical uppercase NXP"
    );
  });

  it("StreamUnmasker correctly restores a token split across streamed chunks", () => {
    const fakeDict: MaskingDictionary = {
      mask: (t: string) => t.replace(/FOO/g, "DEV_0123456789ab"),
      unmask: (t: string) => t.replace(/DEV_0123456789ab/g, "FOO"),
    };
    const unmasker = createStreamUnmasker(fakeDict);

    const padding = "x".repeat(50);
    const full = `${padding} before DEV_0123456789ab after ${padding}`;
    // Simulate network chunking: small pieces guarantee the 16-char token
    // straddles a chunk boundary at least once, and total length exceeds
    // any reasonable lookahead buffer so incremental flushing is exercised.
    const chunkSize = 7;
    let out = "";
    for (let i = 0; i < full.length; i += chunkSize) {
      out += unmasker.push(full.slice(i, i + chunkSize));
    }
    out += unmasker.finalize();

    assert.equal(out, `${padding} before FOO after ${padding}`);
    assert.ok(!out.includes("0123456789ab"), "no partial or full raw token fragment must leak");
  });

  it("StreamUnmasker never leaks a partial device token when fed in tiny chunks smaller than the token", async () => {
    resetMaskingDictionaryCacheForTest();
    const rows = getYieldMonitorTriggerDummyRows();
    const realDevice = String(rows[0]?.DEVICE ?? "").trim();
    const dict = await loadMaskingDictionary();
    const maskedDevice = dict.mask(realDevice);
    assert.notEqual(maskedDevice, realDevice, "sanity check: masking must actually change the text");

    const unmasker = createStreamUnmasker(dict);
    // Long leading padding so the buffer has already grown well past any
    // fixed-size lookahead window by the time the token itself streams in;
    // a 3-char chunk size (much smaller than the token) guarantees the old
    // buggy fixed-window-slice algorithm would have split the token across
    // several separate dict.unmask() calls, leaking raw fragments.
    const padding = "y".repeat(200);
    const full = `${padding} before ${maskedDevice} after`;
    const chunkSize = 3;
    let out = "";
    for (let i = 0; i < full.length; i += chunkSize) {
      out += unmasker.push(full.slice(i, i + chunkSize));
    }
    out += unmasker.finalize();

    assert.equal(out, `${padding} before ${realDevice} after`);
    assert.ok(!out.includes(maskedDevice), "raw device token must not leak in fragments");
  });
});
