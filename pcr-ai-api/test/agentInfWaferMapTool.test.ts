import assert from "node:assert/strict";
import test from "node:test";
import {
  extractBinNumberFromText,
  findLastInfDrawWaferMapContext,
  inferSinglePassIdFromText,
  normalizeInfDrawWaferMapArgs,
  parseInfDrawResultText,
  userWantsAllInfLayers,
} from "../src/lib/agent/agentInfWaferMapTool.js";
import type { ChatMessage } from "../src/lib/agent/agentHistory.js";

test("extractBinNumberFromText", () => {
  assert.equal(extractBinNumberFromText("标出 bin98 所在位置"), 98);
  assert.equal(extractBinNumberFromText("同理画出 bin14"), 14);
  assert.equal(extractBinNumberFromText("highlight: bin:37"), 37);
});

test("parseInfDrawResultText reads device lot slot", () => {
  const text = [
    "**晶圆图已生成** → [点击]( /wafermaps/x.html)",
    "Device: WA00P32P  Lot: DR44117.1Y  Wafer: 14  Slot: 14",
  ].join("\n");
  const ctx = parseInfDrawResultText(text);
  assert.equal(ctx.device, "WA00P32P");
  assert.equal(ctx.lot, "DR44117.1Y");
  assert.equal(ctx.slot, 14);
});

test("inferSinglePassIdFromText for pass1-only wafermap request", () => {
  assert.equal(
    inferSinglePassIdFromText("帮我画出第14片wafer 的pass1 的wafermap"),
    "1"
  );
  assert.equal(userWantsAllInfLayers("画出全部层包括中断和合成"), true);
  assert.equal(
    inferSinglePassIdFromText("画出全部层包括中断和合成"),
    undefined
  );
});

test("normalizeInfDrawWaferMapArgs sets passes=1 for pass1-only question", () => {
  const history = [
    {
      role: "user",
      content: "帮我画出第14片wafer 的pass1 的wafermap",
    },
  ] as import("../src/lib/agent/agentHistory.js").ChatMessage[];
  const merged = normalizeInfDrawWaferMapArgs({}, history);
  assert.equal(merged.passes, "1");
});

test("normalizeInfDrawWaferMapArgs fills lot from prior inf_draw", () => {
  const history: ChatMessage[] = [
    { role: "user", content: "画出 wafermap 标出 bin98" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: {
            name: "inf_draw_wafer_map",
            arguments: JSON.stringify({
              device: "WA00P32P",
              lot: "DR44117.1Y",
              slot: 14,
              highlight: "bin:98",
            }),
          },
        },
      ],
    },
    {
      role: "tool",
      name: "inf_draw_wafer_map",
      tool_call_id: "c1",
      content:
        "**晶圆图已生成** → [点击](/wafermaps/a.html)\n" +
        "Device: WA00P32P  Lot: DR44117.1Y  Wafer: 14  Slot: 14",
    },
    { role: "user", content: "同理画出 bin14 所在位置的 wafermap" },
  ];

  const merged = normalizeInfDrawWaferMapArgs({ bin: 14 }, history);
  assert.equal(merged.device, "WA00P32P");
  assert.equal(merged.lot, "DR44117.1Y");
  assert.equal(merged.slot, 14);
  assert.equal(merged.highlight, "bin:14");
  assert.equal("bin" in merged, false);
});

test("findLastInfDrawWaferMapContext skips failed draw", () => {
  const history: ChatMessage[] = [
    {
      role: "tool",
      name: "inf_draw_wafer_map",
      content: "inf 工具参数错误: lot 不能为空",
    },
    {
      role: "tool",
      name: "inf_draw_wafer_map",
      content: "**晶圆图已生成** → [x](/wafermaps/ok.html)\nDevice: D1  Lot: L1.1Y  Slot: 3",
    },
  ];
  const ctx = findLastInfDrawWaferMapContext(history);
  assert.equal(ctx?.lot, "L1.1Y");
  assert.equal(ctx?.slot, 3);
});
