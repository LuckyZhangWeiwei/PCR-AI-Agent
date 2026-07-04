import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseBinFromTriggerLabel } from "../src/lib/yieldTriggerLabelBin.js";

describe("parseBinFromTriggerLabel（TRIGGER_LABEL 中 Bin# 片段）", () => {
  test("解析数字 Bin#", () => {
    assert.equal(
      parseBinFromTriggerLabel(
        "Bin# 1 on dut# 2 Yield: 58.72, Min Yield(Dut#2): 58.72 Max Yield(Dut#0): 98.15 Delta exceed Delta Limit 20."
      ),
      "1"
    );
    assert.equal(
      parseBinFromTriggerLabel(
        "Bin# 250 on dut# 23 Yield: 49.64, Min Yield(Dut#23): 49.64 Max Yield(Dut#17): 100.00 Delta exceed Delta Limit 50."
      ),
      "250"
    );
  });

  test("解析 Bin#N（数字紧跟 # 无空格）", () => {
    assert.equal(
      parseBinFromTriggerLabel("Bin#11 on dut#1 Conse_Count: 20 exceed limit 20  ."),
      "11"
    );
  });

  test("解析 goodbin，大小写不敏感并归一化为小写", () => {
    assert.equal(
      parseBinFromTriggerLabel(
        "Bin# goodbin on dut# 21 Yield: 29.69, Min Yield(Dut#21): 29.69 Max Yield(Dut#13): 100.00 Delta exceed Delta Limit 50."
      ),
      "goodbin"
    );
    assert.equal(parseBinFromTriggerLabel("BIN# GOODBIN on dut# 1"), "goodbin");
  });

  test("无 Bin# 片段 → null", () => {
    assert.equal(
      parseBinFromTriggerLabel("Totally no good die, exceed consecutive fail limit 100 ."),
      null
    );
  });

  test("空 / undefined / null → null", () => {
    assert.equal(parseBinFromTriggerLabel(undefined), null);
    assert.equal(parseBinFromTriggerLabel(null), null);
    assert.equal(parseBinFromTriggerLabel(""), null);
  });
});
