import assert from "node:assert/strict";
import test from "node:test";
import {
  canRunUnderperformingDutDirectRoute,
  isLotUnderperformingDutQuestion,
  underperformingDutArgsFromText,
} from "../src/lib/agent/agentUnderperformingDutRoute.js";
import type { ChatMessage } from "../src/lib/agent/agentHistory.js";

test("isLotUnderperformingDutQuestion: DUT 低良率意图命中；卡/概况不命中", () => {
  assert.ok(isLotUnderperformingDutQuestion("DR43782.1A 哪些 DUT 偏低"));
  assert.ok(isLotUnderperformingDutQuestion("这个 lot 哪些 dut 良率低"));
  assert.ok(isLotUnderperformingDutQuestion("低良率的 DUT 有哪些"));
  assert.ok(
    isLotUnderperformingDutQuestion(
      "NF12499.1N 各 DUT 良率怎么样？有没有低于 lot 整体 75% 阈值的 DUT？"
    )
  );
  assert.equal(isLotUnderperformingDutQuestion("哪张卡良率最低"), false); // 卡，非 DUT
  assert.equal(isLotUnderperformingDutQuestion("DR43782.1A 概况"), false);
});

test("canRunUnderperformingDutDirectRoute: NF12499.1N 各 DUT 良率 + 75% 阈值", () => {
  assert.ok(
    canRunUnderperformingDutDirectRoute(
      "NF12499.1N 各 DUT 良率怎么样？有没有低于 lot 整体 75% 阈值的 DUT？"
    )
  );
});

test("canRunUnderperformingDutDirectRoute: 需 DUT 低良率意图 + lot（句或 history）", () => {
  assert.ok(canRunUnderperformingDutDirectRoute("DR43782.1A 哪些 DUT 偏低"));
  assert.equal(canRunUnderperformingDutDirectRoute("哪些 DUT 偏低"), false); // 无 lot
  const hist: ChatMessage[] = [
    { role: "user", content: "DR43782.1A 概况" },
    { role: "tool", name: "query_jb_bins", content: JSON.stringify({ lot: "DR43782.1A", device: "WA03P02G" }) } as ChatMessage,
  ];
  assert.ok(canRunUnderperformingDutDirectRoute("哪些 DUT 偏低", hist));
});

test("underperformingDutArgsFromText: 解析 lot + device", () => {
  assert.deepEqual(
    underperformingDutArgsFromText("DR43782.1A 哪些 DUT 偏低"),
    { lot: "DR43782.1A", device: undefined }
  );
  assert.equal(underperformingDutArgsFromText("哪些 DUT 偏低"), null);
});
