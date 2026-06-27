import test from "node:test";
import assert from "node:assert/strict";
import { buildDutConcentrationInsights, goodBinNumbersFromSiteBinPasses } from "../src/lib/agent/agentDutConcentration.js";
import type { SiteBinPass } from "../src/lib/outputSiteBinByLot.js";

function pass(passId: number, bin: string, duts: Array<[number, number]>): SiteBinPass {
  return { passId, bins: [{ bin, duts: duts.map(([dut, dieCount]) => ({ dut, dieCount })) }] };
}

test("concentrated bad die on few DUTs => probe_card", () => {
  const passes = [pass(1, "bin11", [[3, 45], [7, 40], [1, 5], [2, 5], [4, 5]])];
  const [ins] = buildDutConcentrationInsights(passes, [{ passId: 1, cardIds: ["7804-02"], hasCardChange: false }]);
  assert.equal(ins.bin, 11);
  assert.equal(ins.verdict, "probe_card");
  assert.equal(ins.cardId, "7804-02");
  assert.ok(ins.topShare >= 0.7);
});

test("uniform spread across many DUTs => process", () => {
  const duts = Array.from({ length: 10 }, (_, i) => [i + 1, 10] as [number, number]);
  const [ins] = buildDutConcentrationInsights([pass(1, "bin11", duts)], []);
  assert.equal(ins.verdict, "process");
  assert.equal(ins.cardId, null);
});

test("total below minTotalDie => no insight", () => {
  const out = buildDutConcentrationInsights([pass(1, "bin11", [[1, 3], [2, 2]])], []);
  assert.equal(out.length, 0);
});

test("fewer than 3 DUTs => inconclusive", () => {
  const [ins] = buildDutConcentrationInsights([pass(1, "bin11", [[1, 6], [2, 5]])], []);
  assert.equal(ins.verdict, "inconclusive");
});

test("goodBins excludes passing bins from concentration table", () => {
  const passes = [
    {
      passId: 1,
      bins: [
        { bin: "bin1", duts: Array.from({ length: 78 }, (_, i) => ({ dut: i + 1, dieCount: 2000 })) },
        { bin: "bin79", duts: [{ dut: 1, dieCount: 90 }, { dut: 2, dieCount: 10 }] },
      ],
    },
  ];
  const goodBins = goodBinNumbersFromSiteBinPasses(passes);
  assert.ok(goodBins.has(1));
  const out = buildDutConcentrationInsights(passes, [], { goodBins, focusBins: [79] });
  assert.equal(out.length, 1);
  assert.equal(out[0]?.bin, 79);
});

test("focusBins limits which bins are analyzed", () => {
  const passes = [{ passId: 1, bins: [
    { bin: "bin11", duts: [{ dut: 1, dieCount: 90 }, { dut: 2, dieCount: 10 }] },
    { bin: "bin66", duts: [{ dut: 1, dieCount: 90 }, { dut: 2, dieCount: 10 }] },
  ] }];
  const out = buildDutConcentrationInsights(passes, [], { focusBins: [11] });
  assert.equal(out.length, 1);
  assert.equal(out[0].bin, 11);
});

test("markdown renders verdict labels and hides internal identifiers", async (t) => {
  const { formatDutConcentrationMarkdown } = await import("../src/lib/agent/agentDutConcentration.js");
  const md = formatDutConcentrationMarkdown([
    { bin: 11, passId: 1, sortLabel: "pass1", cardId: "7804-02", totalDie: 100,
      topDuts: [{ dut: 3, dieCount: 45, share: 0.45 }], topShare: 0.9, verdict: "probe_card", detail: "x" },
  ]);
  assert.ok(md.includes("BIN11"));
  assert.ok(md.includes("疑探针卡"));
  for (const id of ["cardByPassId", "query_lot_dut_bin_agg", "Markdown", "topShare"]) {
    assert.ok(!md.includes(id), `markdown 不应含内部标识符 ${id}`);
  }
});

test("empty insights => empty string", async (t) => {
  const { formatDutConcentrationMarkdown, DUT_CONCENTRATION_GUIDE } = await import("../src/lib/agent/agentDutConcentration.js");
  assert.equal(formatDutConcentrationMarkdown([]), "");
  assert.ok(DUT_CONCENTRATION_GUIDE.length > 0);
});
