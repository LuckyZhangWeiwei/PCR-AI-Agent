import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { parseInfWaferCoordsFromPath } from "../src/lib/buildInfPath.js";
import {
  binSiteSummaryToSiteBinPass,
  mergeBinSiteSummariesToSiteBinByLotData,
  parseOracleBinCodeOnlyMap,
  parseOracleBinSiteMap,
  parseOracleBinSiteMapOrBinOnly,
} from "../src/lib/infOracleMapFallback.js";

describe("infOracleMapFallback parse", () => {
  test("parseOracleBinSiteMap skips __ and @@ pads", () => {
    const bin = "__ @@ 37 37 __";
    const site = "__ @@ 09 09 __";
    const summary = parseOracleBinSiteMap(bin, site);
    assert.equal(summary.get("55,9"), 2);
    assert.equal(summary.size, 1);
  });

  test("parseOracleBinCodeOnlyMap uses dut=single (Perl no-site parity)", () => {
    const summary = parseOracleBinCodeOnlyMap("__ 01 03 01 __");
    assert.equal(summary.get("1,single"), 2);
    assert.equal(summary.get("3,single"), 1);
    assert.equal(summary.size, 2);
  });

  test("parseOracleBinSiteMapOrBinOnly falls back when site CLOB empty", () => {
    const summary = parseOracleBinSiteMapOrBinOnly("0A 0B", "");
    assert.equal(summary.get("10,single"), 1);
    assert.equal(summary.get("11,single"), 1);
  });

  test("parseOracleBinSiteMapOrBinOnly falls back when site tokens all pads", () => {
    const summary = parseOracleBinSiteMapOrBinOnly("0A 0B", "__ @@");
    assert.equal(summary.get("10,single"), 1);
    assert.equal(summary.get("11,single"), 1);
  });

  test("binSiteSummaryToSiteBinPass builds site-bin-bylot shape", () => {
    const summary = new Map<string, number>([
      ["6,1", 4],
      ["7,13", 2],
    ]);
    const pass = binSiteSummaryToSiteBinPass(1, summary);
    assert.equal(pass.passId, 1);
    assert.deepEqual(pass.bins[0], {
      bin: "bin6",
      duts: [{ dut: 1, dieCount: 4 }],
    });
    assert.deepEqual(pass.bins[1], {
      bin: "bin7",
      duts: [{ dut: 13, dieCount: 2 }],
    });
  });

  test("binSiteSummaryToSiteBinPass supports dut=single keys", () => {
    const pass = binSiteSummaryToSiteBinPass(
      1,
      new Map([
        ["55,single", 10],
        ["3,single", 2],
      ])
    );
    assert.deepEqual(pass.bins, [
      { bin: "bin3", duts: [{ dut: "single", dieCount: 2 }] },
      { bin: "bin55", duts: [{ dut: "single", dieCount: 10 }] },
    ]);
  });

  test("mergeBinSiteSummariesToSiteBinByLotData sorts passes", () => {
    const byPass = new Map([
      [3, new Map([["1,2", 1]])],
      [1, new Map([["55,0", 10]])],
    ]);
    const data = mergeBinSiteSummariesToSiteBinByLotData(byPass);
    assert.deepEqual(
      data.passes.map((p) => p.passId),
      [1, 3]
    );
  });
});

describe("parseInfWaferCoordsFromPath", () => {
  test("parses standard inf path", () => {
    assert.deepEqual(
      parseInfWaferCoordsFromPath("/data/INF/WA03P02G/NF13664.1C/r_1-13"),
      { device: "WA03P02G", lot: "NF13664.1C", slot: 13 }
    );
  });
});
