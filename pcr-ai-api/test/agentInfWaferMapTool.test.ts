import assert from "node:assert/strict";
import test from "node:test";
import {
  buildInfDrawArgsAfterJbLookup,
  buildInfDrawArgsFromSession,
  extractBinNumberFromText,
  extractLotFromUserText,
  extractSlotFromUserText,
  findLastInfDrawWaferMapContext,
  inferSinglePassIdFromText,
  normalizeInfDrawWaferMapArgs,
  parseInfDrawResultText,
  userWantsAllInfLayers,
  userWantsWaferMapOnly,
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

test("userWantsWaferMapOnly recognizes 口语 wafer图 / 晶圆图（无 wafermap 字样）", () => {
  // 用户常说「wafer图」而不写 wafermap —— 此前直连路由漏检
  assert.equal(userWantsWaferMapOnly("NF13607.1R 第三片的wafer图"), true);
  assert.equal(userWantsWaferMapOnly("帮我看一下 DR44117.1Y 第14片 wafer 图"), true);
  assert.equal(userWantsWaferMapOnly("画出 NF13128.1A 第一片晶圆图"), true);
  assert.equal(userWantsWaferMapOnly("WA03P02G NF13128.1A 第二十四片的晶圆图"), true);
  assert.equal(userWantsWaferMapOnly("同理画出 bin14 的 wafer图"), true);
  // 标准写法仍命中
  assert.equal(userWantsWaferMapOnly("画出第14片 wafermap"), true);
  // 非画图问句不误伤
  assert.equal(userWantsWaferMapOnly("NF13607.1R 第三片 pass3 有多少个bin3"), false);
  assert.equal(userWantsWaferMapOnly("DR44117.1Y 整体的测试情况"), false);
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

test("extractSlotFromUserText 第1片wafer", () => {
  assert.equal(
    extractSlotFromUserText("帮我画出DR44117.1Y第1片wafer 的pass1 的wafermap"),
    1
  );
});

test("userWantsWaferMapOnly vs lot overview", () => {
  assert.equal(
    userWantsWaferMapOnly(
      "帮我画出DR44117.1Y第1片wafer 的pass1 的wafermap"
    ),
    true
  );
  assert.equal(userWantsWaferMapOnly("DR44117.1Y lot 概况和聚集分析"), false);
});

test("normalizeInfDrawWaferMapArgs BIN follow-up inherits previous passes (no composite shortcut)", () => {
  const history: ChatMessage[] = [
    {
      role: "tool",
      name: "inf_draw_wafer_map",
      content:
        "**晶圆图已生成** → [x](/wafermaps/a.html)\n" +
        "Device: WA00P32P  Lot: DR44117.1Y  Wafer: 14  Slot: 14",
    },
    { role: "user", content: "画出bin15 所在位置的 wafermap" },
  ];
  const merged = normalizeInfDrawWaferMapArgs({}, history);
  assert.equal(merged.lot, "DR44117.1Y");
  assert.equal(merged.slot, 14);
  assert.equal(merged.highlight, "bin:15");
  // Previous draw had no explicit passes arg → inherit nothing → default (all layers)
  assert.equal(merged.passes, undefined);
});

test("buildInfDrawArgsAfterJbLookup from jb payload + user slot", () => {
  const history = [
    {
      role: "user",
      content: "帮我画出DR44117.1Y第1片wafer 的pass1 的wafermap",
    },
  ] as ChatMessage[];
  const args = buildInfDrawArgsAfterJbLookup(
    { device: "WA00P32P", lot: "DR44117.1Y" },
    history,
    history[0]!.content as string
  );
  assert.equal(args.device, "WA00P32P");
  assert.equal(args.lot, "DR44117.1Y");
  assert.equal(args.slot, 1);
  assert.equal(args.passes, "1");
});

test("extractLotFromUserText", () => {
  assert.equal(extractLotFromUserText("lot DR44117.1Y 第3片"), "DR44117.1Y");
  // markdown emphasis underscores must not block extraction
  assert.equal(extractLotFromUserText("帮我绘一下_NF13128.1A_ 第一片wafermap"), "NF13128.1A");
  assert.equal(extractLotFromUserText("_DR44498.1T_ 第一片"), "DR44498.1T");
  assert.equal(extractLotFromUserText("近方lot NF13128.1A_第二十四片"), "NF13128.1A");
  assert.equal(extractLotFromUserText("WA03P02G NF13128.1A__第二十四片的wafermap"), "NF13128.1A");
  assert.equal(extractLotFromUserText("分析一下P02G 8041-08"), undefined);
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
