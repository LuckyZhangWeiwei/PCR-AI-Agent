import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildDeterministicJbTables } from "../src/lib/agent/jb/agentJbOverviewMarkdown.js";
import { parseJbToolPayload } from "../src/lib/agent/jb/agentJbPayloadResolve.js";
import {
  buildJbSessionCacheJson,
  serializeJbQueryResultForAgent,
  wrapJbQueryResultForAgent,
} from "../src/lib/agent/jb/agentJbBinFormat.js";

describe("agentJbSessionCache", () => {
  it("cache survives aggressive serialize and enables deterministic tables", () => {
    const rows = Array.from({ length: 30 }, (_, i) => {
      const slot = i + 1;
      return {
        LOT: "NF12316.1X",
        DEVICE: "DEV",
        SLOT: slot,
        PASSID: slot % 2 === 0 ? 3 : 1,
        PASSTYPE: "TEST",
        CARDID: "8041-05",
        GROSSDIE: 4300,
        bins: [
          { n: 1, value: 4200, isGoodBin: true },
          { n: 7, value: 80 + slot, isGoodBin: false },
        ],
      };
    }) as Record<string, unknown>[];

    const wrapped = wrapJbQueryResultForAgent(rows, { lotScopedFullRows: true });
    const cacheJson = buildJbSessionCacheJson(wrapped);
    const serialized = serializeJbQueryResultForAgent(wrapped, 4000);

    assert.ok(serialized.length <= 4000);
    const cache = parseJbToolPayload(cacheJson);
    assert.ok(cache);
    assert.equal(cache!._jbSessionCacheVersion, 6);
    assert.ok(Array.isArray(cache!._trendRows));
    assert.ok(
      typeof cache!.lotYieldOverviewMarkdown === "string" &&
        String(cache!.lotYieldOverviewMarkdown).length > 100
    );

    const tables = buildDeterministicJbTables(
      "NF12316.1X lot 整体测试情况",
      cache!
    );
    assert.ok(tables?.includes("分测试层") || tables?.includes("pass1"));
  });
});
