import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  computeUnderperformingDutsForPass,
  computeUnderperformingDutsForPasses,
  DEFAULT_UNDERPERFORMING_THRESHOLD_RATIO,
  parseUnderperformingThresholdRatio,
} from "../src/lib/lotUnderperformingDuts.js";
import { OutputSiteBinByLotValidationError } from "../src/lib/outputSiteBinByLot.js";
import type { SiteBinPass } from "../src/lib/outputSiteBinByLot.js";
import {
  resolveDeviceForLot,
  resolveProbeCardTypeForLot,
  buildGoodBinsByPassFromJbRows,
} from "../src/lib/lotUnderperformingDutsResolve.js";

function pass(passId: number, bins: SiteBinPass["bins"]): SiteBinPass {
  return { passId, bins };
}

describe("lotUnderperformingDuts compute", () => {
  test("flags DUT below lotOverall × thresholdRatio", () => {
    const p = pass(1, [
      {
        bin: "bin1",
        duts: [
          { dut: 1, dieCount: 900 },
          { dut: 2, dieCount: 900 },
          { dut: 3, dieCount: 500 },
        ],
      },
      {
        bin: "bin11",
        duts: [
          { dut: 1, dieCount: 100 },
          { dut: 2, dieCount: 100 },
          { dut: 3, dieCount: 500 },
        ],
      },
    ]);

    const result = computeUnderperformingDutsForPass(p, {
      thresholdRatio: DEFAULT_UNDERPERFORMING_THRESHOLD_RATIO,
      goodBins: new Set([1]),
    });

    assert.ok(result.baseline);
    assert.equal(result.baseline!.method, "lotOverall");
    assert.equal(result.baseline!.yieldPct, 76.67);
    assert.equal(result.baseline!.thresholdPct, 57.5);
    assert.equal(result.lotGoodDie, 2300);
    assert.equal(result.lotTotalDie, 3000);
    assert.equal(result.underperformingDuts.length, 1);
    assert.equal(result.underperformingDuts[0]!.dut, 3);
    assert.equal(result.underperformingDuts[0]!.yieldPct, 50);
  });

  test("lotOverall differs from dutMean when DUT totals differ", () => {
    const p = pass(1, [
      { bin: "bin1", duts: [{ dut: 1, dieCount: 100 }, { dut: 2, dieCount: 900 }] },
      { bin: "bin11", duts: [{ dut: 1, dieCount: 0 }, { dut: 2, dieCount: 100 }] },
    ]);
    const result = computeUnderperformingDutsForPass(p, {
      thresholdRatio: 0.75,
      goodBins: new Set([1]),
    });
    assert.equal(result.baseline!.method, "lotOverall");
    assert.equal(result.baseline!.yieldPct, 90.91);
    assert.equal(result.allDuts[0]!.yieldPct, 100);
    assert.equal(result.allDuts[1]!.yieldPct, 90);
    assert.equal(result.underperformingDuts.length, 0);
  });

  test("returns empty baseline when pass has no die", () => {
    const p = pass(1, []);
    const result = computeUnderperformingDutsForPass(p, { goodBins: new Set([1]) });
    assert.equal(result.baseline, null);
    assert.deepEqual(result.underperformingDuts, []);
  });

  test("computeUnderperformingDutsForPasses preserves pass order", () => {
    const passes = [
      pass(1, [{ bin: "bin1", duts: [{ dut: 1, dieCount: 200 }] }]),
      pass(3, [{ bin: "bin1", duts: [{ dut: 2, dieCount: 200 }] }]),
    ];
    const out = computeUnderperformingDutsForPasses(passes, { goodBins: new Set([1]) });
    assert.equal(out.length, 2);
    assert.equal(out[0]!.passId, 1);
    assert.equal(out[1]!.passId, 3);
  });

  test("goodBinsByPassId: BIN55 good die counts when BIN1 empty (NF12499-style pass1)", () => {
    const p = pass(1, [
      { bin: "bin55", duts: [{ dut: 1, dieCount: 100 }, { dut: 2, dieCount: 100 }] },
      { bin: "bin11", duts: [{ dut: 1, dieCount: 10 }, { dut: 2, dieCount: 10 }] },
    ]);
    const onlyBin1 = computeUnderperformingDutsForPass(p, { goodBins: new Set([1]) });
    assert.equal(onlyBin1.baseline!.yieldPct, 0);

    const with55 = computeUnderperformingDutsForPass(p, {
      goodBinsByPassId: new Map([[1, new Set([1, 55])]]),
    });
    assert.equal(with55.baseline!.yieldPct, 90.91);
  });
});

