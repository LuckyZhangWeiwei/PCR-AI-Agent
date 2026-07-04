# Claude Code 交接：低良率 DUT 表「全 0 / 阈值 0% 全部达标」诊断

**日期：** 2026-07-04
**读者：** Cursor Agent（需真库/真 INF 验证）
**触发：** 用户导出会话 `NF12499.1N` —— DUT 良率表 pass1 全 78 个 DUT `good=0`、表头「阈值 0% 全部达标」，但该 wafer 头部良率是 pass3 = 99.79%。
**相关：** [`HANDOFF_LOT_UNDERPERFORMING_DUTS_API.md`](HANDOFF_LOT_UNDERPERFORMING_DUTS_API.md)

---

## 1. 现象

- lot `NF12499.1N`（device WA03P02G）只测了 1 片（slot 17），头部概况 = **pass3 高温，99.79%**。
- 「各 DUT 良率」区块渲染的却是 **pass1（常温 sort1）层**，78 个 DUT 全部 `good=0 / yield=0`，表头写「lot 整体 0% · 阈值 0%（全部达标）」——自相矛盾。

## 2. 已确认（代码层，无需真库）

1. **pass 号无映射错位。** INF Perl `output_site_bin_bylot.pl` 的 `passId` 直接来自 `SmWaferPass->key('PASS_ID')`，与 JB `PASSID`（sort1→1 / sort2→3 / sort3→5）同源。故表里 pass1 = INF 里真实存在的 `PASS_ID=1` TEST 层。
2. **良品 bin 集合退化到 `{BIN1}`。** `computeUnderperformingDutsForPass` 用 `goodBinNumbersFromSiteBinPasses()`（启发式：**平均每 DUT die > 100** 才算良品 bin）+ 硬编码 `BIN1`。单片 wafer 每 DUT 仅 ~26 die，启发式恒空 → 良品 bin 只剩 `{BIN1}`。
3. **全 0 是真实计算结果。** 78 个 DUT `good=0` ⇒ 该 pass1 层**没有任何 die 落进 BIN1**。
4. **75% 算法本身正确**，但有退化 bug：整体良率 0% → 阈值 0% → 严格 `<` 永不成立 → 误显示「全部达标」。

## 3. 已修（本次 commit，沙箱可验）

- `src/lib/agent/agentUnderperformingDutView.ts`
  - **多列表格**：`DUTS_PER_ROW=3`，每行并排 3 个 DUT（原来 78 行 → 26 行）。
  - **退化守卫**：`baseline.yieldPct <= 0` 时，表头改为 `⚠️ 整体良率 0%（无良品 die 落入良品 bin），无法按相对阈值判别；疑该测试层非完整 TEST 层或良品 bin 非 BIN1，请核对 pass/bin 口径`，不再显示「全部达标」，退化时不误标红。
- 测试 `test/agentUnderperformingDutView.test.ts`：+多列、+退化两例（共 7 例通过）。

## 4. 待 Cursor 真库验证（Claude 沙箱无 INF 盘/真库，未改取数逻辑）

> ✅ **Cursor 已完成（2026-07-04）：** [`HANDOFF_CURSOR_VERIFICATION_RESULTS_2026-07-04_DUT_YIELD_MULTISELECT.md`](HANDOFF_CURSOR_VERIFICATION_RESULTS_2026-07-04_DUT_YIELD_MULTISELECT.md) — pass1 良品为 **BIN55**（`PASSBIN=1-55`）；仅 `{BIN1}` 复现全 0；**建议取数改 JB PASSBIN 优先**。

1. **`NF12499.1N` 的 `PASS_ID=1` 层到底是什么？** 是常温预测/bump 探针（非完整 TEST），还是完整测试但良品 bin ≠ BIN1？直接看 INF `r_1-17` 的 `iBinCodeLast`。
2. **良品 bin 判定是否该改。** 单片/小样本场景下 `avg die per DUT > 100` 启发式失效。是否应改为「读 JB `goodBinIndicesForJbRow`（BIN1 + PASSBIN 段 + isGoodBin）作为良品 bin 来源」，而非 INF 侧启发式？——这会改动取数口径，**需 dummy-parity 双路径同步 + 真库回归**，故留给 Cursor 决策，Claude 未动。
3. **pass 选择。** 默认 `passId=[1,3,5]` 会把没有良品数据的层也拉进来。是否应只分析「JB 有该 lot 良率数据」的 pass（如本例只 pass3）？同样改取数，留 Cursor。

## 5. 结论

Q1（多列）、Q3（75% 退化误报「全部达标」）已在展示层修好且不影响正常 lot。Q2（为何 pass1 全 0）根因指向**良品 bin 判定/取数口径**，属真库范畴，见 §4。
