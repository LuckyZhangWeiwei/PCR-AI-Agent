import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  OutputSiteBinByLotValidationError,
  mergeSiteBinByLotData,
  parsePassIdsFromQuery,
  parseSiteBinByLotJson,
  validateInfPath,
} from "../src/lib/outputSiteBinByLot.js";
import { buildInfLotDir } from "../src/lib/buildInfPath.js";
import { getInfcontrolLayerBinDummyRows } from "../src/lib/infcontrolLayerBinDummy.js";
import {
  parseSiteBinDeviceTopN,
  SITE_BIN_DEVICE_TOP_LOTS_DEFAULT,
  SITE_BIN_DEVICE_TOP_LOTS_MAX,
} from "../src/lib/siteBinByLotDeviceTopN.js";
import { parseSiteBinByLotTestEndWindow } from "../src/lib/siteBinByLotTestEndWindow.js";
import {
  cardIdMatchesProbeCardType,
  probeCardTypeFromCardId,
  resolveSiteBinWafersFromDummy,
} from "../src/lib/siteBinByLotWaferResolve.js";
import {
  buildSiteBinByLotDummyData,
  infPathMatchesSiteBinByLotDummy,
  SITE_BIN_BY_LOT_DUMMY_CANONICAL_INF_PATH,
  siteBinByLotDummyPathAllowed,
  tryResolveSiteBinByLotDummy,
  tryResolveSiteBinByLotDummyForLot,
} from "../src/lib/outputSiteBinByLotDummy.js";

describe("outputSiteBinByLot validation", () => {
  test("validateInfPath rejects empty", () => {
    assert.throws(
      () => validateInfPath("  "),
      (e) => e instanceof OutputSiteBinByLotValidationError
    );
  });

  test("validateInfPath accepts normal path", () => {
    assert.equal(validateInfPath("/data/lot/foo.inf"), "/data/lot/foo.inf");
  });

  test("parsePassIdsFromQuery splits comma and repeats", () => {
    assert.deepEqual(parsePassIdsFromQuery(["1, 2", "3"]), [1, 2, 3]);
  });

  test("parseSiteBinDeviceTopN defaults and caps", () => {
    assert.equal(parseSiteBinDeviceTopN(undefined), SITE_BIN_DEVICE_TOP_LOTS_DEFAULT);
    assert.equal(parseSiteBinDeviceTopN("25"), 25);
    assert.throws(
      () => parseSiteBinDeviceTopN(String(SITE_BIN_DEVICE_TOP_LOTS_MAX + 1)),
      (e) => e instanceof OutputSiteBinByLotValidationError
    );
  });

  test("parsePassIdsFromQuery rejects non-integer", () => {
    assert.throws(
      () => parsePassIdsFromQuery("1.5"),
      (e) => e instanceof OutputSiteBinByLotValidationError
    );
  });

  test("mergeSiteBinByLotData sums dieCount per pass bin dut", () => {
    const a = parseSiteBinByLotJson(
      JSON.stringify({
        passes: [
          {
            passId: 1,
            bins: [{ bin: "bin2", duts: [{ dut: 7, dieCount: 2 }] }],
          },
        ],
      })
    );
    const b = parseSiteBinByLotJson(
      JSON.stringify({
        passes: [
          {
            passId: 1,
            bins: [
              { bin: "bin2", duts: [{ dut: 7, dieCount: 3 }, { dut: 8, dieCount: 1 }] },
              { bin: "bin55", duts: [{ dut: 1, dieCount: 10 }] },
            ],
          },
        ],
      })
    );
    const merged = mergeSiteBinByLotData([a, b]);
    assert.equal(merged.passes.length, 1);
    const bin2 = merged.passes[0].bins.find((x) => x.bin === "bin2");
    assert.ok(bin2);
    assert.deepEqual(
      bin2!.duts.sort((x, y) => Number(x.dut) - Number(y.dut)),
      [
        { dut: 7, dieCount: 5 },
        { dut: 8, dieCount: 1 },
      ]
    );
    const bin55 = merged.passes[0].bins.find((x) => x.bin === "bin55");
    assert.equal(bin55?.duts[0].dieCount, 10);
  });

  test("parseSiteBinByLotJson maps passes bins duts", () => {
    const data = parseSiteBinByLotJson(
      JSON.stringify({
        passes: [
          {
            passId: 1,
            bins: [
              {
                bin: "bin2",
                duts: [
                  { dut: 7, dieCount: 2 },
                  { dut: "single", dieCount: 1 },
                ],
              },
            ],
          },
        ],
      })
    );
    assert.equal(data.passes.length, 1);
    assert.equal(data.passes[0].passId, 1);
    assert.equal(data.passes[0].bins[0].bin, "bin2");
    assert.deepEqual(data.passes[0].bins[0].duts, [
      { dut: 7, dieCount: 2 },
      { dut: "single", dieCount: 1 },
    ]);
  });
});

