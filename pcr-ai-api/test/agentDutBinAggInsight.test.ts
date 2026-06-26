/**
 * Task 4: query_lot_dut_bin_agg 结果附 DUT 集中度判别表
 * 断言：结果是字符串、不以错误前缀开头、不含内部字段名；
 * dummy lot DR43782.1A 含足够坏 bin，应输出含「疑」字的判别表。
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env["INFCONTROL_LAYER_BINS_DUMMY"] = "true";
process.env["SITE_BIN_BY_LOT_DUMMY"] = "true";

import { runTool } from "../src/lib/agent/agentToolHandlers.js";

test("query_lot_dut_bin_agg result is a string and not an error", async () => {
  const out = await runTool("query_lot_dut_bin_agg", { device: "WA10P29E", lot: "DR43782.1A" });
  assert.equal(typeof out, "string");
  assert.ok(
    !(out as string).startsWith("query_lot_dut_bin_agg 参数错误"),
    `Should not return param error, got: ${(out as string).slice(0, 200)}`
  );
  // 不应暴露内部字段名
  assert.ok(!(out as string).includes("cardByPassId"), "should not expose internal field cardByPassId");
  assert.ok(!(out as string).includes("topShare"), "should not expose internal field topShare");
  assert.ok(!(out as string).includes("DutConcentrationInsight"), "should not expose type name");
});

test("query_lot_dut_bin_agg result does not expose internal identifiers", async () => {
  const out = await runTool("query_lot_dut_bin_agg", { device: "WA10P29E", lot: "DR43782.1A" }) as string;
  // Markdown 表头字段（内部实现名）不应出现
  assert.ok(!out.includes("Markdown"), "no Markdown keyword");
  assert.ok(!out.includes("DutConcentration"), "no DutConcentration class name");
});

test("query_lot_dut_bin_agg result includes DUT concentration verdict table for dummy lot", async () => {
  // dummy lot DR43782.1A 含充足坏 bin，集中度表应前置在 JSON 之前
  const out = await runTool("query_lot_dut_bin_agg", { device: "WA10P29E", lot: "DR43782.1A" }) as string;
  // 判别表应包含「疑」字（疑探针卡 或 疑工艺/批次 或 样本不足）
  assert.ok(out.includes("疑"), `Expected verdict table with 「疑」, got start: ${out.slice(0, 300)}`);
  // 判别表标题应在 JSON 数据之前
  const titlePos = out.indexOf("坏 die 的 DUT 集中度");
  const jsonPos = out.indexOf('{"device"');
  assert.ok(titlePos !== -1, "Concentration table title should be present");
  assert.ok(jsonPos !== -1, "JSON data should be present");
  assert.ok(titlePos < jsonPos, "Concentration table should precede JSON data");
});

// ── Task 5: attachDutConcentrationToJbPayload ────────────────────────────────

import { attachDutConcentrationToJbPayload } from "../src/lib/agent/agentToolHandlers.js";

test("clustered alerts cause DUT concentration to be attached", async () => {
  const payload: Record<string, unknown> = {
    device: "WA10P29E",
    lot: "DR43782.1A",
    clusteredBadBinAlerts: [{ bin: 11, passId: 1 }],
  };
  await attachDutConcentrationToJbPayload(payload, "DR43782.1A 测试情况");
  assert.equal(typeof payload["dutConcentrationMarkdown"], "string");
});

test("no clustered alerts → dutConcentrationMarkdown not attached", async () => {
  const payload: Record<string, unknown> = {
    device: "WA10P29E",
    lot: "DR43782.1A",
    clusteredBadBinAlerts: [],
  };
  await attachDutConcentrationToJbPayload(payload, "DR43782.1A 测试情况");
  assert.equal(payload["dutConcentrationMarkdown"], undefined);
});

test("missing device → dutConcentrationMarkdown not attached", async () => {
  const payload: Record<string, unknown> = {
    lot: "DR43782.1A",
    clusteredBadBinAlerts: [{ bin: 11, passId: 1 }],
  };
  await attachDutConcentrationToJbPayload(payload, "DR43782.1A 测试情况");
  assert.equal(payload["dutConcentrationMarkdown"], undefined);
});
