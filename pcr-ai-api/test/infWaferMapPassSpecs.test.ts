import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseInf } from "../src/lib/infParser.js";
import {
  buildPassIdWaferMapSpecs,
  buildStandardWaferMapPassSpecs,
  buildWaferMapPassSpecs,
  decodePsbn,
  describePassLayer,
  findPsbn,
  findSegmentedPassLayers,
  getDiesForWaferMapSpec,
  infNotchAngleToSvg,
  readDieGeometry,
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

test("buildPassIdWaferMapSpecs(1) expands to TEST+RETEST blocks + composite", async () => {
  const root = await parseInf(fixture);
  const specs = buildPassIdWaferMapSpecs(root, "1");
  // Fixture has TEST + RETESTBIN for passId=1 → 2 physical blocks + 1 composite
  assert.equal(specs.length, 3);
  const blockSpecs = specs.filter((s) => s.dieKey.startsWith("__block:"));
  assert.equal(blockSpecs.length, 2);
  assert.ok(blockSpecs.some((s) => s.label.includes("正测")), "should have 正测 tab");
  assert.ok(blockSpecs.some((s) => s.label.includes("复测")), "should have 复测 tab");
  const composite = specs.find((s) => s.dieKey === "1");
  assert.ok(composite, "should have pass-level composite tab");
  assert.equal(composite!.label, "Pass 1 (合成)");
});

test("buildWaferMapPassSpecs('1') expands same as buildPassIdWaferMapSpecs(1)", async () => {
  const root = await parseInf(fixture);
  const fromSingle = buildWaferMapPassSpecs(root, "1");
  const fromPassId = buildPassIdWaferMapSpecs(root, "1");
  assert.deepEqual(fromSingle, fromPassId);
});

test("buildWaferMapPassSpecs single passId: all block dies are non-empty", async () => {
  const root = await parseInf(fixture);
  const psbn = findPsbn(root);
  const goodBins = psbn ? decodePsbn(psbn) : new Set([1]);
  for (const passId of ["1", "3", "5"]) {
    const specs = buildWaferMapPassSpecs(root, passId);
    for (const spec of specs) {
      const dies = getDiesForWaferMapSpec(root, goodBins, spec.dieKey);
      assert.ok(dies.length > 0, `no dies for passId=${passId} spec ${spec.dieKey} (${spec.label})`);
    }
  }
});

test("infNotchAngleToSvg maps INF dNotchAngle to SVG canvas degrees", () => {
  assert.equal(infNotchAngleToSvg(180), 90); // bottom
  assert.equal(infNotchAngleToSvg(270), 180); // left
  assert.equal(infNotchAngleToSvg(90), 0); // right
  assert.equal(infNotchAngleToSvg(0), 270); // top
});

test("readDieGeometry converts dummy INF dNotchAngle 180 to SVG bottom (90)", async () => {
  const root = await parseInf(fixture);
  const { notchAngle } = readDieGeometry(root);
  assert.equal(notchAngle, 90);
});
