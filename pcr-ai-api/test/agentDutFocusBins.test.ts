/**
 * DUT focus bad-BIN 反查：截断假阴性修复 + 问句分类。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFocusDutBinsMarkdown,
  ensureFocusDutInCompactedDuts,
  extractFocusDutBins,
  isDutFocusBadBinQuestion,
  parseFocusDutBinsFromToolResult,
} from "../src/lib/agent/agentDutFocusBins.js";
import { compactSiteBinPasses } from "../src/lib/agent/tools/agentToolDutBinAgg.js";
import {
  detectJbReplyMode,
  isBadBinRankingQuestion,
} from "../src/lib/agent/jb/agentJbQuestionClassifiers.js";
import type { SiteBinPass } from "../src/lib/outputSiteBinByLot/types.js";
import { runTool, truncateResult } from "../src/lib/agent/tools/agentToolHandlers.js";

process.env["SITE_BIN_BY_LOT_DUMMY"] = "true";
process.env["NODE_ENV"] = "test";

test("isDutFocusBadBinQuestion matches wafer+DUT bad-bin questions", () => {
  assert.ok(
    isDutFocusBadBinQuestion("第七片 wafer pass1的测试 中 dut12 测出的哪个坏bin最多")
  );
  assert.ok(
    isDutFocusBadBinQuestion("第一片中 pass1 中dut12 都测试出了什么坏bin")
  );
  assert.ok(
    isDutFocusBadBinQuestion("NF13607.1R 第7片 pass1 DUT12 哪个坏bin最多")
  );
});

test("isDutFocusBadBinQuestion rejects non-DUT or non-bad-bin asks", () => {
  assert.equal(isDutFocusBadBinQuestion("第七片 wafer pass1 哪个坏bin最多"), false);
  assert.equal(isDutFocusBadBinQuestion("哪个 DUT 坏 bin 最多"), false);
  assert.equal(isDutFocusBadBinQuestion("DUT12 的良率怎么样"), false);
});

test("isBadBinRankingQuestion excludes specific DUT asks", () => {
  assert.equal(
    isBadBinRankingQuestion("第七片 wafer pass1的测试 中 dut12 测出的哪个坏bin最多"),
    false
  );
  assert.ok(isBadBinRankingQuestion("N55Z 最近一个月测试中 哪个坏die 最多"));
});

test("detectJbReplyMode: DUT+slot → generic (not bad_bin_ranking / single_slot)", () => {
  assert.equal(
    detectJbReplyMode("第七片 wafer pass1的测试 中 dut12 测出的哪个坏bin最多"),
    "generic"
  );
  assert.equal(
    detectJbReplyMode("第一片中 pass1 中dut12 都测试出了什么坏bin"),
    "generic"
  );
});

test("extractFocusDutBins finds DUT outside top contributors", () => {
  const passes: SiteBinPass[] = [
    {
      passId: 1,
      bins: [
        {
          bin: "bin61",
          duts: [
            { dut: 1, dieCount: 100 },
            { dut: 2, dieCount: 90 },
            { dut: 3, dieCount: 80 },
            { dut: 4, dieCount: 70 },
            { dut: 5, dieCount: 60 },
            { dut: 6, dieCount: 50 },
            { dut: 7, dieCount: 40 },
            { dut: 8, dieCount: 30 },
            { dut: 12, dieCount: 5 }, // outside top 8
          ],
        },
        {
          bin: "bin30",
          duts: [
            { dut: 1, dieCount: 10 },
            { dut: 12, dieCount: 20 },
          ],
        },
        {
          bin: "bin55",
          duts: Array.from({ length: 10 }, (_, i) => ({
            dut: i + 1,
            dieCount: 200,
          })),
        },
      ],
    },
  ];

  const focus = extractFocusDutBins(passes, 12);
  assert.equal(focus.length, 1);
  assert.equal(focus[0]!.passId, 1);
  assert.deepEqual(
    focus[0]!.bins.map((b) => ({ bin: b.bin, dieCount: b.dieCount })),
    [
      { bin: "bin30", dieCount: 20 },
      { bin: "bin61", dieCount: 5 },
    ]
  );
  assert.equal(focus[0]!.totalBadDie, 25);
});

test("compactSiteBinPasses keeps focusDut even outside Top8", () => {
  const passes: SiteBinPass[] = [
    {
      passId: 1,
      bins: [
        {
          bin: "bin61",
          duts: [
            { dut: 1, dieCount: 100 },
            { dut: 2, dieCount: 90 },
            { dut: 3, dieCount: 80 },
            { dut: 4, dieCount: 70 },
            { dut: 5, dieCount: 60 },
            { dut: 6, dieCount: 50 },
            { dut: 7, dieCount: 40 },
            { dut: 8, dieCount: 30 },
            { dut: 12, dieCount: 5 },
          ],
        },
      ],
    },
  ];

  const without = compactSiteBinPasses(passes) as Array<{
    bins: Array<{ duts?: Array<{ dut: number }> }>;
  }>;
  const badWithout = without[0]!.bins.find((b) => (b as { bin?: string }).bin === "bin61");
  assert.ok(badWithout?.duts);
  assert.equal(
    badWithout!.duts!.some((d) => d.dut === 12),
    false,
    "without focusDut, DUT12 should be truncated"
  );

  const withFocus = compactSiteBinPasses(passes, { focusDut: 12 }) as Array<{
    bins: Array<{ duts?: Array<{ dut: number }> }>;
  }>;
  const badWith = withFocus[0]!.bins.find((b) => (b as { bin?: string }).bin === "bin61");
  assert.ok(badWith?.duts?.some((d) => d.dut === 12), "focusDut 12 must remain");
});

test("ensureFocusDutInCompactedDuts appends or replaces last", () => {
  const top = [
    { dut: 1, dieCount: 10 },
    { dut: 2, dieCount: 9 },
  ];
  const all = [
    ...top,
    { dut: 12, dieCount: 1 },
  ];
  const out = ensureFocusDutInCompactedDuts(top, all, 12, 8);
  assert.ok(out.some((d) => d.dut === 12));
});

test("buildFocusDutBinsMarkdown ranks and names top BIN", () => {
  const md = buildFocusDutBinsMarkdown(
    12,
    [
      {
        passId: 1,
        totalBadDie: 25,
        bins: [
          { bin: "bin30", binNum: 30, dieCount: 20 },
          { bin: "bin61", binNum: 61, dieCount: 5 },
        ],
      },
    ],
    { lot: "NF13607.1R", slot: 7, passId: 1 }
  );
  assert.ok(md.includes("BIN30"));
  assert.ok(md.includes("最多坏 BIN：BIN30"));
  assert.ok(md.includes("waferId 7"));
});

test("query_inf_site_bin_by_dut returns focusDutBins for focusDut", async () => {
  const out = (await runTool("query_inf_site_bin_by_dut", {
    device: "WA03P02G",
    lot: "NF12551.1N",
    slot: 1,
    passId: 1,
    focusDut: 12,
  })) as string;
  assert.ok(out.includes('"focusDut"') || out.includes('"focusDut":'), out.slice(0, 200));
  assert.ok(out.includes("focusDutBins"), out.slice(0, 300));
});

test("detectPendingQuery passes focusDut and passId for DUT focus ask", async () => {
  const { detectPendingQuery } = await import("../src/lib/agent/agentPendingQuery.js");
  const pending = detectPendingQuery(
    "第七片 wafer pass1的测试 中 dut12 测出的哪个坏bin最多",
    "query_jb_bins",
    { device: "WA01P14E", lot: "NF13607.1R" }
  );
  assert.ok(pending);
  assert.equal(pending!.toolName, "query_inf_site_bin_by_dut");
  assert.equal(pending!.args["slot"], 7);
  assert.equal(pending!.args["passId"], 1);
  assert.equal(pending!.args["focusDut"], 12);
});

test("canRunScopedBadBinDirectRoute rejects DUT-specific bad-bin ask", async () => {
  const { canRunScopedBadBinDirectRoute } = await import(
    "../src/lib/agent/agentJbScopedBadBinRoute.js"
  );
  assert.equal(
    canRunScopedBadBinDirectRoute(
      "第七片 wafer pass1的测试 中 dut12 测出的哪个坏bin最多",
      [{ role: "user", content: "WA01P14E 测试情况" }]
    ),
    false
  );
});

test("parseFocusDutBinsFromToolResult survives truncateResult() truncation (regression)", () => {
  // Build a payload large enough that truncateResult() has to cut into `passes`
  // while `focusDut`/`focusDutBins` (emitted first) stay intact — this is the
  // exact shape produced by buildInfSiteBinResult() for a big wafer.
  const bigBins = Array.from({ length: 500 }, (_, i) => ({
    bin: `bin${i}`,
    dutCount: 78,
    totalDieCount: 7800,
    avgPerDut: 100,
    duts: Array.from({ length: 78 }, (_, d) => ({ dut: d + 1, dieCount: 100 })),
  }));
  const raw = truncateResult(
    {
      focusDut: 12,
      focusDutBins: [
        { passId: 1, totalBadDie: 25, bins: [{ bin: "bin30", binNum: 30, dieCount: 20 }] },
      ],
      device: "WA03P02G",
      lot: "NF12551.1N",
      slot: 1,
      passes: [{ passId: 1, bins: bigBins }],
    },
    500 // force truncation well before `passes` finishes serializing
  );
  assert.ok(raw.includes("已截断"), "sanity: payload must actually be truncated");

  const parsed = parseFocusDutBinsFromToolResult(raw);
  assert.ok(parsed, "must still recover focusDut/focusDutBins from a truncated payload");
  assert.equal(parsed!.focusDut, 12);
  assert.equal(parsed!.focusDutBins?.[0]?.bins?.[0]?.bin, "bin30");
  assert.equal(parsed!.device, "WA03P02G");
  assert.equal(parsed!.lot, "NF12551.1N");
  assert.equal(parsed!.slot, 1);
});

test("detectJbReplyMode: DUT+slot+card question stays card_dut_question, not generic (regression)", () => {
  assert.equal(
    detectJbReplyMode("第7片 4056-013号卡测的DUT12有没有问题"),
    "card_dut_question"
  );
  // Sanity: without the slot mention, this already worked pre-fix.
  assert.equal(detectJbReplyMode("4056-013号卡测的DUT12有没有问题"), "card_dut_question");
});
