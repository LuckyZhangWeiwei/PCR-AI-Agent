import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseInf } from "../src/lib/infParser.js";
import {
  buildStandardWaferMapPassSpecs,
  buildWaferMapPassSpecs,
  decodePsbn,
  describePassLayer,
  findPsbn,
  findSegmentedPassLayers,
  getDiesForWaferMapSpec,
} from "../src/lib/infWaferMap.js";
import { findAllSmWaferPasses } from "../src/lib/infWaferMap.js";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "docs",
  "inf-dummy-r_1-1"
);

test("buildStandardWaferMapPassSpecs lists every SmWaferPass + composite", async () => {
  assert.ok(fs.existsSync(fixture), "inf-dummy-r_1-1 fixture required");
  const root = await parseInf(fixture);
  const all = findAllSmWaferPasses(root);
  const specs = buildStandardWaferMapPassSpecs(root);

  assert.equal(specs.length, all.length + 1);
  assert.equal(specs[specs.length - 1]!.dieKey, "final");
  assert.equal(specs[specs.length - 1]!.label, "合成 (正测+复测)");

  const testTabs = specs.filter(
    (s) => s.dieKey.startsWith("__block:") && s.label.includes("(正测")
  );
  const retestTabs = specs.filter(
    (s) => s.dieKey.startsWith("__block:") && s.label.includes("(复测")
  );
  assert.equal(testTabs.length, all.filter((p) => p.passType.toUpperCase() === "TEST").length);
  assert.equal(
    retestTabs.length,
    all.filter((p) => p.passType.toUpperCase() === "RETESTBIN").length
  );

  const psbn = findPsbn(root);
  const goodBins = psbn ? decodePsbn(psbn) : new Set([1]);
  for (const spec of specs) {
    const dies = getDiesForWaferMapSpec(root, goodBins, spec.dieKey);
    assert.ok(dies.length > 0, `no dies for ${spec.dieKey} (${spec.label})`);
  }
});

test("describePassLayer labels retest segments when multiple RETESTBIN same PASS_ID", () => {
  const all = [
    { passId: "5", passType: "RETESTBIN", block: {} as never, session: "1", passResult: "" },
    { passId: "5", passType: "RETESTBIN", block: {} as never, session: "1", passResult: "" },
  ];
  assert.equal(describePassLayer(all, 0), "复测·中断前");
  assert.equal(describePassLayer(all, 1), "复测·续测后");
});

test("buildWaferMapPassSpecs(final) matches standard layout", async () => {
  const root = await parseInf(fixture);
  const standard = buildStandardWaferMapPassSpecs(root);
  const fromFinal = buildWaferMapPassSpecs(root, "final");
  assert.deepEqual(fromFinal, standard);
  assert.ok(findSegmentedPassLayers(root).length >= 6);
});

test("buildWaferMapPassSpecs(composite) is final layer only", async () => {
  const root = await parseInf(fixture);
  const specs = buildWaferMapPassSpecs(root, "composite");
  assert.equal(specs.length, 1);
  assert.equal(specs[0]!.dieKey, "final");
});

test("buildWaferMapPassSpecs(all) equals standard", async () => {
  const root = await parseInf(fixture);
  assert.deepEqual(
    buildWaferMapPassSpecs(root, "all"),
    buildStandardWaferMapPassSpecs(root)
  );
});
