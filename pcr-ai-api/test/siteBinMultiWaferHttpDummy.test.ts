/**
 * HTTP: multi-wafer site-bin-bylot (Dummy) — mirrors report InfDutDistPanel parallel fetch + merge.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";

import { buildInfPath } from "../src/lib/buildInfPath.js";
import { getInfcontrolLayerBinDummyRows } from "../src/lib/infcontrol/infcontrolLayerBinDummy.js";
import { mergeSiteBinByLotData } from "../src/lib/outputSiteBinByLot/singleWafer.js";
import { mergeSiteBinPasses } from "../../pcr-ai-report/src/utils/mergeSiteBinPasses.js";

describe("site-bin-bylot multi-wafer HTTP (dummy)", () => {
  let baseUrl = "";
  let server: ReturnType<typeof createServer> | undefined;

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.INFCONTROL_LAYER_BINS_DUMMY = "true";

    const { createApp } = await import("../src/app.js");
    const app = createApp();
    await new Promise<void>((resolve, reject) => {
      const s = createServer(app);
      server = s;
      s.listen(0, "127.0.0.1", () => resolve());
      s.on("error", reject);
    });
    const addr = server!.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}/api/v1`;
  });

  after(async () => {
    await new Promise<void>((resolve) => {
      if (server) server.close(() => resolve());
      else resolve();
    });
  });

  test("two infPath fetches merge same as mergeSiteBinByLotData", async () => {
    const row = getInfcontrolLayerBinDummyRows().find(
      (r) => String(r.PASSTYPE).trim() === "TEST"
    );
    assert.ok(row);
    const device = String(row!.DEVICE);
    const lot = String(row!.LOT);
    const passId = String(Number(row!.PASSID) || 1);
    const slotA = Number(row!.SLOT);
    const slotB =
      Number(
        getInfcontrolLayerBinDummyRows().find(
          (r) =>
            String(r.PASSTYPE).trim() === "TEST" &&
            String(r.LOT) === lot &&
            Number(r.SLOT) !== slotA
        )?.SLOT
      ) || slotA + 1;

    async function fetchPasses(infPath: string) {
      const q = new URLSearchParams({ infPath, passId });
      const r = await fetch(`${baseUrl}/inf-analysis/site-bin-bylot?${q}`);
      assert.equal(r.status, 200);
      const body = (await r.json()) as { passes: { passId: number }[] };
      return body.passes;
    }

    const pathA = buildInfPath(device, lot, slotA);
    const pathB = buildInfPath(device, lot, slotB);
    const [passesA, passesB] = await Promise.all([
      fetchPasses(pathA),
      fetchPasses(pathB),
    ]);

    const serverMerged = mergeSiteBinByLotData([
      { passes: passesA },
      { passes: passesB },
    ]).passes;
    const clientMerged = mergeSiteBinPasses([passesA, passesB]);
    assert.deepEqual(clientMerged, serverMerged);
  });
});
