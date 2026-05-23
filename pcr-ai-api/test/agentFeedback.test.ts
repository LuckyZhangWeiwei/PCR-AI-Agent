import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  saveFeedback,
  buildFeedbackInjection,
  type FeedbackRecord,
} from "../src/lib/agent/agentFeedback.js";

describe("agentFeedback", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "pcr-feedback-test-"));
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("saveFeedback writes a record to the given file", async () => {
    const f = join(tmpDir, "test1.json");
    const record: FeedbackRecord = {
      id: "id-1",
      kind: "good",
      question: "WA03P02G 最近触发次数",
      answer: "最近 7 天触发 12 次",
      timestamp: new Date().toISOString(),
      sessionId: "sess-1",
    };
    await saveFeedback(record, f);
    const { readFile } = await import("node:fs/promises");
    const saved = JSON.parse(await readFile(f, "utf-8")) as FeedbackRecord[];
    assert.equal(saved.length, 1);
    assert.equal(saved[0].id, "id-1");
    assert.equal(saved[0].kind, "good");
  });

  it("saveFeedback appends to an existing file", async () => {
    const f = join(tmpDir, "test2.json");
    const base: FeedbackRecord = {
      id: "id-a", kind: "good", question: "q", answer: "a",
      timestamp: new Date().toISOString(), sessionId: "s",
    };
    const second: FeedbackRecord = {
      id: "id-b", kind: "bad", question: "q2", answer: "a2",
      category: "数据有误", timestamp: new Date().toISOString(), sessionId: "s",
    };
    await saveFeedback(base, f);
    await saveFeedback(second, f);
    const { readFile } = await import("node:fs/promises");
    const saved = JSON.parse(await readFile(f, "utf-8")) as FeedbackRecord[];
    assert.equal(saved.length, 2);
  });

  it("buildFeedbackInjection returns empty string when file does not exist", async () => {
    const result = await buildFeedbackInjection(
      "test question",
      join(tmpDir, "nonexistent.json")
    );
    assert.equal(result, "");
  });

  it("buildFeedbackInjection injects matching good record", async () => {
    const f = join(tmpDir, "test3.json");
    await saveFeedback({
      id: "id-2", kind: "good",
      question: "WA03P02G 触发次数分析",
      answer: "该设备最近 7 天触发了 12 次，主要集中在 dut3",
      timestamp: new Date().toISOString(), sessionId: "s",
    }, f);
    const result = await buildFeedbackInjection("WA03P02G 最近触发次数查询", f);
    assert.ok(result.includes("历史反馈参考"), `Got: ${result}`);
    assert.ok(result.includes("WA03P02G"));
  });

  it("buildFeedbackInjection returns empty for non-matching question", async () => {
    const f = join(tmpDir, "test4.json");
    await saveFeedback({
      id: "id-3", kind: "good",
      question: "XY99 良率分析报告",
      answer: "良率 98.5%",
      timestamp: new Date().toISOString(), sessionId: "s",
    }, f);
    const result = await buildFeedbackInjection("ABC123 完全不同的问题", f);
    assert.equal(result, "");
  });

  it("buildFeedbackInjection includes bad feedback warning with comment", async () => {
    const f = join(tmpDir, "test5.json");
    await saveFeedback({
      id: "id-4", kind: "bad",
      question: "WA03P02G 触发良率数据",
      answer: "...",
      category: "数据有误",
      comment: "触发次数统计时段写错了",
      timestamp: new Date().toISOString(), sessionId: "s",
    }, f);
    const result = await buildFeedbackInjection("WA03P02G 触发良率", f);
    assert.ok(result.includes("数据有误"), `Got: ${result}`);
    assert.ok(result.includes("触发次数统计时段写错了"));
  });
});
