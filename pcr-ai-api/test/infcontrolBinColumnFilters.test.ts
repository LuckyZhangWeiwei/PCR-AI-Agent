import assert from "node:assert/strict";
import test from "node:test";
import {
  applyInfcontrolBinColumnFilters,
  parseBinIndexList,
  rowMatchesInfcontrolBinColumnFilters,
} from "../src/lib/infcontrolBinColumnFilters.js";
import {
  filterInfcontrolLayerBinV3DummyRows,
  filterInfcontrolLayerBinV3DummyRowsMatching,
} from "../src/lib/infcontrol/infcontrolLayerBinDummy.js";
import { parseInfcontrolLayerBinsV3Query } from "../src/lib/infcontrol/infcontrolLayerBinFilters.js";

test("parseBinIndexList accepts plain and BIN-prefixed tokens", () => {
  assert.deepEqual(parseBinIndexList("8, 11, 131", "bins"), [8, 11, 131]);
  assert.deepEqual(parseBinIndexList("BIN8,BIN11", "bins"), [8, 11]);
});

test("applyInfcontrolBinColumnFilters builds OR on BIN columns for bins=", () => {
  const clauses: string[] = [];
  const applied: Record<string, unknown> = {};
  const r = applyInfcontrolBinColumnFilters(
    { bins: "8,11" },
    clauses,
    {},
    applied,
    "t2."
  );
  assert.equal(r.ok, true);
  assert.deepEqual(applied.bins, [8, 11]);
  assert.match(clauses[0]!, /t2\.BIN8/);
  assert.match(clauses[0]!, /t2\.BIN11/);
  assert.match(clauses[0]!, /\sOR\s/);
});

test("rowMatchesInfcontrolBinColumnFilters bins presence", () => {
  const row = { BIN7: 0, BIN8: 3, BIN11: 0 };
  assert.equal(rowMatchesInfcontrolBinColumnFilters(row, { bins: [8] }), true);
  assert.equal(rowMatchesInfcontrolBinColumnFilters(row, { bins: [11] }), false);
  assert.equal(rowMatchesInfcontrolBinColumnFilters(row, { bins: [8, 11] }), true);
});

test("filterInfcontrolLayerBinV3DummyRowsMatching honors bins filter", () => {
  const rows = filterInfcontrolLayerBinV3DummyRowsMatching({ bins: [8] });
  assert.ok(rows.length > 0);
  for (const r of rows) {
    assert.ok(Number(r.BIN8) > 0, `expected BIN8>0 for slot ${r.SLOT}`);
  }
});

test("parseInfcontrolLayerBinsV3Query + v3 list dummy rows for bins=8", () => {
  const parsed = parseInfcontrolLayerBinsV3Query({ bins: "8", limit: "200" });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.applied.bins, [8]);
  assert.match(parsed.whereAndSql, /t2\.BIN8/);
  const rows = filterInfcontrolLayerBinV3DummyRows(parsed.applied, 200);
  assert.ok(rows.length > 0);
});
