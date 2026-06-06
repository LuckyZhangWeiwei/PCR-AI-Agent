import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildClusteredBadBinAlerts,
  formatClusteredBadBinAlertsMarkdown,
} from "../src/lib/agent/agentJbBadBinCluster.js";
import { wrapJbQueryResultForAgent } from "../src/lib/agent/agentJbBinFormat.js";

function row(slot: number, bin7: number, passId = 1): Record<string, unknown> {
  return {
    LOT: "L1",
    SLOT: slot,
    PASSID: passId,
    PASSTYPE: "TEST",
    GROSSDIE: 1000,
    bins: [{ n: 7, value: bin7, isGoodBin: false }],
  };
}

describe("agentJbBadBinCluster", () => {
  it("detects sudden increase between adjacent slots", () => {
    const rows = [1, 2, 3, 4, 5].map((s) => row(s, 3));
    rows.push(row(6, 95));
    const alerts = buildClusteredBadBinAlerts(rows, [{ bin: 7, dieCount: 110 }]);
    assert.ok(
      alerts.some((a) => a.kind === "sudden_increase" && a.bin === 7),
      "expected sudden_increase"
    );
  });

  it("detects cluster of high consecutive slots", () => {
    const rows = [
      ...[1, 2, 3].map((s) => row(s, 2)),
      ...[4, 5, 6, 7].map((s) => row(s, 40)),
      row(8, 3),
    ];
    const alerts = buildClusteredBadBinAlerts(rows, [{ bin: 7, dieCount: 200 }]);
    assert.ok(
      alerts.some((a) => a.kind === "cluster" && a.slots.length >= 3),
      "expected cluster"
    );
  });

  it("wrapJbQueryResultForAgent includes alerts on lot-scoped query", () => {
    const rows = [
      ...[1, 2, 3, 4].map((s) => row(s, 2)),
      row(5, 60),
      row(6, 70),
    ];
    const out = wrapJbQueryResultForAgent(rows, { lotScopedFullRows: true });
    assert.ok(Array.isArray(out.clusteredBadBinAlerts));
    assert.ok((out.clusteredBadBinAlerts as unknown[]).length > 0);
    const md = String(out.clusteredBadBinAlertsMarkdown ?? "");
    assert.ok(md.includes("警示"));
    assert.ok(md.includes("BIN7"));
  });

  it("formatClusteredBadBinAlertsMarkdown has GFM separator column count matching header", () => {
    const rows = [
      ...[1, 2, 3, 4].map((s) => row(s, 2)),
      row(5, 60),
      row(6, 70),
    ];
    const alerts = buildClusteredBadBinAlerts(rows, [{ bin: 7, dieCount: 200 }]);
    assert.ok(alerts.length > 0);
    const md = formatClusteredBadBinAlertsMarkdown(alerts, "L1.1Y", "DEV");
    const lines = md.split("\n");
    const header = lines.find((l) => l.startsWith("| BIN |"))!;
    const sep = lines.find((l) => /^\|[\s:|-]+\|$/.test(l.trim()))!;
    const countCols = (row: string) =>
      row.split("|").filter((c, i, a) => i > 0 && i < a.length - 1).length;
    assert.equal(countCols(header), 5);
    assert.equal(countCols(sep), 5);
  });

  it("formatClusteredBadBinAlertsMarkdown is empty when no alerts", () => {
    const rows = [1, 2, 3, 4].map((s) => row(s, 1));
    const alerts = buildClusteredBadBinAlerts(rows, [{ bin: 7, dieCount: 4 }]);
    assert.equal(alerts.length, 0);
    assert.equal(formatClusteredBadBinAlertsMarkdown(alerts), "");
  });
});
