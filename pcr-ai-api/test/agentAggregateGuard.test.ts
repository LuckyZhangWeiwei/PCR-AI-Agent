import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Self-contained dummy mode so this file passes standalone (no Oracle client / no
// reliance on another test file's global env side effects).
process.env["INFCONTROL_LAYER_BINS_DUMMY"] = "true";
process.env["YIELD_MONITOR_TRIGGERS_DUMMY"] = "true";

import { runTool } from "../src/lib/agent/agentToolHandlers.js";

describe("aggregate_jb_bins scope guard", () => {
  it("rejects aggregate without lot/device/cardId filter", async () => {
    const result = await runTool("aggregate_jb_bins", { groupBy: "bin", groupTop: 10 });
    assert.equal(typeof result, "string");
    assert.ok((result as string).includes("未传 lot"));
    assert.ok((result as string).includes("query_jb_bins"));
  });

  it("allows aggregate when lot is provided", async () => {
    const result = await runTool("aggregate_jb_bins", {
      groupBy: "bin",
      lot: "NF12827.1R",
      groupTop: 5,
    });
    assert.equal(typeof result, "string");
    assert.ok(!(result as string).startsWith("aggregate_jb_bins 错误"));
  });

  // dummy-parity：dummy 必须与 Oracle 一样输出**展平**的组（bin/lot/cardId 在 group 顶层，
  // 无嵌套 parts），否则确定性渲染器（buildMultiLotBinTable / buildBinFocusedLotRankingMarkdown /
  // buildBinCardAggregateMarkdown，均读 g["bin"]/g["lot"]）在 dummy 下恒空、与生产分叉。
  it("dummy groups are FLAT (bin/lot at top level, no nested parts) — dummy-parity", async () => {
    const raw = await runTool("aggregate_jb_bins", {
      device: "WA03P02G",
      groupBy: "bin,lot",
      groupTop: 50,
      testEndFrom: "2020-01-01",
      testEndTo: "2027-01-01",
    });
    const parsed = JSON.parse(raw as string) as {
      groups: Array<Record<string, unknown>>;
    };
    assert.ok(parsed.groups.length > 0, "expected non-empty groups for WA03P02G");
    const g = parsed.groups[0]!;
    assert.ok("bin" in g && "lot" in g && "count" in g, `group must be flat, got ${JSON.stringify(g)}`);
    assert.ok(!("parts" in g), `group must NOT carry nested 'parts', got ${JSON.stringify(g)}`);
    assert.ok(!("key" in g), `group must NOT carry 'key', got ${JSON.stringify(g)}`);
  });

  it("dummy yield aggregate groups are FLAT too — dummy-parity", async () => {
    const raw = await runTool("aggregate_yield_triggers", {
      dimensions: "probeCard",
      probeCardType: "8041",
      timeFrom: "2020-01-01",
      timeTo: "2027-01-01",
    });
    const parsed = JSON.parse(raw as string) as {
      groups: Array<Record<string, unknown>>;
    };
    if (parsed.groups.length > 0) {
      const g = parsed.groups[0]!;
      assert.ok(!("parts" in g) && !("key" in g), `yield group must be flat, got ${JSON.stringify(g)}`);
      assert.ok("count" in g, `yield group must carry count, got ${JSON.stringify(g)}`);
    }
  });
});
