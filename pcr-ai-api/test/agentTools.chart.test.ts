// pcr-ai-api/test/agentTools.chart.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runTool } from "../src/lib/agent/tools/agentToolHandlers.js";

describe("generate_chart tool", () => {
  it("returns a ChartSentinel with __chartOption", async () => {
    const result = await runTool("generate_chart", {
      chartType: "bar",
      title: "Device Triggers",
      data: {
        labels: ["WA03P02G", "WB04P02G"],
        series: [{ name: "Count", values: [42, 18] }],
      },
    });
    assert.ok(
      typeof result === "object" && result !== null && "__chartOption" in result,
      "Should return ChartSentinel"
    );
    const option = (result as { __chartOption: unknown }).__chartOption as Record<string, unknown>;
    assert.ok(option["title"], "option should have title");
    assert.ok(Array.isArray(option["series"]), "option should have series");
  });

  it("bar chart has xAxis with category type", async () => {
    const result = await runTool("generate_chart", {
      chartType: "bar",
      title: "Test",
      data: { labels: ["A", "B"], series: [{ name: "S", values: [1, 2] }] },
    });
    const option = (result as { __chartOption: Record<string, unknown> }).__chartOption;
    const xAxis = option["xAxis"] as Record<string, unknown>;
    assert.equal(xAxis["type"], "category");
  });

  it("pie chart has no xAxis", async () => {
    const result = await runTool("generate_chart", {
      chartType: "pie",
      title: "Pie",
      data: { labels: ["X", "Y"], series: [{ name: "S", values: [30, 70] }] },
    });
    const option = (result as { __chartOption: Record<string, unknown> }).__chartOption;
    assert.equal(option["xAxis"], undefined, "pie should not have xAxis");
    const series = option["series"] as { type: string; data: unknown[] }[];
    assert.equal(series[0].type, "pie");
  });

  it("line chart has xAxis with category type", async () => {
    const result = await runTool("generate_chart", {
      chartType: "line",
      title: "Trend",
      data: { labels: ["Jan", "Feb"], series: [{ name: "S", values: [1, 2] }] },
    });
    const option = (result as { __chartOption: Record<string, unknown> }).__chartOption;
    const xAxis = option["xAxis"] as Record<string, unknown>;
    assert.equal(xAxis["type"], "category");
  });

  it("scatter chart has no xAxis key", async () => {
    const result = await runTool("generate_chart", {
      chartType: "scatter",
      title: "Scatter",
      data: { labels: ["A", "B"], series: [{ name: "S", values: [10, 20] }] },
    });
    const option = (result as { __chartOption: Record<string, unknown> }).__chartOption;
    assert.equal(option["xAxis"], undefined, "scatter should not have xAxis");
  });

  it("returns string error for unknown tool", async () => {
    const result = await runTool("unknown_tool", {});
    assert.equal(typeof result, "string");
    assert.ok(String(result).includes("未知工具"));
  });
});
