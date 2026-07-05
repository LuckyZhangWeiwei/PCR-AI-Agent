import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  loadMaskingDictionary,
  createStreamUnmasker,
  resetMaskingDictionaryCacheForTest,
  type MaskingDictionary,
} from "../src/lib/agent/agentDataMasking.js";
import { getYieldMonitorTriggerDummyRows } from "../src/lib/yieldMonitorTriggerDummy.js";

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
      mask: (t: string) => t.replace(/FOO/g, "TOKEN_abcdefghij"),
      unmask: (t: string) => t.replace(/TOKEN_abcdefghij/g, "FOO"),
    };
    const unmasker = createStreamUnmasker(fakeDict);

    const padding = "x".repeat(50);
    const full = `${padding} before TOKEN_abcdefghij after ${padding}`;
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
    assert.ok(!out.includes("abcdefghij"), "no partial or full raw token fragment must leak");
  });
});
