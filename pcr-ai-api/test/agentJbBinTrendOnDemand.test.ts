import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildDeterministicJbTables } from "../src/lib/agent/agentJbDeterministicReply.js";
import { buildBinSlotTrendMarkdownOnDemand } from "../src/lib/agent/jb/agentJbBinTrend.js";
import {
  buildJbSessionCacheJson,
  wrapJbQueryResultForAgent,
} from "../src/lib/agent/jb/agentJbBinFormat.js";

describe("agentJbBinTrend on demand", () => {
  it("builds BIN7 trend for all slots when BIN7 not in top-5 precomputed trends", () => {
    const rows: Record<string, unknown>[] = [];
    for (let slot = 1; slot <= 25; slot++) {
      rows.push({
        LOT: "NF12316.1X",
        DEVICE: "DEV",
        SLOT: slot,
        PASSID: 1,
        PASSTYPE: "TEST",
        CARDID: "8041-05",
        GROSSDIE: 4300,
        bins: [
          { n: 1, value: 4200, isGoodBin: true },
          { n: 7, value: slot === 20 ? 50 : 5, isGoodBin: false },
        ],
      });
    }
    for (let slot = 1; slot <= 25; slot++) {
      rows.push({
        LOT: "NF12316.1X",
        SLOT: slot,
        PASSID: 3,
        PASSTYPE: "TEST",
        GROSSDIE: 4300,
        bins: [{ n: 1, value: 4290, isGoodBin: true }],
      });
    }

    const wrapped = wrapJbQueryResultForAgent(rows, { lotScopedFullRows: true });
    const cache = JSON.parse(buildJbSessionCacheJson(wrapped)) as Record<
      string,
      unknown
    >;
    const trends = cache.badBinSlotTrends as Array<{ bin: number }> | undefined;
    const precomputedBin7 = trends?.some((t) => t.bin === 7);

    const q = "NF12316.1X 中bin7 的趋势";
    const onDemand = buildBinSlotTrendMarkdownOnDemand(cache, 7, q);
    assert.ok(onDemand, "onDemand markdown missing");
    assert.ok(onDemand!.includes("| 1 |"));
    assert.ok(onDemand!.includes("| 25 |"));

    const tables = buildDeterministicJbTables(q, cache);
    assert.ok(tables, "deterministic tables missing");
    assert.ok(tables!.includes("BIN7"));
    if (!precomputedBin7) {
      assert.ok(tables!.includes("| 20 |"));
    }
  });
});
