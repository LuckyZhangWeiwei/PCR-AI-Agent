import assert from "node:assert/strict";
import test from "node:test";
import {
  detachProseAfterMarkdownTables,
  detachSummaryLikeTableRows,
  splitAgentReplyMarkdown,
} from "./splitAgentReplyMarkdown.js";

test("detachProseAfterMarkdownTables moves tail prose out of table block", () => {
  const md = [
    "| Slot | pass1 良率% |",
    "|---:|---:|",
    "| 1 | 95% |",
    "BIN90 在 waferId 1–13 连续聚集。",
  ].join("\n");
  const { body, tailProse } = detachProseAfterMarkdownTables(md);
  assert.ok(!body.includes("BIN90"));
  assert.ok(tailProse.includes("BIN90"));
});

test("detachSummaryLikeTableRows removes summary pipe row", () => {
  const md = [
    "| Slot | yield |",
    "|---:|---:|",
    "| 1 | 95% |",
    "| 总结 | 批次良率 91.94% |",
  ].join("\n");
  const { body, detachedProse } = detachSummaryLikeTableRows(md);
  assert.equal(body.split("\n").length, 3);
  assert.ok(detachedProse.includes("91.94%"));
});

test("detachSummaryLikeTableRows keeps BIN-named table rows in body", () => {
  const md = [
    "| Slot | pass1 良率% |",
    "|---:|---:|",
    "| 1 | 95% |",
    "",
    "### 警示 / 规律识别",
    "",
    "| BIN | 类型 | 说明 |",
    "|---|---|---|",
    "| BIN66 | 连续聚集 | waferId 8–11 |",
    "| BIN55 | 突增 | waferId 14–15 |",
  ].join("\n");
  const { body, detachedProse } = detachSummaryLikeTableRows(md);
  assert.ok(body.includes("| BIN66 |"), "BIN warning table should stay in body");
  assert.ok(body.includes("### 警示"), "section heading should stay in body");
  assert.equal(detachedProse, "");
});

test("splitAgentReplyMarkdown puts streamed commentary below tables", () => {
  const text = [
    "## 实测数据",
    "",
    "| Slot | pass1 良率% |",
    "|---:|---:|",
    "| 1 | 95% |",
    "",
    "## 分析结论",
    "",
    "### 数据解读",
    "批次良率 91.94%。",
  ].join("\n");
  const { dataMarkdown, commentaryMarkdown } = splitAgentReplyMarkdown(text);
  assert.ok(dataMarkdown.includes("| 1 |"));
  assert.ok(!dataMarkdown.includes("91.94%"));
  assert.ok(commentaryMarkdown.includes("91.94%"));
});

test("splitAgentReplyMarkdown keeps ### 🔍 section in dataMarkdown when patterns-only (no cluster table)", () => {
  // jbReplySkipsCommentaryLlm path: now always emits ## 分析结论 separator
  const text = [
    "## 实测数据",
    "",
    "| Slot | pass1 良率% |",
    "|---:|---:|",
    "| 1 | 95% |",
    "",
    "### 🔍 警示 / 规律识别",
    "",
    "- ⚠️ **BIN41 片间突变**：pass1 第 18–19 片突增",
    "",
    "## 分析结论",
    "",
    "*以上为服务端实测表。如需某 BIN 逐片趋势或晶圆图，请继续提问。*",
  ].join("\n");
  const { dataMarkdown, commentaryMarkdown } = splitAgentReplyMarkdown(text);
  assert.ok(dataMarkdown.includes("### 🔍 警示"), "🔍 heading must be in data section");
  assert.ok(dataMarkdown.includes("BIN41 片间突变"), "pattern bullets must be in data section");
  assert.ok(!commentaryMarkdown.includes("🔍"), "🔍 section must not appear in commentary");
  assert.ok(commentaryMarkdown.includes("以上为服务端实测表"), "footer note in commentary");
});

test("splitAgentReplyMarkdown keeps cluster alerts table and patterns in dataMarkdown", () => {
  // jbReplySkipsCommentaryLlm path with both cluster table and bullet patterns
  const text = [
    "## 实测数据",
    "",
    "| Slot | pass1 良率% |",
    "|---:|---:|",
    "| 1 | 95% |",
    "",
    "### 🔍 警示 / 规律识别",
    "",
    "**⚠ TR21263.1Y** 聚集性 / 突增坏 bin 警示",
    "",
    "| BIN | 测试层 | 类型 | waferId 范围 | 说明 |",
    "|---:|---:|---:|---:|---|",
    "| BIN41 | pass1 | 突增 | 18–19 | 单片突增 19 颗 |",
    "",
    "- ⚠️ **BIN41 片间突变**：pass1 第 18–19 片突增",
    "",
    "## 分析结论",
    "",
    "*以上为服务端实测表。如需某 BIN 逐片趋势或晶圆图，请继续提问。*",
  ].join("\n");
  const { dataMarkdown, commentaryMarkdown } = splitAgentReplyMarkdown(text);
  assert.ok(dataMarkdown.includes("### 🔍 警示"), "🔍 heading in data");
  assert.ok(dataMarkdown.includes("| BIN41 | pass1 |"), "cluster alerts table in data");
  assert.ok(dataMarkdown.includes("BIN41 片间突变"), "pattern bullets in data");
  assert.ok(!commentaryMarkdown.includes("| BIN41 |"), "cluster table must not be in commentary (hidden by CSS)");
});
