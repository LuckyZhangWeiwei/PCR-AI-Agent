# 真库测试任务（给 Cursor）— DUT 低良率阈值 口径 + JB Star 明细表跨 LOT 多选

> **执行者：** Cursor Agent（有真库 / 真 INF 盘访问）
> **被测分支：** `feat/jb-route-resolver`（已推送 origin，未并 main），当前 HEAD `4643f77`
> **背景：** 本文档合并两块待真库验证的内容——(A) 此前诊断 `NF12499.1N` 低良率 DUT 表「全 0 / 阈值 0%」时留下的 3 个口径问题；(B) 刚做完的 JB Star 明细表多选放宽（新增「同 Device + 同探针卡类型」跨 LOT 分组）。**Claude Code 沙箱无真库/无 INF 盘，以下问题必须由 Cursor 用真实数据回答，不能靠代码推断。**
> **结论先行（给 Claude Code 回填）：** 见文末「回传格式」。把关键 SQL/curl 输出、截图描述或 UI 行为贴回 `scratchpad/realdb-dut-yield-multiselect-<日期>.txt` 或直接贴回对话。

---

## 0. 这次要回答的问题（先看这张表，再展开细节）

| # | 问题 | 为什么需要真库 |
|---|---|---|
| A1 | `NF12499.1N` 的 `PASS_ID=1` 层到底是什么内容？ | 需要看 INF 真实 `r_1-17` 记录，代码侧无法判断 |
| A2 | 良品 bin 判定要不要从「INF 启发式」改成「JB `goodBinIndicesForJbRow`」？ | 需要在多个真实 lot 上对比两种口径的差异有多大 |
| A3 | 默认 `passId=[1,3,5]` 要不要窄化为「JB 有良率数据的 pass」？ | 需要看真实数据里有多少 lot 存在「某 pass 无良率数据」的情况 |
| B1 | 真实数据里「同 Device + 同探针卡类型 + 不同 LOT」的组合是否存在、多选后 UI 是否正确 | 需要真实多 lot 数据验证跨 LOT 选择路径 |
| B2 | 跨 LOT 多选后，DUT×Bin 图是否把每个 wafer 各自的数据都统计进去 | 需要真实 INF 数据核对图表数字 |
| B3 | 原有「同 Device+LOT 不同 waferId」多选是否仍正常（回归） | 防止本次改动破坏原有功能 |

---

## 1. 部署被测分支

```bash
git fetch origin && git checkout feat/jb-route-resolver && git pull
git log --oneline -6   # 顶部应含 4643f77(JB Star 多选放宽)
cd pcr-ai-api && npm ci && npm run build && npm test
cd ../pcr-ai-report && npm ci && npm run build
pm2 reload <API进程名> && pm2 reload <前端进程名，若有>
```

---

## 2. Part A — DUT 低良率阈值（75%）口径验证

背景文档：`docs/HANDOFF_UNDERPERFORMING_DUT_ZERO_YIELD_2026-07-04.md`（本节是它的真库验证任务化）。
算法位置：`pcr-ai-api/src/lib/lotUnderperformingDuts.ts`（阈值计算）、`pcr-ai-api/src/lib/agent/agentDutConcentration.ts:29` `goodBinNumbersFromSiteBinPasses`（INF 侧良品 bin 启发式：某 bin 全 lot 平均每 DUT die 数 **> 100** 才算良品 bin）、`pcr-ai-api/src/lib/jbYieldCalc.ts:54` `goodBinIndicesForJbRow`（JB 侧：BIN1 + PASSBIN 段 + isGoodBin 标记）。

### A1. 确认 `NF12499.1N` PASS_ID=1 到底是什么层

```bash
# 直接查 REST（device 会被服务端反查，可不传）
curl "http://<API_HOST>:30008/api/v4/inf-analysis/lot-underperforming-duts?lot=NF12499.1N&passId=1"
```

同时查 INF 原始记录（`r_1-17` 或等价路径，具体命令按你机器上的 INF 查询工具/脚本调整）：
- 该层 `PASSTYPE` 是否为完整 `TEST`（而非预测/bump 等非完整层）？
- 该层的良品 bin 实际是 `BIN1` 吗？还是別的 bin（比如某些 bump probe 层良品 bin 不是 1）？
- 该 wafer 在 PASS_ID=1 层的 `iBinCodeLast` 分布长什么样（有多少种 bin，各自计数）？

**期望产出：** 一段文字结论，回答「PASS_ID=1 是否是可信的完整测试层，良品 bin 是不是 BIN1」。

