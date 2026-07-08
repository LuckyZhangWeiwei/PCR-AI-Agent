import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  INFCONTROL_LAYER_BIN_V3_PASSTYPES,
  infcontrolLayerBinV3BaseWhereBlock,
  infcontrolLayerBinV3PasstypeMatches,
  infcontrolLayerBinV3PasstypeOracleIn,
} from "../src/lib/infcontrolLayerBinPasstypeScope.js";

describe("infcontrolLayerBinPasstypeScope", () => {
  test("Oracle IN list includes TEST ISR and TEST INTERRUPT but not RETESTBIN", () => {
    const sql = infcontrolLayerBinV3PasstypeOracleIn("t2");
    assert.doesNotMatch(sql, /'RETESTBIN'/);
    assert.match(sql, /'TEST ISR'/);
    assert.match(sql, /'TEST INTERRUPT'/);
    assert.match(sql, /'TEST'/);
    assert.match(sql, /'INTERRUPT'/);
  });

  test("infcontrolLayerBinV3PasstypeMatches", () => {
    for (const pt of INFCONTROL_LAYER_BIN_V3_PASSTYPES) {
      assert.equal(infcontrolLayerBinV3PasstypeMatches(pt), true);
      assert.equal(infcontrolLayerBinV3PasstypeMatches(` ${pt} `), true);
    }
    assert.equal(infcontrolLayerBinV3PasstypeMatches("TEST INTERRUPT"), true);
    assert.equal(infcontrolLayerBinV3PasstypeMatches("NA"), false);
    assert.equal(infcontrolLayerBinV3PasstypeMatches("RETEST"), false);
    assert.equal(infcontrolLayerBinV3PasstypeMatches("RETESTBIN"), false);
  });

  test("infcontrolLayerBinV3BaseWhereBlock appends extra AND", () => {
    const block = infcontrolLayerBinV3BaseWhereBlock("t2", "t1.DEVICE = :d");
    assert.match(block, /^WHERE /);
    assert.match(block, /t1\.DEVICE = :d$/);
    assert.match(block, /LAYERNAME/);
  });
});
