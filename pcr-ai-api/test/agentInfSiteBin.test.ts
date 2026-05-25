import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { buildInfLotDir, buildInfPath } from "../src/lib/buildInfPath.js";
import { runTool } from "../src/lib/agent/agentToolHandlers.js";

describe("buildInfPath", () => {
  it("buildInfLotDir uppercases device and lot", () => {
    assert.equal(
      buildInfLotDir("wa03p02g", "nf12551.1n"),
      "/data/INF/WA03P02G/NF12551.1N"
    );
  });

  it("uppercases device and lot, appends slot", () => {
    assert.equal(
      buildInfPath("WA03P02G", "NF12551.1N", 3),
      "/data/INF/WA03P02G/NF12551.1N/r_1-3"
    );
  });

  it("uppercases lowercase inputs", () => {
    assert.equal(
      buildInfPath("wa03p02g", "nf12551.1n", 25),
      "/data/INF/WA03P02G/NF12551.1N/r_1-25"
    );
  });

  it("uses INF_STORAGE_ROOT env override", () => {
    const orig = process.env.INF_STORAGE_ROOT;
    process.env.INF_STORAGE_ROOT = "/mnt/data/inf";
    assert.equal(
      buildInfPath("DEV", "LOT", 1),
      "/mnt/data/inf/DEV/LOT/r_1-1"
    );
    if (orig === undefined) delete process.env.INF_STORAGE_ROOT;
    else process.env.INF_STORAGE_ROOT = orig;
  });

  it("strips trailing slash from INF_STORAGE_ROOT", () => {
    const orig = process.env.INF_STORAGE_ROOT;
    process.env.INF_STORAGE_ROOT = "/data/INF/";
    assert.equal(
      buildInfPath("D", "L", 5),
      "/data/INF/D/L/r_1-5"
    );
    if (orig === undefined) delete process.env.INF_STORAGE_ROOT;
    else process.env.INF_STORAGE_ROOT = orig;
  });
});

describe("toolQueryInfSiteBinByDut", () => {
  before(() => {
    process.env.NODE_ENV = "test";
  });

  it("returns error string when device is missing", async () => {
    const result = await runTool("query_inf_site_bin_by_dut", { lot: "NF12551.1N", slot: 3 });
    assert.ok(typeof result === "string");
    assert.ok((result as string).includes("device"));
  });

  it("returns error string when lot is missing", async () => {
    const result = await runTool("query_inf_site_bin_by_dut", { device: "WA03P02G", slot: 3 });
    assert.ok(typeof result === "string");
    assert.ok((result as string).includes("lot"));
  });

  it("returns error string when slot is missing", async () => {
    const result = await runTool("query_inf_site_bin_by_dut", { device: "WA03P02G", lot: "NF12551.1N" });
    assert.ok(typeof result === "string");
    assert.ok((result as string).includes("slot"));
  });

  it("returns JSON with passes, bin, dieCount using dummy mode", async () => {
    const result = await runTool("query_inf_site_bin_by_dut", {
      device: "WA03P02G",
      lot: "NF12551.1N",
      slot: 1,
      passId: 1,
      cardId: "9440-001",
    });
    assert.ok(typeof result === "string");
    // Result may be truncated by TOOL_RESULT_TRUNCATE (6000 chars); verify structure from prefix
    const resultStr = result as string;
    assert.ok(resultStr.startsWith("{"), "result should start with JSON object");
    assert.ok(
      resultStr.includes('"cardId":"9440-001"') || resultStr.includes('"cardId": "9440-001"'),
      "result should contain cardId"
    );
    assert.ok(
      resultStr.includes('"passes"'),
      "result should contain passes key"
    );
    // Only deep-parse if not truncated
    if (!resultStr.endsWith("…(truncated)")) {
      const parsed = JSON.parse(resultStr) as {
        passes: Array<{ passId: number; bins: Array<{ bin: string; duts: Array<{ dut: unknown; dieCount: number }> }> }>;
        cardId?: string;
      };
      assert.ok(Array.isArray(parsed.passes));
      assert.equal(parsed.cardId, "9440-001");
      if (parsed.passes.length > 0) {
        const firstPass = parsed.passes[0];
        assert.ok(Array.isArray(firstPass.bins));
        if (firstPass.bins.length > 0) {
          const firstBin = firstPass.bins[0];
          assert.ok(typeof firstBin.bin === "string");
          assert.ok(/^bin\d+$/i.test(firstBin.bin));
          assert.ok(Array.isArray(firstBin.duts));
          if (firstBin.duts.length > 0) {
            const d = firstBin.duts[0];
            assert.ok(typeof d.dieCount === "number");
            assert.ok(d.dieCount >= 0);
          }
        }
      }
    }
  });
});
