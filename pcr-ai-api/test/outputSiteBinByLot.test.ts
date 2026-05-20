import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  OutputSiteBinByLotValidationError,
  parsePassIdsFromQuery,
  parseSiteBinByLotJson,
  validateInfPath,
} from "../src/lib/outputSiteBinByLot.js";
import {
  buildSiteBinByLotDummyData,
  infPathMatchesSiteBinByLotDummy,
  SITE_BIN_BY_LOT_DUMMY_CANONICAL_INF_PATH,
  tryResolveSiteBinByLotDummy,
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

  test("parsePassIdsFromQuery rejects non-integer", () => {
    assert.throws(
      () => parsePassIdsFromQuery("1.5"),
      (e) => e instanceof OutputSiteBinByLotValidationError
    );
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

  test("tryResolveSiteBinByLotDummy under NODE_ENV=test", () => {
    process.env.NODE_ENV = "test";
    const data = tryResolveSiteBinByLotDummy(
      SITE_BIN_BY_LOT_DUMMY_CANONICAL_INF_PATH,
      [1]
    );
    assert.ok(data);
    assert.equal(data.passes[0].bins[0].bin, "bin2");
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
});