### A2. 对比两种「良品 bin」判定口径的差异

在至少 **3 个不同规模的真实 lot**（建议：1 个类似 NF12499.1N 的单片小样本 lot，1 个多片正常 lot，1 个你认为「有陷阱」的 lot）上，分别用两种口径统计良品 bin 集合，对比差异：

1. **现口径（INF 启发式）**：`goodBinNumbersFromSiteBinPasses`（平均每 DUT die > 100 才算良品）
2. **备选口径（JB 侧）**：`goodBinIndicesForJbRow`（BIN1 + JB 行的 PASSBIN 段 + isGoodBin 标记）

可以直接跑一段 `tsx` 脚本调这两个函数（在 `pcr-ai-api` 目录下），传入真实 `SiteBinPass[]` / JB 行数据，打印两个 `Set<number>` 对比。若你已有更方便的方式（比如临时加一个调试 endpoint）也可以。

**期望产出：**
- 对每个测试 lot：两种口径算出的良品 bin 集合是否一致？若不一致，差异是什么（比如现口径在小样本上退化为空集，备选口径能拿到 BIN1）？
- 你的结论/建议：是否应该把 `agentDutConcentration.ts` 里 INF 侧的良品 bin 判定，改成优先用 JB `goodBinIndicesForJbRow`（若能拿到对应 JB 行），启发式仅作为兜底？
- **不要直接改代码**——这是口径决策，需要 Claude Code / 产品侧确认后再改（可能涉及 dummy-parity 双路径同步）。

### A3. passId 范围是否要窄化

默认 `passId=[1,3,5]`（对应 sort1/sort2/sort3，见 `pcr-ai-api/CLAUDE.md` 的 pass 映射说明）。

```bash
# 对若干真实 lot 跑全 pass，看哪些 pass 返回空/0 baseline
curl "http://<API_HOST>:30008/api/v4/inf-analysis/lot-underperforming-duts?lot=<真实lot1>"
curl "http://<API_HOST>:30008/api/v4/inf-analysis/lot-underperforming-duts?lot=<真实lot2>"
```

**期望产出：** 抽样 5~10 个真实 lot，统计有多少比例的 lot 存在「某个 pass 完全没有良率数据（baseline=0 或 duts 为空）」的情况。如果比例不低（比如 >20%），建议默认只分析「JB 侧确实有该 lot 良率数据」的 pass；如果比例很低，维持现状即可。

---

## 3. Part B — JB Star 明细表多选放宽（本次改动，commit `4643f77`）

### 3.1 改动内容速览

文件：`pcr-ai-report/src/utils/infDutSelection.ts`（`canJoinDutSelectionGroup`）、`pcr-ai-report/src/reports/InfcontrolReport.tsx`（`toggleDetailListKey` / `toggleDetailAllVisible`）。

**新规则**（原来只允许「同 Device + 同 LOT」）：
- 同 Device + 同 LOT（不同 waferId）— 原有行为，**必须回归验证不变**
- 同 Device + 同探针卡类型（`PROBECARDTYPE`，跨 LOT）— **本次新增**

以组内**首个勾选行**为锚点比较，不是两两互相比较（和原有实现风格一致，但意味着如果组内已有跨 LOT 的行，第三行是否能加入取决于它和「第一行」而不是「最近一行」是否满足条件——这是已知的设计简化，不是 bug）。

DUT×Bin 分布图组件 `InfDutDistPanel.tsx` **本身没有改动**——它一直是按每个 wafer 各自的 `device+lot+slot` 拼 `infPath` 分别请求 INF、再合并展示，理论上天然支持跨 LOT 的 wafer 混合选择。这次验证的重点就是**确认这个"理论上"在真实数据下也成立**。

### 3.2 找真实测试数据

需要在真库里找到（或者构造/确认存在）：
```sql
-- 伪 SQL 示意，实际用你熟悉的方式查 INFCONTROL/JB 表
SELECT DEVICE, LOT, CARDID, SLOT, PASSID
FROM <JB表>
WHERE DEVICE = <某个真实 device>
GROUP BY DEVICE, LOT, CARDID
```
找一个 `DEVICE` 下，**至少 2 个不同 `LOT`**、但 `CARDID` 前缀（探针卡类型，即 `CARDID` 中第一个 `-` 前的部分）**相同**的组合。如果同一 device 下所有 lot 用的都是不同类型的卡（没有巧合出现同类型跨 lot 的情况），就直接告诉我们「真实数据里这种组合很少见」，这本身也是有价值的信息。

