import assert from "node:assert/strict";
import test from "node:test";

import { buildInfPath } from "../src/lib/buildInfPath.js";
import {
  buildSiteBinByLotDummyData,
  tryResolveSiteBinByLotDummy,
} from "../src/lib/outputSiteBinByLotDummy.js";
import { mergeSiteBinByLotData } from "../src/lib/outputSiteBinByLot.js";
import { getInfcontrolLayerBinDummyRows } from "../src/lib/infcontrolLayerBinDummy.js";
import {
  buildInfDutCtxFromDetailListIndices,
  buildInfDutCtxFromDrillBarKeys,
} from "../../pcr-ai-report/src/utils/infDutSelection.js";
import { mergeSiteBinPasses } from "../../pcr-ai-report/src/utils/mergeSiteBinPasses.js";

test("buildInfDutCtxFromDetailListIndices groups wafers and requires same device+lot", () => {
  const rows = getInfcontrolLayerBinDummyRows().filter(
    (r) => String(r.PASSTYPE).trim() === "TEST"
  );
  assert.ok(rows.length >= 2);
  const a = rows[0]!;
  const sameLot = rows.find(
    (r) =>
      r !== a &&
      String(r.LOT) === String(a.LOT) &&
      String(r.DEVICE) === String(a.DEVICE)
  );
  assert.ok(sameLot, "JBStart needs two TEST rows with same lot");

  const idxA = rows.indexOf(a);
  const idxB = rows.indexOf(sameLot!);
  const ctx = buildInfDutCtxFromDetailListIndices(
    [idxA, idxB],
    rows as never,
    { source: "detail" }
  );
  assert.ok(ctx);
  assert.equal(ctx!.lot, String(a.LOT).trim());
  assert.equal(ctx!.device, String(a.DEVICE).trim());
  assert.equal(ctx!.wafers.length, 2);

  const otherLot = rows.find(
    (r) => String(r.LOT).trim() !== String(a.LOT).trim()
  );
  if (otherLot) {
    const bad = buildInfDutCtxFromDetailListIndices(
      [idxA, rows.indexOf(otherLot)],
      rows as never,
      { source: "detail" }
    );
    assert.equal(bad, null);
  }
});

test("buildInfDutCtxFromDetailListIndices keeps same slot rows as separate layers", () => {
  const rows = getInfcontrolLayerBinDummyRows().filter(
    (r) => String(r.PASSTYPE).trim() === "TEST"
  );
  const base = rows[0]!;
  const twin = {
    ...base,
    KEYNUMBER: Number(base.KEYNUMBER) + 9001,
    TESTEND: "2099-12-31T00:00:00.000Z",
  };
  const extended = [...rows, twin] as typeof rows;
  const idxA = 0;
  const idxB = extended.length - 1;
  const ctx = buildInfDutCtxFromDetailListIndices(
    [idxA, idxB],
    extended as never,
    { source: "detail" }
  );
  assert.ok(ctx);
  assert.equal(ctx!.wafers.length, 2);
  assert.equal(ctx!.wafers[0]!.slot, ctx!.wafers[1]!.slot);
  assert.notEqual(ctx!.wafers[0]!.keynumber, ctx!.wafers[1]!.keynumber);
});

test("mergeSiteBinPasses matches mergeSiteBinByLotData (report client vs API)", () => {
  const a = buildSiteBinByLotDummyData([1], 1);
  const b = buildSiteBinByLotDummyData([1], 2);
  const server = mergeSiteBinByLotData([a, b]).passes;
  const client = mergeSiteBinPasses([a.passes, b.passes]);
  assert.deepEqual(client, server);
});

test("dummy per-slot infPath scales dieCount; two-slot client merge matches server", () => {
  process.env.NODE_ENV = "test";
  const rows = getInfcontrolLayerBinDummyRows().filter(
    (r) => String(r.PASSTYPE).trim() === "TEST"
  );
  const row = rows[0]!;
  const device = String(row.DEVICE);
  const lot = String(row.LOT);
  const slotA = Number(row.SLOT);
  const slotB =
    rows.find(
      (r) =>
        String(r.LOT) === lot &&
        String(r.DEVICE) === device &&
        Number(r.SLOT) !== slotA
    )?.SLOT ?? slotA + 1;

  const pathA = buildInfPath(device, lot, slotA);
  const pathB = buildInfPath(device, lot, Number(slotB));
  const dataA = tryResolveSiteBinByLotDummy(pathA, [Number(row.PASSID) || 1]);
  const dataB = tryResolveSiteBinByLotDummy(pathB, [Number(row.PASSID) || 1]);
  assert.ok(dataA && dataB);

  const server = mergeSiteBinByLotData([dataA, dataB]).passes;
  const client = mergeSiteBinPasses([dataA.passes, dataB.passes]);
  assert.deepEqual(client, server);

  const bin2 = server[0]?.bins.find((b) => b.bin === "bin2");
  const dut7 = bin2?.duts.find((d) => d.dut === 7);
  assert.ok(dut7);
  assert.equal(dut7.dieCount, 2 * slotA + 2 * Number(slotB));
});

test("buildInfDutCtxFromDrillBarKeys uses query lot and slot subDim", () => {
  const rows = getInfcontrolLayerBinDummyRows();
  const row = rows.find((r) => String(r.PASSTYPE).trim() === "TEST");
  assert.ok(row);
  const lot = String(row!.LOT).trim();
  const slot = Number(row!.SLOT);
  const ctx = buildInfDutCtxFromDrillBarKeys({
    parentDimKey: "lot",
    parentDimVal: lot,
    subDim: "slot",
    selectedKeys: [`Slot ${slot}`],
    drillGroups: [{ key: `Slot ${slot}`, count: 1, parts: { slot: String(slot) } }],
    formLot: lot,
    formDevice: String(row!.DEVICE),
    formPassId: "",
    listRows: rows as never,
    anchor: { source: "lotYield" },
  });
  assert.ok(ctx);
  assert.equal(ctx!.lot, lot);
  assert.ok(ctx!.wafers.some((w) => w.slot === slot));
});
