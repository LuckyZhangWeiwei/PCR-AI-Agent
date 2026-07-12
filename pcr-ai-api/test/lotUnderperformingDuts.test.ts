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
  resolvePassIdsForDutAnalysis,
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

  test("resolveGoodBinsForPass falls back to {BIN1} when goodBinsByPassId lacks this passId entirely", () => {
    // 边界情况：goodBinsByPassId 这个 Map 本身存在，但完全没有当前 passId 的 key
    // （例如 JB 行查询没覆盖到这个 pass）。修复前会退回 INF 启发式（goodBinNumbersFromSiteBinPasses，
    // >100 avg/DUT 绝对阈值），单 lot 小 die 量场景下必然返回空集合、良率恒为 0%。
    // 修复后应直接兜底为 {HARD_GOOD_BIN}（=1），不再依赖已被证实有缺陷的启发式。
    const p = pass(1, [
      { bin: "bin1", duts: [{ dut: 1, dieCount: 20 }, { dut: 2, dieCount: 20 }] },
      { bin: "bin11", duts: [{ dut: 1, dieCount: 5 }, { dut: 2, dieCount: 5 }] },
    ]);
    const result = computeUnderperformingDutsForPass(p, {
      goodBinsByPassId: new Map(), // passId 1 不在其中
    });
    assert.ok(result.baseline, "baseline must not be null — BIN1 must be recognized as good");
    assert.equal(result.baseline!.yieldPct, 80);
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

  // 有意的取舍（2026-07-05）：曾经这道门槛专门防 NF12595.1A 那次历史 bug（PASSBIN 为空、
  // 真实良品 bin 非 BIN1 时误判）。现已移除——单 lot 场景下 INF 启发式回退本身被证实
  // 在小 die 量场景下必然失效（>100 avg/DUT 绝对阈值不适用于单 lot 每 DUT 仅几十颗 die
  // 的情况），与其保留"防旧 bug 但制造新 bug"的门槛，不如直接信任 JB 权威字段 PASSBIN。
  // 该取舍已与用户确认；若 PASSBIN 为空且真实良品 bin 非 BIN1，仍会误判为 0% 良率，
  // 需要另外的信号源解决，不在此次修复范围内。
  test("passId is always included once it has JB rows, even with no signal beyond BIN1", () => {
    const map = buildGoodBinsByPassFromJbRows([
      { PASSID: 1, PASSBIN: null },
      { PASSID: 1, PASSBIN: "" },
      { PASSID: 3, PASSBIN: "1-55" },
    ]);
    assert.deepEqual([...map.get(1)!].sort((a, b) => a - b), [1]);
    assert.deepEqual([...map.get(3)!].sort((a, b) => a - b), [1, 55]);
  });

  test("single-lot small-die-count scenario: PASSBIN gives only BIN1, goodBins is {1} not empty", () => {
    // 复现 WA01N39W/DR41803.1Y 场景：每 DUT total die 数远低于 100（旧 INF 启发式的
    // 绝对阈值），PASSBIN 只解析出 BIN1（无「额外」信号）。修复前 map 会缺失该 passId，
    // resolveGoodBinsForPass 退回 INF 启发式，>100 绝对阈值在此规模下必然返回空集合，
    // 导致良品 bin 判定为空、良率恒为 0%。
    const map = buildGoodBinsByPassFromJbRows([
      { PASSID: 1, PASSBIN: "1" },
      { PASSID: 1, PASSBIN: "1" },
    ]);
    assert.ok(map.has(1), "passId 1 must be present even though PASSBIN only ever said BIN1");
    assert.deepEqual([...map.get(1)!], [1]);
  });

  test("agent-formatted rows with goodBins array (BIN250) are recognized", () => {
    const map = buildGoodBinsByPassFromJbRows([
      { PASSID: 1, goodBins: [{ bin: 250, dieCount: 6213, isGoodBin: true }] },
    ]);
    assert.deepEqual([...map.get(1)!].sort((a, b) => a - b), [1, 250]);
  });

  test("BIN250 goodBinsByPassId yields non-zero lot yield (WA01N39W-style)", () => {
    const p = pass(1, [
      { bin: "bin250", duts: [{ dut: 0, dieCount: 20 }, { dut: 1, dieCount: 18 }] },
      { bin: "bin7", duts: [{ dut: 0, dieCount: 2 }, { dut: 1, dieCount: 2 }] },
    ]);
    const with250 = computeUnderperformingDutsForPass(p, {
      goodBinsByPassId: new Map([[1, new Set([250])]]),
    });
    assert.ok((with250.baseline?.yieldPct ?? 0) > 0, "BIN250 must count as good die");
    const bin1Only = computeUnderperformingDutsForPass(p, {
      goodBinsByPassId: new Map([[1, new Set([1])]]),
    });
    assert.equal(bin1Only.baseline?.yieldPct, 0);
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

test("resolvePassIdsForDutAnalysis: passIdsPresent overrides default 1/3/5", () => {
  assert.deepEqual(resolvePassIdsForDutAnalysis(undefined, { passIdsPresent: [1, 3, 4] }), [
    1, 3, 4,
  ]);
  assert.deepEqual(resolvePassIdsForDutAnalysis([3, 1]), [1, 3]);
  assert.deepEqual(resolvePassIdsForDutAnalysis(), [1, 3, 5]);
});
