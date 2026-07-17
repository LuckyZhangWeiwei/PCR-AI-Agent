import assert from "node:assert/strict";
import test from "node:test";
import {
  deviceBaseMask,
  deviceMask,
  deviceMatchesMask,
  looksLikeDeviceMaskToken,
} from "../src/lib/deviceMask.js";

test("deviceBaseMask extracts suffix from base segment", () => {
  assert.equal(deviceBaseMask("WA03P02G"), "P02G");
  assert.equal(deviceBaseMask("WC21P51A-V2"), "P51A");
  assert.equal(deviceBaseMask("WA13N06Z_R1"), "N06Z");
});

test("deviceMask strips -M/-N variant suffix before taking last 4 chars", () => {
  assert.equal(deviceMask("WA03P02G"), "P02G");
  assert.equal(deviceMask("WA03P02G-M"), "P02G");
  assert.equal(deviceMask("WA03P02G-N"), "P02G");
  assert.equal(deviceMask("WC21P51A-V2"), "P51A");
  assert.equal(deviceMask("WA13N06Z_R1"), "N06Z");
  assert.equal(deviceMask(""), null);
  assert.equal(deviceMask(null), null);
});

test("deviceMatchesMask matches base suffix and substring", () => {
  assert.equal(deviceMatchesMask("WA03P02G", "P02G"), true);
  assert.equal(deviceMatchesMask("WC21P51A-V2", "P51A"), true);
  assert.equal(deviceMatchesMask("WA03P02G", "N06Z"), false);
  assert.equal(deviceMatchesMask("WA03P02G", "p02g"), true);
});

test("looksLikeDeviceMaskToken accepts 4-char alphanumeric", () => {
  assert.equal(looksLikeDeviceMaskToken("P02G"), true);
  assert.equal(looksLikeDeviceMaskToken("WA03P02G"), false);
});