describe("lotUnderperformingDuts parse", () => {
  test("parseUnderperformingThresholdRatio defaults and validates", () => {
    assert.equal(parseUnderperformingThresholdRatio(undefined), 0.75);
    assert.equal(parseUnderperformingThresholdRatio("0.8"), 0.8);
    assert.throws(
      () => parseUnderperformingThresholdRatio("1.2"),
      (e) => e instanceof OutputSiteBinByLotValidationError
    );
  });
});

describe("resolveDeviceForLot dummy", () => {
  test("resolves device from JB dummy rows", async () => {
    process.env.NODE_ENV = "test";
    const device = await resolveDeviceForLot("DR43782.1A");
    assert.equal(device, "WA10P29E");
  });
});

describe("resolveProbeCardTypeForLot dummy", () => {
  test("resolves dominant probe card type for lot", async () => {
    process.env.NODE_ENV = "test";
    const pct = await resolveProbeCardTypeForLot("WA10P29E", "DR43782.1A", [1, 3, 5]);
    assert.ok(typeof pct === "string" && pct.length > 0);
  });
});

describe("buildGoodBinsByPassFromJbRows", () => {
  test("merges PASSBIN segments per passId", () => {
    const map = buildGoodBinsByPassFromJbRows([
      { PASSID: 1, PASSBIN: "1-55" },
      { PASSID: 3, PASSBIN: "1" },
    ]);
    assert.deepEqual([...map.get(1)!].sort((a, b) => a - b), [1, 55]);
    assert.deepEqual([...map.get(3)!].sort((a, b) => a - b), [1]);
  });
});

describe("GET /inf-analysis/lot-underperforming-duts route", () => {
  test("400 when lot missing", async () => {
    process.env.NODE_ENV = "test";
    const { createApp } = await import("../src/app.js");
    const { createServer } = await import("node:http");
    const app = createApp();
    const server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => resolve());
      server.on("error", reject);
    });
    const addr = server.address() as import("node:net").AddressInfo;
    const base = `http://127.0.0.1:${addr.port}/api/v4`;

    const r = await fetch(`${base}/inf-analysis/lot-underperforming-duts`);
    assert.equal(r.status, 400);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("200 with lot only resolves device and probeCardType from JB", async () => {
    process.env.NODE_ENV = "test";
    process.env.INFCONTROL_LAYER_BINS_DUMMY = "true";
    const { createApp } = await import("../src/app.js");
    const { createServer } = await import("node:http");
    const app = createApp();
    const server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => resolve());
      server.on("error", reject);
    });
    const addr = server.address() as import("node:net").AddressInfo;
    const base = `http://127.0.0.1:${addr.port}/api/v4`;
    const q = new URLSearchParams({ lot: "DR43782.1A", passId: "1" });

    const r = await fetch(`${base}/inf-analysis/lot-underperforming-duts?${q}`);
    const text = await r.text();
    assert.equal(r.status, 200, text);
    const body = JSON.parse(text) as {
      meta: { apiVersion: string; aggregateScope: string };
      device: string;
      lot: string;
      probeCardType: string;
      deviceResolvedFromJb?: boolean;
      probeCardTypeResolvedFromJb?: boolean;
      filters: { baselineMethod: string; thresholdRatio: number };
      passes: unknown[];
    };
    assert.equal(body.meta.apiVersion, "4");
    assert.equal(body.device, "WA10P29E");
    assert.equal(body.lot, "DR43782.1A");
    assert.equal(body.deviceResolvedFromJb, true);
    assert.equal(body.probeCardTypeResolvedFromJb, true);
    assert.equal(body.filters.baselineMethod, "lotOverall");
    assert.equal(body.filters.thresholdRatio, 0.75);
    assert.ok(Array.isArray(body.passes));

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
