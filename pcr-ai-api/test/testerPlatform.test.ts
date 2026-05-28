import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPlatformQueryFilter,
  classifyTesterPlatform,
  machineIdMatchesPlatform,
  normalizeTesterPlatform,
} from "../src/lib/testerPlatform.js";

test("classifyTesterPlatform maps HOSTNAME families", () => {
  assert.equal(classifyTesterPlatform("b3uflex16"), "UFLEX");
  assert.equal(classifyTesterPlatform("b3flex01"), "FLEX");
  assert.equal(classifyTesterPlatform("b3ps1601"), "PS16");
  assert.equal(classifyTesterPlatform("b3j75003"), "J750");
  assert.equal(classifyTesterPlatform("attj93k01"), "93K");
  assert.equal(machineIdMatchesPlatform("b3uflex05", "UFLEX"), true);
  assert.equal(machineIdMatchesPlatform("b3uflex05", "FLEX"), false);
  assert.equal(machineIdMatchesPlatform("b3flex09", "FLEX"), true);
});

test("normalizeTesterPlatform accepts fixed enum", () => {
  assert.equal(normalizeTesterPlatform("uflex"), "UFLEX");
  assert.equal(normalizeTesterPlatform("93k"), "93K");
  assert.equal(normalizeTesterPlatform("bad"), undefined);
});

test("applyPlatformQueryFilter appends REGEXP on HOSTNAME column", () => {
  const clauses: string[] = [];
  const applied: Record<string, unknown> = {};
  const r = applyPlatformQueryFilter(
    { platform: "PS16" },
    clauses,
    applied,
    "t.HOSTNAME"
  );
  assert.equal(r.ok, true);
  assert.equal(applied.platform, "PS16");
  assert.equal(clauses.length, 1);
  assert.match(clauses[0]!, /ps16/);
  assert.match(clauses[0]!, /t\.HOSTNAME/);
});

test("applyPlatformQueryFilter rejects unknown platform", () => {
  const r = applyPlatformQueryFilter(
    { platform: "UNKNOWN" },
    [],
    {},
    "t.HOSTNAME"
  );
  assert.equal(r.ok, false);
});

test("Oracle REGEXP predicates align with dummy classify (UFLEX vs FLEX)", () => {
  const ids = ["b3uflex16", "b3flex01", "b3ps1601", "b3j75003", "other-host"];
  const flexOnly = ids.filter((id) => machineIdMatchesPlatform(id, "FLEX"));
  assert.deepEqual(flexOnly, ["b3flex01"]);
  const uflexOnly = ids.filter((id) => machineIdMatchesPlatform(id, "UFLEX"));
  assert.deepEqual(uflexOnly, ["b3uflex16"]);

  const clauses: string[] = [];
  applyPlatformQueryFilter({ platform: "FLEX" }, clauses, {}, "t.HOSTNAME");
  assert.match(clauses[0]!, /flex/);
  assert.match(clauses[0]!, /uflex/);
});
