import assert from "node:assert/strict";
import test from "node:test";
import {
  buildUnscopedBinClarifyMessage,
  canRunUnscopedBinClarify,
  findUnrecognizedScopeToken,
} from "../src/lib/agent/agentJbUnscopedBinRoute.js";
import type { ChatMessage } from "../src/lib/agent/agentHistory.js";

test("findUnrecognizedScopeToken: 命中无效全大写 token，放过已知业务词/mask", () => {
  assert.equal(findUnrecognizedScopeToken("ZZZZZ 哪个卡测出bin99 多"), "ZZZZZ");
  // BIN/DUT/LOT 等业务词不算 scope token。
  assert.equal(findUnrecognizedScopeToken("BIN99 哪个卡最多"), null);
  // 纯中文、无全大写 token。
  assert.equal(findUnrecognizedScopeToken("哪片卡 bin35 出得最多"), null);
  // mask（P11C）含数字，非 ≥4 连续字母，不误判为无效 token。
  assert.equal(findUnrecognizedScopeToken("P11C bin35 哪张卡"), null);
});

test("canRunUnscopedBinClarify: A2-4 不存在 mask + bin 归因 → 兜底澄清", () => {
  assert.ok(canRunUnscopedBinClarify("ZZZZZ 哪个卡测出bin99 多"));
});

test("canRunUnscopedBinClarify: 有可解析 scope 时不拦截（交正常路由）", () => {
  // 裸 mask N55Z 可解析 → 不澄清。
  assert.equal(canRunUnscopedBinClarify("N55Z 哪个卡测出bin35 多"), false);
  // device 可解析 → 不澄清。
  assert.equal(canRunUnscopedBinClarify("WC13N55Z 哪个卡测出bin35 多"), false);
});

test("canRunUnscopedBinClarify: 纯中文无 token 的问句交 LLM 澄清（不拦截）", () => {
  // B2-3 "哪片卡 bin35 出得最多"：无无效 token → 保持现有 LLM 澄清行为。
  assert.equal(canRunUnscopedBinClarify("哪片卡 bin35 出得最多"), false);
});

test("canRunUnscopedBinClarify: 非 bin 归因/排行类问句不拦截", () => {
  // 无 bin 编号。
  assert.equal(canRunUnscopedBinClarify("ZZZZZ 最近测试情况"), false);
  // 有 bin 但非归因/排行（问概况）。
  assert.equal(canRunUnscopedBinClarify("ZZZZZ bin35 概况"), false);
});

test("canRunUnscopedBinClarify: history 有 lot / scope 时不拦截", () => {
  const historyWithLot: ChatMessage[] = [
    { role: "user", content: "NF13322.1J 最近测试情况" },
    {
      role: "tool",
      name: "query_jb_bins",
      content: JSON.stringify({ device: "WA03P02G", lot: "NF13322.1J" }),
    } as ChatMessage,
  ];
  assert.equal(
    canRunUnscopedBinClarify("ZZZZZ 哪个卡测出bin99 多", historyWithLot),
    false
  );
});

test("buildUnscopedBinClarifyMessage: 含无效 token 与 BIN 编号，提示补充 scope", () => {
  const msg = buildUnscopedBinClarifyMessage("ZZZZZ 哪个卡测出bin99 多");
  assert.match(msg, /ZZZZZ/);
  assert.match(msg, /BIN99/);
  assert.match(msg, /lot|device|mask|机台/);
  assert.ok(msg.length > 20);
});