### 3.3 UI 验证步骤

在 JB Star tab：
1. 用上一步找到的 `device`（可选配合 `probeCardType` 筛选缩小范围）查询，展开明细表。
2. 勾选 **LOT A** 的一行 → 再勾选 **LOT B**（不同 LOT，但 `CARDID` 前缀相同）的一行。
   - **期望：** 允许勾选成功，不弹出「仅可选同一 Device + LOT…」的提示。
   - 勾选区下方应出现两个 tag，分别显示各自的 `LOT / slot / CARDID`。
   - DUT×Bin 分布图上方文案应显示类似「2 片 · 2 个 LOT · Slot X, Y」。
3. 打开浏览器 Network 面板，确认 `GET /api/v4/inf-analysis/site-bin-bylot` 被调用了 **2 次**（每个 wafer 一次），且两次请求的 `infPath` 参数分别对应 LOT A 和 LOT B 各自的 device+lot+slot（不是都用了同一个 lot）。
4. 检查图上的 DUT×Bin 柱状数据，能否与你手动核对的 INF 真实数据吻合（至少挑 1~2 个 bin 抽查 die count 是否对得上）。
5. **回归**：再测一次「同一 LOT、不同 waferId（slot）」多选（旧场景），确认仍然正常（tag、图表都对）。
6. **拒绝场景**：故意勾选 **不同 device** 的两行，或**同 device 但 LOT 和探针卡类型都不同**的两行，确认底部出现提示「仅可选同一 Device + LOT，或同一 Device + 相同探针卡类型 的行」，且第二次勾选被拒绝（第一行保持选中，第二行不加入）。

### 3.4 已知不需要验证的部分

- `LOT Yield% 最差 Top 10` 模块删除（commit `9ab3e0a`）：纯前端 UI 移除，已过 `npm run build`；旧 `localStorage` 里残留的 `lotYield` 布局顺序键会被 `DraggableReportSections.tsx` 的 `normalizeOrder()` 自动过滤掉，无需手动清理、无需真库验证。若你顺手打开 JB Star tab 时发现这个模块的残留（不应该出现），直接报一句即可。

---

## 4. 回传格式

写入 `scratchpad/realdb-dut-yield-multiselect-<日期>.txt` 或贴回对话，包含：

```
环境：分支 commit = <git rev-parse --short HEAD>，pm2 已 reload（时间）

Part A（DUT 低良率阈值口径）
  A1 NF12499.1N PASS_ID=1：<是否完整TEST层 / 良品bin是否是BIN1 / iBinCodeLast分布摘要>
  A2 良品bin口径对比（至少3个lot）：
    lot1=<现口径集合> vs <备选口径集合>，差异=<...>
    lot2=... lot3=...
    建议：<是否应改用JB goodBinIndicesForJbRow>
  A3 passId范围抽样（5~10个lot）：<空baseline比例> ，建议：<维持/窄化>

Part B（JB Star 跨LOT多选）
  B1 真实"同device+同探针卡类型+不同LOT"组合：<找到的具体 device/lot1/lot2/cardId前缀，或"未找到，说明XXX"）
  B2 UI验证：
    - 跨LOT勾选成功=<是/否> tag显示正确=<是/否> selectionSummary文案=<贴实际文案>
    - Network请求次数=<N> 各自infPath=<贴出>
    - DUT×Bin数字核对=<吻合/不吻合，具体说明>
  B3 回归（同LOT不同waferId）=<正常/异常>
  B4 拒绝场景提示=<正常/异常，贴实际提示文案>

总判：Part A 三个口径问题是否需要改代码？Part B 本次改动是否有真实数据下的 bug？
```

---

## 5. 给 Cursor 的纪律提醒

- **Part A 是口径调研，不是让你直接改代码。** 即使发现现有启发式有明显问题，也请先把对比数据带回来，由 Claude Code / 产品侧决定是否改（涉及 dummy-parity 双路径同步 + 可能影响其它已上线功能）。
- **Part B 若发现真实 bug**（比如跨 LOT 请求没有正确按各自 lot 拼 infPath、tag 显示错位等），请贴出具体复现步骤 + Network 请求截图/文本，交回 Claude Code 定位修复，不要自行改动 `infDutSelection.ts` / `InfcontrolReport.tsx`。
- 不提交 `.claude/settings.local.json`、真实 `.env`、key。
- 若临时加调试脚本/`console.log` 验证，测完请还原或删除临时文件。