describe("site-bin-bylot dummy", () => {
  test("canonical infPath matches", () => {
    assert.equal(
      infPathMatchesSiteBinByLotDummy(SITE_BIN_BY_LOT_DUMMY_CANONICAL_INF_PATH),
      true
    );
    assert.equal(infPathMatchesSiteBinByLotDummy("/other/path"), false);
  });

  test("buildSiteBinByLotDummyData returns pass 1 with bin2 and bin55", () => {
    const data = buildSiteBinByLotDummyData([1, 2]);
    assert.equal(data.passes.length, 1);
    assert.equal(data.passes[0].passId, 1);
    const bins = new Set(data.passes[0].bins.map((b) => b.bin));
    assert.ok(bins.has("bin2"));
    assert.ok(bins.has("bin55"));
    const bin55 = data.passes[0].bins.find((b) => b.bin === "bin55");
    assert.ok(bin55 && bin55.duts.length >= 70);
  });

  test("cardIdMatchesProbeCardType uses leading segment", () => {
    assert.equal(cardIdMatchesProbeCardType("9400-01", "9400"), true);
    assert.equal(cardIdMatchesProbeCardType("9400", "9400"), true);
    assert.equal(cardIdMatchesProbeCardType("8037-02", "9400"), false);
    assert.equal(probeCardTypeFromCardId("9400-01"), "9400");
  });

  test("resolveSiteBinWafersFromDummy dedupes by lot+slot for probeCardType", () => {
    process.env.NODE_ENV = "test";
    const testEndWindow = parseSiteBinByLotTestEndWindow({});
    const row = getInfcontrolLayerBinDummyRows().find(
      (r) => String(r.PASSTYPE).trim() === "TEST"
    );
    assert.ok(row);
    const pct = probeCardTypeFromCardId(row!.CARDID);
    assert.ok(pct);
    const wafers = resolveSiteBinWafersFromDummy({
      device: String(row!.DEVICE),
      lot: String(row!.LOT),
      probeCardType: pct!,
      passIds: [Number(row!.PASSID)],
      testEndWindow,
    });
    assert.ok(wafers.length >= 1);
    assert.ok(wafers.some((w) => w.slot === Number(row!.SLOT)));
  });

  test("tryResolveSiteBinByLotDummyForLot merges JB wafers under NODE_ENV=test", () => {
    process.env.NODE_ENV = "test";
    const testEndWindow = parseSiteBinByLotTestEndWindow({});
    const row = getInfcontrolLayerBinDummyRows().find(
      (r) => String(r.PASSTYPE).trim() === "TEST"
    );
    assert.ok(row);
    const device = String(row!.DEVICE);
    const lot = String(row!.LOT);
    const pct = probeCardTypeFromCardId(row!.CARDID)!;
    const passId = Number(row!.PASSID);
    const data = tryResolveSiteBinByLotDummyForLot(
      device,
      lot,
      pct,
      [passId],
      testEndWindow
    );
    assert.ok(data);
    const expectedWafers = resolveSiteBinWafersFromDummy({
      device,
      lot,
      probeCardType: pct,
      passIds: [passId],
      testEndWindow,
    });
    assert.equal(data.waferCount, expectedWafers.length);
    assert.equal(data.probeCardType, pct);
    assert.equal(data.lotDir, buildInfLotDir(device, lot));
    const bin2 = data.passes[0]?.bins.find((b) => b.bin === "bin2");
    if (bin2) {
      const dut7 = bin2.duts.find((d) => d.dut === 7);
      if (dut7) assert.equal(dut7.dieCount, 2 * expectedWafers.length);
    }
  });

  test("tryResolveSiteBinByLotDummy under NODE_ENV=test", () => {
    process.env.NODE_ENV = "test";
    const data = tryResolveSiteBinByLotDummy(
      SITE_BIN_BY_LOT_DUMMY_CANONICAL_INF_PATH,
      [1]
    );
    assert.ok(data);
    assert.equal(data.passes[0].bins[0].bin, "bin2");
  });

  test("siteBinByLotDummyPathAllowed with INFCONTROL_LAYER_BINS_DUMMY accepts buildInfPath", () => {
    const origNode = process.env.NODE_ENV;
    const origJb = process.env.INFCONTROL_LAYER_BINS_DUMMY;
    const origSite = process.env.SITE_BIN_BY_LOT_DUMMY;
    try {
      process.env.NODE_ENV = "development";
      process.env.INFCONTROL_LAYER_BINS_DUMMY = "true";
      delete process.env.SITE_BIN_BY_LOT_DUMMY;
      assert.equal(
        siteBinByLotDummyPathAllowed("/data/INF/WB10N57U/NF12615.1X/r_1-5"),
        true
      );
      assert.equal(
        tryResolveSiteBinByLotDummy("/data/INF/WB10N57U/NF12615.1X/r_1-5", [1])
          ?.passes[0]?.passId,
        1
      );
    } finally {
      if (origNode === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = origNode;
      if (origJb === undefined) delete process.env.INFCONTROL_LAYER_BINS_DUMMY;
      else process.env.INFCONTROL_LAYER_BINS_DUMMY = origJb;
      if (origSite === undefined) delete process.env.SITE_BIN_BY_LOT_DUMMY;
      else process.env.SITE_BIN_BY_LOT_DUMMY = origSite;
    }
  });
});

describe("GET /inf-analysis/site-bin-bylot route", () => {
  test("400 when infPath or passId missing", async () => {
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
    const base = `http://127.0.0.1:${addr.port}/api/v1`;

    const r1 = await fetch(`${base}/inf-analysis/site-bin-bylot`);
    assert.equal(r1.status, 400);
    const b1 = (await r1.json()) as { code: string };
    assert.equal(b1.code, "VALIDATION_ERROR");

    const r2 = await fetch(
      `${base}/inf-analysis/site-bin-bylot?infPath=/tmp/x.inf`
    );
    assert.equal(r2.status, 400);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("200 with dummy sample when NODE_ENV=test and canonical infPath", async () => {
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
    const base = `http://127.0.0.1:${addr.port}/api/v1`;
    const q = new URLSearchParams({
      infPath: SITE_BIN_BY_LOT_DUMMY_CANONICAL_INF_PATH,
      passId: "1",
    });
    q.append("passId", "2");

    const r = await fetch(`${base}/inf-analysis/site-bin-bylot?${q}`);
    assert.equal(r.status, 200);
    const body = (await r.json()) as {
      infPath: string;
      passIds: number[];
      passes: { passId: number; bins: { bin: string }[] }[];
    };
    assert.equal(body.infPath, SITE_BIN_BY_LOT_DUMMY_CANONICAL_INF_PATH);
    assert.deepEqual(body.passIds, [1, 2]);
    assert.equal(body.passes.length, 1);
    assert.equal(body.passes[0].passId, 1);
    assert.ok(body.passes[0].bins.some((b) => b.bin === "bin55"));

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("200 dummy keynumber returns layer-scaled dieCount", async () => {
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
    const base = `http://127.0.0.1:${addr.port}/api/v1`;
    const q1 = new URLSearchParams({
      infPath: SITE_BIN_BY_LOT_DUMMY_CANONICAL_INF_PATH,
      passId: "1",
      keynumber: "1001",
    });
    const q2 = new URLSearchParams({
      infPath: SITE_BIN_BY_LOT_DUMMY_CANONICAL_INF_PATH,
      passId: "1",
      keynumber: "1002",
    });

    const r1 = await fetch(`${base}/inf-analysis/site-bin-bylot?${q1}`);
    const r2 = await fetch(`${base}/inf-analysis/site-bin-bylot?${q2}`);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    const b1 = (await r1.json()) as {
      keynumber: number;
      passes: { bins: { duts: { dieCount: number }[] }[] }[];
    };
    const b2 = (await r2.json()) as {
      passes: { bins: { duts: { dieCount: number }[] }[] }[];
    };
    assert.equal(b1.keynumber, 1001);
    const die1 = b1.passes[0]?.bins[0]?.duts[0]?.dieCount ?? 0;
    const die2 = b2.passes[0]?.bins[0]?.duts[0]?.dieCount ?? 0;
    assert.ok(die1 > 0 && die2 > 0);
    assert.notEqual(die1, die2);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("200 dummy testEnd returns layer-scaled dieCount", async () => {
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
    const base = `http://127.0.0.1:${addr.port}/api/v1`;
    const q1 = new URLSearchParams({
      infPath: SITE_BIN_BY_LOT_DUMMY_CANONICAL_INF_PATH,
      passId: "1",
      testEnd: "2026-07-12T14:31:42.000Z",
    });
    const q2 = new URLSearchParams({
      infPath: SITE_BIN_BY_LOT_DUMMY_CANONICAL_INF_PATH,
      passId: "1",
      testEnd: "2026-07-12T18:20:30.000Z",
    });

    const r1 = await fetch(`${base}/inf-analysis/site-bin-bylot?${q1}`);
    const r2 = await fetch(`${base}/inf-analysis/site-bin-bylot?${q2}`);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    const b1 = (await r1.json()) as {
      passes: { bins: { duts: { dieCount: number }[] }[] }[];
    };
    const b2 = (await r2.json()) as {
      passes: { bins: { duts: { dieCount: number }[] }[] }[];
    };
    const die1 = b1.passes[0]?.bins[0]?.duts[0]?.dieCount ?? 0;
    const die2 = b2.passes[0]?.bins[0]?.duts[0]?.dieCount ?? 0;
    assert.ok(die1 > 0 && die2 > 0);
    assert.notEqual(die1, die2);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("200 legacy lot aggregation without probeCardType (directory scan)", async () => {
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
    const base = `http://127.0.0.1:${addr.port}/api/v1`;
    const q = new URLSearchParams({
      device: "WA03P02G",
      lot: "NF12551.1N",
      passId: "1",
    });

    const r = await fetch(`${base}/inf-analysis/site-bin-bylot?${q}`);
    assert.equal(r.status, 200);
    const body = (await r.json()) as {
      meta: { aggregateScope?: string };
      waferCount: number;
      probeCardType?: string;
    };
    assert.equal(body.meta.aggregateScope, "lot");
    assert.equal(body.waferCount, 3);
    assert.equal(body.probeCardType, undefined);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("200 lot aggregation with probeCardType (JB filter)", async () => {
    process.env.NODE_ENV = "test";
    const row = getInfcontrolLayerBinDummyRows().find(
      (r) => String(r.PASSTYPE).trim() === "TEST"
    );
    assert.ok(row);
    const pct = probeCardTypeFromCardId(row!.CARDID)!;

    const { createApp } = await import("../src/app.js");
    const { createServer } = await import("node:http");
    const app = createApp();
    const server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => resolve());
      server.on("error", reject);
    });
    const addr = server.address() as import("node:net").AddressInfo;
    const base = `http://127.0.0.1:${addr.port}/api/v1`;

    const rNoPass = await fetch(
      `${base}/inf-analysis/site-bin-bylot?device=X`
    );
    assert.equal(rNoPass.status, 400);

    const q = new URLSearchParams({
      device: String(row!.DEVICE),
      lot: String(row!.LOT),
      probeCardType: pct,
      passId: String(row!.PASSID),
    });
    const r = await fetch(`${base}/inf-analysis/site-bin-bylot?${q}`);
    assert.equal(r.status, 200);
    const body = (await r.json()) as {
      meta: { aggregateScope?: string };
      probeCardType: string;
      waferCount: number;
    };
    assert.equal(body.meta.aggregateScope, "lot");
    assert.equal(body.probeCardType, pct);
    assert.ok(body.waferCount >= 1);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("200 device aggregation with only device and passId", async () => {
    process.env.NODE_ENV = "test";
    const row = getInfcontrolLayerBinDummyRows().find(
      (r) => String(r.PASSTYPE).trim() === "TEST"
    );
    assert.ok(row);

    const { createApp } = await import("../src/app.js");
    const { createServer } = await import("node:http");
    const app = createApp();
    const server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => resolve());
      server.on("error", reject);
    });
    const addr = server.address() as import("node:net").AddressInfo;
    const base = `http://127.0.0.1:${addr.port}/api/v1`;
    const q = new URLSearchParams({
      device: String(row!.DEVICE),
      passId: String(row!.PASSID),
    });

    const r = await fetch(`${base}/inf-analysis/site-bin-bylot?${q}`);
    assert.equal(r.status, 200);
    const body = (await r.json()) as {
      meta: { aggregateScope?: string };
      probeCardType: string;
      topN: number;
      selectedLots: string[];
      waferLots?: string[];
    };
    assert.equal(body.meta.aggregateScope, "device");
    assert.ok(body.probeCardType.length > 0);
    assert.equal(body.topN, SITE_BIN_DEVICE_TOP_LOTS_DEFAULT);
    assert.ok(body.selectedLots.length >= 1);
    assert.ok(body.waferLots && body.waferLots.length >= 1);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("400 when device+lot combined with infPath", async () => {
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
    const base = `http://127.0.0.1:${addr.port}/api/v1`;
    const q = new URLSearchParams({
      device: "D",
      lot: "L",
      probeCardType: "9400",
      infPath: "/data/INF/D/L/r_1-1",
      passId: "1",
    });
    const r = await fetch(`${base}/inf-analysis/site-bin-bylot?${q}`);
    assert.equal(r.status, 400);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("POST layers batch merges dummy passes in one request", async () => {
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
    const base = `http://127.0.0.1:${addr.port}/api/v1`;
    const r = await fetch(`${base}/inf-analysis/site-bin-bylot/layers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        layers: [
          {
            infPath: SITE_BIN_BY_LOT_DUMMY_CANONICAL_INF_PATH,
            device: "WA03P02G",
            passIds: [1],
          },
          {
            infPath: SITE_BIN_BY_LOT_DUMMY_CANONICAL_INF_PATH,
            device: "WA03P02G",
            passIds: [1],
            keynumber: 2,
            testEnd: "2099-01-01T00:00:00.000Z",
          },
        ],
      }),
    });
    assert.equal(r.status, 200);
    const body = (await r.json()) as {
      layerCount: number;
      layers: { passes: { bins: { duts: { dieCount: number }[] }[] }[] }[];
      passes: { bins: { duts: { dieCount: number }[] }[] }[];
    };
    assert.equal(body.layerCount, 2);
    assert.equal(body.layers.length, 2);
    assert.ok(body.passes.length > 0);
    const mergedDie = body.passes[0]!.bins.reduce(
      (s, b) => s + b.duts.reduce((t, d) => t + d.dieCount, 0),
      0
    );
    const sumLayers = body.layers.reduce((acc, layer) => {
      const p = layer.passes[0];
      if (!p) return acc;
      return (
        acc +
        p.bins.reduce(
          (s, b) => s + b.duts.reduce((t, d) => t + d.dieCount, 0),
          0
        )
      );
    }, 0);
    assert.equal(mergedDie, sumLayers);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
